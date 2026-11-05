// S3-17: штрафы и премии K18 §8: флаги выключены по умолчанию, причина, сумма, филиал у Директора, чужая зона, отмена и правка без потери
// исходной записи, закрытый период, FOR SHARE периода раньше lockAccounts.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { verifyBalance } from '../../apps/api/src/core/ledger.ts';
import type { AccessContext, StaffRole } from '../../apps/api/src/core/permissions.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { amendPenalty, cancelPenalty, createBonus, createPenalty, listPenalties } from '../../apps/api/src/modules/shifts/penalties.ts';
import { createTestBranch } from '../helpers/network.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

let db: TestDatabase;
let pool: pg.Pool;
const clock = fixedClock('2026-11-14T05:00:00Z');
let branch = '';
let otherBranch = '';

function ctx(role: StaffRole, branchIds: string[] = []): AccessContext {
  return { actor: { kind: 'staff', staffId: randomUUID(), sessionId: randomUUID() }, role, network: role === 'owner', cityIds: new Set(), branchIds: new Set(branchIds), at: clock.now() };
}
const owner = ctx('owner');
const meta = (c: AccessContext): AuditRequestMeta => ({ actor: c.actor, access: c, source: 'crm', requestId: randomUUID() });

async function tx<T>(fn: (t: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}
async function newStaff(branchId: string = branch): Promise<string> {
  const r = await db.client.query<{ id: string }>(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', $1, 'admin', 'x') RETURNING id`, [`${randomUUID()}@yu.test`]);
  await db.client.query(`INSERT INTO app.staff_assignments (staff_id, scope_type, branch_id, valid_from, created_by) VALUES ($1, 'branch', $2, '2026-01-01', $1)`, [r.rows[0]!.id, branchId]);
  return r.rows[0]!.id;
}
const penalty = (staffId: string, extra: Record<string, unknown> = {}, who = owner) =>
  tx((t) => createPenalty(t, who, { staffId, branchId: branch, date: '2026-11-10', amountKop: 50_000, reason: 'опоздание', ...extra }, meta(who), clock));
async function setFlag(key: string, value: boolean): Promise<void> {
  await db.client.query(`DELETE FROM app.settings_values WHERE key = $1`, [key]);
  await db.client.query(`INSERT INTO app.settings_values (key, level, value, valid_from, created_by) VALUES ($1, 'network', $2, '2026-01-01', $3)`, [key, JSON.stringify(value), randomUUID()]);
}
const balance = async (staffId: string) => {
  const a = await db.client.query<{ id: string }>(`SELECT id FROM app.ledger_accounts WHERE kind = 'staff_payroll' AND owner_id = $1`, [staffId]);
  return verifyBalance(db.client, a.rows[0]!.id);
};

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 6 });
  branch = (await createTestBranch(db.client)).id;
  otherBranch = (await createTestBranch(db.client)).id;
});
afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('флаги', () => {
  it('по умолчанию штраф и премия – FEATURE_DISABLED; строка не создаётся', async () => {
    const s = await newStaff();
    await expect(penalty(s)).rejects.toMatchObject({ code: 'FEATURE_DISABLED', details: { setting: 'payroll.penalties_enabled' } });
    await expect(tx((t) => createBonus(t, owner, { staffId: s, date: '2026-11-10', amountKop: 100, reason: 'план' }, meta(owner), clock))).rejects.toMatchObject({ code: 'FEATURE_DISABLED', details: { setting: 'payroll.bonus_enabled' } });
    expect((await db.client.query(`SELECT 1 FROM app.payroll_penalties WHERE staff_id = $1`, [s])).rows).toEqual([]);
  });
});

describe('при включённых флагах', () => {
  beforeAll(async () => {
    await setFlag('payroll.penalties_enabled', true);
    await setFlag('payroll.bonus_enabled', true);
  });

  it('без причины – COMMENT_REQUIRED; сумма ≤ 0 – INVALID_AMOUNT', async () => {
    const s = await newStaff();
    await expect(penalty(s, { reason: '  ' })).rejects.toMatchObject({ code: 'COMMENT_REQUIRED' });
    await expect(penalty(s, { amountKop: 0 })).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
    await expect(penalty(s, { amountKop: -100 })).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
  });

  it('штраф – минус на счёте сотрудника, ссылка и филиал записи, знак ставит система', async () => {
    const s = await newStaff();
    const p = await penalty(s);
    expect(p).toMatchObject({ kind: 'penalty', amountKop: 50_000, status: 'active', branchId: branch, date: '2026-11-10', reason: 'опоздание' });
    const e = await db.client.query(`SELECT amount, entry_type, ref_type, ref_id, branch_id, basis FROM journal.ledger_entries WHERE posting_id = $1`, [p.postingId]);
    expect(e.rows).toEqual([{ amount: '-50000', entry_type: 'payroll.penalty', ref_type: 'payroll_penalty', ref_id: p.id, branch_id: branch, basis: 'опоздание' }]);
    expect(await balance(s)).toMatchObject({ cached: -50_000, ok: true });
  });

  it('Директор без филиала – BRANCH_REQUIRED; Владелец – можно; сотрудник чужой зоны – 404; Администратор – 403', async () => {
    const s = await newStaff();
    const foreign = await newStaff(otherBranch);
    const director = ctx('director', [branch]);
    await expect(penalty(s, { branchId: null }, director)).rejects.toMatchObject({ code: 'BRANCH_REQUIRED' });
    await expect(penalty(foreign, { branchId: otherBranch }, director)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(penalty(foreign, { branchId: null }, director)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(penalty(foreign, { branchId: branch }, director)).rejects.toMatchObject({ code: 'NOT_FOUND' }); // на филиал зоны не назначен
    await expect(penalty(s, {}, ctx('admin', [branch]))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await penalty(s, {}, director)).authorId).toBeDefined();
    expect((await penalty(s, { branchId: null })).branchId).toBeNull();
  });

  it('премия: плюс на счёте; только Владелец (Директору – 403)', async () => {
    const s = await newStaff();
    const director = ctx('director', [branch]);
    await expect(tx((t) => createBonus(t, director, { staffId: s, branchId: branch, date: '2026-11-10', amountKop: 100, reason: 'план' }, meta(director), clock))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const b = await tx((t) => createBonus(t, owner, { staffId: s, date: '2026-11-10', amountKop: 30_000, reason: 'план' }, meta(owner), clock));
    expect(b.kind).toBe('bonus');
    expect(await balance(s)).toMatchObject({ cached: 30_000, ok: true });
  });

  it('отмена сохраняет исходную запись и причину (приёмка 16–17); вторая отмена – ALREADY_REVERSED; причина обязательна', async () => {
    const s = await newStaff();
    const p = await penalty(s);
    await expect(tx((t) => cancelPenalty(t, owner, p.id, { reason: ' ' }, meta(owner), clock))).rejects.toMatchObject({ code: 'COMMENT_REQUIRED' });
    const c = await tx((t) => cancelPenalty(t, owner, p.id, { reason: 'ошибка' }, meta(owner), clock));
    expect(c).toMatchObject({ status: 'cancelled', cancelReason: 'ошибка', reason: 'опоздание', amountKop: 50_000 });
    expect(await balance(s)).toMatchObject({ cached: 0, ok: true });
    const entries = await db.client.query<{ entry_type: string; basis: string }>(`SELECT entry_type, basis FROM journal.ledger_entries WHERE ref_id = $1 ORDER BY id`, [p.id]);
    expect(entries.rows).toEqual([{ entry_type: 'payroll.penalty', basis: 'опоздание' }, { entry_type: 'reversal', basis: 'ошибка' }]);
    await expect(tx((t) => cancelPenalty(t, owner, p.id, { reason: 'ещё' }, meta(owner), clock))).rejects.toMatchObject({ code: 'ALREADY_REVERSED' });
  });

  it('правка: сторно + новая запись со ссылкой replacedBy; история в аудите; why обязателен', async () => {
    const s = await newStaff();
    const p = await penalty(s);
    await expect(tx((t) => amendPenalty(t, owner, p.id, { amountKop: 10_000 }, meta(owner), clock))).rejects.toMatchObject({ code: 'COMMENT_REQUIRED' });
    const n = await tx((t) => amendPenalty(t, owner, p.id, { amountKop: 10_000, why: 'сумма больше нормы' }, meta(owner), clock));
    expect(n).toMatchObject({ amountKop: 10_000, reason: 'опоздание', status: 'active' });
    expect(await balance(s)).toMatchObject({ cached: -10_000, ok: true });
    const old = await db.client.query(`SELECT status, replaced_by FROM app.payroll_penalties WHERE id = $1`, [p.id]);
    expect(old.rows[0]).toEqual({ status: 'cancelled', replaced_by: n.id });
    const audit = await db.client.query<{ before: { amountKop: number }; reason: string }>(`SELECT before, reason FROM journal.audit_events WHERE action = 'payroll.penalty.amended' AND object_id = $1`, [n.id]);
    expect(audit.rows[0]).toMatchObject({ reason: 'сумма больше нормы', before: { amountKop: 50_000 } });
  });

  it('Директор чужой зоны по id – 404; запись без филиала Директору не видна; список ограничен зоной', async () => {
    const s = await newStaff();
    const p = await penalty(s);
    const network = await penalty(s, { branchId: null });
    const foreign = ctx('director', [otherBranch]);
    await expect(tx((t) => cancelPenalty(t, foreign, p.id, { reason: 'x' }, meta(foreign), clock))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const director = ctx('director', [branch]);
    await expect(tx((t) => cancelPenalty(t, director, network.id, { reason: 'x' }, meta(director), clock))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const seen = await listPenalties(pool, director, { staffId: s });
    expect(seen.items.map((i) => i.id)).toEqual([p.id]);
    expect((await listPenalties(pool, owner, { staffId: s })).items).toHaveLength(2);
    expect((await listPenalties(pool, foreign, { staffId: s })).items).toEqual([]);
    await expect(listPenalties(pool, ctx('admin', [branch]), { staffId: s })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('закрытый период: создать и исправить нельзя; отмена – сторно датой открытого периода', async () => {
    const s = await newStaff();
    const p = await penalty(s, { date: '2026-02-10' });
    await db.client.query(`INSERT INTO app.payroll_periods (date_from, date_to, status, closed_at) VALUES ('2026-02-01', '2026-02-28', 'closed', now())`);
    await expect(penalty(s, { date: '2026-02-11' })).rejects.toMatchObject({ code: 'PAYROLL_PERIOD_CLOSED' });
    await expect(tx((t) => amendPenalty(t, owner, p.id, { amountKop: 1, why: 'x' }, meta(owner), clock))).rejects.toMatchObject({ code: 'PAYROLL_PERIOD_CLOSED' });
    await tx((t) => cancelPenalty(t, owner, p.id, { reason: 'ошибка' }, meta(owner), clock));
    const r = await db.client.query<{ d: string }>(`SELECT to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d FROM journal.ledger_entries WHERE ref_id = $1 AND entry_type = 'reversal'`, [p.id]);
    expect(r.rows[0]!.d).toBe('2026-11-14');
  });

  it('FOR SHARE периода раньше lockAccounts: пока закрытие держит период, счёт сотрудника свободен', async () => {
    const s = await newStaff();
    await penalty(s, { date: '2026-03-05' }); // счёт уже есть
    await db.client.query(`INSERT INTO app.payroll_periods (date_from, date_to) VALUES ('2026-03-01', '2026-03-31')`);
    const closer = await pool.connect();
    await closer.query('BEGIN');
    await closer.query(`SELECT 1 FROM app.payroll_periods WHERE date_from = '2026-03-01' FOR UPDATE`);
    const pending = penalty(s, { date: '2026-03-06' });
    await new Promise((r) => setTimeout(r, 200));
    const account = await db.client.query<{ id: string }>(`SELECT id FROM app.ledger_accounts WHERE kind = 'staff_payroll' AND owner_id = $1`, [s]);
    const probe = await pool.connect();
    await probe.query('BEGIN');
    await expect(probe.query(`SELECT 1 FROM app.ledger_accounts WHERE id = $1 FOR UPDATE NOWAIT`, [account.rows[0]!.id])).resolves.toBeDefined();
    await probe.query('ROLLBACK');
    probe.release();
    await closer.query('COMMIT');
    closer.release();
    await expect(pending).resolves.toMatchObject({ status: 'active' });
  });
});

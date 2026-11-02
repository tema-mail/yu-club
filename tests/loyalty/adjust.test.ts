// S2-38: ручная корректировка баллов (K15 §9) и задача истечения партий (K15 §2, Q-43).
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import type { Clock } from '../../apps/api/src/core/time.ts';
import { createBatch, getBalance, openAccount, postPoints, SYSTEM_AUTHOR } from '../../apps/api/src/modules/loyalty/account.ts';
import { adjust, expireBatches, type AdjustInput } from '../../apps/api/src/modules/loyalty/adjust.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const SYS = '00000000-0000-0000-0000-000000000001';
let now = new Date('2026-11-14T05:00:00Z');
const clock: Clock = { now: () => now };
const DAY = 86_400_000;
let db: TestDatabase;
let pool: pg.Pool;

async function inTx<T>(fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
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
const ctxOf = (role: 'owner' | 'director' | 'admin'): AccessContext => ({ actor: { kind: 'staff', staffId: randomUUID(), sessionId: randomUUID() }, role, network: role === 'owner', cityIds: new Set(), branchIds: new Set(), at: now });
const metaOf = (ctx: AccessContext): AuditRequestMeta => ({ actor: ctx.actor, source: 'crm', requestId: randomUUID() });
const run = (ctx: AccessContext, input: AdjustInput) => inTx((tx) => adjust(tx, ctx, input, metaOf(ctx), clock));
const codeOf = (p: Promise<unknown>) => p.then(() => 'ok', (err: { code?: string }) => err.code ?? String(err));
const newClient = async () =>
  (await db.client.query<{ id: string }>(`INSERT INTO app.clients (phone_e164, first_name, status, created_by_type, registered_at) VALUES ($1, 'К', 'active', 'system', now()) RETURNING id`, [`+7913${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`])).rows[0]!.id;
const bal = async (c: string) => (await getBalance(pool, c, now)).balanceCenti;

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
});
afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('adjust (07 §10.3)', () => {
  it('без причины – COMMENT_REQUIRED; Администратор – FORBIDDEN', async () => {
    const c = await newClient();
    expect(await codeOf(run(ctxOf('director'), { clientId: c, deltaCenti: 100, reason: ' ' }))).toBe('COMMENT_REQUIRED');
    expect(await codeOf(run(ctxOf('admin'), { clientId: c, deltaCenti: 100, reason: 'подарок' }))).toBe('FORBIDDEN');
  });

  it('Директор: «+» – партия manual, «−» – FEFO и долг; аудит с причиной; повтор с ключом – одна запись', async () => {
    const c = await newClient();
    const d = ctxOf('director');
    const r1 = await run(d, { clientId: c, deltaCenti: 1000, reason: 'компенсация за сбой', idempotencyKey: 'k1' });
    expect(await run(d, { clientId: c, deltaCenti: 1000, reason: 'компенсация за сбой', idempotencyKey: 'k1' })).toEqual(r1);
    expect(await bal(c)).toBe(1000);
    expect((await db.client.query(`SELECT source, remaining_centi, expires_at FROM app.loyalty_batches WHERE client_id = $1`, [c])).rows).toEqual([{ source: 'manual', remaining_centi: '1000', expires_at: null }]);
    await run(d, { clientId: c, deltaCenti: -2000, reason: 'ошибочное начисление' });
    expect(await bal(c)).toBe(-1000);
    const audit = await db.client.query(`SELECT reason FROM journal.audit_events WHERE action = 'loyalty.adjusted' AND object_id = $1 ORDER BY id`, [c]);
    expect(audit.rows.map((r) => r.reason)).toEqual(['компенсация за сбой', 'ошибочное начисление']); // повтор аудит не пишет
  });

  it('ниже −50: Директор – LIMIT_OVERRIDE_NOT_ALLOWED, Владелец без режима – тоже, с режимом – проходит', async () => {
    const c = await newClient();
    await run(ctxOf('director'), { clientId: c, deltaCenti: -5000, reason: 'долг' });
    expect(await codeOf(run(ctxOf('director'), { clientId: c, deltaCenti: -200, reason: 'ещё', belowLimit: true }))).toBe('LIMIT_OVERRIDE_NOT_ALLOWED');
    expect(await codeOf(run(ctxOf('owner'), { clientId: c, deltaCenti: -200, reason: 'ещё' }))).toBe('LIMIT_OVERRIDE_NOT_ALLOWED');
    await run(ctxOf('owner'), { clientId: c, deltaCenti: -200, reason: 'решение владельца', belowLimit: true });
    expect(await bal(c)).toBe(-5200);
  });

  it('закрытие «требует решения» корректировкой со ссылкой на issue', async () => {
    const c = await newClient();
    const issue = (await db.client.query<{ id: string }>(`INSERT INTO app.loyalty_issues (client_id, kind, ref_type, ref_id, amount_centi) VALUES ($1, 'accrual_reversal_below_limit', 'visit', $2, 1000) RETURNING id`, [c, randomUUID()])).rows[0]!.id;
    const { entryId } = await run(ctxOf('director'), { clientId: c, deltaCenti: -500, reason: 'сторно ниже предела частично', issueId: issue });
    expect((await db.client.query(`SELECT status, resolved_entry_id FROM app.loyalty_issues WHERE id = $1`, [issue])).rows[0]).toEqual({ status: 'resolved', resolved_entry_id: String(entryId) });
  });
});

describe('ревизия 02.11: повтор и ссылка на issue', () => {
  it('повтор «−» с тем же ключом у предела −50 – прежний ответ, а не LIMIT_OVERRIDE_NOT_ALLOWED; аудит один', async () => {
    const c = await newClient();
    const d = ctxOf('director');
    const r1 = await run(d, { clientId: c, deltaCenti: -5000, reason: 'долг', idempotencyKey: 'lim-1' });
    expect(await run(d, { clientId: c, deltaCenti: -5000, reason: 'долг', idempotencyKey: 'lim-1' })).toEqual(r1);
    expect(await bal(c)).toBe(-5000);
    expect(await codeOf(run(d, { clientId: c, deltaCenti: -100, reason: 'долг', idempotencyKey: 'lim-1' }))).toBe('IDEMPOTENCY_KEY_REUSED');
    const audit = await db.client.query(`SELECT 1 FROM journal.audit_events WHERE action = 'loyalty.adjusted' AND object_id = $1`, [c]);
    expect(audit.rowCount).toBe(1);
  });

  it('неверный issueId – NOT_FOUND, чужой – NOT_FOUND, закрытый – LOYALTY_ISSUE_RESOLVED; баланс не меняется', async () => {
    const c = await newClient();
    const other = await newClient();
    const d = ctxOf('director');
    const mk = async (clientId: string) =>
      (await db.client.query<{ id: string }>(`INSERT INTO app.loyalty_issues (client_id, kind, ref_type, ref_id, amount_centi) VALUES ($1, 'accrual_reversal_below_limit', 'visit', $2, 1000) RETURNING id`, [clientId, randomUUID()])).rows[0]!.id;
    expect(await codeOf(run(d, { clientId: c, deltaCenti: -100, reason: 'x', issueId: randomUUID() }))).toBe('NOT_FOUND');
    expect(await codeOf(run(d, { clientId: c, deltaCenti: -100, reason: 'x', issueId: await mk(other) }))).toBe('NOT_FOUND');
    const own = await mk(c);
    await run(d, { clientId: c, deltaCenti: -100, reason: 'закрываю', issueId: own });
    expect(await codeOf(run(d, { clientId: c, deltaCenti: -100, reason: 'ещё раз', issueId: own }))).toBe('LOYALTY_ISSUE_RESOLVED');
    expect(await bal(c)).toBe(-100);
  });
});

describe('задача истечения партий', () => {
  it('batch_ttl_days = null – проход ничего не делает; при сроке – loyalty.expire и FEFO', async () => {
    const c = await newClient();
    await inTx(async (tx) => {
      await openAccount(tx, c, now);
      const p = await postPoints(tx, c, { amount: 700, type: 'loyalty.accrual', branchId: null, occurredAt: now }, randomUUID(), SYSTEM_AUTHOR);
      await createBatch(tx, { clientId: c, entryId: p.entryId, amount: 700, balanceBefore: p.balanceBefore, source: 'visit', branchId: null, expiresAt: new Date(now.getTime() + DAY), accruedAt: now });
    });
    now = new Date(now.getTime() + 2 * DAY);
    expect(await expireBatches(pool, clock)).toBe(0);
    expect(await bal(c)).toBe(700);
    await db.client.query(`INSERT INTO app.settings_values (key, level, value, valid_from, created_by) VALUES ('loyalty.batch_ttl_days', 'network', '30', '2026-01-01', $1)`, [SYS]);
    expect(await expireBatches(pool, clock)).toBe(1);
    expect(await bal(c)).toBe(0);
    const e = await db.client.query(`SELECT e.amount FROM journal.ledger_entries e JOIN app.ledger_accounts a ON a.id = e.account_id WHERE a.owner_id = $1 AND e.entry_type = 'loyalty.expire'`, [c]);
    expect(e.rows).toEqual([{ amount: '-700' }]);
    expect(await expireBatches(pool, clock)).toBe(0);
    // новая партия «+» получает срок: конец суток по UTC через 30 дней
    await run(ctxOf('director'), { clientId: c, deltaCenti: 300, reason: 'подарок' });
    const b = (await db.client.query(`SELECT expires_at FROM app.loyalty_batches WHERE client_id = $1 AND source = 'manual'`, [c])).rows[0];
    expect(b.expires_at).toEqual(new Date('2026-12-17T00:00:00Z'));
  });
});

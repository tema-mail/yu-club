// S2-15: сводка кассы филиала и сети (K17 §9, №48; TC-20 для кассы, 16 §14). Каждое число = сумма своих операций,
// закрывающий остаток места = остаток счёта K3; сутки по зоне филиала при чужом TZ машины; переводы между местами и
// изъятия не входят в результат; баллы и погашения сертификатов – отдельно (nonMoney), касса их не видит.
process.env.TZ = 'America/New_York';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { post } from '../../apps/api/src/core/ledger.ts';
import type { AccessContext, StaffRole } from '../../apps/api/src/core/permissions.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { postMoneyOperation, recordExpense, recordIncome, recordOpeningBalance, recordWithdrawal, transferBetweenPlaces } from '../../apps/api/src/modules/finance/cashbox.ts';
import { reverseOperation } from '../../apps/api/src/modules/finance/corrections.ts';
import { branchSummary, networkSummary } from '../../apps/api/src/modules/finance/summary.ts';
import { createTestBranch } from '../helpers/network.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

let db: TestDatabase;
let pool: pg.Pool;
const clock = fixedClock('2026-11-15T10:00:00Z'); // 17:00 15-го по Новосибирску
const cat: Record<string, string> = {};
let b1: string;
let b2: string;

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
type Cmd = typeof recordIncome;
const run = (cmd: Cmd, body: object) => tx((t) => cmd(t, owner, body, meta(owner), { idempotencyKey: randomUUID(), clock }));
const sys = { kind: 'system' as const, process: 'test' };
const sysMeta: AuditRequestMeta = { actor: { kind: 'system', process: 'test' }, source: 'system', requestId: 'test' };
const balance = async (branchId: string, kind: string) =>
  Number((await db.client.query(`SELECT balance FROM app.ledger_accounts WHERE owner_id = $1 AND kind = $2`, [branchId, kind])).rows[0]?.balance ?? 0);

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
  const r = await db.client.query<{ id: string; name: string }>(`SELECT id, name FROM app.finance_categories WHERE name IN ('Прочее', 'Коммунальные', 'Электричество')`);
  for (const x of r.rows) cat[x.name] = x.id;
  b1 = (await createTestBranch(db.client)).id;
  b2 = (await createTestBranch(db.client)).id;
  const day = '2026-11-15T04:00:00Z'; // 11:00 15-го там
  await run(recordOpeningBalance, { branchId: b1, place: 'cash', amountKop: 100_000, date: '2026-11-01', comment: 'старт' });
  await run(recordIncome, { branchId: b1, method: 'cash', amountKop: 5_000, source: 'event', occurredAt: day });
  await run(recordIncome, { branchId: b1, method: 'card', amountKop: 3_000, source: 'other', occurredAt: '2026-11-14T17:30:00Z' }); // 00:30 15-го там
  await run(recordIncome, { branchId: b1, method: 'cash', amountKop: 700, source: 'other', occurredAt: '2026-11-14T16:30:00Z' }); // 23:30 14-го там
  await run(recordExpense, { branchId: b1, method: 'cash', amountKop: 1_000, categoryId: cat['Прочее'], occurredAt: day, comment: 'мелочи' });
  const power = await run(recordExpense, { branchId: b1, method: 'card', amountKop: 2_000, categoryId: cat['Коммунальные'], subcategoryId: cat['Электричество'], occurredAt: day, comment: 'свет' });
  await tx((t) => reverseOperation(t, owner, { operationId: power.id, reason: 'внесли дважды' }, meta(owner), { idempotencyKey: randomUUID(), clock }));
  await run(recordWithdrawal, { branchId: b1, amountKop: 500, occurredAt: day, comment: 'изъятие' });
  await run(transferBetweenPlaces, { branchId: b1, from: 'cash', amountKop: 4_000, occurredAt: day, comment: 'сдали на счёт' });
  // приход по сеансу и возврат – как их проводит K10
  const session = await tx((t) =>
    postMoneyOperation(t, sys, { branchId: b1, kind: 'income', place: 'cash', method: 'cash', amountKop: 30_000, source: 'session', ref: { type: 'payment', id: randomUUID() }, occurredAt: new Date(day) }, { idempotencyKey: randomUUID() }, sysMeta, clock),
  );
  await tx((t) =>
    postMoneyOperation(t, sys, { branchId: b1, kind: 'refund', place: 'cash', method: 'cash', amountKop: 10_000, comment: 'возврат', ref: { type: 'operation', id: session.id }, occurredAt: new Date(day) }, { idempotencyKey: randomUUID() }, sysMeta, clock),
  );
  // не деньги: погашение сертификата 1 500 (филиал b1) и сгорание 700; оплата баллами – платёж сеанса
  const certRef = { kind: 'certificate' as const, ownerType: 'certificate' as const, ownerId: randomUUID() };
  await db.client.query(`INSERT INTO app.ledger_accounts (kind, unit, owner_type, owner_id) VALUES ('certificate', 'RUB_KOP', 'certificate', $1)`, [certRef.ownerId]);
  const author = { type: 'system' as const, id: null };
  await post(db.client, { entries: [{ account: certRef, amount: 5_000, type: 'certificate.issue', branchId: b2, occurredAt: new Date(day) }], idempotencyKey: randomUUID(), author });
  await post(db.client, { entries: [{ account: certRef, amount: -1_500, type: 'certificate.redeem', branchId: b1, occurredAt: new Date(day) }], idempotencyKey: randomUUID(), author });
  await post(db.client, { entries: [{ account: certRef, amount: -700, type: 'certificate.expire', branchId: b1, occurredAt: new Date(day) }], idempotencyKey: randomUUID(), author });
  const client = (await db.client.query<{ id: string }>(`INSERT INTO app.clients (phone_e164, first_name, status, created_by_type, registered_at) VALUES ('+79130000009', 'К', 'active', 'system', now()) RETURNING id`)).rows[0]!.id;
  const res = (await db.client.query<{ id: string }>(`INSERT INTO app.resources (branch_id, resource_type, name) VALUES ($1, 'pc', 'ПК') RETURNING id`, [b1])).rows[0]!.id;
  const bk = (await db.client.query<{ id: string }>(
    `INSERT INTO app.bookings (checkout_id, branch_id, client_id, resource_id, period, price_kop, source, created_by_type, status)
     VALUES (gen_random_uuid(), $1, $2, $3, tstzrange('2026-11-15T03:00:00Z', '2026-11-15T04:00:00Z', '[)'), 30000, 'crm', 'staff', 'arrived') RETURNING id`,
    [b1, client, res],
  )).rows[0]!.id;
  await db.client.query(`INSERT INTO app.payment_sessions (booking_id, branch_id, client_id, amount_due_kop, booking_version, status) VALUES ($1, $2, $3, 30000, 1, 'paid')`, [bk, b1, client]);
  const p = (await db.client.query<{ id: string }>(`INSERT INTO app.payments (session_id, attempt, total_kop, topup_rule_snapshot, recorded_by, recorded_at) VALUES ($1, 1, 30000, false, gen_random_uuid(), $2) RETURNING id`, [bk, day])).rows[0]!.id;
  await db.client.query(`INSERT INTO app.payment_lines (payment_id, line_no, method, amount_kop, points_centi, ledger_posting_id) VALUES ($1, 1, 'points', 30000, 6000, gen_random_uuid())`, [p]);
  // второй филиал – одна операция
  await run(recordIncome, { branchId: b2, method: 'transfer', amountKop: 9_000, source: 'other', occurredAt: day });
});
afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('сводка филиала', () => {
  it('числа по местам и итог; закрывающий остаток = остаток счёта K3; переводы и изъятия – не результат', async () => {
    const s = await branchSummary(pool, owner, { branchId: b1, from: '2026-11-15' });
    expect(s).toMatchObject({ from: '2026-11-15', to: '2026-11-15', timezone: 'Asia/Novosibirsk' });
    const [cash, noncash] = s.places;
    expect(cash).toEqual({ place: 'cash', openingKop: 100_700, incomeKop: 35_000, expenseKop: 1_000, withdrawalKop: 500, transferInKop: 0, transferOutKop: 4_000, correctionKop: 0, refundKop: 10_000, closingKop: 120_200 });
    expect(noncash).toEqual({ place: 'noncash', openingKop: 0, incomeKop: 3_000, expenseKop: 0, withdrawalKop: 0, transferInKop: 4_000, transferOutKop: 0, correctionKop: 0, refundKop: 0, closingKop: 7_000 });
    expect(cash!.closingKop).toBe(await balance(b1, 'cash_branch'));
    expect(noncash!.closingKop).toBe(await balance(b1, 'cash_branch_noncash'));
    expect(s.total).toEqual({ openingKop: 100_700, incomeKop: 38_000, expenseKop: 1_000, resultKop: 27_000, closingKop: 127_200, operationsCount: 9 });
    expect(s.incomeBySource).toEqual({ session: 30_000, certificate_sale: 0, event: 5_000, extra_service: 0, other: 3_000 });
    expect(s.incomeByMethod).toEqual({ cash: 35_000, card: 3_000, transfer: 0 });
    expect(new Map(s.expenseByCategory.map((c) => [c.name, [c.amountKop, c.sub.map((x) => [x.name, x.amountKop])]]))).toEqual(
      new Map<string, unknown>([['Прочее', [1_000, []]], ['Коммунальные', [0, [['Электричество', 0]]]]]),
    );
    expect(s.nonMoney).toEqual({ pointsSessions: 1, pointsCenti: 6_000, certificateRedeemedKop: 1_500, certificateBurnedKop: 700 });
  });

  it('детализация = итог (TC-20): сумма операций журнала по виду совпадает с числом сводки', async () => {
    const s = await branchSummary(pool, owner, { branchId: b1, from: '2026-11-15' });
    const ops = await db.client.query<{ kind: string; total: string }>(
      `SELECT coalesce(o.kind, fo.kind) AS kind, sum(CASE WHEN fo.kind = 'reversal' THEN -fo.amount_kop ELSE fo.amount_kop END)::text AS total
       FROM journal.finance_operations fo LEFT JOIN journal.finance_operations o ON o.id = fo.reversal_of
       WHERE fo.branch_id = $1 AND fo.occurred_at >= '2026-11-14T17:00:00Z' AND fo.occurred_at < '2026-11-15T17:00:00Z' GROUP BY 1`,
      [b1],
    );
    const by = Object.fromEntries(ops.rows.map((r) => [r.kind, Number(r.total)]));
    expect(by.income).toBe(s.total.incomeKop);
    expect(by.expense).toBe(s.total.expenseKop);
    expect(by.refund).toBe(s.places.reduce((x, p) => x + p.refundKop, 0));
    expect(by.withdrawal).toBe(s.places[0]!.withdrawalKop);
    expect(by.place_transfer).toBe(s.places[0]!.transferOutKop);
  });

  it('сутки – по зоне филиала: 23:30 14-го там – в сводке 14-го; период из двух суток складывается', async () => {
    const d14 = await branchSummary(pool, owner, { branchId: b1, from: '2026-11-14' });
    expect(d14.total).toMatchObject({ incomeKop: 700, operationsCount: 1, openingKop: 100_000 });
    const both = await branchSummary(pool, owner, { branchId: b1, from: '2026-11-14', to: '2026-11-15' });
    expect(both.total).toMatchObject({ openingKop: 100_000, incomeKop: 38_700, closingKop: 127_200 });
  });

  it('права: Администратор – 403; Директор чужого филиала – 404; сеть – по зоне и сумма', async () => {
    await expect(branchSummary(pool, ctx('admin', [b1]), { branchId: b1, from: '2026-11-15' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(branchSummary(pool, ctx('director', [b2]), { branchId: b1, from: '2026-11-15' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const net = await networkSummary(pool, owner, { from: '2026-11-15' });
    expect(net.branches.map((b) => b.branchId).sort()).toEqual([b1, b2].sort());
    expect(net.total).toMatchObject({ incomeKop: 47_000, resultKop: 36_000, nonMoney: { pointsCenti: 6_000 } });
    const dir = await networkSummary(pool, ctx('director', [b2]), { from: '2026-11-15' });
    expect(dir.branches.map((b) => b.branchId)).toEqual([b2]);
    await expect(networkSummary(pool, ctx('admin', [b1]), { from: '2026-11-15' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

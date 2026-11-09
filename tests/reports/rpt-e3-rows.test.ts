// S4-76: сверка rpt_* 0311 с K24 §3.5, §3.9, §3.10 – недостающее в 0415. Схема вверх/вниз/вверх, права yu_reports, поля;
// деньги мероприятия в rpt_event_results совпадают со сводкой карточки (eventMoneySummary): предоплата, возврат, сторно, привязанный вручную расход.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateDown, migrateUp } from '../../db/migrate.ts';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { withTx } from '../../apps/api/src/modules/clients/index.ts';
import { createEvent } from '../../apps/api/src/modules/events/events.ts';
import { addLine } from '../../apps/api/src/modules/events/lines.ts';
import { addEventExpense, eventMoneySummary, linkEventExpense, recordEventIncome, refundEventIncome } from '../../apps/api/src/modules/events/money.ts';
import { recordExpense, recordIncome } from '../../apps/api/src/modules/finance/cashbox.ts';
import { reverseOperation } from '../../apps/api/src/modules/finance/corrections.ts';
import { createTestBranch } from '../helpers/network.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const NEW_VIEWS = ['rpt_event_results', 'rpt_shift_facts', 'rpt_shift_gap_rows', 'rpt_payroll_entries', 'rpt_payout_expenses'];
const clock = fixedClock('2026-11-14T05:00:00Z');
const AT = '2026-11-14T04:00:00Z';
let db: TestDatabase;
let pool: pg.Pool;
let reports: pg.Client;
let owner: AccessContext;
let branchId = '';

const meta = (): AuditRequestMeta => ({ actor: owner.actor, access: owner, source: 'crm', requestId: randomUUID() });
const opts = () => ({ idempotencyKey: randomUUID(), clock });
const tx = <T>(fn: (c: pg.PoolClient) => Promise<T>) => withTx(pool, fn);

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 6 });
  reports = new pg.Client({ connectionString: db.reportsUrl });
  await reports.connect();
  const s = await db.client.query<{ id: string }>(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('В', 'В', $1, 'owner', 'x') RETURNING id`, [`${randomUUID()}@yu.test`]);
  owner = { actor: { kind: 'staff', staffId: s.rows[0]!.id, sessionId: randomUUID() }, role: 'owner', network: true, cityIds: new Set(), branchIds: new Set(), at: clock.now() };
  branchId = (await createTestBranch(db.client)).id;
  await tx((c) => recordIncome(c, owner, { branchId, method: 'cash', amountKop: 10_000_000, source: 'other', occurredAt: AT }, meta(), opts()));
}, 60_000);
afterAll(async () => {
  await reports.end();
  await pool.end();
  await db.drop();
});

describe('0415: схема и права', () => {
  it('вверх/вниз/вверх', async () => {
    const clean = await createTestDatabase({ migrate: true });
    try {
      const n = (await clean.client.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.schema_migrations WHERE version >= '0415'`)).rows[0]!.n;
      const down = await migrateDown(clean.client, n);
      expect(down.at(-1)).toBe('0415');
      expect((await clean.client.query(`SELECT to_regclass('app.rpt_event_results') AS t`)).rows).toEqual([{ t: null }]);
      expect(await migrateUp(clean.client)).toEqual([...down].reverse());
    } finally {
      await clean.drop();
    }
  });

  it('новые представления читает yu_reports, yu_app в них не пишет; поля – как ждут отчёты 3.5, 3.9', async () => {
    for (const v of NEW_VIEWS) await expect(reports.query(`SELECT * FROM app.${v} LIMIT 1`), v).resolves.toBeTruthy();
    const write = await db.client.query<{ v: string }>(
      `SELECT v FROM unnest($1::text[]) v WHERE has_table_privilege('yu_app', 'app.' || v, 'INSERT') OR has_table_privilege('yu_app', 'app.' || v, 'DELETE')`,
      [NEW_VIEWS],
    );
    expect(write.rows).toEqual([]);
    const cols = async (v: string) => (await db.client.query<{ c: string }>(`SELECT column_name AS c FROM information_schema.columns WHERE table_schema = 'app' AND table_name = $1`, [v])).rows.map((x) => x.c);
    expect(await cols('rpt_event_results')).toEqual(expect.arrayContaining(['event_id', 'branch_id', 'held_at', 'has_booking', 'received_kop', 'refunded_kop', 'fact_cost_kop', 'due_kop', 'result_kop', 'deviation_kop']));
    expect(await cols('rpt_shift_facts')).toEqual(expect.arrayContaining(['shift_id', 'planned_start', 'planned_end', 'planned_minutes', 'state', 'paid_minutes', 'hourly_kop', 'attendance_fee_kop']));
    expect(await cols('rpt_shift_gap_rows')).toEqual(expect.arrayContaining(['gap_id', 'branch_id', 'gap_start', 'gap_minutes']));
    expect(await cols('rpt_payroll_entries')).toEqual(expect.arrayContaining(['entry_id', 'staff_id', 'branch_id', 'payroll_date', 'payroll_at', 'kind', 'amount_kop', 'value_kop', 'hourly_kop', 'fee_kop']));
    expect(await cols('rpt_payout_expenses')).toEqual(expect.arrayContaining(['operation_id', 'branch_id', 'statement_id', 'staff_id', 'amount_kop', 'occurred_at']));
  });
});

describe('rpt_event_results = сводка карточки мероприятия', () => {
  it('предоплата, возврат, сторно поступления, расход из карточки и привязанный вручную (без ref_type)', async () => {
    const typeId = (await db.client.query<{ id: string }>(`SELECT id FROM app.event_types WHERE code = 'other'`)).rows[0]!.id;
    const e = await tx((c) => createEvent(c, owner, { typeId, branchId, customer: { name: 'Анна', phone: '+79131234567' }, plannedStart: '2026-12-05T08:00:00Z', plannedEnd: '2026-12-05T10:00:00Z' }, meta(), clock));
    await tx((c) => addLine(c, owner, e.id, { kind: 'catering', name: 'Торт', quantity: 1, unit: 'шт', priceKop: 1_000_000, planCostKop: 300_000 }, meta(), clock));
    const cat = (
      await db.client.query<{ categoryId: string; subcategoryId: string }>(
        `SELECT p.id AS "categoryId", c.id AS "subcategoryId" FROM app.finance_categories p JOIN app.finance_categories c ON c.parent_id = p.id WHERE p.kind = 'expense' AND p.status = 'active' AND c.status = 'active' ORDER BY p.sort_order, c.sort_order LIMIT 1`,
      )
    ).rows[0]!;
    const pre = await tx((c) => recordEventIncome(c, owner, e.id, { method: 'cash', amountKop: 400_000, occurredAt: '2026-10-20T04:00:00Z' }, meta(), opts()));
    const wrong = await tx((c) => recordEventIncome(c, owner, e.id, { method: 'cash', amountKop: 99_000, occurredAt: AT }, meta(), opts()));
    await tx((c) => reverseOperation(c, owner, { operationId: wrong.id, reason: 'ошибка' }, meta(), opts()));
    await tx((c) => refundEventIncome(c, owner, e.id, { incomeOperationId: pre.id, amountKop: 50_000, method: 'cash', reason: 'часть' }, meta(), opts()));
    await tx((c) => addEventExpense(c, owner, e.id, { method: 'cash', amountKop: 120_000, ...cat, occurredAt: AT, comment: 'аниматор' }, meta(), opts()));
    const general = await tx((c) => recordExpense(c, owner, { branchId, method: 'cash', amountKop: 80_000, ...cat, occurredAt: AT, comment: 'кейтеринг' }, meta(), opts()));
    await tx((c) => linkEventExpense(c, owner, e.id, { operationId: general.id, inCost: true }, meta(), { clock }));

    const s = await eventMoneySummary(pool, e.id);
    const r = (await reports.query(`SELECT * FROM app.rpt_event_results WHERE event_id = $1`, [e.id])).rows[0];
    expect({ agreed: Number(r.agreed_price_kop), received: Number(r.received_kop), refunded: Number(r.refunded_kop), fact: Number(r.fact_cost_kop), due: Number(r.due_kop), result: Number(r.result_kop), deviation: Number(r.deviation_kop) }).toEqual({
      agreed: s.agreedKop, received: s.receivedKop, refunded: s.refundedKop, fact: s.factCostKop, due: s.dueKop, result: s.resultKop, deviation: s.deviationKop,
    });
    expect([s.receivedKop, s.refundedKop, s.factCostKop]).toEqual([400_000, 50_000, 200_000]);
    expect(r.held_at.toISOString()).toBe('2026-12-05T08:00:00.000Z');
  });
});

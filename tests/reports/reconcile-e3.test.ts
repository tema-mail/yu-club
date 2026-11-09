// S3-95: представления rpt_* Э3 (0311, K20 §11) и ночная сверка 16 §14 по сущностям Э3. Данные – командами модулей; портит их суперпользователь.
// Чистые данные – ноль; подменённое начисление, счёт сотрудника, расход без связи и две живые связи одной операции – расхождение уровня error.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateDown, migrateUp } from '../../db/migrate.ts';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { processEvent, clearSubscriptions } from '../../apps/api/src/core/outbox.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import { localToInstant, type Clock, type LocalDate, type LocalTime, type TimeZone } from '../../apps/api/src/core/time.ts';
import { recordExpense } from '../../apps/api/src/modules/finance/cashbox.ts';
import { reverseOperation } from '../../apps/api/src/modules/finance/corrections.ts';
import { linkOperation } from '../../apps/api/src/modules/finance/links.ts';
import { runReconcile, type ReconcileLogger } from '../../apps/api/src/modules/reports/reconcile.ts';
import { HANDLER_ATTENDANCE, HANDLER_RATE, registerPayrollHandlers, settleShift } from '../../apps/api/src/modules/shifts/accrual.ts';
import { setAttendance } from '../../apps/api/src/modules/shifts/attendance.ts';
import { closePeriod, createPeriod, postCorrection } from '../../apps/api/src/modules/shifts/payroll.ts';
import { createShift } from '../../apps/api/src/modules/shifts/plan.ts';
import { setRate } from '../../apps/api/src/modules/shifts/rates.ts';
import { createTestBranch } from '../helpers/network.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const TZ = 'Asia/Novosibirsk' as TimeZone;
const NOW = new Date('2026-11-14T05:00:00Z');
const clock: Clock = { now: () => NOW };
const at = (date: string, time: string) => localToInstant(date as LocalDate, time as LocalTime, TZ).toISOString();
const AT = '2026-11-14T04:00:00Z';
let db: TestDatabase;
let pool: pg.Pool;
let reports: pg.Client;
let branchId = '';
let staffId = '';
let categoryId = '';
let eventId = '';
let repairId = '';
const owner: AccessContext = { actor: { kind: 'staff', staffId: randomUUID(), sessionId: randomUUID() }, role: 'owner', network: true, cityIds: new Set(), branchIds: new Set(), at: NOW };
const meta = (): AuditRequestMeta => ({ actor: owner.actor, access: owner, source: 'crm', requestId: randomUUID() });

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
async function settle(): Promise<void> {
  const r = await db.client.query<{ id: string; event_type: string }>(
    `SELECT e.id, e.event_type FROM app.outbox_events e WHERE e.event_type IN ('shift.attendance_changed','staff.rate_set') AND NOT EXISTS (SELECT 1 FROM app.processed_events p WHERE p.event_id = e.id) ORDER BY e.occurred_at, e.id`,
  );
  for (const e of r.rows) await processEvent(pool, e.event_type === 'staff.rate_set' ? HANDLER_RATE : HANDLER_ATTENDANCE, e.id, clock.now());
}
function memoryLogger(): ReconcileLogger & { errors: Array<{ msg: string; obj: Record<string, unknown> }> } {
  const errors: Array<{ msg: string; obj: Record<string, unknown> }> = [];
  return { errors, info: () => undefined, error: (obj, msg) => void errors.push({ obj, msg }) };
}
const reconcile = async (log = memoryLogger()) => (await runReconcile(pool, { trigger: 'manual', clock, logger: log }))!;
const onlyCheck = async (name: string, log = memoryLogger()) => (await reconcile(log)).discrepancies.filter((d) => d.check === name);
async function shift(date: string, minutes: number, staff = staffId): Promise<string> {
  const s = await tx((t) => createShift(t, owner, { staffId: staff, branchId, start: at(date, '10:00'), end: at(date, '16:00') }, meta(), clock));
  await tx((t) => setAttendance(t, owner, s.id, { rowVersion: s.rowVersion, status: 'worked', paidMinutes: minutes, reason: 'факт' }, meta(), clock));
  await settle();
  return s.id;
}
const expense = (kop: number) =>
  tx((t) => recordExpense(t, owner, { branchId, method: 'cash', amountKop: kop, categoryId, occurredAt: AT, comment: 'расход' }, meta(), { idempotencyKey: randomUUID(), clock }));

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 8 });
  reports = new pg.Client({ connectionString: db.reportsUrl });
  await reports.connect();
  clearSubscriptions();
  registerPayrollHandlers({ clock });
  branchId = (await createTestBranch(db.client, { timezone: TZ })).id;
  await db.client.query(`INSERT INTO app.branch_weekly_hours (branch_id, weekday, open_time, close_time, valid_from, created_by) SELECT $1, d, '09:00', '21:00', '2026-01-01', $2 FROM generate_series(1, 7) d`, [branchId, randomUUID()]);
  await db.client.query(`INSERT INTO app.settings_values (key, level, branch_id, value, valid_from, created_by) VALUES ('finance.negative_balance_allowed', 'branch', $1, 'true', '2026-01-01', $2)`, [branchId, randomUUID()]);
  categoryId = (await db.client.query<{ id: string }>(`SELECT id FROM app.finance_categories WHERE name = 'Прочее' AND kind = 'expense'`)).rows[0]!.id;
  const s = await db.client.query<{ id: string }>(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', $1, 'admin', 'x') RETURNING id`, [`${randomUUID()}@yu.test`]);
  staffId = s.rows[0]!.id;
  await db.client.query(`INSERT INTO app.staff_assignments (staff_id, scope_type, branch_id, valid_from, created_by) VALUES ($1, 'branch', $2, '2026-01-01', $1)`, [staffId, branchId]);
  await tx((t) => setRate(t, owner, { staffId, validFrom: '2026-01-01', hourlyKop: 60_000, attendanceFeeKop: 10_000, reason: 'старт' }, meta(), clock));
  await settle();
  const type = await db.client.query<{ id: string }>(`SELECT id FROM app.event_types LIMIT 1`);
  const e = await db.client.query<{ id: string }>(
    `INSERT INTO app.events (number, type_id, branch_id, title, planned_start, planned_end, status, customer_name, customer_phone_e164, source, created_by_type)
     VALUES ('E-1', $1, $2, 'Праздник', '2026-11-20T08:00:00Z', '2026-11-20T10:00:00Z', 'new_request', 'Заказчик', '+79990000000', 'crm', 'staff') RETURNING id`,
    [type.rows[0]!.id, branchId],
  );
  eventId = e.rows[0]!.id;
  await db.client.query(`INSERT INTO app.event_lines (event_id, kind, name, quantity, unit, price_kop, discount_kop, discount_reason, plan_cost_kop) VALUES ($1, 'animator', 'Аниматор', 2, 'час', 100000, 5000, 'постоянный', 30000), ($1, 'catering', 'Торт', 1, 'шт', 50000, 0, NULL, 20000)`, [eventId]);
  const cat = await db.client.query<{ id: string }>(`INSERT INTO app.equipment_categories (name) VALUES ('Тест') RETURNING id`);
  const item = await db.client.query<{ id: string }>(`INSERT INTO app.equipment_items (inventory_number, name, category_id, status, branch_id, created_by, serial_number) VALUES ('INV-000001', 'Шлем', $1, 'repair', $2, $3, 'SN1') RETURNING id`, [cat.rows[0]!.id, branchId, owner.actor.staffId]);
  await db.client.query(`INSERT INTO app.equipment_placements (item_id, branch_id, placed_at, moved_by, reason) VALUES ($1, $2, '2026-01-01T00:00:00Z', $3, 'старт')`, [item.rows[0]!.id, branchId, owner.actor.staffId]);
  await db.client.query(`INSERT INTO app.equipment_warranties (kind, equipment_id, starts_on, ends_on) VALUES ('manufacturer', $1, '2026-01-01', '2027-01-01')`, [item.rows[0]!.id]);
  const rep = await db.client.query<{ id: string }>(
    `INSERT INTO app.repairs (number, equipment_id, branch_id, broken_at_unknown, detected_at, registered_at, symptoms, priority, impact, created_by)
     VALUES ('R-000001', $1, $2, true, '2026-11-10T00:00:00Z', '2026-11-10T00:00:00Z', 'не включается', 'high', 'partial', $3) RETURNING id`,
    [item.rows[0]!.id, branchId, owner.actor.staffId],
  );
  repairId = rep.rows[0]!.id;
  await db.client.query(`INSERT INTO journal.repair_status_history (repair_id, to_status, at, by_staff_id, comment) VALUES ($1, 'new', '2026-11-10T00:00:00Z', $2, 'создан'), ($1, 'in_repair', '2026-11-11T00:00:00Z', $2, 'в работе'), ($1, 'in_repair', '2026-11-12T00:00:00Z', $2, 'повторно')`, [repairId, owner.actor.staffId]);
}, 60_000);
afterAll(async () => {
  clearSubscriptions();
  await reports.end();
  await pool.end();
  await db.drop();
});

describe('0311: схема', () => {
  it('вверх/вниз/вверх; CHECK check_name содержит 0211, 0311 и utilization_over_capacity', async () => {
    const clean = await createTestDatabase({ migrate: true });
    try {
      const n = (await clean.client.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.schema_migrations WHERE version >= '0311'`)).rows[0]!.n;
      const down = await migrateDown(clean.client, n);
      expect(down.at(-1)).toBe('0311');
      expect((await clean.client.query(`SELECT to_regclass('app.rpt_shifts') AS t`)).rows).toEqual([{ t: null }]);
      expect(await migrateUp(clean.client)).toEqual([...down].reverse());
      const def = (await clean.client.query<{ d: string }>(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'reconcile_discrepancies_check_name_check'`)).rows[0]!.d;
      for (const v of ['ledger_balance', 'cash_place', 'payroll_accrual', 'payroll_balance', 'event_expense', 'repair_expense', 'operation_link', 'utilization_over_capacity']) expect(def).toContain(v);
    } finally {
      await clean.drop();
    }
  });

  it('представления читает yu_reports, таблицы модулей – нет; yu_app не пишет в них', async () => {
    for (const v of ['rpt_events', 'rpt_event_money', 'rpt_repair_money', 'rpt_shifts', 'rpt_shift_gaps', 'rpt_payroll', 'rpt_equipment', 'rpt_repairs', 'rpt_payroll_accruals', 'rpt_object_expenses', 'rpt_operation_links']) {
      await expect(reports.query(`SELECT * FROM app.${v} LIMIT 1`), v).resolves.toBeTruthy();
    }
    for (const t of ['app.events', 'app.staff_shifts', 'app.repairs', 'app.equipment_items', 'journal.staff_rates']) {
      await expect(reports.query(`SELECT 1 FROM ${t} LIMIT 1`), t).rejects.toMatchObject({ code: '42501' });
    }
    await expect(pool.query(`DELETE FROM app.rpt_shifts`)).rejects.toMatchObject({ code: '42501' });
  });

  it('поля представлений – по K20 §11', async () => {
    const cols = async (v: string) => (await db.client.query<{ c: string }>(`SELECT column_name AS c FROM information_schema.columns WHERE table_schema = 'app' AND table_name = $1`, [v])).rows.map((x) => x.c);
    const wanted: Record<string, string[]> = {
      rpt_events: ['event_id', 'number', 'branch_id', 'type_code', 'status', 'held_on', 'agreed_price_kop', 'planned_cost_kop', 'planned_cost_by_kind', 'discounts_kop', 'has_booking', 'has_resources', 'source', 'customer_client_id'],
      rpt_event_money: ['event_id', 'operation_id', 'kind', 'role', 'in_cost', 'line_kind', 'category_id', 'subcategory_id', 'amount_kop', 'direction', 'occurred_at', 'reversed'],
      rpt_repair_money: ['repair_id', 'operation_id', 'amount_kop', 'occurred_at', 'payer_branch_id', 'reversed'],
      rpt_shifts: ['shift_id', 'branch_id', 'staff_id', 'local_date', 'planned_period', 'actual_period', 'status', 'state', 'paid_minutes', 'rate_missing'],
      rpt_shift_gaps: ['branch_id', 'local_date', 'gap_period'],
      rpt_payroll: ['period_id', 'staff_id', 'branch_id', 'hours_amount_kop', 'per_shift_kop', 'penalties_kop', 'bonuses_kop', 'adjustments_kop', 'to_pay_kop', 'paid_kop', 'paid_at', 'statement_status'],
      rpt_equipment: ['equipment_id', 'branch_id', 'unit_id', 'room_id', 'resource_ids', 'status', 'inventory_no', 'serial_no', 'category_id'],
      rpt_repairs: ['repair_id', 'equipment_id', 'branch_id', 'incident_at', 'started_at', 'finished_at', 'contractor_id', 'warranty', 'priority', 'status', 'block_ids'],
    };
    for (const [v, want] of Object.entries(wanted)) expect(await cols(v), v).toEqual(expect.arrayContaining(want));
  });

  it('реальные данные: мероприятие, ремонт и оборудование', async () => {
    const e = (await reports.query(`SELECT * FROM app.rpt_events WHERE event_id = $1`, [eventId])).rows[0];
    expect(e).toMatchObject({ number: 'E-1', agreed_price_kop: '245000', planned_cost_kop: '50000', discounts_kop: '5000', has_booking: false, has_resources: false, source: 'crm' });
    expect(e.planned_cost_by_kind).toEqual({ animator: 30000, catering: 20000 });
    const r = (await reports.query(`SELECT * FROM app.rpt_repairs WHERE repair_id = $1`, [repairId])).rows[0];
    expect(r).toMatchObject({ incident_at_is_detected: true, warranty: true, priority: 'high', finished_at: null, block_ids: [] });
    expect(r.started_at.toISOString()).toBe('2026-11-11T00:00:00.000Z');
    const q = (await reports.query(`SELECT * FROM app.rpt_equipment WHERE inventory_no = 'INV-000001'`)).rows[0];
    expect(q).toMatchObject({ status: 'repair', serial_no: 'SN1', resource_ids: [], unit_id: null });
  });
});

describe('смены и зарплата', () => {
  it('rpt_shifts, пустые интервалы и деньги расчёта: начисление, части, штрафы, корректировка', async () => {
    const id = await shift('2026-10-05', 90);
    const row = (await reports.query(`SELECT * FROM app.rpt_shifts WHERE shift_id = $1`, [id])).rows[0];
    expect(row).toMatchObject({ state: 'closed', status: 'worked', paid_minutes: 90, rate_missing: false, actual_period: null });

    const gaps = await reports.query<{ local_date: string; lo: string; hi: string }>(
      `SELECT to_char(local_date, 'YYYY-MM-DD') AS local_date, to_char(lower(gap_period) AT TIME ZONE 'Asia/Novosibirsk', 'HH24:MI') AS lo, to_char(upper(gap_period) AT TIME ZONE 'Asia/Novosibirsk', 'HH24:MI') AS hi
       FROM app.rpt_shift_gaps WHERE branch_id = $1 AND local_date = '2026-10-05' ORDER BY lower(gap_period)`,
      [branchId],
    );
    expect(gaps.rows.map((g) => [g.lo, g.hi])).toEqual([['09:00', '10:00'], ['16:00', '21:00']]);
    const whole = await reports.query(`SELECT 1 FROM app.rpt_shift_gaps WHERE branch_id = $1 AND local_date = '2026-10-06'`, [branchId]);
    expect(whole.rows.length).toBe(1); // без смены – весь открытый день
    await db.client.query(`INSERT INTO app.calendar_exceptions (branch_id, scope_type, local_date, kind, reason, created_by) VALUES ($1, 'branch', '2026-10-07', 'closed', 'ремонт', $2)`, [branchId, owner.actor.staffId]);
    expect((await reports.query(`SELECT 1 FROM app.rpt_shift_gaps WHERE branch_id = $1 AND local_date = '2026-10-07'`, [branchId])).rows).toEqual([]);

    const p = await tx((t) => createPeriod(t, owner, { from: '2026-10-01', to: '2026-10-31' }, meta(), clock));
    await tx((t) => postCorrection(t, owner, { staffId, amountKop: 500, ref: { type: 'shift', id }, reason: 'поправка' }, meta(), { idempotencyKey: randomUUID(), clock }));
    const pay = await reports.query(`SELECT * FROM app.rpt_payroll WHERE period_id = $1 AND staff_id = $2 AND branch_id = $3`, [p.id, staffId, branchId]);
    expect(pay.rows[0]).toMatchObject({ hours_amount_kop: '90000', per_shift_kop: '0', penalties_kop: '0', to_pay_kop: '90000', paid_kop: '0' });
  });

  it('чистые данные – ноль; пересмотр смены и закрытый период расхождений не дают', async () => {
    const worked = await shift('2026-09-10', 60);
    const seen = await db.client.query<{ row_version: number }>(`SELECT row_version FROM app.staff_shifts WHERE id = $1`, [worked]);
    await tx((t) => setAttendance(t, owner, worked, { rowVersion: seen.rows[0]!.row_version, status: 'worked', paidMinutes: 120, reason: 'поправили время' }, meta(), clock));
    await settle();
    const noShow = await shift('2026-09-11', 60);
    const ns = await db.client.query<{ row_version: number }>(`SELECT row_version FROM app.staff_shifts WHERE id = $1`, [noShow]);
    await tx((t) => setAttendance(t, owner, noShow, { rowVersion: ns.rows[0]!.row_version, status: 'no_show', reason: 'не вышел' }, meta(), clock));
    await settle();

    const closedShift = await shift('2026-09-15', 60);
    const closedPeriod = await tx((t) => createPeriod(t, owner, { from: '2026-09-01', to: '2026-09-30' }, meta(), clock));
    await tx((t) => closePeriod(t, owner, closedPeriod.id, {}, meta(), clock));
    // Запоздавшее изменение факта в закрытом периоде: разница – системной корректировкой в открытом (K18 §6), сумма по смене сходится с формулой.
    await db.client.query(`UPDATE app.staff_shifts SET paid_minutes = 30, fact_version = fact_version + 1 WHERE id = $1`, [closedShift]);
    await tx((t) => settleShift(t, closedShift, 'attendance', clock));
    expect((await db.client.query(`SELECT 1 FROM journal.ledger_entries WHERE ref_id = $1 AND refs ? 'closedPeriodId'`, [closedShift])).rows.length).toBe(1);

    const linkedEvent = await expense(10_000);
    await tx((t) => linkOperation(t, owner, { operationId: linkedEvent.id, ref: { type: 'event', id: eventId }, role: 'expense', inCost: true }, meta(), clock));
    const linkedRepair = await expense(20_000);
    await tx((t) => linkOperation(t, owner, { operationId: linkedRepair.id, ref: { type: 'repair', id: repairId }, role: 'expense' }, meta(), clock));
    const reversed = await expense(30_000);
    await tx((t) => linkOperation(t, owner, { operationId: reversed.id, ref: { type: 'repair', id: repairId }, role: 'expense' }, meta(), clock));
    await tx((t) => reverseOperation(t, owner, { operationId: reversed.id, reason: 'ошибка' }, meta(), { idempotencyKey: randomUUID(), clock }));

    const log = memoryLogger();
    const r = await reconcile(log);
    expect(r.discrepancies).toEqual([]);
    expect(log.errors).toEqual([]);
    expect(r.status).toBe('ok');
    expect(r.checked.payroll_accrual).toBeGreaterThanOrEqual(4);
    expect(r.checked.payroll_balance).toBe(1);
    expect(r.checked.event_expense).toBe(1);
    expect(r.checked.repair_expense).toBe(1);
    expect(r.checked.operation_link).toBe(3);

    const money = await reports.query(`SELECT reversed, amount_kop, payer_branch_id FROM app.rpt_repair_money WHERE repair_id = $1 ORDER BY amount_kop`, [repairId]);
    expect(money.rows).toEqual([{ reversed: false, amount_kop: '20000', payer_branch_id: branchId }, { reversed: true, amount_kop: '30000', payer_branch_id: branchId }]);
    const eventMoney = await reports.query(`SELECT role, in_cost, kind, direction, reversed FROM app.rpt_event_money WHERE event_id = $1`, [eventId]);
    expect(eventMoney.rows).toEqual([{ role: 'expense', in_cost: true, kind: 'expense', direction: 'out', reversed: false }]);
  });

  it('корректировка закрытого периода без начисления, потом ставка задним числом – не расхождение: ставка самой корректировки', async () => {
    const staff2 = (await db.client.query<{ id: string }>(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('В', 'Ф', $1, 'admin', 'x') RETURNING id`, [`${randomUUID()}@yu.test`])).rows[0]!.id;
    await db.client.query(`INSERT INTO app.staff_assignments (staff_id, scope_type, branch_id, valid_from, created_by) VALUES ($1, 'branch', $2, '2026-01-01', $1)`, [staff2, branchId]);
    await tx((t) => setRate(t, owner, { staffId: staff2, validFrom: '2026-01-01', hourlyKop: 60_000, attendanceFeeKop: 0, reason: 'старт' }, meta(), clock));
    await settle();
    // Смена закрытого сентября без начисления (не была отмечена до закрытия); факт пришёл после – корректировка по ставке на дату.
    const id = (await db.client.query<{ id: string }>(
      `INSERT INTO app.staff_shifts (staff_id, branch_id, local_date, period, created_by, created_at)
       VALUES ($1, $2, '2026-09-25', tstzrange($3::timestamptz, $4::timestamptz, '[)'), $1, $5) RETURNING id`,
      [staff2, branchId, at('2026-09-25', '10:00'), at('2026-09-25', '16:00'), NOW],
    )).rows[0]!.id;
    await db.client.query(`UPDATE app.staff_shifts SET status = 'worked', paid_minutes = 60, fact_version = fact_version + 1 WHERE id = $1`, [id]);
    await tx((t) => settleShift(t, id, 'attendance', clock));
    expect((await db.client.query(`SELECT amount FROM journal.ledger_entries WHERE ref_id = $1 AND refs ? 'closedPeriodId'`, [id])).rows).toEqual([{ amount: '60000' }]);
    // Новая ставка задним числом: закрытый период не пересчитывается (K18 §3), корректировка остаётся по прежней.
    await tx((t) => setRate(t, owner, { staffId: staff2, validFrom: '2026-09-01', hourlyKop: 90_000, attendanceFeeKop: 0, reason: 'повышение' }, meta(), clock));
    await settle();
    expect((await onlyCheck('payroll_accrual')).filter((d) => d.objectId === id)).toEqual([]);
  });

  it('событие в очереди – не расхождение; после обработки считается', async () => {
    const s = await tx((t) => createShift(t, owner, { staffId, branchId, start: at('2026-10-20', '10:00'), end: at('2026-10-20', '16:00') }, meta(), clock));
    await tx((t) => setAttendance(t, owner, s.id, { rowVersion: s.rowVersion, status: 'worked', paidMinutes: 60, reason: 'факт' }, meta(), clock));
    expect(await onlyCheck('payroll_accrual')).toEqual([]);
    await settle();
    expect(await onlyCheck('payroll_accrual')).toEqual([]);
  });

  it('подменённое начисление: минуты смены не совпали с записью K3 – расхождение и лог error', async () => {
    const id = await shift('2026-07-10', 60);
    await db.client.query(`UPDATE app.staff_shifts SET paid_minutes = 600 WHERE id = $1`, [id]);
    const log = memoryLogger();
    const found = await onlyCheck('payroll_accrual', log);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ objectType: 'shift', objectId: id, branchId, expected: 610_000, actual: 60_000 });
    expect(log.errors.some((e) => e.msg === 'reconcile: расхождение payroll_accrual')).toBe(true);
    await db.client.query(`UPDATE app.staff_shifts SET paid_minutes = 60 WHERE id = $1`, [id]);
    const row = (await db.client.query(`SELECT check_name, object_type, object_id FROM journal.reconcile_discrepancies WHERE object_id = $1`, [id])).rows;
    expect(row[0]).toMatchObject({ check_name: 'payroll_accrual', object_type: 'shift' });
  });

  it('worked по ставке без записи K3 – расхождение', async () => {
    const id = await shift('2026-07-12', 60);
    const saved = await db.client.query<{ paid_minutes: number; status: string }>(`SELECT paid_minutes, status FROM app.staff_shifts WHERE id = $1`, [id]);
    expect(saved.rows[0]!.status).toBe('worked');
    await db.client.query(`UPDATE app.staff_shifts SET unpaid_confirmed = true WHERE id = $1`, [id]);
    const found = await onlyCheck('payroll_accrual');
    expect(found.map((d) => [d.objectId, d.expected, d.actual])).toEqual([[id, 0, 60_000]]);
    await db.client.query(`UPDATE app.staff_shifts SET unpaid_confirmed = false WHERE id = $1`, [id]);
  });

  it('счёт сотрудника: кэш баланса не равен записям – payroll_balance, а не ledger_balance', async () => {
    await db.client.query(`UPDATE app.ledger_accounts SET balance = balance + 777 WHERE kind = 'staff_payroll' AND owner_id = $1`, [staffId]);
    const r = await reconcile();
    const mine = r.discrepancies.filter((d) => d.objectId === staffId);
    expect(mine.map((d) => d.check)).toEqual(['payroll_balance']);
    expect(mine[0]!.actual - mine[0]!.expected).toBe(777);
    expect(r.discrepancies.some((d) => d.check === 'ledger_balance')).toBe(false);
    await db.client.query(`UPDATE app.ledger_accounts SET balance = balance - 777 WHERE kind = 'staff_payroll' AND owner_id = $1`, [staffId]);
  });
});

describe('связи операций', () => {
  it('расход мероприятия и ремонта со ссылкой, но без связи – расхождение на объект', async () => {
    const ins = (kop: number, type: string, id: string) =>
      db.client.query(
        `INSERT INTO journal.finance_operations (branch_id, kind, place, method, direction, amount_kop, category_id, comment, ref_type, ref_id, occurred_at, author_type, posting_id)
         VALUES ($1, 'expense', 'cash', 'cash', 'out', $2, $3, 'подмена', $4, $5, $6, 'system', gen_random_uuid()) RETURNING id`,
        [branchId, kop, categoryId, type, id, AT],
      );
    await ins(5_000, 'event', eventId);
    await ins(7_000, 'repair', repairId);
    const r = await reconcile();
    const ev = r.discrepancies.find((d) => d.check === 'event_expense');
    const rp = r.discrepancies.find((d) => d.check === 'repair_expense');
    expect(ev).toMatchObject({ objectType: 'event', objectId: eventId, branchId, expected: 15_000, actual: 10_000, details: {} });
    expect(rp).toMatchObject({ objectType: 'repair', objectId: repairId, branchId, expected: 27_000, actual: 20_000 });
  });

  it('одна операция – две живые связи (индекс снят подменой) и связь на несуществующий объект – operation_link', async () => {
    const op = await expense(1_000);
    await tx((t) => linkOperation(t, owner, { operationId: op.id, ref: { type: 'event', id: eventId }, role: 'expense' }, meta(), clock));
    await db.client.query(`DROP INDEX app.finance_operation_links_one_live`);
    const second = await db.client.query(`INSERT INTO app.finance_operation_links (operation_id, branch_id, ref_type, ref_id, role, linked_by, linked_at) VALUES ($1, $2, 'repair', $3, 'expense', $4, now())`, [op.id, branchId, repairId, owner.actor.staffId]);
    expect(second.rowCount).toBe(1);
    const orphan = await expense(2_000);
    await tx((t) => linkOperation(t, owner, { operationId: orphan.id, ref: { type: 'event', id: randomUUID() }, role: 'expense' }, meta(), clock));
    const r = await reconcile();
    const links = r.discrepancies.filter((d) => d.check === 'operation_link');
    expect(links.find((d) => d.objectId === op.id)).toMatchObject({ expected: 1, actual: 2, details: { issue: 'multiple_live' } });
    expect(links.find((d) => d.objectId === orphan.id)).toMatchObject({ details: { issue: 'orphan_ref' } });
  });
});

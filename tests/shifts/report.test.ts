// S3-21: отчёт K18 §10: детализация = итог по каждой строке (16 §14); смена не считается дважды по филиалам (05 §10.3); фильтры ограничены зоной
// (приёмка 21); прогноз отделён от факта (приёмка 18); итоги с пустыми интервалами; сходимость со снимком ведомости; маршрут №318.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { clearSubscriptions, processEvent } from '../../apps/api/src/core/outbox.ts';
import type { AccessContext, StaffRole } from '../../apps/api/src/core/permissions.ts';
import { localToInstant, type Clock, type LocalDate, type LocalTime, type TimeZone } from '../../apps/api/src/core/time.ts';
import { HANDLER_ATTENDANCE, registerPayrollHandlers } from '../../apps/api/src/modules/shifts/accrual.ts';
import { setAttendance } from '../../apps/api/src/modules/shifts/attendance.ts';
import { closePeriod, createPeriod, postCorrection } from '../../apps/api/src/modules/shifts/payroll.ts';
import { createPenalty } from '../../apps/api/src/modules/shifts/penalties.ts';
import { createShift } from '../../apps/api/src/modules/shifts/plan.ts';
import { setRate } from '../../apps/api/src/modules/shifts/rates.ts';
import { payrollReport, type ReportRow } from '../../apps/api/src/modules/shifts/report.ts';
import { hashPassword, staffAuthConfig } from '../../apps/api/src/modules/staff/auth.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { createTestBranch, createTestCity } from '../helpers/network.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

let db: TestDatabase;
let pool: pg.Pool;
let cityA = '';
let cityB = '';
let a = '';
let b = '';
let c = '';
const TZ = 'Asia/Novosibirsk' as TimeZone;
const NOW = new Date('2026-11-14T05:00:00Z');
const clock: Clock = { now: () => NOW };
const past = { now: () => new Date('2020-01-01T00:00:00Z') };
const at = (time: string, date: string) => localToInstant(date as LocalDate, time as LocalTime, TZ).toISOString();
const FROM = '2026-10-01';
const TO = '2026-10-31';

function ctx(role: StaffRole, branchIds: string[] = []): AccessContext {
  return { actor: { kind: 'staff', staffId: randomUUID(), sessionId: randomUUID() }, role, network: role === 'owner', cityIds: new Set(), branchIds: new Set(branchIds), at: clock.now() };
}
const owner = ctx('owner');
const meta = (x: AccessContext = owner): AuditRequestMeta => ({ actor: x.actor, access: x, source: 'crm', requestId: randomUUID() });

async function tx<T>(fn: (t: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await fn(client);
    await client.query('COMMIT');
    return r;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
async function newStaff(branches: string[], hourly = 60_000, fee = 10_000, role = 'admin'): Promise<string> {
  const r = await db.client.query<{ id: string }>(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('Иван', 'Смирнов', $1, $2, 'x') RETURNING id`, [`${randomUUID()}@yu.test`, role]);
  const s = r.rows[0]!.id;
  for (const x of branches) await db.client.query(`INSERT INTO app.staff_assignments (staff_id, scope_type, branch_id, valid_from, created_by) VALUES ($1, 'branch', $2, '2026-01-01', $1)`, [s, x]);
  await tx((t) => setRate(t, owner, { staffId: s, validFrom: '2026-01-01', hourlyKop: hourly, attendanceFeeKop: fee, reason: 'старт' }, meta(), clock));
  return s;
}
const plan = (staffId: string, branchId: string, date: string) => tx((t) => createShift(t, owner, { staffId, branchId, start: at('10:00', date), end: at('14:00', date) }, meta(), past));
async function worked(staffId: string, branchId: string, date: string, minutes: number): Promise<string> {
  const s = await plan(staffId, branchId, date);
  await tx((t) => setAttendance(t, owner, s.id, { rowVersion: 1, status: 'worked', paidMinutes: minutes, reason: 'факт' }, meta(), clock));
  return s.id;
}
async function settle(): Promise<void> {
  const r = await db.client.query<{ id: string }>(`SELECT e.id FROM app.outbox_events e WHERE e.event_type = 'shift.attendance_changed' AND NOT EXISTS (SELECT 1 FROM app.processed_events p WHERE p.event_id = e.id) ORDER BY e.occurred_at, e.id`);
  for (const e of r.rows) await processEvent(pool, HANDLER_ATTENDANCE, e.id, clock.now());
}
const report = (filter: Record<string, string> = {}, who = owner) => payrollReport(pool, who, { from: FROM, to: TO, ...filter }, clock);
const rowOf = (rows: ReportRow[], staffId: string) => rows.find((r) => r.staffId === staffId)!;

/** Детализация = итог: каждая сумма строки складывается из записей и смен. */
function assertDetailMatches(r: ReportRow): void {
  const entries = r.detail!.entries;
  const byKind = (kind: string) => entries.filter((e) => e.kind === kind).reduce((s, e) => s + e.amountKop, 0);
  expect(byKind('payroll.accrual')).toBe(r.accruedKop);
  expect(0 - byKind('payroll.penalty')).toBe(r.penaltiesKop);
  expect(byKind('payroll.bonus')).toBe(r.bonusesKop);
  expect(byKind('payroll.correction')).toBe(r.correctionsKop);
  expect(entries.reduce((s, e) => s + e.amountKop, 0)).toBe(r.toPayKop);
  expect(r.detail!.shifts.reduce((s, x) => s + x.accruedKop, 0)).toBe(r.accruedKop);
  expect(r.detail!.shifts.length).toBe(r.plannedShifts);
  expect(r.branches.reduce((s, l) => s + l.plannedShifts, 0)).toBe(r.plannedShifts);
  expect(r.branches.reduce((s, l) => s + l.accruedKop, 0)).toBe(r.accruedKop);
}

let both = '';
let onlyC = '';
let plannedOnly = '';

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 10 });
  clearSubscriptions();
  registerPayrollHandlers({ clock });
  cityA = await createTestCity(db.client);
  cityB = await createTestCity(db.client);
  a = (await createTestBranch(db.client, { cityId: cityA })).id;
  b = (await createTestBranch(db.client, { cityId: cityA })).id;
  c = (await createTestBranch(db.client, { cityId: cityB })).id;
  for (const x of [a, b, c]) await db.client.query(`INSERT INTO app.branch_weekly_hours (branch_id, weekday, open_time, close_time, valid_from, created_by) SELECT $1, d, '10:00', '22:00', '2026-01-01', $2 FROM generate_series(1, 7) d`, [x, randomUUID()]);
  await db.client.query(`INSERT INTO app.settings_values (key, level, value, valid_from, created_by) VALUES ('payroll.penalties_enabled', 'network', 'true', '2026-01-01', $1)`, [randomUUID()]);

  both = await newStaff([a, b]);
  await worked(both, a, '2026-10-05', 120); // 120 000 + 10 000
  await worked(both, b, '2026-10-06', 60); // 60 000, короче порога
  const noShow = await plan(both, a, '2026-10-07');
  await tx((t) => setAttendance(t, owner, noShow.id, { rowVersion: 1, status: 'no_show', reason: 'нет' }, meta(), clock));
  await tx((t) => createPenalty(t, owner, { staffId: both, branchId: a, date: '2026-10-05', amountKop: 5_000, reason: 'опоздание' }, meta(), clock));
  await tx((t) => createPenalty(t, owner, { staffId: both, branchId: null, date: '2026-10-05', amountKop: 2_000, reason: 'сетевая' }, meta(), clock));
  onlyC = await newStaff([c], 30_000, 0);
  await worked(onlyC, c, '2026-10-05', 60);
  plannedOnly = await newStaff([a], 60_000, 0);
  await tx((t) => createShift(t, owner, { staffId: plannedOnly, branchId: a, start: at('10:00', '2026-11-20'), end: at('12:00', '2026-11-20') }, meta(), past));
  await settle();
});
afterAll(async () => {
  clearSubscriptions();
  await pool.end();
  await db.drop();
});

describe('строки и итоги', () => {
  it('строка сотрудника: счётчики, ставки, суммы; смена в двух филиалах не считается дважды', async () => {
    const r = await report({ detail: 'true' });
    const row = rowOf(r.rows, both);
    expect(row).toMatchObject({ name: 'Иван Смирнов', plannedShifts: 3, workedShifts: 2, noShows: 1, paidMinutes: 180, hourlyKop: 60_000, attendanceFeeKop: 10_000, accruedKop: 190_000, penaltiesKop: 7_000, toPayKop: 183_000, otherDeductionsKop: 0, statementStatus: null, actualPayoutDate: null });
    expect(new Map(row.branches.map((l) => [l.branchId, l.accruedKop]))).toEqual(new Map([[a, 130_000], [b, 60_000]]));
    for (const x of r.rows) assertDetailMatches(x);
  });

  it('прогноз отделён от факта (приёмка 18): плановая смена – только в прогнозе', async () => {
    const r = await payrollReport(pool, owner, { from: '2026-11-15', to: '2026-11-30' }, clock);
    const row = rowOf(r.rows, plannedOnly);
    expect(row).toMatchObject({ forecastKop: 120_000, accruedKop: 0, toPayKop: 0 });
    expect(r.totals).toMatchObject({ forecastKop: 120_000, accruedKop: 0, toPayKop: 0 });
    const inOct = await report();
    expect(inOct.totals.forecastKop).toBe(0);
    expect(inOct.totals.accruedKop).toBe(220_000);
  });

  it('итоги: суммы, число сотрудников, пустые интервалы покрытия; суммы пересчитываются при смене фильтра', async () => {
    const all = await report();
    expect(all.totals).toMatchObject({ accruedKop: 220_000, penaltiesKop: 7_000, toPayKop: 213_000, staffCount: 2, unclosedShifts: 0, otherDeductionsKop: 0 });
    expect(all.totals.emptyIntervals).toBeGreaterThan(30); // все дни месяца без смен – по дыре на филиал
    const inB = await report({ branchIds: b });
    expect(inB.totals).toMatchObject({ accruedKop: 60_000, penaltiesKop: 0, toPayKop: 60_000, staffCount: 1 });
    expect(rowOf(inB.rows, both).branches.map((l) => l.branchId)).toEqual([b]);
    const worked_ = await report({ shiftStatus: 'worked' });
    expect(worked_.totals).toMatchObject({ accruedKop: 220_000, penaltiesKop: 0 });
    const noShows = await report({ shiftStatus: 'no_show' });
    expect(noShows.totals).toMatchObject({ accruedKop: 0, staffCount: 1 });
    expect(rowOf(noShows.rows, both).noShows).toBe(1);
    expect((await report({ staffId: onlyC })).rows.map((x) => x.staffId)).toEqual([onlyC]);
    expect((await report({ role: 'director' })).rows).toEqual([]);
    expect((await report({ cityId: cityB })).totals.accruedKop).toBe(30_000);
  });
});

describe('зона', () => {
  it('Директор зоны {А, Б}: только суммы зоны; сетевой штраф и другой город не видны; филиал и город вне зоны – 404', async () => {
    const director = ctx('director', [a]);
    const r = await report({ detail: 'true' }, director);
    expect(r.rows.map((x) => x.staffId)).toEqual([both]);
    const row = r.rows[0]!;
    expect(row).toMatchObject({ accruedKop: 130_000, penaltiesKop: 5_000, toPayKop: 125_000, workedShifts: 1 });
    expect(row.detail!.entries.map((e) => e.branchId).every((x) => x === a)).toBe(true);
    assertDetailMatches(row);
    await expect(report({ branchIds: b }, director)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(report({ branchIds: `${a},${c}` }, director)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(report({ cityId: cityB }, director)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await report({ cityId: cityA }, director)).rows.map((x) => x.staffId)).toEqual([both]);
    expect((await report({ staffId: onlyC }, director)).rows).toEqual([]);
    expect(await report({}, ctx('director', []))).toMatchObject({ rows: [], totals: { staffCount: 0 } });
  });

  it('Администратор – 403; неверный период – 400', async () => {
    await expect(report({}, ctx('admin', [a]))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(payrollReport(pool, owner, {}, clock)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(payrollReport(pool, owner, { from: '2026-01-01', to: '2026-12-31' }, clock)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(payrollReport(pool, owner, { periodId: randomUUID() }, clock)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('период и ведомость', () => {
  it('по periodId: статус и дата выплаты из ведомости, фильтр по статусу расчёта; итог совпадает со снимком при закрытии; корректировка – в следующем периоде', async () => {
    const s = await newStaff([a], 60_000, 0);
    await worked(s, a, '2026-08-10', 60);
    await settle();
    const p = await tx((t) => createPeriod(t, owner, { from: '2026-08-01', to: '2026-08-31' }, meta(), clock));
    await tx((t) => closePeriod(t, owner, p.id, {}, meta(), clock));
    const r = await payrollReport(pool, owner, { periodId: p.id, staffId: s, detail: 'true' }, clock);
    const row = rowOf(r.rows, s);
    expect(row).toMatchObject({ statementStatus: 'calculated', toPayKop: 60_000 });
    assertDetailMatches(row);
    const snap = await db.client.query<{ totals: { toPayKop: number; accruedKop: number } }>(`SELECT totals FROM app.payroll_statements WHERE period_id = $1 AND staff_id = $2`, [p.id, s]);
    expect(snap.rows[0]!.totals).toMatchObject({ toPayKop: row.toPayKop, accruedKop: row.accruedKop });
    expect((await payrollReport(pool, owner, { periodId: p.id, statementStatus: 'paid' }, clock)).rows).toEqual([]);
    expect((await payrollReport(pool, owner, { periodId: p.id, statementStatus: 'calculated', staffId: s }, clock)).rows).toHaveLength(1);

    const st = await db.client.query<{ id: string }>(`SELECT id FROM app.payroll_statements WHERE period_id = $1 AND staff_id = $2`, [p.id, s]);
    await tx((t) => postCorrection(t, owner, { staffId: s, amountKop: -1_000, ref: { type: 'payroll_statement', id: st.rows[0]!.id }, reason: 'переплата' }, meta(), { idempotencyKey: randomUUID(), clock }));
    const after = await payrollReport(pool, owner, { periodId: p.id, staffId: s }, clock);
    expect(rowOf(after.rows, s).toPayKop).toBe(60_000); // закрытый период не изменился
    const nov = await payrollReport(pool, owner, { from: '2026-11-01', to: '2026-11-30', staffId: s, detail: 'true' }, clock);
    const novRow = rowOf(nov.rows, s);
    expect(novRow.correctionsKop).toBe(-1_000);
    assertDetailMatches(novRow);
  });
});

describe('маршрут №318', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), { staff: { pool, auth: staffAuthConfig('t'.repeat(40)), clock } });
  });
  afterAll(async () => {
    await app.close();
  });
  async function login(role: string, branch?: string): Promise<string> {
    const email = `${randomUUID()}@yu.test`;
    const password = 'Пароль-отчёта-проверка-1';
    const r = await db.client.query<{ id: string }>(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', $1, $2, $3) RETURNING id`, [email, role, await hashPassword(password)]);
    if (branch) await db.client.query(`INSERT INTO app.staff_assignments (staff_id, scope_type, branch_id, valid_from, created_by) VALUES ($1, 'branch', $2, '2026-01-01', $1)`, [r.rows[0]!.id, branch]);
    const res = await app.inject({ method: 'POST', url: '/api/crm/v1/auth/login', payload: { email, password } });
    return String(res.headers['set-cookie']).split(';')[0]!;
  }
  const get = (cookie: string, q: string) => app.inject({ method: 'GET', url: `/api/crm/v1/payroll/report?${q}`, headers: { cookie } });

  it('живые данные: Владелец – все, Директор – зона, чужой филиал 404, Администратор 403', async () => {
    const ownerCookie = await login('owner');
    const r = await get(ownerCookie, `from=${FROM}&to=${TO}&detail=true`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.json().totals.accruedKop).toBe(220_000);
    expect((r.json().rows as ReportRow[]).find((x) => x.staffId === both)?.detail?.entries.length).toBeGreaterThan(0);
    const dir = await login('director', a);
    const seen = await get(dir, `from=${FROM}&to=${TO}`);
    expect(seen.json().totals.accruedKop).toBe(130_000);
    expect((await get(dir, `from=${FROM}&to=${TO}&branchIds=${c}`)).statusCode).toBe(404);
    expect((await get(await login('admin', a), `from=${FROM}&to=${TO}`)).statusCode).toBe(403);
  });
});

// S4-77: отчёт «Сотрудники и смены» (K24 §3.9, 14 §12). Пустой интервал ≠ незакрытая смена (приёмка 15); короткая смена – по порогу
// из настройки; деньги: Директор зоны А – суммы филиалов А, как раздел «Зарплата» Э3, филиал Б – 404; Администратор – нет отчёта;
// в файле без reports.export.payroll – not_permitted; TC-19: выплата и расход кассы на неё – один расход; детализация = итог (TC-20).
// Данные – командами модулей смен, зарплаты и кассы.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { clearSubscriptions, processEvent } from '../../apps/api/src/core/outbox.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import { fixedClock, localToInstant, type LocalDate, type LocalTime, type TimeZone } from '../../apps/api/src/core/time.ts';
import { withTx } from '../../apps/api/src/modules/clients/index.ts';
import { financeReport } from '../../apps/api/src/modules/reports/finance.ts';
import type { Metric, ReportEnv } from '../../apps/api/src/modules/reports/framework.ts';
import { staffDetail, staffReport, type StaffMetric } from '../../apps/api/src/modules/reports/staff.ts';
import { HANDLER_ATTENDANCE, HANDLER_RATE, registerPayrollHandlers } from '../../apps/api/src/modules/shifts/accrual.ts';
import { setAttendance } from '../../apps/api/src/modules/shifts/attendance.ts';
import { calculateStatements, closePeriod, createPeriod, markPaid, setStatementStatus } from '../../apps/api/src/modules/shifts/payroll.ts';
import { createPayoutExpense } from '../../apps/api/src/modules/shifts/payout-expense.ts';
import { createPenalty } from '../../apps/api/src/modules/shifts/penalties.ts';
import { createShift } from '../../apps/api/src/modules/shifts/plan.ts';
import { setRate } from '../../apps/api/src/modules/shifts/rates.ts';
import { payrollReport } from '../../apps/api/src/modules/shifts/report.ts';
import { withReportTx } from '../../apps/api/src/modules/reports/framework.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';
import { d, reportFixtures, type Fx } from '../helpers/reports.ts';

const NSK = 'Asia/Novosibirsk' as TimeZone;
const MSK = 'Europe/Moscow' as TimeZone;
const clock = fixedClock('2026-11-14T05:00:00Z');
const OCT = { from: d('2026-10-01'), to: d('2026-10-31') };
const NOV = { from: d('2026-11-01'), to: d('2026-11-30') };
let db: TestDatabase;
let fx: Fx;
let a = '';
let b = '';
let s1 = '';
let s2 = '';
let toPay2 = 0;

const val = (m: Metric | undefined) => (m?.state === 'ok' ? m.value : m?.state === 'unavailable' ? `${m.state}/${m.reason}` : m?.state);
const meta = (o: AccessContext): AuditRequestMeta => ({ actor: o.actor, access: o, source: 'crm', requestId: randomUUID() });
const tx = <T>(fn: (c: pg.PoolClient) => Promise<T>) => withTx(fx.app, fn);
const at = (date: string, time: string, tz: TimeZone) => localToInstant(date as LocalDate, time as LocalTime, tz).toISOString();

async function settle(): Promise<void> {
  const r = await db.client.query<{ id: string; event_type: string }>(
    `SELECT e.id, e.event_type FROM app.outbox_events e WHERE e.event_type IN ('shift.attendance_changed','staff.rate_set') AND NOT EXISTS (SELECT 1 FROM app.processed_events p WHERE p.event_id = e.id) ORDER BY e.occurred_at, e.id`,
  );
  for (const e of r.rows) await processEvent(fx.app, e.event_type === 'staff.rate_set' ? HANDLER_RATE : HANDLER_ATTENDANCE, e.id, clock.now());
}
async function shift(staffId: string, branchId: string, tz: TimeZone, date: string, paidMinutes: number | null): Promise<string> {
  const o = fx.owner();
  const s = await tx((t) => createShift(t, o, { staffId, branchId, start: at(date, '10:00', tz), end: at(date, '16:00', tz) }, meta(o), clock));
  if (paidMinutes !== null) {
    await tx((t) => setAttendance(t, o, s.id, { rowVersion: s.rowVersion, status: 'worked', paidMinutes, reason: 'факт' }, meta(o), clock));
    await settle();
  }
  return s.id;
}
async function person(branchIds: string[]): Promise<string> {
  const id = (await db.client.query<{ id: string }>(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', $1, 'admin', 'x') RETURNING id`, [`${randomUUID()}@yu.test`])).rows[0]!.id;
  for (const br of branchIds) await db.client.query(`INSERT INTO app.staff_assignments (staff_id, scope_type, branch_id, valid_from, created_by) VALUES ($1, 'branch', $2, '2026-01-01', $1)`, [id, br]);
  const o = fx.owner();
  await tx((t) => setRate(t, o, { staffId: id, validFrom: '2026-01-01', hourlyKop: 60_000, attendanceFeeKop: 10_000, reason: 'старт' }, meta(o), clock));
  await settle();
  return id;
}
/** Отчёт «на файл»: fileDates ставит только экспорт. */
const asFile = <T>(ctx: AccessContext, fn: (env: ReportEnv) => Promise<T>) =>
  withReportTx(fx.reports, (t) => fn({ tx: t, main: fx.app, ctx, clock: fixedClock('2026-11-20T05:00:00Z'), fileDates: true }));

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  fx = await reportFixtures(db);
  clearSubscriptions();
  registerPayrollHandlers({ clock });
  a = (await fx.branch(NSK)).id;
  b = (await fx.branch(MSK)).id;
  await db.client.query(`INSERT INTO app.settings_values (key, level, branch_id, value, valid_from, created_by) VALUES ('finance.negative_balance_allowed', 'branch', $1, 'true', '2026-01-01', $2)`, [b, randomUUID()]);
  s1 = await person([a, b]);
  s2 = await person([b]);
  await shift(s1, a, NSK, '2026-10-05', 90); // короче порога 120 минут: без ставки за выход
  await shift(s1, a, NSK, '2026-10-06', 300);
  await shift(s1, a, NSK, '2026-10-07', null); // прошла без отметки – незакрытая
  await shift(s1, b, MSK, '2026-10-08', 120);
  await shift(s1, a, NSK, '2026-11-25', null); // плановая – прогноз
  await shift(s2, b, MSK, '2026-09-09', 60);
  // TC-19: ведомость S2 за сентябрь (октябрь не закрыть: в нём незакрытая смена) выплачена 05.11, расход кассы на выплату – в филиале Б
  const o = fx.owner();
  const p = await tx((t) => createPeriod(t, o, { from: '2026-09-01', to: '2026-09-30' }, meta(o), clock));
  await tx((t) => closePeriod(t, o, p.id, {}, meta(o), clock));
  const st = (await tx((t) => calculateStatements(t, o, p.id, meta(o), clock))).find((x) => x.staffId === s2)!;
  const checked = await tx((t) => setStatementStatus(t, o, st.id, { rowVersion: st.rowVersion, status: 'checked' }, meta(o), clock));
  const ready = await tx((t) => setStatementStatus(t, o, st.id, { rowVersion: checked.rowVersion, status: 'ready' }, meta(o), clock));
  const paid = await tx((t) => markPaid(t, o, st.id, { rowVersion: ready.rowVersion, actualPayoutDate: '2026-11-05' }, meta(o), clock));
  toPay2 = Number(paid.totals.toPayKop);
  await tx((t) => createPayoutExpense(t, o, st.id, { place: 'cash', method: 'cash', split: 'by_branch', occurredAt: '2026-11-05T04:00:00Z' }, meta(o), { idempotencyKey: randomUUID(), clock }));
}, 120_000);
afterAll(async () => {
  clearSubscriptions();
  await fx.close();
  await db.drop();
});

describe('смены', () => {
  it('приёмка 15: пустые интервалы и незакрытые смены – разные показатели; короткая смена по порогу настройки', async () => {
    const r = await fx.run(fx.owner(), (env) => staffReport(env, { period: OCT, branchIds: [a] }));
    expect(val(r.metrics.plannedShifts)).toBe(3);
    expect(val(r.metrics.workedShifts)).toBe(2);
    expect(val(r.metrics.unclosedShifts)).toBe(1);
    expect(val(r.metrics.shortShifts)).toBe(1);
    expect(val(r.metrics.paidMinutes)).toBe(390);
    expect(val(r.metrics.plannedMinutes)).toBe(1080);
    const gaps = await db.client.query<{ n: string }>(`SELECT count(*) AS n FROM app.rpt_shift_gaps WHERE branch_id = $1 AND local_date BETWEEN '2026-10-01' AND '2026-10-31'`, [a]);
    expect(val(r.metrics.emptyIntervals)).toBe(Number(gaps.rows[0]!.n));
    const unclosed = await fx.run(fx.owner(), (env) => staffDetail(env, { period: OCT, branchIds: [a] }, 'unclosedShifts'));
    expect(unclosed.rows.map((x) => [x.kind, x.status])).toEqual([['shift', 'planned']]);
    const empty = await fx.run(fx.owner(), (env) => staffDetail(env, { period: OCT, branchIds: [a] }, 'emptyIntervals', { limit: 3 }));
    expect(empty.rows.every((x) => x.kind === 'gap' && x.staffId === null)).toBe(true);
  });

  it('прогноз – по плановым сменам и ставке на дату, не в учёте', async () => {
    const r = await fx.run(fx.owner(), (env) => staffReport(env, { period: NOV, branchIds: [a] }));
    expect(val(r.metrics.forecast)).toBe(360_000 + 10_000);
    expect(val(r.metrics.accrued)).toBe('no_data');
  });
});

describe('деньги и права', () => {
  it('Директор зоны А: суммы филиала А, как раздел «Зарплата» Э3; выплата без филиала – not_permitted; филиал Б – 404', async () => {
    const dir = fx.director([a]);
    const r = await fx.run(dir, (env) => staffReport(env, { period: OCT }));
    const e3 = await payrollReport(fx.app, dir, { from: '2026-10-01', to: '2026-10-31' }, clock);
    expect(val(r.metrics.accrued)).toBe(90_000 + 310_000);
    expect(val(r.metrics.accrued)).toBe(e3.rows.reduce((s, x) => s + x.accruedKop, 0));
    expect(val(r.metrics.toPay)).toBe(e3.totals.toPayKop);
    expect(val(r.metrics.hoursAmount)).toBe(390_000);
    expect(val(r.metrics.perShift)).toBe(10_000);
    expect(val(r.metrics.paid)).toBe('unavailable/not_permitted');
    await expect(fx.run(dir, (env) => staffReport(env, { period: OCT, branchIds: [b] }))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(fx.run(dir, (env) => staffDetail(env, { period: OCT, branchIds: [b] }, 'accrued'))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('Администратор – отчёта нет (K24 §8); в файле без reports.export.payroll деньги – not_permitted, у Владельца – суммы', async () => {
    await expect(fx.run(fx.admin([a]), (env) => staffReport(env, { period: OCT }))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const file = await asFile(fx.director([a]), (env) => staffReport(env, { period: OCT }));
    expect(val(file.metrics.accrued)).toBe('unavailable/not_permitted');
    expect(val(file.metrics.plannedShifts)).toBe(3);
    expect((await asFile(fx.director([a]), (env) => staffDetail(env, { period: OCT }, 'accrued'))).total).toEqual({ state: 'unavailable', reason: 'not_permitted' });
    const own = await asFile(fx.owner(), (env) => staffReport(env, { period: OCT }));
    expect(val(own.metrics.accrued)).toBe(90_000 + 310_000 + 130_000);
  });

  it('TC-19: выплата по ведомости и расход кассы на неё – одна сумма, в «Финансах» расход учтён один раз', async () => {
    expect(toPay2).toBe(60_000);
    const r = await fx.run(fx.owner(), (env) => staffReport(env, { period: NOV }));
    expect(val(r.metrics.paid)).toBe(toPay2);
    expect(val(r.metrics.payoutExpense)).toBe(toPay2);
    const f = await fx.run(fx.owner(), (env) => financeReport(env, { period: NOV, branchIds: [b] }));
    expect(val(f.metrics.expenses)).toBe(toPay2);
    const dirB = await fx.run(fx.director([b]), (env) => staffReport(env, { period: NOV }));
    expect(val(dirB.metrics.payoutExpense)).toBe(toPay2); // расход кассы – в филиале, Директору виден
  });
});

describe('перенос минуса ведомости', () => {
  const JUN_JUL = { from: d('2026-06-01'), to: d('2026-07-31') };
  const JUL = { from: d('2026-07-01'), to: d('2026-07-31') };
  beforeAll(async () => {
    // S3: июнь – только штраф 500 ₽, ведомость в минусе, выплата переносит минус в июль; в июле смена 120 минут
    const o = fx.owner();
    await db.client.query(`INSERT INTO app.settings_values (key, level, value, valid_from, created_by) VALUES ('payroll.penalties_enabled', 'network', 'true', '2026-01-01', $1)`, [randomUUID()]);
    const s3 = await person([a]);
    // периоды без разрывов: перед сентябрьским – август и июль
    await tx((t) => createPeriod(t, o, { from: '2026-08-01', to: '2026-08-31' }, meta(o), clock));
    await tx((t) => createPeriod(t, o, { from: '2026-07-01', to: '2026-07-31' }, meta(o), clock));
    const jun = await tx((t) => createPeriod(t, o, { from: '2026-06-01', to: '2026-06-30' }, meta(o), clock));
    await tx((t) => createPenalty(t, o, { staffId: s3, branchId: a, date: '2026-06-10', amountKop: 50_000, reason: 'недостача' }, meta(o), clock));
    await tx((t) => closePeriod(t, o, jun.id, {}, meta(o), clock));
    const st = (await tx((t) => calculateStatements(t, o, jun.id, meta(o), clock))).find((x) => x.staffId === s3)!;
    const checked = await tx((t) => setStatementStatus(t, o, st.id, { rowVersion: st.rowVersion, status: 'checked' }, meta(o), clock));
    const ready = await tx((t) => setStatementStatus(t, o, st.id, { rowVersion: checked.rowVersion, status: 'ready' }, meta(o), clock));
    await tx((t) => markPaid(t, o, st.id, { rowVersion: ready.rowVersion, actualPayoutDate: '2026-07-02' }, meta(o), clock));
    await shift(s3, a, NSK, '2026-07-20', 120);
  }, 60_000);

  it.each([
    ['июнь–июль: ведомость-источник в периоде – минус один раз (штраф)', JUN_JUL, 0],
    ['июль: источник вне периода – минус виден корректировкой', JUL, -50_000],
  ] as const)('%s', async (_name, period, corrections) => {
    const r = await fx.run(fx.owner(), (env) => staffReport(env, { period }));
    const e3 = await payrollReport(fx.app, fx.owner(), { from: period.from, to: period.to }, clock);
    expect(e3.totals.correctionsKop).toBe(corrections);
    expect(val(r.metrics.toPay)).toBe(e3.totals.toPayKop);
    expect(r.metrics.adjustments.state === 'ok' ? r.metrics.adjustments.value : 0).toBe(corrections);
    expect(val(r.metrics.toPay)).toBe(120_000 + 10_000 - 50_000);
    for (const key of ['toPay', 'adjustments', 'penalties'] as const) {
      const page = await fx.run(fx.owner(), (env) => staffDetail(env, { period }, key, { limit: 500 }));
      const m = r.metrics[key];
      expect(page.rows.reduce((s, x) => s + x.value, 0), key).toBe(m.state === 'ok' ? m.value : 0);
    }
  });
});

describe('TC-20: детализация = итог', () => {
  it.each([
    ['owner', OCT],
    ['owner', NOV],
    ['director', OCT],
  ] as const)('%s %s', async (who, period) => {
    const ctx = who === 'owner' ? fx.owner() : fx.director([a]);
    const r = await fx.run(ctx, (env) => staffReport(env, { period }));
    for (const [key, m] of Object.entries(r.metrics) as Array<[StaffMetric, Metric]>) {
      let cursor: string | undefined;
      let sum = 0;
      let total: Metric | undefined;
      do {
        const page = await fx.run(ctx, (env) => staffDetail(env, { period }, key, { cursor, limit: 7 }));
        sum += page.rows.reduce((s, x) => s + x.value, 0);
        total = page.total;
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      if (m.state === 'ok') {
        expect(sum, key).toBe(m.value);
        expect(total?.state === 'ok' ? total.value : 0, key).toBe(m.value); // ноль при живом отчёте – в детализации «нет строк»
      } else if (m.state === 'unavailable') {
        expect(total, key).toEqual(m);
      }
    }
  });
});

// S4-77. Отчёт «Сотрудники и смены» (K24 §3.9, 14 §12). Смены – rpt_shift_facts (0415) по началу смены; пустые интервалы – rpt_shift_gap_rows
// (нет сотрудника) и незакрытые смены (не завершены: needs_review или плановая, конец которой прошёл без отметки, как unresolvedShifts Э3) –
// разные показатели (приёмка 15). Короткая смена – отработанная короче порога ставки за выход из настройки K18 (payroll.attendance_fee_min_minutes),
// отчёт порог не предполагает. Деньги – записи K3 rpt_payroll_entries по дате записи, как раздел «Зарплата» Э3 (report.ts): Директор видит суммы
// филиалов своей зоны, записи без филиала (выплата, сетевые корректировки) – только сетевая область. Деньги только с reports.payroll.view,
// в файле – ещё и reports.export.payroll (K24 §8), иначе unavailable/not_permitted. TC-19: выплата по ведомости (K3) и расход кассы на неё
// (rpt_payout_expenses) – разные показатели, расход один раз, начисление расходом не считается. Перенос минуса ведомости – один раз (0416).
import type { Tx } from '../../core/audit.ts';
import { roleAllows } from '../../core/permissions.ts';
import { resolveSettings } from '../../core/settings.ts';
import { formatLocal, instantToLocal, type TimeZone } from '../../core/time.ts';
import {
  computeMetrics, DAY_RULE, detailPage, localAt, metricDef, noData, okMetric, prevPeriod, resolveBranches, unavailable, where, windowsOf,
  type BranchWindow, type Metric, type MetricDef, type Period, type ReportEnv, type ReportParams,
} from './framework.ts';

export const STAFF_ACTION = 'reports.staff.view';
const UTC = 'UTC' as TimeZone;

type Cond = { sql: string; values?: unknown[] };

export type ShiftMetric = 'plannedShifts' | 'workedShifts' | 'noShows' | 'unclosedShifts' | 'shortShifts' | 'plannedMinutes' | 'paidMinutes';
export type GapMetric = 'emptyIntervals' | 'emptyMinutes';
export type MoneyMetric = 'accrued' | 'hoursAmount' | 'perShift' | 'penalties' | 'bonuses' | 'adjustments' | 'toPay' | 'paid' | 'payoutExpense';
export type StaffMetric = ShiftMetric | GapMetric | MoneyMetric | 'forecast';

const MONEY_KEYS: ReadonlySet<string> = new Set<MoneyMetric | 'forecast'>(['accrued', 'hoursAmount', 'perShift', 'penalties', 'bonuses', 'adjustments', 'toPay', 'paid', 'payoutExpense', 'forecast']);

export const STAFF_LABELS = {
  emptyIntervals: 'Пустые интервалы – часы работы филиала без сотрудника на смене',
  unclosedShifts: 'Незакрытые – смена на проверке или прошедшая без отметки явки',
  shortShifts: 'Короче порога ставки за выход (настройка «Минимум минут для ставки за выход»)',
  paid: 'Выплата проводится без филиала – видна только по всей сети',
  payoutExpense: 'Расход кассы на выплату по ведомостям – тот же расход, что в «Финансах», учтён один раз',
  forecast: 'Прогноз по плановым сменам и ставке на дату смены, в учёт не пишется',
};

function shiftDefs(now: Date, feeMin: number): Record<ShiftMetric, MetricDef> {
  const shifts = (agg: 'count' | 'sum', conds: Cond[], col?: string): MetricDef => ({
    spec: { view: 'app.rpt_shift_facts', date: 'planned_start', conds },
    agg, ...(col ? { col } : {}), unit: agg === 'sum' ? 'minutes' : 'count', dateBasis: 'session_start', idCol: 'shift_id',
  });
  const live = { sql: `t.status <> 'cancelled'` };
  const worked = { sql: `t.status = 'worked'` };
  return {
    plannedShifts: shifts('count', [live]),
    workedShifts: shifts('count', [worked]),
    noShows: shifts('count', [{ sql: `t.status = 'no_show'` }]),
    unclosedShifts: shifts('count', [{ sql: `t.status = 'needs_review' OR (t.status = 'planned' AND t.planned_end <= ?::timestamptz)`, values: [now] }]),
    shortShifts: shifts('count', [worked, { sql: 't.paid_minutes < ?::int', values: [feeMin] }]),
    plannedMinutes: shifts('sum', [live], 'planned_minutes'),
    paidMinutes: shifts('sum', [worked], 'paid_minutes'),
  };
}

function gapDefs(): Record<GapMetric, MetricDef> {
  const gaps = (agg: 'count' | 'sum'): MetricDef => ({
    spec: { view: 'app.rpt_shift_gap_rows', date: 'gap_start' },
    agg, ...(agg === 'sum' ? { col: 'gap_minutes' } : {}), unit: agg === 'sum' ? 'minutes' : 'count', dateBasis: 'session_start', idCol: 'gap_id',
  });
  return { emptyIntervals: gaps('count'), emptyMinutes: gaps('sum') };
}

/** Перенос минуса (0416): ведомость-источник целиком в окне отчёта – её минус уже в суммах, запись переноса не берётся (как report.ts Э3). */
const NOT_CARRIED_INSIDE: Cond = { sql: 'NOT (t.carry_from_at IS NOT NULL AND t.carry_from_at >= w.s AND t.carry_to_at <= w.e)' };

function moneyDefs(): Record<MoneyMetric, MetricDef> {
  const entries = (kinds: string[], col: string): MetricDef => ({
    spec: { view: 'app.rpt_payroll_entries', date: 'payroll_at', nullableBranch: true, conds: [{ sql: 't.kind = ANY(?::text[])', values: [kinds] }, NOT_CARRIED_INSIDE] },
    agg: 'sum', col, unit: 'kop', dateBasis: 'at', idCol: 'entry_id',
  });
  const accrual = ['payroll.accrual'];
  return {
    accrued: entries(accrual, 'amount_kop'),
    hoursAmount: entries(accrual, 'hourly_kop'),
    perShift: entries(accrual, 'fee_kop'),
    penalties: entries(['payroll.penalty'], 'value_kop'),
    bonuses: entries(['payroll.bonus'], 'amount_kop'),
    adjustments: entries(['payroll.correction'], 'amount_kop'),
    toPay: entries(['payroll.accrual', 'payroll.penalty', 'payroll.bonus', 'payroll.correction'], 'amount_kop'),
    paid: entries(['payroll.payout'], 'value_kop'),
    payoutExpense: { spec: { view: 'app.rpt_payout_expenses', date: 'occurred_at' }, agg: 'sum', col: 'amount_kop', unit: 'kop', dateBasis: 'occurred_at', idCol: 'operation_id' },
  };
}

/** Записи без филиала – только сетевая область без фильтров (как раздел «Зарплата»: «записи без филиала – только Владелец»). */
function moneyWindows(env: ReportEnv, p: ReportParams, windows: BranchWindow[], period: Period): BranchWindow[] {
  if (!env.ctx.network || p.cityId || p.branchIds?.length || windows.length === 0) return windows;
  // дата записи K3 – дата UTC (payrollDateSql), у записи без филиала payroll_at – её полночь UTC
  return [...windows, { branchId: null, start: new Date(`${period.from}T00:00:00Z`), end: new Date(Date.parse(`${period.to}T00:00:00Z`) + 86_400_000) }];
}

/** Деньги сотрудников: право на экран, в файле – ещё reports.export.payroll (fileDates ставит только экспорт). */
function moneyAllowed(env: ReportEnv): boolean {
  return roleAllows(env.ctx.role, 'reports.payroll.view') && (!env.fileDates || roleAllows(env.ctx.role, 'reports.export.payroll'));
}

const feeMinOf = async (env: ReportEnv): Promise<number> =>
  (await resolveSettings(env.main, ['payroll.attendance_fee_min_minutes'], { network: true }, env.clock.now()))['payroll.attendance_fee_min_minutes'].value;

/** Прогноз плановой смены – как shiftDtos (accrualParts): часы с округлением + ставка за выход от порога. Нет ставки – не считается. */
const FORECAST_SQL = `floor((t.planned_minutes * t.hourly_kop + 30) / 60.0) + CASE WHEN t.planned_minutes >= ?::int THEN t.attendance_fee_kop ELSE 0 END`;
const forecastDef = (): MetricDef => ({
  spec: { view: 'app.rpt_shift_facts', date: 'planned_start', conds: [{ sql: `t.status = 'planned' AND t.hourly_kop IS NOT NULL` }] },
  agg: 'count', unit: 'kop', dateBasis: 'session_start', idCol: 'shift_id',
});

async function forecastTotal(tx: Tx, windows: readonly BranchWindow[], feeMin: number): Promise<{ rows: number; value: number }> {
  if (windows.length === 0) return { rows: 0, value: 0 };
  const w = where(forecastDef().spec, windows);
  const expr = FORECAST_SQL.replace('?', `$${w.params.length + 1}`);
  const r = await tx.query<{ n: string; v: string }>(`SELECT count(*) AS n, coalesce(sum(${expr}), 0) AS v FROM ${w.sql}`, [...w.params, feeMin]);
  return { rows: Number(r.rows[0]!.n), value: Number(r.rows[0]!.v) };
}

const forecastOf = (minutes: number, hourly: number, fee: number, feeMin: number): number => Math.floor((minutes * hourly + 30) / 60) + (minutes >= feeMin ? fee : 0);

export interface StaffResult {
  metrics: Record<StaffMetric, Metric>;
  labels: typeof STAFF_LABELS;
  dateBasis: Record<StaffMetric, string>;
  period: Period;
  prevPeriod: Period;
  computedAt: string;
  dayRule: string;
}

export async function staffReport(env: ReportEnv, p: ReportParams): Promise<StaffResult> {
  const branches = await resolveBranches(env.tx, env.ctx, STAFF_ACTION, p);
  const prevP = prevPeriod(p.period);
  const cur = windowsOf(branches, p.period);
  const prev = windowsOf(branches, prevP);
  const feeMin = await feeMinOf(env);
  const sDefs = shiftDefs(env.clock.now(), feeMin);
  const shifts = await computeMetrics(env.tx, sDefs, cur, prev);
  const gaps = await computeMetrics(env.tx, gapDefs(), cur, prev);
  const mDefs = moneyDefs();
  let money: Record<MoneyMetric | 'forecast', Metric>;
  if (!moneyAllowed(env)) {
    money = Object.fromEntries([...MONEY_KEYS].map((k) => [k, unavailable('not_permitted')])) as Record<MoneyMetric | 'forecast', Metric>;
  } else {
    const m = await computeMetrics(env.tx, mDefs, moneyWindows(env, p, cur, p.period), moneyWindows(env, p, prev, prevP));
    const netWide = moneyWindows(env, p, cur, p.period).some((w) => w.branchId === null);
    const f = await forecastTotal(env.tx, cur, feeMin);
    const fPrev = await forecastTotal(env.tx, prev, feeMin);
    money = { ...m, paid: netWide ? m.paid : unavailable('not_permitted'), forecast: f.rows === 0 ? noData : okMetric(f.value, 'kop', fPrev.rows === 0 ? null : fPrev.value) };
  }
  const dateBasis = {} as Record<StaffMetric, string>;
  for (const [k, d] of Object.entries({ ...sDefs, ...gapDefs(), ...mDefs, forecast: forecastDef() })) dateBasis[k as StaffMetric] = d.dateBasis;
  return {
    metrics: { ...shifts, ...gaps, ...money },
    labels: STAFF_LABELS,
    dateBasis,
    period: p.period,
    prevPeriod: prevP,
    computedAt: env.clock.now().toISOString(),
    dayRule: DAY_RULE,
  };
}

export interface StaffDetailRow {
  id: string;
  kind: 'shift' | 'gap' | 'entry' | 'payout_expense';
  staffId: string | null;
  branchId: string | null;
  atLocal: string | null;
  status: string | null;
  plannedMinutes: number | null;
  paidMinutes: number | null;
  refType: string | null;
  refId: string | null;
  basis: string | null;
  value: number;
}

interface FactRow { shift_id: string; staff_id: string; branch_id: string; planned_start: Date; planned_minutes: number; status: string; paid_minutes: number | null; hourly_kop: string | null; attendance_fee_kop: string | null; [k: string]: unknown }
interface GapRow { gap_id: string; branch_id: string; gap_start: Date; gap_minutes: number; [k: string]: unknown }
interface EntryRow { entry_id: string; staff_id: string; branch_id: string | null; payroll_at: Date; kind: string; ref_type: string | null; ref_id: string | null; basis: string | null; [k: string]: unknown }
interface PayoutRow { operation_id: string; staff_id: string; branch_id: string; statement_id: string; occurred_at: Date; amount_kop: string; [k: string]: unknown }

const colValue = (def: MetricDef, row: Record<string, unknown>): number => (def.agg === 'sum' ? Number(row[def.col!] ?? 0) : 1);

export async function staffDetail(
  env: ReportEnv,
  p: ReportParams,
  metric: unknown,
  opts: { cursor?: string | undefined; limit?: number | undefined } = {},
): Promise<{ rows: StaffDetailRow[]; total: Metric; nextCursor: string | null }> {
  const branches = await resolveBranches(env.tx, env.ctx, STAFF_ACTION, p);
  const windows = windowsOf(branches, p.period);
  const zones = new Map(branches.map((b) => [b.id, b.timezone]));
  const feeMin = await feeMinOf(env);
  const isMoney = typeof metric === 'string' && MONEY_KEYS.has(metric);
  if (isMoney && !moneyAllowed(env)) return { rows: [], total: unavailable('not_permitted'), nextCursor: null };
  const blank = { staffId: null, status: null, plannedMinutes: null, paidMinutes: null, refType: null, refId: null, basis: null };

  if (metric === 'forecast') {
    const page = await detailPage<FactRow>(env.tx, forecastDef(), windows, opts);
    const t = await forecastTotal(env.tx, windows, feeMin);
    const rows = page.rows.map((r): StaffDetailRow => ({
      ...blank, id: r.shift_id, kind: 'shift', staffId: r.staff_id, branchId: r.branch_id, atLocal: localAt(env, r.planned_start, zones.get(r.branch_id)!), status: r.status,
      plannedMinutes: r.planned_minutes, value: forecastOf(r.planned_minutes, Number(r.hourly_kop), Number(r.attendance_fee_kop), feeMin),
    }));
    return { rows, total: t.rows === 0 ? noData : okMetric(t.value, 'kop'), nextCursor: page.nextCursor };
  }
  const all: Record<string, MetricDef> = { ...shiftDefs(env.clock.now(), feeMin), ...gapDefs(), ...moneyDefs() };
  const def = metricDef(all, metric);
  const view = def.spec.view;
  const w = view === 'app.rpt_payroll_entries' ? moneyWindows(env, p, windows, p.period) : windows;
  if (metric === 'paid' && !w.some((x) => x.branchId === null)) return { rows: [], total: unavailable('not_permitted'), nextCursor: null };
  const page = await detailPage<Record<string, unknown>>(env.tx, def, w, opts);
  const rows = page.rows.map((raw): StaffDetailRow => {
    const value = colValue(def, raw);
    if (view === 'app.rpt_shift_facts') {
      const r = raw as FactRow;
      return { ...blank, id: r.shift_id, kind: 'shift', staffId: r.staff_id, branchId: r.branch_id, atLocal: localAt(env, r.planned_start, zones.get(r.branch_id)!), status: r.status, plannedMinutes: r.planned_minutes, paidMinutes: r.paid_minutes, value };
    }
    if (view === 'app.rpt_shift_gap_rows') {
      const r = raw as GapRow;
      return { ...blank, id: r.gap_id, kind: 'gap', branchId: r.branch_id, atLocal: localAt(env, r.gap_start, zones.get(r.branch_id)!), plannedMinutes: r.gap_minutes, value };
    }
    if (view === 'app.rpt_payout_expenses') {
      const r = raw as PayoutRow;
      return { ...blank, id: r.operation_id, kind: 'payout_expense', staffId: r.staff_id, branchId: r.branch_id, atLocal: localAt(env, r.occurred_at, zones.get(r.branch_id)!), refType: 'payroll_statement', refId: r.statement_id, value };
    }
    const r = raw as EntryRow;
    // дата записи K3 – payroll_at, полночь этой даты в зоне филиала записи (без филиала – UTC)
    const tz = (r.branch_id ? zones.get(r.branch_id) : undefined) ?? UTC;
    const atLocal = env.fileDates ? instantToLocal(r.payroll_at, tz).date : formatLocal(r.payroll_at, tz, 'date');
    return { ...blank, id: r.entry_id, kind: 'entry', staffId: r.staff_id, branchId: r.branch_id, atLocal, status: r.kind, refType: r.ref_type, refId: r.ref_id, basis: r.basis, value };
  });
  return { rows, total: page.total.rows === 0 ? noData : okMetric(page.total.value, def.unit), nextCursor: page.nextCursor };
}

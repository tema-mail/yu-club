// S3-21. Отчёт по зарплате (K18 §10, 05 §10, без экспорта): строка сотрудника, разбивка по филиалам, итоги, детализация №318. Только чтение.
// Суммы – из записей K3 и смен: каждая сумма строки раскрывается списком смен и записей (16 §14). Смена ровно в одном филиале – двойного учёта нет.
// Фильтры – внутри зоны payroll.view: филиал вне зоны – 404; Директор видит сотрудников со сменами или записями в зоне и только суммы своей зоны,
// записи без филиала – только Владелец. Прогноз отделён от факта (05 §8.2): план только по сменам planned и в журнал не пишется.
// shiftStatus сужает смены и связанные с ними записи: суммы пересчитываются при смене фильтра (05 §10.5).
import { z } from 'zod';
import type { Db } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { can, roleAllows, type AccessContext } from '../../core/permissions.ts';
import { addDays, parseLocalDate, systemClock, type Clock, type LocalDate } from '../../core/time.ts';
import { payrollDateSql } from './accrual.ts';
import { coverage, MAX_COVERAGE_DAYS } from './coverage.ts';
import { unresolvedShifts } from './payroll.ts';
import { SHIFT_SELECT, shiftDtos, type ShiftDto, type ShiftRow, type ShiftStatus } from './plan.ts';
import { isUuid, notFound } from './rates.ts';

export const MAX_REPORT_DAYS = 93;

const querySchema = z.object({
  periodId: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  cityId: z.string().optional(),
  branchIds: z.string().optional(),
  staffId: z.string().optional(),
  role: z.enum(['owner', 'director', 'admin']).optional(),
  shiftStatus: z.enum(['planned', 'worked', 'no_show', 'cancelled', 'needs_review']).optional(),
  statementStatus: z.enum(['draft', 'calculated', 'checked', 'ready', 'paid', 'disputed']).optional(),
  detail: z.enum(['true', 'false']).optional(),
});

export interface ReportEntry {
  id: string;
  date: LocalDate;
  type: string;
  kind: string;
  branchId: string | null;
  amountKop: number;
  basis: string | null;
  ref: { type: string; id: string } | null;
}
export interface ReportShift extends Pick<ShiftDto, 'id' | 'branchId' | 'localDate' | 'plannedStart' | 'plannedEnd' | 'plannedMinutes' | 'status' | 'factStart' | 'factEnd' | 'paidMinutes' | 'flags'> {
  hourlyKop: number | null;
  attendanceFeeKop: number | null;
  forecastKop: number | null;
  accruedKop: number;
}
export interface ReportBranchLine {
  branchId: string;
  plannedShifts: number;
  workedShifts: number;
  noShows: number;
  plannedMinutes: number;
  paidMinutes: number;
  forecastKop: number;
  accruedKop: number;
}
export interface ReportRow {
  staffId: string;
  name: string;
  role: string;
  branches: ReportBranchLine[];
  plannedShifts: number;
  workedShifts: number;
  noShows: number;
  plannedMinutes: number;
  paidMinutes: number;
  hourlyKop: number | null;
  attendanceFeeKop: number | null;
  forecastKop: number;
  accruedKop: number;
  penaltiesKop: number;
  bonusesKop: number;
  correctionsKop: number;
  otherDeductionsKop: 0;
  toPayKop: number;
  statementStatus: string | null;
  plannedPayoutDate: LocalDate | null;
  actualPayoutDate: LocalDate | null;
  detail?: { shifts: ReportShift[]; entries: ReportEntry[] };
}
export interface PayrollReport {
  from: LocalDate;
  to: LocalDate;
  rows: ReportRow[];
  totals: { forecastKop: number; accruedKop: number; penaltiesKop: number; bonusesKop: number; correctionsKop: number; otherDeductionsKop: 0; toPayKop: number; staffCount: number; emptyIntervals: number; unclosedShifts: number };
}

async function resolveRange(db: Db, q: z.infer<typeof querySchema>): Promise<{ from: LocalDate; to: LocalDate; periodId: string | null }> {
  if (q.periodId) {
    if (!isUuid(q.periodId)) throw notFound();
    const r = await db.query<{ date_from: string; date_to: string }>(`SELECT to_char(date_from, 'YYYY-MM-DD') AS date_from, to_char(date_to, 'YYYY-MM-DD') AS date_to FROM app.payroll_periods WHERE id = $1`, [q.periodId]);
    if (!r.rows[0]) throw notFound();
    return { from: r.rows[0].date_from as LocalDate, to: r.rows[0].date_to as LocalDate, periodId: q.periodId };
  }
  try {
    const from = parseLocalDate(q.from ?? '');
    const to = parseLocalDate(q.to ?? '');
    if (from > to || addDays(from, MAX_REPORT_DAYS - 1) < to) throw new Error('range');
    return { from, to, periodId: null };
  } catch {
    throw new AppError('VALIDATION_FAILED', 400, `Нужен periodId или даты from и to (не больше ${MAX_REPORT_DAYS} дней)`, { maxDays: MAX_REPORT_DAYS });
  }
}

/** Филиалы отчёта внутри зоны; null – вся сеть (только Владелец без фильтров). Явный филиал вне зоны – 404 (приёмка 21). */
async function resolveBranches(db: Db, ctx: AccessContext, q: z.infer<typeof querySchema>): Promise<string[] | null> {
  let list: string[] | null = null;
  if (q.branchIds) {
    list = q.branchIds.split(',').filter(Boolean);
    for (const id of list) if (!isUuid(id) || !can(ctx, 'payroll.view', { branchId: id })) throw notFound();
  }
  if (q.cityId) {
    if (!isUuid(q.cityId)) throw notFound();
    const r = await db.query<{ id: string }>(`SELECT id FROM app.branches WHERE city_id = $1`, [q.cityId]);
    const inCity = r.rows.map((x) => x.id).filter((id) => can(ctx, 'payroll.view', { branchId: id }));
    if (inCity.length === 0) throw notFound();
    list = list ? list.filter((id) => inCity.includes(id)) : inCity;
  }
  if (list) return list;
  return ctx.network ? null : [...ctx.branchIds];
}

interface EntryRow {
  id: string;
  staff_id: string;
  date: string;
  entry_type: string;
  kind: string;
  branch_id: string | null;
  amount: string;
  basis: string | null;
  ref_type: string | null;
  ref_id: string | null;
  carried_from: string | null;
}

/** Пустые интервалы покрытия за период, кусками по 31 дню (K18 §10, 05 §10.5). */
async function countGaps(db: Db, ctx: AccessContext, branches: string[] | null, from: LocalDate, to: LocalDate): Promise<number> {
  const ids = branches ?? (await db.query<{ id: string }>(`SELECT id FROM app.branches WHERE status = 'active'`)).rows.map((x) => x.id);
  const visible = ids.filter((id) => can(ctx, 'shift.view', { branchId: id }));
  if (visible.length === 0) return 0;
  let gaps = 0;
  for (let start = from; start <= to; start = addDays(start, MAX_COVERAGE_DAYS)) {
    const last = addDays(start, MAX_COVERAGE_DAYS - 1);
    const items = await coverage(db, ctx, { branchIds: visible, from: start, to: last < to ? last : to });
    gaps += items.reduce((s, i) => s + i.gaps.length, 0);
  }
  return gaps;
}

export async function payrollReport(db: Db, ctx: AccessContext, raw: unknown, clock: Clock = systemClock): Promise<PayrollReport> {
  if (!roleAllows(ctx.role, 'payroll.view')) throw new AppError('FORBIDDEN', 403, 'Недостаточно прав', { action: 'payroll.view' });
  const parsed = querySchema.safeParse(raw ?? {});
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', 400, 'Неверные данные запроса', { issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  const q = parsed.data;
  if (q.staffId !== undefined && !isUuid(q.staffId)) throw notFound();
  const { from, to, periodId } = await resolveRange(db, q);
  const branches = await resolveBranches(db, ctx, q);

  // смены
  const shiftParams: unknown[] = [from, to];
  let shiftWhere = `s.local_date BETWEEN $1::date AND $2::date AND s.status <> 'cancelled'`;
  if (q.shiftStatus === 'cancelled') shiftWhere = `s.local_date BETWEEN $1::date AND $2::date`;
  if (branches) {
    shiftParams.push(branches);
    shiftWhere += ` AND s.branch_id = ANY($${shiftParams.length}::uuid[])`;
  }
  if (q.staffId) {
    shiftParams.push(q.staffId);
    shiftWhere += ` AND s.staff_id = $${shiftParams.length}`;
  }
  if (q.shiftStatus) {
    shiftParams.push(q.shiftStatus satisfies ShiftStatus);
    shiftWhere += ` AND s.status = $${shiftParams.length}`;
  }
  const shiftRows = (await db.query<ShiftRow>(`${SHIFT_SELECT} WHERE ${shiftWhere} ORDER BY s.local_date, lower(s.period), s.id`, shiftParams)).rows;
  const dtos = await shiftDtos(db, shiftRows, clock);
  const rates = await db.query<{ id: string; hourly_kop: string; attendance_fee_kop: string }>(
    `SELECT s.id, r.hourly_kop, r.attendance_fee_kop FROM app.staff_shifts s
       CROSS JOIN LATERAL (SELECT hourly_kop, attendance_fee_kop FROM journal.staff_rates x WHERE x.staff_id = s.staff_id AND x.valid_from <= s.local_date ORDER BY x.valid_from DESC, x.created_at DESC, x.id DESC LIMIT 1) r
      WHERE s.id = ANY($1::uuid[])`,
    [dtos.map((d) => d.id)],
  );
  const rateOf = new Map(rates.rows.map((r) => [r.id, { hourlyKop: Number(r.hourly_kop), attendanceFeeKop: Number(r.attendance_fee_kop) }]));

  // записи K3: те же условия зоны; сторно – в виде исходной записи; выплаты и компенсация переноса в итоги не входят
  const entryParams: unknown[] = [from, to];
  let entryWhere = `${payrollDateSql('le')} BETWEEN $1::date AND $2::date AND NOT (le.refs ? 'carryOffset') AND coalesce(o.entry_type, le.entry_type) <> 'payroll.payout'`;
  if (branches) {
    entryParams.push(branches);
    entryWhere += ` AND le.branch_id = ANY($${entryParams.length}::uuid[])`;
  }
  if (q.staffId) {
    entryParams.push(q.staffId);
    entryWhere += ` AND a.owner_id = $${entryParams.length}`;
  }
  const entryRows = (
    await db.query<EntryRow>(
      `SELECT le.id::text AS id, a.owner_id AS staff_id, to_char(${payrollDateSql('le')}, 'YYYY-MM-DD') AS date, le.entry_type, coalesce(o.entry_type, le.entry_type) AS kind,
              le.branch_id, le.amount::text AS amount, le.basis, le.ref_type, le.ref_id, le.refs->>'carriedFrom' AS carried_from
         FROM journal.ledger_entries le
         JOIN app.ledger_accounts a ON a.id = le.account_id AND a.kind = 'staff_payroll'
         LEFT JOIN journal.ledger_entries o ON o.id = le.reversal_of
        WHERE ${entryWhere} ORDER BY le.occurred_at, le.id`,
      entryParams,
    )
  ).rows;
  const matchedShifts = new Set(dtos.map((d) => d.id));
  // Перенос минуса: если ведомость-источник целиком в диапазоне, её минус уже в суммах – запись переноса задвоила бы его.
  const carrySources = [...new Set(entryRows.flatMap((e) => (e.carried_from ? [e.carried_from] : [])))];
  const carriedInside = new Set(
    (
      await db.query<{ id: string }>(
        `SELECT st.id FROM app.payroll_statements st JOIN app.payroll_periods p ON p.id = st.period_id WHERE st.id = ANY($1::uuid[]) AND p.date_from >= $2::date AND p.date_to <= $3::date`,
        [carrySources, from, to],
      )
    ).rows.map((x) => x.id),
  );
  const uncarried = entryRows.filter((e) => !(e.carried_from && carriedInside.has(e.carried_from)));
  const entries = q.shiftStatus ? uncarried.filter((e) => e.ref_type === 'shift' && e.ref_id !== null && matchedShifts.has(e.ref_id)) : uncarried;

  // сотрудники
  const staffIds = [...new Set([...dtos.map((d) => d.staffId), ...entries.map((e) => e.staff_id)])];
  const staffParams: unknown[] = [staffIds];
  let staffWhere = `id = ANY($1::uuid[])`;
  if (q.role) {
    staffParams.push(q.role);
    staffWhere += ` AND role = $2`;
  }
  const people = await db.query<{ id: string; name: string; role: string }>(`SELECT id, first_name || ' ' || last_name AS name, role FROM app.staff WHERE ${staffWhere} ORDER BY last_name, first_name, id`, staffParams);
  const latestRates = await db.query<{ staff_id: string; hourly_kop: string; attendance_fee_kop: string }>(
    `SELECT DISTINCT ON (staff_id) staff_id, hourly_kop, attendance_fee_kop FROM journal.staff_rates WHERE staff_id = ANY($1::uuid[]) AND valid_from <= $2::date ORDER BY staff_id, valid_from DESC, created_at DESC, id DESC`,
    [staffIds, to],
  );
  const latest = new Map(latestRates.rows.map((r) => [r.staff_id, r]));
  const statements = periodId
    ? await db.query<{ staff_id: string; status: string; planned: string | null; actual: string | null }>(
        `SELECT staff_id, status, to_char(planned_payout_date, 'YYYY-MM-DD') AS planned, to_char(actual_payout_date, 'YYYY-MM-DD') AS actual FROM app.payroll_statements WHERE period_id = $1`,
        [periodId],
      )
    : { rows: [] as Array<{ staff_id: string; status: string; planned: string | null; actual: string | null }> };
  const statementOf = new Map(statements.rows.map((s) => [s.staff_id, s]));

  const rows: ReportRow[] = [];
  for (const person of people.rows) {
    const st = statementOf.get(person.id);
    if (q.statementStatus && st?.status !== q.statementStatus) continue;
    const mine = dtos.filter((d) => d.staffId === person.id);
    const mineEntries = entries.filter((e) => e.staff_id === person.id);
    const lines = new Map<string, ReportBranchLine>();
    const lineOf = (branchId: string): ReportBranchLine => {
      const l = lines.get(branchId) ?? { branchId, plannedShifts: 0, workedShifts: 0, noShows: 0, plannedMinutes: 0, paidMinutes: 0, forecastKop: 0, accruedKop: 0 };
      lines.set(branchId, l);
      return l;
    };
    const rate = latest.get(person.id);
    const row: ReportRow = {
      staffId: person.id,
      name: person.name,
      role: person.role,
      branches: [],
      plannedShifts: 0,
      workedShifts: 0,
      noShows: 0,
      plannedMinutes: 0,
      paidMinutes: 0,
      hourlyKop: rate ? Number(rate.hourly_kop) : null,
      attendanceFeeKop: rate ? Number(rate.attendance_fee_kop) : null,
      forecastKop: 0,
      accruedKop: 0,
      penaltiesKop: 0,
      bonusesKop: 0,
      correctionsKop: 0,
      otherDeductionsKop: 0,
      toPayKop: 0,
      statementStatus: st?.status ?? null,
      plannedPayoutDate: (st?.planned ?? null) as LocalDate | null,
      actualPayoutDate: (st?.actual ?? null) as LocalDate | null,
    };
    for (const d of mine) {
      const l = lineOf(d.branchId);
      row.plannedShifts += 1;
      l.plannedShifts += 1;
      row.plannedMinutes += d.plannedMinutes;
      l.plannedMinutes += d.plannedMinutes;
      if (d.status === 'no_show') {
        row.noShows += 1;
        l.noShows += 1;
      }
      if (d.status === 'planned') {
        row.forecastKop += d.plannedAccrualKop ?? 0;
        l.forecastKop += d.plannedAccrualKop ?? 0;
      }
      if (d.status === 'worked') {
        row.workedShifts += 1;
        l.workedShifts += 1;
        row.paidMinutes += d.paidMinutes ?? 0;
        l.paidMinutes += d.paidMinutes ?? 0;
      }
    }
    for (const e of mineEntries) {
      const v = Number(e.amount);
      if (e.kind === 'payroll.accrual') {
        row.accruedKop += v;
        if (e.branch_id) lineOf(e.branch_id).accruedKop += v;
      } else if (e.kind === 'payroll.penalty') row.penaltiesKop -= v;
      else if (e.kind === 'payroll.bonus') row.bonusesKop += v;
      else if (e.kind === 'payroll.correction') row.correctionsKop += v;
    }
    row.toPayKop = row.accruedKop - row.penaltiesKop + row.bonusesKop + row.correctionsKop;
    row.branches = [...lines.values()].sort((a, b) => (a.branchId < b.branchId ? -1 : 1));
    if (q.detail === 'true') {
      row.detail = {
        shifts: mine.map((d) => {
          const r = rateOf.get(d.id);
          return {
            id: d.id,
            branchId: d.branchId,
            localDate: d.localDate,
            plannedStart: d.plannedStart,
            plannedEnd: d.plannedEnd,
            plannedMinutes: d.plannedMinutes,
            status: d.status,
            factStart: d.factStart,
            factEnd: d.factEnd,
            paidMinutes: d.paidMinutes,
            flags: d.flags,
            hourlyKop: r?.hourlyKop ?? null,
            attendanceFeeKop: r?.attendanceFeeKop ?? null,
            forecastKop: d.status === 'planned' ? d.plannedAccrualKop : null,
            accruedKop: mineEntries.filter((e) => e.kind === 'payroll.accrual' && e.ref_type === 'shift' && e.ref_id === d.id).reduce((s, e) => s + Number(e.amount), 0),
          };
        }),
        entries: mineEntries.map((e) => ({
          id: e.id,
          date: e.date as LocalDate,
          type: e.entry_type,
          kind: e.kind,
          branchId: e.branch_id,
          amountKop: Number(e.amount),
          basis: e.basis,
          ref: e.ref_type && e.ref_id ? { type: e.ref_type, id: e.ref_id } : null,
        })),
      };
    }
    rows.push(row);
  }

  const sum = (f: (r: ReportRow) => number) => rows.reduce((s, r) => s + f(r), 0);
  const shown = new Set(rows.map((r) => r.staffId));
  const unresolved = (await unresolvedShifts(db, { from, to }, clock.now(), q.staffId)).filter((u) => shown.has(u.staffId) && dtos.some((d) => d.id === u.shiftId));
  return {
    from,
    to,
    rows,
    totals: {
      forecastKop: sum((r) => r.forecastKop),
      accruedKop: sum((r) => r.accruedKop),
      penaltiesKop: sum((r) => r.penaltiesKop),
      bonusesKop: sum((r) => r.bonusesKop),
      correctionsKop: sum((r) => r.correctionsKop),
      otherDeductionsKop: 0,
      toPayKop: sum((r) => r.toPayKop),
      staffCount: rows.length,
      emptyIntervals: await countGaps(db, ctx, branches, from, to),
      unclosedShifts: unresolved.length,
    },
  };
}

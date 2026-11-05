// S3-18. Расчётные периоды и ведомости (K18 §7, §9, 05 §8.4, §11). Закрытие – под payroll_periods FOR UPDATE: всё, что пишет в счёт
// сотрудника или меняет смену, держит FOR SHARE строки периода (rates.ts), поэтому закрытие и запись не проходят мимо друг друга.
// Закрыть нельзя, пока в периоде есть нерешённое (PAYROLL_PERIOD_HAS_UNRESOLVED). При закрытии итоги каждой ведомости фиксируются снимком
// в totals и больше не меняются; исправление – payroll.correction в открытом периоде. Период записи K3 – её зарплатная дата (accrual.ts).
//
// Минус ведомости (toPayKop < 0, Q-154): paid без выплаты. В журнале минус уже есть, поэтому перенос – одна проводка из двух записей:
// payroll.correction на минус датой следующего открытого периода (её видит следующая ведомость) и payroll.correction на плюс с пометкой
// refs.carryOffset (в итоги не входит), иначе минус попал бы в баланс дважды. write_off – только запись-компенсация.
import { z } from 'zod';
import { writeAudit, type AuditRequestMeta, type Db } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { lockAccounts, post, type EntryInput, type RefType, type Tx } from '../../core/ledger.ts';
import { assertCan, roleAllows, type AccessContext } from '../../core/permissions.ts';
import { resolveSetting } from '../../core/settings.ts';
import { addDays, parseLocalDate, systemClock, type Clock, type LocalDate, type TimeZone } from '../../core/time.ts';
import { getBranch } from '../network/index.ts';
import { HANDLER_RATE, openPayrollDate, payrollDateSql, payrollInstant, staffAccount } from './accrual.ts';
import { SHIFT_SELECT, shiftDtos, type ShiftRow } from './plan.ts';
import { isUuid, lockPeriodCreation, lockPeriodsShared, notFound, requireReason } from './rates.ts';

export interface PayrollPeriodDto {
  id: string;
  from: LocalDate;
  to: LocalDate;
  status: 'open' | 'closed';
  closedAt: string | null;
  closedBy: string | null;
}

export type StatementStatus = 'draft' | 'calculated' | 'checked' | 'ready' | 'paid' | 'disputed';

export interface PayrollTotals {
  plannedShifts: number;
  workedShifts: number;
  noShows: number;
  plannedMinutes: number;
  paidMinutes: number;
  forecastKop: number;
  accruedKop: number;
  hourlyPartKop: number;
  feePartKop: number;
  penaltiesKop: number;
  bonusesKop: number;
  correctionsKop: number;
  toPayKop: number;
}
export interface BranchLine {
  branchId: string;
  workedShifts: number;
  paidMinutes: number;
  accruedKop: number;
}
export interface PayrollStatementDto {
  id: string;
  periodId: string;
  staffId: string;
  status: StatementStatus;
  totals: PayrollTotals;
  byBranch: BranchLine[];
  plannedPayoutDate: LocalDate | null;
  actualPayoutDate: LocalDate | null;
  payoutComment: string | null;
  needsReview: Array<{ shiftId: string; reason: string }>;
  rowVersion: number;
}

interface PeriodRow {
  id: string;
  date_from: string;
  date_to: string;
  status: 'open' | 'closed';
  closed_at: Date | null;
  closed_by: string | null;
}
const PERIOD_COLS = `id, to_char(date_from, 'YYYY-MM-DD') AS date_from, to_char(date_to, 'YYYY-MM-DD') AS date_to, status, closed_at, closed_by`;
const toPeriod = (r: PeriodRow): PayrollPeriodDto => ({ id: r.id, from: r.date_from as LocalDate, to: r.date_to as LocalDate, status: r.status, closedAt: r.closed_at?.toISOString() ?? null, closedBy: r.closed_by });
export const ZERO_TOTALS: PayrollTotals = { plannedShifts: 0, workedShifts: 0, noShows: 0, plannedMinutes: 0, paidMinutes: 0, forecastKop: 0, accruedKop: 0, hourlyPartKop: 0, feePartKop: 0, penaltiesKop: 0, bonusesKop: 0, correctionsKop: 0, toPayKop: 0 };

const FALLBACK_TZ = 'Europe/Moscow' as TimeZone; // запись без филиала: дата по зоне отчётов сети

/** Суммы K3 сотрудника по видам и филиалам за даты: сторно – в виде исходной записи; выплаты и компенсация переноса в итоги не входят. */
export const ENTRY_SUMS_SQL = `SELECT le.branch_id, coalesce(o.entry_type, le.entry_type) AS kind, sum(le.amount)::text AS sum
  FROM journal.ledger_entries le
  JOIN app.ledger_accounts a ON a.id = le.account_id AND a.kind = 'staff_payroll' AND a.owner_id = $1
  LEFT JOIN journal.ledger_entries o ON o.id = le.reversal_of
 WHERE ${payrollDateSql('le')} BETWEEN $2::date AND $3::date AND NOT (le.refs ? 'carryOffset') AND coalesce(o.entry_type, le.entry_type) <> 'payroll.payout'
 GROUP BY 1, 2`;

/** Итоги ведомости из смен и записей K3 (K18 §9). branchIds – только суммы этих филиалов (Директор, K18 §10). */
export async function computeTotals(db: Db, range: { from: string; to: string }, staffId: string, clock: Clock, branchIds?: string[]): Promise<{ totals: PayrollTotals; byBranch: BranchLine[] }> {
  const params: unknown[] = [staffId, range.from, range.to];
  let zone = '';
  if (branchIds) {
    params.push(branchIds);
    zone = ` AND s.branch_id = ANY($4::uuid[])`;
  }
  const shifts = await db.query<ShiftRow>(`${SHIFT_SELECT} WHERE s.staff_id = $1 AND s.local_date BETWEEN $2::date AND $3::date AND s.status <> 'cancelled'${zone}`, params);
  const dtos = await shiftDtos(db, shifts.rows, clock);
  const t: PayrollTotals = { ...ZERO_TOTALS };
  const lines = new Map<string, BranchLine>();
  const line = (branchId: string): BranchLine => {
    const l = lines.get(branchId) ?? { branchId, workedShifts: 0, paidMinutes: 0, accruedKop: 0 };
    lines.set(branchId, l);
    return l;
  };
  for (const d of dtos) {
    t.plannedShifts += 1;
    t.plannedMinutes += d.plannedMinutes;
    if (d.status === 'no_show') t.noShows += 1;
    if (d.status === 'planned') t.forecastKop += d.plannedAccrualKop ?? 0;
    if (d.status === 'worked') {
      t.workedShifts += 1;
      t.paidMinutes += d.paidMinutes ?? 0;
      const l = line(d.branchId);
      l.workedShifts += 1;
      l.paidMinutes += d.paidMinutes ?? 0;
    }
  }
  const sums = await db.query<{ branch_id: string | null; kind: string; sum: string }>(ENTRY_SUMS_SQL, [staffId, range.from, range.to]);
  for (const s of sums.rows) {
    if (branchIds && (s.branch_id === null || !branchIds.includes(s.branch_id))) continue;
    const v = Number(s.sum);
    if (s.kind === 'payroll.accrual') {
      t.accruedKop += v;
      if (s.branch_id) line(s.branch_id).accruedKop += v;
    } else if (s.kind === 'payroll.penalty') t.penaltiesKop -= v;
    else if (s.kind === 'payroll.bonus') t.bonusesKop += v;
    else if (s.kind === 'payroll.correction') t.correctionsKop += v;
  }
  const parts = await db.query<{ hourly: string | null; fee: string | null }>(
    `SELECT sum(x.hourly_part_kop)::text AS hourly, sum(x.fee_part_kop)::text AS fee
       FROM journal.payroll_accruals x JOIN journal.ledger_entries le ON le.id = x.ledger_entry_id JOIN app.staff_shifts s ON s.id = x.shift_id
      WHERE s.staff_id = $1 AND ${payrollDateSql('le')} BETWEEN $2::date AND $3::date${zone}
        AND NOT EXISTS (SELECT 1 FROM journal.ledger_entries r WHERE r.reversal_of = le.id)`,
    params,
  );
  t.hourlyPartKop = Number(parts.rows[0]?.hourly ?? 0);
  t.feePartKop = Number(parts.rows[0]?.fee ?? 0);
  t.toPayKop = t.accruedKop - t.penaltiesKop + t.bonusesKop + t.correctionsKop;
  return { totals: t, byBranch: [...lines.values()].sort((a, b) => (a.branchId < b.branchId ? -1 : 1)) };
}

/** Нерешённые смены диапазона (05 §8.3 «не включается молча»). staffId – одного сотрудника.
 *  now = null – для закрытия: нерешённая любая planned, и идущая, и будущая (иначе отметка после закрытия теряет часы). С now – для показа: только прошедшая. */
export async function unresolvedShifts(db: Db, range: { from: string; to: string }, now: Date | null, staffId?: string): Promise<Array<{ shiftId: string; staffId: string; reason: string }>> {
  const r = await db.query<{ id: string; staff_id: string; reason: string }>(
    `SELECT id, staff_id, reason FROM (
       SELECT s.id, s.staff_id,
         CASE
           WHEN s.status = 'needs_review' THEN 'needs_review'
           WHEN s.status = 'planned' AND ($3::timestamptz IS NULL OR upper(s.period) <= $3) THEN 'no_fact'
           WHEN s.status = 'worked' AND NOT s.unpaid_confirmed AND NOT EXISTS (SELECT 1 FROM journal.staff_rates x WHERE x.staff_id = s.staff_id AND x.valid_from <= s.local_date) THEN 'rate_missing'
           WHEN s.status = 'worked' AND NOT s.unpaid_confirmed AND NOT EXISTS (SELECT 1 FROM journal.payroll_accruals a WHERE a.shift_id = s.id AND a.fact_version = s.fact_version) THEN 'accrual_pending'
           WHEN (s.status <> 'worked' OR s.unpaid_confirmed) AND EXISTS (
             SELECT 1 FROM journal.payroll_accruals a JOIN journal.ledger_entries le ON le.id = a.ledger_entry_id
              WHERE a.shift_id = s.id AND NOT EXISTS (SELECT 1 FROM journal.ledger_entries rv WHERE rv.reversal_of = le.id)) THEN 'accrual_pending'
         END AS reason
       FROM app.staff_shifts s
       WHERE s.local_date BETWEEN $1::date AND $2::date AND ($4::uuid IS NULL OR s.staff_id = $4)
     ) q WHERE reason IS NOT NULL ORDER BY id`,
    [range.from, range.to, now, staffId ?? null],
  );
  return r.rows.map((x) => ({ shiftId: x.id, staffId: x.staff_id, reason: x.reason }));
}

// ---- периоды

const periodSchema = z.object({ from: z.string(), to: z.string() });

export async function createPeriod(tx: Tx, ctx: AccessContext, raw: unknown, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<PayrollPeriodDto> {
  assertCan(ctx, 'payroll.period.manage', { network: true });
  const parsed = periodSchema.safeParse(raw ?? {});
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', 400, 'Нужны даты from и to');
  let from: LocalDate;
  let to: LocalDate;
  try {
    from = parseLocalDate(parsed.data.from);
    to = parseLocalDate(parsed.data.to);
  } catch {
    throw new AppError('VALIDATION_FAILED', 400, 'Даты – ГГГГ-ММ-ДД');
  }
  if (to < from) throw new AppError('VALIDATION_FAILED', 400, 'Конец периода раньше начала');
  await lockPeriodCreation(tx);
  let row: PeriodRow;
  try {
    row = (await tx.query<PeriodRow>(`INSERT INTO app.payroll_periods (date_from, date_to) VALUES ($1::date, $2::date) RETURNING ${PERIOD_COLS}`, [from, to])).rows[0]!;
  } catch (err) {
    const e = err as { code?: string; constraint?: string };
    if (e.code === '23P01' && e.constraint === 'payroll_periods_no_overlap') throw new AppError('PAYROLL_PERIOD_OVERLAP', 409, 'Период пересекается с существующим');
    throw err;
  }
  await writeAudit(tx, meta, { action: 'payroll.period.created', object: { type: 'payroll_period', id: row.id }, after: { from, to } }, clock);
  return toPeriod(row);
}

export async function listPeriods(db: Db): Promise<PayrollPeriodDto[]> {
  const r = await db.query<PeriodRow>(`SELECT ${PERIOD_COLS} FROM app.payroll_periods ORDER BY date_from DESC LIMIT 200`);
  return r.rows.map(toPeriod);
}

export async function getPeriod(db: Db, id: string): Promise<PayrollPeriodDto | null> {
  if (!isUuid(id)) return null;
  const r = await db.query<PeriodRow>(`SELECT ${PERIOD_COLS} FROM app.payroll_periods WHERE id = $1`, [id]);
  return r.rows[0] ? toPeriod(r.rows[0]) : null;
}

/** Сотрудники с данными в периоде: смены или записи K3 по датам (выплата прошлого периода сама ведомости не создаёт). */
async function staffInPeriod(db: Db, range: { from: string; to: string }): Promise<string[]> {
  const r = await db.query<{ staff_id: string }>(
    `SELECT staff_id FROM app.staff_shifts WHERE local_date BETWEEN $1::date AND $2::date AND status <> 'cancelled'
     UNION
     SELECT a.owner_id FROM journal.ledger_entries le JOIN app.ledger_accounts a ON a.id = le.account_id AND a.kind = 'staff_payroll'
      WHERE ${payrollDateSql('le')} BETWEEN $1::date AND $2::date AND le.entry_type <> 'payroll.payout' AND NOT (le.refs ? 'carryOffset')`,
    [range.from, range.to],
  );
  return r.rows.map((x) => x.staff_id).sort();
}

/** Закрытие: FOR UPDATE периода, проверка нерешённого, снимок итогов всех ведомостей; после – только сторно и корректировки (K18 §7). */
export async function closePeriod(tx: Tx, ctx: AccessContext, periodId: string, raw: { reason?: string | null }, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<PayrollPeriodDto> {
  assertCan(ctx, 'payroll.period.manage', { network: true });
  if (!isUuid(periodId)) throw notFound();
  const locked = await tx.query<PeriodRow>(`SELECT ${PERIOD_COLS} FROM app.payroll_periods WHERE id = $1 FOR UPDATE`, [periodId]);
  const period = locked.rows[0];
  if (!period) throw notFound();
  if (period.status === 'closed') throw new AppError('PAYROLL_PERIOD_CLOSED', 409, 'Период уже закрыт', { periodId });
  const range = { from: period.date_from, to: period.date_to };
  const now = clock.now();
  const bad = await unresolvedShifts(tx, range, null);
  // Необработанное staff.rate_set со сменами этого периода: событие ещё в outbox, начисления по старой ставке.
  const rates = await tx.query<{ rate_id: string; shift_ids: string[] }>(
    `SELECT e.aggregate_id AS rate_id, array_agg(s.id) AS shift_ids
       FROM app.outbox_events e
       CROSS JOIN LATERAL jsonb_array_elements_text(e.payload->'affectedShiftIds') AS x(shift_id)
       JOIN app.staff_shifts s ON s.id = x.shift_id::uuid AND s.local_date BETWEEN $1::date AND $2::date
      WHERE e.event_type = 'staff.rate_set' AND NOT EXISTS (SELECT 1 FROM app.processed_events p WHERE p.event_id = e.id AND p.handler = $3)
      GROUP BY e.aggregate_id`,
    [range.from, range.to, HANDLER_RATE],
  );
  if (bad.length > 0 || rates.rows.length > 0) {
    throw new AppError('PAYROLL_PERIOD_HAS_UNRESOLVED', 409, 'В периоде есть нерешённые смены или необработанные ставки', {
      shiftIds: [...new Set([...bad.map((b) => b.shiftId), ...rates.rows.flatMap((r) => r.shift_ids)])],
      rateIds: rates.rows.map((r) => r.rate_id),
      reasons: bad,
    });
  }
  for (const staffId of await staffInPeriod(tx, range)) {
    const { totals, byBranch } = await computeTotals(tx, range, staffId, clock);
    await tx.query(
      `INSERT INTO app.payroll_statements (period_id, staff_id, status, totals) VALUES ($1, $2, 'calculated', $3::jsonb)
       ON CONFLICT (period_id, staff_id) DO UPDATE SET totals = EXCLUDED.totals, status = CASE WHEN app.payroll_statements.status = 'draft' THEN 'calculated' ELSE app.payroll_statements.status END, row_version = app.payroll_statements.row_version + 1`,
      [periodId, staffId, JSON.stringify({ ...totals, byBranch })],
    );
  }
  const closed = await tx.query<PeriodRow>(`UPDATE app.payroll_periods SET status = 'closed', closed_at = $2, closed_by = $3 WHERE id = $1 RETURNING ${PERIOD_COLS}`, [periodId, now, ctx.actor.staffId]);
  await writeAudit(tx, meta, { action: 'payroll.period.closed', object: { type: 'payroll_period', id: periodId }, after: { from: range.from, to: range.to }, reason: raw.reason?.trim() || null }, clock);
  return toPeriod(closed.rows[0]!);
}

// ---- ведомости

interface StatementRow {
  id: string;
  period_id: string;
  staff_id: string;
  status: StatementStatus;
  totals: PayrollTotals & { byBranch?: BranchLine[] };
  planned_payout_date: string | null;
  actual_payout_date: string | null;
  payout_comment: string | null;
  row_version: number;
  date_from: string;
  date_to: string;
  period_status: 'open' | 'closed';
}
const STATEMENT_SELECT = `SELECT st.id, st.period_id, st.staff_id, st.status, st.totals, to_char(st.planned_payout_date, 'YYYY-MM-DD') AS planned_payout_date,
    to_char(st.actual_payout_date, 'YYYY-MM-DD') AS actual_payout_date, st.payout_comment, st.row_version,
    to_char(p.date_from, 'YYYY-MM-DD') AS date_from, to_char(p.date_to, 'YYYY-MM-DD') AS date_to, p.status AS period_status
  FROM app.payroll_statements st JOIN app.payroll_periods p ON p.id = st.period_id`;

/** Зона Директора: филиалы, где у сотрудника есть смены или записи за период, пересечённые с зоной. Пусто – ведомости для него нет. */
async function zoneOf(db: Db, ctx: AccessContext, staffId: string, range: { from: string; to: string }): Promise<string[]> {
  const r = await db.query<{ branch_id: string }>(
    `SELECT branch_id FROM app.staff_shifts WHERE staff_id = $1 AND local_date BETWEEN $2::date AND $3::date
     UNION
     SELECT le.branch_id FROM journal.ledger_entries le JOIN app.ledger_accounts a ON a.id = le.account_id AND a.kind = 'staff_payroll' AND a.owner_id = $1
      WHERE le.branch_id IS NOT NULL AND ${payrollDateSql('le')} BETWEEN $2::date AND $3::date`,
    [staffId, range.from, range.to],
  );
  return r.rows.map((x) => x.branch_id).filter((b) => ctx.branchIds.has(b));
}

async function toStatement(db: Db, ctx: AccessContext, r: StatementRow, clock: Clock): Promise<PayrollStatementDto> {
  const range = { from: r.date_from, to: r.date_to };
  const { byBranch: storedLines, ...stored } = r.totals;
  let totals: PayrollTotals = { ...ZERO_TOTALS, ...stored };
  let byBranch = storedLines ?? [];
  if (!ctx.network) {
    const zone = await zoneOf(db, ctx, r.staff_id, range);
    ({ totals, byBranch } = await computeTotals(db, range, r.staff_id, clock, zone)); // Директор – только суммы своей зоны (K18 §10)
  }
  const needsReview = (await unresolvedShifts(db, range, clock.now(), r.staff_id)).map((u) => ({ shiftId: u.shiftId, reason: u.reason }));
  return {
    id: r.id,
    periodId: r.period_id,
    staffId: r.staff_id,
    status: r.status,
    totals,
    byBranch,
    plannedPayoutDate: r.planned_payout_date as LocalDate | null,
    actualPayoutDate: r.actual_payout_date as LocalDate | null,
    payoutComment: r.payout_comment,
    needsReview,
    rowVersion: r.row_version,
  };
}

/** Ведомость в зоне payroll.view; чужая – 404. */
export async function getStatement(db: Db, ctx: AccessContext, id: string, clock: Clock = systemClock): Promise<PayrollStatementDto> {
  const r = await readStatement(db, ctx, id);
  return toStatement(db, ctx, r, clock);
}

async function readStatement(db: Db, ctx: AccessContext, id: string, right = 'payroll.view'): Promise<StatementRow> {
  if (!isUuid(id)) throw notFound();
  const res = await db.query<StatementRow>(`${STATEMENT_SELECT} WHERE st.id = $1`, [id]);
  const row = res.rows[0];
  if (!row) throw notFound();
  if (!roleAllows(ctx.role, 'payroll.view')) throw new AppError('FORBIDDEN', 403, 'Недостаточно прав', { action: 'payroll.view' });
  if (!ctx.network && (await zoneOf(db, ctx, row.staff_id, { from: row.date_from, to: row.date_to })).length === 0) throw notFound();
  if (!roleAllows(ctx.role, right)) throw new AppError('FORBIDDEN', 403, 'Недостаточно прав', { action: right });
  return row;
}

/** Пересчёт ведомостей открытого периода: draft → calculated, итоги из K3 и смен. Закрытый период – снимок не меняется. */
export async function calculateStatements(tx: Tx, ctx: AccessContext, periodId: string, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<PayrollStatementDto[]> {
  if (!roleAllows(ctx.role, 'payroll.statement.review')) throw new AppError('FORBIDDEN', 403, 'Недостаточно прав', { action: 'payroll.statement.review' });
  if (!isUuid(periodId)) throw notFound();
  const p = await tx.query<PeriodRow>(`SELECT ${PERIOD_COLS} FROM app.payroll_periods WHERE id = $1 FOR SHARE`, [periodId]);
  const period = p.rows[0];
  if (!period) throw notFound();
  const range = { from: period.date_from, to: period.date_to };
  let staffIds = await staffInPeriod(tx, range);
  if (!ctx.network) {
    const visible: string[] = [];
    for (const id of staffIds) if ((await zoneOf(tx, ctx, id, range)).length > 0) visible.push(id);
    staffIds = visible;
  }
  if (period.status === 'open') {
    for (const staffId of staffIds) {
      const { totals, byBranch } = await computeTotals(tx, range, staffId, clock);
      await tx.query(
        `INSERT INTO app.payroll_statements (period_id, staff_id, status, totals) VALUES ($1, $2, 'calculated', $3::jsonb)
         ON CONFLICT (period_id, staff_id) DO UPDATE SET totals = EXCLUDED.totals, status = 'calculated', row_version = app.payroll_statements.row_version + 1
           WHERE app.payroll_statements.status IN ('draft','calculated')`,
        [periodId, staffId, JSON.stringify({ ...totals, byBranch })],
      );
    }
    await writeAudit(tx, meta, { action: 'payroll.statement.calculated', object: { type: 'payroll_period', id: periodId }, after: { staffCount: staffIds.length } }, clock);
  }
  const rows = await tx.query<StatementRow>(`${STATEMENT_SELECT} WHERE st.period_id = $1 AND st.staff_id = ANY($2::uuid[]) ORDER BY st.staff_id`, [periodId, staffIds]);
  return Promise.all(rows.rows.map((r) => toStatement(tx, ctx, r, clock)));
}

const TRANSITIONS: Readonly<Record<StatementStatus, readonly StatementStatus[]>> = {
  draft: [],
  calculated: ['checked', 'disputed'],
  checked: ['ready', 'disputed'],
  ready: ['disputed'],
  disputed: ['calculated'],
  paid: [],
};

const statusSchema = z.object({ rowVersion: z.number().int(), status: z.enum(['checked', 'ready', 'disputed', 'calculated']), comment: z.string().max(2000).nullish() });

/** Статусы K18 §9: ready – только Владелец и только у закрытого периода без нерешённых смен; прочие – с payroll.statement.review в зоне. */
export async function setStatementStatus(tx: Tx, ctx: AccessContext, id: string, raw: unknown, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<PayrollStatementDto> {
  const parsed = statusSchema.safeParse(raw ?? {});
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', 400, 'Неверные данные запроса');
  const input = parsed.data;
  const right = input.status === 'ready' ? 'payroll.statement.ready' : 'payroll.statement.review';
  const seen = await readStatement(tx, ctx, id, right);
  const res = await tx.query<StatementRow>(`${STATEMENT_SELECT} WHERE st.id = $1 FOR UPDATE OF st`, [seen.id]);
  const row = res.rows[0]!;
  if (row.row_version !== input.rowVersion) throw new AppError('VERSION_CONFLICT', 409, 'Ведомость уже изменили, обновите данные', { rowVersion: row.row_version });
  if (!TRANSITIONS[row.status].includes(input.status)) throw new AppError('VALIDATION_FAILED', 400, `Переход ${row.status} → ${input.status} не разрешён`, { from: row.status, to: input.status });
  if (input.status === 'ready') {
    if (row.period_status !== 'closed') throw new AppError('PAYROLL_PERIOD_OPEN', 409, 'Сначала закройте расчётный период', { periodId: row.period_id });
    const open = await unresolvedShifts(tx, { from: row.date_from, to: row.date_to }, clock.now(), row.staff_id);
    if (open.length > 0) throw new AppError('PAYROLL_STATEMENT_NEEDS_REVIEW', 409, 'В ведомости есть нерешённые смены', { needsReview: open });
  }
  await tx.query(`UPDATE app.payroll_statements SET status = $2, payout_comment = coalesce($3, payout_comment), row_version = row_version + 1 WHERE id = $1`, [row.id, input.status, input.comment?.trim() || null]);
  await writeAudit(tx, meta, { action: 'payroll.statement.status_changed', object: { type: 'payroll_statement', id: row.id }, before: { status: row.status }, after: { status: input.status }, reason: input.comment?.trim() || null }, clock);
  const fresh = await tx.query<StatementRow>(`${STATEMENT_SELECT} WHERE st.id = $1`, [row.id]);
  return toStatement(tx, ctx, fresh.rows[0]!, clock);
}

/** Первая дата начиная с from вне закрытых периодов; строка её периода – FOR SHARE. */
async function nextOpenDate(tx: Tx, from: LocalDate): Promise<LocalDate> {
  let date = from;
  for (;;) {
    const [p] = await lockPeriodsShared(tx, [date]);
    if (!p || p.status === 'open') return date;
    date = addDays(p.to, 1);
  }
}

const paidSchema = z.object({ rowVersion: z.number().int(), actualPayoutDate: z.string(), comment: z.string().max(2000).nullish() });

/** Выплата (K18 §9): ready → paid, только Владелец, только закрытый период. toPayKop > 0 – payroll.payout; 0 – без проводки; < 0 – перенос минуса. Повтор – тот же результат. */
export async function markPaid(tx: Tx, ctx: AccessContext, id: string, raw: unknown, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<PayrollStatementDto> {
  assertCan(ctx, 'payroll.payout.mark', { network: true });
  const parsed = paidSchema.safeParse(raw ?? {});
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', 400, 'Неверные данные запроса');
  let actual: LocalDate;
  try {
    actual = parseLocalDate(parsed.data.actualPayoutDate);
  } catch {
    throw new AppError('VALIDATION_FAILED', 400, 'Дата выплаты – ГГГГ-ММ-ДД', { field: 'actualPayoutDate' });
  }
  const seen = await readStatement(tx, ctx, id, 'payroll.payout.mark');
  // FOR SHARE периодов ведомости, даты выплаты и первого дня после периода – раньше lockAccounts (K18 §6).
  const periods = await lockPeriodsShared(tx, [seen.date_from as LocalDate, actual]);
  const carryDate = await nextOpenDate(tx, addDays(seen.date_to as LocalDate, 1));
  const payoutDate = periods.some((p) => p.status === 'closed' && p.from <= actual && actual <= p.to) ? await openPayrollDate(tx, FALLBACK_TZ, clock) : actual;

  const account = await staffAccount(tx, seen.staff_id);
  await lockAccounts(tx, [account.id]);
  const row = (await tx.query<StatementRow>(`${STATEMENT_SELECT} WHERE st.id = $1 FOR UPDATE OF st`, [seen.id])).rows[0]!;
  if (row.status === 'paid') return toStatement(tx, ctx, row, clock); // двойное нажатие
  if (row.row_version !== parsed.data.rowVersion) throw new AppError('VERSION_CONFLICT', 409, 'Ведомость уже изменили, обновите данные', { rowVersion: row.row_version });
  if (row.period_status !== 'closed') throw new AppError('PAYROLL_PERIOD_OPEN', 409, 'Сначала закройте расчётный период', { periodId: row.period_id });
  if (row.status !== 'ready') throw new AppError('VALIDATION_FAILED', 400, `Выплатить можно только ведомость в статусе ready, сейчас ${row.status}`, { from: row.status, to: 'paid' });

  const toPay = Number(row.totals.toPayKop ?? 0);
  const author = { type: 'staff' as const, id: ctx.actor.staffId };
  const ref: { type: RefType; id: string } = { type: 'payroll_statement', id: row.id };
  const accountRef: EntryInput['account'] = { kind: 'staff_payroll', ownerType: 'staff', ownerId: row.staff_id };
  let postingId: string | null = null;
  if (toPay > 0) {
    const posted = await post(tx, {
      entries: [{ account: accountRef, amount: -toPay, type: 'payroll.payout', branchId: null, ref, occurredAt: payrollInstant(payoutDate) }],
      idempotencyKey: `payroll-payout:${row.id}`,
      author,
    });
    postingId = posted.postingId;
  } else if (toPay < 0) {
    const mode = (await resolveSetting(tx, 'payroll.negative_carry', { network: true }, clock.now())).value;
    const offset: EntryInput = { account: accountRef, amount: -toPay, type: 'payroll.correction', basis: 'Компенсация минуса ведомости', branchId: null, ref, refs: { carryOffset: 'true' }, occurredAt: payrollInstant(carryDate) };
    const carry: EntryInput = { account: accountRef, amount: toPay, type: 'payroll.correction', basis: 'Перенос минуса ведомости', branchId: null, ref, refs: { carriedFrom: row.id }, occurredAt: payrollInstant(carryDate) };
    await post(tx, { entries: mode === 'carry' ? [carry, offset] : [offset], idempotencyKey: `payroll-correction:carry:${row.id}`, author });
  }
  await tx.query(`UPDATE app.payroll_statements SET status = 'paid', actual_payout_date = $2::date, payout_comment = coalesce($3, payout_comment), payout_posting_id = $4, row_version = row_version + 1 WHERE id = $1`, [
    row.id,
    actual,
    parsed.data.comment?.trim() || null,
    postingId,
  ]);
  await writeAudit(tx, meta, { action: 'payroll.paid', object: { type: 'payroll_statement', id: row.id }, before: { status: row.status }, after: { actualPayoutDate: actual, toPayKop: toPay, postingId } }, clock);
  return toStatement(tx, ctx, (await tx.query<StatementRow>(`${STATEMENT_SELECT} WHERE st.id = $1`, [row.id])).rows[0]!, clock);
}

const correctionSchema = z.object({ staffId: z.string(), amountKop: z.unknown(), ref: z.object({ type: z.enum(['shift', 'payroll_statement']), id: z.string() }), reason: z.string().max(2000).nullish() });

/** Корректировка закрытого (K18 §7): запись в текущем открытом периоде со ссылкой на смену или ведомость; Владелец. */
export async function postCorrection(tx: Tx, ctx: AccessContext, raw: unknown, meta: AuditRequestMeta, opts: { idempotencyKey: string; clock?: Clock }): Promise<{ postingId: string; date: LocalDate }> {
  const clock = opts.clock ?? systemClock;
  assertCan(ctx, 'payroll.correct', { network: true });
  const parsed = correctionSchema.safeParse(raw ?? {});
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', 400, 'Неверные данные запроса');
  const input = parsed.data;
  const amount = input.amountKop;
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount === 0) throw new AppError('INVALID_AMOUNT', 422, 'Сумма – целое ненулевое число копеек');
  const reason = requireReason(input.reason);
  if (!isUuid(input.staffId) || !isUuid(input.ref.id)) throw notFound();
  let branchId: string | null = null;
  if (input.ref.type === 'shift') {
    const s = await tx.query<{ branch_id: string }>(`SELECT branch_id FROM app.staff_shifts WHERE id = $1 AND staff_id = $2`, [input.ref.id, input.staffId]);
    if (!s.rows[0]) throw notFound();
    branchId = s.rows[0].branch_id;
  } else {
    const s = await tx.query(`SELECT 1 FROM app.payroll_statements WHERE id = $1 AND staff_id = $2`, [input.ref.id, input.staffId]);
    if (s.rows.length === 0) throw notFound();
  }
  const branch = branchId ? await getBranch(tx, branchId) : null;
  const date = await openPayrollDate(tx, branch?.timezone ?? FALLBACK_TZ, clock);
  const account = await staffAccount(tx, input.staffId);
  await lockAccounts(tx, [account.id]);
  const posted = await post(tx, {
    entries: [{ account: { kind: 'staff_payroll', ownerType: 'staff', ownerId: input.staffId }, amount, type: 'payroll.correction', basis: reason, branchId, ref: input.ref, occurredAt: payrollInstant(date) }],
    idempotencyKey: `payroll-correction:${opts.idempotencyKey}`,
    author: { type: 'staff', id: ctx.actor.staffId },
  });
  await writeAudit(
    tx,
    meta,
    { action: 'payroll.correction.posted', object: input.ref.type === 'shift' ? { type: 'shift', id: input.ref.id } : { type: 'payroll_statement', id: input.ref.id }, branchId, after: { staffId: input.staffId, amountKop: amount, date, postingId: posted.postingId }, reason },
    clock,
  );
  return { postingId: posted.postingId, date };
}

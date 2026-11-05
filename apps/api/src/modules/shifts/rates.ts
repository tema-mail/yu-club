// S3-10. Ставки сотрудника (K18 §3, 05 §4): только вставка в journal.staff_rates; действует запись с наибольшей
// valid_from ≤ дата, при равных – более поздняя (created_at, id); ставка не задана → null, это не ноль (05 §4.4).
// Новая ставка задним числом сама ничего не пересчитывает: публикует staff.rate_set со списком затронутых смен
// открытых периодов, начисления правит обработчик (accrual.ts). Здесь же – формула начисления и блокировки периодов:
// всё, что пишет в счёт staff_payroll или меняет смену, сначала берёт FOR SHARE строк периодов (K18 §6, §7).
import { writeAudit, type AuditRequestMeta, type Db } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import type { Tx } from '../../core/ledger.ts';
import { publish } from '../../core/outbox.ts';
import { assertCan, type AccessContext } from '../../core/permissions.ts';
import { parseLocalDate, systemClock, type Clock, type LocalDate } from '../../core/time.ts';

export interface StaffRateDto {
  id: string;
  staffId: string;
  validFrom: LocalDate;
  hourlyKop: number;
  attendanceFeeKop: number;
  corrects: string | null;
  reason: string;
  createdBy: string;
  createdAt: string;
}

interface RateRow {
  id: string;
  staff_id: string;
  valid_from: string;
  hourly_kop: string;
  attendance_fee_kop: string;
  corrects: string | null;
  reason: string;
  created_by: string;
  created_at: Date;
}

const RATE_COLS = `id, staff_id, to_char(valid_from, 'YYYY-MM-DD') AS valid_from, hourly_kop, attendance_fee_kop, corrects, reason, created_by, created_at`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown): s is string => typeof s === 'string' && UUID_RE.test(s);
export const notFound = (): AppError => new AppError('NOT_FOUND', 404, 'Не найдено');

const toDto = (r: RateRow): StaffRateDto => ({
  id: r.id,
  staffId: r.staff_id,
  validFrom: r.valid_from as LocalDate,
  hourlyKop: Number(r.hourly_kop),
  attendanceFeeKop: Number(r.attendance_fee_kop),
  corrects: r.corrects,
  reason: r.reason,
  createdBy: r.created_by,
  createdAt: r.created_at.toISOString(),
});

export function requireReason(value: string | null | undefined, field = 'reason'): string {
  const s = value?.trim() ?? '';
  if (s === '') throw new AppError('COMMENT_REQUIRED', 422, 'Укажите причину', { field });
  return s;
}

function assertKop(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new AppError('INVALID_AMOUNT', 422, 'Сумма – целое неотрицательное число копеек', { field });
  }
  return value;
}

/** Ставка на дату; null – не задана (не ноль, 05 §4.4). */
export async function rateAt(db: Db, staffId: string, date: LocalDate): Promise<StaffRateDto | null> {
  const r = await db.query<RateRow>(
    `SELECT ${RATE_COLS} FROM journal.staff_rates WHERE staff_id = $1 AND valid_from <= $2::date
     ORDER BY valid_from DESC, created_at DESC, id DESC LIMIT 1`,
    [staffId, date],
  );
  return r.rows[0] ? toDto(r.rows[0]) : null;
}

/** История ставок: новые сверху, порядок – как у rateAt. */
export async function listRates(db: Db, staffId: string): Promise<StaffRateDto[]> {
  const r = await db.query<RateRow>(
    `SELECT ${RATE_COLS} FROM journal.staff_rates WHERE staff_id = $1 ORDER BY valid_from DESC, created_at DESC, id DESC`,
    [staffId],
  );
  return r.rows.map(toDto);
}

/** K18 §6: почасовая часть до копейки (половина – вверх) + ставка за выход один раз, если смена не короче порога. */
export function accrualParts(
  paidMinutes: number,
  rate: Pick<StaffRateDto, 'hourlyKop' | 'attendanceFeeKop'>,
  feeMinMinutes: number,
): { hourlyPartKop: number; feePartKop: number; totalKop: number } {
  const hourlyPartKop = Math.floor((paidMinutes * rate.hourlyKop + 30) / 60);
  const feePartKop = paidMinutes >= feeMinMinutes ? rate.attendanceFeeKop : 0;
  return { hourlyPartKop, feePartKop, totalKop: hourlyPartKop + feePartKop };
}

// ---- блокировки периодов (K18 §6 «Порядок блокировок»)

export interface PeriodLock {
  id: string;
  from: LocalDate;
  to: LocalDate;
  status: 'open' | 'closed';
}

const PERIODS_GATE = 7_180_303; // ключ advisory: создание периода ↔ запись с датой, у которой периода ещё нет

/** FOR SHARE строк периодов, в которые попадают даты (в порядке дат), раньше любых lockAccounts. Advisory shared закрывает
 *  гонку с createPeriod + closePeriod: дата без периода не «проскочит» мимо только что созданного и закрытого периода. */
export async function lockPeriodsShared(tx: Tx, dates: LocalDate[]): Promise<PeriodLock[]> {
  await tx.query('SELECT pg_advisory_xact_lock_shared($1)', [PERIODS_GATE]);
  const unique = [...new Set(dates)].sort();
  if (unique.length === 0) return [];
  const r = await tx.query<{ id: string; date_from: string; date_to: string; status: 'open' | 'closed' }>(
    `SELECT id, to_char(date_from, 'YYYY-MM-DD') AS date_from, to_char(date_to, 'YYYY-MM-DD') AS date_to, status
       FROM app.payroll_periods p
      WHERE EXISTS (SELECT 1 FROM unnest($1::date[]) d WHERE d BETWEEN p.date_from AND p.date_to)
      ORDER BY p.date_from FOR SHARE`,
    [unique],
  );
  return r.rows.map((p) => ({ id: p.id, from: p.date_from as LocalDate, to: p.date_to as LocalDate, status: p.status }));
}

/** Эксклюзивный вход в создание периода (createPeriod, payroll.ts): ждёт писателей с датами без периода. */
export async function lockPeriodCreation(tx: Tx): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock($1)', [PERIODS_GATE]);
}

/** FOR SHARE периодов дат + отказ, если хотя бы одна дата в закрытом (K18 §4 п.8, §5, §7). */
export async function assertDatesOpen(tx: Tx, dates: LocalDate[]): Promise<void> {
  const periods = await lockPeriodsShared(tx, dates);
  const closed = periods.find((p) => p.status === 'closed');
  if (closed) throw new AppError('PAYROLL_PERIOD_CLOSED', 409, 'Расчётный период закрыт: исправление – корректировкой в открытом периоде', { periodId: closed.id });
}

// ---- команда

/** Новая ставка (Владелец): запись истории, затронутые смены в ответе и аудите, событие для пересчёта. */
export async function setRate(
  tx: Tx,
  ctx: AccessContext,
  input: { staffId: string; validFrom: string; hourlyKop: number; attendanceFeeKop: number; reason: string; corrects?: string | null },
  meta: AuditRequestMeta,
  clock: Clock = systemClock,
): Promise<{ rate: StaffRateDto; affectedShiftIds: string[] }> {
  assertCan(ctx, 'payroll.rate.manage', { network: true });
  if (!isUuid(input.staffId)) throw notFound();
  let validFrom: LocalDate;
  try {
    validFrom = parseLocalDate(input.validFrom);
  } catch {
    throw new AppError('VALIDATION_FAILED', 400, 'Дата вступления – ГГГГ-ММ-ДД', { field: 'validFrom' });
  }
  const hourlyKop = assertKop(input.hourlyKop, 'hourlyKop');
  const attendanceFeeKop = assertKop(input.attendanceFeeKop, 'attendanceFeeKop');
  const reason = requireReason(input.reason);
  const staff = await tx.query('SELECT 1 FROM app.staff WHERE id = $1 FOR NO KEY UPDATE', [input.staffId]);
  if (staff.rows.length === 0) throw notFound();
  if (input.corrects != null) {
    const prev = isUuid(input.corrects)
      ? await tx.query(`SELECT 1 FROM journal.staff_rates WHERE id = $1 AND staff_id = $2 AND valid_from = $3::date`, [input.corrects, input.staffId, validFrom])
      : { rows: [] };
    if (prev.rows.length === 0) throw new AppError('VALIDATION_FAILED', 400, 'Исправлять можно только ставку этого сотрудника с той же датой', { field: 'corrects' });
  }

  // Открытые периоды – FOR SHARE: закрытие дождётся этой транзакции и увидит необработанное событие (K18 §7).
  await tx.query('SELECT pg_advisory_xact_lock_shared($1)', [PERIODS_GATE]);
  await tx.query(`SELECT id FROM app.payroll_periods WHERE status = 'open' AND date_to >= $1::date ORDER BY date_from FOR SHARE`, [validFrom]);

  const now = clock.now();
  // Монотонный created_at сотрудника: «более поздняя» запись определена и при совпадении показаний часов.
  const inserted = await tx.query<RateRow>(
    `INSERT INTO journal.staff_rates (staff_id, valid_from, hourly_kop, attendance_fee_kop, corrects, reason, created_by, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, GREATEST($8::timestamptz, (SELECT max(created_at) + interval '1 millisecond' FROM journal.staff_rates WHERE staff_id = $1)))
     RETURNING ${RATE_COLS}`,
    [input.staffId, validFrom, hourlyKop, attendanceFeeKop, input.corrects ?? null, reason, ctx.actor.staffId, now],
  );
  const rate = toDto(inserted.rows[0]!);

  const affected = await tx.query<{ id: string }>(
    `SELECT s.id FROM app.staff_shifts s
      WHERE s.staff_id = $1 AND s.status = 'worked' AND NOT s.unpaid_confirmed AND s.local_date >= $2::date
        AND s.local_date < coalesce((SELECT min(r.valid_from) FROM journal.staff_rates r WHERE r.staff_id = $1 AND r.valid_from > $2::date), 'infinity'::date)
        AND NOT EXISTS (SELECT 1 FROM app.payroll_periods p WHERE p.status = 'closed' AND s.local_date BETWEEN p.date_from AND p.date_to)
      ORDER BY s.local_date, s.id`,
    [input.staffId, validFrom],
  );
  const affectedShiftIds = affected.rows.map((x) => x.id);

  await publish(tx, {
    type: 'staff.rate_set',
    aggregateType: 'staff_rate',
    aggregateId: rate.id,
    aggregateVersion: rate.id,
    branchId: null,
    payload: { rateId: rate.id, staffId: rate.staffId, validFrom: rate.validFrom, affectedShiftIds },
    occurredAt: now,
  });
  await writeAudit(
    tx,
    meta,
    {
      action: 'staff.rate_set',
      object: { type: 'staff_rate', id: rate.id },
      branchId: null,
      after: { staffId: rate.staffId, validFrom: rate.validFrom, hourlyKop, attendanceFeeKop, corrects: rate.corrects, affectedShiftIds },
      reason,
    },
    clock,
  );
  return { rate, affectedShiftIds };
}

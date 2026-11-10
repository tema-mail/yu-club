// S3-15. Начисление зарплаты (K18 §6): обработчики shift.attendance_changed и staff.rate_set пишут на счёт K3 staff_payroll.
// Применяется состояние смены из базы, а не payload: двойная доставка и обратный порядок версий дают одно живое начисление.
// Порядок блокировок: FOR SHARE периодов (дата смены, даты живых записей, дата для корректировки) → lockAccounts счёта → смена
// FOR UPDATE. Период смены закрыт: обработчик attendance не падает, а проводит разницу payroll.correction датой открытого периода;
// обработчик ставки смены закрытых периодов не трогает (K18 §3, приёмка 15). Пересчёт по новой ставке при той же fact_version
// увеличивает fact_version без события: journal.payroll_accruals и ключ K3 – одна строка на версию, а закрытие периода ищет
// начисление на текущую версию. Сторно и новая запись – две проводки K3 в одной транзакции (reverse и post проводят отдельно).
//
// Дата зарплатной записи: occurred_at = 12:00 UTC локальной даты (payrollInstant). Период записи K3 определяется по этой дате
// (payrollDateSql) и у записей без филиала, и у сторно: зона филиала в журнале не хранится, а дата должна быть одна (K18 §7).
import { ensureAccount, lockAccounts, post, reverse, type Account, type PostingInput, type Tx } from '../../core/ledger.ts';
import { subscribe, type EventEnvelope } from '../../core/outbox.ts';
import { resolveSetting } from '../../core/settings.ts';
import { addDays, instantToLocal, systemClock, type Clock, type LocalDate, type TimeZone } from '../../core/time.ts';
import { accrualParts, lockPeriodsShared, rateAt, type PeriodLock } from './rates.ts';

export const HANDLER_ATTENDANCE = 'shifts.accrual.attendance';
export const HANDLER_RATE = 'shifts.accrual.rate_set';
const SYSTEM_AUTHOR: PostingInput['author'] = { type: 'system', id: null };

export const payrollInstant = (date: LocalDate): Date => new Date(`${date}T12:00:00Z`);
/** SQL: зарплатная дата записи K3 (см. шапку). */
export const payrollDateSql = (alias: string): string => `(${alias}.occurred_at AT TIME ZONE 'UTC')::date`;

export function staffAccount(tx: Tx, staffId: string): Promise<Account> {
  return ensureAccount(tx, { kind: 'staff_payroll', ownerType: 'staff', ownerId: staffId }, { unit: 'RUB_KOP', branchId: null, minBalance: null });
}

/** Первая дата начиная с from, куда можно записать: внутри открытого периода – она сама; до открытого – его начало; закрытый – дальше;
 *  периода дальше нет – сама дата: периоды идут встык (createPeriod), следующий её покроет. Строка периода – FOR SHARE, дата без периода – под gate. */
export async function nextOpenDate(tx: Tx, from: LocalDate): Promise<LocalDate> {
  await lockPeriodsShared(tx, []);
  let date = from;
  for (;;) {
    const r = await tx.query<{ date_from: string; date_to: string; status: 'open' | 'closed' }>(
      `SELECT to_char(date_from, 'YYYY-MM-DD') AS date_from, to_char(date_to, 'YYYY-MM-DD') AS date_to, status FROM app.payroll_periods WHERE date_to >= $1::date ORDER BY date_from LIMIT 1 FOR SHARE`,
      [date],
    );
    const p = r.rows[0];
    if (!p) return date;
    if (p.status === 'open') return p.date_from > date ? (p.date_from as LocalDate) : date;
    date = addDays(p.date_to as LocalDate, 1);
  }
}

/** Дата для записи «в текущем открытом периоде» (K18 §7) от сегодняшней по зоне. Вызывать до lockAccounts. */
export function openPayrollDate(tx: Tx, tz: TimeZone, clock: Clock): Promise<LocalDate> {
  return nextOpenDate(tx, instantToLocal(clock.now(), tz).date);
}

interface LiveEntry {
  id: string;
  amount: string;
  date: LocalDate;
}

/** Незасторнированные начисления смены. */
async function liveAccruals(tx: Tx, shiftId: string): Promise<LiveEntry[]> {
  const r = await tx.query<{ id: string; amount: string; date: string }>(
    `SELECT le.id, le.amount, to_char(${payrollDateSql('le')}, 'YYYY-MM-DD') AS date
       FROM journal.payroll_accruals a JOIN journal.ledger_entries le ON le.id = a.ledger_entry_id
      WHERE a.shift_id = $1 AND NOT EXISTS (SELECT 1 FROM journal.ledger_entries r WHERE r.reversal_of = le.id)
      ORDER BY le.id`,
    [shiftId],
  );
  return r.rows.map((x) => ({ id: x.id, amount: x.amount, date: x.date as LocalDate }));
}

interface ShiftState {
  id: string;
  staff_id: string;
  branch_id: string;
  timezone: string;
  local_date: string;
  status: string;
  paid_minutes: number | null;
  unpaid_confirmed: boolean;
  fact_version: number;
}

const STATE_SQL = `SELECT s.id, s.staff_id, s.branch_id, b.timezone, to_char(s.local_date, 'YYYY-MM-DD') AS local_date, s.status, s.paid_minutes, s.unpaid_confirmed, s.fact_version
  FROM app.staff_shifts s JOIN app.branches b ON b.id = s.branch_id WHERE s.id = $1`;

/** Привести начисление смены к её текущему состоянию. mode='rate': смену закрытого периода не трогать. */
export async function settleShift(tx: Tx, shiftId: string, mode: 'attendance' | 'rate', clock: Clock = systemClock, eventFactVersion?: number): Promise<void> {
  const seen = (await tx.query<ShiftState>(STATE_SQL, [shiftId])).rows[0];
  if (!seen) return;
  const shiftDate = seen.local_date as LocalDate;
  const dates = [shiftDate, ...(await liveAccruals(tx, shiftId)).map((e) => e.date)];
  const periods = await lockPeriodsShared(tx, dates);
  const closedAt = (date: LocalDate): PeriodLock | undefined => periods.find((p) => p.status === 'closed' && p.from <= date && date <= p.to);
  const anyClosed = periods.some((p) => p.status === 'closed');
  if (mode === 'rate' && closedAt(shiftDate)) return;
  const openDate = anyClosed ? await openPayrollDate(tx, seen.timezone as TimeZone, clock) : null;

  const account = await staffAccount(tx, seen.staff_id);
  await lockAccounts(tx, [account.id]);
  const shift = (await tx.query<ShiftState>(`${STATE_SQL} FOR UPDATE OF s`, [shiftId])).rows[0]!;
  if (shift.local_date !== seen.local_date) await lockPeriodsShared(tx, [shift.local_date as LocalDate]); // смену успели перенести

  const date = shift.local_date as LocalDate;
  const rate = await rateAt(tx, shift.staff_id, date);
  const payable = shift.status === 'worked' && !shift.unpaid_confirmed && rate !== null && shift.paid_minutes !== null;
  const feeMin = (await resolveSetting(tx, 'payroll.attendance_fee_min_minutes', { network: true }, clock.now())).value;
  const target = payable ? accrualParts(shift.paid_minutes!, rate, feeMin) : null;
  const targetKop = target?.totalKop ?? 0;
  const ref = { type: 'shift' as const, id: shift.id };

  // Закрытый период: снимок не меняем, разницу – корректировкой в открытом (K18 §6, §7).
  const closed = closedAt(date);
  if (closed && mode === 'attendance') {
    // Версия уже учтена начислением или системной корректировкой – событие опоздало: снимок и журнал не трогаем.
    const last = (await tx.query<{ fact_version: number; rate_id: string | null }>(`SELECT fact_version, rate_id FROM journal.payroll_accruals WHERE shift_id = $1 ORDER BY fact_version DESC LIMIT 1`, [shift.id])).rows[0];
    // Учтённая версия – и у снимка без денег (0436): разница 0 тоже «обработана».
    const corrected = await tx.query<{ v: number | null }>(
      `SELECT greatest((SELECT max((refs->>'factVersion')::int) FROM journal.ledger_entries WHERE account_id = $1 AND ref_type = 'shift' AND ref_id = $2 AND refs ? 'closedPeriodId'),
                       (SELECT max(fact_version) FROM journal.payroll_closed_snapshots WHERE shift_id = $2)) AS v`,
      [account.id, shift.id],
    );
    if ((eventFactVersion ?? shift.fact_version) <= Math.max(last?.fact_version ?? 0, corrected.rows[0]?.v ?? 0)) return;
    // Цель – по ставке, с которой период закрыт, а не по новой (K18 §3); ручные корректировки в сумму не входят: их разницей не поглощаем.
    // Ставка – самой свежей записи смены: начисления или прежней системной корректировки (refs.rateId); нет ни той, ни другой – на дату.
    // Ставку корректировка пишет в refs: по ней сверка (rpt_payroll_accruals, 0413) считает ожидаемую сумму, а не по ставке на дату.
    // Порог доплаты за выход – тоже (refs.feeMinMinutes, 0414): истории настройки нет, без снимка сверка не отличит пропавшую доплату.
    // Снимок без денег (0436) – такая же запись смены, как корректировка: сверка берёт ставку и порог у самой свежей из них.
    const prior = (
      await tx.query<{ rate_id: string; v: number }>(
        `SELECT rate_id, v FROM (
           SELECT refs->>'rateId' AS rate_id, (refs->>'factVersion')::int AS v FROM journal.ledger_entries WHERE account_id = $1 AND ref_type = 'shift' AND ref_id = $2 AND refs ? 'closedPeriodId' AND refs ? 'rateId'
           UNION ALL
           SELECT rate_id::text, fact_version FROM journal.payroll_closed_snapshots WHERE shift_id = $2 AND rate_id IS NOT NULL
         ) p ORDER BY v DESC LIMIT 1`,
        [account.id, shift.id],
      )
    ).rows[0];
    const appliedId = prior && prior.v > (last?.fact_version ?? 0) ? prior.rate_id : (last?.rate_id ?? null);
    const applied = appliedId ? (await tx.query<{ hourly_kop: string; attendance_fee_kop: string }>(`SELECT hourly_kop, attendance_fee_kop FROM journal.staff_rates WHERE id = $1`, [appliedId])).rows[0] : undefined;
    const closedRate = applied ? { hourlyKop: Number(applied.hourly_kop), attendanceFeeKop: Number(applied.attendance_fee_kop) } : rate;
    const closedRateId = applied ? appliedId : (rate?.id ?? null);
    const closedTarget = shift.status === 'worked' && !shift.unpaid_confirmed && closedRate !== null && shift.paid_minutes !== null ? accrualParts(shift.paid_minutes, closedRate, feeMin).totalKop : 0;
    const sum = await tx.query<{ sum: string }>(
      `SELECT coalesce(sum(amount), 0) AS sum FROM journal.ledger_entries WHERE account_id = $1 AND ref_type = 'shift' AND ref_id = $2 AND (entry_type IN ('payroll.accrual','reversal') OR refs ? 'closedPeriodId')`,
      [account.id, shift.id],
    );
    const diff = closedTarget - Number(sum.rows[0]!.sum);
    if (diff !== 0) {
      const onDate = openDate ?? date;
      await post(tx, {
        entries: [{ account: { kind: 'staff_payroll', ownerType: 'staff', ownerId: shift.staff_id }, amount: diff, type: 'payroll.correction', basis: 'Изменение смены закрытого периода', branchId: shift.branch_id, ref, refs: { factVersion: String(shift.fact_version), closedPeriodId: closed.id, ...(closedRateId ? { rateId: closedRateId } : {}), feeMinMinutes: String(feeMin) }, occurredAt: payrollInstant(onDate) }],
        idempotencyKey: `payroll-correction:shift:${shift.id}:${shift.fact_version}`,
        author: SYSTEM_AUTHOR,
      });
    } else {
      // Разница 0 (например, порог сменился, а правка часов дала ту же сумму): деньги не проводим, но снимок условий
      // (ставка, порог) этой версии пишем – иначе сверка считает ожидаемую сумму по прежнему порогу (0436).
      await tx.query(
        `INSERT INTO journal.payroll_closed_snapshots (shift_id, fact_version, rate_id, fee_min_minutes, closed_period_id, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
        [shift.id, shift.fact_version, closedRateId, feeMin, closed.id, clock.now()],
      );
    }
    return;
  }

  const live = await liveAccruals(tx, shift.id);
  const liveKop = live.reduce((s, e) => s + Number(e.amount), 0);
  const current = await tx.query(`SELECT 1 FROM journal.payroll_accruals WHERE shift_id = $1 AND fact_version = $2`, [shift.id, shift.fact_version]);
  if (current.rows.length > 0 && liveKop === targetKop) return; // повторная или запоздавшая доставка
  if (current.rows.length === 0 && target === null && live.length === 0) return; // платить не за что и нечего сторнировать

  // Пересчёт по ставке при той же версии: версия растёт, иначе строка и ключ K3 совпадут с прежними.
  let version = shift.fact_version;
  if (current.rows.length > 0) {
    version = (await tx.query<{ fact_version: number }>(`UPDATE app.staff_shifts SET fact_version = fact_version + 1 WHERE id = $1 RETURNING fact_version`, [shift.id])).rows[0]!.fact_version;
  }
  for (const entry of live) {
    await reverse(tx, {
      entryId: Number(entry.id),
      reason: `Пересчёт смены, версия ${version}`,
      idempotencyKey: `payroll-accrual-reversal:${entry.id}`,
      author: SYSTEM_AUTHOR,
      occurredAt: payrollInstant(closedAt(entry.date) && openDate ? openDate : entry.date),
    });
  }
  if (!target) return;
  let entryId: number | null = null;
  if (target.totalKop !== 0) {
    const posted = await post(tx, {
      entries: [
        {
          account: { kind: 'staff_payroll', ownerType: 'staff', ownerId: shift.staff_id },
          amount: target.totalKop,
          type: 'payroll.accrual',
          branchId: shift.branch_id,
          ref,
          refs: { factVersion: String(version), rateId: rate!.id, hourlyPartKop: String(target.hourlyPartKop), feePartKop: String(target.feePartKop) },
          occurredAt: payrollInstant(date),
        },
      ],
      idempotencyKey: `payroll-accrual:${shift.id}:${version}`,
      author: SYSTEM_AUTHOR,
    });
    entryId = posted.entries[0]!.id;
  }
  // fee_min_minutes – порог, по которому посчитана доплата (снимок для сверки, 0414).
  await tx.query(`INSERT INTO journal.payroll_accruals (shift_id, fact_version, ledger_entry_id, rate_id, hourly_part_kop, fee_part_kop, fee_min_minutes) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
    shift.id,
    version,
    entryId,
    rate!.id,
    target.hourlyPartKop,
    target.feePartKop,
    feeMin,
  ]);
}

/** Подписки начисления; идемпотентность – processed_events (K4) и ключи K3. Подключает worker до startOutboxWorker. */
export function registerPayrollHandlers(deps: { clock?: Clock } = {}): void {
  const clock = deps.clock ?? systemClock;
  subscribe('shift.attendance_changed', HANDLER_ATTENDANCE, async (tx: Tx, e: EventEnvelope<'shift.attendance_changed'>) => {
    await settleShift(tx, e.payload.shiftId, 'attendance', clock, e.payload.factVersion);
  });
  subscribe('staff.rate_set', HANDLER_RATE, async (tx: Tx, e: EventEnvelope<'staff.rate_set'>) => {
    for (const shiftId of e.payload.affectedShiftIds) await settleShift(tx, shiftId, 'rate', clock);
  });
}

// Смены сотрудников и зарплата в CRM (S3-70…S3-75): типы – по ответам apps/api/src/modules/shifts (K18), подписи статусов, тексты ошибок по кодам
// сервера, копейки ↔ рубли без дробной арифметики (строкой) и длительности целыми минутами. Время показываем по зоне филиала – см. lib/booking.ts.
import { ApiError } from './api.ts';
import { addDays } from './booking.ts';

export type ShiftStatus = 'planned' | 'worked' | 'no_show' | 'cancelled' | 'needs_review';
export interface ShiftDto {
  id: string; staffId: string; branchId: string; timezone: string; localDate: string;
  plannedStart: string; plannedEnd: string; plannedMinutes: number; status: ShiftStatus;
  factStart: string | null; factEnd: string | null; paidMinutes: number | null; paidMinutesSource: 'fact_time' | 'manual' | null;
  flags: { rateMissing: boolean; unpaidConfirmed: boolean; outsideHours: boolean; reviewReason: string | null };
  /** null – нет ставки или нет права payroll.view (не ноль). */
  plannedAccrualKop: number | null; factAccrualKop: number | null;
  factVersion: number; comment: string | null; createdBy: string; rowVersion: number;
  /** Имя и фамилия; есть в чтениях (№301, GET /shifts/{id}), в ответах команд нет. */
  staffName?: string;
}
export interface Interval { start: string; end: string }
export interface CoverageDto { branchId: string; date: string; timezone: string; open: Interval[]; covered: Interval[]; gaps: Interval[]; state: 'full' | 'partial' | 'empty' | 'closed' }
export interface ShiftChange { id: string; shiftId: string; changedBy: string; changedAt: string; kind: string; before: Partial<Interval> & { branchId?: string } | null; after: Partial<Interval> & { branchId?: string } | null; reason: string | null; acknowledgedAt: string | null }
export interface TimelineEvent { id: string; at: string; action: string; actorId: string | null; before: Record<string, unknown> | null; after: Record<string, unknown> | null; reason: string | null }

export interface StaffRate { id: string; staffId: string; validFrom: string; hourlyKop: number; attendanceFeeKop: number; corrects: string | null; reason: string; createdBy: string; createdAt: string }

export interface PayrollPeriod { id: string; from: string; to: string; status: 'open' | 'closed'; closedAt: string | null; closedBy: string | null }
export type StatementStatus = 'draft' | 'calculated' | 'checked' | 'ready' | 'paid' | 'disputed';
export interface PayrollTotals { plannedShifts: number; workedShifts: number; noShows: number; plannedMinutes: number; paidMinutes: number; forecastKop: number; accruedKop: number; hourlyPartKop: number; feePartKop: number; penaltiesKop: number; bonusesKop: number; correctionsKop: number; toPayKop: number }
export interface PayrollStatement {
  id: string; periodId: string; staffId: string; status: StatementStatus; totals: PayrollTotals;
  byBranch: Array<{ branchId: string; workedShifts: number; paidMinutes: number; accruedKop: number }>;
  plannedPayoutDate: string | null; actualPayoutDate: string | null; payoutComment: string | null;
  needsReview: Array<{ shiftId: string; reason: string }>; rowVersion: number;
}
export interface ReportShift {
  id: string; branchId: string; localDate: string; plannedStart: string; plannedEnd: string; plannedMinutes: number; status: ShiftStatus;
  factStart: string | null; factEnd: string | null; paidMinutes: number | null; flags: ShiftDto['flags'];
  hourlyKop: number | null; attendanceFeeKop: number | null; forecastKop: number | null; accruedKop: number;
}
export interface ReportEntry { id: string; date: string; type: string; kind: string; branchId: string | null; amountKop: number; basis: string | null; ref: { type: string; id: string } | null }
export interface ReportRow {
  staffId: string; name: string; role: string;
  branches: Array<{ branchId: string; plannedShifts: number; workedShifts: number; noShows: number; plannedMinutes: number; paidMinutes: number; forecastKop: number; accruedKop: number }>;
  plannedShifts: number; workedShifts: number; noShows: number; plannedMinutes: number; paidMinutes: number;
  hourlyKop: number | null; attendanceFeeKop: number | null;
  forecastKop: number; accruedKop: number; penaltiesKop: number; bonusesKop: number; correctionsKop: number; otherDeductionsKop: number; toPayKop: number;
  statementStatus: StatementStatus | null; plannedPayoutDate: string | null; actualPayoutDate: string | null;
  detail?: { shifts: ReportShift[]; entries: ReportEntry[] };
}
export interface PayrollReport {
  from: string; to: string; rows: ReportRow[];
  totals: { forecastKop: number; accruedKop: number; penaltiesKop: number; bonusesKop: number; correctionsKop: number; otherDeductionsKop: number; toPayKop: number; staffCount: number; emptyIntervals: number; unclosedShifts: number };
}
export interface Penalty { id: string; kind: 'penalty' | 'bonus'; staffId: string; branchId: string | null; date: string; amountKop: number; reason: string; comment: string | null; status: 'active' | 'cancelled'; periodId: string | null; authorId: string; postingId: string; cancelReason: string | null; replacedBy: string | null }

export const SHIFT_STATUS: Record<ShiftStatus, { text: string; cls: string }> = {
  planned: { text: 'Запланирована', cls: 'yc-badge--preparing' },
  worked: { text: 'Отработана', cls: 'yc-badge--active' },
  no_show: { text: 'Невыход', cls: 'yc-badge--bk-no_show' },
  cancelled: { text: 'Отменена', cls: 'yc-badge--archived' },
  needs_review: { text: 'Требует проверки', cls: 'yc-badge--temporarily_closed' },
};
export const STATEMENT_STATUS: Record<StatementStatus, { text: string; cls: string }> = {
  draft: { text: 'Черновик', cls: 'yc-badge--preparing' },
  calculated: { text: 'Рассчитана', cls: 'yc-badge--preparing' },
  checked: { text: 'Проверена', cls: 'yc-badge--preparing' },
  ready: { text: 'Готова к выплате', cls: 'yc-badge--temporarily_closed' },
  paid: { text: 'Выплачена', cls: 'yc-badge--active' },
  disputed: { text: 'Спорная', cls: 'yc-badge--bk-no_show' },
};
/** Причины unresolvedShifts (payroll.ts) и review_reason смены – словами. */
export const UNRESOLVED_REASON: Record<string, string> = {
  needs_review: 'требует проверки: нет отметки прихода или ухода',
  no_fact: 'не подтверждён факт выхода: смена ещё плановая',
  rate_missing: 'не настроена ставка оплаты',
  accrual_pending: 'начисление ещё пересчитывается',
};
export const REVIEW_REASON: Record<string, string> = { no_checkout: 'нет отметки ухода', no_checkin: 'нет отметки прихода' };

const FRIENDLY: Record<string, string> = {
  STAFF_NOT_ACTIVE: 'Сотрудник заблокирован или в архиве: новые смены запрещены.',
  STAFF_ON_LEAVE: 'Сотрудник отмечен как «Временно не работает»: новые смены запрещены.',
  STAFF_NOT_ASSIGNED: 'Сотрудник не назначен на этот филиал на эту дату.',
  INVALID_DURATION: 'Проверьте время: начало раньше конца, смена в пределах одних суток филиала.',
  SHIFT_TOO_SHORT: 'Смена короче минимальной длительности, заданной в настройках.',
  OUTSIDE_SCHEDULE: 'Время вне графика филиала: такую смену ставит Директор или Владелец.',
  SHIFT_OVERLAP: 'Конфликт времени: смена пересекается с другой сменой этого сотрудника. Не сохранено.',
  SHIFT_EDIT_DEADLINE: 'Свою смену можно менять не позже чем за 24 часа до начала. Обратитесь к руководителю.',
  SHIFT_NOT_EDITABLE: 'Эту смену уже нельзя изменить здесь: её исправляет руководитель.',
  CHECKIN_WINDOW: 'Приход отмечается не раньше чем за 30 минут до начала смены и до её конца.',
  COMMENT_REQUIRED: 'Укажите причину.',
  VERSION_CONFLICT: 'Запись уже изменили. Экран обновлён, проверьте и повторите.',
  PAYROLL_PERIOD_CLOSED: 'Расчётный период закрыт: исправление – только корректировкой в открытом периоде.',
  PAYROLL_PERIOD_OPEN: 'Сначала закройте расчётный период.',
  PAYROLL_PERIOD_OVERLAP: 'Период пересекается с существующим.',
  PAYROLL_STATEMENT_NEEDS_REVIEW: 'В ведомости есть нерешённые смены: сначала разберите их.',
  PAYOUT_EXPENSE_EXISTS: 'Расход по этой выплате уже создан: второй не проводим.',
  PAYOUT_AMOUNT_MISMATCH: 'Сумма расхода не совпадает с выплатой.',
  OPERATION_ALREADY_LINKED: 'Эта операция уже привязана к другой записи.',
  OPERATION_LINK_INVALID: 'Эту операцию нельзя привязать: она не подходит или сторнирована.',
  FEATURE_DISABLED: 'Штрафы выключены настройкой до юридической проверки.',
  BRANCH_REQUIRED: 'Укажите филиал: без филиала запись ставит только Владелец.',
  INVALID_AMOUNT: 'Проверьте сумму.',
  ALREADY_REVERSED: 'Запись уже отменена.',
  FORBIDDEN: 'Недостаточно прав для этого действия.',
  NOT_FOUND: 'Не найдено: запись удалена или вне вашей зоны.',
};
export function shiftError(e: unknown): string {
  if (!(e instanceof ApiError)) return 'Неизвестная ошибка. Повторите.';
  if (e.code === 'PAYROLL_PERIOD_GAP' && typeof e.details?.expectedFrom === 'string') return `Периоды идут без разрывов: новый должен начинаться ${fmtDate(e.details.expectedFrom)}.`;
  return FRIENDLY[e.code] ?? e.message;
}

// ---- деньги: только целые копейки, разбор – строкой, без умножения дробей

const parse = (t: string): number | null => {
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(t);
  return m ? Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0')) : null;
};
/** «350,50» → 35050. Ноль допустим (ставка 0 ₽ ≠ «ставка не задана»); неверный ввод – null. */
export const parseKopZero = (input: string): number | null => parse(input.replace(/\s/g, '').replace(',', '.'));
/** Сумма со знаком для корректировки: «−500» → −50000; ноль – null. */
export function parseKopSigned(input: string): number | null {
  const t = input.replace(/\s/g, '').replace(',', '.').replace(/^[−–]/, '-');
  const neg = t.startsWith('-');
  const v = parse(neg || t.startsWith('+') ? t.slice(1) : t);
  return v === null || v === 0 ? null : neg ? -v : v;
}
/** 35050 → «350,50» для поля ввода. */
export function kopToInput(kop: number): string {
  const r = Math.trunc(kop / 100);
  const k = kop - r * 100;
  return k === 0 ? String(r) : `${r},${String(k).padStart(2, '0')}`;
}

// ---- длительность и даты

export function fmtMinutes(minutes: number): string {
  const m = minutes % 60;
  const h = (minutes - m) / 60;
  return h === 0 ? `${m} мин` : m === 0 ? `${h} ч` : `${h} ч ${m} мин`;
}
export const fmtDate = (date: string) => `${date.slice(8, 10)}.${date.slice(5, 7)}.${date.slice(0, 4)}`;
/** Понедельник недели даты (ISO). */
export function mondayOf(date: string): string {
  const wd = (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
  return addDays(date, -wd);
}
export const monthStart = (date: string) => `${date.slice(0, 7)}-01`;
export function monthEnd(date: string): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return addDays(next, -1);
}
export const addMonths = (date: string, n: number) => {
  const total = Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1 + n;
  const m = total % 12;
  return `${(total - m) / 12}-${String(m + 1).padStart(2, '0')}-01`;
};
export const monthTitle = (date: string) => {
  const s = new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${date.slice(0, 7)}-01T12:00:00Z`));
  return s.charAt(0).toUpperCase() + s.slice(1).replace(' г.', '');
};

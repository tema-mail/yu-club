// Отчёты CRM (S4-90…S4-98; K24, 14 §15, 13 §6): типы ответов – по apps/api/src/modules/reports (routes.crm.ts, routes.crm.export.ts,
// framework.ts, dashboard.ts, search.ts, reconcile.ts, export.ts), подписи и форматирование. 0, «нет данных» и «недоступно» не смешиваются
// (K24 §2): недоступное показывается словами, а не нулём. Деньги – в копейках, баллы – в сотых (centi), показ – в рублях и баллах.
import { ApiError } from './api.ts';

export type MetricUnit = 'count' | 'kop' | 'centi' | 'minutes' | 'pct' | 'days';
export type UnavailableReason = 'source_not_ready' | 'missing_input' | 'not_permitted';
export type Metric =
  | { state: 'ok'; value: number; unit: MetricUnit; prev?: number | null; deltaAbs?: number | null; deltaPct?: number | null }
  | { state: 'no_data' }
  | { state: 'unavailable'; reason: UnavailableReason };

export interface Period { from: string; to: string }

/** K11 №240: общий вид ответа отчёта; у отчётов свои добавки (labels, groups, rows, series). */
export interface ReportResult {
  metrics: Record<string, Metric>;
  dateBasis: Record<string, string> | string;
  labels?: Record<string, string>;
  groups?: Record<string, unknown>;
  rows?: UnitRow[];
  series?: { points: SeriesPoint[]; zoneNote: string | null };
  period: Period;
  prevPeriod: Period;
  computedAt: string;
  dayRule: string;
}

/** utilization.ts: строка единицы (место ресурса). */
export interface UnitRow {
  unitId: string; unitName: string; resourceId: string; resourceType: string; roomId: string | null; branchId: string; branchName: string;
  availableMin: number; availableElapsedMin: number; blockedMin: number; technicalMin: number; bookedMin: number; usedMin: number; freeMin: number;
}
export interface SeriesPoint { bucket: string; availableMin: number; usedMin: number; bookedMin: number }

/** K11 №241. */
export interface DetailResult { columns: string[]; rows: Array<Record<string, unknown>>; total: Metric; nextCursor: string | null }

/** K11 №239 (dashboard.ts). */
export interface DashboardCard { key: string; title: string; metric: Metric; link: { report: string; metric: string }; note?: string }
export interface DashboardResult { cards: DashboardCard[]; period: Period; prevPeriod: Period; dayRule: string; computedAt: string }

/** K11 №242 (utilization.ts: UnitCalendar). */
export interface Interval { start: string; end: string }
export interface UnitCalendar { unitId: string; date: string; open: Interval[]; booked: Interval[]; blocked: Interval[]; free: Interval[] }

/** K11 №243–247 (export.ts: ExportJob). */
export type ExportStatus = 'queued' | 'running' | 'ready' | 'expired' | 'failed' | 'cancelled';
export interface ExportJob {
  id: string; report: string; format: 'xlsx' | 'csv'; params: Record<string, unknown>; detail: boolean; masked: boolean; status: ExportStatus;
  errorCode: string | null; rows: number | null; bytes: number | null; createdAt: string; startedAt: string | null; finishedAt: string | null;
  expiresAt: string | null; downloadedAt: string | null;
}

/** K11 №250 (search.ts). */
export type SearchType = 'client' | 'booking' | 'finance_operation' | 'staff' | 'event' | 'equipment';
export interface SearchGroup { type: SearchType; items: Array<Record<string, unknown>>; more: boolean }

/** K11 №248 (routes.crm.ts). Директору сервер не отдаёт discrepancyCount и error (undefined – поля нет в JSON). */
export interface ReconcileDiscrepancy {
  check: string; objectType: string; objectId: string; branchId: string | null; expected: number; actual: number; details: Record<string, unknown>; createdAt: string;
}
export interface ReconcileRun {
  id: string; trigger: 'schedule' | 'manual'; scheduledFor: string | null; startedAt: string; finishedAt: string | null;
  status: 'running' | 'ok' | 'discrepancies' | 'failed'; checked: Record<string, number> | null; discrepancyCount?: number; error?: string | null;
  discrepancies: ReconcileDiscrepancy[];
}

// ---- реестр отчётов (K24 §3, §8; 14 §15 – название и назначение)

export type ReportKey = 'bookings' | 'utilization' | 'finance' | 'events' | 'clients' | 'loyalty' | 'certificates' | 'staff' | 'equipment' | 'comms';
export interface ReportInfo {
  key: ReportKey; title: string; purpose: string; action: string;
  /** Фильтры экрана сверх периода, города и филиала (report-handlers.ts QUERY). */
  filters: Array<'resourceType' | 'status' | 'method'>;
  /** Явная «Сформировать» при длинном периоде (K24 §9: 3.3 и 3.6 при > 31 дня). */
  heavy?: boolean;
  /** Измерения сегмента (segment.ts REPORT_SEGMENTS). */
  segments: string[];
}

export const REPORTS: ReportInfo[] = [
  { key: 'bookings', title: 'Бронирования и посещаемость', purpose: 'Сколько броней создано, состоялось, отменено и перенесено', action: 'reports.ops.view', filters: ['resourceType', 'status'], segments: ['branch', 'day', 'resourceType', 'status'] },
  { key: 'utilization', title: 'Загрузка ресурсов', purpose: 'Сколько времени мест было доступно, занято и свободно', action: 'reports.ops.view', filters: ['resourceType'], heavy: true, segments: ['branch', 'day', 'hour', 'resourceType'] },
  { key: 'finance', title: 'Финансы и касса', purpose: 'Поступления, возвраты, расходы и остатки по местам денег', action: 'reports.finance.view', filters: ['method'], segments: ['branch', 'day', 'method', 'source', 'category', 'place'] },
  { key: 'events', title: 'Мероприятия', purpose: 'Проведённые мероприятия, деньги и себестоимость', action: 'reports.events.view', filters: [], segments: [] },
  { key: 'clients', title: 'Клиенты и повторные посещения', purpose: 'Кто пришёл впервые, кто вернулся', action: 'reports.clients.view', filters: [], heavy: true, segments: ['branch', 'day'] },
  { key: 'loyalty', title: 'Лояльность и баллы', purpose: 'Начисления, списания и балансы баллов', action: 'reports.loyalty.view', filters: [], segments: ['branch', 'day'] },
  { key: 'certificates', title: 'Сертификаты', purpose: 'Продажи, погашения и остатки сертификатов', action: 'reports.finance.view', filters: [], segments: ['branch', 'day'] },
  { key: 'staff', title: 'Сотрудники и смены', purpose: 'Смены, явки, пустые интервалы и начисления', action: 'reports.staff.view', filters: [], segments: [] },
  { key: 'equipment', title: 'Оборудование и ремонты', purpose: 'Неисправности, простой и расходы на ремонт', action: 'reports.equipment.view', filters: [], segments: [] },
  { key: 'comms', title: 'Уведомления и публикации', purpose: 'Отправки, отказы от рекламы и публикации', action: 'reports.comms.view', filters: [], segments: ['branch', 'day'] },
];
export const reportInfo = (key: string): ReportInfo | undefined => REPORTS.find((r) => r.key === key);

export const METRIC_TITLES: Record<string, string> = {
  created: 'Создано', planned: 'Запланировано', visited: 'Состоялось', cancelledByClient: 'Отмены клиентом', cancelledByClub: 'Отмены клубом',
  rescheduled: 'Перенесено', noShows: 'Неявки', awaitingDecision: 'Ожидают решения', avgMinutes: 'Средняя длительность', uniqueVisitors: 'Уникальные посетители',
  available: 'Доступное время', availableElapsed: 'Доступное время до текущего момента', blocked: 'Заблокировано', technical: 'Техническое время', booked: 'Забронировано',
  used: 'Использовано', free: 'Свободно', actualLoad: 'Фактическая загрузка', commercialLoad: 'Коммерческая загрузка',
  income: 'Поступления', incomeSession: 'Поступления от сеансов', incomeEvent: 'Поступления от мероприятий', incomeCertificateSale: 'Продажи сертификатов',
  incomeExtraService: 'Дополнительные услуги', incomeOther: 'Прочие поступления', refunds: 'Возвраты', expenses: 'Расходы', withdrawals: 'Изъятия', transfers: 'Переводы',
  corrections: 'Исправления', netMovement: 'Чистое движение денег', nonMoneyPoints: 'Оплачено баллами (не деньги)', nonMoneyCertificate: 'Оплачено сертификатами (не деньги)',
  cashOpening: 'Остаток на начало', cashClosing: 'Остаток на конец',
  count: 'Мероприятия', cancelled: 'Отменены и не состоялись', withoutBooking: 'Без брони ресурса', agreedPrice: 'Согласованная стоимость', avgPrice: 'Средняя стоимость',
  received: 'Поступило', refunded: 'Возвращено', due: 'Осталось получить', plannedCost: 'Себестоимость по плану', factCost: 'Себестоимость по факту',
  deviation: 'Отклонение себестоимости', result: 'Результат мероприятий',
  plannedShifts: 'Смен по плану', workedShifts: 'Отработано смен', unclosedShifts: 'Незакрытые смены', shortShifts: 'Короткие смены',
  plannedMinutes: 'Плановое время', paidMinutes: 'Оплачиваемое время', emptyIntervals: 'Пустые интервалы', emptyMinutes: 'Время без сотрудника',
  accrued: 'Начислено', hoursAmount: 'За часы', perShift: 'Ставка за выход', penalties: 'Штрафы', bonuses: 'Премии', adjustments: 'Корректировки', toPay: 'К выплате',
  paid: 'Выплачено', payoutExpense: 'Расход кассы на выплату', forecast: 'Прогноз по плановым сменам',
  totalEquipment: 'Оборудование на учёте', inService: 'В работе', faulty: 'Неисправно', openFaults: 'Открытые неисправности', incidents: 'Поломки',
  warrantyRepairs: 'Гарантийные ремонты', repairExpenses: 'Расходы на ремонт', avgRepairMinutes: 'Средняя длительность ремонта', downtimeMinutes: 'Простой',
  repeatBreakdowns: 'Повторные поломки',
  withVisit: 'Клиенты с посещением', firstTime: 'Впервые', returning: 'Вернувшиеся', repeat: 'Повторные', notVisited: 'Не приходили', profileVisits: 'Посещения клиентов с профилем',
  newProfiles: 'Новые профили', visitsPerClient: 'Посещений на клиента', avgIntervalDays: 'Средний интервал, дней',
  spentTime: 'Списано на время', spentGoods: 'Списано на товары', returned: 'Возвращено', adjusted: 'Корректировки', expired: 'Сгорело',
  clientsPositive: 'Клиенты с плюсовым балансом', clientsNegative: 'Клиенты с минусом', clientsAtThreshold: 'Клиенты у порога', clientsBlocked: 'Заблокировано оплат баллами', totalBalance: 'Итоговый баланс',
  salesCount: 'Продано, шт.', salesAmount: 'Продано на сумму', redeemedAmount: 'Погашено на сумму', redeemReturnedAmount: 'Возвращено погашений', expiredCount: 'Сгорело, шт.',
  expiredAmount: 'Сгорело на сумму', cancelledCount: 'Отменено, шт.', activeCount: 'Действующие, шт.', activeBalance: 'Остаток действующих', partiallyRedeemed: 'Погашены частично',
  birthdayGift: 'Подарки на день рождения', campaignsCount: 'Рекламные кампании', campaignsReach: 'Охват кампаний', optOuts: 'Отказы от рекламы',
  siteViews: 'Просмотры на сайте', siteClicks: 'Переходы с сайта',
};
export const metricTitle = (key: string): string => METRIC_TITLES[key] ?? key;

export const DATE_BASIS_TITLES: Record<string, string> = {
  session_start: 'по дате сеанса', created_at: 'по дате создания', arrived_at: 'по дате прихода', occurred_at: 'по дате операции', marked_at: 'по дате отметки',
  at: 'по дате события', rescheduled_at: 'по дате переноса', now: 'на момент запроса', finished_at: 'по дате завершения',
};
export function dateBasisOf(r: Pick<ReportResult, 'dateBasis'>, key: string): string {
  const b = typeof r.dateBasis === 'string' ? r.dateBasis : r.dateBasis[key];
  return b ? (DATE_BASIS_TITLES[b] ?? '') : '';
}

export const UNAVAILABLE_TEXT: Record<UnavailableReason, string> = {
  not_permitted: 'Нет права на эти данные',
  source_not_ready: 'Источник ещё не подключён',
  missing_input: 'Не хватает данных для расчёта',
};

export const RESOURCE_TYPE_LABEL: Record<string, string> = { pc: 'ПК', vr: 'VR', ps: 'PlayStation', room: 'Комната' };
export const BOOKING_STATUS_LABEL: Record<string, string> = {
  confirmed: 'Подтверждено', arrived: 'Пришёл', completed: 'Завершено', cancelled_by_client: 'Отменил клиент',
  cancelled_by_club: 'Отменил клуб', no_show: 'Неявка',
};
export const METHOD_LABEL: Record<string, string> = { cash: 'Наличные', card: 'Карта', transfer: 'Перевод' };

// ---- форматирование

const nf = (digits: number) => new Intl.NumberFormat('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits });

export function fmtValue(value: number, unit: MetricUnit): string {
  switch (unit) {
    case 'kop':
      return `${nf(2).format(value / 100)} ₽`;
    case 'centi':
      return `${nf(2).format(value / 100)} балл.`;
    case 'minutes': {
      const m = Math.round(value);
      const h = Math.trunc(m / 60);
      return h ? `${nf(0).format(h)} ч ${Math.abs(m % 60)} мин` : `${m} мин`;
    }
    case 'pct':
      return `${nf(1).format(value)}%`;
    case 'days':
      return `${nf(1).format(value)} дн.`;
    default:
      return Number.isInteger(value) ? nf(0).format(value) : nf(1).format(value);
  }
}

/** Значение показателя словами: ноль – «0», нет записей – «нет данных», нельзя посчитать – причина. */
export function fmtMetric(m: Metric): string {
  if (m.state === 'ok') return fmtValue(m.value, m.unit);
  if (m.state === 'no_data') return 'нет данных';
  return UNAVAILABLE_TEXT[m.reason];
}

/** Сравнение с прошлым периодом: база 0 или её нет – «–» (14 §2.4, приёмка 22). */
export function fmtDelta(m: Metric): string {
  if (m.state !== 'ok' || m.deltaPct === null || m.deltaPct === undefined) return '–';
  const sign = m.deltaPct > 0 ? '+' : m.deltaPct < 0 ? '−' : '';
  return `${sign}${nf(1).format(Math.abs(m.deltaPct))}%`;
}

export const fmtDate = (d: string): string => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
export const fmtPeriod = (p: Period): string => (p.from === p.to ? fmtDate(p.from) : `${fmtDate(p.from)} – ${fmtDate(p.to)}`);

export function fmtAt(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('ru-RU', { timeZone: timezone, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}
export function fmtTime(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('ru-RU', { timeZone: timezone, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

// ---- период (14 §2.2): быстрые периоды от «сегодня» зоны

export function todayIn(timezone: string, now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return parts;
}
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function presets(today: string): Array<{ key: string; label: string; period: Period }> {
  const monthStart = `${today.slice(0, 8)}01`;
  const prevEnd = addDays(monthStart, -1);
  const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
  return [
    { key: 'today', label: 'Сегодня', period: { from: today, to: today } },
    { key: 'yesterday', label: 'Вчера', period: { from: addDays(today, -1), to: addDays(today, -1) } },
    { key: 'week', label: 'Эта неделя', period: { from: addDays(today, -dow), to: addDays(today, 6 - dow) } },
    { key: 'month', label: 'Этот месяц', period: { from: monthStart, to: addDays(`${addDays(monthStart, 32).slice(0, 8)}01`, -1) } },
    { key: 'prevMonth', label: 'Прошлый месяц', period: { from: `${prevEnd.slice(0, 8)}01`, to: prevEnd } },
  ];
}
export const daysIn = (p: Period): number => Math.round((Date.parse(`${p.to}T00:00:00Z`) - Date.parse(`${p.from}T00:00:00Z`)) / 86_400_000) + 1;

// ---- ошибки (reports/errors.ts) словами

export function reportError(e: unknown): string {
  if (!(e instanceof ApiError)) return 'Не удалось загрузить отчёт. Повторите.';
  switch (e.code) {
    case 'REPORT_PERIOD_INVALID':
      return 'Неверный период: начало позже конца или дата слишком далеко в будущем.';
    case 'REPORT_PERIOD_TOO_LONG':
      return `Период длиннее ${String(e.details?.maxDays ?? 92)} дней – для экрана слишком много. Сузьте период или сформируйте файл.`;
    case 'REPORT_FILTER_INVALID':
      return 'Такой фильтр к этому отчёту не подходит. Сбросьте фильтры.';
    case 'REPORT_TIMEOUT':
      return 'Отчёт не уложился по времени – сузьте период или сформируйте файл.';
    case 'NOT_FOUND':
    case 'REPORT_UNKNOWN':
      return 'Такого отчёта или филиала нет в вашей зоне.';
    case 'FORBIDDEN':
      return 'Нет права на этот отчёт.';
    case 'EXPORT_EXPIRED':
      return 'Срок хранения файла истёк – сформируйте заново.';
    case 'EXPORT_NOT_READY':
      return 'Файл ещё не готов.';
    case 'EXPORT_FORBIDDEN':
      return 'Право на этот файл потеряно.';
    case 'EXPORT_TOO_LARGE':
      return 'Слишком много строк для файла – сузьте период.';
    case 'SEARCH_QUERY_TOO_SHORT':
      return e.details?.min === 4 ? 'Для поиска по телефону нужно от 4 цифр.' : 'Введите не меньше 2 символов.';
    case 'RATE_LIMITED':
      return 'Слишком много поисков сразу – повторите через секунду.';
    default:
      return e.message || 'Не удалось загрузить отчёт. Повторите.';
  }
}

/** Адрес отчёта на экране с теми же фильтрами (13 §6.4: карточка ведёт в отчёт с фильтром). */
export function reportHref(report: string, q: { from: string; to: string; cityId?: string; branchIds?: string[]; metric?: string }): string {
  const p = new URLSearchParams({ from: q.from, to: q.to });
  if (q.cityId) p.set('cityId', q.cityId);
  if (q.branchIds?.length) p.set('branchIds', q.branchIds.join(','));
  if (q.metric) p.set('metric', q.metric);
  return `/reports/${report}?${p}`;
}

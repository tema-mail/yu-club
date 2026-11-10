// S4-69. Сводный дашборд (K24 §3.1, §4; 14 §4). Своих формул нет: каждая карточка – значение функции своего отчёта при тех же фильтрах,
// с переходом в него. Набор – по праву роли (§8): нет права – карточки нет, деньги Администратору не приходят. Поступления, возвраты,
// расходы, движение и остаток – отдельными карточками, слова «прибыль» нет (14 §4.3). Карточки Э3 (S4-79): мероприятия (3.5), пустые
// и незакрытые смены (3.9, рабочий стол Директора и Владельца K24 §4), открытые неисправности и простой (3.10) – числами своих отчётов.
import { roleAllows, type AccessContext } from '../../core/permissions.ts';
import { bookingsReport, type BookingsMetric } from './bookings.ts';
import { financeReport } from './finance.ts';
import { equipmentReport } from './equipment.ts';
import { eventsReport } from './events.ts';
import { DAY_RULE, prevPeriod, type Metric, type Period, type ReportEnv, type ReportParams } from './framework.ts';
import { staffReport } from './staff.ts';
import { utilizationReport } from './utilization.ts';

export interface DashboardCard {
  key: string;
  title: string;
  metric: Metric;
  link: { report: string; metric: string };
  note?: string;
}

export interface DashboardResult {
  cards: DashboardCard[];
  period: Period;
  prevPeriod: Period;
  dayRule: string;
  computedAt: string;
}

const BOOKING_CARDS: Array<[BookingsMetric, string]> = [
  ['created', 'Создано броней'],
  ['visited', 'Состоялось посещений'],
  ['cancelledByClient', 'Отмены клиентом'],
  ['cancelledByClub', 'Отмены клубом'],
  ['noShows', 'Неявки'],
];

const FINANCE_CARDS = [
  ['incomeSession', 'Поступления от сеансов'],
  ['incomeEvent', 'Поступления от мероприятий'],
  ['incomeCertificateSale', 'Продажи сертификатов'],
  ['refunds', 'Возвраты'],
  ['expenses', 'Расходы'],
  ['netMovement', 'Чистое движение денег'],
  ['cashClosing', 'Остаток кассы на конец'],
] as const;

export async function dashboard(env: ReportEnv, p: ReportParams): Promise<DashboardResult> {
  const cards: DashboardCard[] = [];
  const allowed = (action: string) => roleAllows(env.ctx.role, action);
  if (allowed('reports.ops.view')) {
    const b = await bookingsReport(env, p);
    for (const [key, title] of BOOKING_CARDS) cards.push({ key, title, metric: b.metrics[key], link: { report: 'bookings', metric: key } });
    const u = await utilizationReport(env, p);
    cards.push({ key: 'actualLoad', title: 'Фактическая загрузка', metric: u.metrics.actualLoad, link: { report: 'utilization', metric: 'actualLoad' } });
  }
  if (allowed('reports.finance.view')) {
    const f = await financeReport(env, p);
    for (const [key, title] of FINANCE_CARDS) cards.push({ key, title, metric: f.metrics[key], link: { report: 'finance', metric: key } });
  }
  if (allowed('reports.events.view')) {
    const e = await eventsReport(env, p);
    cards.push({ key: 'eventsCount', title: 'Мероприятия', metric: e.metrics.count, link: { report: 'events', metric: 'count' }, note: 'По дате проведения' });
  }
  if (allowed('reports.staff.view')) {
    const s = await staffReport(env, p);
    cards.push({ key: 'emptyIntervals', title: 'Пустые смены', metric: s.metrics.emptyIntervals, link: { report: 'staff', metric: 'emptyIntervals' }, note: s.labels.emptyIntervals });
    cards.push({ key: 'unclosedShifts', title: 'Незакрытые смены', metric: s.metrics.unclosedShifts, link: { report: 'staff', metric: 'unclosedShifts' }, note: s.labels.unclosedShifts });
  }
  if (allowed('reports.equipment.view')) {
    const q = await equipmentReport(env, p);
    cards.push({ key: 'openFaults', title: 'Открытые неисправности', metric: q.metrics.openFaults, link: { report: 'equipment', metric: 'openFaults' }, note: 'На момент запроса' });
    cards.push({ key: 'downtime', title: 'Часы простоя', metric: q.metrics.downtimeMinutes, link: { report: 'equipment', metric: 'downtimeMinutes' }, note: 'В минутах, пересечения не задваиваются' });
  }
  return { cards, period: p.period, prevPeriod: prevPeriod(p.period), dayRule: DAY_RULE, computedAt: env.clock.now().toISOString() };
}

// ---- снимок сводки на экране (D5-12)

/** Сводка – значения 5–8 отчётов в одном снимке (≈ 8 с на синтетике Q-93, S4-131): на экране она обновляется не чаще раза в 60 с.
 *  Снимок – на пул отчётов (один на процесс API) по ключу «сотрудник × роль и зона × права × фильтр × период»; computedAt – момент
 *  расчёта, экран его показывает («рассчитано 14:02»), кнопка «обновить» не нужна. Ошибка не кэшируется – экран видит ошибку, а не
 *  прошлый результат (K24 §2). Файл экспорта (export.ts) зовёт dashboard() напрямую и считает заново. */
export const DASHBOARD_TTL_MS = 60_000;
const DASHBOARD_CACHE_MAX = 500;
const dashboardCaches = new WeakMap<object, Map<string, { until: number; value: DashboardResult }>>();

const sorted = (xs: Iterable<string>): string[] => [...xs].sort();

/** Всё, от чего зависят карточки: сотрудник, роль, зона, делегированные права на сегодня и фильтр с периодом. Каждая зона (Set) –
 *  отсортированным массивом: JSON.stringify(Set) = {}, и сужение зоны гранта не меняло бы ключ – отозванный филиал виден до 60 с. */
export function dashboardKey(ctx: AccessContext, p: ReportParams): string {
  const grants = ctx.grants
    ? [...ctx.grants.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([action, z]) => [action, sorted(z.cityIds), sorted(z.branchIds)])
    : [];
  return JSON.stringify([
    ctx.actor.staffId, ctx.role, ctx.network, sorted(ctx.cityIds), sorted(ctx.branchIds), grants,
    p.period.from, p.period.to, p.cityId ?? null, sorted(p.branchIds ?? []),
  ]);
}

/** Свежий снимок по ключу – он; нет или старше DASHBOARD_TTL_MS – compute() (место в полосе и соединение берутся только тогда). */
export async function cachedDashboard(owner: object, key: string, compute: () => Promise<DashboardResult>, nowMs: number = Date.now()): Promise<DashboardResult> {
  let cache = dashboardCaches.get(owner);
  if (!cache) {
    cache = new Map();
    dashboardCaches.set(owner, cache);
  }
  const hit = cache.get(key);
  if (hit && hit.until > nowMs) return hit.value;
  const value = await compute();
  for (const [k, e] of cache) if (e.until <= nowMs) cache.delete(k);
  if (cache.size >= DASHBOARD_CACHE_MAX) cache.delete(cache.keys().next().value!); // самый старый
  cache.set(key, { until: nowMs + DASHBOARD_TTL_MS, value });
  return value;
}

// Уведомления в CRM (K21 §5–§11, K11 №201–212; 09 §7.4, §12): типы ответов API, подписи, время в зоне филиала.
// Типы повторяют apps/api/src/modules/notifications/{campaigns,journal,segments,templates}.ts: контракт один,
// подмена мок ↔ бэкенд – только API_URL. Мок (tests/mock-notifications.ts) типизирован этими же типами.
import { ApiError } from './api.ts';

export type CampaignCategory = 'service' | 'marketing';
export type CampaignStatus = 'draft' | 'confirmed' | 'expanding' | 'sending' | 'done' | 'cancelled';
export type RowCategory = 'service' | 'reminder' | 'marketing';
export type RowStatus =
  | 'planned' | 'queued' | 'sending' | 'sent_to_provider' | 'delivered' | 'error' | 'cancelled'
  | 'skipped_by_prefs' | 'skipped_booking_changed' | 'no_channel' | 'skipped_by_frequency' | 'inbox_only';

export interface SegmentV1 {
  v: 1;
  area: { network: true } | { cityIds: string[] } | { branchIds: string[] };
  visitedBetween?: { from: string; to: string };
  notVisitedSince?: string;
  minVisits?: number;
  hasUpcomingBooking?: boolean;
  resourceTypes?: Array<'pc' | 'vr' | 'ps'>;
  registeredBetween?: { from: string; to: string };
}

export type Audience =
  | { kind: 'client'; clientId: string; bookingId?: string; branchId?: string }
  | { kind: 'booking'; bookingId: string }
  | { kind: 'segment'; segment: SegmentV1 };

/** K21 §5: что видит экран перед отправкой (09 §7.4). sample – только в ответе предпросмотра. */
export interface AudienceCounters {
  total: number;
  willReceivePush: number;
  inboxOnly: number;
  excludedMarketingOff: number;
  excludedFrequency: number;
  excludedInactive: number;
  criticalService: number;
  computedAt: string;
}
export interface AudiencePreviewDto extends AudienceCounters {
  sample: Array<{ clientId: string; displayName: string }>;
}

export interface CampaignDto {
  id: string;
  status: CampaignStatus;
  purpose: string | null;
  category: CampaignCategory;
  title: string;
  body: string;
  url: string | null;
  push: boolean;
  audience: Audience;
  areaType: 'network' | 'city' | 'branch';
  areaIds: string[];
  plannedAt: string | null;
  advertiserNote: string | null;
  erid: string | null;
  templateId: string | null;
  previewSnapshot: AudienceCounters | null;
  previewAt: string | null;
  total: number | null;
  createdBy: string;
  createdAt: string;
  confirmedBy: string | null;
  confirmedAt: string | null;
  cancelledReason: string | null;
  rowVersion: number;
}
export interface CampaignCounters { sent: number; inboxOnly: number; excluded: number; error: number }
export type CampaignListRow = CampaignDto & { counters: CampaignCounters };
export interface TimelineEvent { id: string; at: string; action: string; objectType: string; objectId: string | null; actorType: string; actorId: string | null; actorRole: string | null; before: unknown; after: unknown; reason: string | null; result: string }
export type CampaignDetail = CampaignListRow & { timeline: TimelineEvent[] };

export interface NotificationView {
  id: string;
  clientId: string;
  branchId: string | null;
  category: RowCategory;
  kind: string;
  bookingId: string | null;
  source: 'system' | 'staff';
  initiatorId: string | null;
  title: string;
  body: string;
  url: string | null;
  plannedAt: string;
  sentAt: string | null;
  status: RowStatus;
  skipReason: string | null;
  error: string | null;
  attempts: number;
  campaignId: string | null;
  retryOf: string | null;
  purpose: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface TemplateDto { id: string; name: string; category: CampaignCategory; title: string; body: string; status: 'active' | 'archived'; rowVersion: number }

export interface ClientNotificationSummary {
  marketing: { enabled: boolean; changedAt: string | null; source: string | null };
  reminders: { enabled: boolean; changedAt: string | null };
  push: { activeDevices: number };
  recent: NotificationView[];
}

export interface Page<T> { items: T[]; nextCursor: string | null }

/** Белый список плейсхолдеров K21 §8 (templates.ts PLACEHOLDERS). */
export const PLACEHOLDERS = ['client.firstName', 'branch.name', 'branch.address', 'city.name'] as const;

export const CATEGORY_LABEL: Record<RowCategory, string> = { service: 'Сервисное', reminder: 'Напоминание', marketing: 'Реклама' };
export const SOURCE_LABEL: Record<'system' | 'staff', string> = { system: 'Система', staff: 'Сотрудник' };
export const CAMPAIGN_STATUS: Record<CampaignStatus, string> = {
  draft: 'Черновик', confirmed: 'Подтверждена', expanding: 'Готовится к отправке', sending: 'Отправляется', done: 'Завершена', cancelled: 'Отменена',
};
export const CAMPAIGN_BADGE: Record<CampaignStatus, string> = {
  draft: 'preparing', confirmed: 'preparing', expanding: 'preparing', sending: 'temporarily_closed', done: 'active', cancelled: 'archived',
};
/** 09 §9: «Отправлено провайдеру» ≠ «Доставлено»; delivered без подтверждения провайдера сервер не ставит. */
export const ROW_STATUS: Record<RowStatus, string> = {
  planned: 'Запланировано', queued: 'В очереди', sending: 'Отправляется', sent_to_provider: 'Отправлено провайдеру', delivered: 'Доставлено',
  error: 'Ошибка', cancelled: 'Отменено', skipped_by_prefs: 'Пропущено по настройкам клиента', skipped_booking_changed: 'Пропущено: запись изменена',
  no_channel: 'Нет доступного канала', skipped_by_frequency: 'Пропущено: частота рекламы', inbox_only: 'Только в центре уведомлений',
};
export const ROW_BADGE: Partial<Record<RowStatus, string>> = {
  sent_to_provider: 'active', delivered: 'active', error: 'temporarily_closed', no_channel: 'temporarily_closed', planned: 'preparing', queued: 'preparing', sending: 'preparing',
};
export const KIND_LABEL: Record<string, string> = {
  booking_confirmed: 'Запись подтверждена', booking_cancelled: 'Запись отменена', booking_rescheduled: 'Запись перенесена',
  reminder_day_before: 'Напоминание за день', reminder_before_start: 'Напоминание перед сеансом', personal: 'Личное сообщение',
  campaign: 'Рассылка', event_cancelled: 'Мероприятие отменено', event_rescheduled: 'Мероприятие перенесено', account_event: 'Событие аккаунта',
};
export const DIRECTION_LABEL: Record<'pc' | 'vr' | 'ps', string> = { pc: 'ПК', vr: 'VR', ps: 'PlayStation' };

/** Повторить можно только сервисное с ошибкой или без канала (K21 §9, journal.ts RETRY_NOT_ALLOWED). */
export const canRetryRow = (n: NotificationView) => n.category === 'service' && (n.status === 'error' || n.status === 'no_channel');

export function fmtAt(v: string | null, timezone: string): string {
  if (!v) return '–';
  return new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short', timeZone: timezone }).format(new Date(v));
}

/** Начало локальных суток YYYY-MM-DD в зоне timezone → ISO со смещением (фильтр периода «по зоне филиала»). */
export function zonedDayStart(day: string, timezone: string): string {
  const guess = Date.parse(`${day}T00:00:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(guess));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const local = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  return new Date(guess - (local - guess)).toISOString();
}

export function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Аудитория словами (K21 §9: «описание сегмента словами»). */
export function describeAudience(a: Audience, names: { branch: (id: string) => string; city: (id: string) => string }): string {
  if (a.kind === 'client') return a.bookingId ? 'Один клиент по записи' : 'Один клиент';
  if (a.kind === 'booking') return 'Клиент записи';
  const s = a.segment;
  const area = 'network' in s.area ? 'вся сеть' : 'cityIds' in s.area ? s.area.cityIds.map(names.city).join(', ') : s.area.branchIds.map(names.branch).join(', ');
  const parts = [`Клиенты: ${area}`];
  if (s.visitedBetween) parts.push(`были с ${ru(s.visitedBetween.from)} по ${ru(s.visitedBetween.to)}`);
  if (s.notVisitedSince) parts.push(`не были с ${ru(s.notVisitedSince)}`);
  if (s.minVisits) parts.push(`посещений от ${s.minVisits}`);
  if (s.hasUpcomingBooking !== undefined) parts.push(s.hasUpcomingBooking ? 'есть будущая запись' : 'нет будущей записи');
  if (s.resourceTypes?.length) parts.push(`направления: ${s.resourceTypes.map((t) => DIRECTION_LABEL[t]).join(', ')}`);
  if (s.registeredBetween) parts.push(`регистрация с ${ru(s.registeredBetween.from)} по ${ru(s.registeredBetween.to)}`);
  return parts.join('; ');
}
const ru = (d: string) => d.split('-').reverse().join('.');

/** Ошибки API уведомлений – словами для сотрудника (K21 §12). */
export function notificationError(e: unknown): string {
  if (!(e instanceof ApiError)) return 'Не получилось. Повторите попытку.';
  const map: Record<string, string> = {
    CATEGORY_REQUIRED: 'Выберите категорию сообщения, а для личного – укажите назначение.',
    SERVICE_NEEDS_SUBJECT: 'Сервисное сообщение отправляется только по записи клиента – укажите запись.',
    SEGMENT_SERVICE_FORBIDDEN: 'Сервисное сообщение нельзя отправить группе клиентов.',
    SEGMENT_INVALID: 'Условия аудитории заданы неверно – проверьте даты и область.',
    AUDIENCE_EMPTY: 'В аудитории никого нет – отправлять некому.',
    CAMPAIGN_NOT_EDITABLE: 'Сообщение уже подтверждено или отменено – изменить его нельзя.',
    CAMPAIGN_ALREADY_FINISHED: 'Рассылка уже завершена.',
    PLANNED_AT_OUT_OF_RANGE: `Время отправки – не раньше текущего и не позже чем через ${String(e.details?.maxDays ?? 30)} дней.`,
    TEMPLATE_PLACEHOLDER_UNKNOWN: `В тексте неизвестная подстановка. Можно: ${PLACEHOLDERS.map((p) => `{${p}}`).join(', ')}.`,
    RETRY_NOT_ALLOWED: 'Повторить можно только сервисное сообщение с ошибкой или без канала.',
    MARKETING_ERID_REQUIRED: 'Для рекламы нужен идентификатор erid.',
    MARKETING_NOT_CONFIGURED: 'Рассылка рекламы не настроена на сервере: нет ключа отписки. Обратитесь к Владельцу.',
    VERSION_CONFLICT: 'Сообщение уже изменили. Обновите страницу.',
    FORBIDDEN: 'Недостаточно прав для этого действия.',
    NOT_FOUND: 'Не найдено или вне вашей зоны.',
    VALIDATION_FAILED: 'Проверьте поля формы.',
  };
  return map[e.code] ?? e.message;
}

// Мок уведомлений CRM строго по apps/api/src/modules/notifications/routes.crm.ts, campaigns.ts, journal.ts, templates.ts, segments.ts
// (K21 §5–§12, K11 №201–212): порядок проверок как в API – ключ идемпотентности → id → тело (Zod) → категория и текст → роль → аудитория
// → плановая дата. Чужое – 404, роль – 403; двойное подтверждение – expectedTotal, иначе 409 AUDIENCE_CHANGED с новым числом.
// Отличия от API (данные мока): id филиалов и сотрудников засева – не UUID (b-nsk-krasny, s-owner), поэтому branchId, authorId и
// области сегмента проверяются по справочнику мока, а не форматом; из условий сегмента выборку сужает только область; кампания
// после подтверждения сразу разворачивается в строки (без pg-boss). Сброс – вместе с POST /__test/reset (хук onRequest).
// S4-80 (11.11): имена авторов (authorName, confirmedByName, actorName) – из сотрудников мока, всем с notifications.view;
// №208 campaignId; №251 GET /notifications/failures/summary – как journal.ts failuresSummary.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { bookingFacts } from './mock-booking.ts';
import { registerStaffFeed } from './mock-staff-feed.ts';
import type {
  Audience, AudiencePreviewDto, CampaignCategory, CampaignDetail, CampaignDto, CampaignListRow, ClientNotificationSummary, FailuresSummary, NotificationView, SegmentV1, TemplateDto, TimelineEvent,
} from '../src/lib/notifications.ts';

type Rec = Record<string, unknown>;
type Role = 'owner' | 'director' | 'admin';
interface Staffish { id: string; role: string }
interface BranchLite { id: string; cityId: string; name: string }
interface ClientLite { id: string; status: string; firstName: string | null; lastName: string | null; links: string[] }
export interface NotificationsMockDeps {
  current: (req: FastifyRequest) => Staffish;
  zone: (s: Staffish) => { network: boolean; cityIds: string[]; branchIds: string[] };
  can: (s: Staffish, action: string) => boolean;
  branches: () => BranchLite[];
  clients: () => ClientLite[];
  /** Сотрудники мока – имена авторов (staff/index.ts getStaffNames). */
  staff: () => Array<{ id: string; firstName: string; lastName: string }>;
  /** Добавить действия K21 §10 в /me мока (как EQUIPMENT_ACTIONS). */
  grant: (role: Role, actions: string[]) => void;
}

/** K21 §10 / core/permissions.ts: notifications.view у всех ролей уже есть в моке. */
export const NOTIFICATION_ACTIONS: Record<Role, string[]> = {
  owner: ['notifications.send.service', 'notifications.send.marketing', 'notifications.send.mass', 'notifications.retry', 'notifications.templates.manage'],
  director: ['notifications.send.service', 'notifications.send.marketing', 'notifications.send.mass', 'notifications.retry'],
  admin: ['notifications.send.service'],
};

class Fail extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Rec;
  constructor(status: number, code: string, message: string, details?: Rec) {
    super(message);
    this.status = status;
    this.code = code;
    if (details) this.details = details;
  }
}
const notFound = () => new Fail(404, 'NOT_FOUND', 'Не найдено');
const forbidden = (action: string) => new Fail(403, 'FORBIDDEN', 'Недостаточно прав', { action });
const zod = (issues: Array<{ path: string; message: string }>) => new Fail(400, 'VALIDATION_FAILED', 'Неверные данные запроса', { issues });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const URL_PATH = /^\/([^/\\]|$)/;
const FREQ_MS = 168 * 3600_000; // notifications.marketing_min_interval_hours
const MAX_PLAN_DAYS = 30; // notifications.campaign_max_plan_days
const REQUIRE_ERID = true; // notifications.marketing_require_erid
const PLACEHOLDERS = new Set(['client.firstName', 'branch.name', 'branch.address', 'city.name']);
const iso = (ms: number) => new Date(ms).toISOString();

// ---- Zod-разбор (routes.crm.ts): тот же состав полей и пределы; лишние ключи тела отбрасываются, у аудитории – strict.

type Check = (v: unknown, path: string, out: Array<{ path: string; message: string }>) => unknown;
const opt = (c: Check, nullable = false): Check => (v, p, o) => (v === undefined || (nullable && v === null) ? v : c(v, p, o));
const str = (min: number, max: number, trim = true): Check => (v, p, o) => {
  if (typeof v !== 'string') return o.push({ path: p, message: 'Invalid input: expected string' }), undefined;
  const s = trim ? v.trim() : v;
  if (s.length < min || s.length > max) o.push({ path: p, message: s.length < min ? 'Too small' : 'Too big' });
  return s;
};
const re = (rx: RegExp, max = 512): Check => (v, p, o) => (typeof v === 'string' && rx.test(v) && v.length <= max ? v : (o.push({ path: p, message: 'Invalid string' }), undefined));
const oneOf = (...xs: string[]): Check => (v, p, o) => (typeof v === 'string' && xs.includes(v) ? v : (o.push({ path: p, message: 'Invalid option' }), undefined));
const bool: Check = (v, p, o) => (typeof v === 'boolean' ? v : (o.push({ path: p, message: 'Invalid input: expected boolean' }), undefined));
const int = (min: number, max = Number.MAX_SAFE_INTEGER, coerce = false): Check => (v, p, o) => {
  const n = coerce && typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max ? n : (o.push({ path: p, message: 'Invalid number' }), undefined);
};
/** Филиал/сотрудник: в API – z.uuid(); в моке id засева не UUID – принимаем UUID или известный id. */
const ref = (known: () => string[]): Check => (v, p, o) => (typeof v === 'string' && (UUID.test(v) || known().includes(v)) ? v : (o.push({ path: p, message: 'Invalid UUID' }), undefined));

function shape(schema: Record<string, Check>, value: unknown, prefix = ''): { data: Rec; issues: Array<{ path: string; message: string }> } {
  const issues: Array<{ path: string; message: string }> = [];
  const src = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Rec;
  if (!(value && typeof value === 'object' && !Array.isArray(value))) issues.push({ path: prefix, message: 'Invalid input: expected object' });
  const data: Rec = {};
  for (const [k, c] of Object.entries(schema)) {
    const v = c(src[k], prefix ? `${prefix}.${k}` : k, issues);
    if (v !== undefined) data[k] = v;
  }
  return { data, issues };
}
function parse(schema: Record<string, Check>, value: unknown): Rec {
  const r = shape(schema, value ?? {});
  if (r.issues.length) throw zod(r.issues);
  return r.data;
}

const segmentV1 = (branches: () => string[], cities: () => string[]): Check => (v, p, o) => {
  const src = (v && typeof v === 'object' ? v : {}) as Rec;
  const range = opt((x, pp, oo) => {
    const r = shape({ from: re(LOCAL_DATE), to: re(LOCAL_DATE) }, x, pp);
    oo.push(...r.issues);
    if (!r.issues.length && String(r.data.from) > String(r.data.to)) oo.push({ path: pp, message: 'from позже to' });
    return r.data;
  });
  const area: Check = (x, pp, oo) => {
    const a = (x && typeof x === 'object' ? x : {}) as Rec;
    const keys = Object.keys(a);
    const list = (known: () => string[]) => (y: unknown) => Array.isArray(y) && y.length >= 1 && y.length <= 200 && y.every((id) => typeof id === 'string' && (UUID.test(id) || known().includes(id)));
    if (keys.length === 1 && a.network === true) return { network: true };
    if (keys.length === 1 && list(cities)(a.cityIds)) return { cityIds: a.cityIds };
    if (keys.length === 1 && list(branches)(a.branchIds)) return { branchIds: a.branchIds };
    oo.push({ path: pp, message: 'Invalid input' });
    return undefined;
  };
  const schema: Record<string, Check> = {
    v: (x, pp, oo) => (x === 1 ? 1 : (oo.push({ path: pp, message: 'Invalid input: expected 1' }), undefined)),
    area, visitedBetween: range, notVisitedSince: opt(re(LOCAL_DATE)), minVisits: opt(int(1, 1000)), hasUpcomingBooking: opt(bool),
    resourceTypes: opt((x, pp, oo) => (Array.isArray(x) && x.length >= 1 && x.length <= 3 && x.every((t) => ['pc', 'vr', 'ps'].includes(t as string)) ? x : (oo.push({ path: pp, message: 'Invalid input' }), undefined))),
    registeredBetween: range,
  };
  const r = shape(schema, v, p);
  for (const k of Object.keys(src)) if (!(k in schema)) r.issues.push({ path: p ? `${p}.${k}` : k, message: 'Unrecognized key' });
  o.push(...r.issues);
  return r.data;
};

// ---- состояние

interface Campaign extends CampaignDto { recipients: Array<{ clientId: string; decision: string }> }
interface Prefs { marketing: boolean; marketingAt: string | null; marketingSource: string | null; reminders: boolean; remindersAt: string | null; devices: number }

const C = (n: number) => `c0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const K = 'b-nsk-krasny';
const BK1 = 'b0000000-0000-4000-8000-000000000001';
export const CAMPAIGN_IDS = { krasnyAd: 'a0000000-0000-4000-8000-000000000001', personal: 'a0000000-0000-4000-8000-000000000002', network: 'a0000000-0000-4000-8000-000000000003', tomskDraft: 'a0000000-0000-4000-8000-000000000004', cancelled: 'a0000000-0000-4000-8000-000000000005' };
export const ROW_IDS = { noChannel: 'd0000000-0000-4000-8000-000000000003', tomskError: 'd0000000-0000-4000-8000-000000000006', networkAd: 'd0000000-0000-4000-8000-000000000007', personalError: 'd0000000-0000-4000-8000-000000000008' };
export const TEMPLATE_IDS = { rules: 'f0000000-0000-4000-8000-000000000001', promo: 'f0000000-0000-4000-8000-000000000002' };

let campaigns: Campaign[] = [];
let rows: NotificationView[] = [];
let templates: TemplateDto[] = [];
let prefs = new Map<string, Prefs>();
let timeline: TimelineEvent[] = [];
let replays = new Map<string, { hash: string; status: number; body: unknown }>();
let extraAudience: Array<{ clientId: string; branchId: string }> = [];

function row(n: number, v: Partial<NotificationView> & Pick<NotificationView, 'clientId' | 'category' | 'kind' | 'status' | 'plannedAt'>): NotificationView {
  const sent = v.status === 'sent_to_provider';
  return {
    id: `d0000000-0000-4000-8000-${String(n).padStart(12, '0')}`, branchId: K, bookingId: null, source: 'system', initiatorId: null, authorName: null, title: 'Запись подтверждена', body: 'Ждём вас в клубе.',
    url: null, sentAt: sent ? v.plannedAt : null, skipReason: null, error: null, attempts: sent ? 1 : 0, campaignId: null, retryOf: null, purpose: null, readAt: null, createdAt: v.plannedAt, ...v,
  };
}

function campaign(id: string, v: Partial<Campaign> & Pick<Campaign, 'category' | 'title' | 'body' | 'audience' | 'areaType' | 'areaIds' | 'createdBy' | 'createdAt' | 'status'>): Campaign {
  return {
    id, purpose: null, url: null, push: true, plannedAt: null, advertiserNote: null, erid: null, templateId: null, previewSnapshot: null, previewAt: null, total: null,
    confirmedBy: v.status === 'draft' ? null : v.createdBy, confirmedAt: v.status === 'draft' ? null : v.createdAt, cancelledReason: null, rowVersion: v.status === 'draft' ? 1 : 2, recipients: [], ...v,
  };
}

export function resetNotifications(): void {
  const ad = { category: 'marketing' as const, title: 'Реклама. Скидка 20% в будни', body: 'Приходите днём в будни – скидка 20% на ПК.', erid: 'Kra23abcD' };
  campaigns = [
    campaign(CAMPAIGN_IDS.krasnyAd, { ...ad, audience: { kind: 'segment', segment: { v: 1, area: { branchIds: [K] }, notVisitedSince: '2026-10-01' } }, areaType: 'branch', areaIds: [K], createdBy: 's-director', createdAt: '2026-10-20T03:00:00.000Z', status: 'done', total: 3, recipients: [{ clientId: C(1), decision: 'ok' }, { clientId: C(2), decision: 'marketing_off' }, { clientId: C(4), decision: 'client_inactive' }] }),
    campaign(CAMPAIGN_IDS.personal, { category: 'service', purpose: 'Перенос комнаты', title: 'Комната изменилась', body: 'Ваша запись перенесена в соседнюю комнату.', audience: { kind: 'client', clientId: C(1), bookingId: BK1 }, areaType: 'branch', areaIds: [K], createdBy: 's-admin', createdAt: '2026-11-09T05:00:00.000Z', status: 'done', total: 1, recipients: [{ clientId: C(1), decision: 'ok' }] }),
    campaign(CAMPAIGN_IDS.network, { ...ad, title: 'Реклама. Новые VR-игры', body: 'Во всех клубах сети – новые игры VR.', audience: { kind: 'segment', segment: { v: 1, area: { network: true } } }, areaType: 'network', areaIds: [], createdBy: 's-owner', createdAt: '2026-10-10T04:00:00.000Z', status: 'done', total: 4 }),
    campaign(CAMPAIGN_IDS.tomskDraft, { ...ad, title: 'Реклама. Турнир в Томске', body: 'Регистрация на турнир открыта.', audience: { kind: 'segment', segment: { v: 1, area: { branchIds: ['b-tsk-lenina'] } } }, areaType: 'branch', areaIds: ['b-tsk-lenina'], createdBy: 's-owner', createdAt: '2026-11-10T04:00:00.000Z', status: 'draft' }),
    campaign(CAMPAIGN_IDS.cancelled, { ...ad, title: 'Реклама. Ночной марафон', body: 'Ночь игр по специальной цене.', audience: { kind: 'segment', segment: { v: 1, area: { branchIds: [K] } } }, areaType: 'branch', areaIds: [K], createdBy: 's-director', createdAt: '2026-11-05T04:00:00.000Z', status: 'cancelled', total: 3, cancelledReason: 'Марафон перенесли' }),
  ];
  rows = [
    row(1, { clientId: C(1), category: 'service', kind: 'booking_confirmed', bookingId: BK1, status: 'sent_to_provider', plannedAt: '2026-11-09T02:00:00.000Z' }),
    row(2, { clientId: C(1), category: 'reminder', kind: 'reminder_day_before', bookingId: BK1, title: 'Завтра у вас сеанс', status: 'sent_to_provider', plannedAt: '2026-11-10T14:00:00.000Z' }),
    row(3, { clientId: C(2), category: 'service', kind: 'booking_confirmed', status: 'no_channel', skipReason: 'no_subscription', plannedAt: '2026-11-10T06:00:00.000Z' }),
    row(4, { clientId: C(1), category: 'marketing', kind: 'campaign', source: 'staff', initiatorId: 's-director', campaignId: CAMPAIGN_IDS.krasnyAd, title: ad.title, body: ad.body, status: 'sent_to_provider', plannedAt: '2026-10-20T04:00:00.000Z' }),
    row(6, { clientId: C(3), branchId: 'b-tsk-lenina', category: 'service', kind: 'booking_cancelled', title: 'Запись отменена', status: 'error', error: 'push: 500', attempts: 3, plannedAt: '2026-11-08T05:00:00.000Z' }),
    row(7, { clientId: C(1), branchId: null, category: 'marketing', kind: 'campaign', source: 'staff', initiatorId: 's-owner', campaignId: CAMPAIGN_IDS.network, title: 'Реклама. Новые VR-игры', status: 'sent_to_provider', plannedAt: '2026-10-10T05:00:00.000Z' }),
    row(8, { clientId: C(1), category: 'service', kind: 'personal', source: 'staff', initiatorId: 's-admin', campaignId: CAMPAIGN_IDS.personal, bookingId: BK1, purpose: 'Перенос комнаты', title: 'Комната изменилась', body: 'Ваша запись перенесена в соседнюю комнату.', status: 'error', error: 'push: 410', attempts: 3, plannedAt: '2026-11-09T05:01:00.000Z' }),
  ];
  templates = [
    { id: TEMPLATE_IDS.rules, name: 'Правила клуба', category: 'service', title: 'Важно перед визитом', body: '{client.firstName}, напоминаем правила клуба {branch.name}.', status: 'active', rowVersion: 1 },
    { id: TEMPLATE_IDS.promo, name: 'Будни со скидкой', category: 'marketing', title: 'Реклама. Скидка в будни', body: 'В {branch.name} днём в будни дешевле.', status: 'active', rowVersion: 1 },
  ];
  prefs = new Map([
    [C(1), { marketing: true, marketingAt: '2026-10-01T05:00:00.000Z', marketingSource: 'site', reminders: true, remindersAt: '2026-10-05T07:30:00.000Z', devices: 2 }],
    [C(2), { marketing: false, marketingAt: null, marketingSource: null, reminders: false, remindersAt: '2026-10-16T03:00:00.000Z', devices: 0 }],
    [C(3), { marketing: true, marketingAt: '2026-08-01T05:00:00.000Z', marketingSource: 'account', reminders: true, remindersAt: null, devices: 1 }],
  ]);
  timeline = campaigns.flatMap((c) => [
    ev(c.id, 'notification.campaign_created', c.createdAt, c.createdBy, { category: c.category, audienceKind: c.audience.kind, areaType: c.areaType }),
    ...(c.confirmedAt ? [ev(c.id, 'notification.campaign_confirmed', c.confirmedAt, c.createdBy, { category: c.category, total: c.total })] : []),
  ]);
  replays = new Map();
  extraAudience = [];
}

function ev(objectId: string, action: string, at: string, actorId: string, after: unknown, reason: string | null = null, objectType = 'notification_campaign'): TimelineEvent {
  return { id: String(timeline.length + 1000 + Math.floor(Math.random() * 1e6)), at, action, objectType, objectId, actorType: 'staff', actorId, actorRole: null, before: null, after, reason, result: 'success', actorName: null };
}

export function registerNotifications(app: FastifyInstance, P: string, d: NotificationsMockDeps): void {
  for (const r of Object.keys(NOTIFICATION_ACTIONS) as Role[]) d.grant(r, NOTIFICATION_ACTIONS[r]);
  resetNotifications();
  registerStaffFeed(app, P, d); // лента событий CRM (S4-28) – тот же модуль notifications
  app.addHook('onRequest', async (req) => {
    if (req.method === 'POST' && req.url === '/__test/reset') resetNotifications();
  });
  /** Для теста AUDIENCE_CHANGED: в аудиторию филиала добавляется клиент между предпросмотром и подтверждением. */
  app.post('/__test/notifications/audience-grow', async (req) => {
    const b = (req.body ?? {}) as { branchId?: string };
    extraAudience.push({ clientId: randomUUID(), branchId: b.branchId ?? K });
    return { ok: true };
  });

  const branchIds = () => d.branches().map((b) => b.id);
  /** getStaffNames: «Имя Фамилия»; неизвестный id – «Сотрудник» (journal.ts). */
  const staffName = (id: string) => {
    const x = d.staff().find((y) => y.id === id);
    return x ? `${x.firstName} ${x.lastName}` : 'Сотрудник';
  };
  const named = (r: NotificationView): NotificationView => ({ ...r, authorName: r.initiatorId ? staffName(r.initiatorId) : null });
  const cityIds = () => [...new Set(d.branches().map((b) => b.cityId))];
  const inZone = (s: Staffish, branchId: string) => d.zone(s).network || d.zone(s).branchIds.includes(branchId);
  const campaignInZone = (s: Staffish, c: Pick<Campaign, 'areaType' | 'areaIds'>) => {
    const z = d.zone(s);
    if (z.network) return true;
    if (c.areaType === 'network') return false;
    if (c.areaType === 'city') return c.areaIds.every((x) => z.cityIds.includes(x));
    return c.areaIds.every((x) => z.branchIds.includes(x));
  };
  const load = (s: Staffish, id: string) => {
    const c = UUID.test(id) ? campaigns.find((x) => x.id === id.toLowerCase()) : undefined;
    if (!c || !campaignInZone(s, c)) throw notFound();
    return c;
  };
  const idOf = (req: FastifyRequest) => {
    const id = (req.params as { id?: string }).id ?? '';
    if (!UUID.test(id)) throw notFound();
    return id.toLowerCase();
  };
  const key = (req: FastifyRequest) => {
    const v = req.headers['idempotency-key'];
    const k = Array.isArray(v) ? v[0] : v;
    if (k === undefined || k.trim() === '') throw new Fail(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Нужен заголовок Idempotency-Key');
    if (!UUID.test(k.trim())) throw new Fail(400, 'VALIDATION_FAILED', 'Idempotency-Key должен быть UUID', { field: 'Idempotency-Key' });
    return k.trim().toLowerCase();
  };
  /** runIdempotent: тот же ключ и тело – прежний ответ с заголовком idempotent-replay; другое тело – 409 IDEMPOTENCY_KEY_REUSED. */
  const idem = (reply: FastifyReply, s: Staffish, route: string, k: string, request: unknown, fn: () => { status: number; body: unknown }) => {
    const scope = `staff:${s.id}:${route}:${k}`;
    const hash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const prev = replays.get(scope);
    if (prev) {
      if (prev.hash !== hash) throw new Fail(409, 'IDEMPOTENCY_KEY_REUSED', 'Этот ключ уже использован для другого запроса');
      reply.header('idempotent-replay', 'true');
      return reply.code(prev.status).send(prev.body);
    }
    const r = fn();
    replays.set(scope, { hash, ...r });
    return reply.code(r.status).send(r.body);
  };
  const handle = (fn: (req: FastifyRequest, reply: FastifyReply, s: Staffish) => unknown) => async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      return await fn(req, reply, d.current(req));
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      return reply.code(e.status).send({ error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}), requestId: randomUUID() } });
    }
  };

  // ---- курсор (journal.ts encodeCursor/decodeCursor): base64url JSON [at, id]
  const enc = (at: string, id: string) => Buffer.from(JSON.stringify([at, id])).toString('base64url');
  const dec = (s: string) => {
    try {
      const [at, id] = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as [string, string];
      if (Number.isNaN(Date.parse(at)) || !UUID.test(id)) throw new Error('cursor');
      return { at, id };
    } catch {
      throw new Fail(400, 'VALIDATION_FAILED', 'Неверный курсор', { field: 'cursor' });
    }
  };
  function pageOf<T extends { id: string }>(all: T[], at: (x: T) => string, cursor: string | undefined, limit: number | undefined) {
    const n = Math.min(Math.max(Math.trunc(limit ?? 50), 1), 100);
    const sorted = [...all].sort((a, b) => (at(a) === at(b) ? (a.id < b.id ? 1 : -1) : at(a) < at(b) ? 1 : -1));
    const cur = cursor ? dec(cursor) : null;
    const after = cur ? sorted.filter((x) => at(x) < cur.at || (at(x) === cur.at && x.id < cur.id)) : sorted;
    const items = after.slice(0, n);
    const last = items.at(-1);
    return { items, nextCursor: after.length > n && last ? enc(at(last), last.id) : null };
  }

  const page = { cursor: opt(str(0, 512, false)), limit: opt(int(1, 100, true)) };
  const when = opt(re(ISO_OFFSET));
  const counters = (c: Campaign) => {
    const own = rows.filter((r) => r.campaignId === c.id && r.retryOf === null);
    const n = (...st: string[]) => own.filter((r) => st.includes(r.status)).length;
    const sent = n('sent_to_provider');
    const inboxOnly = n('no_channel', 'inbox_only');
    const error = n('error');
    return { sent, inboxOnly, error, excluded: Math.max(0, (c.total ?? 0) - sent - inboxOnly - error - n('planned', 'queued', 'sending')) };
  };
  const dto = (c: Campaign): CampaignDto => {
    const { recipients: _r, ...rest } = c;
    void _r;
    return rest;
  };
  const listRow = (c: Campaign): CampaignListRow => ({ ...dto(c), counters: counters(c), authorName: staffName(c.createdBy), confirmedByName: c.confirmedBy ? staffName(c.confirmedBy) : null });

  // №201
  app.get(`${P}/notifications/campaigns`, handle(async (req, _reply, s) => {
    const q = parse({ from: when, to: when, branchId: opt(ref(branchIds)), category: opt(oneOf('service', 'marketing')), source: opt(oneOf('system', 'staff')), authorId: opt(ref(() => [s.id, 's-owner', 's-director', 's-admin', 's-admin-tsk', 's-two', 's-fresh'])), status: opt(oneOf('draft', 'confirmed', 'expanding', 'sending', 'done', 'cancelled')), clientId: opt(re(UUID)), ...page }, req.query);
    if (q.branchId && !inZone(s, String(q.branchId))) throw notFound();
    if (!d.can(s, 'notifications.view') || q.source === 'system') return { items: [], nextCursor: null };
    const all = campaigns.filter((c) => campaignInZone(s, c)
      && (!q.from || Date.parse(c.createdAt) >= Date.parse(String(q.from))) && (!q.to || Date.parse(c.createdAt) < Date.parse(String(q.to)))
      && (!q.branchId || c.areaIds.includes(String(q.branchId))) && (!q.category || c.category === q.category) && (!q.authorId || c.createdBy === q.authorId)
      && (!q.status || c.status === q.status) && (!q.clientId || c.recipients.some((r) => r.clientId === String(q.clientId).toLowerCase())));
    const p = pageOf(all, (c) => c.createdAt, q.cursor as string | undefined, q.limit as number | undefined);
    return { items: p.items.map(listRow), nextCursor: p.nextCursor };
  }));

  // ---- проверки кампании (campaigns.ts)
  const segmentCheck = segmentV1(branchIds, cityIds);
  const audienceCheck: Check = (v, p, o) => {
    const a = (v && typeof v === 'object' ? v : {}) as Rec;
    const strict = (schema: Record<string, Check>) => {
      const r = shape(schema, a, p);
      for (const k of Object.keys(a)) if (!(k in schema)) r.issues.push({ path: `${p}.${k}`, message: 'Unrecognized key' });
      o.push(...r.issues);
      return r.data;
    };
    if (a.kind === 'client') return strict({ kind: oneOf('client'), clientId: re(UUID), bookingId: opt(re(UUID)), branchId: opt(ref(branchIds)) });
    if (a.kind === 'booking') return strict({ kind: oneOf('booking'), bookingId: re(UUID) });
    if (a.kind === 'segment') return { kind: 'segment', segment: a.segment }; // segment: z.unknown() – разбирает модуль
    o.push({ path: p, message: 'Invalid input' });
    return undefined;
  };
  const text = {
    purpose: opt(str(0, 200)), title: opt(str(1, 120)), body: opt(str(1, 500)), url: opt(re(URL_PATH, 500), true), plannedAt: opt(re(ISO_OFFSET), true),
    push: opt(bool), advertiserNote: opt(str(0, 200), true), erid: opt(str(1, 64), true),
  };
  function validateText(t: { category?: unknown; title?: unknown; body?: unknown; purpose?: unknown }, audience: Audience) {
    if (!t.category) throw new Fail(422, 'CATEGORY_REQUIRED', 'Укажите категорию сообщения');
    if (audience.kind !== 'segment' && !String(t.purpose ?? '').trim()) throw new Fail(422, 'CATEGORY_REQUIRED', 'Укажите назначение личного сообщения', { field: 'purpose' });
    if (!String(t.title ?? '').trim() || !String(t.body ?? '').trim()) throw new Fail(400, 'VALIDATION_FAILED', 'Нужны заголовок и текст', { fields: ['title', 'body'] });
    assertPlaceholders(String(t.title), String(t.body));
  }
  function assertSendRole(s: Staffish, category: CampaignCategory, audience: Audience) {
    const action = category === 'marketing' ? 'notifications.send.marketing' : 'notifications.send.service';
    if (!d.can(s, action)) throw forbidden(action);
    if (audience.kind === 'segment' && !d.can(s, 'notifications.send.mass')) throw forbidden('notifications.send.mass');
  }
  function parseSegment(v: unknown): SegmentV1 {
    const issues: Array<{ path: string; message: string }> = [];
    const r = segmentCheck(v, '', issues) as SegmentV1;
    if (issues.length) throw new Fail(422, 'SEGMENT_INVALID', 'Сегмент задан неверно', { issues });
    return r;
  }
  function resolveArea(s: Staffish, area: SegmentV1['area']) {
    const z = d.zone(s);
    if ('network' in area) {
      if (!z.network) throw forbidden('notifications.send.mass');
      return { type: 'network' as const, ids: [], branchIds: branchIds() };
    }
    if ('cityIds' in area) {
      const cities = [...new Set(area.cityIds)].sort();
      if (!z.network && cities.some((c) => !z.cityIds.includes(c))) throw notFound();
      const bs = d.branches().filter((b) => cities.includes(b.cityId)).map((b) => b.id);
      if (!bs.length) throw new Fail(422, 'SEGMENT_INVALID', 'В области нет филиалов', { issues: [{ path: 'area', message: 'empty' }] });
      return { type: 'city' as const, ids: cities, branchIds: bs };
    }
    const bs = [...new Set(area.branchIds)].sort();
    if (!z.network && bs.some((b) => !z.branchIds.includes(b))) throw notFound();
    if (bs.some((b) => !branchIds().includes(b))) throw notFound();
    return { type: 'branch' as const, ids: bs, branchIds: bs };
  }
  function resolveAudience(s: Staffish, category: CampaignCategory, audience: Audience) {
    if (audience.kind === 'segment') {
      if (category === 'service') throw new Fail(422, 'SEGMENT_SERVICE_FORBIDDEN', 'Сервисное сообщение нельзя отправить на сегмент');
      return { area: resolveArea(s, parseSegment(audience.segment).area), clientId: null };
    }
    const bookingId = audience.bookingId;
    if (bookingId) {
      const b = bookingFacts(bookingId);
      if (!b || !inZone(s, b.branchId)) throw notFound();
      if (audience.kind === 'client' && audience.clientId !== b.clientId) throw notFound();
      return { area: { type: 'branch' as const, ids: [b.branchId], branchIds: [b.branchId] }, clientId: b.clientId };
    }
    if (audience.kind !== 'client') throw notFound();
    if (category === 'service') throw new Fail(422, 'SERVICE_NEEDS_SUBJECT', 'Сервисное сообщение – только с привязкой к записи клиента');
    const c = d.clients().find((x) => x.id === audience.clientId && x.status !== 'anonymized');
    if (!c) throw notFound();
    if (!audience.branchId) {
      if (!d.zone(s).network) throw notFound();
      return { area: { type: 'network' as const, ids: [], branchIds: branchIds() }, clientId: c.id };
    }
    if (!inZone(s, audience.branchId) || !c.links.includes(audience.branchId)) throw notFound();
    return { area: { type: 'branch' as const, ids: [audience.branchId], branchIds: [audience.branchId] }, clientId: c.id };
  }
  function plannedAt(v: unknown): string | null {
    if (!v) return null;
    const at = Date.parse(String(v));
    if (Number.isNaN(at) || at < Date.now() || at > Date.now() + MAX_PLAN_DAYS * 86_400_000) throw new Fail(422, 'PLANNED_AT_OUT_OF_RANGE', 'Плановая дата вне допустимого диапазона', { maxDays: MAX_PLAN_DAYS });
    return iso(at);
  }

  /** decideSend (index.ts) для мока: неактивный, отказ от рекламы, частота 168 ч, подписка. Клиент из audience-grow – новый, без подписки. */
  function decide(clientId: string, category: CampaignCategory, push: boolean): string {
    const c = d.clients().find((x) => x.id === clientId);
    if (!c && extraAudience.some((x) => x.clientId === clientId)) return category === 'marketing' ? 'marketing_off' : 'no_channel';
    if (!c || ['blocked', 'anonymized', 'deletion_requested'].includes(c.status)) return 'client_inactive';
    const p = prefs.get(clientId);
    if (category === 'marketing') {
      if (!p?.marketing) return 'marketing_off';
      if (rows.some((r) => r.clientId === clientId && r.category === 'marketing' && r.sentAt && Date.now() - Date.parse(r.sentAt) < FREQ_MS)) return 'min_interval';
    }
    return push && (p?.devices ?? 0) > 0 ? 'ok' : 'no_channel';
  }
  function recipients(c: Campaign, area: { branchIds: string[] }, clientId: string | null) {
    if (clientId) return [{ clientId, decision: decide(clientId, c.category, c.push) }];
    const ids = [...d.clients().filter((x) => x.links.some((b) => area.branchIds.includes(b))).map((x) => x.id), ...extraAudience.filter((x) => area.branchIds.includes(x.branchId)).map((x) => x.clientId)];
    return [...new Set(ids)].map((id) => ({ clientId: id, decision: decide(id, c.category, c.push) }));
  }
  function preview(s: Staffish, c: Campaign, list: Array<{ clientId: string; decision: string }>): AudiencePreviewDto {
    const n = (...x: string[]) => list.filter((r) => x.includes(r.decision)).length;
    const passes = n('ok', 'no_channel');
    const full = d.can(s, 'client.view.full');
    const name = (id: string) => {
      const x = d.clients().find((y) => y.id === id);
      if (full) return [x?.firstName, x?.lastName].filter(Boolean).join(' ') || 'Без имени';
      return x?.firstName ? `${x.firstName.slice(0, 1)}***` : 'Без имени';
    };
    return {
      total: list.length, willReceivePush: c.push ? n('ok') : 0, inboxOnly: c.push ? n('no_channel') : passes, excludedMarketingOff: n('marketing_off'), excludedFrequency: n('min_interval'),
      excludedInactive: n('client_inactive'), criticalService: c.category === 'service' ? passes : 0,
      sample: c.audience.kind === 'segment' ? list.filter((r) => r.decision === 'ok' || r.decision === 'no_channel').slice(0, 10).map((r) => ({ clientId: r.clientId, displayName: name(r.clientId) })) : [],
      computedAt: iso(Date.now()),
    };
  }

  // №202
  app.post(`${P}/notifications/campaigns`, handle(async (req, reply, s) => {
    const k = key(req);
    const body = parse({ category: opt(oneOf('service', 'marketing')), templateId: opt(re(UUID)), audience: audienceCheck, ...text }, req.body);
    return idem(reply, s, 'POST /api/crm/v1/notifications/campaigns', k, body, () => {
      const tpl = body.templateId ? templates.find((t) => t.id === String(body.templateId).toLowerCase() && t.status === 'active') : null;
      if (body.templateId && !tpl) throw new Fail(404, 'NOT_FOUND', 'Шаблон не найден');
      const audience = body.audience as Audience;
      const t = { category: (body.category ?? tpl?.category) as CampaignCategory, title: body.title ?? tpl?.title, body: body.body ?? tpl?.body, purpose: body.purpose };
      validateText(t, audience);
      assertSendRole(s, t.category, audience);
      const a = resolveAudience(s, t.category, audience);
      const at = plannedAt(body.plannedAt);
      const now = iso(Date.now());
      const c = campaign(randomUUID(), {
        purpose: (t.purpose as string | undefined) || null, category: t.category, title: String(t.title), body: String(t.body), url: (body.url as string | null | undefined) ?? null, push: (body.push as boolean | undefined) ?? true,
        audience, areaType: a.area.type, areaIds: a.area.ids, plannedAt: at, advertiserNote: (body.advertiserNote as string | null | undefined) ?? null, erid: (body.erid as string | null | undefined) ?? null,
        templateId: (body.templateId as string | undefined) ?? null, createdBy: s.id, createdAt: now, status: 'draft',
      });
      campaigns.push(c);
      timeline.push(ev(c.id, 'notification.campaign_created', now, s.id, { category: c.category, audienceKind: audience.kind, areaType: c.areaType }));
      return { status: 201, body: dto(c) };
    });
  }));

  // №203
  app.get(`${P}/notifications/campaigns/:id`, handle(async (req, _reply, s): Promise<CampaignDetail> => {
    const c = load(s, idOf(req));
    return { ...listRow(c), timeline: timeline.filter((e) => e.objectId === c.id).sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 100).map((e) => ({ ...e, actorName: e.actorId ? staffName(e.actorId) : null })) };
  }));

  // №204 – без Idempotency-Key, повтор останавливает rowVersion
  app.patch(`${P}/notifications/campaigns/:id`, handle(async (req, _reply, s) => {
    const id = idOf(req);
    const body = parse({ rowVersion: int(1), category: opt(oneOf('service', 'marketing')), audience: opt(audienceCheck), ...text }, req.body);
    const c = load(s, id);
    if (c.status !== 'draft') throw new Fail(409, 'CAMPAIGN_NOT_EDITABLE', 'Править можно только черновик');
    if (c.rowVersion !== body.rowVersion) throw new Fail(409, 'VERSION_CONFLICT', 'Кампания уже изменена', { rowVersion: c.rowVersion });
    const audience = (body.audience as Audience | undefined) ?? c.audience;
    const t = { category: (body.category ?? c.category) as CampaignCategory, title: body.title ?? c.title, body: body.body ?? c.body, purpose: body.purpose ?? c.purpose ?? undefined };
    validateText(t, audience);
    assertSendRole(s, t.category, audience);
    const a = resolveAudience(s, t.category, audience);
    const at = body.plannedAt === undefined ? c.plannedAt : plannedAt(body.plannedAt);
    Object.assign(c, {
      purpose: (t.purpose as string | undefined) ?? null, category: t.category, title: String(t.title), body: String(t.body), url: body.url === undefined ? c.url : body.url, push: (body.push as boolean | undefined) ?? c.push,
      audience, areaType: a.area.type, areaIds: a.area.ids, plannedAt: at, advertiserNote: body.advertiserNote === undefined ? c.advertiserNote : body.advertiserNote,
      erid: body.erid === undefined ? c.erid : body.erid, previewSnapshot: null, previewAt: null, rowVersion: c.rowVersion + 1,
    });
    timeline.push(ev(c.id, 'notification.campaign_updated', iso(Date.now()), s.id, { category: c.category, audienceKind: audience.kind }));
    return dto(c);
  }));

  // №205 – чтение по контракту, без ключа; снимок счётчиков запоминается в черновике
  app.post(`${P}/notifications/campaigns/:id/preview`, handle(async (req, _reply, s) => {
    const c = load(s, idOf(req));
    assertSendRole(s, c.category, c.audience);
    if (c.status !== 'draft') throw new Fail(409, 'CAMPAIGN_NOT_EDITABLE', 'Предпросмотр доступен только для черновика');
    const a = resolveAudience(s, c.category, c.audience);
    const p = preview(s, c, recipients(c, a.area, a.clientId));
    const { sample: _s, ...snapshot } = p;
    void _s;
    c.previewSnapshot = snapshot;
    c.previewAt = p.computedAt;
    return p;
  }));

  // №206
  app.post(`${P}/notifications/campaigns/:id/confirm`, handle(async (req, reply, s) => {
    const k = key(req);
    const id = idOf(req);
    const body = parse({ rowVersion: int(1), expectedTotal: opt(int(0)) }, req.body);
    return idem(reply, s, 'POST /api/crm/v1/notifications/campaigns/:id/confirm', k, { id, body }, () => {
      const c = load(s, id);
      assertSendRole(s, c.category, c.audience);
      if (c.status !== 'draft') throw new Fail(409, 'CAMPAIGN_NOT_EDITABLE', 'Кампания уже подтверждена или отменена');
      if (c.rowVersion !== body.rowVersion) throw new Fail(409, 'VERSION_CONFLICT', 'Кампания уже изменена', { rowVersion: c.rowVersion });
      if (c.category === 'marketing' && REQUIRE_ERID && !c.erid) throw new Fail(422, 'MARKETING_ERID_REQUIRED', 'Для рекламы нужен идентификатор erid');
      const a = resolveAudience(s, c.category, c.audience);
      const list = recipients(c, a.area, a.clientId);
      if (list.length === 0) throw new Fail(422, 'AUDIENCE_EMPTY', 'В аудитории никого нет');
      if ((c.audience.kind === 'segment' || list.length > 1) && body.expectedTotal !== list.length) throw new Fail(409, 'AUDIENCE_CHANGED', 'Аудитория изменилась, проверьте число получателей', { total: list.length });
      const now = iso(Date.now());
      Object.assign(c, { status: c.plannedAt ? 'confirmed' : 'done', confirmedBy: s.id, confirmedAt: now, total: list.length, rowVersion: c.rowVersion + 1, recipients: list });
      // Разворачивание (campaign-runner.ts) – сразу: строки только у прошедших решение; без плановой даты «ушло провайдеру» или «нет канала».
      for (const r of list.filter((x) => x.decision === 'ok' || x.decision === 'no_channel')) {
        const sent = !c.plannedAt && r.decision === 'ok';
        rows.push({
          id: randomUUID(), clientId: r.clientId, branchId: c.areaType === 'branch' ? (c.areaIds[0] ?? null) : null, category: c.category, kind: c.audience.kind === 'segment' ? 'campaign' : 'personal',
          bookingId: c.audience.kind === 'segment' ? null : (c.audience.bookingId ?? null), source: 'staff', initiatorId: s.id, authorName: null, title: c.title, body: c.body, url: c.url, plannedAt: c.plannedAt ?? now,
          sentAt: sent ? now : null, status: c.plannedAt ? 'planned' : sent ? 'sent_to_provider' : c.category === 'marketing' ? 'inbox_only' : 'no_channel', skipReason: null, error: null, attempts: sent ? 1 : 0,
          campaignId: c.id, retryOf: null, purpose: c.purpose, readAt: null, createdAt: now,
        });
      }
      timeline.push(ev(c.id, 'notification.campaign_confirmed', now, s.id, { category: c.category, title: c.title, body: c.body, audienceKind: c.audience.kind, areaType: c.areaType, total: list.length }));
      return { status: 200, body: dto(c) };
    });
  }));

  // №207
  app.post(`${P}/notifications/campaigns/:id/cancel`, handle(async (req, reply, s) => {
    const k = key(req);
    const id = idOf(req);
    const body = parse({ reason: str(1, 500) }, req.body);
    return idem(reply, s, 'POST /api/crm/v1/notifications/campaigns/:id/cancel', k, { id, body }, () => {
      const c = load(s, id);
      assertSendRole(s, c.category, c.audience);
      if (c.status === 'done' || c.status === 'cancelled') throw new Fail(409, 'CAMPAIGN_ALREADY_FINISHED', 'Кампания уже завершена');
      const left = rows.filter((r) => r.campaignId === c.id && (r.status === 'planned' || r.status === 'queued'));
      for (const r of left) Object.assign(r, { status: 'cancelled', skipReason: 'campaign_cancelled' });
      Object.assign(c, { status: 'cancelled', cancelledReason: body.reason, rowVersion: c.rowVersion + 1 });
      timeline.push(ev(c.id, 'notification.campaign_cancelled', iso(Date.now()), s.id, { rowsCancelled: left.length }, String(body.reason)));
      return { status: 200, body: dto(c) };
    });
  }));

  // №208
  const visibleRow = (s: Staffish, r: NotificationView) => d.can(s, 'notifications.view') && (r.branchId === null ? d.zone(s).network : inZone(s, r.branchId));
  const listRows = (s: Staffish, q: Rec) => {
    const all = rows.filter((r) => visibleRow(s, r) && (!q.clientId || r.clientId === String(q.clientId).toLowerCase()) && (!q.bookingId || r.bookingId === String(q.bookingId).toLowerCase())
      && (!q.branchId || r.branchId === q.branchId) && (!q.status || r.status === q.status) && (!q.category || r.category === q.category) && (!q.kind || r.kind === q.kind)
      && (!q.source || r.source === q.source) && (!q.campaignId || r.campaignId === String(q.campaignId).toLowerCase()) && (!q.from || Date.parse(r.plannedAt) >= Date.parse(String(q.from))) && (!q.to || Date.parse(r.plannedAt) < Date.parse(String(q.to))));
    const p = pageOf(all, (r) => r.plannedAt, q.cursor as string | undefined, q.limit as number | undefined);
    return { items: p.items.map(named), nextCursor: p.nextCursor };
  };
  app.get(`${P}/notifications`, handle(async (req, _reply, s) => {
    const q = parse({
      clientId: opt(re(UUID)), bookingId: opt(re(UUID)), branchId: opt(ref(branchIds)), status: opt(str(0, 32, false)), category: opt(oneOf('service', 'reminder', 'marketing')),
      kind: opt(str(0, 32, false)), source: opt(oneOf('system', 'staff')), campaignId: opt(re(UUID)), from: when, to: when, ...page,
    }, req.query);
    if (q.branchId && !inZone(s, String(q.branchId))) throw notFound();
    return listRows(s, q);
  }));

  // №251 – journal.ts failuresSummary: сервисные error за [now − days, now) по plannedAt в зоне, без строк с уже сделанным повтором
  app.get(`${P}/notifications/failures/summary`, handle(async (req, reply, s): Promise<FailuresSummary> => {
    const q = parse({ days: opt(int(1, 90, true)) }, req.query);
    reply.header('cache-control', 'no-store');
    const days = (q.days as number | undefined) ?? 7;
    const to = Date.now();
    const from = to - days * 86_400_000;
    const critical = rows.filter((r) => visibleRow(s, r) && r.category === 'service' && r.status === 'error' && Date.parse(r.plannedAt) >= from && Date.parse(r.plannedAt) < to
      && !rows.some((x) => x.retryOf === r.id)).length;
    return { critical, period: { from: iso(from), to: iso(to), days } };
  }));

  // №209
  app.post(`${P}/notifications/:id/retry`, handle(async (req, reply, s) => {
    const k = key(req);
    const id = idOf(req);
    const body = parse({ reason: str(1, 500) }, req.body);
    return idem(reply, s, 'POST /api/crm/v1/notifications/:id/retry', k, { id, body }, () => {
      const src = rows.find((r) => r.id === id);
      if (!src) throw notFound();
      // assertCan: сначала зона (без филиала – цель «сеть»: не-Владельцу 403), затем роль
      if (src.branchId === null ? !d.zone(s).network : !inZone(s, src.branchId)) throw src.branchId === null ? forbidden('notifications.retry') : notFound();
      if (!d.can(s, 'notifications.retry')) throw forbidden('notifications.retry');
      if (src.category !== 'service' || (src.status !== 'error' && src.status !== 'no_channel')) throw new Fail(409, 'RETRY_NOT_ALLOWED', 'Повторить можно только сервисное сообщение с ошибкой или без канала');
      const now = iso(Date.now());
      const r: NotificationView = { ...src, id: randomUUID(), source: 'staff', initiatorId: s.id, plannedAt: now, sentAt: null, status: 'planned', skipReason: null, error: null, attempts: 0, retryOf: id, readAt: null, createdAt: now };
      rows.push(r);
      timeline.push(ev(r.id, 'notification.retried', now, s.id, { retryOf: id, kind: src.kind }, String(body.reason), 'notification'));
      return { status: 201, body: named(r) };
    });
  }));

  // №210
  app.get(`${P}/notifications/templates`, handle(async (req, _reply, s) => {
    if (!d.can(s, 'notifications.view')) throw forbidden('notifications.view');
    const q = parse({ status: opt(oneOf('active', 'archived')) }, req.query);
    return { items: templates.filter((t) => !q.status || t.status === q.status).sort((a, b) => (a.name === b.name ? (a.id < b.id ? -1 : 1) : a.name < b.name ? -1 : 1)) };
  }));

  // №211 – assertCan(templates.manage, сеть): не-Владельцу 403
  const manage = (s: Staffish) => {
    if (!d.zone(s).network || !d.can(s, 'notifications.templates.manage')) throw forbidden('notifications.templates.manage');
  };
  app.post(`${P}/notifications/templates`, handle(async (req, reply, s) => {
    const k = key(req);
    const body = parse({ name: str(1, 120), category: oneOf('service', 'marketing'), title: str(1, 120), body: str(1, 500) }, req.body);
    manage(s);
    assertPlaceholders(String(body.title), String(body.body));
    return idem(reply, s, 'POST /api/crm/v1/notifications/templates', k, body, () => {
      const t: TemplateDto = { id: randomUUID(), name: String(body.name), category: body.category as CampaignCategory, title: String(body.title), body: String(body.body), status: 'active', rowVersion: 1 };
      templates.push(t);
      return { status: 201, body: t };
    });
  }));
  app.patch(`${P}/notifications/templates/:id`, handle(async (req, reply, s) => {
    const k = key(req);
    const id = idOf(req);
    const body = parse({ rowVersion: int(1), name: opt(str(1, 120)), title: opt(str(1, 120)), body: opt(str(1, 500)), status: opt(oneOf('active', 'archived')) }, req.body);
    manage(s);
    return idem(reply, s, 'PATCH /api/crm/v1/notifications/templates/:id', k, { id, body }, () => {
      const t = templates.find((x) => x.id === id);
      if (!t) throw new Fail(404, 'NOT_FOUND', 'Шаблон не найден');
      if (t.rowVersion !== body.rowVersion) throw new Fail(409, 'VERSION_CONFLICT', 'Шаблон уже изменён', { rowVersion: t.rowVersion });
      const title = (body.title as string | undefined) ?? t.title;
      const text2 = (body.body as string | undefined) ?? t.body;
      assertPlaceholders(title, text2);
      Object.assign(t, { name: (body.name as string | undefined) ?? t.name, title, body: text2, status: (body.status as TemplateDto['status'] | undefined) ?? t.status, rowVersion: t.rowVersion + 1 });
      return { status: 200, body: { ...t } };
    });
  }));

  // №212
  app.get(`${P}/clients/:clientId/notification-summary`, handle(async (req, _reply, s): Promise<ClientNotificationSummary> => {
    if (!d.can(s, 'notifications.view')) throw forbidden('notifications.view');
    if (!d.can(s, 'client.view.basic')) throw forbidden('client.view.basic');
    const id = (req.params as { clientId: string }).clientId.toLowerCase();
    if (!UUID.test(id)) throw notFound();
    const c = d.clients().find((x) => x.id === id);
    if (!c || !(d.zone(s).network || c.links.some((b) => d.zone(s).branchIds.includes(b)))) throw notFound();
    const p = prefs.get(id);
    return {
      marketing: { enabled: p?.marketing ?? false, changedAt: p?.marketingAt ?? null, source: p?.marketingSource ?? null },
      reminders: { enabled: p?.reminders ?? true, changedAt: p?.remindersAt ?? null },
      push: { activeDevices: p?.devices ?? 0 },
      recent: listRows(s, { clientId: id, limit: 20 }).items,
    };
  }));
}

/** templates.ts assertPlaceholders: неизвестная подстановка и одинокая скобка – 422. */
function assertPlaceholders(...texts: string[]): void {
  for (const t of texts) {
    const unknown = [...t.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]!).filter((p) => !PLACEHOLDERS.has(p));
    if (unknown.length > 0 || /[{}]/.test(t.replace(/\{([^{}]*)\}/g, ''))) {
      throw new Fail(422, 'TEMPLATE_PLACEHOLDER_UNKNOWN', 'В тексте неизвестный плейсхолдер', { unknown, allowed: [...PLACEHOLDERS] });
    }
  }
}

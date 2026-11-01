// Мок CRM-маршрутов брони (S1-22, S1-23) строго по apps/api/src/modules/booking/routes.crm.ts (K11 №2–12):
// календарь филиала (≤ 7 дней), список с «требует решения», бронь администратором (клиент или телефон+имя),
// карточка с хронологией и версиями, отмена, перенос, приход, завершение, неявка, исправление, служебный комментарий.
// Типы ответов – из packages/contracts/src/crm/booking.ts. Ресурсы, состав, график, блокировки – из mock-ops.ts
// (opsState): одна картина занятости; брони отдаются обратно в ops (syncOps) для списков «затронутых».
// Коды ошибок – как у сервера: SLOT_TAKEN, CLIENT_OVERLAP, RESOURCE_BLOCKED, OUTSIDE_SCHEDULE, OUTSIDE_BOOKING_WINDOW,
// INVALID_DURATION, VERSION_CONFLICT, COMMENT_REQUIRED, INVALID_STATUS_TRANSITION, RANGE_TOO_LONG, IDEMPOTENCY_KEY_REQUIRED.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { CalendarDto, CalendarItem, CrmBooking, CrmBookingRow } from '../../../packages/contracts/src/crm/booking.ts';
import { opsHoursOn, opsState } from './mock-ops.ts';

type Rec = Record<string, unknown>;
type Status = CrmBooking['status'];
interface Staffish { id: string; role: string }
interface ClientLite { id: string; status: string; firstName: string | null; lastName: string | null; phoneE164: string | null; links: string[] }
export interface BookingDeps {
  current: (req: FastifyRequest) => Staffish;
  zone: (s: Staffish) => { branchIds: string[] };
  can: (s: Staffish, action: string) => boolean;
  branches: () => Array<{ id: string; timezone: string; status: string }>;
  reasons: () => Array<Rec & { id?: unknown; domain?: unknown; name: string; code: string; archivedAt: string | null }>;
  clients: () => ClientLite[];
  /** Гость по телефону (findOrCreateGuest): есть карточка с этим телефоном – она, иначе новая guest. */
  guest: (phoneE164: string, firstName: string, lastName: string | null) => ClientLite;
  normalizePhone: (raw: string) => string | null;
  maskPhone: (e164: string | null) => string;
  fail: (reply: FastifyReply, status: number, code: string, message: string, details?: Rec) => unknown;
}

interface Version { version: number; resourceId: string; resourceName: string; start: string; end: string; priceKop: number; createdAt: string; reason: string | null; unitIds: string[] }
interface Event { id: string; at: string; action: string; actorType: string; actorId: string | null; actorRole: string | null; before: unknown; after: unknown; reason: string | null; result: string }
interface Bk {
  id: string; number: number; branchId: string; clientId: string; status: Status; source: 'site' | 'crm'; rowVersion: number; internalComment: string | null;
  cancel: CrmBooking['cancel']; visit: CrmBooking['visit']; versions: Version[]; timeline: Event[];
}

const OFFSET_MS = 7 * 3600_000; // филиалы засева – UTC+7 (как TZ_OFFSET в mock-ops)
const localDate = (ms: number) => new Date(ms + OFFSET_MS).toISOString().slice(0, 10);
const localHM = (ms: number) => new Date(ms + OFFSET_MS).toISOString().slice(11, 16);
const atLocal = (date: string, hm: string) => Date.parse(`${date}T${hm}:00+07:00`);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const iso = (ms: number) => new Date(ms).toISOString();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const STEP: Record<string, number> = { pc: 30, vr_seat: 15, room_whole: 15, ps_room: 30, composite: 15 };
const WINDOW_DAYS = 14;
const MAX_DAYS = 7;
const OCCUPYING: Status[] = ['confirmed', 'arrived', 'completed', 'no_show'];
const ACTOR_ROLE: Record<string, string> = { owner: 'owner', director: 'director', admin: 'admin' };

let store: Bk[] = [];
let nextNumber = 1001;
let replays = new Map<string, { status: number; body: unknown }>();

const cur = (b: Bk) => b.versions[b.versions.length - 1]!;
const ms = (s: string) => Date.parse(s);

/** Засев: брони mock-ops (те же id – для «затронутых») + день смены: начавшаяся, прошедшая без отметки, будущая. */
function seed(): Bk[] {
  const db = opsState();
  const now = Date.now();
  const slot = Math.floor(now / 1800_000) * 1800_000; // текущий получасовой слот
  const c = (n: number) => `c0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const today = localDate(now);
  const mk = (id: string, branchId: string, clientId: string, resourceId: string, s: number, e: number, source: 'site' | 'crm' = 'site'): Bk => {
    const r = db.resources.find((x) => x.id === resourceId)!;
    const created = iso(Math.min(now, s) - 2 * 86_400_000);
    return {
      id, number: nextNumber++, branchId, clientId, status: 'confirmed', source, rowVersion: 1, internalComment: null, cancel: null, visit: null,
      versions: [{ version: 1, resourceId, resourceName: r.name, start: iso(s), end: iso(e), priceKop: price(r.type, s, e), createdAt: created, reason: null, unitIds: [...(db.composition[resourceId] ?? [])] }],
      timeline: [{ id: randomUUID(), at: created, action: 'booking.confirmed', actorType: source === 'site' ? 'client' : 'staff', actorId: null, actorRole: null, before: null, after: { status: 'confirmed', source }, reason: null, result: 'success' }],
    };
  };
  const K = 'b-nsk-krasny';
  return [
    mk('bk-pc1-evening', K, c(1), 'res-pc1', atLocal(addDays(today, 1), '20:00'), atLocal(addDays(today, 1), '22:00')),
    mk('bk-vrroom', K, c(2), 'res-vrroom', atLocal(addDays(today, 3), '15:00'), atLocal(addDays(today, 3), '17:00')),
    mk('bk-tsk', 'b-tsk-lenina', c(3), 'res-tsk-pc1', atLocal(addDays(today, 1), '12:00'), atLocal(addDays(today, 1), '14:00')),
    // начался полчаса назад, идёт: приход или неявка
    mk('b0000000-0000-4000-8000-000000000001', K, c(1), 'res-pc2', slot - 1800_000, slot + 3600_000),
    // закончился без отметки – «требует решения» (R-08)
    mk('b0000000-0000-4000-8000-000000000002', K, c(2), 'res-vr1', slot - 3 * 3600_000, slot - 2 * 3600_000, 'crm'),
  ];
}

function price(type: string, s: number, e: number): number {
  const t = opsState().tariffs.find((x) => x.resourceType === type && x.status === 'active');
  return t ? Math.ceil((e - s) / 60_000 / t.unitMinutes) * t.pricePerUnitKop : 0;
}

/** Брони → ops (затронутые блокировкой, графиком, составом): только занимающие время. */
function syncOps(): void {
  opsState().bookings = store
    .filter((b) => OCCUPYING.includes(b.status))
    .map((b) => ({ id: b.id, branchId: b.branchId, unitIds: cur(b).unitIds, date: localDate(ms(cur(b).start)), start: localHM(ms(cur(b).start)), end: localHM(ms(cur(b).end)) }));
}

export function resetBooking(): void {
  nextNumber = 1001;
  replays = new Map();
  store = seed();
  syncOps();
}

export function registerBooking(app: FastifyInstance, P: string, d: BookingDeps): void {
  resetBooking();
  const notFound = (reply: FastifyReply) => d.fail(reply, 404, 'NOT_FOUND', 'Не найдено');
  const invalid = (reply: FastifyReply, message: string, details: Rec = {}) => d.fail(reply, 400, 'VALIDATION_FAILED', message, details);
  const seesBranch = (s: Staffish, branchId: string) => d.can(s, 'schedule.view') && d.zone(s).branchIds.includes(branchId) && d.branches().some((b) => b.id === branchId);
  const client = (id: string) => d.clients().find((c) => c.id === id);
  const nameOf = (c: ClientLite | undefined) => (c ? [c.firstName, c.lastName].filter((x) => x).join(' ') || null : null);
  const needsDecision = (b: Bk, now: number) => b.status === 'confirmed' && ms(cur(b).end) <= now;

  function row(b: Bk, now: number): CrmBookingRow {
    const c = client(b.clientId);
    const v = cur(b);
    return {
      id: b.id, number: b.number, status: b.status, resourceName: v.resourceName, start: v.start, end: v.end,
      client: { id: b.clientId, name: nameOf(c), phoneMasked: d.maskPhone(c?.phoneE164 ?? null), isGuest: c?.status === 'guest' },
      source: b.source, rowVersion: b.rowVersion, needsDecision: needsDecision(b, now),
    };
  }
  function allowed(s: Staffish, b: Bk, now: number): CrmBooking['allowedActions'] {
    const out: CrmBooking['allowedActions'] = [];
    const st = ms(cur(b).start);
    if (b.status === 'confirmed') {
      if (d.can(s, 'booking.cancel')) out.push('cancel');
      if (d.can(s, 'booking.reschedule') && st > now) out.push('reschedule');
      if (d.can(s, 'booking.visit.mark')) out.push('arrive');
      if (d.can(s, 'booking.visit.mark') && st <= now) out.push('no_show');
    }
    if (b.status === 'arrived' && d.can(s, 'booking.visit.mark')) out.push('complete');
    if ((b.status === 'arrived' || b.status === 'no_show') && d.can(s, 'booking.visit.correct')) out.push('revert_visit');
    return out;
  }
  function card(s: Staffish, b: Bk, now: number): CrmBooking {
    const v = cur(b);
    return {
      ...row(b, now), branchId: b.branchId, timezone: d.branches().find((x) => x.id === b.branchId)!.timezone, resourceId: v.resourceId,
      currentVersion: v.version, priceKop: v.priceKop, internalComment: b.internalComment, cancel: b.cancel, visit: b.visit,
      versions: b.versions.map(({ unitIds: _u, ...x }) => (void _u, x)), allowedActions: allowed(s, b, now),
    };
  }

  /** Проверки позиции (checkItem + занятость): ошибка – ответ уже отправлен, null. */
  function checkItem(reply: FastifyReply, branchId: string, body: { resourceId: string; start: string; end: string }, clientId: string | null, self: Bk | null) {
    const db = opsState();
    const r = db.resources.find((x) => x.id === body.resourceId && x.branchId === branchId && x.status !== 'archived');
    if (!r) return notFound(reply), null;
    if (r.status !== 'active') return d.fail(reply, 409, 'RESOURCE_UNAVAILABLE', 'Это место недоступно для записи', { resourceId: r.id }), null;
    const s = ms(body.start);
    const e = ms(body.end);
    const now = Date.now();
    if (!(s < e)) return d.fail(reply, 422, 'INVALID_DURATION', 'Конец раньше начала', { reason: 'empty' }), null;
    if (s <= now || localDate(s) > addDays(localDate(now), WINDOW_DAYS)) {
      return d.fail(reply, 422, 'OUTSIDE_BOOKING_WINDOW', `Запись доступна на ${WINDOW_DAYS} дней вперёд`, { maxDays: WINDOW_DAYS }), null;
    }
    const step = r.stepMinutesOverride ?? STEP[r.type] ?? 30;
    if (((s + OFFSET_MS) / 60_000) % step !== 0 || ((e - s) / 60_000) % step !== 0) {
      return d.fail(reply, 422, 'INVALID_DURATION', `Выберите время кратно ${step} минутам`, { stepMinutes: step }), null;
    }
    const branch = d.branches().find((b) => b.id === branchId)!;
    if (branch.status !== 'active') return d.fail(reply, 409, 'BRANCH_NOT_ACTIVE', 'Филиал сейчас не принимает записи'), null;
    const unitIds = db.composition[r.id] ?? [];
    const h = opsHoursOn(branchId, localDate(s), unitIds);
    const endHM = localDate(e) === localDate(s) ? localHM(e) : '24:00'; // конец ровно в полночь – «24:00» того же дня
    if (!h || localDate(e - 1) !== localDate(s) || localHM(s) < h.open || endHM > h.close) {
      return d.fail(reply, 409, 'OUTSIDE_SCHEDULE', 'В это время филиал не работает'), null;
    }
    const cross = (a: string[]) => a.some((u) => unitIds.includes(u));
    if (db.blocks.some((bl) => bl.status === 'active' && bl.branchId === branchId && cross(bl.unitIds) && ms(bl.start) < e && ms(bl.end) > s)) {
      return d.fail(reply, 409, 'RESOURCE_BLOCKED', 'Место временно недоступно'), null;
    }
    const live = store.filter((b) => b !== self && OCCUPYING.includes(b.status) && ms(cur(b).start) < e && ms(cur(b).end) > s);
    if (live.some((b) => b.branchId === branchId && cross(cur(b).unitIds))) return d.fail(reply, 409, 'SLOT_TAKEN', 'Это время уже занято'), null;
    if (clientId && live.some((b) => b.clientId === clientId && b.status === 'confirmed')) {
      return d.fail(reply, 409, 'CLIENT_OVERLAP', 'У вас уже есть запись на это время'), null;
    }
    return { r, s, e, unitIds: [...unitIds] };
  }

  const event = (s: Staffish, action: string, before: unknown, after: unknown, reason: string | null = null): Event => ({
    id: randomUUID(), at: iso(Date.now()), action, actorType: 'staff', actorId: s.id, actorRole: ACTOR_ROLE[s.role] ?? null, before, after, reason, result: 'success',
  });
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const isIso = (v: unknown) => typeof v === 'string' && /T.*(Z|[+-]\d{2}:\d{2})$/.test(v) && !Number.isNaN(Date.parse(v));
  const strict = (body: Rec, keys: string[]) => Object.keys(body).every((k) => keys.includes(k));
  const rv = (body: Rec) => Number.isInteger(body.rowVersion) && (body.rowVersion as number) >= 1;

  /** Команда: Idempotency-Key (UUID) → повтор того же ключа отдаёт сохранённый ответ; ответ – CrmBooking. */
  function command(path: string, status: number, run: (req: FastifyRequest, reply: FastifyReply, s: Staffish, body: Rec) => Bk | null | 'replied') {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      const s = d.current(req);
      const key = String(req.headers['idempotency-key'] ?? '').trim();
      if (!key) return d.fail(reply, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'Нужен заголовок Idempotency-Key');
      if (!UUID.test(key)) return invalid(reply, 'Idempotency-Key должен быть UUID', { field: 'Idempotency-Key' });
      const scope = `${s.id}:${path}:${key}`;
      const saved = replays.get(scope);
      if (saved) return reply.header('idempotent-replay', 'true').code(saved.status).send(saved.body);
      const body = (req.body ?? {}) as Rec;
      const b = run(req, reply, s, body);
      if (b === null || b === 'replied') return reply;
      syncOps();
      const out = card(s, b, Date.now());
      replays.set(scope, { status, body: out });
      return reply.code(status).send(out);
    };
  }
  /** Бронь по id в зоне (иначе 404) и право action (иначе 403). */
  function locate(req: FastifyRequest, reply: FastifyReply, s: Staffish, action: string): Bk | null {
    const b = store.find((x) => x.id === (req.params as { bookingId: string }).bookingId);
    if (!b || !seesBranch(s, b.branchId)) return notFound(reply), null;
    if (!d.can(s, action)) return d.fail(reply, 403, 'FORBIDDEN', 'Недостаточно прав', { action }), null;
    return b;
  }
  const versionConflict = (reply: FastifyReply, b: Bk) => d.fail(reply, 409, 'VERSION_CONFLICT', 'Запись уже изменили – обновите карточку', { current: b.rowVersion });
  const transition = (reply: FastifyReply, from: Status, to: string, message = 'Это действие недоступно для записи в текущем статусе', extra: Rec = {}) =>
    d.fail(reply, 409, 'INVALID_STATUS_TRANSITION', message, { from, to, ...extra });
  const commentRequired = (reply: FastifyReply, field: string) => d.fail(reply, 422, 'COMMENT_REQUIRED', 'Укажите комментарий', { field });

  // ---- чтение

  app.get(`${P}/branches/:branchId/calendar`, async (req, reply) => {
    const s = d.current(req);
    const { branchId } = req.params as { branchId: string };
    const q = req.query as { from?: string; to?: string; resourceIds?: string };
    if (!DATE.test(q.from ?? '') || !DATE.test(q.to ?? '')) return invalid(reply, 'Неверные данные запроса', { issues: [{ path: 'from', message: 'Неверная дата' }] });
    if (!seesBranch(s, branchId)) return notFound(reply);
    const from = q.from!;
    const to = q.to!;
    if (to < from) return invalid(reply, 'Конец периода раньше начала', { field: 'to' });
    if (addDays(from, MAX_DAYS - 1) < to) return d.fail(reply, 422, 'RANGE_TOO_LONG', `Период не длиннее ${MAX_DAYS} дней`, { maxDays: MAX_DAYS });
    const filter = q.resourceIds ? new Set(q.resourceIds.split(',').filter((x) => x !== '')) : null;
    const db = opsState();
    const branch = d.branches().find((b) => b.id === branchId)!;
    const rooms = new Map(db.rooms.map((r) => [r.id, r.name]));
    const resources = db.resources
      .filter((r) => r.branchId === branchId && r.status !== 'archived' && (!filter || filter.has(r.id)))
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    const start = atLocal(from, '00:00');
    const end = atLocal(addDays(to, 1), '00:00');
    const resourcesOf = (unitIds: string[]) => resources.filter((r) => (db.composition[r.id] ?? []).some((u) => unitIds.includes(u))).map((r) => r.id);
    const now = Date.now();
    const items: CalendarItem[] = [];
    for (const b of store.filter((x) => x.branchId === branchId && !x.status.startsWith('cancelled') && ms(cur(x).start) < end && ms(cur(x).end) > start)
      .sort((a, b2) => ms(cur(a).start) - ms(cur(b2).start) || a.number - b2.number)) {
      const r = row(b, now);
      items.push({ kind: 'booking', id: b.id, resourceIds: resourcesOf(cur(b).unitIds), start: r.start, end: r.end,
        booking: { number: b.number, status: b.status, clientName: r.client.name, phoneMasked: r.client.phoneMasked, needsDecision: r.needsDecision } });
    }
    for (const bl of db.blocks.filter((x) => x.branchId === branchId && x.status === 'active' && ms(x.start) < end && ms(x.end) > start)) {
      const reasonName = d.reasons().find((r) => r.id === bl.reasonId)?.name ?? 'Блокировка';
      items.push({ kind: 'block', id: bl.id, resourceIds: resourcesOf(bl.unitIds), start: bl.start, end: bl.end, block: { reasonName } });
    }
    const openIntervals = [];
    for (let day = from; day <= to; day = addDays(day, 1)) {
      const h = opsHoursOn(branchId, day, []);
      if (h) openIntervals.push({ start: iso(atLocal(day, h.open)), end: iso(h.close === '24:00' ? atLocal(addDays(day, 1), '00:00') : atLocal(day, h.close)) });
    }
    const dto: CalendarDto = {
      branchId, timezone: branch.timezone, from, to, openIntervals,
      resources: resources.map((r) => ({ id: r.id, name: r.name, type: r.type, roomName: r.roomId ? (rooms.get(r.roomId) ?? null) : null })),
      items: items.filter((i) => !filter || i.resourceIds.length > 0),
    };
    return dto;
  });

  app.get(`${P}/branches/:branchId/bookings`, async (req, reply) => {
    const s = d.current(req);
    const { branchId } = req.params as { branchId: string };
    const q = req.query as { date?: string; status?: string; needsDecision?: string; cursor?: string; limit?: string };
    const limit = q.limit === undefined ? 50 : Number(q.limit);
    if ((q.date !== undefined && !DATE.test(q.date)) || (q.needsDecision !== undefined && !['true', 'false'].includes(q.needsDecision)) || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      return invalid(reply, 'Неверные данные запроса', { issues: [{ path: 'query', message: 'Неверные данные запроса' }] });
    }
    if (!seesBranch(s, branchId)) return notFound(reply);
    const statuses = (q.status ?? '').split(',').filter((x) => x !== '');
    let after: [number, number] | null = null;
    if (q.cursor) {
      try {
        const c = JSON.parse(Buffer.from(q.cursor, 'base64url').toString('utf8')) as unknown;
        if (!Array.isArray(c) || typeof c[0] !== 'string' || typeof c[1] !== 'number' || Number.isNaN(Date.parse(c[0]))) throw new Error('cursor');
        after = [Date.parse(c[0]), c[1]];
      } catch {
        return invalid(reply, 'Неверный курсор', { field: 'cursor' });
      }
    }
    const now = Date.now();
    const dayS = q.date ? atLocal(q.date, '00:00') : -Infinity;
    const dayE = q.date ? atLocal(addDays(q.date, 1), '00:00') : Infinity;
    const all = store
      .filter((b) => b.branchId === branchId && ms(cur(b).start) < dayE && ms(cur(b).end) > dayS)
      .filter((b) => !statuses.length || statuses.includes(b.status))
      .filter((b) => q.needsDecision !== 'true' || needsDecision(b, now))
      .sort((a, b) => ms(cur(a).start) - ms(cur(b).start) || a.number - b.number)
      .filter((b) => !after || ms(cur(b).start) > after[0] || (ms(cur(b).start) === after[0] && b.number > after[1]));
    const page = all.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((b) => row(b, now)),
      nextCursor: all.length > limit && last ? Buffer.from(JSON.stringify([cur(last).start, last.number])).toString('base64url') : null,
    };
  });

  app.get(`${P}/bookings/:bookingId`, async (req, reply) => {
    const s = d.current(req);
    const b = store.find((x) => x.id === (req.params as { bookingId: string }).bookingId);
    if (!b || !seesBranch(s, b.branchId)) return notFound(reply);
    return { ...card(s, b, Date.now()), timeline: [...b.timeline].reverse() };
  });

  // ---- команды

  app.post(`${P}/branches/:branchId/bookings`, command('create', 201, (req, reply, s, body) => {
    const { branchId } = req.params as { branchId: string };
    const c = body.client as Rec | undefined;
    const guest = c && typeof c === 'object' && !('clientId' in c);
    const bad = !strict(body, ['resourceId', 'start', 'end', 'client', 'internalComment']) || typeof body.resourceId !== 'string' || !isIso(body.start) || !isIso(body.end) || !c ||
      (guest ? !strict(c, ['phone', 'firstName', 'lastName']) || text(c.phone).length < 5 || !text(c.firstName) : !strict(c, ['clientId']) || typeof c.clientId !== 'string');
    if (bad) return invalid(reply, 'Неверные данные запроса', { issues: [{ path: 'body', message: 'Неверные данные запроса' }] }), null;
    if (!seesBranch(s, branchId)) return notFound(reply), null;
    if (!d.can(s, 'booking.create')) return d.fail(reply, 403, 'FORBIDDEN', 'Недостаточно прав', { action: 'booking.create' }), null;
    let cl: ClientLite | undefined;
    if (guest) {
      const phone = d.normalizePhone(text(c.phone));
      if (!phone) return invalid(reply, 'Неверный номер телефона', { field: 'client.phone' }), null;
      cl = d.clients().find((x) => x.phoneE164 === phone);
    } else {
      cl = client(String(c.clientId));
      if (!cl) return notFound(reply), null;
    }
    if (cl && ['blocked', 'restricted', 'anonymized', 'deletion_requested'].includes(cl.status)) {
      return d.fail(reply, 403, 'CLIENT_RESTRICTED', 'Запись для этого клиента ограничена', { status: cl.status }), null;
    }
    const item = checkItem(reply, branchId, body as { resourceId: string; start: string; end: string }, cl?.id ?? null, null);
    if (!item) return null;
    if (!cl) cl = d.guest(d.normalizePhone(text(c.phone))!, text(c.firstName), text(c.lastName) || null);
    if (!cl.links.includes(branchId)) cl.links.push(branchId);
    const now = iso(Date.now());
    const b: Bk = {
      id: randomUUID(), number: nextNumber++, branchId, clientId: cl.id, status: 'confirmed', source: 'crm', rowVersion: 1,
      internalComment: text(body.internalComment) || null, cancel: null, visit: null,
      versions: [{ version: 1, resourceId: item.r.id, resourceName: item.r.name, start: iso(item.s), end: iso(item.e), priceKop: price(item.r.type, item.s, item.e), createdAt: now, reason: null, unitIds: item.unitIds }],
      timeline: [],
    };
    b.timeline.push(event(s, 'booking.created', null, { clientId: cl.id, resourceId: item.r.id, start: iso(item.s), end: iso(item.e), priceKop: cur(b).priceKop, source: 'crm' }));
    store.push(b);
    return b;
  }));

  app.post(`${P}/bookings/:bookingId/cancel`, command('cancel', 200, (req, reply, s, body) => {
    if (!strict(body, ['rowVersion', 'initiator', 'reasonId', 'comment']) || !rv(body) || !['club', 'client_by_phone'].includes(String(body.initiator)) || typeof body.reasonId !== 'string' || typeof body.comment !== 'string') {
      return invalid(reply, 'Неверные данные запроса', { issues: [{ path: 'body', message: 'Неверные данные запроса' }] }), null;
    }
    const b = locate(req, reply, s, 'booking.cancel');
    if (!b) return null;
    if (body.rowVersion !== b.rowVersion) return versionConflict(reply, b), null;
    const comment = text(body.comment);
    if (!comment) return commentRequired(reply, 'comment'), null;
    const to: Status = body.initiator === 'club' ? 'cancelled_by_club' : 'cancelled_by_client';
    if (b.status !== 'confirmed') return transition(reply, b.status, to), null;
    const domain = body.initiator === 'club' ? 'booking_cancel_club' : 'booking_cancel_client';
    const reason = d.reasons().find((r) => r.id === body.reasonId && r.domain === domain && !r.archivedAt);
    if (!reason) return invalid(reply, 'Причина не найдена', { field: 'reasonId' }), null;
    const before = b.status;
    Object.assign(b, { status: to, rowVersion: b.rowVersion + 1, cancel: { at: iso(Date.now()), by: 'сотрудник', reasonName: reason.name, comment } });
    b.timeline.push(event(s, 'booking.cancelled', { status: before }, { status: to, reasonCode: reason.code, comment }, comment));
    return b;
  }));

  app.post(`${P}/bookings/:bookingId/reschedule`, command('reschedule', 200, (req, reply, s, body) => {
    if (!strict(body, ['rowVersion', 'resourceId', 'start', 'end', 'reason']) || !rv(body) || typeof body.resourceId !== 'string' || !isIso(body.start) || !isIso(body.end) || typeof body.reason !== 'string') {
      return invalid(reply, 'Неверные данные запроса', { issues: [{ path: 'body', message: 'Неверные данные запроса' }] }), null;
    }
    const b = locate(req, reply, s, 'booking.reschedule');
    if (!b) return null;
    if (body.rowVersion !== b.rowVersion) return versionConflict(reply, b), null;
    const reason = text(body.reason);
    if (!reason) return commentRequired(reply, 'reason'), null;
    if (b.status !== 'confirmed') return transition(reply, b.status, 'rescheduled', 'Перенести можно только подтверждённую запись'), null;
    const v = cur(b);
    if (v.resourceId === body.resourceId && ms(v.start) === ms(String(body.start)) && ms(v.end) === ms(String(body.end))) return b;
    const item = checkItem(reply, b.branchId, body as { resourceId: string; start: string; end: string }, b.clientId, b);
    if (!item) return null;
    const next: Version = { version: v.version + 1, resourceId: item.r.id, resourceName: item.r.name, start: iso(item.s), end: iso(item.e), priceKop: price(item.r.type, item.s, item.e), createdAt: iso(Date.now()), reason, unitIds: item.unitIds };
    b.versions.push(next);
    b.rowVersion += 1;
    b.timeline.push(event(s, 'booking.rescheduled', { version: v.version, resourceId: v.resourceId, start: v.start, end: v.end },
      { version: next.version, resourceId: next.resourceId, resourceName: next.resourceName, start: next.start, end: next.end, priceKop: next.priceKop }, reason));
    return b;
  }));

  const visitCommand = (op: string, perm: string, to: Status, apply: (reply: FastifyReply, s: Staffish, b: Bk, body: Rec) => boolean, keys: string[] = ['rowVersion']) =>
    command(op, 200, (req, reply, s, body) => {
      if (!strict(body, keys) || !rv(body)) return invalid(reply, 'Неверные данные запроса', { issues: [{ path: 'body', message: 'Неверные данные запроса' }] }), null;
      const b = locate(req, reply, s, perm);
      if (!b) return null;
      if (body.rowVersion !== b.rowVersion) return versionConflict(reply, b), null;
      if (!apply(reply, s, b, body)) return null;
      b.status = to;
      b.rowVersion += 1;
      return b;
    });

  app.post(`${P}/bookings/:bookingId/arrive`, visitCommand('arrive', 'booking.visit.mark', 'arrived', (reply, s, b) => {
    if (b.status !== 'confirmed') return transition(reply, b.status, 'arrived'), false;
    b.visit = { arrivedAt: iso(Date.now()), completedAt: null };
    b.timeline.push(event(s, 'visit.confirmed', { status: b.status }, { status: 'arrived', visitId: randomUUID() }));
    return true;
  }));
  app.post(`${P}/bookings/:bookingId/complete`, visitCommand('complete', 'booking.visit.mark', 'completed', (reply, s, b) => {
    if (b.status !== 'arrived') return transition(reply, b.status, 'completed'), false;
    b.visit = { arrivedAt: b.visit!.arrivedAt, completedAt: iso(Math.max(Date.now(), ms(b.visit!.arrivedAt))) };
    b.timeline.push(event(s, 'visit.completed', { status: b.status }, { status: 'completed' }));
    return true;
  }));
  app.post(`${P}/bookings/:bookingId/no-show`, visitCommand('no_show', 'booking.visit.mark', 'no_show', (reply, s, b, body) => {
    if (b.status !== 'confirmed') return transition(reply, b.status, 'no_show'), false;
    if (ms(cur(b).start) > Date.now()) return transition(reply, b.status, 'no_show', 'Неявку можно отметить только после начала сеанса', { reason: 'not_started' }), false;
    const reason = body.reasonId === undefined ? null : d.reasons().find((r) => r.id === body.reasonId && r.domain === 'no_show' && !r.archivedAt);
    if (reason === undefined) return invalid(reply, 'Причина не найдена', { field: 'reasonId' }), false;
    b.timeline.push(event(s, 'no_show.marked', { status: b.status }, { status: 'no_show', noShowId: randomUUID(), reasonCode: reason?.code ?? null }));
    return true;
  }, ['rowVersion', 'reasonId']));
  app.post(`${P}/bookings/:bookingId/revert-visit`, command('revert_visit', 200, (req, reply, s, body) => {
    if (!strict(body, ['rowVersion', 'reason']) || !rv(body) || typeof body.reason !== 'string') return invalid(reply, 'Неверные данные запроса', { issues: [{ path: 'body', message: 'Неверные данные запроса' }] }), null;
    const reason = text(body.reason);
    if (!reason) return commentRequired(reply, 'reason'), null;
    const b = locate(req, reply, s, 'booking.visit.correct');
    if (!b) return null;
    if (body.rowVersion !== b.rowVersion) return versionConflict(reply, b), null;
    if (b.status !== 'arrived' && b.status !== 'no_show') return transition(reply, b.status, 'confirmed'), null;
    const kind = b.status === 'no_show' ? 'no_show' : 'visit';
    b.timeline.push(event(s, `${kind}.reverted`, { status: b.status }, { status: 'confirmed' }, reason));
    Object.assign(b, { status: 'confirmed', visit: null, rowVersion: b.rowVersion + 1 });
    return b;
  }));
  app.patch(`${P}/bookings/:bookingId`, command('update', 200, (req, reply, s, body) => {
    if (!strict(body, ['rowVersion', 'internalComment']) || !rv(body) || !(body.internalComment === null || typeof body.internalComment === 'string')) {
      return invalid(reply, 'Неверные данные запроса', { issues: [{ path: 'body', message: 'Неверные данные запроса' }] }), null;
    }
    const b = locate(req, reply, s, 'booking.create');
    if (!b) return null;
    if (body.rowVersion !== b.rowVersion) return versionConflict(reply, b), null;
    const comment = text(body.internalComment) || null;
    b.timeline.push(event(s, 'booking.updated', { internalComment: b.internalComment }, { internalComment: comment }));
    Object.assign(b, { internalComment: comment, rowVersion: b.rowVersion + 1 });
    return b;
  }));
}


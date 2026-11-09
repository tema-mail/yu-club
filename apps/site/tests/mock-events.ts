// Мок мероприятий и подарка имениннику для e2e сайта (Э3: S3-90…S3-93) – точно по apps/api/src/modules/events/routes.public.ts
// (П3 /me/events, П4 /event-requests, П5 /party-info) и routes.gifts.ts (П1 /me/gifts, /me/gifts/{id}/slots, П2 /me/gifts/{id}/hold).
// П4: согласие – до всего остального (CONSENT_REQUIRED), потом поля, филиал, комната, дата, гости, телефон, лимит 5 заявок с номера в сутки;
// повтор с тем же Idempotency-Key – тот же ответ. Заявка – мероприятие birthday_party в new_request, source = 'site' (/__test/event-requests).
// П1: только свои, без отменённых; issued с прошедшим сроком – сразу «expired». Окна: проверки дня (срок, будни, праздник) – здесь, занятость
// обоих шлемов – в mock-api.ts (giftWindows); удержание – обычное K5 (giftHold): подарок «reserved», пока удержание живо или стало бронью.
// Клиенты: Алина – действующий, истёкший и отменённый подарки, мероприятия всех статусов; Пётр – свой подарок и мероприятие (Алине не видны).
// Только для e2e: POST /__test/events-reset, /__test/party-config { maxGuests?, minMinutes?, noRoom? }, GET /__test/event-requests.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';

const DAY = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORMATS = ['h2', 'h3plus', 'full_day'] as const;
/** Снимок условий на выдаче (gifts.ts GiftTerms). */
const TERMS = { devices: 2, device: 'Meta Quest 3S', minutesEach: 30, roomMinutes: 40, weekdays: [1, 2, 3, 4, 5], excludesHolidays: true, notIncluded: ['PS4', 'PS VR', 'food'] };

interface Branch { id: string; name: string; timezone: string; active: boolean; hasRoom: boolean }
export interface EventsDeps {
  /** Клиент сессии по куке (yu_client) – id и телефон. */
  sessionClient: (cookie: string | undefined) => { id: string; phone: string } | null;
  branches: () => Branch[];
  giftWindows: (branchId: string, date: string, minutes: number) => { closedReason: string | null; slots: Array<{ start: string; end: string }> };
  giftHold: (clientId: string, branchId: string, start: string, minutes: number) => { id: string };
  holdState: (holdId: string) => { state: 'live' | 'converted' | 'dead'; bookingId: string | null };
  fail: (reply: FastifyReply, status: number, code: string, message: string) => unknown;
}

const localDate = (t: number, tz = 'Asia/Novosibirsk') => new Date(t + (tz === 'Asia/Omsk' ? 6 : 7) * 3600_000).toISOString().slice(0, 10);
const plusDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const weekday = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay() || 7;
const at = (d: string, hhmm: string) => new Date(Date.parse(`${d}T${hhmm}:00Z`) - 7 * 3600_000).toISOString();

/** Праздник календаря сети (K20 §9) в моке – ближайший понедельник не раньше чем послезавтра: GIFT_HOLIDAY без привязки к дате прогона. */
export function mockHoliday(now = Date.now()): string {
  let d = plusDays(localDate(now), 2);
  while (weekday(d) !== 1) d = plusDays(d, 1);
  return d;
}

type GiftStatus = 'issued' | 'reserved' | 'used' | 'expired' | 'cancelled';
interface Gift { id: string; number: string; phone: string; issuedOn: string; validUntil: string; status: GiftStatus; holdId: string | null; bookingId: string | null }
interface Ev { id: string; number: string; phone: string; title: string; status: string; startDays: number | null; hours: number; branch: 'krasny' | 'lenina'; lines: Array<{ name: string; quantity: number; unit: string; planCostKop: number }> }

let gifts: Gift[] = [];
let requests: Array<Record<string, unknown>> = [];
let requestNo = 500;
const replies = new Map<string, { status: number; body: unknown }>();
const party = { maxGuests: 10, minMinutes: 120, noRoom: null as string | null };

function seed() {
  const today = localDate(Date.now());
  gifts = [
    { id: randomUUID(), number: 'GF-000101', phone: '+79131234567', issuedOn: plusDays(today, -10), validUntil: plusDays(today, 50), status: 'issued', holdId: null, bookingId: null },
    { id: randomUUID(), number: 'GF-000042', phone: '+79131234567', issuedOn: plusDays(today, -400), validUntil: plusDays(today, -340), status: 'expired', holdId: null, bookingId: null },
    { id: randomUUID(), number: 'GF-000013', phone: '+79131234567', issuedOn: plusDays(today, -500), validUntil: plusDays(today, -440), status: 'cancelled', holdId: null, bookingId: null },
    { id: randomUUID(), number: 'GF-000150', phone: '+79135550000', issuedOn: plusDays(today, -3), validUntil: plusDays(today, 57), status: 'issued', holdId: null, bookingId: null },
  ];
  requests = [];
  replies.clear();
  Object.assign(party, { maxGuests: 10, minMinutes: 120, noRoom: null });
}
seed();

// Себестоимость (planCostKop) лежит в данных, но наружу не отдаётся – как в API (П3 без цен и себестоимости).
const EVENTS: Ev[] = [
  { id: randomUUID(), number: 'EV-000201', phone: '+79131234567', title: 'День рождения', status: 'confirmed', startDays: 5, hours: 2, branch: 'krasny', lines: [
    { name: 'Аренда комнаты VR+PS4', quantity: 2, unit: 'ч', planCostKop: 150_000 },
    { name: 'Праздничный стол', quantity: 1, unit: 'шт', planCostKop: 400_000 },
  ] },
  { id: randomUUID(), number: 'EV-000187', phone: '+79131234567', title: 'Выпускной в VR', status: 'completed', startDays: -30, hours: 3, branch: 'lenina', lines: [{ name: 'Аренда комнаты VR+PS4', quantity: 3, unit: 'ч', planCostKop: 200_000 }] },
  { id: randomUUID(), number: 'EV-000210', phone: '+79131234567', title: 'Заявка на праздник', status: 'new_request', startDays: null, hours: 2, branch: 'krasny', lines: [] },
  { id: randomUUID(), number: 'EV-000190', phone: '+79131234567', title: 'Корпоратив', status: 'cancelled', startDays: 10, hours: 2, branch: 'krasny', lines: [] },
  { id: randomUUID(), number: 'EV-000205', phone: '+79135550000', title: 'День рождения Петра', status: 'confirmed', startDays: 7, hours: 2, branch: 'lenina', lines: [{ name: 'Аренда комнаты VR+PS4', quantity: 2, unit: 'ч', planCostKop: 150_000 }] },
];
const VISIBLE = ['confirmed', 'preparing', 'in_progress', 'completed'];
const BRANCH_OF = {
  krasny: { name: 'Ю-Клуб на Красном', address: 'Красный проспект, 25' },
  lenina: { name: 'Ю-Клуб на Ленина', address: 'проспект Ленина, 80' },
};

/** Как normalizePhone API (РФ по умолчанию); неверный – null. */
function normalizePhone(input: string): string | null {
  if (input.length > 32) return null;
  const raw = input.trim().replace(/[\s()\-.]/g, '');
  const plus = raw.startsWith('+');
  const digits = plus ? raw.slice(1) : raw;
  if (!/^\d+$/.test(digits)) return null;
  const e164 = plus ? `+${digits}` : digits.length === 11 && (digits[0] === '8' || digits[0] === '7') ? `+7${digits.slice(1)}` : digits.length === 10 ? `+7${digits}` : null;
  return e164 && /^\+\d{8,15}$/.test(e164) && (!e164.startsWith('+7') || e164.length === 12) ? e164 : null;
}

export function registerEvents(app: FastifyInstance, P: string, deps: EventsDeps) {
  const err = (reply: FastifyReply, status: number, code: string, message: string, details: Record<string, unknown> = {}) =>
    reply.code(status).send({ error: { code, message, details, requestId: randomUUID() } });
  /** Ошибка мока записи (MockError из mock-api.ts) – как есть; прочее – наверх. */
  const passThrough = (reply: FastifyReply, e: unknown) => {
    const m = e as { status?: unknown; code?: unknown; message?: string; details?: Record<string, unknown> };
    if (typeof m?.status !== 'number' || typeof m.code !== 'string') throw e;
    return err(reply, m.status, m.code, m.message ?? '', m.details ?? {});
  };

  /** Подарок с учётом удержания: живое или ставшее бронью – reserved; удержание умерло – снова issued (healStaleHold). */
  const view = (g: Gift): Gift => {
    if (g.status === 'reserved' && g.holdId) {
      const h = deps.holdState(g.holdId);
      if (h.state === 'dead') Object.assign(g, { status: 'issued', holdId: null, bookingId: null });
      else if (h.state === 'converted') g.bookingId = h.bookingId;
    }
    return g.status === 'issued' && g.validUntil < localDate(Date.now()) ? { ...g, status: 'expired' } : g;
  };

  app.post('/__test/events-reset', async () => {
    seed();
    return { ok: true };
  });
  app.post('/__test/party-config', async (req) => {
    Object.assign(party, req.body ?? {});
    return { ...party };
  });
  app.get('/__test/event-requests', async () => ({ items: requests }));

  // П5: без входа; цены нет, пока price_confirmed = false
  app.get(`${P}/party-info`, async (req, reply) => {
    const { branchId } = req.query as { branchId?: string };
    if (branchId !== undefined && !UUID.test(branchId)) return err(reply, 400, 'VALIDATION_FAILED', 'Неверные данные запроса');
    const branches = deps.branches().filter((b) => b.active && (!branchId || b.id === branchId))
      .map((b) => ({ id: b.id, name: b.name, hasRoom: b.hasRoom && b.id !== party.noRoom }))
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    return {
      branches, minMinutes: party.minMinutes, maxGuests: party.maxGuests, formats: FORMATS, priceConfirmed: false,
      giftTerms: { devices: 2, device: 'Meta Quest 3S', minutesEach: 30, roomMinutes: TERMS.roomMinutes, validDays: 60, weekdays: TERMS.weekdays, excludesHolidays: true, notIncluded: TERMS.notIncluded },
    };
  });

  // П4: без входа
  app.post(`${P}/event-requests`, async (req, reply) => {
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || !key.trim()) return err(reply, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'Нужен заголовок Idempotency-Key');
    const raw = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    if (raw.consent !== true) return err(reply, 422, 'CONSENT_REQUIRED', 'Нужно согласие на обработку персональных данных', { field: 'consent' });
    const scope = `${String(req.headers['x-forwarded-for'] ?? req.ip)}|${key}`;
    const prev = replies.get(scope);
    if (prev) return reply.header('idempotent-replay', 'true').code(prev.status).send(prev.body);
    const bad = (path: string) => err(reply, 400, 'VALIDATION_FAILED', 'Неверные данные запроса', { issues: [{ path, message: 'Invalid input' }] });
    if (typeof raw.branchId !== 'string' || !UUID.test(raw.branchId)) return bad('branchId');
    if (typeof raw.preferredDate !== 'string') return bad('preferredDate');
    if (!FORMATS.includes(raw.format as 'h2')) return bad('format');
    if (typeof raw.guests !== 'number' || !Number.isInteger(raw.guests)) return bad('guests');
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!name || name.length > 200) return bad('name');
    if (typeof raw.phone !== 'string') return bad('phone');
    if (raw.comment !== undefined && (typeof raw.comment !== 'string' || raw.comment.trim().length > 2000)) return bad('comment');
    const b = deps.branches().find((x) => x.id === raw.branchId && x.active);
    if (!b) return err(reply, 404, 'NOT_FOUND', 'Не найдено');
    if (!b.hasRoom || b.id === party.noRoom) return err(reply, 400, 'VALIDATION_FAILED', 'В этом филиале нет комнаты для праздника', { field: 'branchId' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw.preferredDate) || Number.isNaN(Date.parse(raw.preferredDate))) return err(reply, 400, 'VALIDATION_FAILED', 'Неверная дата', { field: 'preferredDate' });
    if (raw.preferredDate < localDate(Date.now(), b.timezone)) return err(reply, 400, 'VALIDATION_FAILED', 'Дата уже прошла', { field: 'preferredDate' });
    if (raw.guests < 1 || raw.guests > party.maxGuests) return err(reply, 422, 'PARTY_GUESTS_LIMIT', `Гостей на празднике – от 1 до ${party.maxGuests}`, { max: party.maxGuests });
    const phone = normalizePhone(raw.phone);
    if (!phone) return err(reply, 400, 'VALIDATION_FAILED', 'Неверный номер телефона', { field: 'phone' });
    if (requests.filter((r) => r.phone === phone && Date.now() - (r.createdAt as number) < DAY).length >= 5) {
      return err(reply, 429, 'RATE_LIMITED', 'Слишком много заявок с этого номера, попробуйте завтра', { reason: 'phone_day', retryAfterSec: DAY / 1000 });
    }
    const number = `EV-${String(++requestNo).padStart(6, '0')}`;
    const comment = typeof raw.comment === 'string' ? raw.comment.trim() : '';
    requests.push({
      number, type: 'birthday_party', status: 'new_request', source: 'site', branchId: b.id, preferredDate: raw.preferredDate, format: raw.format,
      guests: raw.guests, name, phone, wishes: [`Желаемая дата: ${raw.preferredDate}`, comment].filter(Boolean).join('. '), createdAt: Date.now(),
    });
    const body = { requestNumber: number };
    replies.set(scope, { status: 201, body });
    return reply.code(201).send(body);
  });

  // П3: только свои, от confirmed; состав – названия и количество, без цен и себестоимости
  app.get(`${P}/me/events`, async (req, reply) => {
    const me = deps.sessionClient(req.headers.cookie);
    if (!me) return deps.fail(reply, 401, 'AUTH_REQUIRED', 'Войдите в личный кабинет');
    const today = localDate(Date.now());
    const items = EVENTS.filter((e) => e.phone === me.phone && VISIBLE.includes(e.status))
      .map((e) => {
        const start = e.startDays === null ? null : at(plusDays(today, e.startDays), '14:00');
        return {
          id: e.id, number: e.number, title: e.title, status: e.status, start,
          end: start ? new Date(Date.parse(start) + e.hours * 3600_000).toISOString() : null,
          branch: BRANCH_OF[e.branch],
          lines: e.lines.map((l) => ({ name: l.name, quantity: l.quantity, unit: l.unit })),
          bookingIds: [] as string[],
        };
      })
      .sort((a, b) => (b.start ?? '').localeCompare(a.start ?? ''));
    return { items };
  });

  // П1
  app.get(`${P}/me/gifts`, async (req, reply) => {
    const me = deps.sessionClient(req.headers.cookie);
    if (!me) return deps.fail(reply, 401, 'AUTH_REQUIRED', 'Войдите в личный кабинет');
    const items = gifts.filter((g) => g.phone === me.phone && g.status !== 'cancelled').map(view)
      .sort((a, b) => b.issuedOn.localeCompare(a.issuedOn))
      .map((g) => ({ id: g.id, number: g.number, issuedOn: g.issuedOn, validUntil: g.validUntil, status: g.status, terms: TERMS, bookingId: g.bookingId }));
    return { items };
  });

  /** Свой подарок; чужой – как несуществующий (404). Ответ ошибки уже отправлен – null. */
  async function mine(req: { headers: { cookie?: string | undefined }; params: unknown }, reply: FastifyReply): Promise<{ gift: Gift; clientId: string } | null> {
    const me = deps.sessionClient(req.headers.cookie);
    if (!me) {
      await deps.fail(reply, 401, 'AUTH_REQUIRED', 'Войдите в личный кабинет');
      return null;
    }
    const g = gifts.find((x) => x.id === (req.params as { id: string }).id);
    if (!g || g.phone !== me.phone) {
      await deps.fail(reply, 404, 'NOT_FOUND', 'Не найдено');
      return null;
    }
    return { gift: view(g), clientId: me.id };
  }

  app.get(`${P}/me/gifts/:id/slots`, async (req, reply) => {
    const m = await mine(req, reply);
    if (!m) return reply;
    const { branchId, date } = req.query as { branchId?: string; date?: string };
    if (!branchId || !UUID.test(branchId) || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return err(reply, 400, 'VALIDATION_FAILED', 'Неверные данные запроса');
    const closed = (closedReason: string) => ({ date, closedReason, slots: [] });
    if (m.gift.status !== 'issued') return closed('GIFT_NOT_ACTIVE');
    if (date > m.gift.validUntil) return closed('GIFT_EXPIRED');
    if (!TERMS.weekdays.includes(weekday(date))) return closed('GIFT_WEEKDAY_ONLY');
    if (date === mockHoliday()) return closed('GIFT_HOLIDAY');
    try {
      return { date, ...deps.giftWindows(branchId, date, TERMS.roomMinutes) };
    } catch (e) {
      return passThrough(reply, e);
    }
  });

  // П2: обычное удержание K5 на подарочный ресурс; дальше – /holds/{id}/confirm с ценой 0
  app.post(`${P}/me/gifts/:id/hold`, async (req, reply) => {
    const m = await mine(req, reply);
    if (!m) return reply;
    const g = m.gift;
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || !key.trim()) return err(reply, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'Нужен заголовок Idempotency-Key');
    const scope = `gift|${m.clientId}|${key}`;
    const prev = replies.get(scope);
    if (prev) return reply.header('idempotent-replay', 'true').code(prev.status).send(prev.body);
    const body = (req.body ?? {}) as { branchId?: unknown; start?: unknown };
    if (typeof body.branchId !== 'string' || !UUID.test(body.branchId) || typeof body.start !== 'string' || Number.isNaN(Date.parse(body.start))) return err(reply, 400, 'VALIDATION_FAILED', 'Неверные данные запроса');
    if (g.status === 'expired') return err(reply, 409, 'GIFT_EXPIRED', 'Срок подарка истёк', { validUntil: g.validUntil });
    if (g.status === 'reserved') return err(reply, 409, 'GIFT_ALREADY_RESERVED', 'По подарку уже есть запись');
    if (g.status !== 'issued') return err(reply, 409, 'GIFT_NOT_ACTIVE', 'Подарок уже не действует', { status: g.status });
    const tz = deps.branches().find((x) => x.id === body.branchId)?.timezone;
    const date = localDate(Date.parse(body.start), tz);
    if (date > g.validUntil) return err(reply, 409, 'GIFT_EXPIRED', 'Срок подарка истёк', { validUntil: g.validUntil });
    if (!TERMS.weekdays.includes(weekday(date))) return err(reply, 422, 'GIFT_WEEKDAY_ONLY', 'Подарком можно воспользоваться с понедельника по пятницу');
    if (date === mockHoliday()) return err(reply, 422, 'GIFT_HOLIDAY', 'В праздничные дни подарок не действует');
    try {
      const hold = deps.giftHold(m.clientId, body.branchId, body.start, TERMS.roomMinutes);
      Object.assign(gifts.find((x) => x.id === g.id)!, { status: 'reserved', holdId: hold.id, bookingId: null });
      replies.set(scope, { status: 201, body: hold });
      return reply.code(201).send(hold);
    } catch (e) {
      return passThrough(reply, e);
    }
  });
}

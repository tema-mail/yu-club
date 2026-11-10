// Мок слияния дублей (K11 №253–254) строго по apps/api/src/modules/clients/routes.crm.ts и clients/merge.ts (K9 «Слияние»,
// решения D5-01…D5-08): право client.merge (Владелец по сети; делегирование в моке не моделируется – прав сверх роли у мока нет).
// Предпросмотр: обе карточки, данные шести модулей (состав полей – как у обработчиков booking, finance, loyalty, certificates,
// events, notifications), конфликты, заполнение пустого, статус после, canMerge/blocker. Слияние: Idempotency-Key обязателен,
// повтор – тот же ответ с idempotent-replay; merged – 409 CLIENT_MERGED, обезличенная и «запрошено удаление» – 409 CLIENT_NOT_MERGEABLE,
// гость основной при зарегистрированной второй – 409 primary_must_be_registered. Брони и мероприятия второй переезжают к основной.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { bookingFacts } from './mock-booking.ts';
import { maskPhone, type ClientStatus, type ClientsMockDeps, type MockClient } from './mock-clients.ts';
import { eventsOfClient } from './mock-events.ts';
import { opsState } from './mock-ops.ts';

type Rec = Record<string, unknown>;
interface Staffish { id: string; role: string }

const MERGE_REASONS = ['same_person_confirmed', 'duplicate_registration', 'phone_changed'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let replays = new Map<string, { hash: string; body: unknown }>();

export function resetClientMerge(): void {
  replays = new Map();
}

const facts = () => opsState().bookings.map((b) => bookingFacts(b.id)).filter((b): b is NonNullable<ReturnType<typeof bookingFacts>> => b !== undefined);
const live = (b: { status: string; versions: Array<{ end: string }> }) =>
  b.status === 'arrived' || (b.status === 'confirmed' && Date.parse(b.versions[b.versions.length - 1]!.end) > Date.now());

function modulePreview(id: string): Record<string, unknown> {
  const bks = facts().filter((b) => b.clientId === id);
  const evs = eventsOfClient(id);
  return {
    booking: { upcoming: bks.filter(live).length, visits: bks.filter((b) => b.status === 'completed').length, noShows: bks.filter((b) => b.status === 'no_show').length,
      cancelled: bks.filter((b) => b.status.startsWith('cancelled')).length, holds: 0, total: bks.length },
    finance: { payments: 0, paidKop: 0, refundedKop: 0, unpaidSessions: 0 },
    loyalty: { balanceCenti: 0, availableCenti: 0, reservedCenti: 0, preBookingBlocked: false },
    certificates: { total: 0, active: 0, balanceKop: 0 },
    events: { events: evs.length, live: evs.filter((e) => !['completed', 'cancelled', 'not_held'].includes(e.status)).length, gifts: 0 },
    notifications: { messages: 0, planned: 0, subscriptions: 0 },
  };
}

const isRegistered = (c: MockClient) => c.status !== 'guest' && c.registeredAt !== null;
function statusAfter(p: MockClient, s: MockClient): { status: ClientStatus; reason: string | null } {
  if (p.status === 'blocked') return { status: p.status, reason: p.statusReason };
  if (s.status === 'blocked') return { status: 'blocked', reason: s.statusReason };
  if (p.status === 'restricted') return { status: p.status, reason: p.statusReason };
  if (s.status === 'restricted') return { status: 'restricted', reason: s.statusReason };
  return { status: p.status, reason: p.statusReason };
}
function diff(p: MockClient, s: MockClient) {
  const conflicts: Array<{ field: string; primary: string; secondary: string }> = [];
  const fills: Array<{ field: string; value: string }> = [];
  const fields = [['firstName', p.firstName, s.firstName], ['lastName', p.lastName, s.lastName], ['email', p.email, s.email], ['birthDate', p.birthDate, s.birthDate]] as const;
  for (const [field, a, b] of fields) {
    if (a !== null && b !== null && a !== b) conflicts.push({ field, primary: a, secondary: b });
    else if (a === null && b !== null) fills.push({ field, value: b });
  }
  if (p.phoneE164 && s.phoneE164) conflicts.push({ field: 'phone', primary: maskPhone(p.phoneE164), secondary: maskPhone(s.phoneE164) });
  if (p.status !== s.status) conflicts.push({ field: 'status', primary: p.status, secondary: s.status });
  return { conflicts, fills };
}

export function registerClientMerge(
  app: FastifyInstance,
  P: string,
  d: ClientsMockDeps & { clients: () => MockClient[]; card: (s: Staffish, c: MockClient) => unknown },
): void {
  const forbid = (reply: FastifyReply) => d.fail(reply, 403, 'FORBIDDEN', 'Недостаточно прав', { action: 'client.merge' });
  const invalid = (reply: FastifyReply, path: string) => d.fail(reply, 400, 'VALIDATION_FAILED', 'Неверные данные запроса', { issues: [{ path, message: 'Invalid input' }] });
  const closed = (reply: FastifyReply, c: MockClient) =>
    c.status === 'merged'
      ? d.fail(reply, 409, 'CLIENT_MERGED', 'Карточка уже объединена', { clientId: c.id, mergedIntoId: c.mergedIntoId ?? null })
      : c.status === 'anonymized' || c.status === 'deletion_requested'
        ? d.fail(reply, 409, 'CLIENT_NOT_MERGEABLE', 'Эту карточку объединять нельзя', { clientId: c.id, status: c.status, reason: c.status })
        : null;
  const allowed = (s: Staffish) => d.can(s, 'client.merge') && d.zone(s).network;
  /** Порядок как у маршрута и процедуры: параметры → право → тело → карточки (404) → статусы (409). */
  const pair = (reply: FastifyReply, id: string, secondaryId: unknown): { stop: unknown } | { p: MockClient; sc: MockClient } => {
    if (id.toLowerCase() === String(secondaryId).toLowerCase()) return { stop: d.fail(reply, 400, 'VALIDATION_FAILED', 'Нужны две разные карточки', { field: 'secondaryId' }) };
    const p = d.clients().find((x) => x.id === id);
    const sc = d.clients().find((x) => x.id === secondaryId);
    if (!p || !sc) return { stop: d.fail(reply, 404, 'NOT_FOUND', 'Не найдено') };
    const c = closed(reply, sc) ?? closed(reply, p);
    return c ? { stop: c } : { p, sc };
  };

  d.grant('owner', ['client.merge']);

  app.get(`${P}/clients/:clientId/merge-preview`, async (req: FastifyRequest, reply) => {
    const s = d.current(req);
    if (!allowed(s)) return forbid(reply);
    const w = (req.query as { with?: string }).with;
    if (typeof w !== 'string' || !UUID.test(w)) return invalid(reply, 'with');
    const r = pair(reply, (req.params as { clientId: string }).clientId, w);
    if ('stop' in r) return r.stop;
    const blocker = !isRegistered(r.p) && isRegistered(r.sc) ? 'primary_must_be_registered' : null;
    const m1 = modulePreview(r.p.id);
    const m2 = modulePreview(r.sc.id);
    return {
      primary: d.card(s, r.p), secondary: d.card(s, r.sc),
      modules: Object.fromEntries(Object.keys(m1).map((k) => [k, { primary: m1[k], secondary: m2[k] }])),
      ...diff(r.p, r.sc), statusAfter: statusAfter(r.p, r.sc).status, canMerge: blocker === null, blocker,
    };
  });

  app.post(`${P}/clients/:clientId/merge`, async (req: FastifyRequest, reply) => {
    const s = d.current(req);
    const id = (req.params as { clientId: string }).clientId;
    if (!allowed(s)) return forbid(reply);
    const body = (req.body ?? {}) as Rec;
    if (typeof body.secondaryId !== 'string' || !UUID.test(body.secondaryId)) return invalid(reply, 'secondaryId');
    if (typeof body.reason !== 'string' || !MERGE_REASONS.includes(body.reason)) return invalid(reply, 'reason');
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || key === '') return d.fail(reply, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'Нужен заголовок Idempotency-Key');
    const hash = JSON.stringify([id, body.secondaryId, body.reason]);
    const prev = replays.get(`${s.id}:${key}`);
    if (prev) {
      if (prev.hash !== hash) return d.fail(reply, 409, 'IDEMPOTENCY_KEY_REUSED', 'Ключ уже использован для другой операции');
      reply.header('idempotent-replay', 'true');
      return prev.body;
    }
    const r = pair(reply, id, body.secondaryId);
    if ('stop' in r) return r.stop;
    const { p, sc } = r;
    if (!isRegistered(p) && isRegistered(sc)) {
      return d.fail(reply, 409, 'CLIENT_NOT_MERGEABLE', 'Основной должна быть зарегистрированная карточка', { clientId: p.id, reason: 'primary_must_be_registered' });
    }
    let bookings = 0;
    for (const b of facts()) if (b.clientId === sc.id) { b.clientId = p.id; bookings++; }
    let customer = 0;
    let birthday = 0;
    for (const e of eventsOfClient(sc.id)) {
      if (e.customerClientId === sc.id) { e.customerClientId = p.id; customer++; }
      if (e.birthdayClientId === sc.id) { e.birthdayClientId = p.id; birthday++; }
    }
    const results = {
      booking: { bookings, holds: 0, clientTime: 0, visits: 0, noShows: 0 }, finance: { sessions: 0 },
      loyalty: { movedCenti: 0, debtWrittenOffCenti: 0, batches: 0, reserves: 0, issues: 0 }, certificates: { certificates: 0 },
      events: { customer, birthday, gifts: 0 }, notifications: { messages: 0 },
    };
    const { fills } = diff(p, sc);
    const st = statusAfter(p, sc);
    const mergeId = randomUUID();
    const before = p.status;
    const secBefore = sc.status;
    Object.assign(p, {
      firstName: p.firstName ?? sc.firstName, lastName: p.lastName ?? sc.lastName, email: p.email ?? sc.email, birthDate: p.birthDate ?? sc.birthDate,
      status: st.status, statusReason: st.reason, rowVersion: p.rowVersion + 1, links: [...new Set([...p.links, ...sc.links])],
    });
    Object.assign(sc, {
      phoneE164: null, phoneVerifiedAt: null, firstName: null, lastName: null, email: null, birthDate: null, status: 'merged', mergedIntoId: p.id,
      statusReason: null, statusUntil: null, rowVersion: sc.rowVersion + 1,
    });
    d.audit(s, 'client', p.id, 'client.merged', { status: before }, { status: st.status, secondaryId: sc.id, mergeId, results, filled: fills.map((f) => f.field) }, body.reason);
    d.audit(s, 'client', sc.id, 'client.status_changed', { status: secBefore }, { status: 'merged', mergedIntoId: p.id, mergeId }, body.reason);
    const res = { mergeId, primaryId: p.id, secondaryId: sc.id, status: 'merged', results };
    replays.set(`${s.id}:${key}`, { hash, body: res });
    return res;
  });
}

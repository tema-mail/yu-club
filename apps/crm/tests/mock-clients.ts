// Клиенты CRM – мок точно по apps/api/src/modules/clients/routes.crm.ts (K11 №15–16, S1-11, S1-25): поиск и карточка.
// Вынесено из mock-api.ts (файл упёрся в 800 строк): состояние клиентов, засев, маска телефона, зона и маршруты.
// Связь клиент – филиал (брони, S1-07) в моке – поле links: так не-Владелец видит клиентов своей зоны.
// Пока бронирования нет, настоящий бэкенд связей не даёт (noBranchLinks) – находит только по точному телефону.
// №249 обезличивание (K9, D4-60…D4-65) – по clients/anonymize.ts: право client.anonymize (только Владелец), основание – код,
// живые записи (бронь confirmed впереди или arrived, мероприятие не завершено) – 409 CLIENT_HAS_ACTIVE_RECORDS, повтор – 200 alreadyAnonymized.
// №253–254 слияние дублей – mock-client-merge.ts; здесь – статус merged: в общем поиске нет, по id – есть, карточка без full.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { bookingFacts } from './mock-booking.ts';
import { registerClientMerge, resetClientMerge } from './mock-client-merge.ts';
import { eventsOfClient } from './mock-events.ts';
import { opsState } from './mock-ops.ts';

type Rec = Record<string, unknown>;
interface Staffish { id: string; role: string }
interface Zone { network: boolean; branchIds: string[] }

export interface ClientsMockDeps {
  current: (req: FastifyRequest) => Staffish;
  zone: (s: Staffish) => Zone;
  can: (s: Staffish, action: string) => boolean;
  fail: (reply: FastifyReply, status: number, code: string, message: string, details?: Rec) => unknown;
  page: <T>(all: T[], q: { cursor?: string; limit?: string }) => { items: T[]; nextCursor: string | null };
  audit: (s: Staffish, objectType: string, objectId: string, action: string, before: object, after: object, reason: string | null) => void;
  /** Добавить действия K1 в /me мока (как NOTIFICATION_ACTIONS). */
  grant: (role: 'owner' | 'director' | 'admin', actions: string[]) => void;
}

/** D4-61: основание обезличивания – только код. */
const ANONYMIZE_REASONS = ['client_request', 'retention_expired'];

export const CLIENT_STATUSES = ['guest', 'active', 'restricted', 'blocked', 'deletion_requested', 'anonymized', 'merged'] as const;
export type ClientStatus = (typeof CLIENT_STATUSES)[number];
export interface MockClient {
  id: string; status: ClientStatus; firstName: string | null; lastName: string | null; phoneE164: string | null;
  email: string | null; birthDate: string | null; statusReason: string | null; statusUntil: string | null;
  registrationSource: string | null; phoneVerifiedAt: string | null; registeredAt: string | null; createdAt: string;
  lastLoginAt: string | null; rowVersion: number; links: string[]; mergedIntoId?: string | null;
}

const clientId = (n: number) => `c0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function seedClients(): MockClient[] {
  const base = { email: null, birthDate: null, statusReason: null, statusUntil: null, registrationSource: null, lastLoginAt: null, rowVersion: 1 };
  return [
    { ...base, id: clientId(1), status: 'active', firstName: 'Ольга', lastName: 'Смирнова', phoneE164: '+79131234567', email: 'olga@yu.test',
      birthDate: '1995-04-12', registrationSource: 'site', phoneVerifiedAt: '2026-10-01T05:00:00.000Z', registeredAt: '2026-10-01T05:00:00.000Z',
      createdAt: '2026-09-28T09:30:00.000Z', lastLoginAt: '2026-10-30T12:15:00.000Z', rowVersion: 3, links: ['b-nsk-krasny'] },
    { ...base, id: clientId(2), status: 'guest', firstName: 'Иван', lastName: 'Петров', phoneE164: '+79139876543',
      phoneVerifiedAt: null, registeredAt: null, createdAt: '2026-10-15T11:00:00.000Z', links: ['b-nsk-krasny'] },
    { ...base, id: clientId(3), status: 'blocked', firstName: 'Мария', lastName: 'Кузнецова', phoneE164: '+79230001122', email: 'maria@yu.test',
      statusReason: 'Нарушение правил клуба', registrationSource: 'site', phoneVerifiedAt: '2026-08-01T05:00:00.000Z',
      registeredAt: '2026-08-01T05:00:00.000Z', createdAt: '2026-08-01T05:00:00.000Z', links: ['b-tsk-lenina'] },
    { ...base, id: clientId(4), status: 'anonymized', firstName: null, lastName: null, phoneE164: null,
      phoneVerifiedAt: null, registeredAt: null, createdAt: '2026-01-10T05:00:00.000Z', links: ['b-nsk-krasny'] },
  ];
}
let clients = seedClients();

/** Текущий список (массив меняется: гости из броней добавляются в него же). */
export const clientsState = (): MockClient[] => clients;
export function resetClients(): void {
  clients = seedClients();
  resetClientMerge();
}

// Аудит клиента пишется уже маскированным (K2 redact: PD_KEYS) – так его отдаёт и хронология.
export function seedClientAudit() {
  return [
    { id: randomUUID(), at: '2026-09-28T09:30:00.000Z', objectType: 'client', objectId: clientId(1), action: 'client.created', actor: null,
      before: {}, after: { status: 'guest', phoneE164: '+7******4567', firstName: 'О***', lastName: 'С***' }, reason: null },
    { id: randomUUID(), at: '2026-10-01T05:00:00.000Z', objectType: 'client', objectId: clientId(1), action: 'client.status_changed', actor: null,
      before: { status: 'guest' }, after: { status: 'active' }, reason: null },
  ];
}

export const maskPhone = (e164: string | null) =>
  !e164 ? '' : e164.startsWith('+7') && e164.length === 12 ? `+7 ••• ••• ••-${e164.slice(-2)}` : `${e164.slice(0, 2)} ••• ${e164.slice(-2)}`;
const clientRef = (c: MockClient) => ({ id: c.id, status: c.status, firstName: c.firstName, lastName: c.lastName, phoneMasked: maskPhone(c.phoneE164) });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Упрощённый normalizePhone (clients/index.ts): РФ по умолчанию, неверный – null. */
export function normalizePhone(t: string): string | null {
  const raw = t.trim().replace(/[\s().-]/g, '');
  const digits = raw.startsWith('+') ? raw.slice(1) : raw;
  if (!/^\d+$/.test(digits)) return null;
  if (raw.startsWith('+')) return /^[1-9]\d{7,14}$/.test(digits) && (!digits.startsWith('7') || digits.length === 11) ? `+${digits}` : null;
  if (digits.length === 11 && (digits[0] === '8' || digits[0] === '7')) return `+7${digits.slice(1)}`;
  return digits.length === 10 ? `+7${digits}` : null;
}

/** Клиент в зоне сотрудника: Владелец – все, остальные – по связи с филиалами зоны. */
export const clientInZone = (zone: Zone, c: MockClient) => zone.network || c.links.some((b) => zone.branchIds.includes(b));

export function registerClients(app: FastifyInstance, P: string, d: ClientsMockDeps): void {
  const notFound = (reply: FastifyReply) => d.fail(reply, 404, 'NOT_FOUND', 'Не найдено');
  const invalid = (reply: FastifyReply, issues: Array<{ path: string; message: string }>) =>
    d.fail(reply, 400, 'VALIDATION_FAILED', 'Неверные данные запроса', { issues });

  app.get(`${P}/clients`, async (req, reply) => {
    const s = d.current(req);
    if (!d.can(s, 'client.view.basic')) return d.fail(reply, 403, 'FORBIDDEN', 'Недостаточно прав', { action: 'client.view.basic' });
    const q = req.query as { q?: string; branchId?: string; status?: string; cursor?: string; limit?: string };
    const t = (q.q ?? '').trim();
    const status = (q.status ?? '').split(',').filter((x) => x !== '');
    const limit = q.limit === undefined ? 50 : Number(q.limit);
    if ((q.q ?? '').length > 100 || status.some((x) => !(CLIENT_STATUSES as readonly string[]).includes(x)) || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      return invalid(reply, [{ path: 'query', message: 'Неверные данные запроса' }]);
    }
    let match: (c: MockClient) => boolean = () => true;
    let byPhone = false;
    if (UUID.test(t)) match = (c) => c.id === t.toLowerCase();
    else if (/^[+\d\s().-]+$/.test(t)) {
      const digits = t.replace(/\D/g, '');
      if (digits.length < 4) return d.fail(reply, 400, 'VALIDATION_FAILED', 'Для поиска по телефону нужно от 4 цифр', { field: 'q' });
      const e164 = digits.length === 4 ? null : normalizePhone(t);
      byPhone = e164 !== null;
      match = digits.length === 4 ? (c) => (c.phoneE164 ?? '').endsWith(digits) : e164 ? (c) => c.phoneE164 === e164 : (c) => (c.phoneE164 ?? '').includes(digits);
    } else if (t.includes('@')) match = (c) => c.email === t.toLowerCase();
    else if (t) {
      const words = t.toLowerCase().split(/\s+/).slice(0, 3);
      match = (c) => words.every((w) => (c.lastName ?? '').toLowerCase().startsWith(w) || (c.firstName ?? '').toLowerCase().startsWith(w));
    }
    const zone = d.zone(s);
    if (q.branchId && !zone.branchIds.includes(q.branchId)) return notFound(reply);
    const key = (c: MockClient) => `${(c.lastName ?? '').toLowerCase()}\u0000${(c.firstName ?? '').toLowerCase()}\u0000${c.id}`;
    const all = clients
      .filter((c) => match(c) && (byPhone || clientInZone(zone, c)) && (!q.branchId || c.links.includes(q.branchId)))
      .filter((c) => (status.length ? status.includes(c.status) : c.status !== 'anonymized' && (c.status !== 'merged' || UUID.test(t))))
      .sort((a, b) => (key(a) < key(b) ? -1 : 1))
      .map((c) => ({ ...clientRef(c), lastVisitAt: null, lastBranchId: null }));
    return d.page(all, { ...q, limit: String(limit) });
  });

  app.get(`${P}/clients/:clientId`, async (req, reply) => {
    const s = d.current(req);
    if (!d.can(s, 'client.view.basic')) return d.fail(reply, 403, 'FORBIDDEN', 'Недостаточно прав', { action: 'client.view.basic' });
    const c = clients.find((x) => x.id === (req.params as { clientId: string }).clientId);
    if (!c || !clientInZone(d.zone(s), c)) return notFound(reply);
    return cardOf(s, c);
  });
  const cardOf = (s: Staffish, c: MockClient) => ({
    ...clientRef(c), isGuest: c.status === 'guest', phoneVerified: c.phoneVerifiedAt !== null, registeredAt: c.registeredAt,
    mergedIntoId: c.mergedIntoId ?? null,
    // объединённая (merged) – минимум полей без ПДн, как routes.crm.ts
    full: d.can(s, 'client.view.full') && c.status !== 'merged'
      ? { phoneE164: c.phoneE164, email: c.email, birthDate: c.birthDate, statusReason: c.statusReason, statusUntil: c.statusUntil,
          registrationSource: c.registrationSource, createdAt: c.createdAt, lastLoginAt: c.lastLoginAt }
      : null,
    rowVersion: c.rowVersion,
  });
  registerClientMerge(app, P, { ...d, clients: () => clients, card: cardOf });

  // №249: порядок проверок как у маршрута – параметры, право (403), тело (400), затем процедура K9.
  d.grant('owner', ['client.anonymize']);
  app.post(`${P}/clients/:clientId/anonymize`, async (req, reply) => {
    const s = d.current(req);
    const id = (req.params as { clientId: string }).clientId;
    if (id.length > 64) return invalid(reply, [{ path: 'clientId', message: 'Too big' }]);
    if (!d.can(s, 'client.anonymize') || !d.zone(s).network) return d.fail(reply, 403, 'FORBIDDEN', 'Недостаточно прав', { action: 'client.anonymize' });
    const body = req.body;
    const reason = body && typeof body === 'object' ? (body as Rec).reason : undefined;
    if (typeof reason !== 'string' || !ANONYMIZE_REASONS.includes(reason)) return invalid(reply, [{ path: 'reason', message: 'Invalid option' }]);
    const c = UUID.test(id) ? clients.find((x) => x.id === id) : undefined;
    if (!c) return notFound(reply);
    if (c.status === 'anonymized') return { clientId: c.id, status: 'anonymized', alreadyAnonymized: true, affected: {} };
    const now = Date.now();
    const bookings = opsState().bookings.map((b) => bookingFacts(b.id)).filter((b) => b !== undefined && b.clientId === c.id &&
      (b.status === 'arrived' || (b.status === 'confirmed' && Date.parse(b.versions[b.versions.length - 1]!.end) > now))).length;
    const events = eventsOfClient(c.id);
    const live = events.filter((e) => !['completed', 'cancelled', 'not_held'].includes(e.status)).length;
    const blockers = { ...(bookings ? { booking: bookings } : {}), ...(live ? { events: live } : {}) };
    if (bookings || live) return d.fail(reply, 409, 'CLIENT_HAS_ACTIVE_RECORDS', 'Сначала завершите или отмените живые брони и мероприятия клиента', { blockers });
    // events/anonymize.ts: заказчик – заглушки имени и телефона; имя именинника и пожелания – NULL.
    let touched = 0;
    for (const e of events) {
      if (e.customerClientId === c.id) Object.assign(e, { customerName: 'Обезличено', customerPhone: '+70000000000' });
      Object.assign(e, { birthdayName: null, wishes: null, rowVersion: e.rowVersion + 1 });
      touched++;
    }
    const affected = { booking: 0, events: touched, notifications: 0 };
    const before = { status: c.status };
    Object.assign(c, { phoneE164: null, phoneVerifiedAt: null, firstName: null, lastName: null, email: null, birthDate: null,
      status: 'anonymized', statusReason: null, statusUntil: null, rowVersion: c.rowVersion + 1 });
    d.audit(s, 'client', c.id, 'client.status_changed', before, { status: 'anonymized', affected }, reason);
    return { clientId: c.id, status: 'anonymized', alreadyAnonymized: false, affected };
  });
}

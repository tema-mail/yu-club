// Мок входа клиента и ЛК (K9) для e2e сайта – вынесен из mock-api.ts без изменения поведения.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import { liveAdvertisingVersion } from './mock-content.ts';

export function fail(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ error: { code, message, requestId: randomUUID() } });
}

let lastForwardedFor: string | string[] | null = null;

// ---- Вход клиента (K9) – точно по apps/api/src/modules/clients/routes.public.ts и otp.ts:
// тот же ответ 202 на любой номер, коды ошибок, retry-after, кука yu_client. Код в моке всегда MOCK_CODE.
// Особые номера: …0429 – лимит запросов кода, …0503 – SMS не ушло, …0403 – клиент заблокирован.
export const MOCK_CODE = '123456';
const MAX_ATTEMPTS = 5;

interface Challenge { phone: string; attempts: number; expiresAt: number; used: boolean }
interface MockClient { id: string; phone: string; firstName: string | null; lastName: string | null; status: 'active' | 'restricted' | 'blocked'; consent: boolean; prefs?: { remindersEnabled: boolean; marketingEnabled: boolean } }

const challenges = new Map<string, Challenge>();
export const sessions = new Map<string, string>(); // token → clientId
/** journal.client_consents (K9, K21 §4): реклама – с живой версией документа; GET /__test/consents – для e2e. */
export const consents: Array<{ clientId: string; kind: 'marketing'; granted: boolean; documentVersion: string | null; source: 'site' | 'account' }> = [];
export const clients: MockClient[] = [
  { id: randomUUID(), phone: '+79131234567', firstName: 'Алина', lastName: 'Сафронова', status: 'active', consent: true },
  { id: randomUUID(), phone: '+79990000403', firstName: null, lastName: null, status: 'blocked', consent: true },
  // Чужой клиент с записями: e2e ЛК проверяет, что Алина их не видит.
  { id: randomUUID(), phone: '+79135550000', firstName: 'Пётр', lastName: 'Иванов', status: 'active', consent: true },
];

/** Как normalizePhone в apps/api/src/modules/clients/index.ts (РФ по умолчанию). */
function normalizePhone(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > 32) return null;
  const raw = input.trim().replace(/[\s()\-.]/g, '');
  const plus = raw.startsWith('+');
  const digits = plus ? raw.slice(1) : raw;
  if (!/^\d+$/.test(digits)) return null;
  let e164: string;
  if (plus) e164 = `+${digits}`;
  else if (digits.length === 11 && (digits[0] === '8' || digits[0] === '7')) e164 = `+7${digits.slice(1)}`;
  else if (digits.length === 10) e164 = `+7${digits}`;
  else return null;
  return /^\+\d{8,15}$/.test(e164) && (!e164.startsWith('+7') || e164.length === 12) ? e164 : null;
}

const maskPhone = (e164: string) => `+7 ••• ••• ••-${e164.slice(-2)}`;

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

const prefsOf = (c: MockClient) => c.prefs ?? { remindersEnabled: true, marketingEnabled: false };
// Push (K9 /me/push-subscriptions) – endpoint → clientId; журнал вызовов для e2e.
const pushSubs = new Map<string, string>();
const pushCalls: Array<{ method: string; body: unknown }> = [];
// Открытый ключ VAPID – 65 байт (0x04 + нули): браузер в e2e не подписывается по-настоящему, метод подменён.
const MOCK_VAPID = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url');

function meDto(c: MockClient) {
  return {
    id: c.id, phoneMasked: maskPhone(c.phone), firstName: c.firstName, lastName: c.lastName, email: null, birthDate: null,
    status: c.status, notifications: prefsOf(c), loyalty: null, certificates: null,
  };
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLEAR = 'yu_client=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';

export function registerClientAuth(app: FastifyInstance, P: string, onLogin: (clientId: string, cookie: string | undefined) => void) {
  // Только для e2e: последний X-Forwarded-For, который прислал прокси сайта.
  app.addHook('onRequest', async (req) => {
    if (req.url.startsWith(`${P}/auth/`)) lastForwardedFor = req.headers['x-forwarded-for'] ?? null;
  });
  app.get('/__test/last-xff', async () => ({ xff: lastForwardedFor }));

  app.post(`${P}/auth/otp/request`, async (req, reply) => {
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || !key.trim()) return fail(reply, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'Нужен заголовок Idempotency-Key');
    const body = (req.body ?? {}) as { phone?: unknown; purpose?: unknown };
    if (body.purpose !== 'login') return fail(reply, 400, 'VALIDATION_FAILED', 'Неверные данные запроса');
    const phone = normalizePhone(body.phone);
    if (!phone) return reply.code(400).send({ error: { code: 'VALIDATION_FAILED', message: 'Неверный номер телефона', details: { field: 'phone' }, requestId: randomUUID() } });
    if (phone.endsWith('0429')) {
      reply.header('retry-after', '60');
      return reply.code(429).send({ error: { code: 'OTP_RATE_LIMITED', message: 'Слишком много запросов кода, попробуйте позже', details: { resendAfterSec: 60 }, requestId: randomUUID() } });
    }
    if (phone.endsWith('0503')) {
      reply.header('retry-after', '60');
      return reply.code(503).send({ error: { code: 'SMS_UNAVAILABLE', message: 'Не удалось отправить код, попробуйте позже', details: { resendAfterSec: 60 }, requestId: randomUUID() } });
    }
    const challengeId = randomUUID();
    challenges.set(challengeId, { phone, attempts: 0, expiresAt: Date.now() + 300_000, used: false });
    return reply.code(202).send({ challengeId, resendAfterSec: 60, expiresInSec: 300 });
  });

  app.post(`${P}/auth/otp/verify`, async (req, reply) => {
    const body = (req.body ?? {}) as { challengeId?: unknown; code?: unknown; consents?: { pdProcessing?: unknown; marketing?: unknown } };
    const expired = () => fail(reply, 410, 'OTP_EXPIRED', 'Код недействителен, запросите новый');
    if (typeof body.challengeId !== 'string' || !UUID.test(body.challengeId)) return expired();
    if (typeof body.code !== 'string' || !/^\d{6}$/.test(body.code)) {
      return reply.code(400).send({ error: { code: 'VALIDATION_FAILED', message: 'Код – 6 цифр', details: { field: 'code' }, requestId: randomUUID() } });
    }
    const ch = challenges.get(body.challengeId);
    if (!ch || ch.used || ch.expiresAt <= Date.now() || ch.attempts >= MAX_ATTEMPTS) return expired();
    if (body.code !== MOCK_CODE) {
      ch.attempts += 1;
      return reply.code(401).send({ error: { code: 'OTP_INVALID', message: 'Неверный код', details: { attemptsLeft: MAX_ATTEMPTS - ch.attempts }, requestId: randomUUID() } });
    }
    let client = clients.find((c) => c.phone === ch.phone);
    if (client?.status === 'blocked') {
      ch.used = true;
      return reply.code(403).send({ error: { code: 'CLIENT_RESTRICTED', message: 'Вход ограничен, обратитесь в клуб', details: { status: 'blocked' }, requestId: randomUUID() } });
    }
    if ((!client || !client.consent) && body.consents?.pdProcessing !== true) {
      return fail(reply, 422, 'CONSENT_REQUIRED', 'Нужно согласие на обработку персональных данных');
    }
    const isNew = !client;
    // otp.ts: реклама только у нового клиента и только с живой версией страницы, присланную сайтом версию не берём.
    if (isNew && body.consents?.marketing === true && !liveAdvertisingVersion()) return fail(reply, 409, 'MARKETING_DOCUMENT_MISSING', 'Текст согласия на рекламу ещё не опубликован');
    if (!client) {
      client = { id: randomUUID(), phone: ch.phone, firstName: null, lastName: null, status: 'active', consent: true };
      clients.push(client);
      const marketing = body.consents?.marketing === true;
      client.prefs = { remindersEnabled: true, marketingEnabled: marketing };
      if (marketing) consents.push({ clientId: client.id, kind: 'marketing', granted: true, documentVersion: liveAdvertisingVersion(), source: 'site' });
    }
    ch.used = true;
    const token = randomUUID();
    sessions.set(token, client.id);
    onLogin(client.id, req.headers.cookie); // хук входа K9 → booking (server.ts): удержания посетителя – клиенту
    reply.header('set-cookie', `yu_client=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${30 * 86400}`);
    return { client: meDto(client), isNew };
  });

  app.post(`${P}/auth/logout`, async (req, reply) => {
    const token = readCookie(req.headers.cookie, 'yu_client');
    if (token) sessions.delete(token);
    reply.header('set-cookie', CLEAR);
    return reply.code(204).send();
  });

  const sessionClient = (req: { headers: { cookie?: string | undefined } }) => {
    const token = readCookie(req.headers.cookie, 'yu_client');
    return token ? clients.find((c) => c.id === sessions.get(token)) : undefined;
  };

  app.get('/__test/consents', async () => consents.map((x) => ({ ...x, phone: clients.find((c) => c.id === x.clientId)?.phone ?? null })));

  app.get(`${P}/push/vapid-public-key`, async () => ({ publicKey: MOCK_VAPID }));
  app.get('/__test/push-calls', async () => pushCalls);

  app.post(`${P}/me/push-subscriptions`, async (req, reply) => {
    const c = sessionClient(req);
    if (!c) return fail(reply, 401, 'AUTH_REQUIRED', 'Нужно войти');
    const body = (req.body ?? {}) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
    if (typeof body.endpoint !== 'string' || typeof body.keys?.p256dh !== 'string' || typeof body.keys?.auth !== 'string') {
      return fail(reply, 400, 'VALIDATION_FAILED', 'Неверные данные запроса');
    }
    pushCalls.push({ method: 'POST', body });
    const created = pushSubs.get(body.endpoint) !== c.id;
    pushSubs.set(body.endpoint, c.id);
    return reply.code(created ? 201 : 200).send({ id: '0b0d0000-0000-4000-8000-000000000001' });
  });

  app.delete(`${P}/me/push-subscriptions`, async (req, reply) => {
    const c = sessionClient(req);
    if (!c) return fail(reply, 401, 'AUTH_REQUIRED', 'Нужно войти');
    const body = (req.body ?? {}) as { endpoint?: unknown };
    pushCalls.push({ method: 'DELETE', body });
    if (typeof body.endpoint === 'string' && pushSubs.get(body.endpoint) === c.id) pushSubs.delete(body.endpoint);
    return reply.code(204).send();
  });

  app.get(`${P}/me/notification-settings`, async (req, reply) => {
    const c = sessionClient(req);
    if (!c) return fail(reply, 401, 'AUTH_REQUIRED', 'Нужно войти');
    return { ...prefsOf(c), serviceAlwaysOn: true, pushSubscriptions: [...pushSubs.values()].filter((id) => id === c.id).length };
  });

  app.put(`${P}/me/notification-settings`, async (req, reply) => {
    const c = sessionClient(req);
    if (!c) return fail(reply, 401, 'AUTH_REQUIRED', 'Нужно войти');
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || !key.trim()) return fail(reply, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'Нужен заголовок Idempotency-Key');
    const body = (req.body ?? {}) as { remindersEnabled?: unknown; marketingEnabled?: unknown };
    if (typeof body.remindersEnabled !== 'boolean' || typeof body.marketingEnabled !== 'boolean') return fail(reply, 400, 'VALIDATION_FAILED', 'Неверные данные запроса');
    if (c.phone.endsWith('0500')) return fail(reply, 500, 'INTERNAL', 'Внутренняя ошибка');
    const was = prefsOf(c).marketingEnabled;
    if (body.marketingEnabled !== was) {
      // notifications/index.ts: включение рекламы – с живой версией документа, нет её – 409; выключение – без версии.
      const version = body.marketingEnabled ? liveAdvertisingVersion() : null;
      if (body.marketingEnabled && !version) return fail(reply, 409, 'MARKETING_DOCUMENT_MISSING', 'Текст согласия на рекламу ещё не опубликован');
      consents.push({ clientId: c.id, kind: 'marketing', granted: body.marketingEnabled, documentVersion: version, source: 'account' });
    }
    c.prefs = { remindersEnabled: body.remindersEnabled, marketingEnabled: body.marketingEnabled };
    return { ...c.prefs, serviceAlwaysOn: true, pushSubscriptions: 0 };
  });

  app.get(`${P}/me`, async (req, reply) => {
    const token = readCookie(req.headers.cookie, 'yu_client');
    if (!token) return fail(reply, 401, 'AUTH_REQUIRED', 'Нужно войти');
    const client = clients.find((c) => c.id === sessions.get(token));
    if (!client || client.status === 'blocked') {
      reply.header('set-cookie', CLEAR);
      return fail(reply, 401, 'SESSION_REVOKED', 'Сессия завершена, войдите снова');
    }
    return meDto(client);
  });

}

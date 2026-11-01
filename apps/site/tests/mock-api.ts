// Мок публичного API записи для сайта – пока нет S1-08 (apps/api/src/modules/booking/routes.public.ts).
// Повторяет K5 №1–5 (города, филиалы, ресурсы, доступность) и тело ошибки ADR 0002; статусы – K13.
// Филиалы 'preparing'/'archived' лежат в данных, но наружу не отдаются (K5) – так e2e проверяет 404.
// Запуск: MOCK_PORT=4020 node tests/mock-api.ts; сайт: API_URL=http://127.0.0.1:4020.
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';

type Status = 'preparing' | 'active' | 'temporarily_closed' | 'archived';
type Zone = 'pc' | 'vr' | 'ps';

const cities = [
  { id: 'c-nsk', slug: 'novosibirsk', name: 'Новосибирск', timezone: 'Asia/Novosibirsk' },
  { id: 'c-tsk', slug: 'tomsk', name: 'Томск', timezone: 'Asia/Tomsk' },
  // Только готовящийся филиал – города в публичном списке нет.
  { id: 'c-omsk', slug: 'omsk', name: 'Омск', timezone: 'Asia/Omsk' },
];

const branches: Array<{ id: string; cityId: string; slug: string; name: string; address: string; timezone: string; status: Status; phone: string | null }> = [
  { id: 'b-nsk-krasny', cityId: 'c-nsk', slug: 'krasny-prospekt', name: 'Ю-Клуб на Красном', address: 'Красный проспект, 25', timezone: 'Asia/Novosibirsk', status: 'active', phone: null },
  { id: 'b-nsk-akadem', cityId: 'c-nsk', slug: 'akademgorodok', name: 'Ю-Клуб Академгородок', address: 'Морской проспект, 2', timezone: 'Asia/Novosibirsk', status: 'temporarily_closed', phone: null },
  { id: 'b-nsk-new', cityId: 'c-nsk', slug: 'gorskiy', name: 'Ю-Клуб Горский', address: 'Горский микрорайон, 8', timezone: 'Asia/Novosibirsk', status: 'preparing', phone: null },
  { id: 'b-tsk-lenina', cityId: 'c-tsk', slug: 'lenina', name: 'Ю-Клуб на Ленина', address: 'проспект Ленина, 80', timezone: 'Asia/Tomsk', status: 'active', phone: null },
  { id: 'b-omsk-1', cityId: 'c-omsk', slug: 'mira', name: 'Ю-Клуб на Мира', address: 'проспект Мира, 5', timezone: 'Asia/Omsk', status: 'preparing', phone: null },
];

// Пилот по макету (карта сайта п.4): 5 ПК, комната VR+PS4, комнаты PS5.
function seedResources(branchId: string) {
  const r = (id: string, zone: Zone, type: string, name: string, roomId: string | null, roomName: string | null, stepMinutes: number) =>
    ({ id: `${branchId}-${id}`, branchId, roomId, roomName, type, zone, name, stepMinutes, selfBookable: true as const });
  return [
    ...[1, 2, 3, 4, 5].map((n) => r(`pc${n}`, 'pc', 'pc', `ПК ${n}`, `${branchId}-pc-zone`, 'Зал ПК', 30)),
    r('vr1', 'vr', 'vr_seat', 'VR 1', `${branchId}-vr`, 'Комната VR+PS4', 30),
    r('vr2', 'vr', 'vr_seat', 'VR 2', `${branchId}-vr`, 'Комната VR+PS4', 30),
    r('vr-room', 'vr', 'room_whole', 'Вся комната', `${branchId}-vr`, 'Комната VR+PS4', 60),
    ...[1, 2, 3].map((n) => r(`ps5-${n}`, 'ps', 'ps_room', `PS5 ${n}`, `${branchId}-ps5-${n}`, `Комната PS5 ${n}`, 60)),
  ];
}

const isPublic = (s: Status) => s === 'active' || s === 'temporarily_closed';
const publicBranches = () => branches.filter((b) => isPublic(b.status));

function toDto(b: (typeof branches)[number]) {
  const { id, cityId, slug, name, address, timezone, status, phone } = b;
  return { id, cityId, slug, name, address, timezone, status, phone, publicContacts: {}, bookingWindow: { defaultDays: 7, maxDays: 30 }, holdMinutes: 10 };
}

function fail(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ error: { code, message, requestId: randomUUID() } });
}

/** Локальное «HH:MM» даты филиала → ISO UTC. Смещение зоны берём у Intl на эту дату (без DST в Сибири, но честно). */
function localToUtc(date: string, time: string, timezone: string): string {
  const guess = new Date(`${date}T${time}:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'longOffset' }).formatToParts(guess);
  const off = /GMT([+-])(\d{2}):(\d{2})/.exec(parts.find((p) => p.type === 'timeZoneName')?.value ?? '');
  const minutes = off ? (off[1] === '-' ? -1 : 1) * (Number(off[2]) * 60 + Number(off[3])) : 0;
  return new Date(guess.getTime() - minutes * 60_000).toISOString();
}

export function buildMock() {
  const app = Fastify({ logger: false });
  const P = '/api/public/v1';

  app.get(`${P}/cities`, async () => ({
    items: cities.filter((c) => publicBranches().some((b) => b.cityId === c.id)),
  }));

  app.get(`${P}/branches`, async (req) => {
    const { city } = req.query as { city?: string };
    const c = city ? cities.find((x) => x.slug === city) : null;
    const items = publicBranches().filter((b) => !city || b.cityId === c?.id);
    return { items: items.map(toDto) };
  });

  app.get(`${P}/branches/:id`, async (req, reply) => {
    const b = publicBranches().find((x) => x.id === (req.params as { id: string }).id);
    return b ? toDto(b) : fail(reply, 404, 'NOT_FOUND', 'Не найдено');
  });

  app.get(`${P}/branches/:id/resources`, async (req, reply) => {
    const b = publicBranches().find((x) => x.id === (req.params as { id: string }).id);
    if (!b) return fail(reply, 404, 'NOT_FOUND', 'Не найдено');
    const { zone } = req.query as { zone?: string };
    return { items: seedResources(b.id).filter((r) => !zone || r.zone === zone) };
  });

  app.get(`${P}/branches/:id/availability`, async (req, reply) => {
    const b = publicBranches().find((x) => x.id === (req.params as { id: string }).id);
    if (!b) return fail(reply, 404, 'NOT_FOUND', 'Не найдено');
    const { date } = req.query as { date?: string };
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail(reply, 400, 'VALIDATION_FAILED', 'Проверьте данные');
    const open = b.status === 'active';
    return {
      branchId: b.id, date, timezone: b.timezone,
      dayState: open ? 'open' : 'closed',
      openIntervals: open ? [{ start: localToUtc(date, '10:00', b.timezone), end: localToUtc(date, '22:00', b.timezone) }] : [],
      // Слоты – шаг S1-19; каркасу сайта нужны только часы дня.
      resources: [],
      generatedAt: new Date().toISOString(),
    };
  });

  registerClientAuth(app, P);
  return app;
}

// ---- Вход клиента (K9) – точно по apps/api/src/modules/clients/routes.public.ts и otp.ts:
// тот же ответ 202 на любой номер, коды ошибок, retry-after, кука yu_client. Код в моке всегда MOCK_CODE.
// Особые номера: …0429 – лимит запросов кода, …0503 – SMS не ушло, …0403 – клиент заблокирован.
export const MOCK_CODE = '123456';
const MAX_ATTEMPTS = 5;

interface Challenge { phone: string; attempts: number; expiresAt: number; used: boolean }
interface MockClient { id: string; phone: string; firstName: string | null; lastName: string | null; status: 'active' | 'restricted' | 'blocked'; consent: boolean }

const challenges = new Map<string, Challenge>();
const sessions = new Map<string, string>(); // token → clientId
const clients: MockClient[] = [
  { id: randomUUID(), phone: '+79131234567', firstName: 'Алина', lastName: 'Сафронова', status: 'active', consent: true },
  { id: randomUUID(), phone: '+79990000403', firstName: null, lastName: null, status: 'blocked', consent: true },
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

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

function meDto(c: MockClient) {
  return {
    id: c.id, phoneMasked: maskPhone(c.phone), firstName: c.firstName, lastName: c.lastName, email: null, birthDate: null,
    status: c.status, notifications: { remindersEnabled: true, marketingEnabled: false }, loyalty: null, certificates: null,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLEAR = 'yu_client=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';

function registerClientAuth(app: FastifyInstance, P: string) {
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
    const body = (req.body ?? {}) as { challengeId?: unknown; code?: unknown; consents?: { pdProcessing?: unknown } };
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
    if (!client) {
      client = { id: randomUUID(), phone: ch.phone, firstName: null, lastName: null, status: 'active', consent: true };
      clients.push(client);
    }
    ch.used = true;
    const token = randomUUID();
    sessions.set(token, client.id);
    reply.header('set-cookie', `yu_client=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${30 * 86400}`);
    return { client: meDto(client), isNew };
  });

  app.post(`${P}/auth/logout`, async (req, reply) => {
    const token = readCookie(req.headers.cookie, 'yu_client');
    if (token) sessions.delete(token);
    reply.header('set-cookie', CLEAR);
    return reply.code(204).send();
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

let lastForwardedFor: string | string[] | null = null;

if (import.meta.main) {
  const port = Number(process.env.MOCK_PORT ?? 4020);
  await buildMock().listen({ host: '127.0.0.1', port });
  console.log(`site mock-api: http://127.0.0.1:${port}`);
}

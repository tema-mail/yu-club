// Мок центра уведомлений и отписки (K21 §3, §11, K5 №201–206) – точно по apps/api/src/modules/notifications/routes.public.ts и inbox.ts:
// без сессии – 401 AUTH_REQUIRED; limit 1..50, иначе 400 VALIDATION_FAILED; неверный курсор – 400; порядок (at DESC, id DESC); реклама видна только
// при включённой «Рекламе»; чужая и несуществующая строка – 404 NOT_FOUND; read-all – Idempotency-Key (UUID) и { before } с повтором того же ответа;
// ответы личные – Cache-Control: no-store. Отписка: GET ничего не меняет; POST выключает рекламу; токен в моке – строка вместо HMAC:
// 'mock-unsub-<clientId>' – подлинный, 'mock-unsub-expired' – 410 UNSUBSCRIBE_TOKEN_EXPIRED, прочее – 400 UNSUBSCRIBE_TOKEN_INVALID.
// Только для e2e: POST /__test/inbox-reset – вернуть засев; GET /__test/inbox-calls – журнал запросов центра (значок не должен ходить без сессии).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { InboxItem, InboxPage } from '../src/lib/inbox.ts';
import { clients, fail, readCookie, sessions } from './mock-clients.ts';

type Category = 'service' | 'reminder' | 'marketing';
interface Row { id: string; clientId: string; title: string; body: string; category: Category; kind: string; at: number; read: boolean; url: string | null; booking: { id: string; state: 'active' | 'cancelled' | 'finished' | 'unavailable' } | null }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOUR = 3_600_000;
const n = (i: number) => `0b0a0000-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`;
let rows: Row[] = [];
const replays = new Map<string, unknown>();
const calls: string[] = [];

function seed() {
  const alina = clients.find((c) => c.phone === '+79131234567')!;
  const petr = clients.find((c) => c.phone === '+79135550000')!;
  const now = Date.now();
  rows = [
    { id: n(1), clientId: alina.id, title: 'Запись отменена клубом', body: 'Сеанс завтра в 14:00 отменён: клуб закрыт на санобработку.', category: 'service', kind: 'booking_cancelled', at: now - 1 * HOUR, read: false, url: '/account/', booking: { id: '0b0d0000-0000-4000-8000-0000000000a1', state: 'cancelled' } },
    { id: n(2), clientId: alina.id, title: 'Напоминание о сеансе', body: 'Завтра в 14:00, Ю-Клуб на Ленина.', category: 'reminder', kind: 'reminder_day_before', at: now - 2 * HOUR, read: false, url: '/account/', booking: { id: '0b0d0000-0000-4000-8000-0000000000a2', state: 'active' } },
    { id: n(3), clientId: alina.id, title: 'Реклама. Счастливые часы', body: 'По будням с 10 до 14 – скидка на зал ПК.', category: 'marketing', kind: 'campaign', at: now - 3 * HOUR, read: false, url: '/promotions/happy-hours/', booking: null },
    { id: n(4), clientId: alina.id, title: 'Запись подтверждена', body: 'Ждём вас в Ю-Клуб на Красном.', category: 'service', kind: 'booking_confirmed', at: now - 30 * HOUR, read: true, url: null, booking: { id: '0b0d0000-0000-4000-8000-0000000000a3', state: 'finished' } },
    { id: n(5), clientId: petr.id, title: 'Чужое уведомление', body: 'Не для Алины.', category: 'service', kind: 'booking_confirmed', at: now - HOUR, read: false, url: null, booking: null },
  ];
  replays.clear();
}

const marketingOn = (clientId: string) => clients.find((c) => c.id === clientId)?.prefs?.marketingEnabled ?? false;
const visible = (clientId: string) => rows.filter((r) => r.clientId === clientId && (r.category !== 'marketing' || marketingOn(clientId))).sort((a, b) => b.at - a.at || b.id.localeCompare(a.id));
const unread = (clientId: string) => visible(clientId).filter((r) => !r.read).length;
const dto = (r: Row): InboxItem => ({ id: r.id, title: r.title, body: r.body, category: r.category, kind: r.kind, at: new Date(r.at).toISOString(), read: r.read, url: r.url, booking: r.booking });

function session(req: FastifyRequest): string | null {
  const token = readCookie(req.headers.cookie, 'yu_client');
  return token ? (sessions.get(token) ?? null) : null;
}

export function registerNotifications(app: FastifyInstance, P: string) {
  seed();
  // { marketing: true } – у Алины включена «Реклама» (для отписки по ссылке).
  app.post('/__test/inbox-reset', async (req) => {
    seed();
    calls.length = 0;
    if ((req.body as { marketing?: unknown } | undefined)?.marketing === true) {
      const a = clients.find((c) => c.phone === '+79131234567')!;
      a.prefs = { remindersEnabled: a.prefs?.remindersEnabled ?? true, marketingEnabled: true };
    }
    return { ok: true };
  });
  app.get('/__test/inbox-calls', async () => calls);

  const authed = (req: FastifyRequest, reply: FastifyReply): string | null => {
    calls.push(`${req.method} ${req.url.split('?')[0]}`);
    const id = session(req);
    if (!id) fail(reply, 401, 'AUTH_REQUIRED', 'Нужно войти');
    reply.header('cache-control', 'no-store');
    return id;
  };

  // №201
  app.get(`${P}/me/notifications`, async (req, reply) => {
    const id = authed(req, reply);
    if (!id) return reply;
    const q = req.query as { cursor?: string; limit?: string };
    const limit = q.limit === undefined ? 20 : Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) return fail(reply, 400, 'VALIDATION_FAILED', 'Неверные данные запроса');
    let list = visible(id);
    if (q.cursor) {
      let pos: [string, string];
      try {
        pos = JSON.parse(Buffer.from(q.cursor, 'base64url').toString('utf8')) as [string, string];
        if (Number.isNaN(Date.parse(pos[0])) || !UUID.test(pos[1])) throw new Error('cursor');
      } catch {
        return fail(reply, 400, 'VALIDATION_FAILED', 'Неверный курсор');
      }
      const at = Date.parse(pos[0]);
      list = list.filter((r) => r.at < at || (r.at === at && r.id < pos[1]));
    }
    const page = list.slice(0, limit);
    const last = page.at(-1);
    const nextCursor = list.length > limit && last ? Buffer.from(JSON.stringify([new Date(last.at).toISOString(), last.id])).toString('base64url') : null;
    return { items: page.map(dto), nextCursor, unread: unread(id) } satisfies InboxPage;
  });

  // №202
  app.get(`${P}/me/notifications/unread-count`, async (req, reply) => {
    const id = authed(req, reply);
    if (!id) return reply;
    return { unread: unread(id) } satisfies Pick<InboxPage, 'unread'>;
  });

  // №203
  app.post(`${P}/me/notifications/:nid/read`, async (req, reply) => {
    const id = authed(req, reply);
    if (!id) return reply;
    const nid = (req.params as { nid: string }).nid.toLowerCase();
    const row = UUID.test(nid) ? visible(id).find((r) => r.id === nid) : undefined;
    if (!row) return fail(reply, 404, 'NOT_FOUND', 'Не найдено');
    row.read = true;
    return reply.code(204).send();
  });

  // №204
  app.post(`${P}/me/notifications/read-all`, async (req, reply) => {
    const id = authed(req, reply);
    if (!id) return reply;
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || !key.trim()) return fail(reply, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'Нужен заголовок Idempotency-Key');
    if (!UUID.test(key.trim())) return fail(reply, 400, 'VALIDATION_FAILED', 'Idempotency-Key должен быть UUID');
    const before = Date.parse(String((req.body as { before?: unknown } | undefined)?.before ?? ''));
    if (Number.isNaN(before)) return fail(reply, 400, 'VALIDATION_FAILED', 'Неверные данные запроса');
    const k = `${id}:${key}`;
    if (replays.has(k)) return reply.header('idempotent-replay', 'true').send(replays.get(k));
    let marked = 0;
    for (const r of visible(id)) {
      if (r.read || r.at > before) continue;
      r.read = true;
      marked++;
    }
    replays.set(k, { marked });
    return { marked };
  });

  // №205–206: отписка без входа
  const token = (t: unknown, reply: FastifyReply): string | null => {
    if (typeof t !== 'string' || !t || t.length > 512) return (fail(reply, 400, 'UNSUBSCRIBE_TOKEN_INVALID', 'Ссылка отписки недействительна'), null);
    if (t === 'mock-unsub-expired') return (fail(reply, 410, 'UNSUBSCRIBE_TOKEN_EXPIRED', 'Срок ссылки истёк, войдите в кабинет и выключите рекламу в настройках'), null);
    const id = t.startsWith('mock-unsub-') ? t.slice('mock-unsub-'.length) : '';
    if (!clients.some((c) => c.id === id)) return (fail(reply, 400, 'UNSUBSCRIBE_TOKEN_INVALID', 'Ссылка отписки недействительна'), null);
    return id;
  };
  app.get(`${P}/unsubscribe/check`, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const id = token((req.query as { t?: unknown }).t, reply);
    if (!id) return reply;
    return { valid: true, marketingEnabled: marketingOn(id) };
  });
  app.post(`${P}/unsubscribe`, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const id = token((req.body as { t?: unknown } | undefined)?.t, reply);
    if (!id) return reply;
    const c = clients.find((x) => x.id === id)!;
    c.prefs = { remindersEnabled: c.prefs?.remindersEnabled ?? true, marketingEnabled: false };
    return { marketingEnabled: false };
  });
  // Токен для e2e: в настоящем API его подписывает sender.ts (unsubscribeUrl) и кладёт в push.
  app.get('/__test/unsubscribe-token', async (req) => ({ t: `mock-unsub-${clients.find((c) => c.phone === (req.query as { phone?: string }).phone)?.id ?? 'none'}` }));
}

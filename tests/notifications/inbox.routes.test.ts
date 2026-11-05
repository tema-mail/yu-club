// S4-11: HTTP центра уведомлений K21 §11 №201–204 – только за сессией клиента, unread-count без кэша, read-all идемпотентен.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { clientAuthConfig, createDevSmsSender } from '../../apps/api/src/modules/clients/otp.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const BASE = '/api/public/v1';
let db: TestDatabase;
let pool: pg.Pool;
let app: FastifyInstance;
const clock = fixedClock('2026-11-14T10:00:00Z');
const sms = createDevSmsSender('dev');
const sessions: Record<string, { cookie: string; clientId: string }> = {};

async function login(phone: string): Promise<{ cookie: string; clientId: string }> {
  const req = await app.inject({ method: 'POST', url: `${BASE}/auth/otp/request`, headers: { 'idempotency-key': randomUUID() }, payload: { phone, purpose: 'login' } });
  const code = /\d{6}/.exec(sms.sent.at(-1)!.text)![0];
  const res = await app.inject({ method: 'POST', url: `${BASE}/auth/otp/verify`, payload: { challengeId: req.json().challengeId, code, consents: { pdProcessing: true } } });
  expect(res.statusCode).toBe(200);
  const clientId = (await db.client.query<{ id: string }>('SELECT id FROM app.clients WHERE phone_e164 = $1', [phone])).rows[0]!.id;
  return { cookie: String(res.headers['set-cookie']).split(';')[0]!, clientId };
}

async function notify(clientId: string, minutesAgo: number, bookingId: string | null = null): Promise<string> {
  const at = new Date(clock.now().getTime() - minutesAgo * 60_000);
  const r = await db.client.query<{ id: string }>(
    `INSERT INTO app.notifications (client_id, category, kind, booking_id, booking_version, source, title, body, url, planned_at, status, sent_at, dedupe_key)
     VALUES ($1, 'service', 'booking_confirmed', $2, 1, 'system', 'Запись подтверждена', '15 ноября, 14:00', '/account/bookings/', $3, 'sent_to_provider', $3, $4) RETURNING id`,
    [clientId, bookingId, at, `t:${randomUUID()}`],
  );
  return r.rows[0]!.id;
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), { clients: { pool, auth: clientAuthConfig('c'.repeat(40)), sms, clock } });
  sessions.a = await login('+79135550201');
  sessions.b = await login('+79135550202');
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await db.drop();
});

describe('центр уведомлений ЛК №201–204', () => {
  it('без сессии – 401 на все четыре маршрута', async () => {
    const id = randomUUID();
    for (const [method, url] of [
      ['GET', '/me/notifications'],
      ['GET', '/me/notifications/unread-count'],
      ['POST', `/me/notifications/${id}/read`],
      ['POST', '/me/notifications/read-all'],
    ] as const) {
      const res = await app.inject({ method, url: `${BASE}${url}`, headers: { 'idempotency-key': randomUUID() }, payload: method === 'POST' ? {} : undefined });
      expect([url, res.statusCode, res.json().error.code]).toEqual([url, 401, 'AUTH_REQUIRED']);
    }
  });

  it('список и unread-count: свои строки, no-store; брони нет в базе – «недоступна»', async () => {
    const { cookie, clientId } = sessions.a!;
    const n1 = await notify(clientId, 30, randomUUID());
    const n2 = await notify(clientId, 10);
    await notify(sessions.b!.clientId, 5);
    const count = await app.inject({ method: 'GET', url: `${BASE}/me/notifications/unread-count`, headers: { cookie } });
    expect([count.statusCode, count.headers['cache-control'], count.json()]).toEqual([200, 'no-store', { unread: 2 }]);
    const list = await app.inject({ method: 'GET', url: `${BASE}/me/notifications?limit=1`, headers: { cookie } });
    const body = list.json();
    expect(list.headers['cache-control']).toBe('no-store');
    expect(body.items.map((i: { id: string }) => i.id)).toEqual([n2]);
    expect(body.unread).toBe(2);
    const next = await app.inject({ method: 'GET', url: `${BASE}/me/notifications?limit=1&cursor=${body.nextCursor}`, headers: { cookie } });
    expect(next.json().items[0]).toMatchObject({ id: n1, category: 'service', read: false, url: '/account/bookings/', booking: { state: 'unavailable' } });
    const bad = await app.inject({ method: 'GET', url: `${BASE}/me/notifications?limit=500`, headers: { cookie } });
    expect(bad.statusCode).toBe(400);
  });

  it('прочтение: своя – 204, чужая – 404; read-all с ключом идемпотентен, без ключа – 400', async () => {
    const { cookie, clientId } = sessions.b!;
    const mine = await notify(clientId, 3);
    await notify(clientId, 2);
    const foreign = await notify(sessions.a!.clientId, 1);
    expect((await app.inject({ method: 'POST', url: `${BASE}/me/notifications/${mine}/read`, headers: { cookie } })).statusCode).toBe(204);
    const f = await app.inject({ method: 'POST', url: `${BASE}/me/notifications/${foreign}/read`, headers: { cookie } });
    expect([f.statusCode, f.json().error.code]).toEqual([404, 'NOT_FOUND']);

    const noKey = await app.inject({ method: 'POST', url: `${BASE}/me/notifications/read-all`, headers: { cookie }, payload: { before: clock.now().toISOString() } });
    expect([noKey.statusCode, noKey.json().error.code]).toEqual([400, 'IDEMPOTENCY_KEY_REQUIRED']);
    const key = randomUUID();
    const first = await app.inject({ method: 'POST', url: `${BASE}/me/notifications/read-all`, headers: { cookie, 'idempotency-key': key }, payload: { before: clock.now().toISOString() } });
    expect([first.statusCode, first.json()]).toEqual([200, { marked: 2 }]); // 5 мин назад (beforeAll) + 2 мин назад
    const again = await app.inject({ method: 'POST', url: `${BASE}/me/notifications/read-all`, headers: { cookie, 'idempotency-key': key }, payload: { before: clock.now().toISOString() } });
    expect([again.statusCode, again.json(), again.headers['idempotent-replay']]).toEqual([200, { marked: 2 }, 'true']);
    const count = await app.inject({ method: 'GET', url: `${BASE}/me/notifications/unread-count`, headers: { cookie } });
    expect(count.json()).toEqual({ unread: 0 });
  });
});

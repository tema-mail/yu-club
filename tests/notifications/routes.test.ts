// S1-15: HTTP /api/public/v1/me/push-subscriptions, /me/notification-settings, /push/vapid-public-key за сессией клиента; endpoint и ключи не попадают в лог.
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { clientAuthConfig, createDevSmsSender } from '../../apps/api/src/modules/clients/otp.ts';
import { generateVapidKeys } from '../../apps/api/src/modules/notifications/webpush.ts';
import { buildServer, depsFromConfig } from '../../apps/api/src/server.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';
import { fakeBrowser } from '../helpers/push-receiver.ts';

const BASE = '/api/public/v1';
let db: TestDatabase;
let pool: pg.Pool;
let app: FastifyInstance;
let bare: FastifyInstance;
let cookie: string;
let logs = '';
const clock = fixedClock('2026-11-14T10:00:00Z');
const sms = createDevSmsSender('dev');
const vapid = generateVapidKeys();
const ua = fakeBrowser();
const subscription = { endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`, keys: { p256dh: ua.p256dh, auth: ua.auth }, expirationTime: null };

const logStream = new Writable({
  write(chunk: Buffer, _enc, cb) {
    logs += chunk.toString();
    cb();
  },
});

async function login(phone: string): Promise<string> {
  const req = await app.inject({ method: 'POST', url: `${BASE}/auth/otp/request`, headers: { 'idempotency-key': randomUUID() }, payload: { phone, purpose: 'login' } });
  const code = /\d{6}/.exec(sms.sent.at(-1)!.text)![0];
  const res = await app.inject({ method: 'POST', url: `${BASE}/auth/otp/verify`, payload: { challengeId: req.json().challengeId, code, consents: { pdProcessing: true } } });
  expect(res.statusCode).toBe(200);
  return String(res.headers['set-cookie']).split(';')[0]!;
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
  const clients = { pool, auth: clientAuthConfig('c'.repeat(40)), sms, clock };
  app = buildServer(loadConfig({ LOG_LEVEL: 'trace' }), { logStream, clients, notifications: { vapidPublicKey: vapid.publicKey } });
  bare = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), { clients });
  cookie = await login('+79135550101');
});
afterAll(async () => {
  await app.close();
  await bare.close();
  await pool.end();
  await db.drop();
});

describe('открытый ключ VAPID', () => {
  it('отдаётся без входа; без ключей на сервере – 503 PUSH_NOT_CONFIGURED', async () => {
    const res = await app.inject({ method: 'GET', url: `${BASE}/push/vapid-public-key` });
    expect(res.json()).toEqual({ publicKey: vapid.publicKey });
    const none = await bare.inject({ method: 'GET', url: `${BASE}/push/vapid-public-key` });
    expect([none.statusCode, none.json().error.code]).toEqual([503, 'PUSH_NOT_CONFIGURED']);
  });
});

describe('подписка', () => {
  it('без сессии – 401 AUTH_REQUIRED', async () => {
    const res = await app.inject({ method: 'POST', url: `${BASE}/me/push-subscriptions`, payload: subscription });
    expect([res.statusCode, res.json().error.code]).toEqual([401, 'AUTH_REQUIRED']);
  });

  it('201 при первой, 200 с тем же id при повторе; чужой хост – 422; кривое тело – 400', async () => {
    const first = await app.inject({ method: 'POST', url: `${BASE}/me/push-subscriptions`, headers: { cookie }, payload: subscription });
    expect(first.statusCode).toBe(201);
    const again = await app.inject({ method: 'POST', url: `${BASE}/me/push-subscriptions`, headers: { cookie }, payload: subscription });
    expect([again.statusCode, again.json().id]).toEqual([200, first.json().id]);
    const evil = await app.inject({ method: 'POST', url: `${BASE}/me/push-subscriptions`, headers: { cookie }, payload: { ...subscription, endpoint: 'https://evil.example/x' } });
    expect([evil.statusCode, evil.json().error.code]).toEqual([422, 'PUSH_ENDPOINT_NOT_ALLOWED']);
    const bad = await app.inject({ method: 'POST', url: `${BASE}/me/push-subscriptions`, headers: { cookie }, payload: { endpoint: subscription.endpoint } });
    expect([bad.statusCode, bad.json().error.code]).toEqual([400, 'VALIDATION_FAILED']);
    const settings = await app.inject({ method: 'GET', url: `${BASE}/me/notification-settings`, headers: { cookie } });
    expect(settings.json().pushSubscriptions).toBe(1);
  });

  it('на сервере без VAPID подписка – 503, не сохраняется', async () => {
    const res = await bare.inject({ method: 'POST', url: `${BASE}/me/push-subscriptions`, headers: { cookie }, payload: { ...subscription, endpoint: `${subscription.endpoint}-x` } });
    expect(res.statusCode).toBe(503);
  });

  it('DELETE /{id} – 204, повтор, чужой и кривой id тоже 204', async () => {
    const { id } = (await app.inject({ method: 'POST', url: `${BASE}/me/push-subscriptions`, headers: { cookie }, payload: subscription })).json();
    const other = await login('+79135550102');
    const foreign = await app.inject({ method: 'DELETE', url: `${BASE}/me/push-subscriptions/${id}`, headers: { cookie: other } });
    expect(foreign.statusCode).toBe(204);
    const still = await app.inject({ method: 'GET', url: `${BASE}/me/notification-settings`, headers: { cookie } });
    expect(still.json().pushSubscriptions).toBe(1);
    for (const target of [id, id, 'not-a-uuid']) {
      const res = await app.inject({ method: 'DELETE', url: `${BASE}/me/push-subscriptions/${target}`, headers: { cookie } });
      expect(res.statusCode).toBe(204);
    }
    const settings = await app.inject({ method: 'GET', url: `${BASE}/me/notification-settings`, headers: { cookie } });
    expect(settings.json().pushSubscriptions).toBe(0);
  });
});

describe('отписка по endpoint и выход', () => {
  it('DELETE /me/push-subscriptions с {endpoint} – 204, подписка отозвана; endpoint не в URL', async () => {
    const own = { ...subscription, endpoint: `${subscription.endpoint}-del` };
    await app.inject({ method: 'POST', url: `${BASE}/me/push-subscriptions`, headers: { cookie }, payload: own });
    const res = await app.inject({ method: 'DELETE', url: `${BASE}/me/push-subscriptions`, headers: { cookie }, payload: { endpoint: own.endpoint } });
    expect(res.statusCode).toBe(204);
    const r = await db.client.query('SELECT revoke_reason FROM app.push_subscriptions WHERE endpoint = $1', [own.endpoint]);
    expect(r.rows[0]).toEqual({ revoke_reason: 'unsubscribed' });
  });

  it('выход (K9 №3) гасит подписку этой сессии с revoke_reason=logout, подписку другой сессии – нет', async () => {
    const s1 = await login('+79135550103');
    clock.advance(61_000); // пауза между кодами на номер (K7 otp_resend_cooldown_seconds)
    const s2 = await login('+79135550103');
    const a = { ...subscription, endpoint: `${subscription.endpoint}-s1` };
    const b = { ...subscription, endpoint: `${subscription.endpoint}-s2` };
    await app.inject({ method: 'POST', url: `${BASE}/me/push-subscriptions`, headers: { cookie: s1 }, payload: a });
    await app.inject({ method: 'POST', url: `${BASE}/me/push-subscriptions`, headers: { cookie: s2 }, payload: b });
    expect((await app.inject({ method: 'POST', url: `${BASE}/auth/logout`, headers: { cookie: s1 } })).statusCode).toBe(204);
    const r = await db.client.query<{ endpoint: string; revoke_reason: string | null }>(
      'SELECT endpoint, revoke_reason FROM app.push_subscriptions WHERE endpoint = ANY($1) ORDER BY endpoint',
      [[a.endpoint, b.endpoint]],
    );
    expect(r.rows.map((x) => x.revoke_reason)).toEqual(['logout', null]);
  });
});

describe('настройки', () => {
  it('GET – умолчания; PUT без Idempotency-Key – 400; PUT меняет, повтор ключа – idempotent-replay', async () => {
    const get = await app.inject({ method: 'GET', url: `${BASE}/me/notification-settings`, headers: { cookie } });
    expect(get.json()).toEqual({ remindersEnabled: true, marketingEnabled: false, serviceAlwaysOn: true, pushSubscriptions: 0 });
    const payload = { remindersEnabled: true, marketingEnabled: true };
    const noKey = await app.inject({ method: 'PUT', url: `${BASE}/me/notification-settings`, headers: { cookie }, payload });
    expect(noKey.json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const key = randomUUID();
    const put = await app.inject({ method: 'PUT', url: `${BASE}/me/notification-settings`, headers: { cookie, 'idempotency-key': key }, payload });
    expect([put.statusCode, put.json().marketingEnabled]).toEqual([200, true]);
    const replay = await app.inject({ method: 'PUT', url: `${BASE}/me/notification-settings`, headers: { cookie, 'idempotency-key': key }, payload });
    expect(replay.headers['idempotent-replay']).toBe('true');
    const me = await app.inject({ method: 'GET', url: `${BASE}/me`, headers: { cookie } });
    expect(me.json().notifications).toEqual({ remindersEnabled: true, marketingEnabled: true });
  });

  it('в логе сервера нет endpoint и ключей подписки', () => {
    expect(logs.length).toBeGreaterThan(0);
    expect(logs).not.toContain(ua.p256dh);
    expect(logs).not.toContain(subscription.endpoint.split('/').at(-1)!);
  });
});

describe('конфиг VAPID', () => {
  const env = { VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, VAPID_SUBJECT: 'mailto:ops@yu-club.test' };
  it('все три или ни одного; формат проверяется', () => {
    expect(() => loadConfig({ VAPID_PUBLIC_KEY: vapid.publicKey })).toThrow(/все три или ни одного/);
    expect(() => loadConfig({ ...env, VAPID_PRIVATE_KEY: 'short' })).toThrow(/VAPID_PRIVATE_KEY/);
    expect(() => loadConfig({ ...env, VAPID_SUBJECT: 'ops@yu-club.test' })).toThrow(/VAPID_SUBJECT/);
    expect(loadConfig({ PUSH_ENDPOINT_HOSTS: 'fcm.googleapis.com, *.push.apple.com' }).PUSH_ENDPOINT_HOSTS).toEqual(['fcm.googleapis.com', '*.push.apple.com']);
  });

  it('depsFromConfig: пара не сходится – ошибка запуска; сходится – ключ отдаётся маршрутам и диспетчеру', async () => {
    const other = generateVapidKeys();
    expect(() => depsFromConfig(loadConfig({ ...env, VAPID_PRIVATE_KEY: other.privateKey, DATABASE_URL: db.url }))).toThrow(/не соответствует/);
    const ok = depsFromConfig(loadConfig({ ...env, DATABASE_URL: db.url }));
    expect(ok.deps.notifications?.vapidPublicKey).toBe(vapid.publicKey);
    expect(ok.sender?.vapid?.publicKey).toBe(vapid.publicKey);
    await ok.close();
    const off = depsFromConfig(loadConfig({ DATABASE_URL: db.url }));
    expect([off.deps.notifications?.vapidPublicKey, off.sender?.vapid]).toEqual([null, null]);
    await off.close();
  });
});

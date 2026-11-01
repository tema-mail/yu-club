import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { clientAuthConfig, createDevSmsSender, unconfiguredSmsSender } from '../../apps/api/src/modules/clients/otp.ts';
import { buildServer, depsFromConfig } from '../../apps/api/src/server.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const BASE = '/api/public/v1';
const VISITOR = '7a0b4c1d-0000-4000-8000-0000000000aa';

let db: TestDatabase;
let pool: pg.Pool;
let app: FastifyInstance;
let logs = '';
const clock = fixedClock('2026-11-20T07:00:00Z');
const sms = createDevSmsSender('test');
const hookCalls: Array<{ clientId: string; visitorId: string | null }> = [];
const codes: string[] = [];
const tokens: string[] = [];

const logStream = new Writable({
  write(chunk: Buffer, _enc, cb) {
    logs += chunk.toString();
    cb();
  },
});

function requestCode(phone: string, key: string = randomUUID()) {
  return app.inject({ method: 'POST', url: `${BASE}/auth/otp/request`, headers: { 'idempotency-key': key }, payload: { phone, purpose: 'login' } });
}

async function codeFor(phone: string): Promise<{ challengeId: string; code: string }> {
  const res = await requestCode(phone);
  expect(res.statusCode).toBe(202);
  const code = /\d{6}/.exec(sms.sent.at(-1)!.text)![0];
  codes.push(code);
  return { challengeId: res.json().challengeId, code };
}

function verify(payload: object, cookie?: string) {
  return app.inject({ method: 'POST', url: `${BASE}/auth/otp/verify`, payload, headers: cookie ? { cookie } : {} });
}

async function login(phone: string): Promise<string> {
  const res = await verify({ ...(await codeFor(phone)), consents: { pdProcessing: true } });
  expect(res.statusCode).toBe(200);
  const cookie = String(res.headers['set-cookie']).split(';')[0]!;
  tokens.push(cookie.slice('yu_client='.length));
  return cookie;
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
  app = buildServer(loadConfig({ LOG_LEVEL: 'trace' }), {
    logStream,
    clients: {
      pool,
      auth: clientAuthConfig('c'.repeat(40)),
      sms,
      clock,
      hooks: { onLogin: async (_tx, x) => void hookCalls.push({ clientId: x.clientId, visitorId: x.visitorId }) },
    },
  });
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await db.drop();
});

describe('POST /auth/otp/request', () => {
  it('без Idempotency-Key – 400 IDEMPOTENCY_KEY_REQUIRED; кривой телефон – 400 VALIDATION_FAILED', async () => {
    const res = await app.inject({ method: 'POST', url: `${BASE}/auth/otp/request`, payload: { phone: '+79131234567', purpose: 'login' } });
    expect(res.json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect((await requestCode('12')).json().error.code).toBe('VALIDATION_FAILED');
  });

  it('202, повтор ключа – тот же ответ с Idempotent-Replay; слишком часто – 429 с Retry-After', async () => {
    const key = randomUUID();
    const a = await requestCode('+79134000001', key);
    expect(a.statusCode).toBe(202);
    expect(a.json()).toEqual({ challengeId: expect.any(String), resendAfterSec: 60, expiresInSec: 300 });
    const b = await requestCode('+79134000001', key);
    expect(b.headers['idempotent-replay']).toBe('true');
    expect(b.json()).toEqual(a.json());
    const c = await requestCode('+79134000001');
    expect(c.statusCode).toBe(429);
    expect(c.json().error).toMatchObject({ code: 'OTP_RATE_LIMITED', details: { resendAfterSec: 60 } });
    expect(c.headers['retry-after']).toBe('60');
  });
});

describe('POST /auth/otp/verify и сессия', () => {
  it('без галочки – 422 CONSENT_REQUIRED; с галочкой – кука yu_client HttpOnly; Secure; SameSite=Lax, токена в теле нет', async () => {
    const ch = await codeFor('+79134000002');
    const no = await verify(ch);
    expect(no.statusCode).toBe(422);
    expect(no.json().error.code).toBe('CONSENT_REQUIRED');
    const res = await verify({ ...ch, consents: { pdProcessing: true }, documentVersion: 'pd-2026-11' }, `yu_visitor=${VISITOR}`);
    expect(res.statusCode).toBe(200);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/^yu_client=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000$/);
    const token = cookie.split(';')[0]!.slice('yu_client='.length);
    tokens.push(token);
    expect(res.body).not.toContain(token);
    expect(res.json()).toEqual({
      isNew: true,
      client: {
        id: expect.any(String),
        phoneMasked: '+7 ••• ••• ••-02',
        firstName: null,
        lastName: null,
        email: null,
        birthDate: null,
        status: 'active',
        notifications: { remindersEnabled: true, marketingEnabled: false },
        loyalty: null,
        certificates: null,
      },
    });
    expect(hookCalls.at(-1)).toEqual({ clientId: res.json().client.id, visitorId: VISITOR });
  });

  it('неверный код – 401 OTP_INVALID с attemptsLeft; неизвестный запрос – 410 OTP_EXPIRED', async () => {
    const ch = await codeFor('+79134000003');
    const res = await verify({ ...ch, code: ch.code === '000000' ? '111111' : '000000' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toMatchObject({ code: 'OTP_INVALID', details: { attemptsLeft: 4 } });
    expect((await verify({ challengeId: randomUUID(), code: '123456' })).statusCode).toBe(410);
  });

  it('GET /me: с кукой – профиль; без – AUTH_REQUIRED; мусор – SESSION_REVOKED; после выхода – 401', async () => {
    const cookie = await login('+79134000004');
    const me = await app.inject({ method: 'GET', url: `${BASE}/me`, headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ phoneMasked: '+7 ••• ••• ••-04', status: 'active' });
    expect((await app.inject({ method: 'GET', url: `${BASE}/me` })).json().error.code).toBe('AUTH_REQUIRED');
    expect((await app.inject({ method: 'GET', url: `${BASE}/me`, headers: { cookie: 'yu_client=xxx' } })).json().error.code).toBe('SESSION_REVOKED');
    const out = await app.inject({ method: 'POST', url: `${BASE}/auth/logout`, headers: { cookie } });
    expect(out.statusCode).toBe(204);
    expect(String(out.headers['set-cookie'])).toMatch(/^yu_client=; .*Max-Age=0$/);
    expect((await app.inject({ method: 'GET', url: `${BASE}/me`, headers: { cookie } })).statusCode).toBe(401);
  });

  it('повторная регистрация = вход: isNew false, та же карточка', async () => {
    await login('+79134000005');
    clock.advance(61_000); // пауза между кодами
    const res = await verify(await codeFor('+79134000005'));
    expect(res.statusCode).toBe(200);
    expect(res.json().isNew).toBe(false);
  });
});

describe('боевой адаптер без провайдера и окружение', () => {
  it('503 SMS_UNAVAILABLE с Retry-After', async () => {
    const prod = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), {
      clients: { pool, auth: clientAuthConfig('c'.repeat(40)), sms: unconfiguredSmsSender, clock },
    });
    const res = await prod.inject({
      method: 'POST',
      url: `${BASE}/auth/otp/request`,
      headers: { 'idempotency-key': randomUUID() },
      payload: { phone: '+79134000009', purpose: 'login' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatchObject({ code: 'SMS_UNAVAILABLE', requestId: expect.any(String) });
    expect(res.headers['retry-after']).toBe('60');
    await prod.close();
  });

  it('production → боевой адаптер, иначе тестовый', async () => {
    const env = { DATABASE_URL: db.url, SESSION_PEPPER: 'z'.repeat(40) };
    const prod = depsFromConfig(loadConfig({ ...env, NODE_ENV: 'production' }));
    expect(prod.deps.clients?.sms).toBe(unconfiguredSmsSender);
    const dev = depsFromConfig(loadConfig({ ...env, NODE_ENV: 'development' }));
    expect(dev.deps.clients?.sms).not.toBe(unconfiguredSmsSender);
    await prod.close();
    await dev.close();
  });
});

describe('логи', () => {
  it('ни код, ни токен сессии не попали в лог сервера (лог при этом пишется)', () => {
    expect(logs).toContain('"reqId"');
    expect(codes.length).toBeGreaterThan(4);
    for (const code of codes) expect(logs).not.toContain(code);
    for (const token of tokens) expect(logs).not.toContain(token);
  });
});

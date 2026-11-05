// S4-19: отписка в один шаг K21 §4, §11 №205–206: токен HMAC, GET не меняет, POST меняет, повтор идемпотентен, частота с IP.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import { clientAuthConfig, createDevSmsSender } from '../../apps/api/src/modules/clients/otp.ts';
import { signUnsubscribeToken, unsubscribeUrl, verifyUnsubscribeToken } from '../../apps/api/src/modules/notifications/unsubscribe.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const BASE = '/api/public/v1';
const SECRET = 'u'.repeat(32);
let t = new Date('2026-11-20T06:00:00Z').getTime();
const clock = { now: () => new Date(t) };
let db: TestDatabase;
let pool: pg.Pool;
let app: FastifyInstance;
let bare: FastifyInstance;
let phone = 79190001000;
let ipN = 0;

async function client(marketing = true): Promise<string> {
  const id = (await db.client.query<{ id: string }>(`INSERT INTO app.clients (phone_e164, status, registered_at, created_by_type) VALUES ($1, 'active', now(), 'system') RETURNING id`, [`+${++phone}`])).rows[0]!.id;
  await db.client.query('INSERT INTO app.client_notification_prefs (client_id, marketing_enabled) VALUES ($1, $2)', [id, marketing]);
  if (marketing) {
    await db.client.query(`INSERT INTO journal.client_consents (client_id, kind, granted, document_version, source, actor_type, actor_id, at) VALUES ($1, 'marketing', true, 'v1', 'account', 'client', $1, '2026-01-01')`, [id]);
  }
  return id;
}
const token = (clientId: string) => unsubscribeUrl(SECRET, clientId, randomUUID(), clock.now()).split('t=')[1]!;
const prefs = async (id: string) => (await db.client.query<{ marketing_enabled: boolean }>('SELECT marketing_enabled FROM app.client_notification_prefs WHERE client_id = $1', [id])).rows[0]!.marketing_enabled;
const consents = async (id: string) => (await db.client.query<{ granted: boolean; source: string }>(`SELECT granted, source FROM journal.client_consents WHERE client_id = $1 AND kind = 'marketing' ORDER BY id`, [id])).rows;
const ip = () => `10.0.0.${++ipN}`;
const get = (tok: string, from = ip(), a = app) => a.inject({ method: 'GET', url: `${BASE}/unsubscribe/check?t=${encodeURIComponent(tok)}`, remoteAddress: from });
const post = (tok: unknown, from = ip(), a = app) => a.inject({ method: 'POST', url: `${BASE}/unsubscribe`, payload: { t: tok } as object, remoteAddress: from });

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
  const clients = { pool, auth: clientAuthConfig('c'.repeat(40)), sms: createDevSmsSender('dev'), clock };
  const notifications = { vapidPublicKey: null, unsubscribeSecret: SECRET };
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), { clients, notifications });
  bare = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), { clients });
});
afterAll(async () => {
  await app.close();
  await bare.close();
  await pool.end();
  await db.drop();
});
beforeEach(() => {
  t = new Date('2026-11-20T06:00:00Z').getTime();
});

describe('токен', () => {
  it('подпись и поля проверяются, чужой секрет и правка полезной части → INVALID; срок 90 дней → EXPIRED', () => {
    const id = randomUUID();
    const url = unsubscribeUrl(SECRET, id, null, clock.now());
    const tok = url.split('t=')[1]!;
    expect(url.startsWith('/unsubscribe/?t=')).toBe(true);
    expect(verifyUnsubscribeToken(SECRET, tok, clock.now())).toMatchObject({ clientId: id, campaignId: null });
    expect(() => verifyUnsubscribeToken('z'.repeat(32), tok, clock.now())).toThrow(expect.objectContaining({ code: 'UNSUBSCRIBE_TOKEN_INVALID' }));
    const [p, mac] = tok.split('.') as [string, string];
    const forged = Buffer.from(JSON.stringify([randomUUID(), null, 9_999_999_999])).toString('base64url');
    expect(() => verifyUnsubscribeToken(SECRET, `${forged}.${mac}`, clock.now())).toThrow(expect.objectContaining({ code: 'UNSUBSCRIBE_TOKEN_INVALID' }));
    expect(() => verifyUnsubscribeToken(SECRET, p, clock.now())).toThrow(expect.objectContaining({ code: 'UNSUBSCRIBE_TOKEN_INVALID' }));
    const later = new Date(clock.now().getTime() + 91 * 86_400_000);
    expect(() => verifyUnsubscribeToken(SECRET, tok, later)).toThrow(expect.objectContaining({ code: 'UNSUBSCRIBE_TOKEN_EXPIRED' }));
    const valid89 = new Date(clock.now().getTime() + 89 * 86_400_000);
    expect(verifyUnsubscribeToken(SECRET, tok, valid89).clientId).toBe(id);
  });
});

describe('№205–206', () => {
  it('GET не меняет согласие и не раскрывает клиента; POST меняет, пишет журнал, аудит, событие; повтор – тот же ответ без записей', async () => {
    const id = await client(true);
    const tok = token(id);
    for (let i = 0; i < 3; i++) {
      const g = await get(tok);
      expect([g.statusCode, g.json(), g.headers['cache-control']]).toEqual([200, { valid: true, marketingEnabled: true }, 'no-store']);
    }
    expect(await prefs(id)).toBe(true);
    expect(await consents(id)).toHaveLength(1);

    const first = await post(tok);
    expect([first.statusCode, first.json()]).toEqual([200, { marketingEnabled: false }]);
    expect(await prefs(id)).toBe(false);
    expect((await consents(id)).at(-1)).toEqual({ granted: false, source: 'site' });
    const again = await post(tok);
    expect([again.statusCode, again.json()]).toEqual([200, { marketingEnabled: false }]);
    expect(await consents(id)).toHaveLength(2);
    expect((await get(tok)).json()).toEqual({ valid: true, marketingEnabled: false });

    const audit = await db.client.query<{ source: string; actor_type: string; after: { via: string } }>(`SELECT source, actor_type, after FROM journal.audit_events WHERE action = 'notification.unsubscribed' AND object_id = $1`, [id]);
    expect(audit.rows).toEqual([expect.objectContaining({ source: 'site', actor_type: 'client', after: expect.objectContaining({ via: 'unsubscribe_link' }) })]);
    const ev = await db.client.query(`SELECT 1 FROM app.outbox_events WHERE event_type = 'client.notification_prefs_changed' AND aggregate_id = $1`, [id]);
    expect(ev.rowCount).toBe(1);
  });

  it('параллельные POST: одна запись журнала', async () => {
    const id = await client(true);
    const tok = token(id);
    const res = await Promise.all(Array.from({ length: 8 }, () => post(tok)));
    expect(res.every((r) => r.statusCode === 200)).toBe(true);
    expect(await consents(id)).toHaveLength(2);
  });

  it('поддельный → 400, просроченный → 410, пустой → 400; ничего не меняется', async () => {
    const id = await client(true);
    const bad = await post(signUnsubscribeToken('z'.repeat(32), { clientId: id, campaignId: null, exp: 9_999_999_999 }));
    expect([bad.statusCode, bad.json().error.code]).toEqual([400, 'UNSUBSCRIBE_TOKEN_INVALID']);
    expect((await get('мусор')).statusCode).toBe(400);
    expect((await post(undefined)).statusCode).toBe(400);
    const tok = token(id);
    t += 91 * 86_400_000;
    const old = await post(tok);
    expect([old.statusCode, old.json().error.code]).toEqual([410, 'UNSUBSCRIBE_TOKEN_EXPIRED']);
    expect(await prefs(id)).toBe(true);
  });

  it('11-й запрос в минуту с IP → 429 с Retry-After, другой IP и следующая минута – проходят; GET и POST считаются вместе', async () => {
    const id = await client(false);
    const tok = token(id);
    const from = ip();
    for (let i = 0; i < 5; i++) expect((await get(tok, from)).statusCode).toBe(200);
    for (let i = 0; i < 5; i++) expect((await post(tok, from)).statusCode).toBe(200);
    const over = await post(tok, from);
    expect([over.statusCode, over.json().error.code]).toEqual([429, 'RATE_LIMITED']);
    expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);
    expect((await get(tok)).statusCode).toBe(200);
    t += 60_000;
    expect((await post(tok, from)).statusCode).toBe(200);
  });

  it('без UNSUBSCRIBE_SECRET → 503 MARKETING_NOT_CONFIGURED, согласие не меняется', async () => {
    const id = await client(true);
    const res = await post(token(id), ip(), bare);
    expect([res.statusCode, res.json().error.code]).toEqual([503, 'MARKETING_NOT_CONFIGURED']);
    expect(await prefs(id)).toBe(true);
  });
});

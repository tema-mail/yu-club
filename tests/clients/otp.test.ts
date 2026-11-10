import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import {
  clientAuthConfig,
  createDevSmsSender,
  logoutClient,
  requestOtp,
  resolveClientSession,
  unconfiguredSmsSender,
  verifyOtp,
  type DevSmsSender,
  type VerifyInput,
} from '../../apps/api/src/modules/clients/otp.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

let db: TestDatabase;
let pool: pg.Pool;
let sms: DevSmsSender;
const clock = fixedClock('2026-11-20T07:00:00Z');
const cfg = clientAuthConfig('p'.repeat(40), { maxPerIpPerHour: 1000 });
const req = { requestId: 'req-otp', ip: '10.1.0.1' };
const MIN = 60_000;
const allCodes: string[] = [];

function lastCode(): string {
  const text = sms.sent.at(-1)!.text;
  const code = /\d{6}/.exec(text)![0];
  allCodes.push(code);
  return code;
}

async function ask(phone: string, r = req) {
  const res = await requestOtp(pool, cfg, clock, sms, { phone, idempotencyKey: randomUUID() }, r);
  clock.advance(cfg.resendCooldownSeconds * 1000 + 1000);
  return res;
}

async function askOk(phone: string): Promise<{ challengeId: string; code: string }> {
  const res = await ask(phone);
  expect(res.status).toBe(202);
  return { challengeId: (res.body as { challengeId: string }).challengeId, code: lastCode() };
}

const verify = (input: VerifyInput, hooks = {}) => verifyOtp(pool, cfg, clock, input, req, hooks);
const consent = { pdProcessing: true };

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 6 });
});
beforeEach(() => {
  sms = createDevSmsSender('dev');
});
afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('запрос кода', () => {
  it('ответ одинаков для существующего и нового номера', async () => {
    await db.client.query(
      `INSERT INTO app.clients (phone_e164, first_name, status, registered_at, created_by_type) VALUES ('+79130000001', 'Есть', 'active', now(), 'system')`,
    );
    const a = await ask('+79130000001');
    const b = await ask('+79130000002');
    const shape = (r: typeof a) => ({ status: r.status, keys: Object.keys(r.body as object).sort(), body: { ...(r.body as object), challengeId: 'x' } });
    expect(shape(a)).toEqual(shape(b));
    expect(a.body).toEqual({ challengeId: expect.any(String), resendAfterSec: 60, expiresInSec: 300 });
    // текст SMS без имени клиента
    expect(sms.sent.map((s) => s.text).join(' ')).not.toContain('Есть');
  });

  it('в базе только HMAC кода, idempotencyKey SMS = challengeId', async () => {
    const { challengeId, code } = await askOk('+79130000003');
    const r = await db.client.query('SELECT * FROM app.client_otp_challenges WHERE id = $1', [challengeId]);
    expect(r.rows[0].code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(r.rows[0])).not.toContain(code);
    expect(sms.sent.at(-1)!.idempotencyKey).toBe(challengeId);
  });

  it('пауза между кодами – 429 OTP_RATE_LIMITED с resendAfterSec', async () => {
    await requestOtp(pool, cfg, clock, sms, { phone: '+79130000004', idempotencyKey: randomUUID() }, req);
    clock.advance(10_000);
    const err = await requestOtp(pool, cfg, clock, sms, { phone: '+79130000004', idempotencyKey: randomUUID() }, req).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'OTP_RATE_LIMITED', httpStatus: 429, details: { resendAfterSec: 50 } });
    clock.advance(60_000);
  });

  it('не больше 5 кодов на номер в час', async () => {
    for (let i = 0; i < 5; i++) expect((await ask('+79130000005')).status).toBe(202);
    await expect(ask('+79130000005')).rejects.toMatchObject({ code: 'OTP_RATE_LIMITED' });
    clock.advance(60 * MIN);
    expect((await ask('+79130000005')).status).toBe(202);
  });

  it('лимит по IP: разные номера с одного адреса', async () => {
    const strict = clientAuthConfig('p'.repeat(40), { maxPerIpPerHour: 3 });
    const ip = { requestId: 'req-ip', ip: '10.2.0.9' };
    for (let i = 0; i < 3; i++) {
      expect((await requestOtp(pool, strict, clock, sms, { phone: `+7913100000${i}`, idempotencyKey: randomUUID() }, ip)).status).toBe(202);
    }
    await expect(requestOtp(pool, strict, clock, sms, { phone: '+79131000009', idempotencyKey: randomUUID() }, ip)).rejects.toMatchObject({
      code: 'OTP_RATE_LIMITED',
    });
    const other = { requestId: 'req-ip2', ip: '10.2.0.10' };
    expect((await requestOtp(pool, strict, clock, sms, { phone: '+79131000009', idempotencyKey: randomUUID() }, other)).status).toBe(202);
    clock.advance(2 * MIN);
  });

  it('тот же Idempotency-Key – тот же ответ, второе SMS не уходит', async () => {
    const key = randomUUID();
    const a = await requestOtp(pool, cfg, clock, sms, { phone: '+79130000006', idempotencyKey: key }, req);
    const b = await requestOtp(pool, cfg, clock, sms, { phone: '+79130000006', idempotencyKey: key }, req);
    expect(b).toEqual({ ...a, replayed: true });
    expect(sms.sent).toHaveLength(1);
    clock.advance(2 * MIN);
  });

  it('провайдер не настроен – 503 SMS_UNAVAILABLE, запрос кода сохранён, повтор ключа – тот же 503', async () => {
    const key = randomUUID();
    const a = await requestOtp(pool, cfg, clock, unconfiguredSmsSender, { phone: '+79130000007', idempotencyKey: key }, req);
    expect(a).toMatchObject({ status: 503, body: { error: { code: 'SMS_UNAVAILABLE', details: { resendAfterSec: 60 } } } });
    const b = await requestOtp(pool, cfg, clock, unconfiguredSmsSender, { phone: '+79130000007', idempotencyKey: key }, req);
    expect(b).toMatchObject({ status: 503, replayed: true });
    const n = await db.client.query("SELECT count(*)::int AS n FROM app.client_otp_challenges WHERE phone_e164 = '+79130000007'");
    expect(n.rows[0].n).toBe(1);
    clock.advance(2 * MIN);
  });

  it('тестовый адаптер: dev и stage – можно, prod и прочее – запрещён', () => {
    expect(() => createDevSmsSender('stage')).not.toThrow();
    expect(() => createDevSmsSender('prod')).toThrow(/APP_ENV=prod/);
    expect(() => createDevSmsSender('production')).toThrow(/APP_ENV/);
  });
});

describe('проверка кода', () => {
  it('новый клиент без галочки – 422 CONSENT_REQUIRED, код не гасится; с галочкой – active, согласие с версией и временем', async () => {
    const { challengeId, code } = await askOk('+79132000001');
    await expect(verify({ challengeId, code })).rejects.toMatchObject({ code: 'CONSENT_REQUIRED', httpStatus: 422 });
    await expect(verify({ challengeId, code, consents: { pdProcessing: false } })).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });
    // K9, K22 §7: страница согласия на рекламу не опубликована – галочка рекламы не принимается, код не гасится
    await expect(verify({ challengeId, code, consents: { pdProcessing: true, marketing: true }, documentVersion: 'pd-v7' })).rejects.toMatchObject({ code: 'MARKETING_DOCUMENT_MISSING', httpStatus: 409 });
    await db.client.query(
      `INSERT INTO app.content_pages (key, document_version, status, draft, draft_updated_at, draft_updated_by, created_by, created_at)
       VALUES ('advertising-consent', 'advertising-consent-2026-11-01', 'published', '{}', now(), gen_random_uuid(), gen_random_uuid(), now())`,
    );
    const r = await verify({ challengeId, code, consents: { pdProcessing: true, marketing: true }, documentVersion: 'pd-v7' });
    expect(r.isNew).toBe(true);
    expect(r.client).toMatchObject({ status: 'active', phoneMasked: '+7 ••• ••• ••-01', notifications: { remindersEnabled: true, marketingEnabled: true } });
    const c = await db.client.query(
      'SELECT kind, granted, document_version, source, at FROM journal.client_consents WHERE client_id = $1 ORDER BY id',
      [r.client.id],
    );
    expect(c.rows).toEqual([
      { kind: 'pd_processing', granted: true, document_version: 'pd-v7', source: 'site', at: clock.now() },
      { kind: 'marketing', granted: true, document_version: 'advertising-consent-2026-11-01', source: 'site', at: clock.now() },
    ]);
    // код погашен
    await expect(verify({ challengeId, code, consents: consent })).rejects.toMatchObject({ code: 'OTP_EXPIRED', httpStatus: 410 });
  });

  it('опубликовано согласие на ПДн – в журнале его живая версия, а не присланная сайтом (K22 §7)', async () => {
    await db.client.query(
      `INSERT INTO app.content_pages (key, document_version, status, draft, draft_updated_at, draft_updated_by, created_by, created_at)
       VALUES ('personal-data-consent', 'personal-data-consent-2026-11-01', 'published', '{}', now(), gen_random_uuid(), gen_random_uuid(), now())`,
    );
    const { challengeId, code } = await askOk('+79132000019');
    const r = await verify({ challengeId, code, consents: consent, documentVersion: 'pd-v7' });
    expect(r.isNew).toBe(true);
    const c = await db.client.query('SELECT kind, document_version FROM journal.client_consents WHERE client_id = $1', [r.client.id]);
    expect(c.rows).toEqual([{ kind: 'pd_processing', document_version: 'personal-data-consent-2026-11-01' }]);
    await db.client.query(`DELETE FROM app.content_pages WHERE key = 'personal-data-consent'`);
  });

  it('повторная регистрация = вход: та же карточка, согласие не спрашивается', async () => {
    const first = await askOk('+79132000002');
    const a = await verify({ ...first, consents: consent });
    const second = await askOk('+79132000002');
    const b = await verify(second);
    expect(b).toMatchObject({ isNew: false, client: { id: a.client.id } });
    const n = await db.client.query("SELECT count(*)::int AS n FROM app.clients WHERE phone_e164 = '+79132000002'");
    expect(n.rows[0].n).toBe(1);
  });

  it('guest → active без второй карточки, с согласием', async () => {
    const g = await db.client.query<{ id: string }>(
      `INSERT INTO app.clients (phone_e164, first_name, status, registration_source, created_by_type) VALUES ('+79132000003', 'Гость', 'guest', 'crm', 'staff') RETURNING id`,
    );
    const ch = await askOk('+79132000003');
    await expect(verify(ch)).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });
    const r = await verify({ ...ch, consents: consent });
    expect(r).toMatchObject({ isNew: true, client: { id: g.rows[0]!.id, status: 'active', firstName: 'Гость' } });
    const row = await db.client.query("SELECT status, registered_at, phone_verified_at FROM app.clients WHERE phone_e164 = '+79132000003'");
    expect(row.rows).toEqual([{ status: 'active', registered_at: clock.now(), phone_verified_at: clock.now() }]);
  });

  it('перевыпуск аннулирует старый код', async () => {
    const old = await askOk('+79132000004');
    const fresh = await askOk('+79132000004');
    await expect(verify({ ...old, consents: consent })).rejects.toMatchObject({ code: 'OTP_EXPIRED' });
    const s = await db.client.query('SELECT superseded_at FROM app.client_otp_challenges WHERE id = $1', [old.challengeId]);
    expect(s.rows[0].superseded_at).not.toBeNull();
    await expect(verify({ ...fresh, consents: consent })).resolves.toMatchObject({ isNew: true });
  });

  it('5 неверных – OTP_INVALID с attemptsLeft 4..0; 6-я попытка (даже верная) – OTP_EXPIRED', async () => {
    const { challengeId, code } = await askOk('+79132000005');
    const wrong = code === '000000' ? '111111' : '000000';
    for (let left = 4; left >= 0; left--) {
      await expect(verify({ challengeId, code: wrong })).rejects.toMatchObject({ code: 'OTP_INVALID', httpStatus: 401, details: { attemptsLeft: left } });
    }
    await expect(verify({ challengeId, code, consents: consent })).rejects.toMatchObject({ code: 'OTP_EXPIRED' });
  });

  it('истёкший код – OTP_EXPIRED; неизвестный challengeId – OTP_EXPIRED', async () => {
    const ch = await askOk('+79132000006');
    clock.advance(cfg.otpTtlSeconds * 1000);
    await expect(verify({ ...ch, consents: consent })).rejects.toMatchObject({ code: 'OTP_EXPIRED' });
    await expect(verify({ challengeId: randomUUID(), code: '123456' })).rejects.toMatchObject({ code: 'OTP_EXPIRED' });
    await expect(verify({ challengeId: 'nope', code: '123456' })).rejects.toMatchObject({ code: 'OTP_EXPIRED' });
  });

  it('заблокированный клиент – CLIENT_RESTRICTED, сессии нет', async () => {
    await db.client.query(
      `INSERT INTO app.clients (phone_e164, status, registered_at, created_by_type) VALUES ('+79132000007', 'blocked', now(), 'system')`,
    );
    const ch = await askOk('+79132000007');
    await expect(verify({ ...ch, consents: consent })).rejects.toMatchObject({ code: 'CLIENT_RESTRICTED', httpStatus: 403 });
  });

  it('хук входа (K5 attach) получает посетителя в транзакции входа; сбой хука отменяет вход', async () => {
    const calls: unknown[] = [];
    const ch = await askOk('+79132000008');
    const r = await verify({ ...ch, consents: consent, visitorId: 'v-1' }, { onLogin: async (_tx: unknown, x: unknown) => void calls.push(x) });
    expect(calls).toEqual([{ clientId: r.client.id, visitorId: 'v-1', at: clock.now() }]);

    const ch2 = await askOk('+79132000009');
    const fail = { onLogin: async () => Promise.reject(new Error('attach упал')) };
    await expect(verify({ ...ch2, consents: consent }, fail)).rejects.toThrow('attach упал');
    const n = await db.client.query("SELECT count(*)::int AS n FROM app.clients WHERE phone_e164 = '+79132000009'");
    expect(n.rows[0].n).toBe(0);
  });
});

describe('сессия', () => {
  it('в базе HMAC токена; выход отзывает; срок – session_days', async () => {
    const ch = await askOk('+79133000001');
    const r = await verify({ ...ch, consents: consent });
    const row = await db.client.query('SELECT token_hash, expires_at FROM app.client_sessions WHERE id = $1', [r.sessionId]);
    expect(row.rows[0].token_hash).not.toBe(r.token);
    expect(row.rows[0].expires_at).toEqual(new Date(clock.now().getTime() + 30 * 24 * 3600 * 1000));
    expect(await resolveClientSession(pool, cfg, r.token, clock)).toEqual({ clientId: r.client.id, sessionId: r.sessionId });
    await logoutClient(pool, clock, { clientId: r.client.id, sessionId: r.sessionId }, req);
    expect(await resolveClientSession(pool, cfg, r.token, clock)).toBeNull();
  });

  it('блокировка клиента – сессия не пускает; истёкшая – отзывается как expired', async () => {
    const ch = await askOk('+79133000002');
    const r = await verify({ ...ch, consents: consent });
    await db.client.query("UPDATE app.clients SET status = 'blocked' WHERE id = $1", [r.client.id]);
    expect(await resolveClientSession(pool, cfg, r.token, clock)).toBeNull();
    await db.client.query("UPDATE app.clients SET status = 'active' WHERE id = $1", [r.client.id]);
    clock.advance(31 * 24 * 3600 * 1000);
    expect(await resolveClientSession(pool, cfg, r.token, clock)).toBeNull();
    const s = await db.client.query('SELECT revoke_reason FROM app.client_sessions WHERE id = $1', [r.sessionId]);
    expect(s.rows[0].revoke_reason).toBe('expired');
  });
});

describe('секреты', () => {
  it('ни один выданный код и ни один токен не попал в аудит; журнал согласий – только вставка', async () => {
    expect(allCodes.length).toBeGreaterThan(10);
    const audit = await db.client.query('SELECT action, before, after, reason FROM journal.audit_events');
    const dump = JSON.stringify(audit.rows);
    for (const code of allCodes) expect(dump).not.toContain(code);
    expect(audit.rows.map((r) => r.action)).toEqual(expect.arrayContaining(['auth.client.login', 'auth.client.login_failed', 'client.created']));
    const v = await db.client.query('SELECT * FROM journal.append_only_violations()');
    expect(v.rows).toEqual([]);
  });
});

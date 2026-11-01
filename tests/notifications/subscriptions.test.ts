// S1-15: подписка Web Push и настройки уведомлений – функции модуля на настоящей Postgres.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import {
  DEFAULT_PUSH_HOSTS,
  MAX_ACTIVE_SUBSCRIPTIONS,
  getNotificationSettings,
  removePushSubscriptionById,
  removePushSubscriptionByEndpoint,
  revokeSessionSubscriptions,
  savePushSubscription,
  updateNotificationSettings,
  validateSubscription,
} from '../../apps/api/src/modules/notifications/index.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';
import { fakeBrowser } from '../helpers/push-receiver.ts';

let db: TestDatabase;
let pool: pg.Pool;
const clock = fixedClock('2026-11-14T10:00:00Z');
let phone = 79130002000;

async function newSession(clientId: string): Promise<string> {
  return (
    await db.client.query<{ id: string }>(
      `INSERT INTO app.client_sessions (client_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 day') RETURNING id`,
      [clientId, randomUUID()],
    )
  ).rows[0]!.id;
}

async function client(): Promise<{ id: string; sessionId: string; s: { clientId: string; sessionId: string }; meta: AuditRequestMeta }> {
  const id = (
    await db.client.query<{ id: string }>(
      `INSERT INTO app.clients (phone_e164, status, registered_at, created_by_type) VALUES ($1, 'active', now(), 'system') RETURNING id`,
      [`+${++phone}`],
    )
  ).rows[0]!.id;
  const sessionId = await newSession(id);
  return { id, sessionId, s: { clientId: id, sessionId }, meta: { actor: { kind: 'client', clientId: id, sessionId }, source: 'account', requestId: randomUUID() } };
}

const sub = (path: string = randomUUID()) => {
  const ua = fakeBrowser();
  return { endpoint: `https://fcm.googleapis.com/fcm/send/${path}`, keys: { p256dh: ua.p256dh, auth: ua.auth } };
};
const active = async (clientId: string) =>
  (await db.client.query<{ n: number }>('SELECT count(*)::int AS n FROM app.push_subscriptions WHERE client_id = $1 AND revoked_at IS NULL', [clientId])).rows[0]!.n;
const audit = async (clientId: string) =>
  (await db.client.query<{ action: string; after: unknown }>('SELECT action, after FROM journal.audit_events WHERE object_id = $1 ORDER BY id', [clientId])).rows;

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
});
afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('validateSubscription', () => {
  const ok = sub();
  it('известные push-сервисы проходят, чужой хост и http – 422, кривые ключи – 400', () => {
    expect(() => validateSubscription(ok, DEFAULT_PUSH_HOSTS)).not.toThrow();
    expect(() => validateSubscription({ ...ok, endpoint: 'https://api.push.apple.com/3/device/x' }, DEFAULT_PUSH_HOSTS)).not.toThrow();
    expect(() => validateSubscription({ ...ok, endpoint: 'https://fcm.googleapis.com:443/fcm/send/x' }, DEFAULT_PUSH_HOSTS)).not.toThrow();
    for (const endpoint of ['https://fcm.googleapis.com:8443/fcm/send/x', 'https://evil.example/fcm', 'http://fcm.googleapis.com/x', 'https://push.apple.com.evil.ru/x', 'https://169.254.169.254/latest']) {
      expect(() => validateSubscription({ ...ok, endpoint }, DEFAULT_PUSH_HOSTS), endpoint).toThrow(expect.objectContaining({ code: 'PUSH_ENDPOINT_NOT_ALLOWED' }));
    }
    expect(() => validateSubscription({ ...ok, endpoint: 'не адрес' }, DEFAULT_PUSH_HOSTS)).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    expect(() => validateSubscription({ ...ok, keys: { ...ok.keys, auth: 'AAAA' } }, DEFAULT_PUSH_HOSTS)).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });
  it('http://127.0.0.1 – только если хост явно в списке (тестовый приёмник)', () => {
    const local = { ...ok, endpoint: 'http://127.0.0.1:9999/p' };
    expect(() => validateSubscription(local, DEFAULT_PUSH_HOSTS)).toThrow();
    expect(() => validateSubscription(local, ['127.0.0.1'])).not.toThrow();
  });
});

describe('подписка', () => {
  it('сохраняется; повтор той же – идемпотентен (created=false, без второй строки и аудита)', async () => {
    const c = await client();
    const s = sub();
    const first = await savePushSubscription(pool, clock, c.s, s, DEFAULT_PUSH_HOSTS, c.meta);
    const again = await savePushSubscription(pool, clock, c.s, s, DEFAULT_PUSH_HOSTS, c.meta);
    expect(first.created).toBe(true);
    expect(again).toEqual({ id: first.id, created: false });
    expect(await active(c.id)).toBe(1);
    const a = await audit(c.id);
    expect(a.map((x) => x.action)).toEqual(['notification.push_subscribed']);
    expect(a[0]!.after).toEqual({ endpoint: 'fcm.googleapis.com/…', transferred: false, evicted: 0 });
    expect(JSON.stringify(a)).not.toContain(s.keys.p256dh);
  });

  it('тот же endpoint у другого клиента – переносится; новые ключи обновляются', async () => {
    const a = await client();
    const b = await client();
    const s = sub();
    const { id } = await savePushSubscription(pool, clock, a.s, s, DEFAULT_PUSH_HOSTS, a.meta);
    const moved = await savePushSubscription(pool, clock, b.s, { ...s, keys: sub().keys }, DEFAULT_PUSH_HOSTS, b.meta);
    expect(moved).toEqual({ id, created: false });
    expect([await active(a.id), await active(b.id)]).toEqual([0, 1]);
    expect((await audit(b.id))[0]!.after).toMatchObject({ transferred: true });
  });

  it('отписка: своя активная – revoked(unsubscribed); повтор и чужая – false; повторная подписка оживляет', async () => {
    const c = await client();
    const other = await client();
    const s = sub();
    const { id } = await savePushSubscription(pool, clock, c.s, s, DEFAULT_PUSH_HOSTS, c.meta);
    expect(await removePushSubscriptionById(pool, clock, other.id, id, other.meta)).toBe(false);
    expect(await removePushSubscriptionById(pool, clock, c.id, id, c.meta)).toBe(true);
    expect(await removePushSubscriptionById(pool, clock, c.id, id, c.meta)).toBe(false);
    expect(await active(c.id)).toBe(0);
    await savePushSubscription(pool, clock, c.s, s, DEFAULT_PUSH_HOSTS, c.meta);
    expect(await active(c.id)).toBe(1);
  });

  it(`не больше ${MAX_ACTIVE_SUBSCRIPTIONS} активных: самая старая гасится`, async () => {
    const c = await client();
    for (let i = 0; i <= MAX_ACTIVE_SUBSCRIPTIONS; i++) {
      clock.advance(1000);
      await savePushSubscription(pool, clock, c.s, sub(`many-${i}`), DEFAULT_PUSH_HOSTS, c.meta);
    }
    expect(await active(c.id)).toBe(MAX_ACTIVE_SUBSCRIPTIONS);
    const oldest = await db.client.query('SELECT revoke_reason FROM app.push_subscriptions WHERE endpoint LIKE $1', ['%/many-0']);
    expect(oldest.rows[0]).toEqual({ revoke_reason: 'unsubscribed' });
  });

  it('выход гасит только подписки своей сессии (logout); повторный вход переносит подписку на новую сессию', async () => {
    const c = await client();
    const phone2 = await newSession(c.id);
    const here = sub();
    await savePushSubscription(pool, clock, c.s, here, DEFAULT_PUSH_HOSTS, c.meta);
    await savePushSubscription(pool, clock, { clientId: c.id, sessionId: phone2 }, sub(), DEFAULT_PUSH_HOSTS, c.meta);
    expect(await revokeSessionSubscriptions(db.client, c.sessionId, clock.now())).toBe(1);
    expect(await active(c.id)).toBe(1);
    const r = await db.client.query('SELECT revoke_reason FROM app.push_subscriptions WHERE endpoint = $1', [here.endpoint]);
    expect(r.rows[0]).toEqual({ revoke_reason: 'logout' });
    // тот же браузер вошёл заново и подписался – подписка ожила и привязана к новой сессии
    const again = await newSession(c.id);
    await savePushSubscription(pool, clock, { clientId: c.id, sessionId: again }, here, DEFAULT_PUSH_HOSTS, c.meta);
    expect(await revokeSessionSubscriptions(db.client, again, clock.now())).toBe(1);
  });

  it('удаление по endpoint – только своей; чужая и повтор – false', async () => {
    const c = await client();
    const other = await client();
    const s = sub();
    await savePushSubscription(pool, clock, c.s, s, DEFAULT_PUSH_HOSTS, c.meta);
    expect(await removePushSubscriptionByEndpoint(pool, clock, other.id, s.endpoint, other.meta)).toBe(false);
    expect(await removePushSubscriptionByEndpoint(pool, clock, c.id, s.endpoint, c.meta)).toBe(true);
    expect(await removePushSubscriptionByEndpoint(pool, clock, c.id, s.endpoint, c.meta)).toBe(false);
    expect(await active(c.id)).toBe(0);
  });
});

describe('настройки уведомлений', () => {
  it('по умолчанию: напоминания вкл., реклама выкл., сервисные всегда', async () => {
    const c = await client();
    expect(await getNotificationSettings(pool, c.id)).toEqual({ remindersEnabled: true, marketingEnabled: false, serviceAlwaysOn: true, pushSubscriptions: 0 });
  });

  it('включение рекламы = согласие с версией; выключение напоминаний гасит плановые; событие и аудит; повтор ключа – тот же ответ', async () => {
    const c = await client();
    await db.client.query(
      `INSERT INTO app.notifications (client_id, category, kind, booking_id, booking_version, source, title, body, planned_at, dedupe_key)
       VALUES ($1, 'reminder', 'reminder_day_before', $2, 1, 'system', 't', 'b', now() + interval '1 day', $3),
              ($1, 'service', 'booking_confirmed', $2, 1, 'system', 't', 'b', now(), $4)`,
      [c.id, randomUUID(), `r:${randomUUID()}`, `s:${randomUUID()}`],
    );
    const key = randomUUID();
    const input = { remindersEnabled: false, marketingEnabled: true };
    const r = await updateNotificationSettings(pool, clock, c.id, input, key, c.meta);
    expect(r).toMatchObject({ status: 200, replayed: false, body: { remindersEnabled: false, marketingEnabled: true } });
    const replay = await updateNotificationSettings(pool, clock, c.id, input, key, c.meta);
    expect(replay).toMatchObject({ status: 200, replayed: true, body: r.body });

    const consents = await db.client.query('SELECT kind, granted, document_version, source FROM journal.client_consents WHERE client_id = $1 ORDER BY id', [c.id]);
    expect(consents.rows).toEqual([
      { kind: 'reminders', granted: false, document_version: null, source: 'account' },
      { kind: 'marketing', granted: true, document_version: 'marketing-2026-11', source: 'account' },
    ]);
    const n = await db.client.query('SELECT category, status FROM app.notifications WHERE client_id = $1 ORDER BY category', [c.id]);
    expect(n.rows).toEqual([
      { category: 'reminder', status: 'skipped_by_prefs' },
      { category: 'service', status: 'planned' },
    ]);
    const ev = await db.client.query('SELECT event_type, payload FROM app.outbox_events WHERE aggregate_id = $1', [c.id]);
    expect(ev.rows).toEqual([{ event_type: 'client.notification_prefs_changed', payload: { clientId: c.id, remindersEnabled: false, marketingEnabled: true } }]);
    expect((await audit(c.id)).map((x) => x.action)).toEqual(['client.consent_changed', 'client.consent_changed', 'client.notification_prefs_changed']);
  });

  it('то же значение – без согласий, аудита и события', async () => {
    const c = await client();
    await updateNotificationSettings(pool, clock, c.id, { remindersEnabled: true, marketingEnabled: false }, randomUUID(), c.meta);
    expect(await audit(c.id)).toEqual([]);
    expect((await db.client.query('SELECT 1 FROM journal.client_consents WHERE client_id = $1', [c.id])).rowCount).toBe(0);
  });
});

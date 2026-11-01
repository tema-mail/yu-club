// S1-16: отправка и журнал статусов – фейковый push-сервис на 127.0.0.1, настоящая Postgres, fixedClock.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { claimDue, runDue, sendNotification, type BookingLookup, type SenderDeps } from '../../apps/api/src/modules/notifications/sender.ts';
import { generateVapidKeys, vapidKeys } from '../../apps/api/src/modules/notifications/webpush.ts';
import { createTestBranch } from '../helpers/network.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';
import { decryptAes128gcm, fakeBrowser, startPushReceiver, verifyVapid, type FakeBrowser, type PushReceiver } from '../helpers/push-receiver.ts';

let db: TestDatabase;
let pool: pg.Pool;
let rx: PushReceiver;
let branchId: string;
const clock = fixedClock('2026-11-14T14:00:00Z');
const pair = generateVapidKeys();
const vapid = vapidKeys(pair.publicKey, pair.privateKey, 'mailto:ops@yu-club.test');
let deps: SenderDeps;
let phone = 79130001000;

async function client(prefs?: { reminders?: boolean; marketing?: boolean }): Promise<string> {
  const id = (
    await db.client.query<{ id: string }>(
      `INSERT INTO app.clients (phone_e164, status, registered_at, created_by_type) VALUES ($1, 'active', now(), 'system') RETURNING id`,
      [`+${++phone}`],
    )
  ).rows[0]!.id;
  if (prefs) {
    await db.client.query('INSERT INTO app.client_notification_prefs (client_id, reminders_enabled, marketing_enabled) VALUES ($1, $2, $3)', [
      id,
      prefs.reminders ?? true,
      prefs.marketing ?? false,
    ]);
  }
  return id;
}

async function subscribe(clientId: string, path: string, ua: FakeBrowser = fakeBrowser()): Promise<{ id: string; ua: FakeBrowser }> {
  const r = await db.client.query<{ id: string }>(
    'INSERT INTO app.push_subscriptions (client_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4) RETURNING id',
    [clientId, rx.endpoint(path), ua.p256dh, ua.auth],
  );
  return { id: r.rows[0]!.id, ua };
}

async function notification(clientId: string, over: Record<string, unknown> = {}): Promise<string> {
  const v = { category: 'service', kind: 'booking_confirmed', booking_id: randomUUID(), booking_version: 1, not_after: null, planned_at: clock.now(), ...over };
  const r = await db.client.query<{ id: string }>(
    `INSERT INTO app.notifications (client_id, branch_id, category, kind, booking_id, booking_version, source, title, body, url, planned_at, not_after, dedupe_key)
     VALUES ($1, $2, $3, $4, $5, $6, 'system', 'Ю-Клуб: запись подтверждена', '15 ноября, 14:00 – Центр, ПК 7', '/account/bookings/', $7, $8, $9) RETURNING id`,
    [clientId, branchId, v.category, v.kind, v.booking_id, v.booking_version, v.planned_at, v.not_after, `${String(v.kind)}:${randomUUID()}:1`],
  );
  return r.rows[0]!.id;
}

const row = async (id: string) =>
  (await db.client.query<{ status: string; skip_reason: string | null; error: string | null; attempts: number; retry_at: Date | null; sent_at: Date | null }>(
    'SELECT status, skip_reason, error, attempts, retry_at, sent_at FROM app.notifications WHERE id = $1',
    [id],
  )).rows[0]!;

async function queueAndSend(id: string, d: SenderDeps = deps) {
  await db.client.query(`UPDATE app.notifications SET status = 'queued' WHERE id = $1`, [id]);
  return sendNotification(d, id);
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
  rx = await startPushReceiver();
  branchId = (await createTestBranch(db.client)).id;
  deps = { pool, clock, vapid, timeoutMs: 300 };
});
afterAll(async () => {
  await rx.close();
  await pool.end();
  await db.drop();
});
beforeEach(() => {
  rx.received.length = 0;
  rx.respond.clear();
});

describe('отправка провайдеру', () => {
  it('201 → sent_to_provider; приёмник расшифровал тело, VAPID верный; журнал и аудит без endpoint и ключей', async () => {
    const c = await client();
    const { id: subId, ua } = await subscribe(c, '/p/ok-1');
    const id = await notification(c);
    expect(await runDue(deps)).toEqual({ sent_to_provider: 1 });
    expect(await row(id)).toMatchObject({ status: 'sent_to_provider', attempts: 1 });
    expect(rx.received).toHaveLength(1);
    const got = rx.received[0]!;
    expect(got.headers.ttl).toBe(String(12 * 3600));
    expect(got.headers.topic).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(verifyVapid(got.headers.authorization, pair.publicKey).aud).toBe(rx.origin);
    const msg = JSON.parse(decryptAes128gcm(got.body, ua).plaintext.toString());
    expect(msg).toMatchObject({ title: 'Ю-Клуб: запись подтверждена', url: '/account/bookings/', id });

    const d = await db.client.query('SELECT subscription_id, outcome, http_status, attempt FROM journal.notification_deliveries WHERE notification_id = $1', [id]);
    expect(d.rows).toEqual([{ subscription_id: subId, outcome: 'accepted', http_status: 201, attempt: 1 }]);
    const a = await db.client.query<{ action: string; actor_type: string; after: unknown }>(
      'SELECT action, actor_type, after FROM journal.audit_events WHERE object_id = $1',
      [id],
    );
    expect(a.rows.map((x) => [x.action, x.actor_type])).toEqual([['notification.sent', 'system']]);
    expect(JSON.stringify(a.rows)).not.toContain('127.0.0.1');
    expect(JSON.stringify(a.rows)).not.toContain(ua.p256dh);
  });

  it('повтор задачи для уже отправленной строки – not_queued, второго запроса нет (проверка 7)', async () => {
    const c = await client();
    await subscribe(c, '/p/ok-2');
    const id = await notification(c);
    expect(await queueAndSend(id)).toBe('sent_to_provider');
    expect(await sendNotification(deps, id)).toBe('not_queued');
    expect(rx.received).toHaveLength(1);
  });

  it('не наступившее не берётся; напоминание −15 мин – TTL 1 ч и Urgency high', async () => {
    const c = await client();
    await subscribe(c, '/p/ok-3');
    const later = await notification(c, { planned_at: new Date(clock.now().getTime() + 60_000) });
    const soon = await notification(c, { category: 'reminder', kind: 'reminder_before_start', not_after: new Date(clock.now().getTime() + 15 * 60_000) });
    expect(await claimDue(pool, clock.now())).toEqual([soon]);
    expect(await sendNotification(deps, soon)).toBe('sent_to_provider');
    expect(rx.received[0]!.headers).toMatchObject({ ttl: '3600', urgency: 'high' });
    expect((await row(later)).status).toBe('planned');
    await db.client.query(`UPDATE app.notifications SET status = 'cancelled' WHERE id = $1`, [later]); // не мешать следующим
  });
});

describe('нет канала и отзыв подписки', () => {
  it('без подписки – no_channel, строка остаётся для ЛК', async () => {
    const c = await client();
    const id = await notification(c);
    expect(await queueAndSend(id)).toBe('no_channel');
    expect(await row(id)).toMatchObject({ status: 'no_channel', skip_reason: 'no_subscription' });
    expect(rx.received).toHaveLength(0);
  });

  it('410 → подписка revoked(gone), уведомление no_channel; следующее – уже без запроса', async () => {
    const c = await client();
    const { id: subId } = await subscribe(c, '/p/gone');
    rx.respond.set('/p/gone', 410);
    const id = await notification(c);
    expect(await queueAndSend(id)).toBe('no_channel');
    expect(await row(id)).toMatchObject({ status: 'no_channel', skip_reason: 'subscriptions_gone' });
    const s = await db.client.query('SELECT revoke_reason FROM app.push_subscriptions WHERE id = $1', [subId]);
    expect(s.rows[0]).toEqual({ revoke_reason: 'gone' });
    const next = await notification(c);
    expect(await queueAndSend(next)).toBe('no_channel');
    expect(rx.received).toHaveLength(1);
  });

  it('две подписки: одна 410, другая 201 – sent_to_provider, мёртвая отозвана', async () => {
    const c = await client();
    const dead = await subscribe(c, '/p/dead');
    await subscribe(c, '/p/alive');
    rx.respond.set('/p/dead', 404);
    const id = await notification(c);
    expect(await queueAndSend(id)).toBe('sent_to_provider');
    expect((await db.client.query('SELECT revoke_reason FROM app.push_subscriptions WHERE id = $1', [dead.id])).rows[0]).toEqual({ revoke_reason: 'gone' });
  });

  it('без ключей VAPID – no_channel (push_not_configured)', async () => {
    const c = await client();
    await subscribe(c, '/p/novapid');
    const id = await notification(c);
    expect(await queueAndSend(id, { ...deps, vapid: null })).toBe('no_channel');
    expect((await row(id)).skip_reason).toBe('push_not_configured');
  });
});

describe('пропуски по настройкам и брони', () => {
  it('реклама без согласия – skipped_by_prefs; с согласием – уходит', async () => {
    const no = await client();
    await subscribe(no, '/p/m-no');
    const a = await notification(no, { category: 'marketing', kind: 'campaign', booking_id: null, booking_version: null });
    expect(await queueAndSend(a)).toBe('skipped_by_prefs');
    expect((await row(a)).skip_reason).toBe('marketing_not_consented');

    const yes = await client({ marketing: true });
    await subscribe(yes, '/p/m-yes');
    const b = await notification(yes, { category: 'marketing', kind: 'campaign', booking_id: null, booking_version: null });
    expect(await queueAndSend(b)).toBe('sent_to_provider');
    expect(rx.received).toHaveLength(1);
  });

  it('напоминания выключены: reminder пропущен, отмена клубом (service) уходит (09 §3.1)', async () => {
    const c = await client({ reminders: false });
    await subscribe(c, '/p/r-off');
    const r = await notification(c, { category: 'reminder', kind: 'reminder_day_before' });
    const cancel = await notification(c, { kind: 'booking_cancelled' });
    expect(await queueAndSend(r)).toBe('skipped_by_prefs');
    expect(await queueAndSend(cancel)).toBe('sent_to_provider');
  });

  it('сеанс уже начался (not_after) – skipped_booking_changed, без запроса', async () => {
    const c = await client();
    await subscribe(c, '/p/late');
    const id = await notification(c, { category: 'reminder', kind: 'reminder_before_start', not_after: clock.now() });
    expect(await queueAndSend(id)).toBe('skipped_booking_changed');
    expect((await row(id)).skip_reason).toBe('expired');
    expect(rx.received).toHaveLength(0);
  });

  it('BookingLookup: нет брони, отменена, перенесена, другой клиент – пропуск; «отменено клубом» по отменённой – уходит', async () => {
    const c = await client();
    await subscribe(c, '/p/booking');
    const state = new Map<string, Awaited<ReturnType<BookingLookup['snapshot']>>>();
    const d: SenderDeps = { ...deps, bookings: { snapshot: async (_tx, bookingId) => state.get(bookingId) ?? null } };
    const make = async (snap: Awaited<ReturnType<BookingLookup['snapshot']>>, kind = 'reminder_day_before') => {
      const bookingId = randomUUID();
      state.set(bookingId, snap);
      return notification(c, { category: kind === 'booking_cancelled' ? 'service' : 'reminder', kind, booking_id: bookingId });
    };
    const cases: Array<[string, string]> = [
      [await make(null), 'booking_missing'],
      [await make({ version: 1, clientId: c, state: 'cancelled' }), 'booking_cancelled'],
      [await make({ version: 1, clientId: c, state: 'finished' }), 'booking_finished'],
      [await make({ version: 2, clientId: c, state: 'active' }), 'booking_changed'],
      [await make({ version: 1, clientId: randomUUID(), state: 'active' }), 'client_changed'],
    ];
    for (const [id, reason] of cases) {
      expect(await queueAndSend(id, d)).toBe('skipped_booking_changed');
      expect((await row(id)).skip_reason).toBe(reason);
    }
    const ok = await make({ version: 1, clientId: c, state: 'cancelled' }, 'booking_cancelled');
    expect(await queueAndSend(ok, d)).toBe('sent_to_provider');
  });
});

describe('ошибки провайдера и повторы', () => {
  it('429 → повтор через 1, 5, 15 мин; после push_retry_limit (3) – error и аудит failed', async () => {
    const c = await client();
    await subscribe(c, '/p/busy');
    rx.respond.set('/p/busy', 429);
    const id = await notification(c);
    const delays: number[] = [];
    for (let i = 0; i < 3; i++) {
      expect(await queueAndSend(id)).toBe('retry');
      const r = await row(id);
      expect(r.status).toBe('planned');
      delays.push((r.retry_at!.getTime() - clock.now().getTime()) / 60_000);
    }
    expect(delays).toEqual([1, 5, 15]);
    expect(await queueAndSend(id)).toBe('error');
    expect(await row(id)).toMatchObject({ status: 'error', error: 'retries_exhausted', attempts: 4 });
    const a = await db.client.query('SELECT action FROM journal.audit_events WHERE object_id = $1', [id]);
    expect(a.rows).toEqual([{ action: 'notification.failed' }]);
  });

  it('повтор по retry_at забирает диспетчер, когда время пришло', async () => {
    const c = await client();
    await subscribe(c, '/p/flaky');
    rx.respond.set('/p/flaky', 503);
    const id = await notification(c);
    expect(await runDue(deps)).toEqual({ retry: 1 });
    rx.respond.set('/p/flaky', 201);
    expect(await runDue(deps)).toEqual({});
    clock.advance(60_000);
    expect(await runDue(deps)).toEqual({ sent_to_provider: 1 });
    expect((await row(id)).attempts).toBe(2);
  });

  it('тайм-аут – повтор (неизвестный исход); 403 – сразу error (повтор не поможет)', async () => {
    const c = await client();
    await subscribe(c, '/p/hang');
    rx.respond.set('/p/hang', 'hang');
    const t = await notification(c);
    expect(await queueAndSend(t)).toBe('retry');

    const c2 = await client();
    await subscribe(c2, '/p/forbidden');
    rx.respond.set('/p/forbidden', 403);
    const f = await notification(c2);
    expect(await queueAndSend(f)).toBe('error');
    expect((await row(f)).error).toBe('provider_rejected');
  });
});

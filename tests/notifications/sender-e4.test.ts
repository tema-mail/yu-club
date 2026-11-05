// S4-16: отправка Э4 K21 §7 на настоящей Postgres и приёмнике push: decideSend в send, тихие часы, частота под блокировкой,
// payload рекламы с отпиской, две очереди диспетчера. Весь файл идёт с чужим TZ процесса: время считается только по зоне филиала.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { claimDue, MARKETING_DISPATCH_LIMIT, sendNotification, type SenderDeps } from '../../apps/api/src/modules/notifications/sender.ts';
import { verifyUnsubscribeToken } from '../../apps/api/src/modules/notifications/unsubscribe.ts';
import { generateVapidKeys, vapidKeys } from '../../apps/api/src/modules/notifications/webpush.ts';
import { createTestBranch } from '../helpers/network.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';
import { decryptAes128gcm, fakeBrowser, startPushReceiver, type FakeBrowser, type PushReceiver } from '../helpers/push-receiver.ts';

const SECRET = 'u'.repeat(32);
const noon = fixedClock('2026-11-20T06:00:00Z'); // 13:00 НСК
const pair = generateVapidKeys();
const vapid = vapidKeys(pair.publicKey, pair.privateKey, 'mailto:ops@yu-club.test');
const prevTz = process.env.TZ;
let db: TestDatabase;
let pool: pg.Pool;
let rx: PushReceiver;
let branchId: string;
let deps: SenderDeps;
let phone = 79200001000;

async function client(o: { marketing?: boolean; sub?: boolean } = {}): Promise<{ id: string; ua: FakeBrowser }> {
  const id = (await db.client.query<{ id: string }>(`INSERT INTO app.clients (phone_e164, status, registered_at, created_by_type) VALUES ($1, 'active', now(), 'system') RETURNING id`, [`+${++phone}`])).rows[0]!.id;
  await db.client.query('INSERT INTO app.client_notification_prefs (client_id, marketing_enabled) VALUES ($1, $2)', [id, o.marketing ?? true]);
  if (o.marketing ?? true) {
    await db.client.query(`INSERT INTO journal.client_consents (client_id, kind, granted, document_version, source, actor_type, actor_id, at) VALUES ($1, 'marketing', true, 'v1', 'account', 'client', $1, '2026-01-01')`, [id]);
  }
  const ua = fakeBrowser();
  if (o.sub ?? true) {
    await db.client.query('INSERT INTO app.push_subscriptions (client_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4)', [id, rx.endpoint(`/e4/${randomUUID()}`), ua.p256dh, ua.auth]);
  }
  return { id, ua };
}

async function row(clientId: string, over: { category?: string; kind?: string; bookingId?: string | null; version?: number | null; status?: string; plannedAt?: Date } = {}): Promise<string> {
  const r = await db.client.query<{ id: string }>(
    `INSERT INTO app.notifications (client_id, branch_id, category, kind, booking_id, booking_version, source, title, body, url, planned_at, status, dedupe_key)
     VALUES ($1, $2, $3, $4, $5, $6, 'staff', 'Реклама. Акция', 'Текст', '/promotions/x/', $7, $8, $9) RETURNING id`,
    [clientId, branchId, over.category ?? 'marketing', over.kind ?? 'campaign', over.bookingId ?? null, over.version ?? null, over.plannedAt ?? noon.now(), over.status ?? 'queued', `t:${randomUUID()}`],
  );
  return r.rows[0]!.id;
}
const state = async (id: string) =>
  (await db.client.query<{ status: string; skip_reason: string | null; planned_at: Date }>('SELECT status, skip_reason, planned_at FROM app.notifications WHERE id = $1', [id])).rows[0]!;

beforeAll(async () => {
  process.env.TZ = 'America/New_York'; // чужой TZ процесса: смена суток у нас и там разная
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 12 });
  rx = await startPushReceiver();
  branchId = (await createTestBranch(db.client)).id;
  deps = { pool, clock: noon, vapid, timeoutMs: 3000, unsubscribeSecret: SECRET };
});
afterAll(async () => {
  if (prevTz === undefined) delete process.env.TZ;
  else process.env.TZ = prevTz;
  await rx.close();
  await pool.end();
  await db.drop();
});
beforeEach(() => {
  rx.received.length = 0;
});

describe('решение в send', () => {
  it('отказ после постановки в очередь → skipped_by_prefs marketing_off; запись согласия отозвана → no_marketing_consent; запроса нет', async () => {
    const a = await client();
    const id = await row(a.id);
    await db.client.query('UPDATE app.client_notification_prefs SET marketing_enabled = false WHERE client_id = $1', [a.id]);
    expect(await sendNotification(deps, id)).toBe('skipped_by_prefs');
    expect((await state(id)).skip_reason).toBe('marketing_off');
    const b = await client();
    const idB = await row(b.id);
    await db.client.query(`INSERT INTO journal.client_consents (client_id, kind, granted, source, actor_type, actor_id, at) VALUES ($1, 'marketing', false, 'site', 'client', $1, '2026-02-01')`, [b.id]);
    expect(await sendNotification(deps, idB)).toBe('skipped_by_prefs');
    expect((await state(idB)).skip_reason).toBe('no_marketing_consent');
    expect(rx.received).toHaveLength(0);
  });

  it('личное по брони: отмена → skipped_booking_changed, перенос (другая версия) → уходит; TTL 24 ч', async () => {
    const c = await client();
    const cancelled = randomUUID();
    const moved = randomUUID();
    const d: SenderDeps = {
      ...deps,
      bookings: {
        snapshot: async (_tx, id) => (id === cancelled ? { version: 1, clientId: c.id, state: 'cancelled' } : { version: 5, clientId: c.id, state: 'active' }),
      },
    };
    const a = await row(c.id, { category: 'service', kind: 'personal', bookingId: cancelled });
    expect(await sendNotification(d, a)).toBe('skipped_booking_changed');
    const b = await row(c.id, { category: 'service', kind: 'personal', bookingId: moved });
    expect(await sendNotification(d, b)).toBe('sent_to_provider');
    expect(rx.received[0]!.headers.ttl).toBe(String(24 * 3600));
  });

  it('реклама без UNSUBSCRIBE_SECRET не уходит: error, без запроса', async () => {
    const c = await client();
    const id = await row(c.id);
    expect(await sendNotification({ ...deps, unsubscribeSecret: null }, id)).toBe('error');
    expect(await state(id)).toMatchObject({ status: 'error', skip_reason: 'unsubscribe_not_configured' });
    expect(rx.received).toHaveLength(0);
  });
});

describe('payload рекламы', () => {
  it('кнопка и адрес отписки с подлинным токеном; у сервисного их нет; TTL рекламы 12 ч', async () => {
    const c = await client();
    const id = await row(c.id);
    expect(await sendNotification(deps, id)).toBe('sent_to_provider');
    const msg = JSON.parse(decryptAes128gcm(rx.received[0]!.body, c.ua).plaintext.toString());
    expect(rx.received[0]!.headers.ttl).toBe(String(12 * 3600));
    expect(msg.actions).toEqual([{ action: 'unsubscribe', title: 'Отписаться от акций' }]);
    expect(verifyUnsubscribeToken(SECRET, msg.unsubscribeUrl.split('t=')[1], noon.now()).clientId).toBe(c.id);

    const s = await client();
    const sid = await row(s.id, { category: 'service', kind: 'personal', bookingId: randomUUID() });
    expect(await sendNotification(deps, sid)).toBe('sent_to_provider');
    const smsg = JSON.parse(decryptAes128gcm(rx.received[1]!.body, s.ua).plaintext.toString());
    expect(smsg.actions).toBeUndefined();
    expect(smsg.unsubscribeUrl).toBeUndefined();
  });
});

describe('тихие часы', () => {
  it('23:00 по НСК → обратно planned на 10:00 следующего дня, запроса нет; потом уходит; сервисное в 23:00 – сразу', async () => {
    const night = fixedClock('2026-11-20T16:00:00Z');
    const c = await client();
    const id = await row(c.id);
    expect(await sendNotification({ ...deps, clock: night }, id)).toBe('rescheduled');
    const st = await state(id);
    expect([st.status, st.planned_at.toISOString()]).toEqual(['planned', '2026-11-21T03:00:00.000Z']);
    expect(rx.received).toHaveLength(0);
    expect(await claimDue(pool, night.now())).not.toContain(id);
    const morning = fixedClock('2026-11-21T03:00:00Z');
    expect(await claimDue(pool, morning.now())).toContain(id);
    expect(await sendNotification({ ...deps, clock: morning }, id)).toBe('sent_to_provider');
    const s = await row(c.id, { category: 'service', kind: 'personal', bookingId: randomUUID() });
    expect(await sendNotification({ ...deps, clock: night }, s)).toBe('sent_to_provider');
  });
});

describe('частота', () => {
  it('вторая реклама через 2 дня → skipped_by_frequency; через 8 дней – уходит', async () => {
    const c = await client();
    expect(await sendNotification(deps, await row(c.id))).toBe('sent_to_provider');
    const d2 = fixedClock('2026-11-22T06:00:00Z');
    const second = await row(c.id);
    expect(await sendNotification({ ...deps, clock: d2 }, second)).toBe('skipped_by_frequency');
    expect((await state(second)).skip_reason).toBe('min_interval');
    const d8 = fixedClock('2026-11-28T06:00:00Z');
    expect(await sendNotification({ ...deps, clock: d8 }, await row(c.id))).toBe('sent_to_provider');
  });

  it('две рекламы одному клиенту из двух кампаний параллельно 100 раз → всегда ушла одна', async () => {
    for (let i = 0; i < 100; i++) {
      const c = await client();
      const [a, b] = [await row(c.id), await row(c.id)];
      const res = await Promise.all([sendNotification(deps, a), sendNotification(deps, b)]);
      expect(res.sort()).toEqual(['sent_to_provider', 'skipped_by_frequency']);
    }
    expect(rx.received).toHaveLength(100);
  }, 120_000);
});

describe('две очереди диспетчера', () => {
  it('1000 рекламных строк не задерживают напоминание −15 мин; реклама не больше своей пачки', async () => {
    const c = await client();
    const earlier = new Date(noon.now().getTime() - 3600_000);
    await db.client.query(
      `INSERT INTO app.notifications (client_id, branch_id, category, kind, source, title, body, planned_at, dedupe_key)
       SELECT $1, $2, 'marketing', 'campaign', 'staff', 'т', 'б', $3, 'bulk:' || g FROM generate_series(1, 1000) g`,
      [c.id, branchId, earlier],
    );
    const reminder = await row(c.id, { category: 'reminder', kind: 'reminder_before_start', bookingId: randomUUID(), version: 1, status: 'planned' });
    const ids = await claimDue(pool, noon.now());
    expect(ids[0]).toBe(reminder);
    expect(ids).toHaveLength(1 + MARKETING_DISPATCH_LIMIT);
    await db.client.query(`DELETE FROM app.notifications WHERE dedupe_key LIKE 'bulk:%'`);
  });
});

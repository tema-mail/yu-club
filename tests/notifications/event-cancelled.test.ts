// S4-29 (K20 §12, K21 §2, §247): event.cancelled и event.rescheduled → сервисное заказчику с профилем. Заказчик с выключенными напоминаниями и рекламой получает;
// без профиля – ничего (Q-116); повтор события – одна строка; категория service, а не event_cancel; «было/стало» по зоне филиала; перенос после отмены не пишет; события идут через настоящий outbox.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearSubscriptions, processEvent, publish, type EventPayload } from '../../apps/api/src/core/outbox.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { bookingLookup } from '../../apps/api/src/modules/booking/providers.ts';
import { HANDLERS, registerNotificationHandlers } from '../../apps/api/src/modules/notifications/handlers.ts';
import { runDue } from '../../apps/api/src/modules/notifications/sender.ts';
import { createTestBranch } from '../helpers/network.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const clock = fixedClock('2026-11-14T05:00:00Z');
let db: TestDatabase;
let pool: pg.Pool;
let branchId: string;
let phone = 79150000000;
let version = 1;

const client = async () => {
  const id = (await db.client.query<{ id: string }>(`INSERT INTO app.clients (phone_e164, status, created_by_type) VALUES ($1, 'active', 'system') RETURNING id`, [`+${phone++}`])).rows[0]!.id;
  await db.client.query(`INSERT INTO app.client_notification_prefs (client_id, reminders_enabled, marketing_enabled) VALUES ($1, false, false)`, [id]);
  return id;
};
async function emit<T extends 'event.cancelled' | 'event.rescheduled'>(type: T, eventId: string, payload: EventPayload<T>): Promise<string> {
  const r = await publish(db.client, { type, aggregateType: 'event', aggregateId: eventId, aggregateVersion: type === 'event.cancelled' ? 'cancelled' : version++, branchId, occurredAt: clock.now(), payload });
  return r.eventId;
}
const cancelled = (eventId: string, customerClientId: string | null) => emit('event.cancelled', eventId, { eventId, branchId, customerClientId, reason: 'служебная причина', linkedBookingIds: [], giftIds: [] });
const moved = (eventId: string, customerClientId: string | null, start = '2026-11-20T12:00:00Z') =>
  emit('event.rescheduled', eventId, {
    eventId, branchId, customerClientId,
    previous: { start: '2026-11-18T12:00:00Z', end: '2026-11-18T14:00:00Z' },
    current: { start, end: '2026-11-20T14:00:00Z' },
  });
const rows = async (clientId: string) =>
  (await db.client.query<{ id: string; category: string; kind: string; title: string; body: string; status: string; booking_id: string | null; dedupe_key: string; source: string }>(
    `SELECT id, category, kind, title, body, status, booking_id, dedupe_key, source FROM app.notifications WHERE client_id = $1 ORDER BY created_at, id`,
    [clientId],
  )).rows;

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
  branchId = (await createTestBranch(db.client, { timezone: 'Asia/Novosibirsk' })).id;
  clearSubscriptions();
  registerNotificationHandlers({ bookings: bookingLookup, clock });
});
afterAll(async () => {
  clearSubscriptions();
  await pool.end();
  await db.drop();
});

describe('event.cancelled', () => {
  it('заказчику с выключенными напоминаниями и рекламой – service, kind event_cancelled, сообщение уходит; причина сотрудника в текст не попадает', async () => {
    const c = await client();
    const eventId = randomUUID();
    await processEvent(pool, HANDLERS.eventCancelled, await cancelled(eventId, c), clock.now());
    const [row] = await rows(c);
    expect(row).toMatchObject({ category: 'service', kind: 'event_cancelled', booking_id: null, source: 'system', status: 'planned', dedupe_key: `event_cancelled:${eventId}:cancelled` });
    expect(row!.title).toContain('отменено');
    expect(row!.body).not.toContain('служебная');
    await runDue({ pool, clock, vapid: null });
    expect((await rows(c))[0]!.status).toBe('no_channel'); // не skipped_by_prefs: нет подписки – остаётся в центре уведомлений
  });

  it('без профиля – ничего (Q-116); повтор события – одна строка', async () => {
    const before = Number((await db.client.query<{ n: string }>(`SELECT count(*) AS n FROM app.notifications`)).rows[0]!.n);
    await processEvent(pool, HANDLERS.eventCancelled, await cancelled(randomUUID(), null), clock.now());
    expect(Number((await db.client.query<{ n: string }>(`SELECT count(*) AS n FROM app.notifications`)).rows[0]!.n)).toBe(before);
    const c = await client();
    const eventId = randomUUID();
    const id = await cancelled(eventId, c);
    await processEvent(pool, HANDLERS.eventCancelled, id, clock.now());
    await processEvent(pool, HANDLERS.eventCancelled, id, clock.now());
    await db.client.query(`DELETE FROM app.processed_events WHERE event_id = $1`, [id]); // гаснет и повтор мимо processed_events
    await processEvent(pool, HANDLERS.eventCancelled, id, clock.now());
    expect(await rows(c)).toHaveLength(1);
  });
});

describe('event.rescheduled', () => {
  it('service, kind event_rescheduled, «было/стало» по зоне филиала; повтор – одна строка', async () => {
    const c = await client();
    const eventId = randomUUID();
    const id = await moved(eventId, c);
    await processEvent(pool, HANDLERS.eventRescheduled, id, clock.now());
    await processEvent(pool, HANDLERS.eventRescheduled, id, clock.now());
    await db.client.query(`DELETE FROM app.processed_events WHERE event_id = $1`, [id]);
    await processEvent(pool, HANDLERS.eventRescheduled, id, clock.now());
    const list = await rows(c);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ category: 'service', kind: 'event_rescheduled' });
    expect(list[0]!.body).toContain('Было: 18 ноября, 19:00'); // 12:00 UTC = 19:00 НСК
    expect(list[0]!.body).toContain('Стало: 20 ноября, 19:00');
  });

  it('второй перенос – новая строка; перенос, дошедший после отмены, не пишет; без профиля – ничего', async () => {
    const c = await client();
    const eventId = randomUUID();
    await processEvent(pool, HANDLERS.eventRescheduled, await moved(eventId, c), clock.now());
    await processEvent(pool, HANDLERS.eventRescheduled, await moved(eventId, c, '2026-11-21T12:00:00Z'), clock.now());
    expect(await rows(c)).toHaveLength(2);
    const late = await moved(eventId, c, '2026-11-22T12:00:00Z');
    await processEvent(pool, HANDLERS.eventCancelled, await cancelled(eventId, c), clock.now());
    await processEvent(pool, HANDLERS.eventRescheduled, late, clock.now());
    const kinds = (await rows(c)).map((r) => r.kind).sort();
    expect(kinds).toEqual(['event_cancelled', 'event_rescheduled', 'event_rescheduled']);
    await processEvent(pool, HANDLERS.eventRescheduled, await moved(randomUUID(), null), clock.now());
  });
});

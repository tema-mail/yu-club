// K14 §Подписки: события брони → плановые уведомления через настоящие команды (confirm, change.ts) и processEvent.
// Подтверждение → booking_confirmed + напоминания; перенос → старые skipped, «было/стало» и новые напоминания;
// отмена клубом → booking_cancelled, отмена клиентом – без сообщения; устаревшее событие не планирует;
// повторная доставка – duplicate; BookingLookup.snapshot по таблице броней (проверки 1–4 перед отправкой).
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { clearSubscriptions, processEvent } from '../../apps/api/src/core/outbox.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import type { Clock } from '../../apps/api/src/core/time.ts';
import { cancelBooking, rescheduleBooking } from '../../apps/api/src/modules/booking/change.ts';
import { confirmHold } from '../../apps/api/src/modules/booking/confirm.ts';
import { createHold } from '../../apps/api/src/modules/booking/hold.ts';
import { runOccupancyCommand } from '../../apps/api/src/modules/booking/occupancy.ts';
import { bookingLookup } from '../../apps/api/src/modules/booking/providers.ts';
import { HANDLERS, registerNotificationHandlers } from '../../apps/api/src/modules/notifications/handlers.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const SYS = '00000000-0000-0000-0000-000000000001';
const t = new Date('2026-11-14T05:00:00Z').getTime(); // 12:00 Новосибирска
const clock: Clock = { now: () => new Date(t) };
let db: TestDatabase;
let pool: pg.Pool;
const ids: Record<string, string> = {};
let phones = 3_000_000;
let admin: AccessContext;

async function one<T = { id: string }>(sql: string, params: unknown[] = []): Promise<T> {
  return (await db.client.query(sql, params)).rows[0] as T;
}
async function book(iso: string): Promise<{ id: string; clientId: string }> {
  const clientId = (await one(`INSERT INTO app.clients (phone_e164, status, created_by_type) VALUES ($1, 'active', 'system') RETURNING id`, [`+7913${phones++}`])).id;
  const h = await runOccupancyCommand(pool, (c) => createHold(c, { clientId, visitorId: null }, { branchId: ids.b1!, items: [{ resourceId: ids.pc!, start: new Date(iso), end: new Date(Date.parse(iso) + 3_600_000) }] }, clock));
  return { id: (await runOccupancyCommand(pool, (c) => confirmHold(c, clientId, h.id, clock))).bookings[0]!.id, clientId };
}
const eventId = async (type: string, bookingId: string) => (await one(`SELECT id FROM app.outbox_events WHERE event_type = $1 AND aggregate_id = $2 ORDER BY id DESC LIMIT 1`, [type, bookingId])).id;
const deliver = async (handler: string, type: string, bookingId: string) => processEvent(pool, handler, await eventId(type, bookingId), clock.now());
const rows = async (bookingId: string) =>
  (await db.client.query<{ kind: string; status: string; booking_version: number }>(`SELECT kind, status, booking_version FROM app.notifications WHERE booking_id = $1 ORDER BY booking_version, kind`, [bookingId])).rows;
const meta: AuditRequestMeta = { actor: { kind: 'staff', staffId: SYS, sessionId: 's' }, source: 'crm', requestId: 'r' };

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 6 });
  const city = await one(`INSERT INTO app.cities (code, slug, name, timezone) VALUES ('nsk', 'nsk', 'НСК', 'Asia/Novosibirsk') RETURNING id`);
  ids.b1 = (await one(`INSERT INTO app.branches (city_id, code, slug, name, address, timezone, status) VALUES ($1, 'b1', 'b1', 'b1', 'адрес', 'Asia/Novosibirsk', 'active') RETURNING id`, [city.id])).id;
  await db.client.query(`INSERT INTO app.branch_weekly_hours (branch_id, weekday, open_time, close_time, valid_from, created_by) SELECT $1, d, '10:00', '22:00', '2026-01-01', $2 FROM generate_series(1, 7) d`, [ids.b1, SYS]);
  await db.client.query(`INSERT INTO app.tariffs (branch_id, resource_type, name, unit_minutes, price_per_unit_kop, valid_from, status, created_by) VALUES ($1, 'pc', 'pc', 30, 20000, '2026-01-01', 'active', $2)`, [ids.b1, SYS]);
  const u = await one(`INSERT INTO app.occupancy_units (branch_id, code, name) VALUES ($1, 'PC1', 'PC1') RETURNING id`, [ids.b1]);
  ids.pc = (await one(`INSERT INTO app.resources (branch_id, resource_type, name) VALUES ($1, 'pc', 'ПК-1') RETURNING id`, [ids.b1])).id;
  await db.client.query(`INSERT INTO app.resource_units (resource_id, unit_id, valid_from) VALUES ($1, $2, '2026-01-01')`, [ids.pc, u.id]);
  ids.reason = (await one(`SELECT id FROM app.dict_reasons WHERE domain = 'booking_cancel_club' AND code = 'other'`)).id;
  admin = { actor: { kind: 'staff', staffId: SYS, sessionId: randomUUID() }, role: 'owner', network: true, cityIds: new Set(), branchIds: new Set(), at: clock.now() };
  clearSubscriptions();
  registerNotificationHandlers({ bookings: bookingLookup, clock });
  registerNotificationHandlers({ bookings: bookingLookup, clock }); // повтор – без ошибки
});
afterAll(async () => {
  clearSubscriptions();
  await pool.end();
  await db.drop();
});

describe('обработчики K14 на событиях брони', () => {
  it('подтверждение → booking_confirmed и напоминания; повторная доставка – duplicate, строк не прибавилось', async () => {
    const b = await book('2026-11-16T07:00:00Z');
    expect(await deliver(HANDLERS.confirmed, 'booking.confirmed', b.id)).toBe('processed');
    expect(await rows(b.id)).toEqual([
      { kind: 'booking_confirmed', status: 'planned', booking_version: 1 },
      { kind: 'reminder_before_start', status: 'planned', booking_version: 1 },
      { kind: 'reminder_day_before', status: 'planned', booking_version: 1 },
    ]);
    expect(await deliver(HANDLERS.confirmed, 'booking.confirmed', b.id)).toBe('duplicate');
    expect(await rows(b.id)).toHaveLength(3);
    expect(await bookingLookup.snapshot(pool, b.id)).toEqual({ version: 1, clientId: b.clientId, state: 'active' });
  });

  it('перенос → строки v1 skipped, «было/стало» и напоминания v2; запоздалое confirmed после переноса ничего не планирует', async () => {
    const b = await book('2026-11-17T07:00:00Z');
    await deliver(HANDLERS.confirmed, 'booking.confirmed', b.id);
    await runOccupancyCommand(pool, (c) => rescheduleBooking(c, b.id, { ctx: admin, rowVersion: 1, resourceId: ids.pc!, start: new Date('2026-11-18T07:00:00Z'), end: new Date('2026-11-18T08:00:00Z'), reason: 'перенос' }, meta, clock));
    await deliver(HANDLERS.rescheduled, 'booking.rescheduled', b.id);
    const r = await rows(b.id);
    expect(r.filter((x) => x.booking_version === 1).every((x) => x.status === 'skipped_booking_changed')).toBe(true);
    expect(r.filter((x) => x.booking_version === 2).map((x) => [x.kind, x.status])).toEqual([
      ['booking_rescheduled', 'planned'],
      ['reminder_before_start', 'planned'],
      ['reminder_day_before', 'planned'],
    ]);
    const late = await book('2026-11-19T07:00:00Z');
    await runOccupancyCommand(pool, (c) => rescheduleBooking(c, late.id, { ctx: admin, rowVersion: 1, resourceId: ids.pc!, start: new Date('2026-11-19T09:00:00Z'), end: new Date('2026-11-19T10:00:00Z'), reason: 'перенос' }, meta, clock));
    await deliver(HANDLERS.confirmed, 'booking.confirmed', late.id);
    expect(await rows(late.id)).toEqual([]);
  });

  it('отмена клубом → плановые skipped и booking_cancelled; клиентом – без сообщения; snapshot cancelled', async () => {
    const b = await book('2026-11-20T07:00:00Z');
    await deliver(HANDLERS.confirmed, 'booking.confirmed', b.id);
    await runOccupancyCommand(pool, (c) => cancelBooking(c, b.id, { kind: 'staff', ctx: admin, rowVersion: 1, initiator: 'club', reasonId: ids.reason!, comment: 'сбой' }, meta, clock));
    await deliver(HANDLERS.cancelled, 'booking.cancelled', b.id);
    const r = await rows(b.id);
    expect(r.find((x) => x.kind === 'booking_cancelled')).toEqual({ kind: 'booking_cancelled', status: 'planned', booking_version: 1 });
    expect(r.filter((x) => x.kind !== 'booking_cancelled').every((x) => x.status === 'skipped_booking_changed')).toBe(true);
    expect((await bookingLookup.snapshot(pool, b.id))!.state).toBe('cancelled');

    const c = await book('2026-11-21T07:00:00Z');
    await deliver(HANDLERS.confirmed, 'booking.confirmed', c.id);
    await runOccupancyCommand(pool, (tx) => cancelBooking(tx, c.id, { kind: 'client', clientId: c.clientId }, { actor: { kind: 'client', clientId: c.clientId, sessionId: '' }, source: 'account', requestId: 'r' }, clock));
    await deliver(HANDLERS.cancelled, 'booking.cancelled', c.id);
    expect((await rows(c.id)).map((x) => x.status)).toEqual(['skipped_booking_changed', 'skipped_booking_changed', 'skipped_booking_changed']);
    expect(await bookingLookup.snapshot(pool, randomUUID())).toBeNull();
  });
});

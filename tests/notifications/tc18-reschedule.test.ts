// Э5: TC-18 (tz/20 §10) целиком на настоящей Postgres: бронь → подтверждение (K4) → план напоминаний (K14) → перенос
// сотрудником → старые строки пропущены и диспетчер их не шлёт, новые рассчитаны от нового времени и уходят в свой срок.
// Настоящие команды брони, обработчики outbox и отправитель runDue; ключей VAPID нет – итог «нет канала», без сети.
// Страховка отправителя: строка прежней версии, оставшаяся плановой, пропускается им самим по версии брони (09 §6.4 п.3).
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { clearSubscriptions, processEvent } from '../../apps/api/src/core/outbox.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import { localToInstant, type Clock, type LocalDate, type LocalTime, type TimeZone } from '../../apps/api/src/core/time.ts';
import { rescheduleBooking } from '../../apps/api/src/modules/booking/change.ts';
import { confirmHold } from '../../apps/api/src/modules/booking/confirm.ts';
import { createHold } from '../../apps/api/src/modules/booking/hold.ts';
import { runOccupancyCommand } from '../../apps/api/src/modules/booking/occupancy.ts';
import { bookingLookup } from '../../apps/api/src/modules/booking/providers.ts';
import { HANDLERS, registerNotificationHandlers } from '../../apps/api/src/modules/notifications/handlers.ts';
import { runDue, type SenderDeps } from '../../apps/api/src/modules/notifications/sender.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const SYS = '00000000-0000-0000-0000-000000000001';
const NSK = 'Asia/Novosibirsk' as TimeZone;
let now = new Date('2026-11-14T05:00:00Z'); // 14.11, 12:00 Новосибирска
const clock: Clock = { now: () => now };
const local = (date: string, time: string) => localToInstant(date as LocalDate, time as LocalTime, NSK);
let db: TestDatabase;
let pool: pg.Pool;
const ids: Record<string, string> = {};
let owner: AccessContext;
let deps: SenderDeps;

const one = async (sql: string, params: unknown[] = []) => (await db.client.query(sql, params)).rows[0];
const meta = (): AuditRequestMeta => ({ actor: owner.actor, source: 'crm', requestId: randomUUID() });
const eventId = async (type: string, bookingId: string) => (await one(`SELECT id FROM app.outbox_events WHERE event_type = $1 AND aggregate_id = $2 ORDER BY id DESC LIMIT 1`, [type, bookingId])).id as string;
interface Row {
  booking_version: number;
  kind: string;
  status: string;
  planned_at: Date;
  attempts: number;
  sent_at: Date | null;
}
const rows = async (bookingId: string): Promise<Row[]> =>
  (await db.client.query<Row>(`SELECT booking_version, kind, status, planned_at, attempts, sent_at FROM app.notifications WHERE booking_id = $1 ORDER BY booking_version, planned_at, kind`, [bookingId])).rows;
const brief = (r: Row) => `${r.booking_version}:${r.kind}:${r.status}`;

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 6 });
  const city = await one(`INSERT INTO app.cities (code, slug, name, timezone) VALUES ('nsk', 'nsk', 'НСК', $1) RETURNING id`, [NSK]);
  ids.b1 = (await one(`INSERT INTO app.branches (city_id, code, slug, name, address, timezone, status) VALUES ($1, 'b1', 'b1', 'Центр', 'адрес', $2, 'active') RETURNING id`, [city.id, NSK])).id;
  await db.client.query(`INSERT INTO app.branch_weekly_hours (branch_id, weekday, open_time, close_time, valid_from, created_by) SELECT $1, d, '10:00', '22:00', '2026-01-01', $2 FROM generate_series(1, 7) d`, [ids.b1, SYS]);
  await db.client.query(`INSERT INTO app.tariffs (branch_id, resource_type, name, unit_minutes, price_per_unit_kop, valid_from, status, created_by) VALUES ($1, 'pc', 'ПК', 30, 15000, '2026-01-01', 'active', $2)`, [ids.b1, SYS]);
  const u = await one(`INSERT INTO app.occupancy_units (branch_id, code, name) VALUES ($1, 'PC1', 'PC1') RETURNING id`, [ids.b1]);
  ids.pc1 = (await one(`INSERT INTO app.resources (branch_id, resource_type, name) VALUES ($1, 'pc', 'ПК 1') RETURNING id`, [ids.b1])).id;
  await db.client.query(`INSERT INTO app.resource_units (resource_id, unit_id, valid_from) VALUES ($1, $2, '2026-01-01')`, [ids.pc1, u.id]);
  ids.client = (await one(`INSERT INTO app.clients (phone_e164, first_name, status, created_by_type, registered_at) VALUES ('+79130000018', 'Анна', 'active', 'system', now()) RETURNING id`)).id;
  ids.owner = (await one(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('В', 'В', 'o@yu.test', 'owner', 'x') RETURNING id`)).id;
  owner = { actor: { kind: 'staff', staffId: ids.owner!, sessionId: randomUUID() }, role: 'owner', network: true, cityIds: new Set(), branchIds: new Set(), at: now };
  deps = { pool, clock, vapid: null, bookings: bookingLookup };
  clearSubscriptions();
  registerNotificationHandlers({ bookings: bookingLookup, clock });
});
afterAll(async () => {
  clearSubscriptions();
  await pool.end();
  await db.drop();
});

describe('TC-18: напоминания после переноса', () => {
  it('TC-18: после переноса старые напоминания пропущены и диспетчером не отправляются, новые рассчитаны от нового времени и уходят в свой срок; плановая строка прежней версии пропускается самим отправителем', async () => {
    // бронь на 15.11 14:00–15:00 создана 14.11 в 12:00 → подтверждение + напоминания: накануне в 21:00 и за 15 минут
    const start1 = local('2026-11-15', '14:00');
    const h = await runOccupancyCommand(pool, (c) => createHold(c, { clientId: ids.client!, visitorId: null }, { branchId: ids.b1!, items: [{ resourceId: ids.pc1!, start: start1, end: new Date(start1.getTime() + 3_600_000) }] }, clock));
    const booking = (await runOccupancyCommand(pool, (c) => confirmHold(c, ids.client!, h.id, clock))).bookings[0]!.id;
    expect(await processEvent(pool, HANDLERS.confirmed, await eventId('booking.confirmed', booking), now)).toBe('processed');
    const v1 = await rows(booking);
    expect(v1.map(brief)).toEqual(['1:booking_confirmed:planned', '1:reminder_day_before:planned', '1:reminder_before_start:planned']);
    const oldDayBefore = local('2026-11-14', '21:00');
    const oldBeforeStart = new Date(start1.getTime() - 15 * 60_000);
    expect(v1.map((r) => r.planned_at.toISOString())).toEqual([now, oldDayBefore, oldBeforeStart].map((d) => d.toISOString()));

    // перенос сотрудником на 16.11 18:00–19:00 → строки v1 пропущены, «было/стало» и напоминания v2 от нового времени
    const start2 = local('2026-11-16', '18:00');
    const moved = await runOccupancyCommand(pool, (c) => rescheduleBooking(c, booking, { ctx: owner, rowVersion: 1, resourceId: ids.pc1!, start: start2, end: new Date(start2.getTime() + 3_600_000), reason: 'просьба клиента' }, meta(), clock));
    expect(moved.currentVersion).toBe(2);
    expect(await processEvent(pool, HANDLERS.rescheduled, await eventId('booking.rescheduled', booking), now)).toBe('processed');
    const planned = await rows(booking);
    expect(planned.map(brief)).toEqual([
      '1:booking_confirmed:skipped_booking_changed',
      '1:reminder_day_before:skipped_booking_changed',
      '1:reminder_before_start:skipped_booking_changed',
      '2:booking_rescheduled:planned',
      '2:reminder_day_before:planned',
      '2:reminder_before_start:planned',
    ]);
    const newDayBefore = local('2026-11-15', '21:00');
    const newBeforeStart = new Date(start2.getTime() - 15 * 60_000);
    expect(planned.slice(3).map((r) => r.planned_at.toISOString())).toEqual([now, newDayBefore, newBeforeStart].map((d) => d.toISOString()));

    // диспетчер в момент старого «накануне»: уходит только «перенесено» (его срок – сейчас), старые напоминания не берутся
    now = oldDayBefore;
    expect(await runDue(deps)).toEqual({ no_channel: 1 });
    expect((await rows(booking)).map(brief)).toEqual([
      '1:booking_confirmed:skipped_booking_changed',
      '1:reminder_day_before:skipped_booking_changed',
      '1:reminder_before_start:skipped_booking_changed',
      '2:booking_rescheduled:no_channel',
      '2:reminder_day_before:planned',
      '2:reminder_before_start:planned',
    ]);
    // в момент старого «за 15 минут» – ничего
    now = oldBeforeStart;
    expect(await runDue(deps)).toEqual({});
    // новые – каждое в свой срок, от нового времени
    now = newDayBefore;
    expect(await runDue(deps)).toEqual({ no_channel: 1 });
    expect((await rows(booking)).filter((r) => r.booking_version === 2).map(brief)).toEqual(['2:booking_rescheduled:no_channel', '2:reminder_day_before:no_channel', '2:reminder_before_start:planned']);
    now = newBeforeStart;
    expect(await runDue(deps)).toEqual({ no_channel: 1 });
    expect((await rows(booking)).filter((r) => r.booking_version === 2).map(brief)).toEqual(['2:booking_rescheduled:no_channel', '2:reminder_day_before:no_channel', '2:reminder_before_start:no_channel']);
    // старые строки не трогались: ни попыток, ни отправки
    for (const r of (await rows(booking)).filter((x) => x.booking_version === 1)) expect([r.kind, r.status, r.attempts, r.sent_at]).toEqual([r.kind, 'skipped_booking_changed', 0, null]);

    // страховка отправителя: строка v1 осталась бы плановой (обработчик не успел) – диспетчер пропускает её по версии брони
    await db.client.query(`UPDATE app.notifications SET status = 'planned' WHERE booking_id = $1 AND booking_version = 1 AND kind = 'reminder_before_start'`, [booking]);
    now = oldBeforeStart;
    expect(await runDue(deps)).toEqual({ skipped_booking_changed: 1 });
    expect((await rows(booking)).filter((r) => r.booking_version === 1 && r.kind === 'reminder_before_start').map((r) => [r.status, r.sent_at])).toEqual([['skipped_booking_changed', null]]);
  });
});

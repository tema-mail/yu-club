// S1-15: моменты напоминаний по зонам филиала (R-17), плановые строки и их отмена (K14, TC-18 – часть без броней).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { localToInstant, parseLocalDate, parseLocalTime, type TimeZone } from '../../apps/api/src/core/time.ts';
import {
  bookingDrafts,
  planBookingNotifications,
  planClubCancellation,
  reminderMoments,
  skipPlannedForBooking,
  skipRemindersForClient,
  type BookingFacts,
} from '../../apps/api/src/modules/notifications/reminders.ts';
import { createTestBooking } from '../helpers/booking.ts';
import { createTestBranch } from '../helpers/network.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const NSK = 'Asia/Novosibirsk' as TimeZone;
const KGD = 'Europe/Kaliningrad' as TimeZone;
const VVO = 'Asia/Vladivostok' as TimeZone;
const MSK = 'Europe/Moscow' as TimeZone;
const times = { dayBeforeAt: parseLocalTime('21:00'), beforeMinutes: 15 };
const at = (date: string, time: string, tz: TimeZone) => localToInstant(parseLocalDate(date), parseLocalTime(time), tz);
const iso = (d: Date) => d.toISOString();

describe('reminderMoments – по зоне филиала', () => {
  it.each([
    [NSK, '2026-11-14T14:00:00.000Z', '2026-11-15T06:45:00.000Z'], // +7
    [MSK, '2026-11-14T18:00:00.000Z', '2026-11-15T10:45:00.000Z'], // +3
    [KGD, '2026-11-14T19:00:00.000Z', '2026-11-15T11:45:00.000Z'], // +2
    [VVO, '2026-11-14T11:00:00.000Z', '2026-11-15T03:45:00.000Z'], // +10
  ])('%s: сеанс 15.11 14:00 местного → 21:00 местного 14.11 и 13:45 местного', (tz, dayBefore, beforeStart) => {
    const start = at('2026-11-15', '14:00', tz);
    const m = reminderMoments(start, tz, new Date('2026-11-01T00:00:00Z'), times);
    expect(m.map((x) => [x.kind, iso(x.plannedAt)])).toEqual([
      ['reminder_day_before', dayBefore],
      ['reminder_before_start', beforeStart],
    ]);
  });

  it('запись 14.11 в 21:30 на 15.11 – «накануне» не шлём, остаётся только −15 мин (R-17)', () => {
    const start = at('2026-11-15', '14:00', NSK);
    const m = reminderMoments(start, NSK, at('2026-11-14', '21:30', NSK), times);
    expect(m.map((x) => x.kind)).toEqual(['reminder_before_start']);
  });

  it('ровно в 21:00 накануне – тоже без «накануне» (момент не позже создания)', () => {
    const m = reminderMoments(at('2026-11-15', '14:00', NSK), NSK, at('2026-11-14', '21:00', NSK), times);
    expect(m.map((x) => x.kind)).toEqual(['reminder_before_start']);
  });

  it('21:30 по Новосибирску = 17:30 по Москве: для московского филиала «накануне» ещё будет', () => {
    const created = at('2026-11-14', '21:30', NSK);
    expect(reminderMoments(at('2026-11-15', '14:00', MSK), MSK, created, times).map((x) => x.kind)).toEqual([
      'reminder_day_before',
      'reminder_before_start',
    ]);
  });

  it('бронь за 10 минут до начала – ни одного напоминания', () => {
    const start = at('2026-11-15', '14:00', NSK);
    expect(reminderMoments(start, NSK, new Date(start.getTime() - 10 * 60_000), times)).toEqual([]);
  });

  it('сеанс в 00:30 – «накануне» значит вечер предыдущей календарной даты', () => {
    const m = reminderMoments(at('2026-11-15', '00:30', NSK), NSK, new Date('2026-11-01T00:00:00Z'), times);
    expect(iso(m[0]!.plannedAt)).toBe(iso(at('2026-11-14', '21:00', NSK)));
  });

  it('свои настройки K7: 20:00 и −30 мин', () => {
    const m = reminderMoments(at('2026-11-15', '14:00', NSK), NSK, new Date('2026-11-01T00:00:00Z'), {
      dayBeforeAt: parseLocalTime('20:00'),
      beforeMinutes: 30,
    });
    expect(m.map((x) => iso(x.plannedAt))).toEqual([iso(at('2026-11-14', '20:00', NSK)), iso(at('2026-11-15', '13:30', NSK))]);
  });
});

describe('bookingDrafts – тексты без лишних ПДн, время по филиалу', () => {
  it('подтверждение и напоминания; время в тексте местное', () => {
    const b: BookingFacts = {
      bookingId: randomUUID(),
      bookingVersion: 1,
      clientId: randomUUID(),
      branchId: randomUUID(),
      branchTimezone: KGD,
      resourceName: 'ПК 7',
      start: at('2026-11-15', '14:00', KGD),
      end: at('2026-11-15', '16:00', KGD),
    };
    const d = bookingDrafts(b, new Date('2026-11-01T00:00:00Z'), times, 'Ю-Клуб Центр', { kind: 'booking_confirmed' });
    expect(d.map((x) => [x.kind, x.category])).toEqual([
      ['booking_confirmed', 'service'],
      ['reminder_day_before', 'reminder'],
      ['reminder_before_start', 'reminder'],
    ]);
    expect(d[0]!.body).toBe('15 ноября, 14:00 – Ю-Клуб Центр, ПК 7');
    expect(d[2]!.body).toBe('В 14:00 – Ю-Клуб Центр, ПК 7');
    expect(d[1]!.notAfter).toEqual(b.start);
  });
});

describe('плановые строки в базе', () => {
  let db: TestDatabase;
  let branchId: string;
  let clientId: string;
  const now = new Date('2026-11-10T03:00:00Z');

  const facts = async (over: Partial<BookingFacts> = {}): Promise<BookingFacts> => ({
    bookingId: await createTestBooking(db.client, { clientId, branchId }),
    bookingVersion: 1,
    clientId,
    branchId,
    branchTimezone: NSK,
    resourceName: 'VR 2',
    start: at('2026-11-15', '14:00', NSK),
    end: at('2026-11-15', '15:00', NSK),
    ...over,
  });
  const statuses = async (bookingId: string) =>
    (
      await db.client.query<{ kind: string; status: string; booking_version: number }>(
        'SELECT kind, status, booking_version FROM app.notifications WHERE booking_id = $1 ORDER BY booking_version, planned_at',
        [bookingId],
      )
    ).rows.map((r) => `${r.booking_version}:${r.kind}:${r.status}`);

  beforeAll(async () => {
    db = await createTestDatabase({ migrate: true });
    branchId = (await createTestBranch(db.client, { timezone: NSK })).id;
    clientId = (
      await db.client.query<{ id: string }>(
        `INSERT INTO app.clients (phone_e164, status, registered_at, created_by_type) VALUES ('+79130000001', 'active', now(), 'system') RETURNING id`,
      )
    ).rows[0]!.id;
  });
  afterAll(async () => db.drop());

  it('подтверждение: три строки; повтор события – без дублей', async () => {
    const b = await facts();
    expect(await planBookingNotifications(db.client, b, now)).toHaveLength(3);
    expect(await planBookingNotifications(db.client, b, now)).toHaveLength(0);
    expect(await statuses(b.bookingId)).toEqual([
      '1:booking_confirmed:planned',
      '1:reminder_day_before:planned',
      '1:reminder_before_start:planned',
    ]);
  });

  it('перенос: старые → skipped_booking_changed, новые напоминания запланированы (TC-18)', async () => {
    const b = await facts();
    await planBookingNotifications(db.client, b, now);
    const moved = { ...b, bookingVersion: 2, start: at('2026-11-16', '18:00', NSK), end: at('2026-11-16', '19:00', NSK) };
    expect(await skipPlannedForBooking(db.client, b.bookingId, now, 2)).toBe(3);
    await planBookingNotifications(db.client, moved, now, { kind: 'booking_rescheduled', previousStart: b.start });
    expect(await statuses(b.bookingId)).toEqual([
      '1:booking_confirmed:skipped_booking_changed',
      '1:reminder_day_before:skipped_booking_changed',
      '1:reminder_before_start:skipped_booking_changed',
      '2:booking_rescheduled:planned',
      '2:reminder_day_before:planned',
      '2:reminder_before_start:planned',
    ]);
    const body = (await db.client.query<{ body: string }>(`SELECT body FROM app.notifications WHERE dedupe_key = $1`, [`booking_rescheduled:${b.bookingId}:2`])).rows[0]!.body;
    expect(body).toMatch(/^Было: 15 ноября, 14:00\. Стало: 16 ноября, 18:00 – .+, VR 2$/);
  });

  it('выключил напоминания: плановые reminder → skipped_by_prefs, отмена клубом всё равно запланирована', async () => {
    const b = await facts();
    await planBookingNotifications(db.client, b, now, null);
    expect(await skipRemindersForClient(db.client, clientId, now)).toBeGreaterThanOrEqual(2);
    await skipPlannedForBooking(db.client, b.bookingId, now);
    await planClubCancellation(db.client, b, now);
    expect(await statuses(b.bookingId)).toEqual([
      '1:booking_cancelled:planned',
      '1:reminder_day_before:skipped_by_prefs',
      '1:reminder_before_start:skipped_by_prefs',
    ]);
  });
});

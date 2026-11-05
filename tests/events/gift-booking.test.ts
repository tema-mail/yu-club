// S3-59: запись по подарку на настоящей Postgres – TC-14 целиком (K20 §18). Часы теста – 2026 год: подарок выдан 01.06 (Пн).
// Гонка двух holdGift, подмена клиента (bookGiftByStaff, перенос, attachHold), обработчики K4 с повторной доставкой и не по порядку,
// приход → used, исправление прихода → reserved, неявка → issued (Q-114), перенос на субботу, оплата none (K10).
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { AppError } from '../../apps/api/src/core/errors.ts';
import { clearSubscriptions, processEvent } from '../../apps/api/src/core/outbox.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { cancelBooking, createStaffBooking, rescheduleBooking } from '../../apps/api/src/modules/booking/change.ts';
import { confirmHold } from '../../apps/api/src/modules/booking/confirm.ts';
import { addHoldItem, attachHold, createHold, expireDueHolds, releaseHold } from '../../apps/api/src/modules/booking/hold.ts';
import { runOccupancyCommand } from '../../apps/api/src/modules/booking/occupancy.ts';
import { bookingLookup, paymentBookingProvider } from '../../apps/api/src/modules/booking/providers.ts';
import { markArrived, markNoShow, revertVisit } from '../../apps/api/src/modules/booking/visit.ts';
import { bookGiftByStaff, GIFT_HANDLERS, holdGift, registerGiftGrant, registerGiftHandlers, weekdayOf } from '../../apps/api/src/modules/events/gift-booking.ts';
import { issueGift } from '../../apps/api/src/modules/events/gifts.ts';
import { recordPayment } from '../../apps/api/src/modules/finance/payment.ts';
import { setHoliday } from '../../apps/api/src/modules/network/holidays.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const issueClock = fixedClock('2026-06-01T05:00:00Z');
const clock = fixedClock('2026-06-02T05:00:00Z');
let db: TestDatabase;
let pool: pg.Pool;
let owner: AccessContext;
const ids: Record<string, string> = {};
const units: Record<string, string> = {};
let phone = 79130000000;

const meta = (): AuditRequestMeta => ({ actor: owner.actor, access: owner, source: 'crm', requestId: randomUUID() });
const tx = <T>(fn: (c: pg.PoolClient) => Promise<T>) => runOccupancyCommand(pool, fn);
const one = async (sql: string, params: unknown[] = []) => (await db.client.query(sql, params)).rows[0];
async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
}
async function newClient(): Promise<string> {
  return (await one(`INSERT INTO app.clients (phone_e164, first_name, status, created_by_type) VALUES ($1, 'Катя', 'active', 'system') RETURNING id`, [`+${++phone}`])).id;
}
async function newGift(clientId?: string) {
  const id = clientId ?? (await newClient());
  const g = await tx((c) => issueGift(c, owner, { clientId: id, branchId: ids.branch, reason: 'тест' }, meta(), issueClock));
  return { gift: g, clientId: id };
}
const giftStatus = async (id: string) => (await one('SELECT status FROM app.birthday_gifts WHERE id = $1', [id])).status as string;
const uses = async (id: string) => (await db.client.query('SELECT status, hold_id, booking_id FROM app.gift_uses WHERE gift_id = $1 ORDER BY changed_at, id', [id])).rows;
// 12:00 по Новосибирску = 05:00 UTC
const noon = (date: string, hhmm = '05:00') => new Date(`${date}T${hhmm}:00Z`);
const hold = (giftId: string, clientId: string, start: Date, at = clock) => tx((c) => holdGift(c, { clientId, visitorId: null }, giftId, { branchId: ids.branch!, start }, meta(), at));
const book = (giftId: string, start: Date, extra: { clientId?: string } = {}, at = clock) => tx((c) => bookGiftByStaff(c, owner, giftId, { branchId: ids.branch!, start, ...extra }, meta(), at));
async function eventId(type: string, key: string, value: string): Promise<string> {
  return (await one(`SELECT id FROM app.outbox_events WHERE event_type = $1 AND payload ->> $2 = $3 ORDER BY occurred_at DESC, id DESC LIMIT 1`, [type, key, value])).id;
}
const deliver = (handler: string, id: string) => processEvent(pool, handler, id, clock.now());
const visitCmd = (rowVersion: number) => ({ ctx: owner, rowVersion });

beforeAll(async () => {
  clearSubscriptions();
  registerGiftGrant();
  registerGiftHandlers({ clock });
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 12 });
  const s = await one(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', 'o@yu.test', 'owner', 'x') RETURNING id`);
  owner = { actor: { kind: 'staff', staffId: s.id, sessionId: randomUUID() }, role: 'owner', network: true, cityIds: new Set(), branchIds: new Set(), at: clock.now() };
  const city = await one(`INSERT INTO app.cities (code, slug, name, timezone) VALUES ('nsk', 'nsk', 'НСК', 'Asia/Novosibirsk') RETURNING id`);
  ids.branch = (await one(`INSERT INTO app.branches (city_id, code, slug, name, address, timezone, status) VALUES ($1, 'b1', 'b1', 'b1', 'адрес', 'Asia/Novosibirsk', 'active') RETURNING id`, [city.id])).id;
  await db.client.query(`INSERT INTO app.branch_weekly_hours (branch_id, weekday, open_time, close_time, valid_from, created_by) SELECT $1, d, '10:00', '22:00', '2026-01-01', $2 FROM generate_series(1, 7) d`, [ids.branch, s.id]);
  for (const [type, price] of [['vr_seat', 10000], ['ps_room', 20000], ['gift_vr', 0]] as const) {
    await db.client.query(`INSERT INTO app.tariffs (branch_id, resource_type, name, unit_minutes, price_per_unit_kop, valid_from, status, created_by) VALUES ($1, $2, $2, 5, $3, '2026-01-01', 'active', $4)`, [ids.branch, type, price, s.id]);
  }
  ids.room = (await one(`INSERT INTO app.rooms (branch_id, slug, name, is_published) VALUES ($1, 'vr', 'VR', true) RETURNING id`, [ids.branch])).id;
  for (const code of ['VR1', 'VR2', 'PS4']) units[code] = (await one(`INSERT INTO app.occupancy_units (branch_id, room_id, code, name) VALUES ($1, $2, $3, $3) RETURNING id`, [ids.branch, ids.room, code])).id;
  const res = async (type: string, name: string, list: string[], extra = 'true, NULL') => {
    const r = await one(`INSERT INTO app.resources (branch_id, room_id, resource_type, name, self_bookable, step_minutes_override) VALUES ($1, $2, $3, $4, ${extra}) RETURNING id`, [ids.branch, ids.room, type, name]);
    await db.client.query(`INSERT INTO app.resource_units (resource_id, unit_id, valid_from) SELECT $1, u, '2026-01-01' FROM unnest($2::uuid[]) u`, [r.id, list]);
    return r.id as string;
  };
  ids.vr1 = await res('vr_seat', 'VR-место 1', [units.VR1!]);
  ids.vr2 = await res('vr_seat', 'VR-место 2', [units.VR2!]);
  ids.ps = (await one(`INSERT INTO app.resources (branch_id, room_id, resource_type, name) VALUES ($1, $2, 'ps_room', 'PS4') RETURNING id`, [ids.branch, ids.room])).id;
  await db.client.query(`INSERT INTO app.resource_units (resource_id, unit_id, valid_from) VALUES ($1, $2, '2026-01-01')`, [ids.ps, units.PS4]);
  ids.gift = await res('gift_vr', 'Подарок: 2 VR', [units.VR1!, units.VR2!], 'false, 5');
  // часы теста стоят: срок подарка 60 дней длиннее окна записи 30 дней – окно шире, чтобы проверять весь срок
  await db.client.query(`INSERT INTO app.settings_values (key, level, value, valid_from, created_by) VALUES ('booking.window_max_days', 'network', '90'::jsonb, '2026-01-01', $1)`, [s.id]);
  await tx((c) => setHoliday(c, owner, { scope: 'network', date: '2026-06-12', name: 'День России' }, meta(), clock));
});
afterAll(async () => {
  clearSubscriptions();
  await pool.end();
  await db.drop();
});

describe('S3-59: TC-14 проверки записи', () => {
  it('день недели – по дате филиала', () => {
    expect(['2026-06-01', '2026-06-06', '2026-06-07'].map((d) => weekdayOf(d as never))).toEqual([1, 6, 7]);
  });
  it('запись 06.06 (Сб) → GIFT_WEEKDAY_ONLY; 12.06 (праздник сети) → GIFT_HOLIDAY; 01.08 → GIFT_EXPIRED', async () => {
    const { gift, clientId } = await newGift();
    expect(gift.validUntil).toBe('2026-07-31');
    expect(await codeOf(hold(gift.id, clientId, noon('2026-06-06')))).toBe('GIFT_WEEKDAY_ONLY');
    expect(await codeOf(hold(gift.id, clientId, noon('2026-06-12')))).toBe('GIFT_HOLIDAY');
    expect(await codeOf(hold(gift.id, clientId, noon('2026-08-03')))).toBe('GIFT_EXPIRED');
    expect(await codeOf(book(gift.id, noon('2026-06-06')))).toBe('GIFT_WEEKDAY_ONLY');
    expect(await giftStatus(gift.id)).toBe('issued');
    expect(await uses(gift.id)).toEqual([]);
  });
  it('занят один шлем (бронь VR2) → SLOT_TAKEN; запись 40 минут занимает VR1 + VR2, не PS4; PS4 в это время свободна (Q-155)', async () => {
    const { gift, clientId } = await newGift();
    const other = await newClient();
    await tx((c) => createStaffBooking(c, { ctx: owner, branchId: ids.branch!, resourceId: ids.vr2!, client: { clientId: other }, start: noon('2026-06-03'), end: noon('2026-06-03', '05:30') }, meta(), clock));
    expect(await codeOf(hold(gift.id, clientId, noon('2026-06-03')))).toBe('SLOT_TAKEN');
    expect(await giftStatus(gift.id)).toBe('issued');
    const h = await hold(gift.id, clientId, noon('2026-06-04'));
    expect(h.items[0]!.priceKop).toBe(0);
    const occ = await db.client.query(`SELECT unit_id, upper(period) - lower(period) AS d FROM app.occupancy WHERE active AND source_id = $1`, [h.items[0]!.id]);
    expect(occ.rows.map((r) => r.unit_id).sort()).toEqual([units.VR1, units.VR2].sort());
    expect(occ.rows[0].d.minutes).toBe(40);
    expect(await codeOf(tx((c) => createStaffBooking(c, { ctx: owner, branchId: ids.branch!, resourceId: ids.ps!, client: { clientId: other }, start: noon('2026-06-04'), end: noon('2026-06-04', '06:00') }, meta(), clock)))).toBe('ok');
  });
  it('добавить PS4 в удержание подарка → GIFT_COMPOSITION_INVALID; состав с PS → тоже; начало не на сетке 15', async () => {
    const { gift, clientId } = await newGift();
    expect(await codeOf(hold(gift.id, clientId, noon('2026-06-05', '05:05')))).toBe('INVALID_DURATION');
    const h = await hold(gift.id, clientId, noon('2026-06-05'));
    const item = { resourceId: ids.ps!, start: noon('2026-06-05', '07:00'), end: noon('2026-06-05', '08:00') };
    expect(await codeOf(tx((c) => addHoldItem(c, { clientId, visitorId: null }, h.id, item, clock)))).toBe('GIFT_COMPOSITION_INVALID');
    await db.client.query(`INSERT INTO app.resource_units (resource_id, unit_id, valid_from) VALUES ($1, $2, '2026-01-01')`, [ids.gift, units.PS4]);
    try {
      const second = await newGift();
      expect(await codeOf(hold(second.gift.id, second.clientId, noon('2026-06-08')))).toBe('GIFT_COMPOSITION_INVALID');
    } finally {
      await db.client.query(`DELETE FROM app.resource_units WHERE resource_id = $1 AND unit_id = $2`, [ids.gift, units.PS4]);
    }
  });
  it('обычная запись на подарочный ресурс без гранта → RESOURCE_UNAVAILABLE', async () => {
    const clientId = await newClient();
    expect(await codeOf(tx((c) => createHold(c, { clientId, visitorId: null }, { branchId: ids.branch!, items: [{ resourceId: ids.gift!, start: noon('2026-06-09'), end: noon('2026-06-09', '05:40') }] }, clock)))).toBe('RESOURCE_UNAVAILABLE');
    expect(await codeOf(tx((c) => createStaffBooking(c, { ctx: owner, branchId: ids.branch!, resourceId: ids.gift!, client: { clientId }, start: noon('2026-06-09'), end: noon('2026-06-09', '05:40') }, meta(), clock)))).toBe('RESOURCE_UNAVAILABLE');
  });
  it('два параллельных holdGift → одна запись (база); третий – GIFT_ALREADY_RESERVED', async () => {
    const { gift, clientId } = await newGift();
    const both = await Promise.all([codeOf(hold(gift.id, clientId, noon('2026-06-10'))), codeOf(hold(gift.id, clientId, noon('2026-06-10', '07:00')))]);
    expect(both.sort()).toEqual(['GIFT_ALREADY_RESERVED', 'ok']);
    expect((await uses(gift.id)).filter((u) => u.status === 'held')).toHaveLength(1);
    expect(await codeOf(hold(gift.id, clientId, noon('2026-06-11')))).toBe('GIFT_ALREADY_RESERVED');
  });
  it('20 параллельных записей подарка из CRM → одна бронь', async () => {
    const { gift } = await newGift();
    const all = await Promise.all(Array.from({ length: 20 }, (_, i) => codeOf(book(gift.id, new Date(noon('2026-06-15').getTime() + i * 15 * 60_000)))));
    expect(all.filter((c) => c === 'ok')).toHaveLength(1);
    for (const c of all) expect(['ok', 'GIFT_ALREADY_RESERVED']).toContain(c);
  });
});

describe('S3-59: проверка 8 – клиент брони = клиент подарка', () => {
  it('holdGift чужим клиентом или посетителем, бронь на другого клиента – GIFT_CLIENT_MISMATCH', async () => {
    const { gift } = await newGift();
    const stranger = await newClient();
    expect(await codeOf(hold(gift.id, stranger, noon('2026-06-16')))).toBe('GIFT_CLIENT_MISMATCH');
    expect(await codeOf(tx((c) => holdGift(c, { clientId: null, visitorId: randomUUID() }, gift.id, { branchId: ids.branch!, start: noon('2026-06-16') }, meta(), clock)))).toBe('GIFT_CLIENT_MISMATCH');
    expect(await codeOf(book(gift.id, noon('2026-06-16'), { clientId: stranger }))).toBe('GIFT_CLIENT_MISMATCH');
    expect(await giftStatus(gift.id)).toBe('issued');
  });
  it('перенос с подменой подарка чужого клиента – GIFT_CLIENT_MISMATCH', async () => {
    const a = await newGift();
    const b = await newGift();
    const bookingId = await book(a.gift.id, noon('2026-06-17'));
    expect(await codeOf(tx((c) => rescheduleBooking(c, bookingId, { ctx: owner, rowVersion: 1, resourceId: ids.gift!, start: noon('2026-06-18'), end: noon('2026-06-18', '05:40'), reason: 'x', serviceGrant: { kind: 'gift', id: b.gift.id } }, meta(), clock)))).toBe('GIFT_CLIENT_MISMATCH');
  });
  it('attachHold чужого удержания – GIFT_CLIENT_MISMATCH; вход клиента его не присваивает', async () => {
    const { gift, clientId } = await newGift();
    const h = await hold(gift.id, clientId, noon('2026-06-19'));
    const visitorId = randomUUID();
    await db.client.query(`UPDATE app.holds SET client_id = NULL, visitor_id = $2 WHERE id = $1`, [h.id, visitorId]);
    await db.client.query(`UPDATE app.client_time SET active = false, released_at = now(), release_reason = 'released' WHERE source_id = $1`, [h.items[0]!.id]);
    const stranger = await newClient();
    expect(await codeOf(tx((c) => attachHold(c, stranger, visitorId, h.id, clock)))).toBe('GIFT_CLIENT_MISMATCH');
    expect((await one('SELECT client_id FROM app.holds WHERE id = $1', [h.id])).client_id).toBeNull();
    expect(await codeOf(tx((c) => attachHold(c, clientId, visitorId, h.id, clock)))).toBe('ok');
    expect((await one('SELECT client_id FROM app.holds WHERE id = $1', [h.id])).client_id).toBe(clientId);
  });
});

describe('S3-59: жизненный цикл', () => {
  it('удержание → подтверждение → приход → used; повторная запись → GIFT_NOT_ACTIVE; исправление прихода → reserved; повтор доставки ничего не меняет', async () => {
    const { gift, clientId } = await newGift();
    const h = await hold(gift.id, clientId, noon('2026-06-22'));
    expect(await giftStatus(gift.id)).toBe('reserved');
    const done = await tx((c) => confirmHold(c, clientId, h.id, clock));
    const bookingId = done.bookings[0]!.id;
    expect(done.bookings[0]!.priceKop).toBe(0);
    const confirmedEv = await eventId('booking.confirmed', 'bookingId', bookingId);
    await deliver(GIFT_HANDLERS.bookingConfirmed, confirmedEv);
    expect((await uses(gift.id))[0]).toMatchObject({ status: 'booked', booking_id: bookingId, hold_id: h.id });

    const arriveAt = fixedClock('2026-06-22T05:00:00Z');
    const arrived = await tx((c) => markArrived(c, bookingId, visitCmd(1), meta(), arriveAt));
    const visitEv = await eventId('visit.confirmed', 'bookingId', bookingId);
    await deliver(GIFT_HANDLERS.visitConfirmed, visitEv);
    await deliver(GIFT_HANDLERS.visitConfirmed, visitEv);
    expect(await giftStatus(gift.id)).toBe('used');
    expect((await uses(gift.id))[0].status).toBe('used');
    expect(await codeOf(hold(gift.id, clientId, noon('2026-06-23')))).toBe('GIFT_NOT_ACTIVE');

    await tx((c) => revertVisit(c, bookingId, { ...visitCmd(arrived.rowVersion), reason: 'ошибка' }, meta(), arriveAt));
    await deliver(GIFT_HANDLERS.visitReverted, await eventId('visit.reverted', 'bookingId', bookingId));
    expect(await giftStatus(gift.id)).toBe('reserved');
    expect((await uses(gift.id))[0].status).toBe('booked');
    const log = await db.client.query(`SELECT action FROM journal.audit_events WHERE object_type = 'gift' AND object_id = $1 ORDER BY id`, [gift.id]);
    expect(log.rows.map((r) => r.action)).toEqual(['gift.issued', 'gift.reserved', 'gift.used', 'gift.reserved']);
  });
  it('события не по порядку: приход раньше подтверждения – всё равно used', async () => {
    const { gift, clientId } = await newGift();
    const h = await hold(gift.id, clientId, noon('2026-06-23'));
    const done = await tx((c) => confirmHold(c, clientId, h.id, clock));
    const bookingId = done.bookings[0]!.id;
    await tx((c) => markArrived(c, bookingId, visitCmd(1), meta(), fixedClock('2026-06-23T05:00:00Z')));
    await deliver(GIFT_HANDLERS.visitConfirmed, await eventId('visit.confirmed', 'bookingId', bookingId));
    expect(await giftStatus(gift.id)).toBe('used');
    await deliver(GIFT_HANDLERS.bookingConfirmed, await eventId('booking.confirmed', 'bookingId', bookingId));
    expect(await giftStatus(gift.id)).toBe('used');
  });
  it('неявка → подарок снова issued (Q-114); снятая неявка возвращает запись; при выключенной настройке – cancelled с причиной', async () => {
    const { gift } = await newGift();
    const bookingId = await book(gift.id, noon('2026-06-24'));
    expect((await uses(gift.id))[0]).toMatchObject({ status: 'booked', booking_id: bookingId });
    const at = fixedClock('2026-06-24T05:30:00Z');
    const r = await tx((c) => markNoShow(c, bookingId, visitCmd(1), meta(), at));
    await deliver(GIFT_HANDLERS.noShowMarked, await eventId('no_show.marked', 'bookingId', bookingId));
    expect(await giftStatus(gift.id)).toBe('issued');
    expect((await uses(gift.id))[0].status).toBe('released');
    await tx((c) => revertVisit(c, bookingId, { ...visitCmd(r.rowVersion), reason: 'пришёл' }, meta(), at));
    await deliver(GIFT_HANDLERS.noShowReverted, await eventId('no_show.reverted', 'bookingId', bookingId));
    expect(await giftStatus(gift.id)).toBe('reserved');

    await db.client.query(`INSERT INTO app.settings_values (key, level, value, valid_from, created_by) VALUES ('gift.no_show_returns', 'network', 'false'::jsonb, '2026-01-01', $1)`, [owner.actor.staffId]);
    try {
      const second = await newGift();
      const b2 = await book(second.gift.id, noon('2026-06-25'));
      await tx((c) => markNoShow(c, b2, visitCmd(1), meta(), fixedClock('2026-06-25T05:30:00Z')));
      await deliver(GIFT_HANDLERS.noShowMarked, await eventId('no_show.marked', 'bookingId', b2));
      expect(await one('SELECT status, cancel_reason FROM app.birthday_gifts WHERE id = $1', [second.gift.id])).toEqual({ status: 'cancelled', cancel_reason: 'no_show' });
    } finally {
      await db.client.query(`DELETE FROM app.settings_values WHERE key = 'gift.no_show_returns'`);
    }
  });
  it('отмена брони → issued и можно записаться снова', async () => {
    const { gift } = await newGift();
    const bookingId = await book(gift.id, noon('2026-06-26'));
    const clientId = (await one('SELECT client_id FROM app.bookings WHERE id = $1', [bookingId])).client_id;
    await tx((c) => cancelBooking(c, bookingId, { kind: 'client', clientId }, meta(), clock));
    await deliver(GIFT_HANDLERS.bookingCancelled, await eventId('booking.cancelled', 'bookingId', bookingId));
    expect(await giftStatus(gift.id)).toBe('issued');
    expect(await codeOf(book(gift.id, noon('2026-06-29')))).toBe('ok');
    expect((await uses(gift.id)).map((u) => u.status).sort()).toEqual(['booked', 'released']);
  });
  it('удержание отпущено или истекло → issued (в той же транзакции / обработчик / самолечение при следующей записи)', async () => {
    const a = await newGift();
    const h = await hold(a.gift.id, a.clientId, noon('2026-07-01'));
    await tx((c) => releaseHold(c, { clientId: a.clientId, visitorId: null }, h.id, clock));
    expect(await giftStatus(a.gift.id)).toBe('issued');

    const b = await newGift();
    const h2 = await hold(b.gift.id, b.clientId, noon('2026-07-02'));
    const later = fixedClock('2026-06-02T06:00:00Z');
    expect(await codeOf(hold(b.gift.id, b.clientId, noon('2026-07-02', '07:00'), later))).toBe('ok'); // истекшее не мешает, задача ещё не прошла
    expect((await uses(b.gift.id)).map((u) => u.status).sort()).toEqual(['held', 'released']);
    expect((await one('SELECT status FROM app.holds WHERE id = $1', [h2.id])).status).toBe('active');
    await expireDueHolds(pool, fixedClock('2026-06-02T06:00:00Z'));
    await deliver(GIFT_HANDLERS.holdExpired, await eventId('hold.expired', 'holdId', h2.id));
    expect(await giftStatus(b.gift.id)).toBe('reserved'); // живая запись – другая: обработчик старой её не трогает
  });
});

describe('S3-59: перенос и оплата', () => {
  it('перенос на субботу – GIFT_WEEKDAY_ONLY, на праздник и после срока – свои коды; на будний день – да; прежнее время цело', async () => {
    const { gift } = await newGift();
    const bookingId = await book(gift.id, noon('2026-06-30'));
    const move = (start: Date, rowVersion = 1) => tx((c) => rescheduleBooking(c, bookingId, { ctx: owner, rowVersion, resourceId: ids.gift!, start, end: new Date(start.getTime() + 40 * 60_000), reason: 'попросили' }, meta(), clock));
    expect(await codeOf(move(noon('2026-07-04')))).toBe('GIFT_WEEKDAY_ONLY');
    await tx((c) => setHoliday(c, owner, { scope: 'network', date: '2026-07-06', name: 'Праздник' }, meta(), clock));
    expect(await codeOf(move(noon('2026-07-06')))).toBe('GIFT_HOLIDAY');
    expect((await one('SELECT lower(period) AS s FROM app.bookings WHERE id = $1', [bookingId])).s.toISOString()).toBe('2026-06-30T05:00:00.000Z');
    const m = await move(noon('2026-07-07'));
    expect(m.currentVersion).toBe(2);
    expect(await giftStatus(gift.id)).toBe('reserved');
  });
  it('перенос брони из ЛК раньше обработчика booking.confirmed – запись находится по удержанию', async () => {
    const { gift, clientId } = await newGift();
    const h = await hold(gift.id, clientId, noon('2026-07-13'));
    const done = await tx((c) => confirmHold(c, clientId, h.id, clock));
    const bookingId = done.bookings[0]!.id;
    expect((await uses(gift.id))[0].status).toBe('held');
    const r = await tx((c) => rescheduleBooking(c, bookingId, { ctx: owner, rowVersion: 1, resourceId: ids.gift!, start: noon('2026-07-14'), end: noon('2026-07-14', '05:40'), reason: 'попросили' }, meta(), clock));
    expect(r.currentVersion).toBe(2);
    expect((await uses(gift.id))[0]).toMatchObject({ status: 'booked', booking_id: bookingId });
    await deliver(GIFT_HANDLERS.bookingConfirmed, await eventId('booking.confirmed', 'bookingId', bookingId));
    expect((await uses(gift.id))[0].status).toBe('booked');
  });
  it('перенос на обычный ресурс → запись освобождена, подарок снова issued', async () => {
    const { gift } = await newGift();
    const bookingId = await book(gift.id, noon('2026-07-08'));
    await tx((c) => rescheduleBooking(c, bookingId, { ctx: owner, rowVersion: 1, resourceId: ids.vr1!, start: noon('2026-07-09'), end: noon('2026-07-09', '05:30'), reason: 'обычная' }, meta(), clock));
    await deliver(GIFT_HANDLERS.bookingRescheduled, await eventId('booking.rescheduled', 'bookingId', bookingId));
    expect(await giftStatus(gift.id)).toBe('issued');
  });
  it('оплата none (K10): брони 0 ₽ – сеанс закрыт без денег', async () => {
    const { gift } = await newGift();
    const bookingId = await book(gift.id, noon('2026-07-10'));
    await tx((c) => markArrived(c, bookingId, visitCmd(1), meta(), fixedClock('2026-07-10T05:00:00Z')));
    const before = (await one('SELECT count(*)::int n FROM journal.finance_operations')).n;
    const r = await tx((c) => recordPayment(c, owner, { bookingId, lines: [{ method: 'none', amountKop: 0 }] }, meta(), { bookings: { ...paymentBookingProvider, facts: (d, id) => bookingLookup.facts(d, id) }, clock: fixedClock('2026-07-10T05:10:00Z') }));
    expect(r.session.status).toBe('paid');
    expect((await one('SELECT count(*)::int n FROM journal.finance_operations')).n).toBe(before);
  });
  it('подарок не виден в «Мои сертификаты»: таблицы и номера раздельны', async () => {
    const { gift, clientId } = await newGift();
    const n = await db.client.query(`SELECT 1 FROM app.certificates WHERE recipient_client_id = $1 OR buyer_client_id = $1`, [clientId]);
    expect(n.rowCount).toBe(0);
    expect(gift.number.startsWith('GF-')).toBe(true);
  });
});

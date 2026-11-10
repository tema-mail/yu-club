// S4-28 (13 §11): остальные события ленты из outbox на настоящей Postgres – брони (booking.confirmed / rescheduled / cancelled → зона
// филиала с schedule.view) и блокировка ресурса (resource_block.created из настоящего createBlock → зона с block.manage).
// Двойная доставка – одна строка, в том числе мимо processed_events; чужой филиал не видит, прочтение чужого – 404;
// блокировка, связанная с ремонтом (repair_blocks), в ленту не идёт – её покрывает repair_registered.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearSubscriptions, processEvent, publish, type EventPayload } from '../../apps/api/src/core/outbox.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import { fixedClock, interval } from '../../apps/api/src/core/time.ts';
import { createBlock } from '../../apps/api/src/modules/booking/blocks.ts';
import { FEED_HANDLERS, listStaffFeed, markFeedRead, registerStaffFeedHandlers } from '../../apps/api/src/modules/notifications/staff-feed.ts';
import { createEquipmentWorld, ctxOf, inTx, metaOf, type EquipmentWorld } from '../helpers/equipment.ts';

const clock = fixedClock('2026-11-14T05:00:00Z');
const TZ = 'Asia/Novosibirsk';
let w: EquipmentWorld;
let n = 0;
const staff: Record<'dir1' | 'dir2' | 'admin1', string> = { dir1: '', dir2: '', admin1: '' };
const ctx = {} as Record<keyof typeof staff, AccessContext>;

type BookingEvent = 'booking.confirmed' | 'booking.rescheduled' | 'booking.cancelled';
type Row = { id: string; branch_id: string; staff_id: string | null; action: string; ref_type: string; ref_id: string; title: string; body: string | null };

const newStaff = async (role: string) =>
  (await w.db.client.query<{ id: string }>(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', $1, $2, 'x') RETURNING id`, [`e${n++}@yu.test`, role])).rows[0]!.id;
const emit = async <T extends BookingEvent>(type: T, bookingId: string, aggregateVersion: number | string, payload: EventPayload<T>) =>
  (await publish(w.db.client, { type, aggregateType: 'booking', aggregateId: bookingId, aggregateVersion, branchId: w.branch, occurredAt: clock.now(), payload })).eventId;
const byEvent = async (kind: string, eventId: string) =>
  (await w.db.client.query<Row>(`SELECT id, branch_id, staff_id, action, ref_type, ref_id, title, body FROM app.staff_feed_events WHERE dedupe_key = $1`, [`${kind}:${eventId}`])).rows[0];
const count = async (kind: string) => (await w.db.client.query<{ n: number }>(`SELECT count(*)::int AS n FROM app.staff_feed_events WHERE kind = $1`, [kind])).rows[0]!.n;
const ids = async (who: keyof typeof staff) => (await listStaffFeed(w.pool, ctx[who], { limit: 50 })).items.map((i) => i.id);
/** Трижды: дважды подряд и ещё раз после удаления отметки processed_events – одна строка ленты. */
async function deliverThrice(handler: string, eventId: string): Promise<void> {
  await processEvent(w.pool, handler, eventId, clock.now());
  await processEvent(w.pool, handler, eventId, clock.now());
  await w.db.client.query(`DELETE FROM app.processed_events WHERE event_id = $1`, [eventId]);
  await processEvent(w.pool, handler, eventId, clock.now());
}
async function expectZoneOnly(row: Row): Promise<void> {
  for (const who of ['dir1', 'admin1'] as const) expect(await ids(who), who).toContain(row.id);
  expect(await ids('dir2')).not.toContain(row.id);
  await expect(markFeedRead(w.pool, ctx.dir2, row.id, clock.now())).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
}
const base = (bookingId: string, number: number) => ({ bookingId, number, branchId: w.branch, branchTimezone: TZ, clientId: w.client });
const SLOT = { start: '2026-11-16T08:00:00Z', end: '2026-11-16T09:00:00Z' }; // 16 ноября, 15:00–16:00 по Новосибирску

beforeAll(async () => {
  w = await createEquipmentWorld(6);
  staff.dir1 = await newStaff('director');
  staff.dir2 = await newStaff('director');
  staff.admin1 = await newStaff('admin');
  ctx.dir1 = ctxOf(clock, 'director', [w.branch], staff.dir1);
  ctx.dir2 = ctxOf(clock, 'director', [w.other], staff.dir2);
  ctx.admin1 = ctxOf(clock, 'admin', [w.branch], staff.admin1);
  clearSubscriptions();
  registerStaffFeedHandlers({ clock });
});
afterAll(async () => {
  clearSubscriptions();
  await w.close();
});

describe('брони (K11 события → зона schedule.view)', () => {
  it('новая запись с сайта: тройная доставка – одна строка; ресурс и время по зоне филиала; чужой филиал не видит', async () => {
    const bookingId = randomUUID();
    const id = await emit('booking.confirmed', bookingId, 1, {
      ...base(bookingId, 1045), checkoutId: randomUUID(), resourceId: w.resources.VR1, resourceName: 'VR-место 1', ...SLOT, priceKop: 50_000, source: 'site', bookingVersion: 1,
    });
    await deliverThrice(FEED_HANDLERS.bookingConfirmed, id);
    expect(await count('booking_created')).toBe(1);
    const row = (await byEvent('booking_created', id))!;
    expect(row).toMatchObject({ branch_id: w.branch, staff_id: null, action: 'schedule.view', ref_type: 'booking', ref_id: bookingId, title: 'Новая запись № 1045', body: 'VR-место 1, 16 ноября, 15:00–16:00, с сайта' });
    await expectZoneOnly(row);
  });

  it('запись из CRM помечена источником', async () => {
    const bookingId = randomUUID();
    const id = await emit('booking.confirmed', bookingId, 1, {
      ...base(bookingId, 1046), checkoutId: randomUUID(), resourceId: w.resources.VR2, resourceName: 'VR-место 2', ...SLOT, priceKop: 50_000, source: 'crm', bookingVersion: 1,
    });
    await processEvent(w.pool, FEED_HANDLERS.bookingConfirmed, id, clock.now());
    expect((await byEvent('booking_created', id))?.body).toBe('VR-место 2, 16 ноября, 15:00–16:00, из CRM');
  });

  it('перенос: было/стало по зоне филиала и новый ресурс', async () => {
    const bookingId = randomUUID();
    const id = await emit('booking.rescheduled', bookingId, 2, {
      ...base(bookingId, 1045), previous: { version: 1, resourceId: w.resources.VR1, ...SLOT },
      current: { version: 2, resourceId: w.resources.VR2, resourceName: 'VR-место 2', start: '2026-11-17T05:00:00Z', end: '2026-11-17T06:00:00Z', priceKop: 50_000 },
    });
    await deliverThrice(FEED_HANDLERS.bookingRescheduled, id);
    expect(await count('booking_rescheduled')).toBe(1);
    const row = (await byEvent('booking_rescheduled', id))!;
    expect(row).toMatchObject({ action: 'schedule.view', ref_type: 'booking', ref_id: bookingId, title: 'Перенос записи № 1045', body: 'Было: 16 ноября, 15:00–16:00. Стало: 17 ноября, 12:00–13:00, VR-место 2' });
    await expectZoneOnly(row);
  });

  it('отмена: клиентом – без причины, клубом – с публичной причиной', async () => {
    const byClient = randomUUID();
    const a = await emit('booking.cancelled', byClient, 'cancelled', { ...base(byClient, 1047), ...SLOT, bookingVersion: 1, cancelledBy: 'client', reasonCode: null, publicReason: null });
    await deliverThrice(FEED_HANDLERS.bookingCancelled, a);
    expect(await count('booking_cancelled')).toBe(1);
    const row = (await byEvent('booking_cancelled', a))!;
    expect(row).toMatchObject({ action: 'schedule.view', ref_type: 'booking', ref_id: byClient, title: 'Отмена записи № 1047', body: '16 ноября, 15:00–16:00, отменил клиент' });
    await expectZoneOnly(row);

    const byClub = randomUUID();
    const b = await emit('booking.cancelled', byClub, 'cancelled', { ...base(byClub, 1048), ...SLOT, bookingVersion: 1, cancelledBy: 'club', reasonCode: 'repair', publicReason: 'Ремонт оборудования' });
    await processEvent(w.pool, FEED_HANDLERS.bookingCancelled, b, clock.now());
    expect((await byEvent('booking_cancelled', b))?.body).toBe('16 ноября, 15:00–16:00, отменил клуб: Ремонт оборудования');
  });
});

describe('блокировка ресурса (createBlock → resource_block.created → зона block.manage)', () => {
  const owner = ctxOf(clock, 'owner');
  const period = interval(new Date('2026-11-16T08:00:00Z'), new Date('2026-11-16T12:00:00Z'));
  const outboxOf = async (blockId: string) =>
    (await w.db.client.query<{ id: string }>(`SELECT id FROM app.outbox_events WHERE event_type = 'resource_block.created' AND aggregate_id = $1`, [blockId])).rows[0]?.id;

  it('createBlock публикует событие; тройная доставка – одна строка с причиной, ресурсом и периодом; чужой филиал не видит', async () => {
    const { blockId } = await inTx(w.pool, (t) => createBlock(t, owner, { branchId: w.branch, target: { type: 'resource', ids: [w.resources.VR1] }, period, reasonId: w.reasonRepair, comment: 'Замена кабеля' }, metaOf(owner), clock));
    const id = (await outboxOf(blockId))!;
    expect(id).toBeTruthy();
    await deliverThrice(FEED_HANDLERS.blockCreated, id);
    expect(await count('block_created')).toBe(1);
    const reason = (await w.db.client.query<{ name: string }>(`SELECT name FROM app.dict_reasons WHERE id = $1`, [w.reasonRepair])).rows[0]!.name;
    const row = (await byEvent('block_created', id))!;
    expect(row).toMatchObject({ branch_id: w.branch, staff_id: null, action: 'block.manage', ref_type: 'resource_block', ref_id: blockId, title: `Блокировка ресурса: ${reason}`, body: 'VR-место 1, 16 ноября, 15:00–19:00. Замена кабеля' });
    await expectZoneOnly(row);
  });

  it('блокировка ремонта (repair_blocks) в ленту не идёт – о ней говорит repair_registered', async () => {
    const SYS = randomUUID();
    const eq = (await w.db.client.query<{ id: string }>(
      `INSERT INTO app.equipment_items (inventory_number, name, category_id, status, branch_id, created_by) VALUES ('INV-000901', 'Шлем', $1, 'repair', $2, $3) RETURNING id`, [w.categoryId, w.branch, SYS],
    )).rows[0]!.id;
    const repairId = (await w.db.client.query<{ id: string }>(
      `INSERT INTO app.repairs (number, equipment_id, branch_id, broken_at_unknown, detected_at, registered_at, symptoms, priority, impact, created_by) VALUES ('R-000901', $1, $2, true, $3, $3, 'сломан', 'critical', 'full', $4) RETURNING id`,
      [eq, w.branch, clock.now(), SYS],
    )).rows[0]!.id;
    const { blockId } = await inTx(w.pool, async (t) => {
      const created = await createBlock(t, owner, { branchId: w.branch, target: { type: 'unit', ids: [w.units.VR2] }, period, reasonId: w.reasonRepair, comment: 'Ремонт R-000901' }, metaOf(owner), clock);
      await t.query(`INSERT INTO app.repair_blocks (repair_id, block_id, linked_at, linked_by) VALUES ($1, $2, $3, $4)`, [repairId, created.blockId, clock.now(), SYS]);
      return created;
    });
    const id = (await outboxOf(blockId))!;
    await deliverThrice(FEED_HANDLERS.blockCreated, id);
    expect(await byEvent('block_created', id)).toBeUndefined();
    expect(await count('block_created')).toBe(1); // только строка предыдущего теста
  });
});

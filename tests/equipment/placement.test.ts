// S3-31: перемещение оборудования (K19 §4, 02 §10, приёмка 10 §17 п.3–4, 19) на настоящей Postgres: история мест, уход из VR1
// при будущей брони или мероприятии – EQUIPMENT_MOVE_HAS_BOOKINGS, с подтверждением – брони и мероприятия целы, список в аудите;
// списанное в единицу – отказ; единица чужого филиала – отказ составного FK; между филиалами без зоны второго – 404.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import { fixedClock, interval } from '../../apps/api/src/core/time.ts';
import { eventOccupancy, occupyForEvent } from '../../apps/api/src/modules/booking/providers.ts';
import { createEquipment, setEquipmentStatus } from '../../apps/api/src/modules/equipment/items.ts';
import { listPlacements, moveEquipment } from '../../apps/api/src/modules/equipment/placement.ts';
import { createBooking, createEquipmentWorld, ctxOf, fails, inTx, metaOf, type EquipmentWorld } from '../helpers/equipment.ts';

const clock = fixedClock('2026-11-14T05:00:00Z');
const AT = '2026-11-14T05:00:00Z';
let w: EquipmentWorld;
let owner: AccessContext;
let director: AccessContext;
let admin: AccessContext;

const create = (body: Record<string, unknown>) => inTx(w.pool, (t) => createEquipment(t, owner, { name: 'Шлем', categoryId: w.categoryId, branchId: w.branch, ...body }, metaOf(owner), clock));
const move = (id: string, body: Record<string, unknown>, who = owner) => inTx(w.pool, (t) => moveEquipment(t, who, id, { at: AT, reason: 'перестановка', ...body }, metaOf(who), clock));
const auditAfter = async (id: string) =>
  (await w.db.client.query<{ actor_id: string; after: Record<string, unknown> }>(`SELECT actor_id, after FROM journal.audit_events WHERE object_id = $1 AND action = 'equipment.moved' ORDER BY id DESC`, [id])).rows[0];

beforeAll(async () => {
  w = await createEquipmentWorld();
  owner = ctxOf(clock, 'owner');
  director = ctxOf(clock, 'director', [w.branch]);
  admin = ctxOf(clock, 'admin', [w.branch]);
});
afterAll(() => w.close());

describe('перемещение (10 §4)', () => {
  it('история прежних мест доступна, текущее – одно (приёмка 3–4)', async () => {
    const a = await create({ unitId: w.units.PS4 });
    const r = await move(a.id, { rowVersion: 1, to: { branchId: w.branch, roomId: w.room } });
    expect(r.equipment.placement).toMatchObject({ unitId: null, roomId: w.room, since: new Date(AT).toISOString() });
    expect(r.blockProposal).toBeNull();
    const history = await listPlacements(w.pool, admin, a.id);
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ roomId: w.room, unitId: null, removedAt: null, reason: 'перестановка' });
    expect(history[1]).toMatchObject({ unitId: w.units.PS4 });
    expect(history[1]!.removedAt).not.toBeNull();
    await fails(listPlacements(w.pool, ctxOf(clock, 'admin', [w.other]), a.id), 'NOT_FOUND');
  });

  it('уход из VR1 при будущей брони и мероприятии: без подтверждения – EQUIPMENT_MOVE_HAS_BOOKINGS, место не изменилось', async () => {
    const bookingId = await createBooking(w, w.resources.VR1, '2026-11-14T08:00:00Z');
    const eventResourceId = randomUUID();
    await inTx(w.pool, (t) => occupyForEvent(t, { branchId: w.branch, resourceId: w.resources.VR1, eventResourceId, period: interval(new Date('2026-11-14T12:00:00Z'), new Date('2026-11-14T14:00:00Z')) }));
    const a = await create({ unitId: w.units.VR1 });
    const err = await fails(move(a.id, { rowVersion: 1, to: { branchId: w.branch } }), 'EQUIPMENT_MOVE_HAS_BOOKINGS');
    expect(err.details).toMatchObject({ bookingIds: [bookingId], eventIds: [eventResourceId] });
    expect((await listPlacements(w.pool, owner, a.id))).toHaveLength(1);

    // с подтверждением – проводится; бронь и мероприятие целы; список и автор в аудите; предложение блокировки на единицу
    const done = await move(a.id, { rowVersion: 1, to: { branchId: w.branch }, acknowledgeBookings: true }, director);
    expect(done.affectedBookingIds).toEqual([bookingId]);
    expect(done.equipment.placement.unitId).toBeNull();
    expect(done.blockProposal).toMatchObject({ target: { type: 'unit', ids: [w.units.VR1] } });
    expect(done.blockProposal!.affectedBookings.map((b) => b.id)).toEqual([bookingId]);
    expect(done.blockProposal!.affectedEvents.map((e) => e.eventId)).toEqual([eventResourceId]);
    const booking = await w.db.client.query<{ status: string }>(`SELECT status FROM app.bookings WHERE id = $1`, [bookingId]);
    expect(booking.rows[0]!.status).toBe('confirmed');
    expect(await eventOccupancy(w.pool, eventResourceId)).toHaveLength(1);
    const audit = await auditAfter(a.id);
    expect(audit?.actor_id).toBe(director.actor.staffId);
    expect(audit?.after).toMatchObject({ acknowledged: true, affectedBookingIds: [bookingId], affectedEventIds: [eventResourceId] });
    expect((await w.db.client.query(`SELECT 1 FROM app.resource_blocks WHERE $1 = ANY(target_ids)`, [w.units.VR1])).rowCount).toBe(0);
  });

  it('уход из единицы без будущих занятий и переезд внутри того же места не требуют подтверждения', async () => {
    const a = await create({ unitId: w.units.PS4 });
    expect((await move(a.id, { rowVersion: 1, to: { branchId: w.branch } })).affectedBookingIds).toEqual([]);
    await fails(move(a.id, { rowVersion: 2, to: { branchId: w.branch } }), 'VALIDATION_FAILED');
  });

  it('списанное в единицу – EQUIPMENT_NOT_PLACEABLE, по филиалу – EQUIPMENT_WRITTEN_OFF; резерв в комнату – отказ (приёмка 19)', async () => {
    const off = await create({});
    await inTx(w.pool, (t) => setEquipmentStatus(t, owner, off.id, { rowVersion: 1, status: 'written_off', reason: 'сгорел' }, metaOf(owner), clock));
    await fails(move(off.id, { rowVersion: 2, to: { branchId: w.branch, unitId: w.units.VR2 } }), 'EQUIPMENT_NOT_PLACEABLE');
    await fails(move(off.id, { rowVersion: 2, to: { branchId: w.other } }), 'EQUIPMENT_WRITTEN_OFF');
    const reserve = await create({ status: 'reserve' });
    await fails(move(reserve.id, { rowVersion: 1, to: { branchId: w.branch, roomId: w.room } }), 'EQUIPMENT_NOT_PLACEABLE');
    expect((await move(reserve.id, { rowVersion: 1, to: { branchId: w.other } })).equipment.placement.branchId).toBe(w.other);
  });

  it('единица или комната чужого филиала – отказ составного FK', async () => {
    const a = await create({});
    await fails(move(a.id, { rowVersion: 1, to: { branchId: w.branch, unitId: w.units.otherUnit } }), 'NOT_FOUND');
    await fails(move(a.id, { rowVersion: 1, to: { branchId: w.branch, roomId: w.otherRoom } }), 'NOT_FOUND');
    expect((await listPlacements(w.pool, owner, a.id))).toHaveLength(1);
  });

  it('между филиалами: Директор без зоны второго – 404; Администратор – 403; с зоной обоих проходит и меняет филиал карточки', async () => {
    const a = await create({});
    await fails(move(a.id, { rowVersion: 1, to: { branchId: w.other } }, director), 'NOT_FOUND');
    await fails(move(a.id, { rowVersion: 1, to: { branchId: w.other } }, admin), 'FORBIDDEN');
    const both = ctxOf(clock, 'director', [w.branch, w.other]);
    expect((await move(a.id, { rowVersion: 1, to: { branchId: w.other, unitId: w.units.otherUnit } }, both)).equipment.placement).toMatchObject({ branchId: w.other, unitId: w.units.otherUnit, roomId: w.otherRoom });
    await fails(move(a.id, { rowVersion: 2, to: { branchId: w.branch } }, director), 'NOT_FOUND');
  });

  it('компонент едет с родителем одной операцией, история у каждого; устаревшая версия и будущий момент – отказ', async () => {
    const parent = await create({ unitId: w.units.PS4 });
    const child = await create({ unitId: w.units.PS4, parentId: parent.id });
    await fails(move(parent.id, { rowVersion: 9, to: { branchId: w.branch, roomId: w.room } }), 'VERSION_CONFLICT');
    await fails(move(parent.id, { rowVersion: 1, at: '2026-12-01T00:00:00Z', to: { branchId: w.branch, roomId: w.room } }), 'VALIDATION_FAILED');
    await move(parent.id, { rowVersion: 1, to: { branchId: w.branch, roomId: w.room } });
    expect(await listPlacements(w.pool, owner, child.id)).toHaveLength(2);
    const audit = await auditAfter(child.id);
    expect(audit?.after).toMatchObject({ withParent: parent.id });
    expect((await listPlacements(w.pool, owner, child.id))[0]).toMatchObject({ roomId: w.room, unitId: null });
  });
});

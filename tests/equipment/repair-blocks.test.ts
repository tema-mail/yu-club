// S3-36: ремонт → блокировка, TC-12 (K19 §8, §17, приёмка 10 §17 п.15–16, 20 §4.2) на настоящей Postgres: бронь VR1 в списке, после
// подтверждения бронь confirmed; праздник в комнате – в affectedEvents, не отменён; новые брони VR1 и комнаты – RESOURCE_BLOCKED, VR2 –
// проходит; без подтверждения блокировки нет (флаг false); при true критическая блокирует сама; простой – по блокировкам; гонка
// «подтверждение блокировки ↔ удержание» 100 раз – либо RESOURCE_BLOCKED, либо удержание в списке.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../../apps/api/src/core/errors.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import { fixedClock, interval } from '../../apps/api/src/core/time.ts';
import { occupy, runOccupancyCommand } from '../../apps/api/src/modules/booking/occupancy.ts';
import { eventOccupancy, occupyForEvent, liftBlockFor } from '../../apps/api/src/modules/booking/providers.ts';
import { createEquipment, setEquipmentStatus } from '../../apps/api/src/modules/equipment/items.ts';
import { confirmBlock, proposeBlock, repairDowntime } from '../../apps/api/src/modules/equipment/repair-blocks.ts';
import { changeRepairStatus, getRepair, registerRepair } from '../../apps/api/src/modules/equipment/repairs.ts';
import { expandToUnits } from '../../apps/api/src/modules/resources/index.ts';
import { createBooking, createEquipmentWorld, ctxOf, fails, inTx, metaOf, type EquipmentWorld } from '../helpers/equipment.ts';

const clock = fixedClock('2026-11-14T05:00:00Z');
const DETECTED = '2026-11-14T05:00:00Z';
let w: EquipmentWorld;
let owner: AccessContext;
let admin: AccessContext;
let foreign: AccessContext;

const item = (body: object) => inTx(w.pool, (t) => createEquipment(t, owner, { name: 'Шлем VR1', categoryId: w.categoryId, branchId: w.branch, ...body }, metaOf(owner), clock));
const register = (equipmentId: string, body: object = {}, who = admin) =>
  inTx(w.pool, (t) => registerRepair(t, who, { equipmentId, detectedAt: DETECTED, brokenAtUnknown: true, symptoms: 'шлем не включается', priority: 'high', impact: 'full', ...body }, metaOf(who), clock));
const confirm = (repairId: string, body: object, who = admin) => inTx(w.pool, (t) => confirmBlock(t, who, repairId, body, metaOf(who), clock));
const slot = (iso: string, minutes = 60) => interval(new Date(iso), new Date(new Date(iso).getTime() + minutes * 60_000));

/** Попытка занять ресурс: удержанием или бронью. */
async function tryOccupy(resourceId: string, iso: string, minutes = 60): Promise<string> {
  const u = await expandToUnits(w.pool, resourceId, new Date(iso));
  try {
    await runOccupancyCommand(w.pool, (c) => occupy(c, { branchId: w.branch, units: u, period: slot(iso, minutes), source: { type: 'booking', id: randomUUID(), version: 1 }, clientId: null }));
    return 'ok';
  } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
}

beforeAll(async () => {
  w = await createEquipmentWorld(40);
  owner = ctxOf(clock, 'owner');
  admin = ctxOf(clock, 'admin', [w.branch]);
  foreign = ctxOf(clock, 'admin', [w.other]);
});
afterAll(() => w.close());

describe('TC-12: поломка шлема VR1 (K19 §17)', () => {
  it('предложение → подтверждение: бронь в списке и confirmed; праздник отдельным списком; VR1 и комната закрыты, VR2 открыт', async () => {
    const bookingId = await createBooking(w, w.resources.VR1, '2026-11-15T07:00:00Z'); // завтра 14:00 по Новосибирску
    const eventResourceId = randomUUID();
    await inTx(w.pool, (t) => occupyForEvent(t, { branchId: w.branch, resourceId: w.resources.whole, eventResourceId, period: slot('2026-11-15T09:00:00Z', 120) }));
    const helmet = await item({ unitId: w.units.VR1 });

    // Регистрация только предлагает: блокировки нет, занятие проходит
    const reg = await register(helmet.id);
    expect(reg.autoBlock).toBeNull();
    expect(reg.blockProposal).toMatchObject({ target: { type: 'unit', ids: [w.units.VR1] }, reasonCode: 'repair' });
    expect(reg.blockProposal!.period.start).toBe(new Date(DETECTED).toISOString());
    expect((await w.db.client.query(`SELECT 1 FROM app.repair_blocks WHERE repair_id = $1`, [reg.repair.id])).rowCount).toBe(0);
    expect(await tryOccupy(w.resources.VR1, '2026-11-14T06:00:00Z', 30)).toBe('ok');

    // Предпросмотр на период с бронью: те же, что даст подтверждение
    const period = { start: '2026-11-14T10:00:00Z', end: '2026-11-16T10:00:00Z' };
    const preview = await proposeBlock(w.pool, admin, reg.repair.id, { period }, clock);
    expect(preview!.affectedBookings.map((b) => b.id)).toEqual([bookingId]);
    expect(preview!.affectedBookings[0]!.client.phoneMasked).not.toContain('79130000099');
    expect(preview!.affectedEvents.map((e) => e.eventId)).toEqual([eventResourceId]);
    expect((await w.db.client.query(`SELECT 1 FROM app.resource_blocks WHERE reason_id = $1`, [w.reasonRepair])).rowCount).toBe(0);

    const done = await confirm(reg.repair.id, { target: preview!.target, period, comment: 'шлем' });
    expect(done.affectedBookingIds).toEqual([bookingId]);
    expect(done.affectedEventIds).toEqual([eventResourceId]);

    // Бронь и мероприятие не тронуты (01 §13, 18 §7.4)
    expect((await w.db.client.query<{ status: string }>(`SELECT status FROM app.bookings WHERE id = $1`, [bookingId])).rows[0]!.status).toBe('confirmed');
    expect(await eventOccupancy(w.pool, eventResourceId)).toHaveLength(3);
    expect((await w.db.client.query<{ n: number }>(`SELECT count(*)::int n FROM app.occupancy WHERE active AND source_id = $1`, [bookingId])).rows[0]!.n).toBe(1);

    // Новые занятия: VR1 и комната – RESOURCE_BLOCKED, VR2 – проходит (приёмка 15–16)
    expect(await tryOccupy(w.resources.VR1, '2026-11-15T12:00:00Z')).toBe('RESOURCE_BLOCKED');
    expect(await tryOccupy(w.resources.whole, '2026-11-15T12:00:00Z')).toBe('RESOURCE_BLOCKED');
    expect(await tryOccupy(w.resources.VR2, '2026-11-15T12:00:00Z')).toBe('ok');

    // Статус ресурса не тронут (K19 §1 п.2) и ремонт показывает блокировку; аудит связи
    expect((await w.db.client.query<{ status: string }>(`SELECT status FROM app.resources WHERE id = $1`, [w.resources.VR1])).rows[0]!.status).toBe('active');
    const card = await getRepair(w.pool, admin, reg.repair.id);
    expect(card.blocks).toEqual([{ blockId: done.blockId, active: true, period: { start: new Date(period.start).toISOString(), end: new Date(period.end).toISOString() }, liftedAt: null }]);
    expect((await w.db.client.query(`SELECT 1 FROM journal.audit_events WHERE action = 'repair.block_linked' AND object_id = $1`, [reg.repair.id])).rowCount).toBe(1);
  });

  it('общий компонент комнаты (телевизор) → блокировка комнаты: все её единицы', async () => {
    const tv = await item({ roomId: w.room, name: 'Телевизор' });
    const reg = await register(tv.id);
    expect(reg.blockProposal!.target).toEqual({ type: 'room', ids: [w.room] });
    const period = { start: '2026-12-01T10:00:00Z', end: '2026-12-01T12:00:00Z' };
    await confirm(reg.repair.id, { target: reg.blockProposal!.target, period });
    expect(await tryOccupy(w.resources.VR2, '2026-12-01T10:30:00Z', 30)).toBe('RESOURCE_BLOCKED');
    expect(await tryOccupy(w.resources.VR1, '2026-12-01T10:30:00Z', 30)).toBe('RESOURCE_BLOCKED');
  });
});

describe('подтверждение (K19 §8)', () => {
  it('Администратор подтверждает; чужой филиал – 404; плохой период, чужая цель и лишнее поле – отказ; закрытый ремонт не блокирует', async () => {
    const eq = await item({ unitId: w.units.PS4 });
    const reg = await register(eq.id);
    const period = { start: '2026-12-02T10:00:00Z', end: '2026-12-02T12:00:00Z' };
    await fails(confirm(reg.repair.id, { target: { type: 'unit', ids: [w.units.PS4] }, period }, foreign), 'NOT_FOUND');
    await fails(proposeBlock(w.pool, foreign, reg.repair.id, {}, clock), 'NOT_FOUND');
    await fails(confirm(reg.repair.id, { target: { type: 'unit', ids: [w.units.PS4] }, period: { start: period.end, end: period.start } }), 'VALIDATION_FAILED');
    await fails(confirm(reg.repair.id, { target: { type: 'unit', ids: [w.units.otherUnit] }, period }), 'RESOURCE_LINK_INVALID');
    await fails(confirm(reg.repair.id, { target: { type: 'resources', ids: [w.resources.VR1] }, period }), 'VALIDATION_FAILED');
    await inTx(w.pool, (t) => changeRepairStatus(t, owner, reg.repair.id, { rowVersion: reg.repair.rowVersion, to: 'cancelled', comment: 'ошибочно' }, metaOf(owner), clock));
    await fails(confirm(reg.repair.id, { target: { type: 'unit', ids: [w.units.PS4] }, period }), 'REPAIR_TRANSITION_INVALID');
  });

  it('привязка существующей блокировки: повтор – без изменений; к другому ремонту – отказ; снятая – отказ', async () => {
    const eq = await item({ unitId: w.units.PS4 });
    const a = await register(eq.id);
    const b = await register(eq.id);
    const created = await confirm(a.repair.id, { target: { type: 'unit', ids: [w.units.PS4] }, period: { start: '2026-12-03T10:00:00Z', end: '2026-12-03T12:00:00Z' } });
    expect((await confirm(a.repair.id, { blockId: created.blockId })).blockId).toBe(created.blockId);
    await fails(confirm(b.repair.id, { blockId: created.blockId }), 'VALIDATION_FAILED');
    await fails(confirm(a.repair.id, { blockId: randomUUID() }), 'NOT_FOUND');
    expect((await w.db.client.query(`SELECT 1 FROM app.repair_blocks WHERE block_id = $1`, [created.blockId])).rowCount).toBe(1);
    await inTx(w.pool, (t) => liftBlockFor(t, owner, created.blockId, {}, metaOf(owner), clock));
    await fails(confirm(a.repair.id, { blockId: created.blockId }), 'VALIDATION_FAILED');
    expect((await proposeBlock(w.pool, admin, a.repair.id, {}, clock))!.otherOpenRepairs).toContain(b.repair.id);
  });

  it('ремонт без места: предложения нет, цель можно задать вручную', async () => {
    const eq = await item({});
    const reg = await register(eq.id);
    expect(reg.blockProposal).toBeNull();
    expect(await proposeBlock(w.pool, admin, reg.repair.id, {}, clock)).toBeNull();
    const manual = await proposeBlock(w.pool, admin, reg.repair.id, { target: { type: 'unit', ids: [w.units.PS4] } }, clock);
    expect(manual!.target.ids).toEqual([w.units.PS4]);
  });
});

describe('место архивировано или опустело (ревью S3-36)', () => {
  it('поломка и смена статуса проходят без предложения; автоблокировка не роняет регистрацию; выбранная сотрудником цель – ошибка', async () => {
    const unit = (await w.db.client.query<{ id: string }>(`INSERT INTO app.occupancy_units (branch_id, room_id, code, name) VALUES ($1, $2, 'ARC', 'Архивная') RETURNING id`, [w.branch, w.room])).rows[0]!.id;
    const empty = (await w.db.client.query<{ id: string }>(`INSERT INTO app.rooms (branch_id, slug, name) VALUES ($1, 'empty', 'Пустая') RETURNING id`, [w.branch])).rows[0]!.id;
    const onUnit = await item({ unitId: unit });
    const inRoom = await item({ roomId: empty });
    await w.db.client.query(`UPDATE app.occupancy_units SET status = 'archived' WHERE id = $1`, [unit]);
    const a = await register(onUnit.id);
    expect(a.repair.unitId).toBe(unit);
    expect(a.blockProposal).toBeNull();
    expect((await register(inRoom.id)).blockProposal).toBeNull();
    const changed = await inTx(w.pool, (t) => setEquipmentStatus(t, owner, onUnit.id, { rowVersion: onUnit.rowVersion, status: 'repair' }, metaOf(owner), clock));
    expect(changed).toMatchObject({ equipment: { status: 'repair' }, blockProposal: null });
    await fails(proposeBlock(w.pool, admin, a.repair.id, { target: { type: 'unit', ids: [unit] } }, clock), 'RESOURCE_LINK_INVALID');
    await w.db.client.query(`INSERT INTO app.settings_values (key, level, value, valid_from, created_by) VALUES ('equipment.critical_auto_block', 'network', 'true', '2026-01-01', $1)`, [randomUUID()]);
    try {
      expect((await register(onUnit.id, { priority: 'critical' })).autoBlock).toBeNull();
    } finally {
      await w.db.client.query(`DELETE FROM app.settings_values WHERE key = 'equipment.critical_auto_block'`);
    }
  });
});

describe('автоблокировка за флагом (Q-111)', () => {
  it('false – критическая только предлагает; true – блокирует сама в той же транзакции, брони целы; не критическая – предложение', async () => {
    const eq = await item({ unitId: w.units.VR2 });
    const off = await register(eq.id, { priority: 'critical' });
    expect(off.autoBlock).toBeNull();
    expect(off.blockProposal).not.toBeNull();
    const bookingId = await createBooking(w, w.resources.VR2, '2026-11-14T15:00:00Z');
    await w.db.client.query(`INSERT INTO app.settings_values (key, level, value, valid_from, created_by) VALUES ('equipment.critical_auto_block', 'network', 'true', '2026-01-01', $1)`, [randomUUID()]);
    try {
      expect((await register(eq.id, { priority: 'high' })).autoBlock).toBeNull();
      const on = await register(eq.id, { priority: 'critical' });
      expect(on.autoBlock!.affectedBookingIds).toEqual([bookingId]);
      expect(on.blockProposal).toBeNull();
      expect(on.repair.id).toBeTruthy();
      expect((await getRepair(w.pool, admin, on.repair.id)).blocks[0]!.period).toEqual({ start: new Date(DETECTED).toISOString(), end: '2026-11-15T05:00:00.000Z' });
      expect((await w.db.client.query<{ status: string }>(`SELECT status FROM app.bookings WHERE id = $1`, [bookingId])).rows[0]!.status).toBe('confirmed');
      expect(await tryOccupy(w.resources.VR2, '2026-11-14T20:00:00Z', 30)).toBe('RESOURCE_BLOCKED');
      const outbox = await w.db.client.query<{ payload: { autoBlockId: string } }>(`SELECT payload FROM app.outbox_events WHERE event_type = 'repair.registered' AND aggregate_id = $1`, [on.repair.id]);
      expect(outbox.rows[0]!.payload.autoBlockId).toBe(on.autoBlock!.blockId);
      const noPlace = await item({});
      expect((await register(noPlace.id, { priority: 'critical' })).autoBlock).toBeNull();
    } finally {
      await w.db.client.query(`DELETE FROM app.settings_values WHERE key = 'equipment.critical_auto_block'`);
    }
  });
});

describe('простой (10 §15)', () => {
  it('только по блокировкам: без блокировки – не простой; снятие и «сейчас» обрезают; пересечения не удваиваются', async () => {
    const later = fixedClock('2026-12-10T12:00:00Z');
    const eq = await item({ unitId: w.units.PS4 });
    const reg = await register(eq.id);
    expect(await repairDowntime(w.pool, admin, reg.repair.id, later)).toEqual({ minutes: 0, hasBlocks: false });
    const a = await confirm(reg.repair.id, { target: { type: 'unit', ids: [w.units.PS4] }, period: { start: '2026-12-10T10:00:00Z', end: '2026-12-10T11:00:00Z' } });
    await confirm(reg.repair.id, { target: { type: 'unit', ids: [w.units.PS4] }, period: { start: '2026-12-10T10:30:00Z', end: '2026-12-10T11:30:00Z' } });
    expect(await repairDowntime(w.pool, admin, reg.repair.id, later)).toEqual({ minutes: 90, hasBlocks: true });
    expect(await repairDowntime(w.pool, admin, reg.repair.id, fixedClock('2026-12-10T10:10:00Z'))).toEqual({ minutes: 10, hasBlocks: true });
    expect(a.blockId).toBeTruthy();
  });
});

describe('гонка «подтверждение блокировки ↔ удержание» (K6, S3-36)', () => {
  it('100 пар на настоящей базе: либо RESOURCE_BLOCKED у удержания, либо удержание в списке затронутых', async () => {
    const eq = await item({ unitId: w.units.VR1 });
    const { repair } = await register(eq.id, { impact: 'none' });
    const outcomes = { blocked: 0, listed: 0 };
    for (let k = 0; k < 100; k++) {
      const start = new Date(Date.parse('2027-01-01T00:00:00Z') + k * 3_600_000);
      const period = { start: start.toISOString(), end: new Date(start.getTime() + 3_000_000).toISOString() };
      const hold = (await w.db.client.query<{ id: string }>(`INSERT INTO app.holds (branch_id, client_id, created_by_type, ttl_minutes, expires_at) VALUES ($1, $2, 'client', 15, '2027-12-31') RETURNING id`, [w.branch, w.client])).rows[0]!.id;
      const holdItem = (
        await w.db.client.query<{ id: string }>(
          `INSERT INTO app.hold_items (hold_id, resource_id, period, unit_ids) VALUES ($1, $2, tstzrange($3, $4, '[)'), $5) RETURNING id`,
          [hold, w.resources.VR1, period.start, period.end, [w.units.VR1]],
        )
      ).rows[0]!.id;
      const units = await expandToUnits(w.pool, w.resources.VR1, start);
      const expiresAt = new Date('2027-12-31T00:00:00Z');
      const [held, blocked] = await Promise.allSettled([
        runOccupancyCommand(w.pool, (c) => occupy(c, { branchId: w.branch, units, period: interval(start, new Date(period.end)), source: { type: 'hold_item', id: holdItem, holdExpiresAt: expiresAt }, clientId: null })),
        confirm(repair.id, { target: { type: 'unit', ids: [w.units.VR1] }, period }),
      ]);
      expect(blocked.status).toBe('fulfilled');
      const list = (blocked as PromiseFulfilledResult<{ affectedHoldIds: string[] }>).value.affectedHoldIds;
      if (held.status === 'rejected') {
        expect((held.reason as AppError).code).toBe('RESOURCE_BLOCKED');
        expect(list).toEqual([]);
        outcomes.blocked++;
      } else {
        expect(list).toEqual([hold]);
        outcomes.listed++;
      }
    }
    expect(outcomes.blocked + outcomes.listed).toBe(100);
  }, 120_000);
});

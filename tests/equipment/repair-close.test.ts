// S3-37: закрытие ремонта, гарантии, повтор (K19 §7, §9, приёмка 10 §17 п.17): без суммы и без «без затрат» – REPAIR_CLOSE_INCOMPLETE;
// второй открытый ремонт на комнате – блокировка не снята (other_open_repair, 02 §11); снятая остаётся в истории; повторная поломка
// показывает прошлые ремонты и гарантии, гарантийной сама не становится (10 §10.2).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../../apps/api/src/core/errors.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import { fixedClock, interval } from '../../apps/api/src/core/time.ts';
import { occupy, runOccupancyCommand } from '../../apps/api/src/modules/booking/occupancy.ts';
import { liftBlockFor } from '../../apps/api/src/modules/booking/providers.ts';
import { createExecutor } from '../../apps/api/src/modules/equipment/executors.ts';
import { reverseOperation } from '../../apps/api/src/modules/finance/corrections.ts';
import { createRepairExpense } from '../../apps/api/src/modules/equipment/repair-expense.ts';
import { createEquipment, getEquipment, setEquipmentStatus } from '../../apps/api/src/modules/equipment/items.ts';
import { confirmBlock } from '../../apps/api/src/modules/equipment/repair-blocks.ts';
import { closeRepair, createWarranty, invalidateWarranty, listWarranties } from '../../apps/api/src/modules/equipment/repair-close.ts';
import { approveRepair, changeRepairStatus, getRepair, registerRepair, updateRepair, type RepairDto } from '../../apps/api/src/modules/equipment/repairs.ts';
import { expandToUnits } from '../../apps/api/src/modules/resources/index.ts';
import { createBooking, createEquipmentWorld, ctxOf, fails, inTx, metaOf, type EquipmentWorld } from '../helpers/equipment.ts';

const clock = fixedClock('2026-11-14T05:00:00Z');
const DONE = '2026-11-14T04:30:00Z';
let w: EquipmentWorld;
let owner: AccessContext;
let director: AccessContext;
let admin: AccessContext;
let executorId = '';

const item = (body: object) => inTx(w.pool, (t) => createEquipment(t, owner, { name: 'Шлем', categoryId: w.categoryId, branchId: w.branch, ...body }, metaOf(owner), clock));
const register = (equipmentId: string, body: object = {}) =>
  inTx(w.pool, (t) => registerRepair(t, admin, { equipmentId, detectedAt: '2026-11-14T04:00:00Z', brokenAtUnknown: true, symptoms: 'сломалось', priority: 'high', impact: 'full', ...body }, metaOf(admin), clock));
const status = (r: { id: string; rowVersion: number }, to: string) => inTx(w.pool, (t) => changeRepairStatus(t, director, r.id, { rowVersion: r.rowVersion, to, comment: 'ход работ' }, metaOf(director), clock));
const toCheck = async (r: RepairDto) => status(await status(r, 'in_repair'), 'done_pending_check');
const close = (r: { id: string; rowVersion: number }, body: object, who = director) =>
  inTx(w.pool, (t) => closeRepair(t, who, r.id, { rowVersion: r.rowVersion, worksDone: 'заменили плату', completedAt: DONE, finalEquipmentStatus: 'in_service', actualCostKop: 500000, executorId, ...body }, metaOf(who), clock));
const block = (repairId: string, target: object, start: string, end: string) => inTx(w.pool, (t) => confirmBlock(t, admin, repairId, { target, period: { start, end } }, metaOf(admin), clock));
const blockStatus = async (id: string) => (await w.db.client.query<{ status: string; lifted_at: Date | null }>(`SELECT status, lifted_at FROM app.resource_blocks WHERE id = $1`, [id])).rows[0]!;
async function tryOccupy(resourceId: string, iso: string): Promise<string> {
  const u = await expandToUnits(w.pool, resourceId, new Date(iso));
  try {
    await runOccupancyCommand(w.pool, (c) => occupy(c, { branchId: w.branch, units: u, period: interval(new Date(iso), new Date(new Date(iso).getTime() + 1_800_000)), source: { type: 'booking', id: randomUUID(), version: 1 }, clientId: null }));
    return 'ok';
  } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
}

beforeAll(async () => {
  w = await createEquipmentWorld();
  owner = ctxOf(clock, 'owner');
  director = ctxOf(clock, 'director', [w.branch]);
  admin = ctxOf(clock, 'admin', [w.branch]);
  executorId = (await inTx(w.pool, (t) => createExecutor(t, owner, { kind: 'service_center', name: 'Сервис' }, metaOf(owner), clock))).id;
});
afterAll(() => w.close());

describe('поля закрытия (10 §13.5)', () => {
  it('без суммы и без «без затрат» – REPAIR_CLOSE_INCOMPLETE со списком полей; оба сразу – тоже; «без затрат» без комментария', async () => {
    const eq = await item({});
    const r = await toCheck((await register(eq.id)).repair);
    const err = await fails(close(r, { actualCostKop: undefined }), 'REPAIR_CLOSE_INCOMPLETE');
    expect(err.details?.fields).toEqual(expect.arrayContaining(['actualCostKop', 'noCost']));
    await fails(close(r, { noCost: true }), 'REPAIR_CLOSE_INCOMPLETE');
    const noComment = await fails(close(r, { actualCostKop: undefined, noCost: true }), 'REPAIR_CLOSE_INCOMPLETE');
    expect(noComment.details?.fields).toEqual(['costComment']);
    const all = await fails(close(r, { worksDone: undefined, completedAt: undefined, finalEquipmentStatus: undefined, executorId: null }), 'REPAIR_CLOSE_INCOMPLETE');
    expect(all.details?.fields).toEqual(expect.arrayContaining(['worksDone', 'completedAt', 'finalEquipmentStatus', 'executorId']));
    await fails(close(r, { completedAt: '2026-11-13T00:00:00Z' }), 'REPAIR_DATES_INVALID');
    await fails(close(r, { completedAt: '2026-11-15T00:00:00Z' }), 'REPAIR_DATES_INVALID');
  });

  it('закрытие: итоговый статус оборудования выбирает сотрудник, снимок исполнителя, событие, аудит; из другого статуса и повторно – отказ', async () => {
    const eq = await item({ unitId: w.units.PS4 });
    const reg = await register(eq.id);
    await fails(close(reg.repair, {}), 'REPAIR_TRANSITION_INVALID');
    const r = await toCheck(reg.repair);
    expect((await getEquipment(w.pool, owner, eq.id)).status).toBe('repair');
    const closed = await close(r, { finalEquipmentStatus: 'reserve' });
    expect(closed.repair).toMatchObject({ status: 'closed', actualCostKop: 500000, noCost: false, finalEquipmentStatus: 'reserve', worksDone: 'заменили плату', acceptedBy: director.actor.staffId, executor: { id: executorId, snapshot: { name: 'Сервис' } } });
    expect(closed.stillBlocked).toEqual([]);
    expect((await getEquipment(w.pool, owner, eq.id))).toMatchObject({ status: 'reserve', placement: { unitId: null } }); // резерв покидает единицу
    await fails(close(closed.repair, {}), 'REPAIR_TRANSITION_INVALID');
    const outbox = await w.db.client.query(`SELECT 1 FROM app.outbox_events WHERE event_type = 'repair.closed' AND aggregate_id = $1`, [r.id]);
    expect(outbox.rowCount).toBe(1);
    const audit = await w.db.client.query<{ after: { stillBlocked: unknown[] } }>(`SELECT after FROM journal.audit_events WHERE object_id = $1 AND action = 'repair.closed'`, [r.id]);
    expect(audit.rows[0]!.after.stillBlocked).toEqual([]);
  });

  it('«ремонт не потребовался»: диагностика → проверка, без исполнителя и «без затрат» с комментарием', async () => {
    const eq = await item({});
    const d = await status((await register(eq.id)).repair, 'diagnostics');
    const r = await status(d, 'done_pending_check');
    const closed = await close(r, { worksDone: 'ремонт не потребовался: был выключен кабель', actualCostKop: undefined, noCost: true, costComment: 'без затрат', executorId: undefined });
    expect(closed.repair).toMatchObject({ status: 'closed', noCost: true, actualCostKop: null, payment: { status: 'no_cost' }, executor: { id: null } });
  });
});

describe('кто принимает (Q-52)', () => {
  it('Администратор принимает ≤ порога; выше порога и списание – FORBIDDEN; Директор закрывает выше порога, но не списывает', async () => {
    const eq = await item({});
    const small = await toCheck((await register(eq.id)).repair);
    await fails(close(small, { actualCostKop: 1_000_001 }, admin), 'FORBIDDEN');
    await fails(close(small, { finalEquipmentStatus: 'written_off' }, admin), 'FORBIDDEN');
    await fails(close(small, { finalEquipmentStatus: 'written_off', actualCostKop: 1 }, director), 'FORBIDDEN');
    const accepted = await close(small, { actualCostKop: 1_000_000 }, admin);
    expect(accepted.repair.acceptedBy).toBe(admin.actor.staffId);
    const big = await toCheck((await register(eq.id)).repair);
    expect((await close(big, { actualCostKop: 5_000_000 }, director)).repair.status).toBe('closed');
    const dead = await toCheck((await register(eq.id)).repair);
    expect((await close(dead, { finalEquipmentStatus: 'written_off' }, owner)).repair.finalEquipmentStatus).toBe('written_off');
    expect((await getEquipment(w.pool, owner, eq.id)).status).toBe('written_off');
    const foreign = ctxOf(clock, 'director', [w.other]);
    await fails(close(big, {}, foreign), 'NOT_FOUND');
  });
});

describe('дыры закрытия (ревью S3-37)', () => {
  it('выход из lost закрытием – только Владелец: Директор и Администратор получают FORBIDDEN', async () => {
    const eq = await item({});
    const r = await toCheck((await register(eq.id)).repair);
    const cur = await getEquipment(w.pool, owner, eq.id);
    await inTx(w.pool, (t) => setEquipmentStatus(t, owner, eq.id, { rowVersion: cur.rowVersion, status: 'lost', reason: 'пропал' }, metaOf(owner), clock));
    await fails(close(r, {}, director), 'FORBIDDEN');
    await fails(close(r, {}, admin), 'FORBIDDEN');
    expect((await getEquipment(w.pool, owner, eq.id)).status).toBe('lost');
    expect((await close(r, {}, owner)).repair.status).toBe('closed');
    expect((await getEquipment(w.pool, owner, eq.id)).status).toBe('in_service');
  });

  it('порог для Администратора считает и план: «без затрат» и 1 ₽ на плане выше порога – FORBIDDEN', async () => {
    const eq = await item({});
    const { repair } = await register(eq.id);
    const planned = await inTx(w.pool, (t) => updateRepair(t, director, repair.id, { rowVersion: repair.rowVersion, plan: { costKop: 2_000_000 } }, metaOf(director), clock));
    const waiting = await status(await status(planned, 'diagnostics'), 'awaiting_approval');
    const ok = await inTx(w.pool, (t) => approveRepair(t, owner, repair.id, { rowVersion: waiting.rowVersion, decision: 'approve', comment: 'да' }, metaOf(owner), clock));
    const r = await toCheck(ok);
    await fails(close(r, { actualCostKop: undefined, noCost: true, costComment: 'нет затрат' }, admin), 'FORBIDDEN');
    await fails(close(r, { actualCostKop: 1 }, admin), 'FORBIDDEN');
    expect((await close(r, { actualCostKop: 1_900_000 }, director)).repair.status).toBe('closed');
  });

  it('«без затрат» при живом расходе – отказ; после сторно – можно; 0 ₽ вместо «без затрат» – отказ; executorId: null убирает снимок', async () => {
    await w.db.client.query(`INSERT INTO app.settings_values (key, level, branch_id, value, valid_from, created_by) VALUES ('finance.negative_balance_allowed', 'branch', $1, 'true', '2026-01-01', $2)`, [w.branch, randomUUID()]);
    const eq = await item({});
    const d = await status((await register(eq.id)).repair, 'diagnostics');
    const op = await inTx(w.pool, (t) => createRepairExpense(t, director, d.id, { branchId: w.branch, method: 'cash', amountKop: 1000, occurredAt: DONE }, metaOf(director), { idempotencyKey: randomUUID(), clock }));
    const assigned = await inTx(w.pool, (t) => updateRepair(t, director, d.id, { rowVersion: d.rowVersion, executorId }, metaOf(director), clock));
    const r = await status(assigned, 'done_pending_check');
    const free = { actualCostKop: undefined, noCost: true, costComment: 'нет затрат', executorId: null };
    const err = await fails(close(r, free), 'REPAIR_CLOSE_INCOMPLETE');
    expect(err.details).toMatchObject({ fields: ['noCost'], operationIds: [op.id] });
    expect((await fails(close(r, { actualCostKop: 0 }), 'REPAIR_CLOSE_INCOMPLETE')).details?.fields).toEqual(['noCost']);
    await inTx(w.pool, (t) => reverseOperation(t, owner, { operationId: op.id, reason: 'ошибка' }, metaOf(owner), { idempotencyKey: randomUUID(), clock }));
    const closed = await close(r, free);
    expect(closed.repair).toMatchObject({ noCost: true, payment: { status: 'no_cost', paidKop: 0 }, executor: { id: null, snapshot: null } });
  });
});

describe('снятие блокировок (10 §12.2, 02 §11, приёмка 17)', () => {
  it('снимается только выбранная; невыбранная – not_selected; снятая остаётся в истории; занятие снова проходит; прошлая бронь цела', async () => {
    const eq = await item({ unitId: w.units.VR1 });
    const reg = await register(eq.id);
    const bookingId = await createBooking(w, w.resources.VR1, '2026-11-20T10:00:00Z');
    const a = await block(reg.repair.id, { type: 'unit', ids: [w.units.VR1] }, '2026-11-20T06:00:00Z', '2026-11-20T18:00:00Z');
    const b = await block(reg.repair.id, { type: 'unit', ids: [w.units.VR1] }, '2026-11-21T06:00:00Z', '2026-11-21T18:00:00Z');
    const r = await toCheck(await getRepair(w.pool, admin, reg.repair.id));
    await fails(close(r, { liftBlockIds: [randomUUID()] }), 'NOT_FOUND');
    const closed = await close(r, { liftBlockIds: [a.blockId] });
    expect(closed.stillBlocked).toEqual([{ blockId: b.blockId, reason: 'not_selected' }]);
    expect(await blockStatus(a.blockId)).toMatchObject({ status: 'lifted' });
    expect((await blockStatus(a.blockId)).lifted_at).not.toBeNull();
    expect(await blockStatus(b.blockId)).toMatchObject({ status: 'active' });
    const history = closed.repair.blocks.find((x) => x.blockId === a.blockId);
    expect(history).toMatchObject({ active: false, liftedAt: clock.now().toISOString() });
    expect(await tryOccupy(w.resources.VR1, '2026-11-20T14:00:00Z')).toBe('ok');
    expect(await tryOccupy(w.resources.VR1, '2026-11-21T14:00:00Z')).toBe('RESOURCE_BLOCKED');
    expect((await w.db.client.query<{ status: string }>(`SELECT status FROM app.bookings WHERE id = $1`, [bookingId])).rows[0]!.status).toBe('confirmed');
    const outbox = await w.db.client.query<{ payload: { stillBlockedIds: string[] } }>(`SELECT payload FROM app.outbox_events WHERE event_type = 'repair.closed' AND aggregate_id = $1`, [r.id]);
    expect(outbox.rows[0]!.payload.stillBlockedIds).toEqual([b.blockId]);
  });

  it('второй открытый ремонт на той же комнате – блокировка не снята, даже выбранная (other_open_repair); после закрытия второго снимает сотрудник', async () => {
    const tv = await item({ roomId: w.room, name: 'Телевизор' });
    const headset = await item({ unitId: w.units.VR2, name: 'Шлем VR2' });
    const first = await register(tv.id);
    const second = await register(headset.id);
    const roomBlock = await block(first.repair.id, { type: 'room', ids: [w.room] }, '2026-11-25T06:00:00Z', '2026-11-25T18:00:00Z');
    const r = await toCheck(await getRepair(w.pool, admin, first.repair.id));
    const closed = await close(r, { liftBlockIds: [roomBlock.blockId] });
    expect(closed.stillBlocked).toEqual([{ blockId: roomBlock.blockId, reason: 'other_open_repair' }]);
    expect(await blockStatus(roomBlock.blockId)).toMatchObject({ status: 'active' });
    expect(await tryOccupy(w.resources.VR1, '2026-11-25T10:00:00Z')).toBe('RESOURCE_BLOCKED');

    // Ремонт на другой единице блокировку VR1 не держит: пересечения единиц нет
    const headset1 = await item({ unitId: w.units.VR1, name: 'Шлем VR1' });
    const third = await register(headset1.id);
    const unitBlock = await block(third.repair.id, { type: 'unit', ids: [w.units.VR1] }, '2026-11-26T06:00:00Z', '2026-11-26T18:00:00Z');
    const t = await toCheck(await getRepair(w.pool, admin, third.repair.id));
    expect((await close(t, { liftBlockIds: [unitBlock.blockId] })).stillBlocked).toEqual([]);

    const s = await toCheck(second.repair);
    expect((await close(s, {})).stillBlocked).toEqual([]);
    // Осталась за закрытым ремонтом: сама не снимается, снимает сотрудник (K11 №14)
    expect(await blockStatus(roomBlock.blockId)).toMatchObject({ status: 'active' });
    await inTx(w.pool, (t) => liftBlockFor(t, admin, roomBlock.blockId, {}, metaOf(admin), clock));
    expect(await tryOccupy(w.resources.VR1, '2026-11-25T10:00:00Z')).toBe('ok');
  });
});

describe('гарантии и повтор (K19 §9, 10 §10)', () => {
  it('гарантия на работы при закрытии; производителя – отдельно; повторная поломка показывает прошлые ремонты и гарантии, но гарантийной не становится', async () => {
    const eq = await item({});
    const first = await toCheck((await register(eq.id)).repair);
    await close(first, { warranty: { startsOn: '2026-11-14', endsOn: '2027-02-14', terms: '3 месяца', issuer: 'Сервис' } });
    const manufacturer = await inTx(w.pool, (t) => createWarranty(t, director, eq.id, { kind: 'manufacturer', startsOn: '2026-01-01', endsOn: '2028-01-01' }, metaOf(director), clock));
    const list = await listWarranties(w.pool, admin, eq.id);
    expect(list.map((x) => x.kind).sort()).toEqual(['manufacturer', 'repair']);
    expect(list.find((x) => x.kind === 'repair')).toMatchObject({ repairId: first.id, endsOn: '2027-02-14' });

    const again = await register(eq.id, { previousRepairId: first.id });
    expect(again.details.history.map((h) => h.id)).toEqual([first.id]);
    expect(again.details.warranties.map((x) => x.kind).sort()).toEqual(['manufacturer', 'repair']);
    expect(again.repair).toMatchObject({ previousRepairId: first.id, actualCostKop: null, noCost: false, status: 'new' });
    expect(JSON.stringify(again.repair)).not.toMatch(/warranty/i);

    const bad = await inTx(w.pool, (t) => invalidateWarranty(t, director, manufacturer.id, { reason: 'ошибка ввода' }, metaOf(director), clock));
    expect(bad.status).toBe('invalid');
    const after = await register(eq.id);
    expect(after.details.warranties.map((x) => x.kind)).toEqual(['repair']);
    await expect(w.pool.query(`DELETE FROM app.equipment_warranties WHERE id = $1`, [manufacturer.id])).rejects.toMatchObject({ code: '42501' });
    expect((await w.db.client.query(`SELECT 1 FROM journal.audit_events WHERE object_id = $1 AND action = 'warranty.invalidated'`, [manufacturer.id])).rowCount).toBe(1);
  });

  it('проверки: конец раньше начала, вид и ремонт не сходятся, чужое вложение, Администратору – нет, чужой филиал – 404', async () => {
    const eq = await item({});
    const create = (body: object, who = director) => inTx(w.pool, (t) => createWarranty(t, who, eq.id, body, metaOf(who), clock));
    await fails(create({ kind: 'manufacturer', startsOn: '2027-01-01', endsOn: '2026-01-01' }), 'VALIDATION_FAILED');
    await fails(create({ kind: 'repair', startsOn: '2026-01-01', endsOn: '2027-01-01' }), 'VALIDATION_FAILED');
    await fails(create({ kind: 'manufacturer', repairId: randomUUID(), startsOn: '2026-01-01', endsOn: '2027-01-01' }), 'VALIDATION_FAILED');
    await fails(create({ kind: 'manufacturer', attachmentId: randomUUID(), startsOn: '2026-01-01', endsOn: '2027-01-01' }), 'VALIDATION_FAILED');
    await fails(create({ kind: 'manufacturer', startsOn: '2026-01-01', endsOn: '2027-01-01' }, admin), 'FORBIDDEN');
    await fails(create({ kind: 'manufacturer', startsOn: '2026-01-01', endsOn: '2027-01-01' }, ctxOf(clock, 'director', [w.other])), 'NOT_FOUND');
    await fails(listWarranties(w.pool, ctxOf(clock, 'admin', [w.other]), eq.id), 'NOT_FOUND');
  });

  it('план и ремонт после закрытия не правятся', async () => {
    const eq = await item({});
    const r = await toCheck((await register(eq.id)).repair);
    const closed = await close(r, {});
    await fails(inTx(w.pool, (t) => updateRepair(t, director, r.id, { rowVersion: closed.repair.rowVersion, cause: 'x' }, metaOf(director), clock)), 'REPAIR_TRANSITION_INVALID');
    await fails(status(closed.repair, 'in_repair'), 'REPAIR_TRANSITION_INVALID');
  });
});

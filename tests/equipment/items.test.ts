// S3-30: карточка оборудования (K19 §2–§3, приёмка 10 §17 п.1–2, 19). Настоящая Postgres: номер без дублей при 50 параллельных
// созданиях, дубль серийного – предупреждение, written_off – конечный, правка стоимости Директором – FORBIDDEN, статус
// только предлагает блокировку и ничего не закрывает.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateDown, migrateUp } from '../../db/migrate.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { createCategory, createEquipment, listCategories, setEquipmentStatus, updateCategory, updateEquipment } from '../../apps/api/src/modules/equipment/items.ts';
import { registerRepair } from '../../apps/api/src/modules/equipment/repairs.ts';
import { createBooking, createEquipmentWorld, ctxOf, fails, inTx, metaOf, type EquipmentWorld } from '../helpers/equipment.ts';
import { createTestDatabase } from '../helpers/pg.ts';

const clock = fixedClock('2026-11-14T05:00:00Z');
let w: EquipmentWorld;
let owner: AccessContext;
let director: AccessContext;
let admin: AccessContext;
let foreign: AccessContext;

const create = (body: Record<string, unknown>, who = owner) => inTx(w.pool, (t) => createEquipment(t, who, { name: 'Шлем Quest', categoryId: w.categoryId, branchId: w.branch, ...body }, metaOf(who), clock));
const setStatus = (id: string, body: Record<string, unknown>, who = owner) => inTx(w.pool, (t) => setEquipmentStatus(t, who, id, body, metaOf(who), clock));
const update = (id: string, body: Record<string, unknown>, who = owner) => inTx(w.pool, (t) => updateEquipment(t, who, id, body, metaOf(who), clock));
const auditOf = async (id: string) => (await w.db.client.query<{ action: string; before: unknown; after: unknown; reason: string | null }>(`SELECT action, before, after, reason FROM journal.audit_events WHERE object_id = $1 ORDER BY id`, [id])).rows;

beforeAll(async () => {
  w = await createEquipmentWorld(60);
  owner = ctxOf(clock, 'owner');
  director = ctxOf(clock, 'director', [w.branch]);
  admin = ctxOf(clock, 'admin', [w.branch]);
  foreign = ctxOf(clock, 'director', [w.other]);
});
afterAll(() => w.close());

describe('0304: схема', () => {
  it('вверх/вниз/вверх на чистой базе; посев категорий 10 §3.2', async () => {
    const clean = await createTestDatabase({ migrate: true });
    try {
      const n = async () => (await clean.client.query<{ n: number }>(`SELECT count(*)::int n FROM app.equipment_categories`)).rows[0]!.n;
      expect(await n()).toBe(10);
      const applied = (await clean.client.query<{ version: string }>(`SELECT version FROM schema_migrations ORDER BY version`)).rows.map((r) => r.version);
      await migrateDown(clean.client, applied.length - applied.indexOf('0304'));
      expect((await clean.client.query<{ t: string | null }>(`SELECT to_regclass('app.equipment_items')::text t`)).rows[0]!.t).toBeNull();
      await migrateUp(clean.client);
      expect(await n()).toBe(10);
    } finally {
      await clean.drop();
    }
  });

  it('у yu_app нет DELETE и правки инвентарного номера; единица чужого филиала отвергается составным FK', async () => {
    const item = await create({});
    await expect(w.pool.query('DELETE FROM app.equipment_items WHERE id = $1', [item.id])).rejects.toMatchObject({ code: '42501' });
    await expect(w.pool.query(`UPDATE app.equipment_items SET inventory_number = 'INV-999999' WHERE id = $1`, [item.id])).rejects.toMatchObject({ code: '42501' });
    await expect(
      w.db.client.query(`INSERT INTO app.equipment_placements (item_id, branch_id, unit_id, placed_at, removed_at, moved_by, reason) VALUES ($1, $2, $3, now(), now(), $4, 'x')`, [item.id, w.branch, w.units.otherUnit, randomUUID()]),
    ).rejects.toMatchObject({ code: '23503' });
  });
});

describe('карточка (10 §3)', () => {
  it('номер INV-000001… без дублей при 50 параллельных созданиях', async () => {
    const all = await Promise.all(Array.from({ length: 50 }, (_, i) => create({ name: `ПК ${i}` })));
    const numbers = all.map((x) => x.inventoryNumber);
    expect(new Set(numbers).size).toBe(50);
    for (const n of numbers) expect(n).toMatch(/^INV-\d{6}$/);
  });

  it('дубль серийного в той же категории и модели – предупреждение, сохранение не блокируется; другая модель – нет', async () => {
    const a = await create({ serialNumber: 'SN-1', model: 'Quest 3' });
    expect(a.details).toBeUndefined();
    const b = await create({ serialNumber: 'SN-1', model: 'Quest 3' });
    expect(b.details?.duplicateOf).toEqual([a.id]);
    expect((await create({ serialNumber: 'SN-1', model: 'Quest 2' })).details).toBeUndefined();
  });

  it('создание пишет размещение в единицу и аудит; комната выводится из единицы; резерв в единицу – EQUIPMENT_NOT_PLACEABLE', async () => {
    const a = await create({ unitId: w.units.VR1 });
    expect(a.placement).toMatchObject({ branchId: w.branch, unitId: w.units.VR1, roomId: w.room });
    expect(a.status).toBe('in_service');
    expect((await auditOf(a.id))[0]!.action).toBe('equipment.created');
    await fails(create({ unitId: w.units.VR1, status: 'reserve' }), 'EQUIPMENT_NOT_PLACEABLE');
    expect((await create({ status: 'reserve' })).status).toBe('reserve');
  });

  it('единица чужого филиала – отказ; комната не той единицы – отказ', async () => {
    await fails(create({ unitId: w.units.otherUnit }), 'NOT_FOUND');
    await fails(create({ unitId: w.units.VR1, roomId: w.otherRoom }), 'VALIDATION_FAILED');
  });

  it('родитель: глубина не больше 3, чужой филиал и цикл – отказ', async () => {
    const a = await create({});
    const b = await create({ parentId: a.id });
    const c = await create({ parentId: b.id });
    await fails(create({ parentId: c.id }), 'VALIDATION_FAILED');
    await fails(update(a.id, { rowVersion: a.rowVersion, parentId: c.id }), 'VALIDATION_FAILED');
    const away = await create({ branchId: w.other });
    await fails(create({ parentId: away.id }), 'VALIDATION_FAILED');
  });

  it('права: Администратор не создаёт; чужой филиал – 404; поле пароля отвергается схемой', async () => {
    await fails(create({}, admin), 'FORBIDDEN');
    await fails(create({}, foreign), 'NOT_FOUND');
    await fails(create({ password: 'секрет' }), 'VALIDATION_FAILED');
  });

  it('правка: Директор меняет имя, стоимость и серийный – FORBIDDEN; Владелец – можно, серийный – отдельный код аудита; устаревшая версия – конфликт', async () => {
    const a = await create({ purchaseCostKop: 100000, serialNumber: 'S-A' }, director);
    const named = await update(a.id, { rowVersion: a.rowVersion, name: 'Новое имя' }, director);
    expect(named).toMatchObject({ name: 'Новое имя', rowVersion: a.rowVersion + 1 });
    await fails(update(a.id, { rowVersion: named.rowVersion, purchaseCostKop: 200000 }, director), 'FORBIDDEN');
    await fails(update(a.id, { rowVersion: named.rowVersion, serialNumber: 'S-B' }, director), 'FORBIDDEN');
    await fails(update(a.id, { rowVersion: named.rowVersion, legacyNumber: 'L' }, director), 'FORBIDDEN');
    expect((await update(a.id, { rowVersion: named.rowVersion, purchaseCostKop: 100000 }, director)).purchaseCostKop).toBe(100000); // та же сумма – не правка
    await fails(update(a.id, { rowVersion: 1, name: 'x' }), 'VERSION_CONFLICT');
    const cur = await update(a.id, { rowVersion: named.rowVersion + 1, serialNumber: 'S-B', purchaseCostKop: 300000 });
    expect(cur).toMatchObject({ serialNumber: 'S-B', purchaseCostKop: 300000 });
    const actions = (await auditOf(a.id)).map((x) => x.action);
    expect(actions).toContain('equipment.serial_changed');
    await fails(update(a.id, { rowVersion: cur.rowVersion, inventoryNumber: 'INV-1' }), 'VALIDATION_FAILED');
  });
});

describe('статусы (K19 §2)', () => {
  it('written_off – конечный, Директору нельзя; покидает единицу, история места цела (приёмка 19)', async () => {
    const a = await create({ unitId: w.units.PS4 });
    await fails(setStatus(a.id, { rowVersion: a.rowVersion, status: 'written_off', reason: 'сгорел' }, director), 'FORBIDDEN');
    await fails(setStatus(a.id, { rowVersion: a.rowVersion, status: 'written_off' }), 'COMMENT_REQUIRED');
    const off = await setStatus(a.id, { rowVersion: a.rowVersion, status: 'written_off', reason: 'сгорел' });
    expect(off.equipment).toMatchObject({ status: 'written_off', statusReason: 'сгорел', placement: { unitId: null, roomId: null } });
    expect(off.blockProposal).toBeNull();
    await fails(setStatus(a.id, { rowVersion: off.equipment.rowVersion, status: 'in_service' }), 'EQUIPMENT_WRITTEN_OFF');
    await fails(update(a.id, { rowVersion: off.equipment.rowVersion, name: 'x' }), 'EQUIPMENT_WRITTEN_OFF');
    const history = await w.db.client.query<{ unit_id: string | null; removed_at: Date | null }>(`SELECT unit_id, removed_at FROM app.equipment_placements WHERE item_id = $1 ORDER BY removed_at NULLS LAST`, [a.id]);
    expect(history.rows.map((r) => r.unit_id)).toEqual([w.units.PS4, null]);
    expect((await auditOf(a.id)).map((x) => x.action)).toContain('equipment.written_off');
  });

  it('lost → in_service – только Владелец и с причиной', async () => {
    const a = await create({}, director);
    const lost = await setStatus(a.id, { rowVersion: a.rowVersion, status: 'lost', reason: 'не нашли' }, director);
    const v = lost.equipment.rowVersion;
    await fails(setStatus(a.id, { rowVersion: v, status: 'in_service', reason: 'нашлось' }, director), 'FORBIDDEN');
    await fails(setStatus(a.id, { rowVersion: v, status: 'in_service' }), 'COMMENT_REQUIRED');
    expect((await setStatus(a.id, { rowVersion: v, status: 'in_service', reason: 'нашлось' })).equipment.status).toBe('in_service');
  });

  it('статус «В ремонте» предлагает блокировку с бронью, но блокировки нет и бронь цела (K19 §1)', async () => {
    const bookingId = await createBooking(w, w.resources.VR1, '2026-11-14T08:00:00Z');
    const a = await create({ unitId: w.units.VR1 }, director);
    const r = await setStatus(a.id, { rowVersion: a.rowVersion, status: 'repair' }, director);
    expect(r.equipment.status).toBe('repair');
    expect(r.blockProposal).toMatchObject({ target: { type: 'unit', ids: [w.units.VR1] }, reasonCode: 'repair', period: { start: '2026-11-14T05:00:00.000Z', end: '2026-11-15T05:00:00.000Z' } });
    expect(r.blockProposal!.affectedBookings.map((b) => b.id)).toEqual([bookingId]);
    expect((await w.db.client.query(`SELECT 1 FROM app.resource_blocks WHERE $1 = ANY(target_ids)`, [w.units.VR1])).rowCount).toBe(0);
    const unavailable = await create({});
    await fails(setStatus(unavailable.id, { rowVersion: 1, status: 'unavailable' }), 'COMMENT_REQUIRED');
    expect((await setStatus(unavailable.id, { rowVersion: 1, status: 'unavailable', reason: 'нет питания' })).blockProposal).toBeNull(); // без места блокировать нечего
    const reserve = await create({ unitId: w.units.VR2 });
    const moved = await setStatus(reserve.id, { rowVersion: 1, status: 'reserve' });
    expect(moved.equipment.placement.unitId).toBeNull();
    expect(moved.blockProposal).toBeNull();
  });

  it('предложение при смене статуса показывает открытые ремонты на этой единице; закрытые и чужие единицы – нет', async () => {
    const a = await create({ unitId: w.units.PS4 });
    const b = await create({ unitId: w.units.PS4 });
    const other = await create({ unitId: w.units.VR2 });
    const reg = (id: string) => inTx(w.pool, (t) => registerRepair(t, owner, { equipmentId: id, detectedAt: '2026-11-14T04:00:00Z', brokenAtUnknown: true, symptoms: 'сломалось', priority: 'low', impact: 'none' }, metaOf(owner), clock));
    const onUnit = (await reg(a.id)).repair;
    await reg(other.id);
    const r = await setStatus(b.id, { rowVersion: 1, status: 'unavailable', reason: 'нет питания' });
    expect(r.blockProposal!.otherOpenRepairs).toEqual([onUnit.id]);
  });

  it('чужой филиал – 404, неизвестный статус и лишние поля – отказ', async () => {
    const a = await create({});
    await fails(setStatus(a.id, { rowVersion: 1, status: 'repair' }, foreign), 'NOT_FOUND');
    await fails(setStatus(a.id, { rowVersion: 1, status: 'available' }), 'VALIDATION_FAILED');
    await fails(setStatus(randomUUID(), { rowVersion: 1, status: 'repair' }), 'NOT_FOUND');
  });
});

describe('категории (10 §3.2)', () => {
  it('Владелец создаёт и архивирует; дубль – отказ; архивная не выбирается; Директору нельзя, чтение можно', async () => {
    const c = await inTx(w.pool, (t) => createCategory(t, owner, { name: 'Кресла', sortOrder: 5 }, metaOf(owner), clock));
    await fails(inTx(w.pool, (t) => createCategory(t, owner, { name: 'Кресла' }, metaOf(owner), clock)), 'VALIDATION_FAILED');
    await fails(inTx(w.pool, (t) => createCategory(t, director, { name: 'Столы' }, metaOf(director), clock)), 'FORBIDDEN');
    const archived = await inTx(w.pool, (t) => updateCategory(t, owner, c.id, { status: 'archived' }, metaOf(owner), clock));
    expect(archived.status).toBe('archived');
    await fails(create({ categoryId: c.id }), 'VALIDATION_FAILED');
    expect((await listCategories(w.pool, director)).map((x) => x.name)).toContain('Кресла');
    expect((await auditOf(c.id)).map((x) => x.action)).toEqual(['equipment.category.created', 'equipment.category.archived']);
  });
});

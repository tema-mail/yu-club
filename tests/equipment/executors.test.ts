// S3-35: исполнители ремонта (K19 §6, 10 §8): правка справочника не меняет executor_snapshot прошлых ремонтов (10 §8.3);
// внутренний ремонт без ИНН сохраняется (10 §8.2); архив вместо удаления, архивный не назначается.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { createExecutor, listExecutors, updateExecutor } from '../../apps/api/src/modules/equipment/executors.ts';
import { createEquipment } from '../../apps/api/src/modules/equipment/items.ts';
import { getRepair, registerRepair, updateRepair } from '../../apps/api/src/modules/equipment/repairs.ts';
import { createEquipmentWorld, ctxOf, fails, inTx, metaOf, type EquipmentWorld } from '../helpers/equipment.ts';

const clock = fixedClock('2026-11-14T05:00:00Z');
let w: EquipmentWorld;
let owner: AccessContext;
let director: AccessContext;
let admin: AccessContext;

const create = (body: object, who = director) => inTx(w.pool, (t) => createExecutor(t, who, body, metaOf(who), clock));
const patch = (id: string, body: object, who = director) => inTx(w.pool, (t) => updateExecutor(t, who, id, body, metaOf(who), clock));
const newRepair = async () => {
  const eq = await inTx(w.pool, (t) => createEquipment(t, owner, { name: 'Шлем', categoryId: w.categoryId, branchId: w.branch }, metaOf(owner), clock));
  return (await inTx(w.pool, (t) => registerRepair(t, admin, { equipmentId: eq.id, detectedAt: '2026-11-14T04:00:00Z', brokenAtUnknown: true, symptoms: 'не включается', priority: 'low', impact: 'none' }, metaOf(admin), clock))).repair;
};

beforeAll(async () => {
  w = await createEquipmentWorld();
  owner = ctxOf(clock, 'owner');
  director = ctxOf(clock, 'director', [w.branch]);
  admin = ctxOf(clock, 'admin', [w.branch]);
});
afterAll(() => w.close());

describe('исполнители (10 §8)', () => {
  it('правка справочника не меняет снимок прошлых ремонтов; новое назначение берёт новые реквизиты', async () => {
    const ex = await create({ kind: 'service_center', name: 'Сервис-Центр', phone: '+73830000001', inn: '5400000000', address: 'Ленина, 1' });
    const r = await newRepair();
    const assigned = await inTx(w.pool, (t) => updateRepair(t, director, r.id, { rowVersion: r.rowVersion, executorId: ex.id }, metaOf(director), clock));
    expect(assigned.executor.id).toBe(ex.id);
    expect(assigned.executor.snapshot).toMatchObject({ name: 'Сервис-Центр', phone: '+73830000001', inn: '5400000000', kind: 'service_center' });
    const changed = await patch(ex.id, { rowVersion: ex.rowVersion, name: 'Новое имя', phone: '+73830000002' });
    expect(changed).toMatchObject({ name: 'Новое имя', phone: '+73830000002', inn: '5400000000' });
    const past = await getRepair(w.pool, admin, r.id);
    expect(past.executor.snapshot).toMatchObject({ name: 'Сервис-Центр', phone: '+73830000001' });
    const next = await newRepair();
    const fresh = await inTx(w.pool, (t) => updateRepair(t, director, next.id, { rowVersion: next.rowVersion, executorId: ex.id }, metaOf(director), clock));
    expect(fresh.executor.snapshot).toMatchObject({ name: 'Новое имя', phone: '+73830000002' });
    const cleared = await inTx(w.pool, (t) => updateRepair(t, director, fresh.id, { rowVersion: fresh.rowVersion, executorId: null }, metaOf(director), clock));
    expect(cleared.executor).toEqual({ id: null, snapshot: null });
  });

  it('внутренний ремонт без ИНН сохраняется: сотрудник-исполнитель без реквизитов', async () => {
    const staff = await w.db.client.query<{ id: string }>(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('Пётр', 'Техник', 'tech@yu.test', 'admin', 'x') RETURNING id`);
    const ex = await create({ kind: 'staff', name: 'Пётр Техник', staffId: staff.rows[0]!.id });
    expect(ex).toMatchObject({ inn: null, phone: null, status: 'active' });
    const r = await newRepair();
    const a = await inTx(w.pool, (t) => updateRepair(t, director, r.id, { rowVersion: r.rowVersion, executorId: ex.id }, metaOf(director), clock));
    expect(a.executor.snapshot).toMatchObject({ kind: 'staff', staffId: staff.rows[0]!.id, inn: null });
  });

  it('архив вместо удаления: архивный не назначается и не в списке по умолчанию; нет DELETE; аудит', async () => {
    const ex = await create({ kind: 'contractor', name: 'ИП Иванов' });
    const archived = await patch(ex.id, { rowVersion: 1, status: 'archived' });
    expect(archived.status).toBe('archived');
    const r = await newRepair();
    await fails(inTx(w.pool, (t) => updateRepair(t, director, r.id, { rowVersion: r.rowVersion, executorId: ex.id }, metaOf(director), clock)), 'VALIDATION_FAILED');
    expect((await listExecutors(w.pool, admin)).map((x) => x.id)).not.toContain(ex.id);
    expect((await listExecutors(w.pool, admin, { includeArchived: true })).map((x) => x.id)).toContain(ex.id);
    await expect(w.pool.query('DELETE FROM app.repair_executors WHERE id = $1', [ex.id])).rejects.toMatchObject({ code: '42501' });
    const audit = await w.db.client.query<{ action: string }>(`SELECT action FROM journal.audit_events WHERE object_id = $1 ORDER BY id`, [ex.id]);
    expect(audit.rows.map((a) => a.action)).toEqual(['repair.executor.created', 'repair.executor.archived']);
  });

  it('права и проверки: Администратору только чтение; плохой ИНН, неизвестный сотрудник, старая версия, лишнее поле – отказ', async () => {
    await fails(create({ kind: 'contractor', name: 'x' }, admin), 'FORBIDDEN');
    await fails(create({ kind: 'contractor', name: 'x', inn: '123' }), 'VALIDATION_FAILED');
    await fails(create({ kind: 'staff', name: 'x', staffId: '00000000-0000-4000-8000-000000000000' }), 'VALIDATION_FAILED');
    await fails(create({ kind: 'contractor', name: 'x', bank: 'y' }), 'VALIDATION_FAILED');
    const ex = await create({ kind: 'contractor', name: 'Ещё один' });
    await fails(patch(ex.id, { rowVersion: 9, name: 'y' }), 'VERSION_CONFLICT');
    await fails(patch(ex.id, { rowVersion: 1, name: 'y' }, admin), 'FORBIDDEN');
    await fails(patch('00000000-0000-4000-8000-000000000000', { rowVersion: 1, name: 'y' }), 'NOT_FOUND');
  });
});

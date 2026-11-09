// S3-33: K19 №331–337 по настоящему HTTP с настоящим входом сотрудников: IDOR на каждом маршруте с объектом чужого филиала,
// Администратор не получает accounts ни в карточке, ни по №336 (Q-54), перемещение между филиалами без зоны второго – 404,
// повтор с тем же ключом не плодит карточек, отказ в зоне пишется в аудит.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { hashPassword, staffAuthConfig } from '../../apps/api/src/modules/staff/auth.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { createBooking, createEquipmentWorld, type EquipmentWorld } from '../helpers/equipment.ts';

const PASSWORD = 'Пароль-оборудования-проверка-1';
const BASE = '/api/crm/v1';
const clock = fixedClock('2026-11-14T05:00:00Z');
let w: EquipmentWorld;
let app: FastifyInstance;
const cookies: Record<string, string> = {};

async function login(key: string, role: string, branchIds: string[] = []): Promise<string> {
  const r = await w.db.client.query<{ id: string }>(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', $1, $2, $3) RETURNING id`, [`${key}@yu.test`, role, await hashPassword(PASSWORD)]);
  for (const b of branchIds) await w.db.client.query(`INSERT INTO app.staff_assignments (staff_id, scope_type, branch_id, valid_from, created_by) VALUES ($1, 'branch', $2, '2026-01-01', $1)`, [r.rows[0]!.id, b]);
  const res = await app.inject({ method: 'POST', url: `${BASE}/auth/login`, payload: { email: `${key}@yu.test`, password: PASSWORD } });
  cookies[key] = String(res.headers['set-cookie']).split(';')[0]!;
  return r.rows[0]!.id;
}
function req(who: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object, key: string = randomUUID()) {
  const headers: Record<string, string> = { cookie: cookies[who]! };
  if (method !== 'GET') headers['idempotency-key'] = key;
  return app.inject({ method, url: `${BASE}${url}`, headers, ...(payload ? { payload } : {}) });
}
const newItem = async (body: object = {}, who = 'owner') => (await req(who, 'POST', '/equipment', { name: 'Шлем', categoryId: w.categoryId, branchId: w.branch, ...body })).json();

beforeAll(async () => {
  w = await createEquipmentWorld();
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), { staff: { pool: w.pool, auth: staffAuthConfig('q'.repeat(40)), clock } });
  await login('owner', 'owner');
  await login('director', 'director', [w.branch]);
  await login('admin', 'admin', [w.branch]);
  await login('foreign', 'director', [w.other]);
});
afterAll(async () => {
  await app.close();
  await w.close();
});

describe('№331–332: список и карточка', () => {
  it('создание 201, повтор с тем же ключом – та же карточка, номер не тратится на дубль', async () => {
    const key = randomUUID();
    const body = { name: 'Quest', categoryId: w.categoryId, branchId: w.branch, unitId: w.units.PS4, serialNumber: 'SER-1' };
    const a = await req('director', 'POST', '/equipment', body, key);
    expect(a.statusCode).toBe(201);
    const b = await req('director', 'POST', '/equipment', body, key);
    expect(b.statusCode).toBe(201);
    expect(b.headers['idempotent-replay']).toBe('true');
    expect(b.json().id).toBe(a.json().id);
    expect((await w.db.client.query(`SELECT 1 FROM app.equipment_items WHERE serial_number = 'SER-1'`)).rowCount).toBe(1);
    const got = await req('admin', 'GET', `/equipment/${a.json().id}`);
    expect(got.json()).toMatchObject({ name: 'Quest', placement: { unitId: w.units.PS4, roomId: w.room }, status: 'in_service' });
  });

  it('список: фильтры, зона в SQL, курсор по номеру', async () => {
    const away = await newItem({ branchId: w.other, name: 'Чужой' });
    const mine = await newItem({ name: 'Свой', unitId: w.units.VR2, serialNumber: 'SER-L' });
    const list = (await req('admin', 'GET', '/equipment?limit=100')).json();
    const ids = list.items.map((x: { id: string }) => x.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(away.id);
    expect((await req('owner', 'GET', `/equipment?branchId=${w.other}`)).json().items.map((x: { id: string }) => x.id)).toEqual([away.id]);
    expect((await req('foreign', 'GET', `/equipment?branchId=${w.branch}`)).json().items).toEqual([]);
    expect((await req('owner', 'GET', `/equipment?unitId=${w.units.VR2}`)).json().items.map((x: { id: string }) => x.id)).toEqual([mine.id]);
    expect((await req('owner', 'GET', '/equipment?serial=SER-L')).json().items).toHaveLength(1);
    expect((await req('owner', 'GET', `/equipment?cityId=${w.cityId}&status=in_service&categoryId=${w.categoryId}&roomId=${w.room}&limit=100`)).json().items.length).toBeGreaterThan(0);
    const page = (await req('owner', 'GET', '/equipment?limit=1')).json();
    expect(page.nextCursor).toMatch(/^INV-/);
    const next = (await req('owner', 'GET', `/equipment?limit=1&cursor=${page.nextCursor}`)).json();
    expect(next.items[0].inventoryNumber > page.items[0].inventoryNumber).toBe(true);
    expect((await req('owner', 'GET', '/equipment?cursor=мусор')).statusCode).toBe(400);
  });

  it('IDOR: объект чужого филиала – 404 на каждом маршруте №332–336', async () => {
    const it = await newItem();
    const account = (await req('owner', 'POST', '/equipment-accounts', { platform: 'meta', displayName: 'm-1', equipmentId: it.id, branchId: w.branch, boundFrom: '2026-11-01' })).json();
    const probes: Array<[string, 'GET' | 'POST' | 'PATCH', string, object?]> = [
      ['карточка', 'GET', `/equipment/${it.id}`],
      ['правка', 'PATCH', `/equipment/${it.id}`, { rowVersion: 1, name: 'x' }],
      ['статус', 'POST', `/equipment/${it.id}/status`, { rowVersion: 1, status: 'repair' }],
      ['перемещение', 'POST', `/equipment/${it.id}/move`, { rowVersion: 1, to: { branchId: w.other }, at: '2026-11-14T05:00:00Z', reason: 'x' }],
      ['история', 'GET', `/equipment/${it.id}/placements`],
      ['учётки', 'GET', `/equipment-accounts?equipmentId=${it.id}`],
      ['перепривязка', 'POST', `/equipment-accounts/${account.id}/rebind`, { equipmentId: null, at: '2026-11-10', reason: 'x' }],
    ];
    for (const [name, method, url, body] of probes) {
      const r = await req('foreign', method, url, body);
      expect(r.statusCode, name).toBe(404);
      expect(r.json().error.code, name).toBe('NOT_FOUND');
    }
    expect((await req('foreign', 'POST', '/equipment', { name: 'x', categoryId: w.categoryId, branchId: w.branch })).statusCode).toBe(404);
    const missing = await req('owner', 'GET', `/equipment/${randomUUID()}`);
    expect(missing.statusCode).toBe(404);
    expect((await req('owner', 'GET', '/equipment/not-a-uuid')).statusCode).toBe(404);
  });
});

describe('№336: учётки и Администратор (Q-54)', () => {
  it('Владельцу и Директору – accounts в карточке; Администратору – ни ключа, ни прямого запроса, ни записи', async () => {
    const it = await newItem();
    const bound = await req('director', 'POST', '/equipment-accounts', { platform: 'playstation', displayName: 'psn-x', equipmentId: it.id, branchId: w.branch, boundFrom: '2026-11-01' });
    expect(bound.statusCode).toBe(201);
    expect((await req('director', 'GET', `/equipment/${it.id}`)).json().accounts.map((a: { displayName: string }) => a.displayName)).toEqual(['psn-x']);
    const adminCard = await req('admin', 'GET', `/equipment/${it.id}`);
    expect(adminCard.statusCode).toBe(200);
    expect(adminCard.json()).not.toHaveProperty('accounts');
    expect(adminCard.body).not.toContain('psn-x');
    const direct = await req('admin', 'GET', `/equipment-accounts?equipmentId=${it.id}`);
    expect(direct.statusCode).toBe(403);
    expect(direct.body).not.toContain('psn-x');
    expect((await req('admin', 'GET', `/equipment-accounts?branchId=${w.branch}`)).statusCode).toBe(403);
    expect((await req('admin', 'POST', '/equipment-accounts', { platform: 'meta', displayName: 'z', equipmentId: it.id, branchId: w.branch, boundFrom: '2026-11-01' })).statusCode).toBe(403);
    const rebound = await req('director', 'POST', `/equipment-accounts/${bound.json().id}/rebind`, { equipmentId: null, at: '2026-11-10', reason: 'продали' });
    expect(rebound.json()).toMatchObject({ ended: { status: 'ended' }, current: null });
    expect((await req('director', 'POST', '/equipment-accounts', { platform: 'meta', displayName: 'z', equipmentId: it.id, branchId: w.branch, boundFrom: '2026-11-01', password: 'x' })).statusCode).toBe(400);
  });
});

describe('№333–335: статус и перемещение', () => {
  it('статус: предложение с бронью, блокировки нет; списание Директором – 403 с записью отказа', async () => {
    const bookingId = await createBooking(w, w.resources.VR1, '2026-11-14T09:00:00Z');
    const it = await newItem({ unitId: w.units.VR1 });
    const r = await req('director', 'POST', `/equipment/${it.id}/status`, { rowVersion: 1, status: 'diagnostics' });
    expect(r.statusCode).toBe(200);
    expect(r.json().blockProposal.affectedBookings.map((b: { id: string }) => b.id)).toEqual([bookingId]);
    expect(r.body).not.toContain('+7913');
    const off = await req('director', 'POST', `/equipment/${it.id}/status`, { rowVersion: 2, status: 'written_off', reason: 'x' });
    expect(off.statusCode).toBe(403);
    const denied = await w.db.client.query(`SELECT action, result FROM journal.audit_events WHERE object_id = $1 AND result = 'denied'`, [it.id]);
    expect(denied.rows[0]).toMatchObject({ action: 'equipment.written_off', result: 'denied' });
  });

  it('перемещение: 409 со списком, с подтверждением 200; между филиалами без зоны второго – 404; Администратор – 403; история', async () => {
    const it = await newItem({ unitId: w.units.VR1 });
    const body = { rowVersion: 1, to: { branchId: w.branch }, at: '2026-11-14T05:00:00Z', reason: 'перестановка' };
    const conflict = await req('director', 'POST', `/equipment/${it.id}/move`, body);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('EQUIPMENT_MOVE_HAS_BOOKINGS');
    expect(conflict.json().error.details.bookingIds).toHaveLength(1);
    expect((await req('admin', 'POST', `/equipment/${it.id}/move`, body)).statusCode).toBe(403);
    const toOther = { ...body, to: { branchId: w.other }, acknowledgeBookings: true };
    expect((await req('director', 'POST', `/equipment/${it.id}/move`, toOther)).statusCode).toBe(404);
    const ok = await req('director', 'POST', `/equipment/${it.id}/move`, { ...body, acknowledgeBookings: true });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().affectedBookingIds).toHaveLength(1);
    const history = await req('admin', 'GET', `/equipment/${it.id}/placements`);
    expect(history.json().items).toHaveLength(2);
  });
});

describe('№337: категории', () => {
  it('Администратору – чтение; правка только Владельцу с архивом вместо удаления', async () => {
    expect((await req('admin', 'GET', '/equipment-categories')).json().items.length).toBeGreaterThanOrEqual(10);
    expect((await req('director', 'POST', '/equipment-categories', { name: 'Столы' })).statusCode).toBe(403);
    const c = await req('owner', 'POST', '/equipment-categories', { name: 'Столы' });
    expect(c.statusCode).toBe(201);
    const patched = await req('owner', 'PATCH', `/equipment-categories/${c.json().id}`, { status: 'archived' });
    expect(patched.json().status).toBe('archived');
    expect((await req('owner', 'PATCH', `/equipment-categories/${randomUUID()}`, { name: 'x' })).statusCode).toBe(404);
    const denied = await w.db.client.query(`SELECT 1 FROM journal.audit_events WHERE action = 'equipment.category.created' AND result = 'denied'`);
    expect(denied.rowCount).toBe(1);
  });
});

describe('карточка и фильтры по ремонтам и гарантиям (10 §13.1–13.2)', () => {
  it('открытые ремонты, последний ремонт, «гарантия до» – максимальная действующая; фильтры hasOpenRepair и warrantyExpiresBefore', async () => {
    const eq = await newItem({ name: 'С ремонтом' });
    const clean = await newItem({ name: 'Без ремонта' });
    expect(eq).toMatchObject({ openRepairsCount: 0, warrantyUntil: null, lastRepairAt: null });
    const reg = await req('admin', 'POST', '/repairs', { equipmentId: eq.id, detectedAt: '2026-11-14T04:00:00Z', brokenAtUnknown: true, symptoms: 'не включается', priority: 'low', impact: 'none' });
    expect(reg.statusCode).toBe(201);
    const warranties = [
      { kind: 'manufacturer', startsOn: '2026-01-01', endsOn: '2030-06-01' },
      { kind: 'manufacturer', startsOn: '2026-01-01', endsOn: '2031-06-01' },
    ];
    const ids: string[] = [];
    for (const g of warranties) ids.push((await req('director', 'POST', `/equipment/${eq.id}/warranties`, g)).json().id);
    const card = (await req('admin', 'GET', `/equipment/${eq.id}`)).json();
    expect(card).toMatchObject({ openRepairsCount: 1, warrantyUntil: '2031-06-01', lastRepairAt: '2026-11-14T04:00:00.000Z' });
    await req('director', 'POST', `/warranties/${ids[1]}/invalidate`, { reason: 'ошибка' });
    expect((await req('admin', 'GET', `/equipment/${eq.id}`)).json().warrantyUntil).toBe('2030-06-01');

    const idsOf = async (query: string) => (await req('owner', 'GET', `/equipment?limit=100&${query}`)).json().items.map((x: { id: string }) => x.id);
    expect(await idsOf('hasOpenRepair=true')).toContain(eq.id);
    expect(await idsOf('hasOpenRepair=true')).not.toContain(clean.id);
    expect(await idsOf('hasOpenRepair=false')).toContain(clean.id);
    expect(await idsOf('warrantyExpiresBefore=2030-07-01')).toEqual([eq.id]);
    expect(await idsOf('warrantyExpiresBefore=2030-05-01')).toEqual([]);

    const repair = reg.json().repair;
    const closed = await req('director', 'POST', `/repairs/${repair.id}/status`, { rowVersion: repair.rowVersion, to: 'cancelled', comment: 'ошибочно' });
    expect(closed.statusCode).toBe(200);
    expect((await req('admin', 'GET', `/equipment/${eq.id}`)).json()).toMatchObject({ openRepairsCount: 0, lastRepairAt: null });
  });
});

describe('хронология оборудования /audit/timeline (K2, зона K1)', () => {
  it('Директор и Администратор своей зоны видят; чужая зона и несуществующий – одинаковый 404', async () => {
    const eq = await newItem({ name: 'Хронология' }, 'director');
    const away = await newItem({ branchId: w.other, name: 'Чужая хронология' });
    const tl = (who: string, id: string) => req(who, 'GET', `/audit/timeline?objectType=equipment&objectId=${id}`);
    const actions = (r: { json: () => { items: { action: string }[] } }) => r.json().items.map((e) => e.action);
    expect(actions(await tl('owner', eq.id))).toContain('equipment.created');
    const dir = await tl('director', eq.id);
    expect(dir.statusCode).toBe(200);
    expect(actions(dir)).toContain('equipment.created');
    const adm = await tl('admin', eq.id);
    expect(adm.statusCode).toBe(200);
    expect(actions(adm)).toEqual([]); // Администратор – только свои события (audit.view.own), карточку создал Директор
    const foreign = await tl('admin', away.id);
    const missing = await tl('admin', randomUUID());
    expect(foreign.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(foreign.json().error.code).toBe(missing.json().error.code);
    expect((await tl('foreign', eq.id)).statusCode).toBe(404);
    expect((await tl('director', 'не-uuid')).statusCode).toBe(404);
  });
});

// S3-39: K19 №341–349 и вложения №350 по настоящему HTTP с настоящим входом: IDOR на каждом маршруте; Администратор регистрирует,
// прикладывает фото, подтверждает блокировку и принимает ремонт ≤ порога, но не меняет план и сумму (10 §14); timeline – из аудита;
// сквозной TC-12 по API; двойной клик расхода – одна операция, та же операция ко второму ремонту – OPERATION_ALREADY_LINKED.
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import { createFileStore } from '../../apps/api/src/core/files.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { hashPassword, staffAuthConfig } from '../../apps/api/src/modules/staff/auth.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { createBooking, createEquipmentWorld, type EquipmentWorld } from '../helpers/equipment.ts';

const PASSWORD = 'Пароль-ремонта-проверка-1';
const BASE = '/api/crm/v1';
const DETECTED = '2026-11-14T04:00:00Z';
const clock = fixedClock('2026-11-14T05:00:00Z');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
let w: EquipmentWorld;
let app: FastifyInstance;
let root = '';
const cookies: Record<string, string> = {};

async function login(key: string, role: string, branchIds: string[] = []): Promise<void> {
  const r = await w.db.client.query<{ id: string }>(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', $1, $2, $3) RETURNING id`, [`${key}@yu.test`, role, await hashPassword(PASSWORD)]);
  for (const b of branchIds) await w.db.client.query(`INSERT INTO app.staff_assignments (staff_id, scope_type, branch_id, valid_from, created_by) VALUES ($1, 'branch', $2, '2026-01-01', $1)`, [r.rows[0]!.id, b]);
  const res = await app.inject({ method: 'POST', url: `${BASE}/auth/login`, payload: { email: `${key}@yu.test`, password: PASSWORD } });
  cookies[key] = String(res.headers['set-cookie']).split(';')[0]!;
}
function req(who: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object, key: string = randomUUID()) {
  const headers: Record<string, string> = { cookie: cookies[who]! };
  if (method !== 'GET') headers['idempotency-key'] = key;
  return app.inject({ method, url: `${BASE}${url}`, headers, ...(payload ? { payload } : {}) });
}
const item = async (body: object = {}) => (await req('owner', 'POST', '/equipment', { name: 'Шлем', categoryId: w.categoryId, branchId: w.branch, ...body })).json();
const register = (equipmentId: string, who = 'admin', body: object = {}) => req(who, 'POST', '/repairs', { equipmentId, detectedAt: DETECTED, brokenAtUnknown: true, symptoms: 'не включается', priority: 'high', impact: 'full', ...body });
const newRepair = async (body: object = {}) => (await register((await item(body)).id)).json().repair;
const step = async (r: { id: string; rowVersion: number }, to: string) => (await req('director', 'POST', `/repairs/${r.id}/status`, { rowVersion: r.rowVersion, to, comment: 'ход работ' })).json();
const toCheck = async (r: { id: string; rowVersion: number }) => step(await step(r, 'in_repair'), 'done_pending_check');

beforeAll(async () => {
  w = await createEquipmentWorld();
  root = await mkdtemp(path.join(tmpdir(), 'yu-repair-'));
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), { staff: { pool: w.pool, auth: staffAuthConfig('r'.repeat(40)), clock }, attachments: { store: createFileStore({ root }) } });
  await login('owner', 'owner');
  await login('director', 'director', [w.branch]);
  await login('admin', 'admin', [w.branch]);
  await login('foreign', 'director', [w.other]);
  await w.db.client.query(`INSERT INTO app.settings_values (key, level, branch_id, value, valid_from, created_by) VALUES ('finance.negative_balance_allowed', 'branch', $1, 'true', '2026-01-01', $2)`, [w.branch, randomUUID()]);
});
afterAll(async () => {
  await app.close();
  await w.close();
  await rm(root, { recursive: true, force: true });
});

describe('TC-12 по API (K19 §17)', () => {
  it('поломка → предложение с бронью → подтверждение: бронь confirmed, новые занятия закрыты; timeline из аудита', async () => {
    const bookingId = await createBooking(w, w.resources.VR1, '2026-11-14T10:00:00Z');
    const eq = await item({ unitId: w.units.VR1 });
    const reg = await register(eq.id);
    expect(reg.statusCode).toBe(201);
    const { repair, blockProposal, autoBlock } = reg.json();
    expect(autoBlock).toBeNull();
    expect(blockProposal.affectedBookings.map((b: { id: string }) => b.id)).toEqual([bookingId]);

    const preview = await req('admin', 'GET', `/repairs/${repair.id}/block-proposal`);
    expect(preview.statusCode).toBe(200);
    expect(preview.json().target).toEqual({ type: 'unit', ids: [w.units.VR1] });
    const custom = await req('admin', 'GET', `/repairs/${repair.id}/block-proposal?targetType=room&targetId=${w.room}&start=2026-11-14T06:00:00Z&end=2026-11-14T07:00:00Z`);
    expect(custom.json()).toMatchObject({ target: { type: 'room' }, affectedBookings: [] });

    const blocked = await req('admin', 'POST', `/repairs/${repair.id}/blocks`, { target: blockProposal.target, period: blockProposal.period, comment: 'шлем' });
    expect(blocked.statusCode).toBe(201);
    expect(blocked.json().affectedBookings.map((b: { id: string; status: string }) => [b.id, b.status])).toEqual([[bookingId, 'confirmed']]);
    expect((await w.db.client.query<{ status: string }>(`SELECT status FROM app.bookings WHERE id = $1`, [bookingId])).rows[0]!.status).toBe('confirmed');

    const card = await req('admin', 'GET', `/repairs/${repair.id}`);
    expect(card.statusCode).toBe(200);
    const body = card.json();
    expect(body.blocks[0]).toMatchObject({ blockId: blocked.json().blockId, active: true });
    expect(body.downtime.hasBlocks).toBe(true);
    expect(body.timeline.map((t: { action: string }) => t.action)).toEqual(expect.arrayContaining(['repair.registered', 'repair.block_linked']));
  });

  it('ремонт без места: предложение пустое, не ошибка', async () => {
    const r = await newRepair();
    const res = await req('admin', 'GET', `/repairs/${r.id}/block-proposal`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ target: null, affectedBookings: [] });
  });
});

describe('Администратор (10 §14)', () => {
  it('регистрирует, прикладывает фото, подтверждает блокировку, принимает ≤ порога; план, сумму и статусы не меняет', async () => {
    const r = await newRepair({ unitId: w.units.PS4 });
    const photo = await app.inject({
      method: 'POST',
      url: `${BASE}/attachments?ownerType=repair&ownerId=${r.id}&docType=photo&name=${encodeURIComponent('шлем.jpg')}`,
      headers: { cookie: cookies.admin!, 'idempotency-key': randomUUID(), 'content-type': 'image/jpeg' },
      payload: JPEG,
    });
    expect(photo.statusCode).toBe(201);
    const list = await req('admin', 'GET', `/attachments?ownerType=repair&ownerId=${r.id}`);
    expect(list.json().items.map((a: { id: string }) => a.id)).toEqual([photo.json().attachmentId]);
    expect((await req('admin', 'GET', `/attachments/${photo.json().attachmentId}`)).statusCode).toBe(200);
    const eqDoc = await app.inject({
      method: 'POST',
      url: `${BASE}/attachments?ownerType=equipment&ownerId=${r.equipmentId}&docType=warranty_card`,
      headers: { cookie: cookies.admin!, 'idempotency-key': randomUUID(), 'content-type': 'image/jpeg' },
      payload: JPEG,
    });
    expect(eqDoc.statusCode).toBe(201);
    const foreignUpload = await app.inject({
      method: 'POST',
      url: `${BASE}/attachments?ownerType=repair&ownerId=${r.id}&docType=photo`,
      headers: { cookie: cookies.foreign!, 'idempotency-key': randomUUID(), 'content-type': 'image/jpeg' },
      payload: JPEG,
    });
    expect(foreignUpload.statusCode).toBe(404);
    expect((await req('foreign', 'GET', `/attachments/${photo.json().attachmentId}`)).statusCode).toBe(404);
    expect((await req('foreign', 'GET', `/attachments?ownerType=repair&ownerId=${r.id}`)).statusCode).toBe(404);

    expect((await req('admin', 'POST', `/repairs/${r.id}/blocks`, { target: { type: 'unit', ids: [w.units.PS4] }, period: { start: '2026-12-01T00:00:00Z', end: '2026-12-01T01:00:00Z' } })).statusCode).toBe(201);
    expect((await req('admin', 'PATCH', `/repairs/${r.id}`, { rowVersion: r.rowVersion, plan: { costKop: 100 } })).statusCode).toBe(403);
    expect((await req('admin', 'POST', `/repairs/${r.id}/status`, { rowVersion: r.rowVersion, to: 'diagnostics', comment: 'x' })).statusCode).toBe(403);
    expect((await req('admin', 'POST', `/repairs/${r.id}/expense`, { branchId: w.branch, method: 'cash', amountKop: 100, occurredAt: DETECTED })).statusCode).toBe(403);
    const denied = await w.db.client.query(`SELECT action FROM journal.audit_events WHERE object_id = $1 AND result = 'denied' ORDER BY id`, [r.id]);
    expect(denied.rows.map((x) => x.action)).toEqual(['repair.updated', 'repair.status_changed', 'repair.expense_linked']);

    const check = await toCheck(r);
    const closeBody = { rowVersion: check.rowVersion, worksDone: 'заменили', completedAt: '2026-11-14T04:30:00Z', finalEquipmentStatus: 'in_service', executorId: await executor() };
    expect((await req('admin', 'POST', `/repairs/${r.id}/close`, { ...closeBody, actualCostKop: 1_500_000 })).statusCode).toBe(403);
    const accepted = await req('admin', 'POST', `/repairs/${r.id}/close`, { ...closeBody, actualCostKop: 500_000 });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().repair.status).toBe('closed');
    expect(accepted.json().stillBlocked).toHaveLength(1);
  });
});

async function executor(): Promise<string> {
  return (await req('director', 'POST', '/repair-executors', { kind: 'service_center', name: `Сервис ${randomUUID()}` })).json().id;
}

describe('IDOR (K19 §17)', () => {
  it('ремонт чужого филиала – 404 на каждом маршруте №342–348; список зоны – без чужих', async () => {
    const eq = await item();
    const r = (await register(eq.id)).json().repair;
    const warranty = (await req('director', 'POST', `/equipment/${eq.id}/warranties`, { kind: 'manufacturer', startsOn: '2026-01-01', endsOn: '2028-01-01' })).json();
    const probes: Array<[string, 'GET' | 'POST' | 'PATCH', string, object?]> = [
      ['регистрация', 'POST', '/repairs', { equipmentId: eq.id, detectedAt: DETECTED, brokenAtUnknown: true, symptoms: 'x', priority: 'low', impact: 'none' }],
      ['карточка', 'GET', `/repairs/${r.id}`],
      ['правка', 'PATCH', `/repairs/${r.id}`, { rowVersion: 1, cause: 'x' }],
      ['статус', 'POST', `/repairs/${r.id}/status`, { rowVersion: 1, to: 'diagnostics', comment: 'x' }],
      ['согласование', 'POST', `/repairs/${r.id}/approve`, { rowVersion: 1, decision: 'approve', comment: 'x' }],
      ['предложение', 'GET', `/repairs/${r.id}/block-proposal`],
      ['блокировка', 'POST', `/repairs/${r.id}/blocks`, { target: { type: 'unit', ids: [w.units.VR1] }, period: { start: '2026-12-01T00:00:00Z', end: '2026-12-01T01:00:00Z' } }],
      ['закрытие', 'POST', `/repairs/${r.id}/close`, { rowVersion: 1 }],
      ['расход', 'POST', `/repairs/${r.id}/expense`, { branchId: w.other, method: 'cash', amountKop: 100, occurredAt: DETECTED }],
      ['привязка', 'POST', `/repairs/${r.id}/expense/link`, { operationId: randomUUID() }],
      ['гарантии', 'GET', `/equipment/${eq.id}/warranties`],
      ['новая гарантия', 'POST', `/equipment/${eq.id}/warranties`, { kind: 'manufacturer', startsOn: '2026-01-01', endsOn: '2028-01-01' }],
      ['недействительна', 'POST', `/warranties/${warranty.id}/invalidate`, { reason: 'x' }],
    ];
    for (const [name, method, url, body] of probes) {
      const res = await req('foreign', method, url, body);
      expect(res.statusCode, name).toBe(404);
      expect(res.json().error.code, name).toBe('NOT_FOUND');
    }
    expect((await req('foreign', 'GET', `/repairs?equipmentId=${eq.id}`)).json().items).toEqual([]);
    expect((await req('admin', 'GET', `/repairs?equipmentId=${eq.id}`)).json().items.map((x: { id: string }) => x.id)).toEqual([r.id]);
    expect((await req('owner', 'GET', `/repairs/${randomUUID()}`)).statusCode).toBe(404);
  });
});

describe('согласование, закрытие, расход и справочники по HTTP', () => {
  it('план выше порога: 409; Директор не согласует 403; Владелец согласует; идемпотентный повтор', async () => {
    const r = await newRepair();
    const planned = (await req('director', 'PATCH', `/repairs/${r.id}`, { rowVersion: 1, plan: { works: 'замена', costKop: 1_500_000, end: '2026-11-20' } })).json();
    const refused = await req('director', 'POST', `/repairs/${r.id}/status`, { rowVersion: planned.rowVersion, to: 'planned', comment: 'в план' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('REPAIR_APPROVAL_REQUIRED');
    const waiting = await step(await step(planned, 'diagnostics'), 'awaiting_approval');
    expect((await req('director', 'POST', `/repairs/${r.id}/approve`, { rowVersion: waiting.rowVersion, decision: 'approve', comment: 'да' })).statusCode).toBe(403);
    const key = randomUUID();
    const ok = await req('owner', 'POST', `/repairs/${r.id}/approve`, { rowVersion: waiting.rowVersion, decision: 'approve', comment: 'да' }, key);
    expect(ok.json()).toMatchObject({ status: 'planned' });
    const replay = await req('owner', 'POST', `/repairs/${r.id}/approve`, { rowVersion: waiting.rowVersion, decision: 'approve', comment: 'да' }, key);
    expect(replay.headers['idempotent-replay']).toBe('true');
    const overdue = await req('director', 'GET', '/repairs?planOverdue=true');
    expect(overdue.statusCode).toBe(200);
    const proposalPeriod = (await req('admin', 'GET', `/repairs/${r.id}/block-proposal`)).json();
    expect(proposalPeriod.target).toBeNull(); // без места цели нет
  });

  it('закрытие без суммы – 422 со списком; REPAIR_DATES_INVALID при регистрации – 422', async () => {
    const r = await toCheck(await newRepair());
    const incomplete = await req('director', 'POST', `/repairs/${r.id}/close`, { rowVersion: r.rowVersion, worksDone: 'x', completedAt: DETECTED, finalEquipmentStatus: 'in_service' });
    expect(incomplete.statusCode).toBe(422);
    expect(incomplete.json().error.code).toBe('REPAIR_CLOSE_INCOMPLETE');
    expect(incomplete.json().error.details.fields).toEqual(expect.arrayContaining(['actualCostKop', 'noCost', 'executorId']));
    const dates = await register((await item()).id, 'admin', { brokenAtUnknown: false });
    expect(dates.statusCode).toBe(422);
    expect(dates.json().error.code).toBe('REPAIR_DATES_INVALID');
  });

  it('расход: двойной клик тем же ключом – одна операция; ручной привязывается; ко второму ремонту – 409; сторно исключает операцию из оплаты в карточке', async () => {
    const r = await newRepair();
    const body = { branchId: w.branch, method: 'cash', amountKop: 250000, occurredAt: '2026-11-14T04:30:00Z', comment: 'плата' };
    const key = randomUUID();
    const first = await req('director', 'POST', `/repairs/${r.id}/expense`, body, key);
    expect(first.statusCode).toBe(201);
    const second = await req('director', 'POST', `/repairs/${r.id}/expense`, body, key);
    expect(second.json().id).toBe(first.json().id);
    expect((await w.db.client.query<{ n: number }>(`SELECT count(*)::int n FROM journal.finance_operations WHERE ref_type = 'repair' AND ref_id = $1`, [r.id])).rows[0]!.n).toBe(1);

    const category = (await w.db.client.query<{ id: string }>(`SELECT id FROM app.finance_categories WHERE name = 'Прочее' AND kind = 'expense' AND parent_id IS NULL`)).rows[0]!.id;
    const manual = await req('director', 'POST', `/branches/${w.branch}/finance/expense`, { method: 'cash', amountKop: 1000, categoryId: category, occurredAt: '2026-11-14T04:30:00Z', comment: 'ручной' });
    const manualId: string = manual.statusCode === 201 ? manual.json().id : '';
    expect(manualId).not.toBe('');
    const linked = await req('director', 'POST', `/repairs/${r.id}/expense/link`, { operationId: manualId });
    expect(linked.statusCode).toBe(200);
    expect(linked.json().payment.paidKop).toBe(251000);
    const other = await newRepair();
    const again = await req('director', 'POST', `/repairs/${other.id}/expense/link`, { operationId: manualId });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('OPERATION_ALREADY_LINKED');
    const reversed = await req('owner', 'POST', `/finance/operations/${manualId}/reverse`, { reason: 'ошибка' });
    expect(reversed.statusCode).toBeLessThan(300);
    expect((await req('director', 'GET', `/repairs/${r.id}`)).json().payment.paidKop).toBe(250000);
  });

  it('гарантии и исполнители: Администратору чтение, архив вместо удаления', async () => {
    const eq = await item();
    expect((await req('admin', 'POST', `/equipment/${eq.id}/warranties`, { kind: 'manufacturer', startsOn: '2026-01-01', endsOn: '2028-01-01' })).statusCode).toBe(403);
    const g = await req('director', 'POST', `/equipment/${eq.id}/warranties`, { kind: 'manufacturer', startsOn: '2026-01-01', endsOn: '2028-01-01', issuer: 'Meta' });
    expect(g.statusCode).toBe(201);
    expect((await req('admin', 'GET', `/equipment/${eq.id}/warranties`)).json().items).toHaveLength(1);
    expect((await req('director', 'POST', `/warranties/${g.json().id}/invalidate`, { reason: 'ошибка' })).json().status).toBe('invalid');
    const ex = await req('director', 'POST', '/repair-executors', { kind: 'contractor', name: 'ИП Петров' });
    expect(ex.statusCode).toBe(201);
    expect((await req('admin', 'POST', '/repair-executors', { kind: 'contractor', name: 'x' })).statusCode).toBe(403);
    expect((await req('admin', 'GET', '/repair-executors')).json().items.map((x: { id: string }) => x.id)).toContain(ex.json().id);
    expect((await req('director', 'PATCH', `/repair-executors/${ex.json().id}`, { rowVersion: 1, status: 'archived' })).json().status).toBe('archived');
    expect((await req('admin', 'GET', '/repair-executors')).json().items.map((x: { id: string }) => x.id)).not.toContain(ex.json().id);
    expect((await req('admin', 'GET', '/repair-executors?includeArchived=true')).json().items.map((x: { id: string }) => x.id)).toContain(ex.json().id);
  });
});

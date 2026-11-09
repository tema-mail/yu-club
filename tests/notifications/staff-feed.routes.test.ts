// S4-28: HTTP ленты событий CRM через настоящий сервер и вход сотрудников – своё и своей зоны, чужое – 404, значок непрочитанных,
// прочтение (204, повтор – 204), «прочитать все», без входа – 401, ответы не кэшируются. События – через настоящий outbox.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import { clearSubscriptions, processEvent, publish } from '../../apps/api/src/core/outbox.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { FEED_HANDLERS, registerStaffFeedHandlers } from '../../apps/api/src/modules/notifications/staff-feed.ts';
import { hashPassword, staffAuthConfig } from '../../apps/api/src/modules/staff/auth.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { createTestBranch } from '../helpers/network.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const BASE = '/api/crm/v1';
const PASSWORD = 'Пароль-для-теста-1';
const clock = fixedClock('2026-11-20T06:00:00Z');
let db: TestDatabase;
let pool: pg.Pool;
let app: FastifyInstance;
let b1: string;
let b2: string;
const cookies: Record<string, string> = {};
const ids: Record<string, string> = {};

const req = (who: string, method: 'GET' | 'POST', url: string, payload?: object) =>
  app.inject({ method, url: `${BASE}${url}`, headers: { cookie: cookies[who]! }, ...(payload ? { payload } : {}) });

async function staff(key: string, role: string, branch?: string): Promise<void> {
  const r = await db.client.query<{ id: string }>(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', $1, $2, $3) RETURNING id`, [`${key}@yu.test`, role, await hashPassword(PASSWORD)]);
  ids[key] = r.rows[0]!.id;
  if (branch) {
    await db.client.query(`INSERT INTO app.staff_assignments (staff_id, scope_type, branch_id, valid_from, created_by) VALUES ($1, 'branch', $2, '2026-01-01', $1)`, [r.rows[0]!.id, branch]);
  }
  const res = await app.inject({ method: 'POST', url: `${BASE}/auth/login`, payload: { email: `${key}@yu.test`, password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  cookies[key] = String(res.headers['set-cookie']).split(';')[0]!;
}

async function repair(branchId: string, number: string): Promise<string> {
  const repairId = randomUUID();
  const { eventId } = await publish(db.client, {
    type: 'repair.registered', aggregateType: 'repair', aggregateId: repairId, aggregateVersion: 1, branchId, occurredAt: clock.now(),
    payload: { repairId, number, equipmentId: randomUUID(), branchId, priority: 'high', impact: 'partial', autoBlockId: null },
  });
  await processEvent(pool, FEED_HANDLERS.repairRegistered, eventId, clock.now());
  return repairId;
}
async function shift(staffId: string, branchId: string): Promise<string> {
  const shiftId = randomUUID();
  const { eventId } = await publish(db.client, {
    type: 'shift.changed', aggregateType: 'shift', aggregateId: shiftId, aggregateVersion: 2, branchId, occurredAt: clock.now(),
    payload: { shiftId, staffId, branchId, branchTimezone: 'Asia/Novosibirsk', changedBy: ids.director!, kind: 'created', before: null, after: { start: '2026-11-21T03:00:00Z', end: '2026-11-21T11:00:00Z', branchId }, reason: null },
  });
  await processEvent(pool, FEED_HANDLERS.shiftChanged, eventId, clock.now());
  return shiftId;
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 6 });
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), { staff: { pool, auth: staffAuthConfig('t'.repeat(40)), clock }, notifications: { vapidPublicKey: null, unsubscribeSecret: null } });
  b1 = (await createTestBranch(db.client)).id;
  b2 = (await createTestBranch(db.client)).id;
  await staff('owner', 'owner');
  await staff('director', 'director', b1);
  await staff('director2', 'director', b2);
  await staff('admin', 'admin', b1);
  await staff('admin2', 'admin', b1);
  clearSubscriptions();
  registerStaffFeedHandlers({ clock });
});
afterAll(async () => {
  clearSubscriptions();
  await app.close();
  await pool.end();
  await db.drop();
});

describe('GET /staff-feed', () => {
  it('без входа – 401', async () => {
    expect((await app.inject({ method: 'GET', url: `${BASE}/staff-feed` })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: `${BASE}/staff-feed/unread-count` })).statusCode).toBe(401);
  });

  it('ремонт – зоне филиала, смена – только её сотруднику; чужой филиал не видит; ответы no-store', async () => {
    const repairId = await repair(b1, 'Р-5');
    const shiftId = await shift(ids.admin!, b1);
    const r = await req('admin', 'GET', '/staff-feed');
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    const body = r.json() as { items: Array<{ refType: string; refId: string; title: string; branchName: string; read: boolean }>; unread: number; nextCursor: string | null };
    expect(body.items.map((i) => i.refId)).toEqual(expect.arrayContaining([repairId, shiftId]));
    expect(body.items.find((i) => i.refId === repairId)).toMatchObject({ refType: 'repair', title: 'Новый ремонт № Р-5', read: false });
    expect(body.items[0]!.branchName).not.toBe('');
    expect(body.unread).toBe(2);
    const colleague = (await req('admin2', 'GET', '/staff-feed')).json() as { items: Array<{ refId: string }> };
    expect(colleague.items.map((i) => i.refId)).toEqual([repairId]);
    expect(((await req('director2', 'GET', '/staff-feed')).json() as { items: unknown[] }).items).toHaveLength(0);
    expect(((await req('owner', 'GET', '/staff-feed')).json() as { items: Array<{ refId: string }> }).items.map((i) => i.refId)).toEqual([repairId]);
    expect((await req('admin', 'GET', '/staff-feed/unread-count')).json()).toEqual({ unread: 2 });
  });

  it('неверные параметры – 400', async () => {
    expect((await req('admin', 'GET', '/staff-feed?limit=51')).statusCode).toBe(400);
    expect((await req('admin', 'GET', '/staff-feed?cursor=xx')).json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
  });
});

describe('прочтение', () => {
  it('своё – 204, повтор – 204; чужой зоны и не UUID – 404; «прочитать все» – только своё', async () => {
    const repairId = await repair(b1, 'Р-6');
    const list = (await req('director', 'GET', '/staff-feed?unread=true')).json() as { items: Array<{ id: string; refId: string }>; unread: number };
    const item = list.items.find((i) => i.refId === repairId)!;
    expect((await req('director', 'POST', `/staff-feed/${item.id}/read`)).statusCode).toBe(204);
    expect((await req('director', 'POST', `/staff-feed/${item.id}/read`)).statusCode).toBe(204);
    expect((await req('director', 'GET', '/staff-feed/unread-count')).json()).toEqual({ unread: list.unread - 1 });
    expect((await req('director2', 'POST', `/staff-feed/${item.id}/read`)).statusCode).toBe(404);
    expect((await req('director', 'POST', '/staff-feed/abc/read')).statusCode).toBe(404);

    const adminBefore = ((await req('admin', 'GET', '/staff-feed/unread-count')).json() as { unread: number }).unread;
    const all = await req('director', 'POST', '/staff-feed/read-all', { before: clock.now().toISOString() });
    expect(all.json()).toEqual({ marked: list.unread - 1 });
    expect((await req('director', 'GET', '/staff-feed/unread-count')).json()).toEqual({ unread: 0 });
    expect((await req('admin', 'GET', '/staff-feed/unread-count')).json()).toEqual({ unread: adminBefore });
    expect((await req('director', 'POST', '/staff-feed/read-all', {})).statusCode).toBe(400);
  });
});

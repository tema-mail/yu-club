// GET /branches/{id}/blocks – список блокировок для CRM; хронология комнат/ресурсов/тарифов по зоне.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import { writeAudit, type AuditObjectType } from '../../apps/api/src/core/audit.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { hashPassword, staffAuthConfig } from '../../apps/api/src/modules/staff/auth.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { createTestBranch } from '../helpers/network.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const PASSWORD = 'Пароль-списка-блокировок-1';
const BASE = '/api/crm/v1';
const clock = fixedClock('2026-11-14T05:00:00Z');
let db: TestDatabase;
let pool: pg.Pool;
let app: FastifyInstance;
const cookies: Record<string, string> = {};
const ids: Record<string, string> = {};

async function one(sql: string, values: unknown[] = []): Promise<string> {
  return (await db.client.query<{ id: string }>(sql, values)).rows[0]!.id;
}
async function login(key: string, role: string, branchId?: string): Promise<void> {
  const id = await one(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', $1, $2, $3) RETURNING id`, [
    `${key.toLowerCase()}@yu.test`,
    role,
    await hashPassword(PASSWORD),
  ]);
  if (branchId) {
    await db.client.query(`INSERT INTO app.staff_assignments (staff_id, scope_type, branch_id, valid_from, created_by) VALUES ($1, 'branch', $2, '2026-01-01', $1)`, [id, branchId]);
  }
  const res = await app.inject({ method: 'POST', url: `${BASE}/auth/login`, payload: { email: `${key.toLowerCase()}@yu.test`, password: PASSWORD } });
  cookies[key] = String(res.headers['set-cookie']).split(';')[0]!;
  ids[key] = id;
}
const get = (who: string, url: string) => app.inject({ method: 'GET', url: `${BASE}${url}`, headers: { cookie: cookies[who]! } });
const noRid = (r: { json(): { error: Record<string, unknown> } }) => ({ ...r.json().error, requestId: undefined });

async function block(branch: string, type: string, targets: string[], from: string, to: string, unitIds: string[], lifted = false): Promise<string> {
  const id = await one(
    `INSERT INTO app.resource_blocks (branch_id, target_type, target_ids, period, reason_id, comment, status, created_by, lifted_at)
     VALUES ($1, $2, $3, tstzrange($4, $5, '[)'), $6, 'ремонт', $7, $8, $9) RETURNING id`,
    [ids[branch], type, targets, from, to, ids.reason, lifted ? 'lifted' : 'active', ids.owner, lifted ? '2026-11-14T04:00:00Z' : null],
  );
  for (const u of unitIds) await db.client.query(`INSERT INTO app.resource_block_units (block_id, unit_id, period, active) VALUES ($1, $2, tstzrange($3, $4, '[)'), $5)`, [id, u, from, to, !lifted]);
  return id;
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), { staff: { pool, auth: staffAuthConfig('l'.repeat(40)), clock } });
  ids.a = (await createTestBranch(db.client)).id;
  ids.b = (await createTestBranch(db.client)).id;
  ids.reason = (await db.client.query<{ id: string }>(`SELECT id FROM app.dict_reasons WHERE domain = 'resource_block' AND code = 'other'`)).rows[0]!.id;
  ids.room = await one(`INSERT INTO app.rooms (branch_id, slug, name) VALUES ($1, 'vr', 'VR') RETURNING id`, [ids.a]);
  ids.vr1 = await one(`INSERT INTO app.resources (branch_id, room_id, resource_type, name) VALUES ($1, $2, 'vr_seat', 'VR 1') RETURNING id`, [ids.a, ids.room]);
  ids.pc1 = await one(`INSERT INTO app.resources (branch_id, resource_type, name) VALUES ($1, 'pc', 'ПК 1') RETURNING id`, [ids.a]);
  ids.uVr = await one(`INSERT INTO app.occupancy_units (branch_id, room_id, code, name) VALUES ($1, $2, 'vr1', 'VR 1') RETURNING id`, [ids.a, ids.room]);
  ids.uPc = await one(`INSERT INTO app.occupancy_units (branch_id, code, name) VALUES ($1, 'pc1', 'ПК 1') RETURNING id`, [ids.a]);
  await db.client.query(`INSERT INTO app.resource_units (resource_id, unit_id, valid_from) VALUES ($1, $2, '2026-01-01'), ($3, $4, '2026-01-01')`, [ids.vr1, ids.uVr, ids.pc1, ids.uPc]);
  await login('owner', 'owner');
  await login('director', 'director', ids.a);
  await login('adminA', 'admin', ids.a);
  await login('adminB', 'admin', ids.b);
  ids.roomBlock = await block('a', 'room', [ids.room!], '2026-11-20T03:00Z', '2026-11-20T06:00Z', [ids.uVr!]);
  ids.pcBlock = await block('a', 'resource', [ids.pc1!], '2026-11-15T03:00Z', '2026-11-15T04:00Z', [ids.uPc!]);
  ids.oldBlock = await block('a', 'resource', [ids.pc1!], '2026-11-10T03:00Z', '2026-11-10T04:00Z', [ids.uPc!], true);
  ids.bBlock = await block('b', 'unit', [randomUUID()], '2026-11-15T03:00Z', '2026-11-15T04:00Z', []);
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await db.drop();
});

describe('GET /branches/{id}/blocks', () => {
  it('по умолчанию – активные по началу; снятые и все – фильтром; поля для снятия (rowVersion, причина)', async () => {
    const r = await get('adminA', `/branches/${ids.a}/blocks`);
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    const items = r.json().items;
    expect(items.map((b: { id: string }) => b.id)).toEqual([ids.pcBlock, ids.roomBlock]);
    expect(items[0]).toMatchObject({ status: 'active', reasonName: expect.any(String), comment: 'ремонт', rowVersion: 1, start: '2026-11-15T03:00:00.000Z' });
    expect((await get('adminA', `/branches/${ids.a}/blocks?status=lifted`)).json().items.map((b: { id: string }) => b.id)).toEqual([ids.oldBlock]);
    expect((await get('adminA', `/branches/${ids.a}/blocks?status=all`)).json().items).toHaveLength(3);
  });

  it('период – пересечение; ресурс – по цели и по единицам комнаты; комната', async () => {
    const q = (s: string) => get('director', `/branches/${ids.a}/blocks?${s}`).then((r) => r.json().items.map((b: { id: string }) => b.id));
    expect(await q('from=2026-11-20T05:00:00Z&to=2026-11-21T00:00:00Z')).toEqual([ids.roomBlock]);
    expect(await q(`resourceId=${ids.vr1}`)).toEqual([ids.roomBlock]); // блок комнаты закрывает VR-место
    expect(await q(`resourceId=${ids.pc1}&status=all`)).toEqual([ids.oldBlock, ids.pcBlock]);
    expect(await q(`roomId=${ids.room}`)).toEqual([ids.roomBlock]);
    expect((await get('director', `/branches/${ids.a}/blocks?from=2026-11-21T00:00:00Z&to=2026-11-20T00:00:00Z`)).statusCode).toBe(400);
  });

  it('порциями по nextCursor; мусорный курсор – 400', async () => {
    const p1 = (await get('owner', `/branches/${ids.a}/blocks?status=all&limit=2`)).json();
    expect(p1.items).toHaveLength(2);
    const p2 = (await get('owner', `/branches/${ids.a}/blocks?status=all&limit=2&cursor=${p1.nextCursor}`)).json();
    expect(p2.nextCursor).toBeNull();
    expect([...p1.items, ...p2.items].map((b: { id: string }) => b.id)).toEqual([ids.oldBlock, ids.pcBlock, ids.roomBlock]);
    const bad = Buffer.from(JSON.stringify(['x', 'y'])).toString('base64url');
    expect((await get('owner', `/branches/${ids.a}/blocks?cursor=${bad}`)).statusCode).toBe(400);
    expect((await get('owner', `/branches/${ids.a}/blocks?cursor=мусор`)).statusCode).toBe(400);
  });

  it('чужой филиал – 404 с телом несуществующего; Владелец видит любой', async () => {
    const foreign = await get('adminA', `/branches/${ids.b}/blocks`);
    const missing = await get('adminA', `/branches/${randomUUID()}/blocks`);
    expect(foreign.statusCode).toBe(404);
    expect(noRid(foreign)).toEqual(noRid(missing));
    expect(noRid(await get('owner', `/branches/${randomUUID()}/blocks`))).toEqual(noRid(missing));
    expect((await get('owner', `/branches/${ids.b}/blocks`)).json().items.map((b: { id: string }) => b.id)).toEqual([ids.bBlock]);
    expect((await app.inject({ method: 'GET', url: `${BASE}/branches/${ids.a}/blocks` })).statusCode).toBe(401);
  });
});

describe('хронология объектов филиала по зоне', () => {
  beforeAll(async () => {
    const meta = (who: string) => ({ actor: { kind: 'staff' as const, staffId: ids[who]!, sessionId: 's' }, source: 'crm' as const, requestId: randomUUID() });
    const ev = (who: string, type: AuditObjectType, id: string, branchId: string) =>
      writeAudit(pool, meta(who), { action: `${type === 'resource_block' ? 'block' : type}.updated`, object: { type, id }, branchId, after: { name: 'x' } }, clock);
    await ev('owner', 'room', ids.room!, ids.a!);
    await ev('director', 'resource', ids.vr1!, ids.a!);
    await ev('adminA', 'resource', ids.vr1!, ids.a!);
    ids.tariffB = randomUUID();
    await ev('owner', 'tariff', ids.tariffB, ids.b!);
    ids.tariffA = randomUUID();
    await ev('owner', 'tariff', ids.tariffA, ids.a!);
    // отказ с филиалом A по объекту филиала B не открывает объект B Директору A
    await pool.query(
      `INSERT INTO journal.audit_events (occurred_at, actor_type, actor_id, action, object_type, object_id, branch_id, result, source, request_id)
       VALUES (now(), 'staff', $1, 'tariff.updated', 'tariff', $2, $3, 'denied', 'crm', 'r')`,
      [ids.director, ids.tariffB, ids.a],
    );
  });
  const tl = (who: string, type: string, id: string) => get(who, `/audit/timeline?objectType=${type}&objectId=${id}`);

  it('Директор своей зоны видит хронологию комнаты, ресурса, тарифа; чужого филиала – 404', async () => {
    expect((await tl('director', 'room', ids.room!)).json().items).toHaveLength(1);
    expect((await tl('director', 'resource', ids.vr1!)).json().items).toHaveLength(2);
    expect((await tl('director', 'tariff', ids.tariffA!)).statusCode).toBe(200);
    const foreign = await tl('director', 'tariff', ids.tariffB!);
    expect(foreign.statusCode).toBe(404);
    expect(noRid(foreign)).toEqual(noRid(await tl('director', 'tariff', randomUUID())));
  });

  it('Администратор – только свои события в своей зоне; Владелец – всё', async () => {
    const own = (await tl('adminA', 'resource', ids.vr1!)).json().items;
    expect(own.map((e: { actor: { id: string } }) => e.actor.id)).toEqual([ids.adminA]);
    expect((await tl('adminB', 'resource', ids.vr1!)).statusCode).toBe(404);
    expect((await tl('owner', 'tariff', ids.tariffB!)).json().items).toHaveLength(2);
  });
});

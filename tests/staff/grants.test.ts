// S3-89: API делегирования по HTTP (K1 «Делегирование», K11 №380–382): только Владелец, себе нельзя, зона внутри назначений,
// аудит выдачи и отзыва, право начинает и перестаёт действовать со следующего запроса.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { hashPassword, staffAuthConfig } from '../../apps/api/src/modules/staff/auth.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { createTestBranch, createTestCity } from '../helpers/network.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const PASSWORD = 'Пароль-делегирования-2';
const BASE = '/api/crm/v1';
const CITY_1 = '11111111-0000-4000-8000-00000000000c';
const CITY_2 = '22222222-0000-4000-8000-00000000000c';
const BR_A = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const BR_C = 'cccccccc-0000-4000-8000-0000000000c1';
const clock = fixedClock('2026-11-20T07:00:00Z');
let db: TestDatabase;
let pool: pg.Pool;
let app: FastifyInstance;
const ids: Record<string, string> = {};
const cookies: Record<string, string> = {};

async function staff(key: string, role: string, assign?: { city?: string; branch?: string }): Promise<void> {
  const r = await db.client.query<{ id: string }>(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', $1, $2, $3) RETURNING id`, [`${key}@yu.test`, role, await hashPassword(PASSWORD)]);
  ids[key] = r.rows[0]!.id;
  if (assign) {
    await db.client.query(`INSERT INTO app.staff_assignments (staff_id, scope_type, city_id, branch_id, valid_from, created_by) VALUES ($1, $2, $3, $4, '2026-01-01', $1)`, [ids[key], assign.city ? 'city' : 'branch', assign.city ?? null, assign.branch ?? null]);
  }
  const res = await app.inject({ method: 'POST', url: `${BASE}/auth/login`, payload: { email: `${key}@yu.test`, password: PASSWORD } });
  cookies[key] = String(res.headers['set-cookie']).split(';')[0]!;
}
function req(who: string, method: 'GET' | 'POST', url: string, payload?: object, key: string | null = randomUUID()) {
  const headers: Record<string, string> = { cookie: cookies[who]! };
  if (key && method !== 'GET') headers['idempotency-key'] = key;
  return app.inject({ method, url: `${BASE}${url}`, headers, ...(payload ? { payload } : {}) });
}
const grantBody = (over: object = {}) => ({ action: 'network.hours.manage', branchId: BR_A, validFrom: '2026-11-20', ...over });
const audits = async (action: string, result = 'success') =>
  (await db.client.query<{ object_id: string; actor_id: string }>(`SELECT object_id, actor_id FROM journal.audit_events WHERE action = $1 AND result = $2`, [action, result])).rows;
const actionsOf = async (who: string) => (await req(who, 'GET', '/me')).json().actions as string[];

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  await createTestCity(db.client, { id: CITY_1 });
  await createTestCity(db.client, { id: CITY_2 });
  await createTestBranch(db.client, { id: BR_A, cityId: CITY_1 });
  await createTestBranch(db.client, { id: BR_C, cityId: CITY_2 });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 6 });
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), { staff: { pool, auth: staffAuthConfig('t'.repeat(40)), clock } });
  await staff('owner', 'owner');
  await staff('director', 'director', { city: CITY_1 });
  await staff('admin', 'admin', { branch: BR_A });
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await db.drop();
});

describe('только Владелец', () => {
  it('Директор и Администратор получают 403 на выдачу, отзыв и список; отказ в аудите', async () => {
    const before = (await audits('staff.grant.created', 'denied')).length;
    for (const who of ['director', 'admin']) {
      expect((await req(who, 'POST', `/staff/${ids.admin}/grants`, grantBody())).statusCode).toBe(403);
      expect((await req(who, 'POST', `/staff/grants/${randomUUID()}/revoke`, {})).statusCode).toBe(403);
      expect((await req(who, 'GET', '/staff/grants')).statusCode).toBe(403);
    }
    expect((await audits('staff.grant.created', 'denied')).length).toBe(before + 4);
    expect((await audits('staff.grant.revoked', 'denied')).length).toBe(2);
  });

  it('без сессии – 401, без ключа идемпотентности – 400', async () => {
    expect((await app.inject({ method: 'GET', url: `${BASE}/staff/grants` })).statusCode).toBe(401);
    expect((await req('owner', 'POST', `/staff/${ids.admin}/grants`, grantBody(), null)).json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('выдача себе запрещена', async () => {
    const r = await req('owner', 'POST', `/staff/${ids.owner}/grants`, grantBody());
    expect(r.statusCode).toBe(403);
  });
});

describe('проверки выдачи', () => {
  it('неделегируемое действие, чужая зона, сломанные даты и цель, неизвестный сотрудник', async () => {
    const code = async (id: string, over: object) => {
      const r = await req('owner', 'POST', `/staff/${id}/grants`, grantBody(over));
      return [r.statusCode, r.json().error?.code];
    };
    expect(await code(ids.admin!, { action: 'finance.correct' })).toEqual([422, 'GRANT_ACTION_NOT_DELEGABLE']);
    expect(await code(ids.admin!, { action: 'payroll.view', branchId: BR_C })).toEqual([422, 'GRANT_SCOPE_INVALID']);
    expect(await code(ids.admin!, { branchId: undefined, cityId: CITY_1 })).toEqual([422, 'GRANT_SCOPE_INVALID']);
    expect(await code(ids.admin!, { validFrom: '2026-01-01' })).toEqual([400, 'VALIDATION_FAILED']);
    expect(await code(ids.admin!, { validTo: '2026-11-19' })).toEqual([400, 'VALIDATION_FAILED']);
    expect(await code(ids.admin!, { cityId: CITY_1 })).toEqual([400, 'VALIDATION_FAILED']);
    expect(await code(randomUUID(), {})).toEqual([404, 'NOT_FOUND']);
    expect((await pool.query('SELECT count(*)::int AS n FROM app.staff_grants')).rows[0].n).toBe(0);
  });
});

describe('выдача, действие, отзыв', () => {
  let grantId = '';

  it('выдача: 201, срок, аудит, /me показывает действие, повтор с тем же ключом не плодит строку', async () => {
    expect(await actionsOf('admin')).not.toContain('network.hours.manage');
    const key = randomUUID();
    const r = await req('owner', 'POST', `/staff/${ids.admin}/grants`, grantBody({ validTo: '2026-12-31', reason: 'закрывает отпуск директора' }), key);
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ staffId: ids.admin, action: 'network.hours.manage', branchId: BR_A, cityId: null, validFrom: '2026-11-20', validTo: '2026-12-31', grantedBy: ids.owner, revokedAt: null });
    grantId = r.json().id;
    const replay = await req('owner', 'POST', `/staff/${ids.admin}/grants`, grantBody({ validTo: '2026-12-31', reason: 'закрывает отпуск директора' }), key);
    expect(replay.headers['idempotent-replay']).toBe('true');
    expect(await audits('staff.grant.created')).toEqual([{ object_id: grantId, actor_id: ids.owner }]);
    expect(await actionsOf('admin')).toContain('network.hours.manage');
  });

  it('пересечение того же права – 409; список: всё и по сотруднику, с закрытым списком действий', async () => {
    const dup = await req('owner', 'POST', `/staff/${ids.admin}/grants`, grantBody({ validFrom: '2026-12-01' }));
    expect([dup.statusCode, dup.json().error.code]).toEqual([409, 'GRANT_ALREADY_ACTIVE']);
    const list = await req('owner', 'GET', `/staff/grants?staffId=${ids.admin}`);
    expect(list.statusCode).toBe(200);
    expect(list.json().items.map((x: { id: string }) => x.id)).toEqual([grantId]);
    expect(list.json().delegable).toContain('payroll.view');
    expect(list.json().delegable).not.toContain('finance.correct');
    expect((await req('owner', 'GET', `/staff/grants?staffId=${ids.director}`)).json().items).toEqual([]);
  });

  it('отзыв: аудит, /me без действия со следующего запроса; повтор не пишет аудит второй раз', async () => {
    const r = await req('owner', 'POST', `/staff/grants/${grantId}/revoke`, { reason: 'директор вернулся' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().revokedBy).toBe(ids.owner);
    expect(await actionsOf('admin')).not.toContain('network.hours.manage');
    expect((await req('owner', 'POST', `/staff/grants/${grantId}/revoke`, {})).statusCode).toBe(200);
    expect((await audits('staff.grant.revoked')).length).toBe(1);
    expect((await req('owner', 'POST', `/staff/grants/${randomUUID()}/revoke`, {})).statusCode).toBe(404);
  });

  it('живое действие: network.branch.create на город открывает создание филиала только в нём', async () => {
    const branch = (slug: string, cityId: string) => req('director', 'POST', '/branches', { cityId, slug, name: slug, address: 'адрес' });
    expect((await branch('bez-prava', CITY_1)).statusCode).toBe(403);
    const g = await req('owner', 'POST', `/staff/${ids.director}/grants`, { action: 'network.branch.create', cityId: CITY_1, validFrom: '2026-11-20' });
    expect(g.statusCode, g.body).toBe(201);
    expect((await branch('s-pravom', CITY_1)).statusCode).toBe(201);
    expect((await branch('chuzhoy', CITY_2)).statusCode).toBe(404);
  });
});

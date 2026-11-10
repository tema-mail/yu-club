// K11 №251–252, K9 «Слияние» по HTTP на настоящем сервере (buildServer регистрирует все шесть обработчиков модулей):
// права (Владелец – да; Директор и Администратор без права – 403 с записью отказа; делегированное право – только клиенты
// зоны, чужой – 404), Idempotency-Key (обязателен; повтор – тот же ответ; новый ключ после слияния – 409 CLIENT_MERGED),
// старая карточка – 200 с фактом объединения без ПДн, поиск – по id находит, по старому телефону – нет.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { hashPassword, staffAuthConfig } from '../../apps/api/src/modules/staff/auth.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { createTestBooking } from '../helpers/booking.ts';
import { createTestBranch } from '../helpers/network.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const PASSWORD = 'Пароль-для-слияния-1';
const BR_1 = 'bbbbbbbb-0000-4000-8000-0000000000c1';
const BR_2 = 'bbbbbbbb-0000-4000-8000-0000000000c2';
const URL = '/api/crm/v1/clients';
let db: TestDatabase;
let pool: pg.Pool;
let app: FastifyInstance;
const clock = fixedClock('2026-11-20T07:00:00Z');
const cookies: Record<string, string> = {};
const staffIds: Record<string, string> = {};
let seq = 79220000000;

async function addStaff(key: string, role: string, branch?: string): Promise<void> {
  const r = await db.client.query<{ id: string }>(
    `INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('Имя', 'Фамилия', $1, $2, $3) RETURNING id`,
    [`${key}@yu.test`, role, await hashPassword(PASSWORD)],
  );
  staffIds[key] = r.rows[0]!.id;
  if (branch) {
    await db.client.query(`INSERT INTO app.staff_assignments (staff_id, scope_type, branch_id, valid_from, created_by) VALUES ($1, 'branch', $2, '2026-01-01', $1)`, [r.rows[0]!.id, branch]);
  }
}
async function login(key: string): Promise<void> {
  const res = await app.inject({ method: 'POST', url: '/api/crm/v1/auth/login', payload: { email: `${key}@yu.test`, password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  cookies[key] = String(res.headers['set-cookie']).split(';')[0]!;
}
async function addClient(name: string, branch?: string): Promise<{ id: string; phone: string }> {
  const phone = `+${++seq}`;
  const id = (await db.client.query<{ id: string }>(
    `INSERT INTO app.clients (phone_e164, phone_verified_at, first_name, last_name, status, registered_at, created_by_type) VALUES ($1, now(), $2, 'Дублёва', 'active', now(), 'system') RETURNING id`,
    [phone, name],
  )).rows[0]!.id;
  if (branch) await createTestBooking(db.client, { clientId: id, branchId: branch, status: 'completed' });
  return { id, phone };
}
const get = (key: string, url: string) => app.inject({ method: 'GET', url, headers: { cookie: cookies[key]! } });
const post = (key: string, id: string, payload: object, idem: string | null = randomUUID()) =>
  app.inject({ method: 'POST', url: `${URL}/${id}/merge`, headers: { cookie: cookies[key]!, ...(idem ? { 'idempotency-key': idem } : {}) }, payload });

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  await createTestBranch(db.client, { id: BR_1 });
  await createTestBranch(db.client, { id: BR_2 });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 6 });
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), { staff: { pool, auth: staffAuthConfig('k'.repeat(40)), clock } });
  await addStaff('owner', 'owner');
  await addStaff('director', 'director', BR_1);
  await addStaff('admin', 'admin', BR_1);
  await addStaff('deleg', 'director', BR_1);
  await db.client.query(
    `INSERT INTO app.staff_grants (staff_id, action, scope_type, branch_id, valid_from, granted_by) VALUES ($1, 'client.merge', 'branch', $2, '2026-11-01', $3)`,
    [staffIds.deleg, BR_1, staffIds.owner],
  );
  for (const k of ['owner', 'director', 'admin', 'deleg']) await login(k);
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await db.drop();
});

describe('права', () => {
  it('Директор и Администратор без права – 403 FORBIDDEN (client.merge), отказ в аудите, карточки целы', async () => {
    const a = await addClient('Анна', BR_1);
    const b = await addClient('Аня', BR_1);
    for (const key of ['director', 'admin']) {
      const res = await post(key, a.id, { secondaryId: b.id, reason: 'same_person_confirmed' });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toMatchObject({ code: 'FORBIDDEN', details: { action: 'client.merge' } });
      expect((await get(key, `${URL}/${a.id}/merge-preview?with=${b.id}`)).statusCode).toBe(403);
    }
    const denied = await db.client.query(`SELECT count(*)::int AS n FROM journal.audit_events WHERE object_id = $1 AND action = 'client.merged' AND result = 'denied'`, [a.id]);
    expect(denied.rows[0].n).toBe(4);
    expect((await db.client.query('SELECT status FROM app.clients WHERE id = $1', [b.id])).rows[0].status).toBe('active');
  });

  it('делегированное право: клиенты своей зоны – можно, клиент вне зоны – 404 как несуществующий', async () => {
    const a = await addClient('Вера', BR_1);
    const b = await addClient('Вероника', BR_1);
    const foreign = await addClient('Варвара', BR_2);
    const out = await post('deleg', a.id, { secondaryId: foreign.id, reason: 'same_person_confirmed' });
    expect(out.statusCode).toBe(404);
    expect((await get('deleg', `${URL}/${a.id}/merge-preview?with=${foreign.id}`)).statusCode).toBe(404);
    const ok = await post('deleg', a.id, { secondaryId: b.id, reason: 'duplicate_registration' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ primaryId: a.id, secondaryId: b.id, status: 'merged' });
  });
});

describe('Владелец', () => {
  it('предпросмотр: обе карточки, данные шести модулей, конфликты; мусорный with – 400; чужой id – 404', async () => {
    const a = await addClient('Галина', BR_1);
    const b = await addClient('Галя', BR_2);
    const res = await get('owner', `${URL}/${a.id}/merge-preview?with=${b.id}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.primary.id).toBe(a.id);
    expect(body.secondary.id).toBe(b.id);
    expect(Object.keys(body.modules).sort()).toEqual(['booking', 'certificates', 'events', 'finance', 'loyalty', 'notifications']);
    expect(body.modules.booking.secondary).toMatchObject({ total: 1 });
    expect(body.conflicts).toEqual(expect.arrayContaining([{ field: 'firstName', primary: 'Галина', secondary: 'Галя' }]));
    expect(body.canMerge).toBe(true);
    expect((await get('owner', `${URL}/${a.id}/merge-preview?with=nope`)).statusCode).toBe(400);
    expect((await get('owner', `${URL}/${a.id}/merge-preview?with=00000000-0000-4000-8000-000000000000`)).statusCode).toBe(404);
  });

  it('слияние: без ключа – 400; тот же ключ – тот же ответ; новый ключ – 409 CLIENT_MERGED; старая карточка – факт объединения', async () => {
    const a = await addClient('Дарья', BR_1);
    const b = await addClient('Даша', BR_1);
    const payload = { secondaryId: b.id, reason: 'same_person_confirmed' };
    expect((await post('owner', a.id, payload, null)).json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect((await post('owner', a.id, { secondaryId: b.id, reason: 'потому что' })).statusCode).toBe(400);
    const key = randomUUID();
    const first = await post('owner', a.id, payload, key);
    expect(first.statusCode).toBe(200);
    expect(first.json().results.booking).toMatchObject({ bookings: 1 });
    const again = await post('owner', a.id, payload, key);
    expect(again.statusCode).toBe(200);
    expect(again.headers['idempotent-replay']).toBe('true');
    expect(again.json()).toEqual(first.json());
    expect((await db.client.query('SELECT count(*)::int AS n FROM journal.client_merges WHERE secondary_client_id = $1', [b.id])).rows[0].n).toBe(1);
    const other = await post('owner', a.id, payload);
    expect(other.statusCode).toBe(409);
    expect(other.json().error).toMatchObject({ code: 'CLIENT_MERGED', details: { clientId: b.id, mergedIntoId: a.id } });

    const card = await get('owner', `${URL}/${b.id}`);
    expect(card.statusCode).toBe(200);
    expect(card.json()).toMatchObject({ id: b.id, status: 'merged', mergedIntoId: a.id, firstName: null, lastName: null, phoneMasked: '', full: null });
    expect(card.body).not.toContain(b.phone.slice(-4));
    expect((await get('owner', `${URL}/${a.id}`)).json()).toMatchObject({ status: 'active', mergedIntoId: null });

    const byId = await get('owner', `${URL}?q=${b.id}`);
    expect(byId.json().items).toEqual([expect.objectContaining({ id: b.id, status: 'merged' })]);
    expect((await get('owner', `${URL}?q=${encodeURIComponent(b.phone)}`)).json().items).toEqual([]);
  });

  it('обезличенную – 409 CLIENT_NOT_MERGEABLE', async () => {
    const a = await addClient('Елена', BR_1);
    const b = await addClient('Лена', BR_1);
    const an = await app.inject({ method: 'POST', url: `${URL}/${b.id}/anonymize`, headers: { cookie: cookies.owner!, 'idempotency-key': randomUUID() }, payload: { reason: 'client_request' } });
    expect(an.statusCode).toBe(200);
    const res = await post('owner', a.id, { secondaryId: b.id, reason: 'same_person_confirmed' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CLIENT_NOT_MERGEABLE');
  });
});

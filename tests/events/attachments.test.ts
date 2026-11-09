// Вложения мероприятия (K19 §9, 11 §11.4): владелец 'event' зарегистрирован сервером; запись – event.money.record,
// чтение – event.view, вне зоны – 404 на загрузке, списке и выдаче; файл – только через GET /attachments/:id.
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import { createFileStore } from '../../apps/api/src/core/files.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { hashPassword, staffAuthConfig } from '../../apps/api/src/modules/staff/auth.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const PASSWORD = 'Пароль-документов-мероприятия-1';
const BASE = '/api/crm/v1';
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
const clock = fixedClock('2026-11-14T05:00:00Z');
let db: TestDatabase;
let pool: pg.Pool;
let app: FastifyInstance;
let root: string;
const cookies: Record<string, string> = {};
const ids: Record<string, string> = {};

type Who = 'owner' | 'admin' | 'stranger';
const one = async (sql: string, params: unknown[] = []) => (await db.client.query(sql, params)).rows[0];
async function staff(who: Who, role: string, branchId: string | null): Promise<void> {
  const s = await one(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', $1, $2, $3) RETURNING id`, [`${who}@yu.test`, role, await hashPassword(PASSWORD)]);
  ids[who] = s.id;
  if (branchId) await db.client.query(`INSERT INTO app.staff_assignments (staff_id, scope_type, branch_id, valid_from, created_by) VALUES ($1, 'branch', $2, '2026-01-01', $1)`, [s.id, branchId]);
  const res = await app.inject({ method: 'POST', url: `${BASE}/auth/login`, payload: { email: `${who}@yu.test`, password: PASSWORD } });
  cookies[who] = String(res.headers['set-cookie']).split(';')[0]!;
}
const get = (who: Who, url: string) => app.inject({ method: 'GET', url: `${BASE}${url}`, headers: { cookie: cookies[who]! } });
const post = (who: Who, url: string, payload: object) => app.inject({ method: 'POST', url: `${BASE}${url}`, headers: { cookie: cookies[who]!, 'idempotency-key': randomUUID() }, payload });
const upload = (who: Who, eventId: string, file: Buffer = PDF) =>
  app.inject({
    method: 'POST',
    url: `${BASE}/attachments?${new URLSearchParams({ ownerType: 'event', ownerId: eventId, docType: 'check', name: 'чек.pdf' })}`,
    headers: { cookie: cookies[who]!, 'content-type': 'application/pdf', 'idempotency-key': randomUUID() },
    payload: file,
  });
async function newEvent(): Promise<string> {
  const r = await post('owner', '/events', { typeId: ids.type, branchId: ids.b1, customer: { name: 'Анна Смирнова', phone: '+79131234567' } });
  expect(r.statusCode).toBe(201);
  return r.json().id;
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
  root = await mkdtemp(path.join(os.tmpdir(), 'yu-event-docs-'));
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), { staff: { pool, auth: staffAuthConfig('d'.repeat(40)), clock }, attachments: { store: createFileStore({ root }) } });
  const city = await one(`INSERT INTO app.cities (code, slug, name, timezone) VALUES ('nsk', 'nsk', 'НСК', 'Asia/Novosibirsk') RETURNING id`);
  for (const code of ['b1', 'b2']) {
    ids[code] = (await one(`INSERT INTO app.branches (city_id, code, slug, name, address, timezone, status) VALUES ($1, $2, $2, $2, 'адрес', 'Asia/Novosibirsk', 'active') RETURNING id`, [city.id, code])).id;
  }
  await staff('owner', 'owner', null);
  await staff('admin', 'admin', ids.b1!);
  await staff('stranger', 'director', ids.b2!);
  ids.type = (await one(`SELECT id FROM app.event_types WHERE code = 'other'`)).id;
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await db.drop();
  await rm(root, { recursive: true, force: true });
});

describe('владелец вложений event', () => {
  it('Администратор филиала кладёт чек и скачивает его через API; чужой филиал – 404 на загрузке, списке и выдаче', async () => {
    const eventId = await newEvent();
    const up = await upload('admin', eventId);
    expect(up.statusCode).toBe(201);
    const id = up.json().attachmentId as string;
    expect(up.json().attachment).toMatchObject({ ownerType: 'event', ownerId: eventId, docType: 'check', status: 'active' });

    const file = await get('admin', `/attachments/${id}`);
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-disposition']).toMatch(/^attachment;/);
    expect(file.rawPayload.equals(PDF)).toBe(true);
    expect((await get('admin', `/attachments?ownerType=event&ownerId=${eventId}`)).json().items.map((a: { id: string }) => a.id)).toEqual([id]);

    expect((await upload('stranger', eventId)).statusCode).toBe(404);
    expect((await get('stranger', `/attachments/${id}`)).statusCode).toBe(404);
    expect((await get('stranger', `/attachments?ownerType=event&ownerId=${eventId}`)).statusCode).toBe(404);
    expect((await post('stranger', `/attachments/${id}/invalidate`, { reason: 'x' })).statusCode).toBe(404);
  });

  it('несуществующее мероприятие – 404, как чужое', async () => {
    expect((await upload('owner', randomUUID())).statusCode).toBe(404);
  });
});

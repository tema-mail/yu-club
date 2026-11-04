// S3-07 по HTTP: K19 №350 – вложения. IDOR: файл объекта чужого филиала → 404 (выдача, список, загрузка,
// «недействителен»); без зарегистрированного владельца тип отклоняется; выдача – скачиванием с nosniff;
// повтор загрузки с тем же Idempotency-Key – та же запись.
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import { AppError } from '../../apps/api/src/core/errors.ts';
import { createFileStore, registerAttachmentOwner } from '../../apps/api/src/core/files.ts';
import { assertCan } from '../../apps/api/src/core/permissions.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { hashPassword, staffAuthConfig } from '../../apps/api/src/modules/staff/auth.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const PASSWORD = 'Пароль-вложений-проверка-1';
const BASE = '/api/crm/v1';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2, 3]);
const EXE = Buffer.from([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0, 4, 0, 0, 0, 0xff, 0xff, 0, 0]);
let db: TestDatabase;
let pool: pg.Pool;
let app: FastifyInstance;
let root: string;
const cookies: Record<string, string> = {};
const ids: Record<string, string> = {};
/** Объекты-владельцы теста: id → филиал. */
const objects = new Map<string, string>();
const clock = fixedClock('2026-11-14T05:00:00Z');

async function staff(key: string, role: string, branch?: string): Promise<void> {
  const r = await db.client.query<{ id: string }>(
    `INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', $1, $2, $3) RETURNING id`,
    [`${key}@yu.test`, role, await hashPassword(PASSWORD)],
  );
  if (branch) {
    await db.client.query(
      `INSERT INTO app.staff_assignments (staff_id, scope_type, branch_id, valid_from, created_by) VALUES ($1, 'branch', $2, '2026-01-01', $1)`,
      [r.rows[0]!.id, branch],
    );
  }
  const res = await app.inject({ method: 'POST', url: `${BASE}/auth/login`, payload: { email: `${key}@yu.test`, password: PASSWORD } });
  cookies[key] = String(res.headers['set-cookie']).split(';')[0]!;
}

function upload(who: string, query: Record<string, string>, file: Buffer, contentType = 'image/png', key: string | null = randomUUID()) {
  const headers: Record<string, string> = { cookie: cookies[who]!, 'content-type': contentType };
  if (key) headers['idempotency-key'] = key;
  return app.inject({ method: 'POST', url: `${BASE}/attachments?${new URLSearchParams(query)}`, headers, payload: file });
}
const get = (who: string, url: string) => app.inject({ method: 'GET', url: `${BASE}${url}`, headers: { cookie: cookies[who]! } });
const post = (who: string, url: string, payload: object) =>
  app.inject({ method: 'POST', url: `${BASE}${url}`, headers: { cookie: cookies[who]!, 'idempotency-key': randomUUID() }, payload });
const newObject = (branchId: string) => {
  const id = randomUUID();
  objects.set(id, branchId);
  return id;
};

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
  root = await mkdtemp(path.join(os.tmpdir(), 'yu-attach-http-'));
  const branchOf = (id: string) => {
    const b = objects.get(id);
    if (!b) throw new AppError('NOT_FOUND', 404, 'Не найдено');
    return b;
  };
  registerAttachmentOwner('test_object', {
    canRead: async (_db, c, id) => assertCan(c, 'equipment.view', { branchId: branchOf(id) }),
    canWrite: async (_db, c, id) => assertCan(c, 'repair.attach', { branchId: branchOf(id) }),
  });
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), {
    staff: { pool, auth: staffAuthConfig('t'.repeat(40)), clock },
    attachments: { store: createFileStore({ root }) },
  });
  await staff('owner', 'owner');
  const c = await post('owner', '/cities', { slug: 'nsk', name: 'Новосибирск', timezone: 'Asia/Novosibirsk' });
  for (const slug of ['lenina', 'marksa']) {
    const b = await post('owner', '/branches', { cityId: c.json().id, slug, name: slug, address: 'адрес' });
    ids[slug] = b.json().id;
  }
  await staff('admin', 'admin', ids.lenina);
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await db.drop();
  await rm(root, { recursive: true, force: true });
});

describe('вложения по HTTP (№350)', () => {
  it('загрузка → 201; выдача – те же байты, скачиванием, nosniff, без кэша', async () => {
    const obj = newObject(ids.lenina!);
    const res = await upload('admin', { ownerType: 'test_object', ownerId: obj, docType: 'photo', name: 'шлем VR1.png' }, PNG);
    expect(res.statusCode).toBe(201);
    const { attachmentId, attachment } = res.json();
    expect(attachment).toMatchObject({ ownerId: obj, mimeType: 'image/png', sizeBytes: PNG.length, originalName: 'шлем VR1.png' });
    const file = await get('admin', `/attachments/${attachmentId}`);
    expect(file.statusCode).toBe(200);
    expect(Buffer.compare(file.rawPayload, PNG)).toBe(0);
    expect(file.headers['content-type']).toBe('image/png');
    expect(file.headers['content-disposition']).toMatch(/^attachment; filename="/);
    expect(file.headers['content-disposition']).toContain(`filename*=UTF-8''${encodeURIComponent('шлем VR1.png')}`);
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(file.headers['cache-control']).toBe('private, no-store');
    const list = await get('admin', `/attachments?ownerType=test_object&ownerId=${obj}`);
    expect(list.json().items.map((a: { id: string }) => a.id)).toEqual([attachmentId]);
  });

  it('IDOR: объект чужого филиала → 404 на выдачу, список, загрузку и «недействителен»; тело – как у несуществующего', async () => {
    const foreign = newObject(ids.marksa!);
    const own = await upload('owner', { ownerType: 'test_object', ownerId: foreign, docType: 'receipt' }, PNG);
    expect(own.statusCode).toBe(201);
    const id = own.json().attachmentId as string;
    const missing = await get('admin', `/attachments/${randomUUID()}`);
    expect(missing.statusCode).toBe(404);
    for (const r of [
      await get('admin', `/attachments/${id}`),
      await get('admin', `/attachments?ownerType=test_object&ownerId=${foreign}`),
      await upload('admin', { ownerType: 'test_object', ownerId: foreign, docType: 'photo' }, PNG),
      await post('admin', `/attachments/${id}/invalidate`, { reason: 'чужое' }),
    ]) {
      expect(r.statusCode).toBe(404);
      expect(r.json().error.code).toBe('NOT_FOUND');
    }
  });

  it('без зарегистрированного владельца тип отклоняется; подмена MIME → 415; без ключа – 400', async () => {
    const obj = newObject(ids.lenina!);
    const unknown = await upload('owner', { ownerType: 'repair_unknown', ownerId: obj, docType: 'photo' }, PNG);
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error.code).toBe('VALIDATION_FAILED');
    const exe = await upload('owner', { ownerType: 'test_object', ownerId: obj, docType: 'photo' }, EXE, 'image/png');
    expect(exe.statusCode).toBe(415);
    expect(exe.json().error.code).toBe('ATTACHMENT_TYPE_NOT_ALLOWED');
    const exeOwnType = await upload('owner', { ownerType: 'test_object', ownerId: obj, docType: 'photo' }, EXE, 'application/x-msdownload');
    expect(exeOwnType.statusCode).toBe(415);
    const noKey = await upload('owner', { ownerType: 'test_object', ownerId: obj, docType: 'photo' }, PNG, 'image/png', null);
    expect(noKey.json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('повтор с тем же ключом – та же запись, одна строка; «недействителен» с причиной', async () => {
    const obj = newObject(ids.lenina!);
    const key = randomUUID();
    const a = await upload('admin', { ownerType: 'test_object', ownerId: obj, docType: 'act' }, PNG, 'image/png', key);
    const b = await upload('admin', { ownerType: 'test_object', ownerId: obj, docType: 'act' }, PNG, 'image/png', key);
    expect(b.headers['idempotent-replay']).toBe('true');
    expect(b.json().attachmentId).toBe(a.json().attachmentId);
    const n = await db.client.query(`SELECT count(*)::int AS n FROM app.attachments WHERE owner_id = $1`, [obj]);
    expect(n.rows[0].n).toBe(1);
    const inv = await post('admin', `/attachments/${a.json().attachmentId}/invalidate`, { reason: 'не тот акт' });
    expect(inv.statusCode).toBe(200);
    expect(inv.json()).toMatchObject({ status: 'invalid', invalidReason: 'не тот акт' });
  });
});

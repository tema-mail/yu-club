// S4-31: API медиа по HTTP (K11 №224–227). Администратор загружает, но не архивирует; удаление – только Владелец и только
// неиспользованное; ответ – без абсолютного пути на диске; лимит 10 МБ → MEDIA_TOO_LARGE; настоящий multipart, живые файлы.
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import { createFileStore, type FileStore } from '../../apps/api/src/core/files.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { syncUsages } from '../../apps/api/src/modules/content/media.ts';
import { hashPassword, staffAuthConfig } from '../../apps/api/src/modules/staff/auth.ts';
import { buildServer, depsFromConfig } from '../../apps/api/src/server.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const PASSWORD = 'Пароль-медиа-проверка-1';
const BASE = '/api/crm/v1';
const clock = fixedClock('2026-11-14T05:00:00Z');
let db: TestDatabase;
let pool: pg.Pool;
let app: FastifyInstance;
let root: string;
let store: FileStore;
const cookies: Record<string, string> = {};

async function staff(key: string, role: string): Promise<void> {
  const r = await db.client.query<{ id: string }>(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', $1, $2, $3) RETURNING id`, [`${key}@yu.test`, role, await hashPassword(PASSWORD)]);
  await db.client.query(`INSERT INTO app.staff_assignments (staff_id, scope_type, branch_id, valid_from, created_by) SELECT $1, 'branch', id, '2026-01-01', $1 FROM app.branches WHERE $2 <> 'owner' LIMIT 1`, [r.rows[0]!.id, role]);
  const res = await app.inject({ method: 'POST', url: `${BASE}/auth/login`, payload: { email: `${key}@yu.test`, password: PASSWORD } });
  cookies[key] = String(res.headers['set-cookie']).split(';')[0]!;
}

function multipart(file: Buffer, fields: Record<string, string> = {}, filename = 'фото.png'): { payload: Buffer; contentType: string } {
  const boundary = `----yu${randomUUID()}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
  parts.push(file, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}
function upload(who: string, file: Buffer, fields: Record<string, string> = {}, idempotencyKey = randomUUID()) {
  const m = multipart(file, fields);
  return app.inject({ method: 'POST', url: `${BASE}/content/media`, headers: { cookie: cookies[who]!, 'content-type': m.contentType, 'idempotency-key': idempotencyKey }, payload: m.payload });
}
const get = (who: string, url: string) => app.inject({ method: 'GET', url: `${BASE}${url}`, headers: { cookie: cookies[who]! } });
const send = (who: string, method: 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
  app.inject({ method, url: `${BASE}${url}`, headers: { cookie: cookies[who]!, 'idempotency-key': randomUUID() }, ...(payload ? { payload } : {}) });
const png = (seed: number) => sharp({ create: { width: 600, height: 400, channels: 3, background: { r: seed, g: 50, b: 90 } } }).png().toBuffer();

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
  root = await mkdtemp(path.join(os.tmpdir(), 'yu-media-http-'));
  store = createFileStore({ root });
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), { staff: { pool, auth: staffAuthConfig('t'.repeat(40)), clock }, content: { mediaStore: store } });
  await staff('owner', 'owner');
  const c = await send('owner', 'POST', '/cities', { slug: 'nsk', name: 'Новосибирск', timezone: 'Asia/Novosibirsk' });
  await send('owner', 'POST', '/branches', { cityId: c.json().id, slug: 'lenina', name: 'Ленина', address: 'адрес' });
  await staff('director', 'director');
  await staff('admin', 'admin');
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await db.drop();
  await rm(root, { recursive: true, force: true });
});

describe('S4-31: медиатека по HTTP', () => {
  it('Администратор загружает: 201, поля и адреса, без абсолютного пути; файлы реально на диске; повтор ключа – та же запись; без ключа – отказ', async () => {
    const file = await png(1);
    const key = randomUUID();
    const res = await upload('admin', file, { alt: 'Зал', title: 'Подпись' }, key);
    expect(res.statusCode).toBe(201);
    const { media, duplicate } = res.json();
    expect(duplicate).toBe(false);
    expect(media).toMatchObject({ alt: 'Зал', title: 'Подпись', originalName: 'фото.png', purpose: 'image', status: 'active', mime: 'image/png', width: 600 });
    expect(res.body).not.toContain(root);
    expect(media.url).toBe(`/media/${media.storageKey}`);
    for (const v of media.variants) expect(await store.exists(v.key)).toBe(true);
    const replay = await upload('admin', file, { alt: 'Зал', title: 'Подпись' }, key);
    expect(replay.headers['idempotent-replay']).toBe('true');
    expect(replay.json().media.id).toBe(media.id);
    const dup = await upload('director', file);
    expect(dup.statusCode).toBe(200);
    expect(dup.json()).toMatchObject({ duplicate: true, media: { id: media.id } });
    const m = multipart(file);
    const noKey = await app.inject({ method: 'POST', url: `${BASE}/content/media`, headers: { cookie: cookies.admin!, 'content-type': m.contentType }, payload: m.payload });
    expect(noKey.statusCode).toBe(400);
  });

  it('отказы приёма: SVG → 415, 11 МБ → 413 MEDIA_TOO_LARGE, не multipart → 400, без входа → 401', async () => {
    const svg = await upload('admin', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'));
    expect(svg.statusCode).toBe(415);
    expect(svg.json().error.code).toBe('MEDIA_TYPE_NOT_ALLOWED');
    const big = await upload('admin', Buffer.alloc(11 * 1024 * 1024, 1));
    expect(big.statusCode).toBe(413);
    expect(big.json().error.code).toBe('MEDIA_TOO_LARGE');
    const json = await send('admin', 'POST', '/content/media', { x: 1 });
    expect(json.statusCode).toBe(400);
    const anon = await app.inject({ method: 'GET', url: `${BASE}/content/media` });
    expect(anon.statusCode).toBe(401);
  });

  it('Администратор не архивирует и не удаляет; Директор архивирует; alt правит Администратор', async () => {
    const { media } = (await upload('owner', await png(2))).json();
    expect((await send('admin', 'POST', `/content/media/${media.id}/archive`)).statusCode).toBe(403);
    expect((await send('admin', 'DELETE', `/content/media/${media.id}`)).statusCode).toBe(403);
    expect((await send('director', 'DELETE', `/content/media/${media.id}`)).statusCode).toBe(403);
    const patched = await send('admin', 'PATCH', `/content/media/${media.id}`, { alt: 'Комната', rowVersion: media.rowVersion });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().alt).toBe('Комната');
    expect((await send('admin', 'PATCH', `/content/media/${media.id}`, { alt: 'x', rowVersion: media.rowVersion })).statusCode).toBe(409);
    expect((await send('director', 'POST', `/content/media/${media.id}/archive`)).json().status).toBe('archived');
    const list = await get('admin', '/content/media?archived=true');
    expect(list.json().items.map((x: { id: string }) => x.id)).toContain(media.id);
    expect((await get('admin', '/content/media')).json().items.map((x: { id: string }) => x.id)).not.toContain(media.id);
  });

  it('удаление: используемый → MEDIA_IN_USE, связи видны; свободный → файлы и строка исчезают; чужой id → 404', async () => {
    const { media } = (await upload('owner', await png(3))).json();
    const entity = randomUUID();
    await syncUsages(pool, 'publication', entity, false, [{ mediaId: media.id, field: 'cover' }]);
    const usages = await get('admin', `/content/media/${media.id}/usages`);
    expect(usages.json()).toEqual({ usages: [{ entityType: 'publication', entityId: entity, field: 'cover', live: false }], inVersions: false });
    const blocked = await send('owner', 'DELETE', `/content/media/${media.id}`);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe('MEDIA_IN_USE');
    await syncUsages(pool, 'publication', entity, false, []);
    const ok = await send('owner', 'DELETE', `/content/media/${media.id}`);
    expect(ok.statusCode).toBe(200);
    expect(await store.exists(media.storageKey)).toBe(false);
    expect((await get('owner', `/content/media/${media.id}`)).statusCode).toBe(404);
    expect((await send('owner', 'DELETE', `/content/media/${randomUUID()}`)).statusCode).toBe(404);
    const audit = await db.client.query(`SELECT 1 FROM journal.audit_events WHERE object_id = $1 AND action = 'media.deleted'`, [media.id]);
    expect(audit.rowCount).toBe(1);
  });

  it('depsFromConfig подключает медиатеку с квотой из MEDIA_QUOTA_GB', async () => {
    const cfg = loadConfig({ LOG_LEVEL: 'silent', DATABASE_URL: db.url, MEDIA_DIR: path.join(root, 'cfg'), MEDIA_QUOTA_GB: '0.000000001' });
    const { deps, close } = depsFromConfig(cfg);
    try {
      expect(deps.content?.mediaStore.root).toBe(path.join(root, 'cfg'));
      await expect(deps.content!.mediaStore.writeAtomic('a/b.webp', Buffer.alloc(100))).rejects.toMatchObject({ code: 'MEDIA_QUOTA_EXCEEDED' });
    } finally {
      await close();
    }
  });
});

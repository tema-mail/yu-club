// S4-38: API CRM публикаций №213–218 и токен №233 по HTTP. Администратор: черновик своего филиала – да, публикация – 403; Директор: сетевая – 403,
// охват с чужим филиалом – 404; allowedActions совпадает с проверкой сервера (матрица роль × охват × статус).
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import { verifyPreviewToken } from '../../apps/api/src/modules/content/preview.ts';
import { hashPassword, staffAuthConfig } from '../../apps/api/src/modules/staff/auth.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { clock, contentFixture, NOW, type ContentFixture } from '../helpers/content.ts';
import { createTestBranch } from '../helpers/network.ts';

const PASSWORD = 'Пароль-публикаций-проверка-1';
const BASE = '/api/crm/v1';
const SECRET = 's'.repeat(40);
let f: ContentFixture;
let app: FastifyInstance;
let mine: string;
let foreign: string;
let cover: string;
const cookies: Record<string, string> = {};
let n = 0;

async function login(key: string, role: string, branch?: string): Promise<void> {
  const r = await f.db.client.query<{ id: string }>(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', $1, $2, $3) RETURNING id`, [`${key}@yu.test`, role, await hashPassword(PASSWORD)]);
  if (branch) await f.db.client.query(`INSERT INTO app.staff_assignments (staff_id, scope_type, branch_id, valid_from, created_by) VALUES ($1, 'branch', $2, '2026-01-01', $1)`, [r.rows[0]!.id, branch]);
  const res = await app.inject({ method: 'POST', url: `${BASE}/auth/login`, payload: { email: `${key}@yu.test`, password: PASSWORD } });
  cookies[key] = String(res.headers['set-cookie']).split(';')[0]!;
}
const call = (who: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, key: string = randomUUID()) =>
  app.inject({ method, url: `${BASE}${url}`, headers: { cookie: cookies[who]!, ...(method === 'GET' ? {} : { 'idempotency-key': key }) }, ...(payload ? { payload } : {}) });

const draft = (scope: object, over: object = {}) => {
  n += 1;
  return { scope, title: `Новость ${n}`, lead: 'Подводка', body: 'Текст', slug: `n-${n}`, coverMediaId: cover, publishFrom: '2026-11-01T00:00:00Z', ...over };
};
const branchScope = (...ids: string[]) => ({ type: 'branch', branchIds: ids });
const create = async (who: string, d: object) => (await call(who, 'POST', '/content/publications', { type: 'news', draft: d })).json();
const live = async (d: object) => {
  const row = await create('owner', d);
  const res = await call('owner', 'POST', `/content/publications/${row.id}/publish`, { rowVersion: row.rowVersion });
  expect(res.statusCode).toBe(200);
  return res.json();
};

beforeAll(async () => {
  f = await contentFixture();
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), { staff: { pool: f.pool, auth: staffAuthConfig('t'.repeat(40)), clock }, content: { mediaStore: f.store, previewSecret: SECRET } });
  mine = (await createTestBranch(f.db.client)).id;
  foreign = (await createTestBranch(f.db.client)).id;
  cover = await f.image(51, 'Обложка');
  await f.db.client.query(`UPDATE app.staff SET status = 'archived' WHERE id = $1`, [f.staffId]); // единственный действующий Владелец – тот, что входит ниже
  await login('owner', 'owner');
  await login('director', 'director', mine);
  await login('admin', 'admin', mine);
});
afterAll(async () => {
  await app.close();
  await f.close();
});

describe('S4-38: права', () => {
  it('Администратор: черновик своего филиала – да; публикация – 403; сетевая и чужая – нет', async () => {
    const res = await call('admin', 'POST', '/content/publications', { type: 'news', draft: draft(branchScope(mine)) });
    expect(res.statusCode).toBe(201);
    const row = res.json();
    expect((await call('admin', 'POST', `/content/publications/${row.id}/publish`, { rowVersion: row.rowVersion })).statusCode).toBe(403);
    const saved = await call('admin', 'PUT', `/content/publications/${row.id}/draft`, { rowVersion: row.rowVersion, draft: { ...row.draft, title: 'Правка' } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().draft.title).toBe('Правка');
    expect((await call('admin', 'POST', '/content/publications', { type: 'news', draft: draft({ type: 'network' }) })).statusCode).toBe(403);
    expect((await call('admin', 'POST', '/content/publications', { type: 'news', draft: draft(branchScope(foreign)) })).statusCode).toBe(404);
  });

  it('Директор: своя – публикует; сетевая – 403; охват с чужим филиалом – 404; чужая не видна', async () => {
    const own = await create('director', draft(branchScope(mine)));
    const pub = await call('director', 'POST', `/content/publications/${own.id}/publish`, { rowVersion: own.rowVersion });
    expect(pub.statusCode).toBe(200);
    expect(pub.json()).toMatchObject({ status: 'published', versionNo: 1 });
    const net = await create('owner', draft({ type: 'network' }));
    expect((await call('director', 'POST', `/content/publications/${net.id}/publish`, { rowVersion: net.rowVersion })).statusCode).toBe(403);
    const two = await create('owner', draft(branchScope(mine, foreign)));
    expect((await call('director', 'POST', `/content/publications/${two.id}/publish`, { rowVersion: two.rowVersion })).statusCode).toBe(404);
    expect((await call('director', 'POST', '/content/publications', { type: 'news', draft: draft(branchScope(mine, foreign)) })).statusCode).toBe(404);
    const alien = await create('owner', draft(branchScope(foreign)));
    expect((await call('director', 'GET', `/content/publications/${alien.id}`)).statusCode).toBe(404);
    expect((await call('director', 'GET', `/content/publications/${alien.id}/versions`)).statusCode).toBe(404);
    expect((await call('director', 'GET', `/content/publications/${net.id}`)).statusCode).toBe(200); // сетевое смотреть можно
  });

  it('allowedActions совпадает с проверкой сервера: роль × охват × статус', async () => {
    const scopes: Array<[string, object]> = [['network', { type: 'network' }], ['mine', branchScope(mine)], ['two', branchScope(mine, foreign)]];
    for (const who of ['owner', 'director', 'admin']) {
      for (const [, scope] of scopes) {
        for (const state of ['draft', 'published'] as const) {
          const row = state === 'published' ? await live(draft(scope)) : await create('owner', draft(scope));
          const card = await call(who, 'GET', `/content/publications/${row.id}`);
          if (card.statusCode !== 200) continue;
          const allowed: string[] = card.json().allowedActions;
          const dto = card.json();
          // проверяем в обратной последовательности состояний, чтобы успех не менял условие следующей пробы: у каждой пробы своя строка
          const probe = async (action: string, url: string, body: object) => {
            const res = await call(who, url === 'PUT' ? 'PUT' : 'POST', `/content/publications/${row.id}/${action}`, body);
            const ok = res.statusCode < 400;
            expect(ok, `${who} ${JSON.stringify(scope)} ${state} ${action}: ответ ${res.statusCode}, allowed ${allowed.join(',')}`).toBe(allowed.includes(action === 'draft' ? 'edit' : action));
          };
          await probe('draft', 'PUT', { rowVersion: dto.rowVersion, draft: dto.draft });
          const fresh = (await call('owner', 'GET', `/content/publications/${row.id}`)).json();
          if (state === 'draft') await probe('publish', 'POST', { rowVersion: fresh.rowVersion });
          else await probe('unpublish', 'POST', { reason: 'проверка' });
        }
      }
    }
  });
});

describe('S4-38: команды и чтение', () => {
  it('версии, откат, снятие, архив через HTTP; идемпотентность; причина обязательна; статус-конфликт', async () => {
    const v1 = await live(draft({ type: 'network' }, { title: 'Первая' }));
    const saved = (await call('owner', 'PUT', `/content/publications/${v1.id}/draft`, { rowVersion: v1.rowVersion, draft: { ...v1.draft, title: 'Вторая' } })).json();
    const v2 = (await call('owner', 'POST', `/content/publications/${v1.id}/publish`, { rowVersion: saved.rowVersion, reason: 'обновили' })).json();
    expect(v2.versionNo).toBe(2);
    const versions = (await call('admin', 'GET', `/content/publications/${v1.id}/versions`)).json().items;
    expect(versions.map((x: { versionNo: number }) => x.versionNo)).toEqual([2, 1]);
    const key = randomUUID();
    const back = await call('owner', 'POST', `/content/publications/${v1.id}/rollback`, { versionId: versions[1].id, rowVersion: v2.rowVersion, reason: 'ошибка' }, key);
    expect(back.statusCode).toBe(200);
    expect(back.json()).toMatchObject({ versionNo: 3, draft: { title: 'Первая' } });
    const replay = await call('owner', 'POST', `/content/publications/${v1.id}/rollback`, { versionId: versions[1].id, rowVersion: v2.rowVersion, reason: 'ошибка' }, key);
    expect(replay.headers['idempotent-replay']).toBe('true');
    expect(replay.json().versionNo).toBe(3);
    expect((await call('owner', 'POST', `/content/publications/${v1.id}/archive`, { reason: 'x' })).statusCode).toBe(409);
    const off = await call('owner', 'POST', `/content/publications/${v1.id}/unpublish`, { reason: '' });
    expect(off.statusCode).toBe(422);
    expect(off.json().error.code).toBe('COMMENT_REQUIRED');
    expect((await call('owner', 'POST', `/content/publications/${v1.id}/unpublish`, { reason: 'снято' })).json().status).toBe('unpublished');
    expect((await call('owner', 'POST', `/content/publications/${v1.id}/archive`, { reason: 'убрано' })).json().status).toBe('archived');
    const card = (await call('owner', 'GET', `/content/publications/${v1.id}`)).json();
    expect(card.allowedActions).toEqual([]);
    expect(card.live.title).toBe('Первая');
  });

  it('ошибки схемы и полноты – понятными кодами; без ключа идемпотентности – 400; устаревшая версия – 409', async () => {
    expect((await call('owner', 'POST', '/content/publications', { type: 'news', draft: { title: 'без охвата' } })).json().error.code).toBe('CONTENT_INVALID');
    const row = await create('owner', { scope: { type: 'network' } });
    const incomplete = await call('owner', 'POST', `/content/publications/${row.id}/publish`, { rowVersion: row.rowVersion });
    expect(incomplete.statusCode).toBe(422);
    expect(incomplete.json().error.details.fields.length).toBeGreaterThan(3);
    const conflict = await call('owner', 'PUT', `/content/publications/${row.id}/draft`, { rowVersion: 99, draft: row.draft });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('VERSION_CONFLICT');
    const noKey = await app.inject({ method: 'PUT', url: `${BASE}/content/publications/${row.id}/draft`, headers: { cookie: cookies.owner! }, payload: { rowVersion: 1, draft: row.draft } });
    expect(noKey.statusCode).toBe(400);
  });

  it('список: зона, фильтры, поиск, курсор; чужих нет; allowedActions в строках', async () => {
    const marker = `Метка${randomUUID().slice(0, 8)}`;
    const a = await create('owner', draft(branchScope(foreign), { title: `${marker} чужая` }));
    const b = await create('owner', draft(branchScope(mine), { title: `${marker} своя` }));
    const c = await create('owner', draft({ type: 'network' }, { title: `${marker} сеть` }));
    const ids = async (who: string, q: string) => (await call(who, 'GET', `/content/publications?q=${encodeURIComponent(marker)}${q}`)).json().items.map((x: { id: string }) => x.id);
    expect((await ids('owner', '')).sort()).toEqual([a.id, b.id, c.id].sort());
    expect((await ids('admin', '')).sort()).toEqual([b.id, c.id].sort());
    expect(await ids('owner', `&branchId=${foreign}`)).toEqual([a.id]);
    expect(await ids('owner', '&status=published')).toEqual([]);
    const page = (await call('owner', 'GET', `/content/publications?q=${encodeURIComponent(marker)}&limit=1`)).json();
    expect(page.items).toHaveLength(1);
    expect(page.items[0].allowedActions).toContain('edit');
    const next = (await call('owner', 'GET', `/content/publications?q=${encodeURIComponent(marker)}&limit=1&cursor=${page.nextCursor}`)).json();
    expect(next.items[0].id).not.toBe(page.items[0].id);
    expect((await call('owner', 'GET', '/content/publications?cursor=x')).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `${BASE}/content/publications` })).statusCode).toBe(401);
  });
});

describe('S4-38: токен предпросмотра №233', () => {
  it('Администратор получает токен на своё; подпись верна; чужой филиал – 404; неизвестный тип – 404', async () => {
    const own = await create('admin', draft(branchScope(mine)));
    const res = await call('admin', 'POST', `/content/publication/${own.id}/preview-token`, { branchId: mine });
    expect(res.statusCode).toBe(201);
    const claims = verifyPreviewToken(SECRET, res.json().token, NOW);
    expect(claims).toMatchObject({ entityType: 'publication', entityId: own.id, draftRowVersion: own.rowVersion, branchId: mine });
    expect(res.json().previewPath).toBe(`/content/preview/${res.json().token}`);
    const alien = await create('owner', draft(branchScope(foreign)));
    expect((await call('admin', 'POST', `/content/publication/${alien.id}/preview-token`, {})).statusCode).toBe(404);
    expect((await call('admin', 'POST', `/content/publication/${own.id}/preview-token`, { branchId: foreign })).statusCode).toBe(404);
    expect((await call('admin', 'POST', `/content/spam/${own.id}/preview-token`, {})).statusCode).toBe(404);
    expect((await call('admin', 'POST', `/content/publication/${randomUUID()}/preview-token`, {})).statusCode).toBe(404);
  });

  it('без PREVIEW_SECRET токен не выдаётся', async () => {
    const plain = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), { staff: { pool: f.pool, auth: staffAuthConfig('t'.repeat(40)), clock }, content: { mediaStore: f.store } });
    const row = await create('owner', draft({ type: 'network' }));
    const res = await plain.inject({ method: 'POST', url: `${BASE}/content/publication/${row.id}/preview-token`, headers: { cookie: cookies.owner!, 'idempotency-key': randomUUID() }, payload: {} });
    expect(res.statusCode).toBe(404);
    await plain.close();
  });
});

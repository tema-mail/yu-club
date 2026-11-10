// S4-39: API CRM каталога и страниц №219–223, №228 по HTTP. Каталог – только Владелец; доступность – Директор своего филиала; юридические – только Владелец;
// страницы комнат и филиалов по зоне; блоки: создание, сохранение, порядок, публикация; изменения видны в публичном API только после publish.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import { hashPassword, staffAuthConfig } from '../../apps/api/src/modules/staff/auth.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { clock, contentFixture, type ContentFixture } from '../helpers/content.ts';
import { createTestBranch } from '../helpers/network.ts';

const PASSWORD = 'Пароль-каталога-проверка-1';
const BASE = '/api/crm/v1';
const PUB = '/api/public/v1/content';
let f: ContentFixture;
let app: FastifyInstance;
let mine: { id: string; cityId: string };
let foreign: { id: string; cityId: string };
let cover: string;
let roomMine: string;
let roomForeign: string;
const cookies: Record<string, string> = {};

async function login(key: string, role: string, branch?: string): Promise<void> {
  const r = await f.db.client.query<{ id: string }>(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', $1, $2, $3) RETURNING id`, [`${key}@yu.test`, role, await hashPassword(PASSWORD)]);
  if (branch) {
    await f.db.client.query(`INSERT INTO app.staff_assignments (staff_id, scope_type, branch_id, valid_from, created_by) VALUES ($1, 'branch', $2, '2026-01-01', $1)`, [r.rows[0]!.id, branch]);
  }
  const res = await app.inject({ method: 'POST', url: `${BASE}/auth/login`, payload: { email: `${key}@yu.test`, password: PASSWORD } });
  cookies[key] = String(res.headers['set-cookie']).split(';')[0]!;
}
const call = (who: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
  app.inject({ method, url: `${BASE}${url}`, headers: { cookie: cookies[who]!, ...(method === 'GET' ? {} : { 'idempotency-key': randomUUID() }) }, ...(payload ? { payload } : {}) });
const pub = (url: string) => app.inject({ method: 'GET', url: `${PUB}${url}` });
const room = async (branchId: string, slug: string) => (await f.db.client.query<{ id: string }>(`INSERT INTO app.rooms (branch_id, name, slug, is_published) VALUES ($1, 'Комната', $2, true) RETURNING id`, [branchId, slug])).rows[0]!.id;

beforeAll(async () => {
  f = await contentFixture();
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), { network: { pool: f.pool }, staff: { pool: f.pool, auth: staffAuthConfig('t'.repeat(40)), clock }, content: { mediaStore: f.store, previewSecret: 'p'.repeat(40) } });
  mine = await createTestBranch(f.db.client);
  foreign = await createTestBranch(f.db.client);
  cover = await f.image(61, 'Обложка');
  roomMine = await room(mine.id, 'r-mine');
  roomForeign = await room(foreign.id, 'r-foreign');
  await f.db.client.query(`UPDATE app.staff SET status = 'archived' WHERE id = $1`, [f.staffId]);
  await login('owner', 'owner');
  await login('director', 'director', mine.id);
  await login('admin', 'admin', mine.id);
});
afterAll(async () => {
  await app.close();
  await f.close();
});

describe('S4-39: игры', () => {
  it('каталог – только Владелец: Директор и Администратор видят, но не создают и не публикуют', async () => {
    const draft = { title: 'CS2', short: 'Шутер', coverMediaId: cover, full: 'Описание', slug: 'cs2' };
    for (const who of ['director', 'admin']) expect((await call(who, 'POST', '/content/games', { direction: 'pc', draft })).statusCode).toBe(403);
    const created = await call('owner', 'POST', '/content/games', { direction: 'pc', draft });
    expect(created.statusCode).toBe(201);
    const game = created.json();
    expect((await call('director', 'GET', `/content/games/${game.id}/draft`)).json().direction).toBe('pc');
    expect((await call('admin', 'GET', '/content/games?direction=pc')).json().items).toHaveLength(1);
    expect((await call('director', 'POST', `/content/games/${game.id}/publish`, { rowVersion: game.rowVersion })).statusCode).toBe(403);
    expect((await call('admin', 'PUT', `/content/games/${game.id}/draft`, { rowVersion: game.rowVersion, draft })).statusCode).toBe(403);
    expect((await pub('/games/pc/cs2')).statusCode).toBe(404);
    const live = await call('owner', 'POST', `/content/games/${game.id}/publish`, { rowVersion: game.rowVersion });
    expect(live.json().versionNo).toBe(1);
    expect((await pub('/games/pc/cs2')).json().title).toBe('CS2');
    expect((await call('admin', 'GET', `/content/games/${game.id}/versions`)).json().items).toHaveLength(1);
  });

  it('доступность: Директор своего филиала – да, чужого – 404; Администратор – 403; выдача по ?branch= меняется сразу', async () => {
    const game = (await call('owner', 'GET', '/content/games?direction=pc')).json().items[0];
    expect((await pub(`/games?branch=${mine.id}`)).json().items).toEqual([]);
    const ok = await call('director', 'PUT', `/content/games/${game.id}/branches/${mine.id}`, { available: true, note: 'зал 2' });
    expect(ok.statusCode).toBe(200);
    expect((await pub(`/games?branch=${mine.id}`)).json().items[0].note).toBe('зал 2');
    expect((await call('director', 'PUT', `/content/games/${game.id}/branches/${foreign.id}`, { available: true })).statusCode).toBe(404);
    expect((await call('admin', 'PUT', `/content/games/${game.id}/branches/${mine.id}`, { available: false })).statusCode).toBe(403);
    expect((await call('owner', 'GET', `/content/games/${game.id}/draft`)).json().branches).toEqual([{ branchId: mine.id, available: true, note: 'зал 2' }]);
  });
});

describe('S4-39: страницы', () => {
  it('юридические – только Владелец; ключ вне списка → PAGE_KEY_UNKNOWN; чтение пустого черновика ничего не создаёт', async () => {
    expect((await call('owner', 'GET', '/content/pages/landing/draft')).json().error.code).toBe('PAGE_KEY_UNKNOWN');
    const empty = await call('admin', 'GET', '/content/pages/privacy-policy/draft');
    expect(empty.json()).toMatchObject({ id: null, rowVersion: 1, key: 'privacy-policy' });
    expect((await f.db.client.query(`SELECT 1 FROM app.content_pages`)).rowCount).toBe(0);
    const draft = { title: 'Политика', body: 'Текст', documentVersion: 'privacy-policy-2026-11-05' };
    for (const who of ['director', 'admin']) expect((await call(who, 'PUT', '/content/pages/privacy-policy/draft', { rowVersion: 1, draft })).statusCode).toBe(403);
    const saved = await call('owner', 'PUT', '/content/pages/privacy-policy/draft', { rowVersion: 1, draft });
    expect(saved.statusCode).toBe(200);
    expect((await call('director', 'POST', '/content/pages/privacy-policy/publish', { rowVersion: saved.json().rowVersion })).statusCode).toBe(403);
    const live = await call('owner', 'POST', '/content/pages/privacy-policy/publish', { rowVersion: saved.json().rowVersion });
    expect(live.statusCode).toBe(200);
    expect((await pub('/legal-versions')).json().privacyPolicy).toBe('privacy-policy-2026-11-05');
    expect((await call('owner', 'GET', '/content/pages/privacy-policy/versions')).json().items).toHaveLength(1);
    expect((await call('owner', 'PUT', '/content/pages/landing/draft', { rowVersion: 1, draft })).json().error.code).toBe('PAGE_KEY_UNKNOWN');
    expect((await call('owner', 'PUT', `/content/pages/privacy-policy/draft?cityId=${mine.cityId}`, { rowVersion: 1, draft })).json().error.code).toBe('CONTENT_INVALID');
  });

  it('подмена города: ?cityId= – своя строка; в публичном API только в этом городе', async () => {
    const saved = await call('owner', 'PUT', `/content/pages/about/draft?cityId=${mine.cityId}`, { rowVersion: 1, draft: { title: 'О городе', body: 'Текст города' } });
    expect(saved.statusCode).toBe(200);
    expect((await call('owner', 'GET', '/content/pages/about/draft')).json().id).toBeNull();
    await call('owner', 'POST', `/content/pages/about/publish?cityId=${mine.cityId}`, { rowVersion: saved.json().rowVersion });
    expect((await pub(`/pages/about?city=${mine.cityId}`)).json().title).toBe('О городе');
    expect((await pub('/pages/about')).statusCode).toBe(404);
  });

  it('комната: своя – Администратор пишет, Директор публикует; чужая – 404; несуществующая – 404', async () => {
    const draft = { description: 'VR-комната' };
    expect((await call('admin', 'GET', `/content/rooms/${roomForeign}/draft`)).statusCode).toBe(404);
    expect((await call('admin', 'PUT', `/content/rooms/${roomForeign}/draft`, { rowVersion: 1, draft })).statusCode).toBe(404);
    expect((await call('admin', 'PUT', `/content/rooms/${randomUUID()}/draft`, { rowVersion: 1, draft })).statusCode).toBe(404);
    expect((await call('admin', 'GET', `/content/rooms/${roomMine}/draft`)).json().id).toBeNull();
    const saved = await call('admin', 'PUT', `/content/rooms/${roomMine}/draft`, { rowVersion: 1, draft });
    expect(saved.statusCode).toBe(200);
    const rv = saved.json().rowVersion;
    expect((await call('admin', 'POST', `/content/rooms/${roomMine}/publish`, { rowVersion: rv })).statusCode).toBe(403);
    expect((await call('director', 'POST', `/content/rooms/${roomMine}/publish`, { rowVersion: rv })).statusCode).toBe(200);
    expect((await pub(`/rooms/${roomMine}`)).json().description).toBe('VR-комната');
    expect((await call('director', 'POST', `/content/rooms/${roomMine}/unpublish`, { reason: 'ремонт' })).statusCode).toBe(200);
    expect((await pub(`/rooms/${roomMine}`)).statusCode).toBe(404);
    expect((await call('director', 'GET', `/content/rooms/${roomMine}/versions`)).json().items).toHaveLength(1);
  });

  it('филиал: своя – да, чужой – 404, мусор – 404', async () => {
    const draft = { description: 'Клуб', geo: { lat: 55, lng: 82 } };
    expect((await call('director', 'PUT', `/content/branches/${foreign.id}/draft`, { rowVersion: 1, draft })).statusCode).toBe(404);
    expect((await call('director', 'GET', '/content/branches/мусор/draft')).statusCode).toBe(404);
    const saved = await call('admin', 'PUT', `/content/branches/${mine.id}/draft`, { rowVersion: 1, draft });
    expect(saved.statusCode).toBe(200);
    const live = await call('director', 'POST', `/content/branches/${mine.id}/publish`, { rowVersion: saved.json().rowVersion });
    expect(live.statusCode).toBe(200);
    expect((await pub(`/branches/${mine.id}`)).json().geo).toEqual({ lat: 55, lng: 82 });
  });
});

describe('S4-39: строки чужого города (K1: чужое – 404)', () => {
  it('черновик страницы и блока города вне зоны не читается и токен на него не выдаётся; сетевое и своя зона – да', async () => {
    const secret = `ЧЕРНОВИК-${randomUUID()}`;
    const page = await call('owner', 'PUT', `/content/pages/rules/draft?cityId=${foreign.cityId}`, { rowVersion: 1, draft: { title: secret, body: secret } });
    expect(page.statusCode).toBe(200);
    const block = await call('owner', 'PUT', '/content/home-blocks', { blockType: 'cta', cityId: foreign.cityId, draft: { blockType: 'cta', payload: { title: secret, label: 'x', url: '/schedule/' } } });
    expect(block.statusCode).toBe(201);
    for (const who of ['director', 'admin']) {
      for (const url of [`/content/pages/rules/draft?cityId=${foreign.cityId}`, `/content/pages/rules/versions?cityId=${foreign.cityId}`, `/content/home-blocks?cityId=${foreign.cityId}`, `/content/home-blocks/${block.json().id}/versions`, `/content/home-blocks/${block.json().id}/draft`]) {
        const res = await call(who, 'GET', url);
        expect(res.statusCode, `${who} ${url}`).toBe(404);
        expect(res.body).not.toContain(secret);
      }
      expect((await call(who, 'POST', `/content/home_block/${block.json().id}/preview-token`, {})).statusCode).toBe(404);
      expect((await call(who, 'POST', `/content/content_page/${page.json().id}/preview-token`, {})).statusCode).toBe(404);
      expect((await call(who, 'GET', '/content/pages/rules/draft')).statusCode).toBe(200);
      expect((await call(who, 'GET', '/content/home-blocks')).statusCode).toBe(200);
    }
    expect((await call('owner', 'GET', `/content/home-blocks?cityId=${foreign.cityId}`)).json().items[0].draft.payload.title).toBe(secret);
    expect((await call('owner', 'POST', `/content/home_block/${block.json().id}/preview-token`, {})).statusCode).toBe(201);
  });
});

describe('S4-39: блоки главной', () => {
  it('создание, сохранение, порядок, публикация; Директор – только блок своего города; повтор без rowVersion → конфликт', async () => {
    const hero = { blockType: 'hero', draft: { blockType: 'hero', payload: { title: 'Клуб' } } };
    expect((await call('director', 'PUT', '/content/home-blocks', hero)).statusCode).toBe(403);
    const created = await call('owner', 'PUT', '/content/home-blocks', hero);
    expect(created.statusCode).toBe(201);
    const row = created.json();
    expect((await call('owner', 'PUT', '/content/home-blocks', hero)).statusCode).toBe(409);
    const saved = await call('owner', 'PUT', '/content/home-blocks', { ...hero, rowVersion: row.rowVersion, draft: { blockType: 'hero', payload: { title: 'Клуб 2' } } });
    expect(saved.statusCode).toBe(200);
    expect((await pub('/home')).json().blocks).toEqual([]);
    expect((await call('owner', 'POST', `/content/home-blocks/${row.id}/publish`, { rowVersion: saved.json().rowVersion })).statusCode).toBe(200);
    expect((await pub('/home')).json().blocks[0].payload.title).toBe('Клуб 2');
    const about = (await call('owner', 'PUT', '/content/home-blocks', { blockType: 'about', draft: { blockType: 'about', payload: { body: 'О нас' } } })).json();
    await call('owner', 'POST', `/content/home-blocks/${about.id}/publish`, { rowVersion: about.rowVersion });
    expect((await call('owner', 'PUT', '/content/home-blocks/order', { ids: [about.id, row.id] })).statusCode).toBe(200);
    expect((await pub('/home')).json().blocks.map((b: { blockType: string }) => b.blockType)).toEqual(['about', 'hero']);
    expect((await call('admin', 'GET', '/content/home-blocks')).json().items.map((b: { blockType: string; sortOrder: number }) => [b.blockType, b.sortOrder])).toEqual([['about', 0], ['hero', 1]]);
    expect((await call('owner', 'GET', `/content/home-blocks/${row.id}/versions`)).json().items).toHaveLength(1);
    // один блок (№228, для истории версий и отката в CRM): draftDto с типом и уровнем; чужой id – 404
    const one = await call('admin', 'GET', `/content/home-blocks/${row.id}/draft`);
    expect(one.statusCode).toBe(200);
    expect(one.json()).toMatchObject({ id: row.id, blockType: 'hero', cityId: null, sortOrder: 1, status: 'published', draft: { payload: { title: 'Клуб 2' } } });
    expect(one.json().rowVersion).toBeGreaterThan(saved.json().rowVersion);
    expect((await call('owner', 'GET', `/content/home-blocks/${randomUUID()}/draft`)).statusCode).toBe(404);
  });
});

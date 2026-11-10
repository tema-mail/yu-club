// S4-37: публичный API контента №207–215 по HTTP. Уникальная строка из черновика не встречается ни в одном ответе; DTO без авторов и draft;
// игры с ?branch= – только доступные; ETag и max-age=60, повтор с If-None-Match → 304; новая публикация меняет ETag.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import { blockDef, ensureBlock } from '../../apps/api/src/modules/content/blocks.ts';
import { gameDef, setGameBranch } from '../../apps/api/src/modules/content/games.ts';
import { branchPageDef, ensureBranchPage, ensurePage, ensureRoomPage, pageDef, roomPageDef } from '../../apps/api/src/modules/content/pages.ts';
import { publicationDef } from '../../apps/api/src/modules/content/publications.ts';
import { createEntity, publish, saveDraft, type EntityDef, type EntityRow } from '../../apps/api/src/modules/content/versions.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { clock, contentFixture, type ContentFixture } from '../helpers/content.ts';
import { createTestBranch } from '../helpers/network.ts';

const BASE = '/api/public/v1/content';
const SECRET = `ЧЕРНОВИК-${randomUUID()}`;
const AUTHOR = 'Секретнейший Автор';
let f: ContentFixture;
let app: FastifyInstance;
let cover: string;
let branch: { id: string; cityId: string };
let otherBranch: string;
let roomId: string;

const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url: `${BASE}${url}`, headers });
async function livePlus<D extends Record<string, unknown>>(def: EntityDef<D>, row: EntityRow, draft: unknown): Promise<EntityRow> {
  const c = f.owner();
  const saved = await f.inTx((tx) => saveDraft(tx, c, def, row.id, { rowVersion: row.row_version, draft }, f.meta(c), clock));
  const { row: live } = await f.inTx((tx) => publish(tx, c, def, saved.id, { rowVersion: saved.row_version }, f.meta(c), clock));
  return live;
}
/** Записать в черновик живой сущности секрет: теперь снимок и черновик расходятся. */
async function poison<D extends Record<string, unknown>>(def: EntityDef<D>, row: EntityRow, draft: unknown): Promise<void> {
  const c = f.owner();
  await f.inTx((tx) => saveDraft(tx, c, def, row.id, { rowVersion: row.row_version, draft }, f.meta(c), clock));
}

beforeAll(async () => {
  f = await contentFixture();
  await f.db.client.query(`UPDATE app.staff SET first_name = 'Секретнейший', last_name = 'Автор' WHERE id = $1`, [f.staffId]);
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), { network: { pool: f.pool } });
  cover = await f.image(41, 'Обложка');
  branch = await createTestBranch(f.db.client);
  otherBranch = (await createTestBranch(f.db.client)).id;
  roomId = (await f.db.client.query<{ id: string }>(`INSERT INTO app.rooms (branch_id, name, slug, is_published) VALUES ($1, 'Комната', 'vr-room', true) RETURNING id`, [branch.id])).rows[0]!.id;
  const c = f.owner();
  const base = { title: 'Живой заголовок', lead: 'Живая подводка', body: 'Живой текст', coverMediaId: cover, publishFrom: '2026-11-01T00:00:00Z' };
  const news = await f.inTx((tx) => createEntity(tx, c, publicationDef, { type: 'news' }, { scope: { type: 'network' }, ...base, slug: 'first-news' }, f.meta(c), clock));
  const newsLive = await livePlus(publicationDef, news, news.draft);
  await poison(publicationDef, newsLive, { scope: { type: 'network' }, ...base, slug: 'first-news', title: SECRET, body: SECRET, lead: SECRET });
  const promo = await f.inTx((tx) => createEntity(tx, c, publicationDef, { type: 'promotion' }, { scope: { type: 'branch', branchIds: [branch.id] }, ...base, slug: 'promo-here', publishTo: '2027-01-01T00:00:00Z', conditions: 'условия' }, f.meta(c), clock));
  await livePlus(publicationDef, promo, promo.draft);
  const onlyDraft = { scope: { type: 'network' }, ...base, slug: 'only-draft', title: SECRET };
  await f.inTx((tx) => createEntity(tx, c, publicationDef, { type: 'news' }, onlyDraft, f.meta(c), clock));

  const gameDraft = { title: 'Игра', short: 'Коротко', coverMediaId: cover, full: 'Полное описание', slug: 'cs2' };
  const game = await f.inTx((tx) => createEntity(tx, c, gameDef, { direction: 'pc' }, gameDraft, f.meta(c), clock));
  const gameLive = await livePlus(gameDef, game, gameDraft);
  await setGameBranch(f.pool, c, game.id, branch.id, { available: true }, f.meta(c), clock);
  await poison(gameDef, gameLive, { ...gameDraft, title: SECRET, full: SECRET });

  const page = await f.inTx((tx) => ensurePage(tx, c, 'about', null, f.meta(c), clock));
  const pageLive = await livePlus(pageDef, page, { title: 'О клубе', body: 'Текст о клубе' });
  await poison(pageDef, pageLive, { title: SECRET, body: SECRET });
  const legal = await f.inTx((tx) => ensurePage(tx, c, 'advertising-consent', null, f.meta(c), clock));
  await livePlus(pageDef, legal, { title: 'Согласие', body: 'Текст', documentVersion: 'advertising-consent-2026-11-01' });

  const rp = await f.inTx((tx) => ensureRoomPage(tx, c, roomId, f.meta(c), clock));
  const rpLive = await livePlus(roomPageDef, rp, { description: 'Комната живая' });
  await poison(roomPageDef, rpLive, { description: SECRET });
  const bp = await f.inTx((tx) => ensureBranchPage(tx, c, branch.id, f.meta(c), clock));
  const bpLive = await livePlus(branchPageDef, bp, { description: 'Филиал живой' });
  await poison(branchPageDef, bpLive, { description: SECRET });
  const { row: blockRow } = await f.inTx((tx) => ensureBlock(tx, c, { blockType: 'hero', cityId: null, draft: { blockType: 'hero', payload: { title: 'Герой' } } }, f.meta(c), clock));
  const blockLive = await livePlus(blockDef, blockRow, blockRow.draft);
  await poison(blockDef, blockLive, { blockType: 'hero', payload: { title: SECRET } });
});
afterAll(async () => {
  await app.close();
  await f.close();
});

const routes = () => [
  '/home',
  `/home?city=${branch.cityId}`,
  '/publications',
  '/publications?type=news',
  `/publications?branch=${branch.id}`,
  '/publications/news/first-news',
  '/games',
  `/games?branch=${branch.id}`,
  '/games/pc/cs2',
  '/pages/about',
  `/rooms/${roomId}`,
  `/branches/${branch.id}`,
  '/legal-versions',
];

describe('S4-37: черновик не виден посетителю', () => {
  it('ни один маршрут №207–215 не содержит строки черновика, автора и служебных полей; все отвечают 200 с живыми данными', async () => {
    for (const url of routes()) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(200);
      expect(res.body, url).not.toContain(SECRET);
      expect(res.body, url).not.toContain(AUTHOR);
      expect(res.body, url).not.toMatch(/"draft"|createdBy|created_by|publishedBy|published_by|draftUpdated|rowVersion|liveVersionId/);
    }
    expect((await get('/publications/news/first-news')).json()).toMatchObject({ title: 'Живой заголовок', body: 'Живой текст', state: 'active', indexable: true, appliesHere: null });
    expect((await get('/games/pc/cs2')).json()).toMatchObject({ title: 'Игра', full: 'Полное описание' });
    expect((await get('/pages/about')).json()).toMatchObject({ title: 'О клубе', body: 'Текст о клубе' });
    expect((await get(`/rooms/${roomId}`)).json().description).toBe('Комната живая');
    expect((await get(`/branches/${branch.id}`)).json().description).toBe('Филиал живой');
    expect((await get('/legal-versions')).json()).toEqual({ privacyPolicy: null, personalDataConsent: null, cookiePolicy: null, advertisingConsent: 'advertising-consent-2026-11-01' });
    const home = (await get('/home')).json();
    expect(home.seo).toEqual({ title: null, description: null, h1: null, ogImage: null }); // №207: seo баннера для мета главной
    expect(home.blocks[0]).toMatchObject({ blockType: 'hero', payload: { title: 'Герой' } });
    expect(home.news.map((n: { slug: string }) => n.slug)).toEqual(['first-news']);
    expect(home.promos.map((n: { slug: string }) => n.slug)).toEqual(['promo-here']);
    expect(home.games[0].title).toBe('Игра');
    expect(home.news[0].cover).toMatchObject({ alt: 'Обложка', removed: false });
    expect(home.news[0].cover.url).toMatch(/^\/media\/.+\.webp$/);
  });

  it('только черновик по адресу → 404; не опубликованный ключ → 404; неизвестный ключ → PAGE_KEY_UNKNOWN', async () => {
    expect((await get('/publications/news/only-draft')).statusCode).toBe(404);
    expect((await get('/pages/rules')).statusCode).toBe(404);
    const unknown = await get('/pages/landing');
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe('PAGE_KEY_UNKNOWN');
    expect((await get('/games/pc/none')).statusCode).toBe(404);
    expect((await get(`/rooms/${randomUUID()}`)).statusCode).toBe(404);
    expect((await get('/rooms/мусор')).statusCode).toBe(404);
  });
});

describe('S4-37: поведение', () => {
  it('игры с ?branch= – только доступные; без branch – пометка общего каталога', async () => {
    const here = (await get(`/games?branch=${branch.id}`)).json();
    expect(here.networkCatalog).toBe(false);
    expect(here.items.map((g: { slug: string }) => g.slug)).toEqual(['cs2']);
    expect((await get(`/games?branch=${otherBranch}`)).json().items).toEqual([]);
    expect((await get('/games')).json().networkCatalog).toBe(true);
    expect((await get('/games?direction=vr')).json().items).toEqual([]);
  });

  it('охват: публикация филиала видна в нём и не видна в другом; appliesHere на странице', async () => {
    const slugs = async (q: string) => (await get(`/publications?${q}`)).json().items.map((i: { slug: string }) => i.slug);
    expect(await slugs(`branch=${branch.id}`)).toEqual(expect.arrayContaining(['first-news', 'promo-here']));
    expect(await slugs(`branch=${otherBranch}`)).toEqual(['first-news']);
    expect((await get(`/publications/promotion/promo-here?branch=${branch.id}`)).json().appliesHere).toBe(true);
    expect((await get(`/publications/promotion/promo-here?branch=${otherBranch}`)).json().appliesHere).toBe(false);
    expect((await get(`/publications/news/first-news?branch=${otherBranch}`)).json().appliesHere).toBe(true);
  });

  it('ETag и max-age=60; If-None-Match → 304; новая публикация меняет ETag; сохранение черновика – нет', async () => {
    const first = await get('/pages/about');
    expect(first.headers['cache-control']).toBe('public, max-age=60');
    const etag = String(first.headers.etag);
    expect(etag).toMatch(/^".+"$/);
    const again = await get('/pages/about', { 'if-none-match': etag });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe('');
    const row = (await f.db.client.query<EntityRow>(`SELECT * FROM app.content_pages WHERE key = 'about' AND city_id IS NULL`)).rows[0]!;
    const c = f.owner();
    const saved = await f.inTx((tx) => saveDraft(tx, c, pageDef, row.id, { rowVersion: row.row_version, draft: { title: 'О клубе 2', body: 'Новый текст' } }, f.meta(c), clock));
    expect((await get('/pages/about')).headers.etag).toBe(etag);
    await f.inTx((tx) => publish(tx, c, pageDef, saved.id, { rowVersion: saved.row_version }, f.meta(c), clock));
    const changed = await get('/pages/about', { 'if-none-match': etag });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().title).toBe('О клубе 2');
    expect(changed.headers.etag).not.toBe(etag);
  });

  it('неверные параметры → 400; список – курсор и предел', async () => {
    expect((await get('/publications?type=spam')).statusCode).toBe(400);
    expect((await get('/publications?city=мусор')).statusCode).toBe(400);
    expect((await get('/publications?limit=999')).statusCode).toBe(400);
    expect((await get('/publications/spam/x')).statusCode).toBe(400);
    const p1 = (await get('/publications?limit=1')).json();
    expect(p1.items).toHaveLength(1);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = (await get(`/publications?limit=1&cursor=${p1.nextCursor}`)).json();
    expect(p2.items[0].id).not.toBe(p1.items[0].id);
  });
});

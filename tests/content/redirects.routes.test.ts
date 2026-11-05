// S4-53: K5 №216 и №217 по HTTP. Старый адрес → 200 { location }, текущий и несуществующий → 404, мусор → 400, кэш 60 с;
// карта: только опубликованное и индексируемое – черновик, снятое, архив, indexable = false, завершённая и отложенная не попадают.
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import { gameDef } from '../../apps/api/src/modules/content/games.ts';
import { ensurePage, pageDef } from '../../apps/api/src/modules/content/pages.ts';
import { publicationDef } from '../../apps/api/src/modules/content/publications.ts';
import { archive, createEntity, publish, saveDraft, unpublish, type EntityDef, type EntityRow } from '../../apps/api/src/modules/content/versions.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { clock, contentFixture, type ContentFixture } from '../helpers/content.ts';

const BASE = '/api/public/v1';
let f: ContentFixture;
let app: FastifyInstance;
let cover: string;
const get = (url: string) => app.inject({ method: 'GET', url: `${BASE}${url}` });
const resolve = (p: string) => get(`/redirects/resolve?path=${encodeURIComponent(p)}`);
const news = (slug: string, over: Record<string, unknown> = {}) => ({ scope: { type: 'network' }, title: 'Заголовок', lead: 'Подводка', body: 'Текст', slug, coverMediaId: cover, publishFrom: '2026-11-01T00:00:00Z', ...over });

async function live<D extends Record<string, unknown>>(def: EntityDef<D>, row: EntityRow): Promise<EntityRow> {
  const c = f.owner();
  return (await f.inTx((tx) => publish(tx, c, def, row.id, { rowVersion: row.row_version }, f.meta(c), clock))).row;
}
async function make<D extends Record<string, unknown>>(def: EntityDef<D>, parent: Record<string, unknown>, draft: unknown): Promise<EntityRow> {
  const c = f.owner();
  return f.inTx((tx) => createEntity(tx, c, def, parent, draft, f.meta(c), clock));
}

beforeAll(async () => {
  f = await contentFixture();
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), { network: { pool: f.pool } });
  cover = await f.image(81, 'Обложка');
});
afterAll(async () => {
  await app.close();
  await f.close();
});

describe('№216 /redirects/resolve', () => {
  it('старый адрес → location и кэш 60 с; цель не редиректит дальше; несуществующее → 404; мусор → 400', async () => {
    const row = await live(publicationDef, await make(publicationDef, { type: 'news' }, news('was-a')));
    const c = f.owner();
    const saved = await f.inTx((tx) => saveDraft(tx, c, publicationDef, row.id, { rowVersion: row.row_version, draft: news('now-b') }, f.meta(c), clock));
    await live(publicationDef, saved);
    const hit = await resolve('/news/was-a/');
    expect(hit.statusCode).toBe(200);
    expect(hit.json()).toEqual({ location: '/news/now-b/' });
    expect(hit.headers['cache-control']).toBe('public, max-age=60');
    const target = await resolve('/news/now-b/');
    expect(target.statusCode).toBe(404);
    expect(target.headers['cache-control']).toBe('public, max-age=60');
    expect(target.json().error.code).toBe('NOT_FOUND');
    expect((await resolve('/nope/')).statusCode).toBe(404);
    for (const bad of ['', 'news', '//evil.ru/', '/\\evil.ru', '/news/a?x=1', `/${'a'.repeat(300)}`]) expect((await resolve(bad)).statusCode, bad).toBe(400);
    expect((await get('/redirects/resolve')).statusCode).toBe(400);
  });
});

describe('№217 /seo/sitemap-entries', () => {
  it('только опубликованное и индексируемое, lastmod – дата живой версии', async () => {
    const c = f.owner();
    await live(publicationDef, await make(publicationDef, { type: 'promotion' }, news('live-promo', { publishTo: '2099-12-31T00:00:00Z', conditions: 'Условия' })));
    await make(publicationDef, { type: 'news' }, news('only-draft'));
    await live(publicationDef, await make(publicationDef, { type: 'news' }, news('no-index', { indexable: false })));
    await live(publicationDef, await make(publicationDef, { type: 'promotion' }, news('ended-promo', { publishFrom: '2026-01-01T00:00:00Z', publishTo: '2026-02-01T00:00:00Z', conditions: 'Условия' })));
    await live(publicationDef, await make(publicationDef, { type: 'news' }, news('future', { publishFrom: '2099-01-01T00:00:00Z' })));
    const off = await live(publicationDef, await make(publicationDef, { type: 'news' }, news('taken-off')));
    const unpub = await f.inTx((tx) => unpublish(tx, c, publicationDef, off.id, { reason: 'снято' }, f.meta(c), clock));
    const old = await live(publicationDef, await make(publicationDef, { type: 'news' }, news('in-archive')));
    const oldOff = await f.inTx((tx) => unpublish(tx, c, publicationDef, old.id, { reason: 'снято' }, f.meta(c), clock));
    await f.inTx((tx) => archive(tx, c, publicationDef, oldOff.id, { reason: 'архив' }, f.meta(c), clock));
    expect(unpub.status).toBe('unpublished');

    await live(gameDef, await make(gameDef, { direction: 'vr' }, { title: 'Игра', short: 'К', coverMediaId: cover, full: 'Описание', slug: 'alyx' }));
    await live(gameDef, await make(gameDef, { direction: 'vr' }, { title: 'Плитка', short: 'К', coverMediaId: cover }));
    const page = async (key: string, draft: unknown) => {
      const row = await f.inTx((tx) => ensurePage(tx, c, key, null, f.meta(c), clock));
      await live(pageDef, await f.inTx((tx) => saveDraft(tx, c, pageDef, row.id, { rowVersion: row.row_version, draft }, f.meta(c), clock)));
    };
    await page('about', { title: 'О клубе', body: 'Текст' });
    await page('privacy-policy', { title: 'Политика', body: 'Текст', documentVersion: 'privacy-policy-2026-11-01' });

    const res = await get('/seo/sitemap-entries');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=60');
    const items = res.json().items as Array<{ path: string; lastmod: string | null }>;
    const paths = items.map((i) => i.path);
    for (const p of ['/promotions/live-promo/', '/games/vr/alyx/', '/about/', '/news/now-b/']) expect(paths, p).toContain(p);
    for (const p of ['/news/only-draft/', '/news/no-index/', '/promotions/ended-promo/', '/news/future/', '/news/taken-off/', '/news/in-archive/', '/news/was-a/', '/privacy-policy/']) expect(paths, p).not.toContain(p);
    expect(items.every((i) => typeof i.lastmod === 'string' && !Number.isNaN(Date.parse(i.lastmod)))).toBe(true);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths.filter((p) => p.includes('undefined') || p.includes('null'))).toEqual([]);
  });
});

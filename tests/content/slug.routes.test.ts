// S4-58: K11 №236–238 по HTTP с настоящим входом. Подсказка транслита по ГОСТ 7.79 с правками Яндекса; занятый → suggestion; история видна;
// зарезервированное, неверное, предупреждение истории; без сессии – 401, администратору (content.view есть у всех трёх ролей) – 200; значения вне списка – 400.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import { publicationDef } from '../../apps/api/src/modules/content/publications.ts';
import { createEntity, publish, saveDraft } from '../../apps/api/src/modules/content/versions.ts';
import { hashPassword, staffAuthConfig } from '../../apps/api/src/modules/staff/auth.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { clock, contentFixture, type ContentFixture } from '../helpers/content.ts';

const BASE = '/api/crm/v1';
const PASSWORD = 'Пароль-для-теста-1';
let f: ContentFixture;
let app: FastifyInstance;
const cookies: Record<string, string> = {};
let cover: string;
let newsId: string;

async function login(key: string, role: string) {
  await f.db.client.query(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', $1, $2, $3)`, [`${key}@yu.test`, role, await hashPassword(PASSWORD)]);
  const res = await app.inject({ method: 'POST', url: `${BASE}/auth/login`, payload: { email: `${key}@yu.test`, password: PASSWORD } });
  cookies[key] = String(res.headers['set-cookie']).split(';')[0]!;
}
const get = (url: string, who = 'owner') => app.inject({ method: 'GET', url: `${BASE}${url}`, headers: who ? { cookie: cookies[who]! } : {} });
const q = (o: Record<string, string>) => new URLSearchParams(o).toString();
const news = (slug: string) => ({ scope: { type: 'network' }, title: 'Заголовок', lead: 'Подводка', body: 'Текст', slug, coverMediaId: cover, publishFrom: '2026-11-01T00:00:00Z' });

beforeAll(async () => {
  f = await contentFixture();
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), { network: { pool: f.pool }, staff: { pool: f.pool, auth: staffAuthConfig('t'.repeat(40)), clock }, content: { mediaStore: f.store, previewSecret: 'p'.repeat(40) } });
  cover = await f.image(91, 'Обложка');
  await f.db.client.query(`UPDATE app.staff SET status = 'archived' WHERE id = $1`, [f.staffId]);
  await login('owner', 'owner');
  await login('admin', 'admin');
  const c = f.ctx('owner');
  const row = await f.inTx((tx) => createEntity(tx, c, publicationDef, { type: 'news' }, news('first-slug'), f.meta(c), clock));
  const live = (await f.inTx((tx) => publish(tx, c, publicationDef, row.id, { rowVersion: row.row_version }, f.meta(c), clock))).row;
  const edited = await f.inTx((tx) => saveDraft(tx, c, publicationDef, live.id, { rowVersion: live.row_version, draft: news('second-slug') }, f.meta(c), clock));
  await f.inTx((tx) => publish(tx, c, publicationDef, edited.id, { rowVersion: edited.row_version }, f.meta(c), clock));
  newsId = row.id;
});
afterAll(async () => {
  await app.close();
  await f.close();
});

describe('№236 подсказка', () => {
  it('транслит по таблице K23 §3, стоп-слова отброшены', async () => {
    const res = await get(`/content/slug-suggest?${q({ type: 'publication', title: 'Щедрый турнир в Новосибирске по CS2' })}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ slug: 'shchedryy-turnir-novosibirske-cs2' });
    expect((await get(`/content/slug-suggest?${q({ type: 'city', title: 'x' })}`)).statusCode).toBe(400);
    expect((await get(`/content/slug-suggest?${q({ type: 'game', title: '' })}`)).statusCode).toBe(400);
  });
});

describe('№237 проверка', () => {
  const check = async (o: Record<string, string>) => (await get(`/content/slug-check?${q(o)}`)).json();

  it('занятый → SLUG_TAKEN с подсказкой; своя запись не занята; свободный – ok', async () => {
    expect(await check({ entityType: 'publication', parent: 'news', slug: 'second-slug' })).toEqual({ ok: false, code: 'SLUG_TAKEN', suggestion: 'second-slug-2' });
    expect(await check({ entityType: 'publication', parent: 'news', slug: 'second-slug', excludeId: newsId })).toEqual({ ok: true });
    expect(await check({ entityType: 'publication', parent: 'promotion', slug: 'second-slug' })).toEqual({ ok: true });
    expect(await check({ entityType: 'publication', parent: 'news', slug: 'never-used' })).toEqual({ ok: true });
  });

  it('старый адрес – предупреждение SLUG_IN_HISTORY, не ошибка; своему объекту предупреждения нет', async () => {
    expect(await check({ entityType: 'publication', parent: 'news', slug: 'first-slug' })).toEqual({ ok: true, code: 'SLUG_IN_HISTORY' });
    expect(await check({ entityType: 'publication', parent: 'news', slug: 'first-slug', excludeId: newsId })).toEqual({ ok: true });
  });

  it('город news → SLUG_RESERVED; маска и длина → SLUG_INVALID; неизвестная сущность – 400', async () => {
    expect(await check({ entityType: 'city', slug: 'news' })).toEqual({ ok: false, code: 'SLUG_RESERVED' });
    expect(await check({ entityType: 'city', slug: 'A-b' })).toEqual({ ok: false, code: 'SLUG_INVALID' });
    expect(await check({ entityType: 'game', parent: 'pc', slug: 'a'.repeat(91) })).toEqual({ ok: false, code: 'SLUG_INVALID' });
    expect((await get(`/content/slug-check?${q({ entityType: 'staff', slug: 'x' })}`)).statusCode).toBe(400);
    expect((await get(`/content/slug-check?${q({ entityType: 'game', slug: 'x', excludeId: 'not-uuid' })}`)).statusCode).toBe(400);
  });
});

describe('№238 история', () => {
  it('старые адреса сущности видны с датой; у чужой – пусто; id проверяется', async () => {
    const res = await get(`/seo/history?${q({ entityType: 'publication', entityId: newsId })}`);
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<{ oldSlug: string; createdAt: string }>;
    expect(items.map((i) => i.oldSlug)).toEqual(['first-slug']);
    expect(Number.isNaN(Date.parse(items[0]!.createdAt))).toBe(false);
    expect((await get(`/seo/history?${q({ entityType: 'publication', entityId: randomUUID() })}`)).json()).toEqual({ items: [] });
    expect((await get(`/seo/history?${q({ entityType: 'publication', entityId: 'x' })}`)).statusCode).toBe(400);
  });
});

describe('права', () => {
  it('без сессии – 401, с сессией администратора – 200 на всех трёх', async () => {
    const urls = [`/content/slug-suggest?${q({ type: 'game', title: 'x' })}`, `/content/slug-check?${q({ entityType: 'game', slug: 'x' })}`, `/seo/history?${q({ entityType: 'game', entityId: randomUUID() })}`];
    for (const url of urls) {
      expect((await get(url, '')).statusCode, url).toBe(401);
      expect((await get(url, 'admin')).statusCode, url).toBe(200);
    }
  });
});

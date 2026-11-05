// S4-35: страницы (K22 §2, §5, §7). Ключ вне списка → PAGE_KEY_UNKNOWN; версия документа неизменна у опубликованной версии;
// юридические – только сеть и только Владелец; подмена города; комната чужого филиала → 404; снятая с сайта комната – нет страницы.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { branchPageDef, ensureBranchPage, ensurePage, ensureRoomPage, getBranchPage, getPage, getRoomPage, legalVersions, pageDef, roomPageDef } from '../../apps/api/src/modules/content/pages.ts';
import { listVersions, publish, rollback, saveDraft, type EntityDef, type EntityRow } from '../../apps/api/src/modules/content/versions.ts';
import { clock, contentFixture, fails, type ContentFixture } from '../helpers/content.ts';
import { createTestBranch, createTestCity } from '../helpers/network.ts';

let f: ContentFixture;
let cityId: string;
let branchA: string;
let branchB: string;

const ensure = (key: string, city: string | null = null, c = f.owner()) => f.inTx((tx) => ensurePage(tx, c, key, city, f.meta(c), clock));
async function fill<D extends Record<string, unknown>>(def: EntityDef<D>, row: EntityRow, draft: unknown, c = f.owner()): Promise<EntityRow> {
  return f.inTx((tx) => saveDraft(tx, c, def, row.id, { rowVersion: row.row_version, draft }, f.meta(c), clock));
}
async function pub<D extends Record<string, unknown>>(def: EntityDef<D>, row: EntityRow, c = f.owner()) {
  return f.inTx((tx) => publish(tx, c, def, row.id, { rowVersion: row.row_version }, f.meta(c), clock));
}
async function room(branchId: string, published = true): Promise<string> {
  const r = await f.db.client.query<{ id: string }>(`INSERT INTO app.rooms (branch_id, name, slug, is_published) VALUES ($1, 'Комната', $2, $3) RETURNING id`, [branchId, `r-${randomUUID().slice(0, 8)}`, published]);
  return r.rows[0]!.id;
}

beforeAll(async () => {
  f = await contentFixture();
  cityId = await createTestCity(f.db.client);
  branchA = (await createTestBranch(f.db.client, { cityId })).id;
  branchB = (await createTestBranch(f.db.client)).id;
});
afterAll(async () => {
  await f.close();
});

describe('S4-35: страницы по ключу', () => {
  it('ключ вне списка → PAGE_KEY_UNKNOWN и при записи, и при чтении; редактор страниц не плодит', async () => {
    await fails(ensure('landing-city-1'), 'PAGE_KEY_UNKNOWN');
    await fails(getPage(f.pool, { key: 'zzz' }), 'PAGE_KEY_UNKNOWN');
  });

  it('не опубликована → null; публикация → видна; подмена города опубликованной версией; снятая – снова сетевая', async () => {
    expect(await getPage(f.pool, { key: 'about' })).toBeNull();
    const net = await fill(pageDef, await ensure('about'), { title: 'О сети', body: 'Сетевой текст' });
    await fails(getPage(f.pool, { key: 'about-x' }), 'PAGE_KEY_UNKNOWN');
    await pub(pageDef, net);
    expect(await getPage(f.pool, { key: 'about' })).toMatchObject({ title: 'О сети', body: 'Сетевой текст' });
    const city = await fill(pageDef, await ensure('about', cityId), { title: 'О городе', body: 'Городской текст' });
    expect((await getPage(f.pool, { key: 'about', cityId }))?.title).toBe('О сети'); // черновик города не виден
    await pub(pageDef, city);
    expect((await getPage(f.pool, { key: 'about', cityId }))?.title).toBe('О городе');
    expect((await getPage(f.pool, { key: 'about' }))?.title).toBe('О сети');
    expect((await getPage(f.pool, { key: 'about', cityId: randomUUID() }))?.title).toBe('О сети');
  });

  it('полнота по полям; повторный ensure – та же строка; Директор и Администратор сетевое не правят', async () => {
    const row = await ensure('rules');
    expect((await ensure('rules')).id).toBe(row.id);
    const err = await fails(pub(pageDef, row), 'CONTENT_INCOMPLETE');
    expect(err.details?.fields).toEqual([{ field: 'title', code: 'REQUIRED' }, { field: 'body', code: 'REQUIRED' }]);
    await fails(ensure('rules', null, f.ctx('director', [branchA])), 'FORBIDDEN');
    await fails(fill(pageDef, row, { title: 'x' }, f.ctx('admin', [branchA])), 'FORBIDDEN');
  });
});

describe('S4-35: юридические', () => {
  it('только сеть; только Владелец; версия обязательна, формат и префикс ключа; живая версия отдаётся в legalVersions', async () => {
    await fails(ensure('privacy-policy', cityId), 'CONTENT_INVALID');
    await fails(ensure('privacy-policy', null, f.ctx('director', [branchA])), 'FORBIDDEN');
    expect((await legalVersions(f.pool)).privacyPolicy).toBeNull();
    const row = await ensure('privacy-policy');
    const noVer = await fill(pageDef, row, { title: 'Политика', body: 'Текст 1' });
    expect(((await fails(pub(pageDef, noVer), 'CONTENT_INCOMPLETE')).details?.fields as Array<{ code: string }>)[0]!.code).toBe('REQUIRED');
    const wrong = await fill(pageDef, noVer, { title: 'Политика', body: 'Текст 1', documentVersion: 'cookie-policy-2026-11-01' });
    expect(((await fails(pub(pageDef, wrong), 'CONTENT_INCOMPLETE')).details?.fields as Array<{ code: string }>)[0]!.code).toBe('FORMAT');
    const ok = await fill(pageDef, wrong, { title: 'Политика', body: 'Текст 1', documentVersion: 'privacy-policy-2026-11-01' });
    await pub(pageDef, ok);
    expect(await legalVersions(f.pool)).toEqual({ privacyPolicy: 'privacy-policy-2026-11-01', personalDataConsent: null, cookiePolicy: null, advertisingConsent: null });
    expect((await getPage(f.pool, { key: 'privacy-policy' }))?.documentVersion).toBe('privacy-policy-2026-11-01');
  });

  it('версия документа неизменна: тот же номер с другим текстом → отказ; новый номер – можно; откат восстанавливает номер; снимок v1 не меняется', async () => {
    const row = await fill(pageDef, await ensure('cookie-policy'), { title: 'Куки', body: 'Текст А', documentVersion: 'cookie-policy-2026-11-01' });
    const v1 = await pub(pageDef, row);
    const sameNo = await fill(pageDef, v1.row, { title: 'Куки', body: 'Текст Б', documentVersion: 'cookie-policy-2026-11-01' });
    const err = await fails(pub(pageDef, sameNo), 'CONTENT_INCOMPLETE');
    expect(err.details?.fields).toEqual([{ field: 'documentVersion', code: 'REUSED' }]);
    const newNo = await fill(pageDef, sameNo, { title: 'Куки', body: 'Текст Б', documentVersion: 'cookie-policy-2026-11-02' });
    const v2 = await pub(pageDef, newNo);
    expect((await getPage(f.pool, { key: 'cookie-policy' }))?.documentVersion).toBe('cookie-policy-2026-11-02');
    await f.inTx((tx) => rollback(tx, f.owner(), pageDef, row.id, { versionId: v1.version.id, rowVersion: v2.row.row_version, reason: 'ошибка' }, f.meta(f.owner()), clock));
    const back = await getPage(f.pool, { key: 'cookie-policy' });
    expect(back).toMatchObject({ documentVersion: 'cookie-policy-2026-11-01', body: 'Текст А' });
    const versions = await listVersions(f.pool, 'content_page', row.id);
    expect(versions.at(-1)?.snapshot.documentVersion).toBe('cookie-policy-2026-11-01');
    expect(versions.at(-1)?.snapshot.body).toBe('Текст А');
  });
});

describe('S4-35: страницы комнат и филиалов', () => {
  it('комната чужого филиала и несуществующая → одинаковый 404; своя – Администратор пишет черновик, публикует Директор', async () => {
    const roomA = await room(branchA);
    const roomB = await room(branchB);
    const admin = f.ctx('admin', [branchA]);
    await fails(f.inTx((tx) => ensureRoomPage(tx, admin, roomB, f.meta(admin), clock)), 'NOT_FOUND');
    await fails(f.inTx((tx) => ensureRoomPage(tx, admin, randomUUID(), f.meta(admin), clock)), 'NOT_FOUND');
    await fails(f.inTx((tx) => ensureRoomPage(tx, admin, 'мусор', f.meta(admin), clock)), 'NOT_FOUND');
    const row = await f.inTx((tx) => ensureRoomPage(tx, admin, roomA, f.meta(admin), clock));
    const image = await f.image(7, 'Комната');
    const saved = await fill(roomPageDef, row, { description: 'VR-комната', gallery: [image], features: ['PS5'], rentFormatsText: 'Почасово' }, admin);
    await fails(pub(roomPageDef, saved, admin), 'FORBIDDEN');
    await fails(pub(roomPageDef, saved, f.ctx('director', [branchB])), 'NOT_FOUND');
    await pub(roomPageDef, saved, f.ctx('director', [branchA]));
    const page = await getRoomPage(f.pool, roomA);
    expect(page).toMatchObject({ description: 'VR-комната', features: ['PS5'], rentFormatsText: 'Почасово' });
    expect(page?.gallery[0]).toMatchObject({ alt: 'Комната', removed: false });
    expect(page?.seo.ogImage).toMatch(/\.jpg$/);
    await f.db.client.query(`UPDATE app.rooms SET is_published = false WHERE id = $1`, [roomA]);
    expect(await getRoomPage(f.pool, roomA)).toBeNull(); // выключатель – у resources
  });

  it('галерея без alt → MEDIA_ALT_REQUIRED; пустое описание → полнота', async () => {
    const r = await f.inTx((tx) => ensureRoomPage(tx, f.owner(), undefined as never, f.meta(f.owner()), clock)).catch(() => null);
    expect(r).toBeNull();
    const roomId = await room(branchA);
    const row = await f.inTx((tx) => ensureRoomPage(tx, f.owner(), roomId, f.meta(f.owner()), clock));
    expect(((await fails(pub(roomPageDef, row), 'CONTENT_INCOMPLETE')).details?.fields as Array<{ field: string }>)[0]!.field).toBe('description');
    const noAlt = await f.image(8, null);
    const saved = await fill(roomPageDef, row, { description: 'Текст', gallery: [noAlt] });
    const err = await fails(pub(roomPageDef, saved), 'MEDIA_ALT_REQUIRED');
    expect(err.details?.fields).toEqual([{ field: 'gallery.0', mediaId: noAlt }]);
    await fails(fill(roomPageDef, saved, { description: 'x', gallery: Array.from({ length: 21 }, () => noAlt) }), 'CONTENT_INVALID');
  });

  it('филиал: структурированный адрес и координаты; неверный индекс → CONTENT_INVALID; архивный филиал – нет страницы; чужой – 404', async () => {
    const row = await f.inTx((tx) => ensureBranchPage(tx, f.owner(), branchA, f.meta(f.owner()), clock));
    await fails(fill(branchPageDef, row, { description: 'x', postal: { street: 'Ленина 1', locality: 'Новосибирск', region: 'НСО', postalCode: '12' } }), 'CONTENT_INVALID');
    const saved = await fill(branchPageDef, row, { description: 'Клуб', howToGet: 'От метро 5 минут', postal: { street: 'Ленина 1', locality: 'Новосибирск', region: 'НСО', postalCode: '630000' }, geo: { lat: 55.03, lng: 82.92 } });
    await pub(branchPageDef, saved);
    expect(await getBranchPage(f.pool, branchA)).toMatchObject({ description: 'Клуб', howToGet: 'От метро 5 минут', postal: { postalCode: '630000' }, geo: { lat: 55.03, lng: 82.92 } });
    expect(await getBranchPage(f.pool, branchB)).toBeNull();
    const c = f.ctx('director', [branchB]);
    await fails(f.inTx((tx) => ensureBranchPage(tx, c, branchA, f.meta(c), clock)), 'NOT_FOUND');
    await f.db.client.query(`UPDATE app.branches SET status = 'archived', archived_at = now() WHERE id = $1`, [branchA]);
    expect(await getBranchPage(f.pool, branchA)).toBeNull();
    await f.db.client.query(`UPDATE app.branches SET status = 'active', archived_at = NULL WHERE id = $1`, [branchA]);
  });

  it('описание форматов аренды – тоже Markdown: картинка в обход формы не проходит, из медиатеки попадает в снимок', async () => {
    const roomId = await room(branchA);
    const row = await f.inTx((tx) => ensureRoomPage(tx, f.owner(), roomId, f.meta(f.owner()), clock));
    const image = await f.image(9, 'Зал');
    await fails(fill(roomPageDef, row, { description: 'x', rentFormatsText: `![Иван][r]\n\n[r]: media:${image}` }), 'CONTENT_INVALID');
    const saved = await fill(roomPageDef, row, { description: 'x', rentFormatsText: `![a](media:${image})` });
    const v = await pub(roomPageDef, saved);
    expect(v.version.snapshot.media?.[image]?.alt).toBe('Зал');
  });

  it('черновик не в выдаче', async () => {
    const secret = `ЧЕРНОВИК-${randomUUID()}`;
    const row = await f.inTx((tx) => ensureBranchPage(tx, f.owner(), branchA, f.meta(f.owner()), clock));
    await fill(branchPageDef, row, { description: secret });
    const page = await getBranchPage(f.pool, branchA);
    expect(JSON.stringify(page)).not.toContain(secret);
    expect(page?.description).toBe('Клуб');
  });
});

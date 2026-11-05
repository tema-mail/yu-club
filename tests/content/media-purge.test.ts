// S4-45: принудительная очистка по ГК ст. 152.1 (K22 §8). После очистки ни один вариант файла не отдаётся; журнал не правится, живая сущность – новая версия без фото;
// откат к старой версии показывает заглушку; Директор → 403; без основания – COMMENT_REQUIRED; аудит с основанием; файл заново не загрузить; настоящий HTTP.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import { blockDef, ensureBlock } from '../../apps/api/src/modules/content/blocks.ts';
import { getMediaRow, uploadMedia } from '../../apps/api/src/modules/content/media.ts';
import { stripMedia } from '../../apps/api/src/modules/content/media-purge.ts';
import { publicationDef, type PublicationDraft } from '../../apps/api/src/modules/content/publications.ts';
import { createEntity, listVersions, publish, rollback, saveDraft, type EntityRow } from '../../apps/api/src/modules/content/versions.ts';
import { hashPassword, staffAuthConfig } from '../../apps/api/src/modules/staff/auth.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { clock, contentFixture, fails, type ContentFixture } from '../helpers/content.ts';

const PASSWORD = 'Пароль-очистки-проверка-1';
const BASE = '/api/crm/v1';
const PUB = '/api/public/v1/content';
const BASIS = 'Заявление субъекта от 05.11.2026, вх. №12';
let f: ContentFixture;
let app: FastifyInstance;
const cookies: Record<string, string> = {};
let n = 0;

async function login(key: string, role: string): Promise<void> {
  const r = await f.db.client.query<{ id: string }>(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', $1, $2, $3) RETURNING id`, [`${key}@yu.test`, role, await hashPassword(PASSWORD)]);
  expect(r.rowCount).toBe(1);
  const res = await app.inject({ method: 'POST', url: `${BASE}/auth/login`, payload: { email: `${key}@yu.test`, password: PASSWORD } });
  cookies[key] = String(res.headers['set-cookie']).split(';')[0]!;
}
const purge = (who: string, id: string, payload: object = { reason: 'Требование субъекта', basis: BASIS }, key: string = randomUUID()) =>
  app.inject({ method: 'POST', url: `${BASE}/content/media/${id}/purge`, headers: { cookie: cookies[who]!, 'idempotency-key': key }, payload });
const pubGet = (url: string) => app.inject({ method: 'GET', url: `${PUB}${url}` });

async function liveNews(cover: string, body = 'Текст'): Promise<{ row: EntityRow; slug: string; versionId: string }> {
  n += 1;
  const c = f.owner();
  const slug = `purge-${n}`;
  const draft: PublicationDraft = { scope: { type: 'network' }, title: `Новость ${n}`, lead: 'Подводка', body, slug, coverMediaId: cover, publishFrom: '2026-11-01T00:00:00Z' };
  const created = await f.inTx((tx) => createEntity(tx, c, publicationDef, { type: 'news' }, draft, f.meta(c), clock));
  const { row, version } = await f.inTx((tx) => publish(tx, c, publicationDef, created.id, { rowVersion: created.row_version }, f.meta(c), clock));
  return { row, slug, versionId: version.id };
}

beforeAll(async () => {
  f = await contentFixture();
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), { network: { pool: f.pool }, staff: { pool: f.pool, auth: staffAuthConfig('t'.repeat(40)), clock }, content: { mediaStore: f.store } });
  await f.db.client.query(`UPDATE app.staff SET status = 'archived' WHERE id = $1`, [f.staffId]);
  await login('owner', 'owner');
  await login('director', 'director');
});
afterAll(async () => {
  await app.close();
  await f.close();
});

describe('S4-45: чистая замена', () => {
  it('поле, массив и картинка в тексте убираются; чужие остаются', () => {
    const id = 'aaaaaaaa-0000-4000-8000-000000000001';
    const other = 'bbbbbbbb-0000-4000-8000-000000000002';
    expect(stripMedia({ coverMediaId: id, ogMediaId: other, gallery: [id, other], body: `до ![лицо](media:${id}) после ![x](media:${other})`, payload: { items: [{ title: 'а', mediaId: id }] } }, id)).toEqual({
      ogMediaId: other,
      gallery: [other],
      body: `до  после ![x](media:${other})`,
      payload: { items: [{ title: 'а' }] },
    });
  });
});

describe('S4-45: очистка', () => {
  it('файлы всех вариантов удалены даже при использовании в версиях; живая – новая версия без фото; журнал не правлен; публичный API без адреса; аудит с основанием', async () => {
    const id = await f.image(91, 'Лицо Иванова');
    const row0 = (await getMediaRow(f.pool, id))!;
    const inText = await liveNews(id, `Абзац ![подпись](media:${id}) конец`);
    expect((await pubGet(`/publications/news/${inText.slug}`)).json().cover.url).toMatch(/^\/media\//);
    const res = await purge('owner', id);
    expect(res.statusCode).toBe(200);
    expect(res.json().purged).toBe(true);
    expect(res.json().affected).toEqual([{ entityType: 'publication', entityId: inText.row.id, versionNo: 2 }]);
    for (const v of row0.variants) expect(await f.store.exists(v.key)).toBe(false);
    expect(await f.store.exists(row0.storage_key)).toBe(false);

    const page = (await pubGet(`/publications/news/${inText.slug}`)).json();
    expect(page.cover).toBeNull();
    expect(page.body).not.toContain(id);
    expect(page.media).toEqual({});
    const raw = JSON.stringify(page);
    expect(raw).not.toContain(row0.sha256);
    expect(raw).not.toContain('Лицо Иванова');

    const versions = await listVersions(f.pool, 'publication', inText.row.id);
    expect(versions.map((v) => v.versionNo)).toEqual([2, 1]);
    expect(versions[1]!.snapshot.coverMediaId).toBe(id); // журнал только вставка: старый снимок не тронут
    expect(versions[0]!.reason).toContain('Очистка фото');

    const media = (await getMediaRow(f.pool, id))!;
    expect(media).toMatchObject({ status: 'purged', alt: null, title: null, original_name: null, variants: [] });
    const audit = await f.db.client.query<{ reason: string; after: { basis: string; affected: unknown[]; files: number } }>(`SELECT reason, after FROM journal.audit_events WHERE object_id = $1 AND action = 'media.purged'`, [id]);
    expect(audit.rows[0]).toMatchObject({ reason: 'Требование субъекта', after: { basis: BASIS, files: row0.variants.length } });
    expect(audit.rows[0]!.after.affected).toHaveLength(1);
    const left = await f.db.client.query(`SELECT 1 FROM app.content_media_usages WHERE media_id = $1`, [id]);
    expect(left.rowCount).toBe(0);
  });

  it('откат к старой версии показывает заглушку, а не файл; живые столбцы и снимок откатились', async () => {
    const id = await f.image(92, 'Фото');
    const news = await liveNews(id);
    await purge('owner', id);
    const fresh = (await f.db.client.query<EntityRow>(`SELECT * FROM app.content_publications WHERE id = $1`, [news.row.id])).rows[0]!;
    const c = f.owner();
    await f.inTx((tx) => rollback(tx, c, publicationDef, news.row.id, { versionId: news.versionId, rowVersion: fresh.row_version, reason: 'откат' }, f.meta(c), clock));
    const page = (await pubGet(`/publications/news/${news.slug}`)).json();
    expect(page.cover).toEqual({ removed: true, alt: 'изображение удалено', width: null, height: null, url: null, variants: [] });
    expect(JSON.stringify(page)).not.toContain('/media/');
    // повторно опубликовать заглушку нельзя: фото в черновике после отката – MEDIA_MISSING
    const row = (await f.db.client.query<EntityRow>(`SELECT * FROM app.content_publications WHERE id = $1`, [news.row.id])).rows[0]!;
    const err = await fails(f.inTx((tx) => publish(tx, c, publicationDef, row.id, { rowVersion: row.row_version }, f.meta(c), clock)), 'CONTENT_INCOMPLETE');
    expect(err.details?.fields).toEqual([{ field: 'cover', code: 'MEDIA_MISSING' }]);
  });

  it('снятая с сайта и черновик: новой версии нет, черновик очищен, row_version вырос; блок главной и его массивы тоже', async () => {
    const id = await f.image(93, 'Фото');
    const c = f.owner();
    const onlyDraft = await f.inTx((tx) => createEntity(tx, c, publicationDef, { type: 'news' }, { scope: { type: 'network' }, title: 'Черновик', coverMediaId: id }, f.meta(c), clock));
    const { row: blockRow } = await f.inTx((tx) => ensureBlock(tx, c, { blockType: 'advantages', cityId: null, draft: { blockType: 'advantages', payload: { items: [{ title: 'Быстро', mediaId: id }] } } }, f.meta(c), clock));
    const live = await f.inTx((tx) => publish(tx, c, blockDef, blockRow.id, { rowVersion: blockRow.row_version }, f.meta(c), clock));
    const res = await purge('owner', id);
    expect(res.json().affected).toEqual(expect.arrayContaining([
      { entityType: 'publication', entityId: onlyDraft.id, versionNo: null },
      { entityType: 'home_block', entityId: blockRow.id, versionNo: 2 },
    ]));
    const d = (await f.db.client.query<{ draft: PublicationDraft; row_version: number; cover_media_id: string | null }>(`SELECT draft, row_version, cover_media_id FROM app.content_publications WHERE id = $1`, [onlyDraft.id])).rows[0]!;
    expect(d.draft.coverMediaId).toBeUndefined();
    expect(d.row_version).toBe(onlyDraft.row_version + 1);
    expect((await pubGet('/home')).json().blocks[0].payload.items[0]).toEqual({ title: 'Быстро' });
    expect(live.row.status).toBe('published');
    // устаревшая вкладка редактора не вернёт ссылку: row_version вырос
    await fails(f.inTx((tx) => saveDraft(tx, c, publicationDef, onlyDraft.id, { rowVersion: onlyDraft.row_version, draft: onlyDraft.draft }, f.meta(c), clock)), 'VERSION_CONFLICT');
  });

  it('Директор → 403; без причины или основания → COMMENT_REQUIRED, файл цел; мусор и чужой id → 404; повтор – без изменений', async () => {
    const id = await f.image(94, 'Фото');
    const row = (await getMediaRow(f.pool, id))!;
    expect((await purge('director', id)).statusCode).toBe(403);
    for (const body of [{ reason: 'x' }, { basis: 'y' }, { reason: ' ', basis: 'y' }, {}]) {
      const res = await purge('owner', id, body);
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('COMMENT_REQUIRED');
    }
    expect(await f.store.exists(row.storage_key)).toBe(true);
    expect((await purge('owner', randomUUID())).statusCode).toBe(404);
    expect((await purge('owner', 'мусор')).statusCode).toBe(404);
    expect((await purge('owner', id)).json().affected).toEqual([]);
    expect(await f.store.exists(row.storage_key)).toBe(false);
    const again = await purge('owner', id);
    expect(again.statusCode).toBe(200);
    expect(again.json().affected).toEqual([]);
    const audit = await f.db.client.query(`SELECT 1 FROM journal.audit_events WHERE object_id = $1 AND action = 'media.purged'`, [id]);
    expect(audit.rowCount).toBe(1);
  });

  it('подпись в тексте не возвращается после отката; поле условий тоже чистится; живой снимок без id и подписи', async () => {
    const id = await f.image(97, 'Фото');
    const c = f.owner();
    const cover = await f.image(98, 'Обложка');
    const news = await liveNews(cover, `Абзац ![Иван Иванов](media:${id}) конец`);
    await purge('owner', id);
    const after = (await pubGet(`/publications/news/${news.slug}`)).json();
    expect(JSON.stringify(after)).not.toContain('Иван Иванов');
    expect(JSON.stringify(after)).not.toContain(id);
    const fresh = (await f.db.client.query<EntityRow>(`SELECT * FROM app.content_publications WHERE id = $1`, [news.row.id])).rows[0]!;
    await f.inTx((tx) => rollback(tx, c, publicationDef, news.row.id, { versionId: news.versionId, rowVersion: fresh.row_version, reason: 'откат' }, f.meta(c), clock));
    const back = await pubGet(`/publications/news/${news.slug}`);
    expect(back.body).not.toContain('Иван Иванов');
    expect(back.json().body).toBe(`Абзац ![](media:${id}) конец`);
    expect(back.json().media[id]).toMatchObject({ removed: true, url: null });
    const versions = await listVersions(f.pool, 'publication', news.row.id);
    expect(JSON.stringify(versions.at(-1)!.snapshot)).toContain('Иван Иванов'); // журнал не правится
    expect(JSON.stringify(versions[0]!.snapshot)).not.toContain('Иван Иванов');

    const other = await f.image(99, 'Фото');
    n += 1;
    const draft: PublicationDraft = { scope: { type: 'network' }, title: 'Акция', lead: 'л', body: 'т', slug: `purge-c-${n}`, coverMediaId: cover, publishFrom: '2026-11-01T00:00:00Z', publishTo: '2027-01-01T00:00:00Z', conditions: `Условия ![Пётр](media:${other})` };
    const made = await f.inTx((tx) => createEntity(tx, c, publicationDef, { type: 'promotion' }, draft, f.meta(c), clock));
    await f.inTx((tx) => publish(tx, c, publicationDef, made.id, { rowVersion: made.row_version }, f.meta(c), clock));
    expect((await purge('owner', other)).json().affected).toEqual([{ entityType: 'publication', entityId: made.id, versionNo: 2 }]);
    const promo = await pubGet(`/publications/promotion/${draft.slug}`);
    expect(promo.body).not.toContain('Пётр');
    expect(promo.body).not.toContain(other);
  });

  it('запрет повторной загрузки не снимается: удалить очищенную строку нельзя', async () => {
    const id = await f.image(100, 'Фото');
    await purge('owner', id);
    const res = await app.inject({ method: 'DELETE', url: `${BASE}/content/media/${id}`, headers: { cookie: cookies.owner!, 'idempotency-key': randomUUID() } });
    expect(res.statusCode).toBe(404);
    expect((await getMediaRow(f.pool, id))?.status).toBe('purged');
  });

  it('очищенный файл заново не загрузить; в списке медиатеки его нет; правка и архив – 404', async () => {
    const c = f.owner();
    const content = await sharp({ create: { width: 90, height: 60, channels: 3, background: '#445566' } }).png().toBuffer();
    const { media } = await uploadMedia(f.pool, c, f.store, { content, purpose: 'image', alt: 'Фото' }, f.meta(c), clock);
    await purge('owner', media.id);
    await fails(uploadMedia(f.pool, c, f.store, { content, purpose: 'image' }, f.meta(c), clock), 'CONTENT_STATUS_CONFLICT');
    const list = await app.inject({ method: 'GET', url: `${BASE}/content/media`, headers: { cookie: cookies.owner! } });
    expect(list.json().items.map((x: { id: string }) => x.id)).not.toContain(media.id);
    expect((await app.inject({ method: 'GET', url: `${BASE}/content/media/${media.id}`, headers: { cookie: cookies.owner! } })).statusCode).toBe(404);
  });

  it('сбой транзакции не стирает файлы: файлы удаляются только после фиксации', async () => {
    const id = await f.image(95, 'Фото');
    const row = (await getMediaRow(f.pool, id))!;
    // устаревшая версия: повтор ключа с другим телом → отказ до фиксации; файл цел
    const key = randomUUID();
    await purge('owner', id, { reason: 'первая', basis: 'б' }, key);
    expect(await f.store.exists(row.storage_key)).toBe(false);
    const id2 = await f.image(96, 'Фото');
    const row2 = (await getMediaRow(f.pool, id2))!;
    const conflict = await purge('owner', id2, { reason: 'другая', basis: 'б' }, key);
    expect(conflict.statusCode).toBeGreaterThanOrEqual(400);
    expect(await f.store.exists(row2.storage_key)).toBe(true);
  });
});

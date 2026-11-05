// S4-36: блоки главной (K22 §2, K11 №228). Блок городской версии подменяет сетевой; неопубликованный – не в выдаче; порядок сохраняется;
// схема типа; права: сетевое – Владелец, городское – content.publish по городу.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blockDef, ensureBlock, getHomeBlocks, reorderBlocks, type BlockDraft, type BlockType } from '../../apps/api/src/modules/content/blocks.ts';
import { publish, saveDraft, unpublish, type EntityRow } from '../../apps/api/src/modules/content/versions.ts';
import { clock, contentFixture, fails, type ContentFixture } from '../helpers/content.ts';
import { createTestBranch, createTestCity } from '../helpers/network.ts';

let f: ContentFixture;
let cityA: string;
let cityB: string;

const block = async (blockType: BlockType, draft: unknown, cityId: string | null = null, c = f.owner()) => (await f.inTx((tx) => ensureBlock(tx, c, { blockType, cityId, draft }, f.meta(c), clock))).row;
const pub = (row: EntityRow, c = f.owner()) => f.inTx((tx) => publish(tx, c, blockDef, row.id, { rowVersion: row.row_version }, f.meta(c), clock));
const hero = (title: string): BlockDraft => ({ blockType: 'hero', payload: { title } });

beforeAll(async () => {
  f = await contentFixture();
  cityA = await createTestCity(f.db.client);
  cityB = await createTestCity(f.db.client);
});
afterAll(async () => {
  await f.close();
});

describe('S4-36: блоки главной', () => {
  it('неопубликованный не в выдаче; городская версия подменяет сетевую только в своём городе; снятая – снова сетевая', async () => {
    expect((await getHomeBlocks(f.pool, {})).blocks).toEqual([]);
    const net = await block('hero', hero('Сетевой'));
    expect((await getHomeBlocks(f.pool, {})).blocks).toEqual([]);
    await pub(net);
    expect((await getHomeBlocks(f.pool, {})).blocks[0]).toMatchObject({ blockType: 'hero', cityOverride: false, payload: { title: 'Сетевой' } });
    const city = await block('hero', hero('Городской'), cityA);
    expect((await getHomeBlocks(f.pool, { cityId: cityA })).blocks[0]!.payload).toEqual({ title: 'Сетевой' }); // черновик города не виден
    await pub(city);
    expect((await getHomeBlocks(f.pool, { cityId: cityA })).blocks).toHaveLength(1);
    expect((await getHomeBlocks(f.pool, { cityId: cityA })).blocks[0]).toMatchObject({ cityOverride: true, payload: { title: 'Городской' } });
    expect((await getHomeBlocks(f.pool, { cityId: cityB })).blocks[0]!.payload).toEqual({ title: 'Сетевой' });
    expect((await getHomeBlocks(f.pool, {})).blocks[0]!.payload).toEqual({ title: 'Сетевой' });
    await f.inTx((tx) => unpublish(tx, f.owner(), blockDef, city.id, { reason: 'снято' }, f.meta(f.owner()), clock));
    expect((await getHomeBlocks(f.pool, { cityId: cityA })).blocks[0]!.payload).toEqual({ title: 'Сетевой' });
  });

  it('порядок сохраняется и задаётся списком; чужой город в списке → 404; порядок не требует публикации', async () => {
    const about = await block('about', { blockType: 'about', payload: { body: 'О нас' } });
    const cta = await block('cta', { blockType: 'cta', payload: { title: 'Запись', label: 'Записаться', url: '/schedule/?zone=vr' } });
    const heroRow = await block('hero', hero('Сетевой'));
    await pub(about);
    await pub(cta);
    const order = async () => (await getHomeBlocks(f.pool, {})).blocks.map((b) => b.blockType);
    expect(await order()).toEqual(['hero', 'about', 'cta']); // по умолчанию – порядок типов дизайна
    await f.inTx((tx) => reorderBlocks(tx, f.owner(), { cityId: null, ids: [cta.id, about.id, heroRow.id] }, f.meta(f.owner()), clock));
    expect(await order()).toEqual(['cta', 'about', 'hero']);
    const cityBlock = await block('hero', hero('Город Б'), cityB);
    await fails(f.inTx((tx) => reorderBlocks(tx, f.owner(), { cityId: null, ids: [cityBlock.id] }, f.meta(f.owner()), clock)), 'NOT_FOUND');
    await fails(f.inTx((tx) => reorderBlocks(tx, f.owner(), { cityId: null, ids: [randomUUID()] }, f.meta(f.owner()), clock)), 'NOT_FOUND');
  });

  it('схема типа: неверный payload, чужой тип и внешняя ссылка → CONTENT_INVALID; //host в кнопке не проходит', async () => {
    await fails(block('promo_strip', { blockType: 'promo_strip', payload: {} }), 'CONTENT_INVALID');
    await fails(block('promo_strip', hero('Не тот тип')), 'CONTENT_INVALID');
    for (const url of ['//evil.ru', '/\\evil.ru', 'https://evil.ru', 'javascript:alert(1)']) {
      await fails(block('promo_strip', { blockType: 'promo_strip', payload: { text: 'x', url } }), 'CONTENT_INVALID');
    }
    await fails(block('directions', { blockType: 'directions', payload: { items: [] } }), 'CONTENT_INVALID');
    const strip = await block('promo_strip', { blockType: 'promo_strip', payload: { text: 'Скидка', url: '/promotions/spring/' } });
    expect(strip.block_type).toBe('promo_strip');
    await fails(f.inTx((tx) => saveDraft(tx, f.owner(), blockDef, strip.id, { rowVersion: strip.row_version, draft: hero('x') }, f.meta(f.owner()), clock)), 'CONTENT_INVALID');
    expect((await block('promo_strip', { blockType: 'promo_strip', payload: { text: 'Другая' } })).id).toBe(strip.id); // тип на уровне один
  });

  it('картинки: alt обязателен; в снимке заморожен', async () => {
    const noAlt = await f.image(21, null);
    const adv = await block('advantages', { blockType: 'advantages', payload: { items: [{ title: 'Быстро', mediaId: noAlt }] } });
    const err = await fails(pub(adv), 'MEDIA_ALT_REQUIRED');
    expect(err.details?.fields).toEqual([{ field: 'payload.items.0.mediaId', mediaId: noAlt }]);
    const withAlt = await f.image(22, 'ПК');
    const saved = await f.inTx((tx) => saveDraft(tx, f.owner(), blockDef, adv.id, { rowVersion: adv.row_version, draft: { blockType: 'advantages', payload: { items: [{ title: 'Быстро', mediaId: withAlt }] } } }, f.meta(f.owner()), clock));
    await pub(saved);
    const shown = (await getHomeBlocks(f.pool, {})).blocks.find((b) => b.blockType === 'advantages');
    expect(shown?.media[withAlt]).toMatchObject({ alt: 'ПК', removed: false });
  });

  it('права: Директор – блок своего города да, сетевой и чужой город нет; Администратор – нет', async () => {
    const { cityId: own, id: branch } = await createTestBranch(f.db.client);
    const director = f.ctx('director', [branch], [own]);
    const mine = await block('hero', hero('Мой город'), own, director);
    expect((await pub(mine, director)).row.status).toBe('published');
    await fails(block('hero', hero('Сеть'), null, director), 'FORBIDDEN');
    await fails(block('hero', hero('Чужой'), cityB, director), 'NOT_FOUND');
    await fails(block('hero', hero('Мой'), own, f.ctx('admin', [branch], [own])), 'FORBIDDEN');
  });
});

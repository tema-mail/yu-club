// S4-50: история слагов пишет publish (K23 §5, §10). Опубликованная новость A → B → C: A и B ведут на C; новый объект занял A – история A снята;
// смена слага в черновике до публикации истории не оставляет; откат возвращает слаг; снятое и архив – 404, не редирект. Игры – то же.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveLegacyPath, slugHistory } from '../../apps/api/src/modules/content/paths.ts';
import { gameDef } from '../../apps/api/src/modules/content/games.ts';
import { publicationDef } from '../../apps/api/src/modules/content/publications.ts';
import { archive, createEntity, publish, rollback, saveDraft, unpublish, type EntityDef, type EntityRow } from '../../apps/api/src/modules/content/versions.ts';
import { clock, contentFixture, NOW, type ContentFixture } from '../helpers/content.ts';

let f: ContentFixture;
let cover: string;
const resolve = async (path: string) => (await resolveLegacyPath(f.pool, path, NOW))?.location ?? null;
const news = (slug: string) => ({ scope: { type: 'network' }, title: 'Заголовок', lead: 'Подводка', body: 'Текст', slug, coverMediaId: cover, publishFrom: '2026-11-01T00:00:00Z' });
const game = (slug: string) => ({ title: 'Игра', short: 'Коротко', coverMediaId: cover, full: 'Описание', slug });

async function live<D extends Record<string, unknown>>(def: EntityDef<D>, row: EntityRow): Promise<EntityRow> {
  const c = f.owner();
  return (await f.inTx((tx) => publish(tx, c, def, row.id, { rowVersion: row.row_version }, f.meta(c), clock))).row;
}
async function make<D extends Record<string, unknown>>(def: EntityDef<D>, parent: Record<string, unknown>, draft: unknown): Promise<EntityRow> {
  const c = f.owner();
  return f.inTx((tx) => createEntity(tx, c, def, parent, draft, f.meta(c), clock));
}
async function edit<D extends Record<string, unknown>>(def: EntityDef<D>, row: EntityRow, draft: unknown): Promise<EntityRow> {
  const c = f.owner();
  return f.inTx((tx) => saveDraft(tx, c, def, row.id, { rowVersion: row.row_version, draft }, f.meta(c), clock));
}
const republish = async <D extends Record<string, unknown>>(def: EntityDef<D>, row: EntityRow, draft: unknown) => live(def, await edit(def, row, draft));

beforeAll(async () => {
  f = await contentFixture();
  cover = await f.image(71, 'Обложка');
});
afterAll(async () => {
  await f.close();
});

describe('публикации', () => {
  it('A → B → C: A и B ведут на C одним переходом; новый объект занял A – история снята, адрес его', async () => {
    let row = await live(publicationDef, await make(publicationDef, { type: 'news' }, news('slug-a')));
    row = await republish(publicationDef, row, news('slug-b'));
    row = await republish(publicationDef, row, news('slug-c'));
    expect(await resolve('/news/slug-a/')).toBe('/news/slug-c/');
    expect(await resolve('/news/slug-b/')).toBe('/news/slug-c/');
    expect(await resolve('/news/slug-c/')).toBeNull();
    expect((await slugHistory(f.pool, 'publication', row.id)).map((h) => h.oldSlug).sort()).toEqual(['slug-a', 'slug-b']);

    await live(publicationDef, await make(publicationDef, { type: 'news' }, news('slug-a')));
    expect(await resolve('/news/slug-a/')).toBeNull();
    expect((await slugHistory(f.pool, 'publication', row.id)).map((h) => h.oldSlug)).toEqual(['slug-b']);
    // тот же слаг другого типа – другой родитель
    expect(await resolve('/promotions/slug-b/')).toBeNull();
  });

  it('смена слага в черновике до первой публикации истории не оставляет; черновик живой версии адрес не меняет', async () => {
    let row = await make(publicationDef, { type: 'news' }, news('draft-1'));
    row = await edit(publicationDef, row, news('draft-2'));
    row = await live(publicationDef, row);
    expect(await slugHistory(f.pool, 'publication', row.id)).toEqual([]);
    await edit(publicationDef, row, news('draft-3'));
    expect(await slugHistory(f.pool, 'publication', row.id)).toEqual([]);
    expect(await resolve('/news/draft-2/')).toBeNull();
  });

  it('откат к версии со старым слагом: адрес возвращается, новый ведёт на него', async () => {
    const first = await live(publicationDef, await make(publicationDef, { type: 'news' }, news('roll-a')));
    const second = await republish(publicationDef, first, news('roll-b'));
    const v = await f.db.client.query<{ id: string }>(`SELECT id FROM journal.content_versions WHERE entity_id = $1 AND version_no = 1`, [first.id]);
    const c = f.owner();
    await f.inTx((tx) => rollback(tx, c, publicationDef, first.id, { versionId: v.rows[0]!.id, rowVersion: second.row_version, reason: 'ошибка' }, f.meta(c), clock));
    expect(await resolve('/news/roll-b/')).toBe('/news/roll-a/');
    expect(await resolve('/news/roll-a/')).toBeNull();
  });

  it('снятая с сайта и архивная: старый и текущий адрес – null (страница отдаёт 404), а не редирект', async () => {
    let row = await live(publicationDef, await make(publicationDef, { type: 'news' }, news('off-a')));
    row = await republish(publicationDef, row, news('off-b'));
    const c = f.owner();
    row = await f.inTx((tx) => unpublish(tx, c, publicationDef, row.id, { reason: 'снято' }, f.meta(c), clock));
    expect(await resolve('/news/off-a/')).toBeNull();
    await f.inTx((tx) => archive(tx, c, publicationDef, row.id, { reason: 'в архив' }, f.meta(c), clock));
    expect(await resolve('/news/off-a/')).toBeNull();
    expect(await resolve('/news/off-b/')).toBeNull();
  });

  it('правила розыгрыша идут за слагом', async () => {
    let row = await live(publicationDef, await make(publicationDef, { type: 'giveaway' }, { ...news('give-a'), resultsDate: '2026-12-01T00:00:00Z', prize: 'Приз', rulesBody: 'Правила' }));
    row = await republish(publicationDef, row, { ...news('give-b'), resultsDate: '2026-12-01T00:00:00Z', prize: 'Приз', rulesBody: 'Правила' });
    expect(row.slug).toBe('give-b');
    expect(await resolve('/giveaways/give-a/')).toBe('/giveaways/give-b/');
    expect(await resolve('/giveaways/give-a/rules/')).toBe('/giveaways/give-b/rules/');
  });
});

describe('игры', () => {
  it('A → B в пределах направления; другое направление не видит; без full – 404', async () => {
    let row = await live(gameDef, await make(gameDef, { direction: 'pc' }, game('game-a')));
    row = await republish(gameDef, row, game('game-b'));
    expect(await resolve('/games/pc/game-a/')).toBe('/games/pc/game-b/');
    expect(await resolve('/games/vr/game-a/')).toBeNull();
    expect(await resolve('/games/pc/game-b/')).toBeNull();
    await live(gameDef, await make(gameDef, { direction: 'pc' }, game('game-a')));
    expect(await resolve('/games/pc/game-a/')).toBeNull();
    await republish(gameDef, row, { title: 'Игра', short: 'Коротко', coverMediaId: cover });
    expect(await resolve('/games/pc/game-b/')).toBeNull();
  });

  it('A → без страницы → B: пока страницы нет – 404, с новой страницей старый адрес ведёт на неё', async () => {
    let row = await live(gameDef, await make(gameDef, { direction: 'vr' }, game('tile-a')));
    row = await republish(gameDef, row, { title: 'Игра', short: 'Коротко', coverMediaId: cover });
    expect(row.slug).toBeNull();
    expect(await resolve('/games/vr/tile-a/')).toBeNull();
    row = await republish(gameDef, row, game('tile-b'));
    expect(await resolve('/games/vr/tile-a/')).toBe('/games/vr/tile-b/');
    expect(await resolve('/games/vr/tile-b/')).toBeNull();
    // Возврат к первому слагу снимает его из истории.
    await republish(gameDef, row, game('tile-a'));
    expect(await resolve('/games/vr/tile-a/')).toBeNull();
    expect(await resolve('/games/vr/tile-b/')).toBe('/games/vr/tile-a/');
  });
});

// S4-34: игры и доступность по филиалам (K22 §2, §9; 12 приёмка 9, §14.1). Филиал без строки → игры нет; PlayStation без platforms →
// CONTENT_INCOMPLETE; без full – нет карточки; без branch – пометка общего каталога; права; очищенная обложка – заглушка.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getGamePage, gameDef, listGames, setGameBranch, type GameDirection, type GameDraft } from '../../apps/api/src/modules/content/games.ts';
import { createEntity, publish, saveDraft, type EntityRow } from '../../apps/api/src/modules/content/versions.ts';
import { clock, contentFixture, fails, type ContentFixture } from '../helpers/content.ts';
import { createTestBranch } from '../helpers/network.ts';

let f: ContentFixture;
let cover: string;
let branchA: string;
let branchB: string;
let n = 0;

const create = (direction: GameDirection, draft: GameDraft) => {
  const c = f.owner();
  return createEntity(f.pool, c, gameDef, { direction }, draft, f.meta(c), clock);
};
const pub = (row: EntityRow) => {
  const c = f.owner();
  return f.inTx((tx) => publish(tx, c, gameDef, row.id, { rowVersion: row.row_version }, f.meta(c), clock));
};
const full = (over: Partial<GameDraft> = {}): GameDraft => {
  n += 1;
  return { title: `Игра ${n}`, short: 'Коротко', coverMediaId: cover, full: 'Описание игры', slug: `game-${n}`, ...over };
};
const avail = (gameId: string, branchId: string, available = true, note?: string, c = f.owner()) => setGameBranch(f.pool, c, gameId, branchId, { available, ...(note ? { note } : {}) }, f.meta(c), clock);

beforeAll(async () => {
  f = await contentFixture();
  cover = await f.image(1, 'Обложка');
  branchA = (await createTestBranch(f.db.client)).id;
  branchB = (await createTestBranch(f.db.client)).id;
});
afterAll(async () => {
  await f.close();
});

describe('S4-34: доступность по филиалам', () => {
  it('филиал без строки – игры нет; available=false – нет; сетевой каталог с пометкой показывает все опубликованные', async () => {
    const yes = (await pub(await create('pc', full({ title: 'Есть' })))).row;
    const no = (await pub(await create('pc', full({ title: 'Выключена' })))).row;
    const none = (await pub(await create('pc', full({ title: 'Без строки' })))).row;
    await avail(yes.id, branchA, true, 'Только на втором этаже');
    await avail(no.id, branchA, false);
    const here = await listGames(f.pool, { branchId: branchA });
    expect(here.networkCatalog).toBe(false);
    expect(here.items.map((g) => g.title)).toEqual(['Есть']);
    expect(here.items[0]!.note).toBe('Только на втором этаже');
    expect((await listGames(f.pool, { branchId: branchB })).items).toEqual([]);
    const net = await listGames(f.pool, { direction: 'pc' });
    expect(net.networkCatalog).toBe(true);
    expect(net.items.map((g) => g.title)).toEqual(expect.arrayContaining(['Есть', 'Выключена', 'Без строки']));
    expect(none.status).toBe('published');
  });

  it('права: Директор – своего филиала, чужой → 404; Администратор → 403; аудит есть; повтор обновляет ту же строку', async () => {
    const g = await create('vr', full());
    const director = f.ctx('director', [branchA]);
    await avail(g.id, branchA, true, undefined, director);
    await fails(avail(g.id, branchB, true, undefined, director), 'NOT_FOUND');
    await fails(avail(g.id, branchA, true, undefined, f.ctx('admin', [branchA])), 'FORBIDDEN');
    await avail(g.id, branchA, false, undefined, director);
    const rows = await f.db.client.query<{ available: boolean }>(`SELECT available FROM app.content_game_branches WHERE game_id = $1`, [g.id]);
    expect(rows.rows).toEqual([{ available: false }]);
    const audit = await f.db.client.query(`SELECT 1 FROM journal.audit_events WHERE object_id = $1 AND action = 'content.availability_changed'`, [g.id]);
    expect(audit.rowCount).toBe(2);
    await fails(avail(randomUUID(), branchA), 'NOT_FOUND');
  });
});

describe('S4-34: карточка и полнота', () => {
  it('PlayStation без platforms → CONTENT_INCOMPLETE; с платформами публикуется; остальные поля – по §9', async () => {
    const err = await fails(pub(await create('playstation', full())), 'CONTENT_INCOMPLETE');
    expect(err.details?.fields).toEqual([{ field: 'platforms', code: 'REQUIRED' }]);
    const empty = await fails(pub(await create('pc', {})), 'CONTENT_INCOMPLETE');
    expect((empty.details?.fields as Array<{ field: string }>).map((x) => x.field)).toEqual(['title', 'short', 'coverMediaId']);
    expect((await pub(await create('playstation', full({ platforms: ['ps5'] })))).row.status).toBe('published');
  });

  it('без full – нет карточки, плитка в каталоге есть; слаг не нужен; с full без слага – полнота', async () => {
    const { row } = await pub(await create('vr', { title: 'Плитка', short: 'Только плитка', coverMediaId: cover }));
    expect(row.has_full).toBe(false);
    const tile = (await listGames(f.pool, { direction: 'vr' })).items.find((g) => g.title === 'Плитка');
    expect(tile).toMatchObject({ hasPage: false, slug: null });
    const bad = await fails(pub(await create('vr', { title: 'x', short: 'y', coverMediaId: cover, full: 'текст' })), 'CONTENT_INCOMPLETE');
    expect(bad.details?.fields).toEqual([{ field: 'slug', code: 'REQUIRED' }]);
    const page = await pub(await create('vr', full({ slug: 'half-life-alyx', title: 'Alyx' })));
    expect(await getGamePage(f.pool, { direction: 'vr', slug: 'half-life-alyx' })).toMatchObject({ title: 'Alyx', full: 'Описание игры', hasPage: true });
    expect(await getGamePage(f.pool, { direction: 'pc', slug: 'half-life-alyx' })).toBeNull();
    // снятие полного описания новой публикацией убирает страницу
    const d = page.row.draft as GameDraft;
    const edited = await saveDraft(f.pool, f.owner(), gameDef, page.row.id, { rowVersion: page.row.row_version, draft: { ...d, full: '' } }, f.meta(f.owner()), clock);
    await pub(edited);
    expect(await getGamePage(f.pool, { direction: 'vr', slug: 'half-life-alyx' })).toBeNull();
  });

  it('страница: где поиграть – только доступные и не архивные филиалы; черновика в ответе нет', async () => {
    const { row } = await pub(await create('pc', full({ slug: 'cs2', title: 'Живой' })));
    await avail(row.id, branchA, true, 'заметка');
    const archived = (await createTestBranch(f.db.client)).id;
    await f.db.client.query(`UPDATE app.branches SET status = 'archived', archived_at = now() WHERE id = $1`, [archived]);
    await avail(row.id, archived, true);
    const secret = `ЧЕРНОВИК-${randomUUID()}`;
    await saveDraft(f.pool, f.owner(), gameDef, row.id, { rowVersion: row.row_version, draft: { ...(row.draft as GameDraft), title: secret } }, f.meta(f.owner()), clock);
    const page = await getGamePage(f.pool, { direction: 'pc', slug: 'cs2' });
    expect(page?.availableIn.map((b) => b.id)).toEqual([branchA]);
    expect(page?.availableIn[0]).toMatchObject({ note: 'заметка' });
    expect(JSON.stringify(page)).not.toContain(secret);
    expect(JSON.stringify(page)).not.toMatch(/"draft"|created_by|published_by/);
  });

  it('каталог – только Владелец; слаг занят в направлении → SLUG_TAKEN', async () => {
    const row = await create('pc', full());
    const c = f.ctx('director', [branchA]);
    await fails(saveDraft(f.pool, c, gameDef, row.id, { rowVersion: 1, draft: {} }, f.meta(c), clock), 'FORBIDDEN');
    await fails(f.inTx((tx) => publish(tx, c, gameDef, row.id, { rowVersion: 1 }, f.meta(c), clock)), 'FORBIDDEN');
    await pub(await create('pc', full({ slug: 'dup' })));
    await fails(pub(await create('pc', full({ slug: 'dup' }))), 'SLUG_TAKEN');
    expect((await pub(await create('vr', full({ slug: 'dup' })))).row.slug).toBe('dup');
  });
});

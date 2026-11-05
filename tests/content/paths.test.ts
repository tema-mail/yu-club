// S4-50: история адресов K23 §5. A → B → C: старые ведут сразу на C; занятие старого снимает историю; закрытые объекты; переименование города
// тянет филиал и комнату; город news – SLUG_RESERVED и 23514; транслит; миграция вверх/вниз/вверх.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateDown, migrateUp } from '../../db/migrate.ts';
import { RESERVED_CITY_SLUGS } from '../../packages/contracts/src/paths.ts';
import { checkSlug, recordSlugChange, releaseSlug, resolveLegacyPath, slugDraft, slugHistory } from '../../apps/api/src/modules/content/paths.ts';
import { clock, contentFixture, NOW, type ContentFixture } from '../helpers/content.ts';
import { createTestDatabase } from '../helpers/pg.ts';

let f: ContentFixture;
const q = (sql: string, params: unknown[] = []) => f.db.client.query<{ id: string }>(sql, params);
const resolve = async (path: string) => (await resolveLegacyPath(f.pool, path, NOW))?.location ?? null;

async function city(slug: string, status = 'active'): Promise<string> {
  return (await q(`INSERT INTO app.cities (code, slug, name, timezone, status, archived_at) VALUES ($1, $2, $2, 'Asia/Novosibirsk', $3, CASE WHEN $3 = 'archived' THEN now() END) RETURNING id`, [`${slug}-${Math.random()}`, slug, status])).rows[0]!.id;
}
async function branch(cityId: string, slug: string, status = 'active'): Promise<string> {
  return (await q(`INSERT INTO app.branches (city_id, code, slug, name, address, timezone, status, archived_at, temp_closed_from, temp_close_reason) VALUES ($1, $2, $3, $3, 'адрес', 'Asia/Novosibirsk', $4, CASE WHEN $4 = 'archived' THEN now() END, CASE WHEN $4 = 'temporarily_closed' THEN now() END, CASE WHEN $4 = 'temporarily_closed' THEN 'ремонт' END) RETURNING id`, [cityId, `${cityId}-${slug}`, slug, status])).rows[0]!.id;
}
async function room(branchId: string, slug: string, published = true, status = 'active'): Promise<string> {
  return (await q(`INSERT INTO app.rooms (branch_id, name, slug, is_published, status, archived_at) VALUES ($1, $2, $2, $3, $4, CASE WHEN $4 = 'archived' THEN now() END) RETURNING id`, [branchId, slug, published, status])).rows[0]!.id;
}
async function rename(table: string, id: string, entityType: 'city' | 'branch' | 'room', parentKey: string, oldSlug: string, newSlug: string) {
  await q(`UPDATE ${table} SET slug = $2 WHERE id = $1`, [id, newSlug]);
  await recordSlugChange(f.pool, { entityType, entityId: id, parentKey, oldSlug, newSlug }, clock);
}

beforeAll(async () => {
  f = await contentFixture();
});
afterAll(async () => {
  await f.close();
});

describe('города, филиалы, комнаты', () => {
  it('A → B → C: старые адреса ведут сразу на текущий, текущий – не редирект, петель нет', async () => {
    const c = await city('alpha');
    await branch(c, 'one');
    await branch(c, 'two');
    await rename('app.cities', c, 'city', '', 'alpha', 'beta');
    await rename('app.cities', c, 'city', '', 'beta', 'gamma');
    expect(await resolve('/alpha/')).toBe('/gamma/');
    expect(await resolve('/beta/')).toBe('/gamma/');
    expect(await resolve('/gamma/')).toBeNull();
    expect(await resolve((await resolve('/alpha/'))!)).toBeNull();
  });

  it('переименован город – старые адреса филиала и комнаты ведут на новые; филиал и комната – тоже одним переходом', async () => {
    const c = await city('oldtown');
    const b = await branch(c, 'lenina');
    await branch(c, 'mira');
    const r = await room(b, 'vr-room');
    await rename('app.cities', c, 'city', '', 'oldtown', 'newtown');
    expect(await resolve('/oldtown/lenina/')).toBe('/newtown/lenina/');
    expect(await resolve('/oldtown/lenina/rooms/vr-room/')).toBe('/newtown/lenina/rooms/vr-room/');
    await rename('app.branches', b, 'branch', c, 'lenina', 'lenina-12');
    await rename('app.rooms', r, 'room', b, 'vr-room', 'vr');
    expect(await resolve('/oldtown/lenina/rooms/vr-room/')).toBe('/newtown/lenina-12/rooms/vr/');
    expect(await resolve('/newtown/lenina/')).toBe('/newtown/lenina-12/');
    expect(await resolve('/oldtown/lenina/rooms/')).toBe('/newtown/lenina-12/#rooms');
    expect(await resolve('/newtown/lenina-12/rooms/vr/')).toBeNull();
    expect(await resolve('/newtown/lenina-12/')).toBeNull();
  });

  it('новый объект занял старый слаг: живой объект важнее редиректа, история снимается', async () => {
    const c = await city('shared-a');
    await branch(c, 'x1');
    await branch(c, 'x2');
    await rename('app.cities', c, 'city', '', 'shared-a', 'shared-b');
    const other = await city('shared-a');
    await branch(other, 'y1');
    await branch(other, 'y2');
    expect(await resolve('/shared-a/')).toBeNull(); // новый город живёт по своему адресу, хотя строка истории ещё есть
    await releaseSlug(f.pool, 'city', '', 'shared-a');
    expect(await slugHistory(f.pool, 'city', c)).toEqual([]);
  });

  it('возврат к старому слагу: A → B → A снимает A из истории, B ведёт на A', async () => {
    const c = await city('back-a');
    await branch(c, 'p1');
    await branch(c, 'p2');
    await rename('app.cities', c, 'city', '', 'back-a', 'back-b');
    await rename('app.cities', c, 'city', '', 'back-b', 'back-a');
    expect(await resolve('/back-b/')).toBe('/back-a/');
    expect(await resolve('/back-a/')).toBeNull();
    expect((await slugHistory(f.pool, 'city', c)).map((h) => h.oldSlug)).toEqual(['back-b']);
  });

  it('город: один филиал – сразу на него; нет открытых – нет адреса; архив – главная', async () => {
    const single = await city('single');
    await branch(single, 'only');
    expect(await resolve('/single/')).toBe('/single/only/');
    await rename('app.cities', single, 'city', '', 'single', 'single-2');
    expect(await resolve('/single/')).toBe('/single-2/only/');

    const prep = await city('prep');
    const pb = await branch(prep, 'soon', 'preparing');
    expect(await resolve('/prep/')).toBeNull();
    expect(await resolve('/prep/soon/')).toBeNull(); // готовящегося на сайте нет – перехода на 404 не делаем
    await room(pb, 'r');
    expect(await resolve('/prep/soon/rooms/r/')).toBeNull();

    await city('gone', 'archived');
    expect(await resolve('/gone/')).toBe('/');
  });

  it('филиал в архиве: город с двумя открытыми – на город, иначе – контакты; комнаты – туда же; нет комнаты – ничего', async () => {
    const big = await city('big');
    await branch(big, 'a1');
    await branch(big, 'a2');
    const closed = await branch(big, 'closed', 'archived');
    await room(closed, 'r1');
    expect(await resolve('/big/closed/')).toBe('/big/');
    expect(await resolve('/big/closed/rooms/r1/')).toBe('/big/');
    expect(await resolve('/big/closed/rooms/')).toBe('/big/');
    expect(await resolve('/big/closed/rooms/nope/')).toBeNull();

    const small = await city('small');
    await branch(small, 's1');
    await branch(small, 'gone', 'archived');
    expect(await resolve('/small/gone/')).toBe('/contacts/');
  });

  it('комната в архиве, снята с сайта или закрыта – на страницу филиала; временно закрытый филиал – на месте', async () => {
    const c = await city('rooms-city');
    const b = await branch(c, 'main', 'temporarily_closed');
    await branch(c, 'second');
    await room(b, 'live');
    await room(b, 'hidden', false);
    await room(b, 'old', true, 'archived');
    await room(b, 'shut', true, 'unavailable');
    expect(await resolve('/rooms-city/main/rooms/live/')).toBeNull();
    for (const s of ['hidden', 'old', 'shut']) expect(await resolve(`/rooms-city/main/rooms/${s}/`)).toBe('/rooms-city/main/');
    expect(await resolve('/rooms-city/main/')).toBeNull();
    expect(await resolve('/rooms-city/main/rooms/nope/')).toBeNull();
  });

  it('несуществующее и служебное – null; чужой родитель историю не видит; ненормальный адрес разрешается как нормальный', async () => {
    for (const p of ['/nope/', '/nope/nope/', '/a/b/c/d/', '/', '/account/', '/rules/', '/news/', '/games/', '/games/pc/', '/robots.txt']) expect(await resolve(p), p).toBeNull();
    const c1 = await city('parent-one');
    const c2 = await city('parent-two');
    const b = await branch(c1, 'moved-from');
    await branch(c1, 'other');
    await branch(c2, 'p');
    await branch(c2, 'q');
    await rename('app.branches', b, 'branch', c1, 'moved-from', 'moved-to');
    expect(await resolve('/parent-one/moved-from/')).toBe('/parent-one/moved-to/');
    expect(await resolve('/parent-two/moved-from/')).toBeNull();
    expect(await resolve('/PARENT-ONE/Moved-From')).toBe('/parent-one/moved-to/');
    expect(await resolve('/Parent-Two/P')).toBe('/parent-two/p/');
  });
});

describe('зарезервированные слаги', () => {
  it('город news – 23514 в БД и SLUG_RESERVED в проверке CRM; список миграции совпадает с реестром адресов', async () => {
    const err = await q(`INSERT INTO app.cities (code, slug, name, timezone) VALUES ('news', 'news', 'x', 'Asia/Omsk')`).then(() => null, (e: { code?: string }) => e);
    expect(err?.code).toBe('23514');
    expect(await checkSlug(f.pool, { entityType: 'city', parent: '', slug: 'news' })).toEqual({ ok: false, code: 'SLUG_RESERVED' });
    const def = await q(`SELECT pg_get_constraintdef(oid) AS id FROM pg_constraint WHERE conname = 'cities_slug_reserved'`);
    const inDb = [...def.rows[0]!.id.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]!).sort();
    expect(inDb).toEqual([...RESERVED_CITY_SLUGS].sort());
  });
});

describe('слаг для CRM', () => {
  it('маска и длина, занят у родителя с подсказкой, история – предупреждение, себя не считает', async () => {
    const c = await city('check-city');
    const b = await branch(c, 'taken');
    await branch(c, 'taken-2');
    const check = (slug: string, entityType: 'city' | 'branch' = 'branch') => checkSlug(f.pool, { entityType, parent: c, slug });
    expect(await check('Плохой')).toEqual({ ok: false, code: 'SLUG_INVALID' });
    expect(await check('a--b')).toEqual({ ok: false, code: 'SLUG_INVALID' });
    expect(await check('a'.repeat(41), 'city')).toEqual({ ok: false, code: 'SLUG_INVALID' });
    expect(await check('taken')).toEqual({ ok: false, code: 'SLUG_TAKEN', suggestion: 'taken-3' });
    expect(await checkSlug(f.pool, { entityType: 'branch', parent: c, slug: 'taken', excludeId: b })).toEqual({ ok: true });
    await rename('app.branches', b, 'branch', c, 'taken', 'renamed');
    expect(await check('taken')).toEqual({ ok: true, code: 'SLUG_IN_HISTORY' });
    expect(await checkSlug(f.pool, { entityType: 'branch', parent: c, slug: 'taken', excludeId: b })).toEqual({ ok: true });
    expect(await check('free')).toEqual({ ok: true });
    expect((await slugHistory(f.pool, 'branch', b)).map((h) => h.oldSlug)).toEqual(['taken']);
  });
});

describe('черновой транслит', () => {
  it.each([
    ['Новый турнир по CS2 в Новосибирске', 'novyy-turnir-cs2-novosibirske'],
    ['Щука, ёлка и хоккей', 'shchuka-yolka-khokkey'],
    ['Цены на VR', 'tseny-vr'],
    ['Объявление: подъезд', 'obyavlenie-podezd'],
    ['Акция 5+1 на PS5!', 'aktsiya-5-1-ps5'],
    ['!!!', ''],
  ])('%s → %s', (title, slug) => {
    expect(slugDraft(title)).toBe(slug);
  });
  it('обрезка по целому слову, не длиннее предела', () => {
    const s = slugDraft('слово '.repeat(40));
    expect(s.length).toBeLessThanOrEqual(90);
    expect(s.endsWith('slovo')).toBe(true);
  });
});

describe('миграция', () => {
  it('вверх → вниз → вверх на чистой базе', async () => {
    const t = await createTestDatabase({ migrate: true });
    try {
      const later = await t.client.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.schema_migrations WHERE version >= '0405'`);
      const down = await migrateDown(t.client, later.rows[0]!.n);
      expect(down.at(-1)).toBe('0405');
      expect((await t.client.query(`SELECT 1 FROM pg_tables WHERE tablename = 'seo_slug_history'`)).rows).toEqual([]);
      expect(await migrateUp(t.client)).toEqual([...down].reverse());
    } finally {
      await t.drop();
    }
  });
});

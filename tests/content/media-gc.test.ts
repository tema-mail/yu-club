// S4-44: уборка медиа. Файл строки и файл старой версии не удаляются; «сирота» старше суток – удалён; свежая – остаётся (загрузка могла ещё не записать строку).
import { utimes } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { blockDef, ensureBlock } from '../../apps/api/src/modules/content/blocks.ts';
import { gcMedia, getMediaRow, startMediaGc } from '../../apps/api/src/modules/content/media.ts';
import { publish, saveDraft } from '../../apps/api/src/modules/content/versions.ts';
import { clock, contentFixture, NOW, type ContentFixture } from '../helpers/content.ts';

const DAY = 24 * 60 * 60 * 1000;
let f: ContentFixture;
const age = async (relative: string, ms: number) => {
  const t = new Date(NOW.getTime() - ms);
  await utimes(path.join(f.root, relative), t, t);
};
/** Все файлы старше суток: иначе «нетронутость» файла строки объяснялась бы возрастом, а не строкой. */
async function ageAll(): Promise<void> {
  for await (const e of f.store.list()) await age(e.relative, 2 * DAY);
}

beforeAll(async () => {
  f = await contentFixture();
});
afterAll(async () => {
  await f.close();
});

describe('S4-44: уборка', () => {
  it('«сирота» старше суток удалён; свежая остаётся; файлы строки (все варианты) целы', async () => {
    const id = await f.image(81);
    const row = (await getMediaRow(f.pool, id))!;
    await f.store.writeAtomic('zz/zz/orphan-old-480.webp', Buffer.from('сирота'));
    await f.store.writeAtomic('zz/zz/orphan-fresh-480.webp', Buffer.from('свежая'));
    await ageAll();
    await age('zz/zz/orphan-fresh-480.webp', DAY - 60_000);
    const r = await gcMedia(f.pool, f.store, NOW);
    expect(r.removed).toEqual(['zz/zz/orphan-old-480.webp']);
    expect(await f.store.exists('zz/zz/orphan-old-480.webp')).toBe(false);
    expect(await f.store.exists('zz/zz/orphan-fresh-480.webp')).toBe(true);
    expect(row.variants.length).toBeGreaterThan(0);
    for (const v of row.variants) expect(await f.store.exists(v.key)).toBe(true);
    expect(await f.store.exists(row.storage_key)).toBe(true);
    await f.store.remove('zz/zz/orphan-fresh-480.webp');
  });

  it('файл старой версии цел: медиа больше нет в черновике и живой версии, архивная строка остаётся', async () => {
    const id = await f.image(82, 'Старое фото');
    const c = f.owner();
    const { row } = await f.inTx((tx) => ensureBlock(tx, c, { blockType: 'hero', cityId: null, draft: { blockType: 'hero', payload: { title: 'С фото', mediaId: id } } }, f.meta(c), clock));
    const v1 = await f.inTx((tx) => publish(tx, c, blockDef, row.id, { rowVersion: row.row_version }, f.meta(c), clock));
    const saved = await f.inTx((tx) => saveDraft(tx, c, blockDef, row.id, { rowVersion: v1.row.row_version, draft: { blockType: 'hero', payload: { title: 'Без фото' } } }, f.meta(c), clock));
    await f.inTx((tx) => publish(tx, c, blockDef, row.id, { rowVersion: saved.row_version }, f.meta(c), clock));
    await f.db.client.query(`UPDATE app.content_media SET status = 'archived', archived_at = now() WHERE id = $1`, [id]);
    await ageAll();
    expect((await gcMedia(f.pool, f.store, NOW)).removed).toEqual([]);
    const media = (await getMediaRow(f.pool, id))!;
    expect(await f.store.exists(media.storage_key)).toBe(true);
  });

  it('файл очищенной строки, оставшийся после сбоя, удаляется', async () => {
    const id = await f.image(83);
    const row = (await getMediaRow(f.pool, id))!;
    await f.db.client.query(`UPDATE app.content_media SET status = 'purged' WHERE id = $1`, [id]);
    await ageAll();
    const r = await gcMedia(f.pool, f.store, NOW);
    expect(r.removed.sort()).toEqual(row.variants.map((v) => v.key).sort());
    expect(await f.store.exists(row.storage_key)).toBe(false);
  });

  it('пустой или не созданный каталог – без ошибки', async () => {
    const { createFileStore } = await import('../../apps/api/src/core/files.ts');
    expect(await gcMedia(f.pool, createFileStore({ root: path.join(f.root, 'нет-каталога') }), NOW)).toMatchObject({ removed: [] });
  });

  it('задача: ночью один проход за сутки; днём не идёт; ошибка не роняет', async () => {
    await f.store.writeAtomic('zz/zz/orphan-night-480.webp', Buffer.from('сирота'));
    await ageAll();
    const done: number[] = [];
    const day = startMediaGc({ pool: f.pool, store: f.store, clock: fixedClock('2026-11-14T12:00:00Z'), intervalMs: 5, onDone: (r) => done.push(r.removed.length) });
    await new Promise((resolve) => setTimeout(resolve, 40));
    day.stop();
    expect(done).toEqual([]);
    const night = startMediaGc({ pool: f.pool, store: f.store, clock: fixedClock('2026-11-14T01:30:00Z'), intervalMs: 5, onDone: (r) => done.push(r.removed.length) });
    await new Promise((resolve) => setTimeout(resolve, 200));
    night.stop();
    expect(done).toEqual([1]);
    const errors: unknown[] = [];
    const broken = startMediaGc({ pool: { query: () => Promise.reject(new Error('нет базы')) }, store: f.store, clock: fixedClock('2026-11-15T01:30:00Z'), intervalMs: 5, onError: (e) => errors.push(e) });
    await new Promise((resolve) => setTimeout(resolve, 60));
    broken.stop();
    expect(errors).toHaveLength(1);
  });
});

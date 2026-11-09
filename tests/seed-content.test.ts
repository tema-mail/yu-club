// S4-130: засев Э4 поверх Э0 и Э1 – медиа, публикации трёх типов с охватом сеть / город / филиал, игры с доступностью по филиалам,
// страницы, две кампании-черновика. Повтор без дублей (ни строк, ни версий, ни аудита); демо помечено; на проде – отказ до записи.
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixedClock } from '../apps/api/src/core/time.ts';
import { listGames } from '../apps/api/src/modules/content/games.ts';
import { getPage } from '../apps/api/src/modules/content/pages.ts';
import { listPublications } from '../apps/api/src/modules/content/publications.ts';
import { seedContent, type ContentSeedReport } from '../db/seed/content.ts';
import { DEMO_MARK, seedDev } from '../db/seed/dev.ts';
import { seedResources } from '../db/seed/resources.ts';
import { createTestDatabase, type TestDatabase } from './helpers/pg.ts';

const clock = fixedClock('2026-11-14T05:00:00Z');
let db: TestDatabase;
let pool: pg.Pool;
let mediaDir: string;
let first: ContentSeedReport;

async function counts(): Promise<Record<string, number>> {
  const r = await db.client.query(`SELECT
    (SELECT count(*)::int FROM app.content_media) media, (SELECT count(*)::int FROM app.content_publications) publications,
    (SELECT count(*)::int FROM app.content_games) games, (SELECT count(*)::int FROM app.content_game_branches) availability,
    (SELECT count(*)::int FROM app.content_pages) pages, (SELECT count(*)::int FROM journal.content_versions) versions,
    (SELECT count(*)::int FROM app.notification_campaigns) campaigns, (SELECT count(*)::int FROM journal.audit_events) audit`);
  return r.rows[0];
}
const branchId = async (code: string) => (await db.client.query<{ id: string }>(`SELECT id FROM app.branches WHERE code = $1`, [code])).rows[0]!.id;
const cityId = async (code: string) => (await db.client.query<{ id: string }>(`SELECT id FROM app.cities WHERE code = $1`, [code])).rows[0]!.id;

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
  mediaDir = await mkdtemp(path.join(os.tmpdir(), 'yu-seed-media-'));
});
afterAll(async () => {
  await pool.end();
  await db.drop();
  await rm(mediaDir, { recursive: true, force: true });
});

describe('S4-130: засев Э4', () => {
  it('на проде – отказ до записи; без Э0/Э1 – понятная ошибка', async () => {
    const before = await counts();
    await expect(seedContent(pool, { env: { APP_ENV: 'production' }, mediaDir }, clock)).rejects.toThrow(/только для dev\/stage\/test/);
    await expect(seedContent(pool, { env: { NODE_ENV: 'production' }, mediaDir }, clock)).rejects.toThrow(/только для dev\/stage\/test/);
    await expect(seedContent(pool, { env: { APP_ENV: 'test' }, mediaDir }, clock)).rejects.toThrow(/засев Э0 и Э1/);
    expect(await counts()).toEqual(before);
    expect(await readdir(mediaDir)).toEqual([]);
  });

  it('создаёт медиа, 9 публикаций, 3 игры с доступностью, 3 страницы и 2 кампании', async () => {
    await seedDev(pool, { env: { APP_ENV: 'test' }, password: 'Демо-пароль-засева-4' }, clock);
    await seedResources(pool, { env: { APP_ENV: 'test' } }, clock);
    first = await seedContent(pool, { env: { APP_ENV: 'test' }, mediaDir }, clock);
    expect(first.created).toEqual({ media: 4, publications: 9, games: 3, availability: 5, pages: 3, campaigns: 2 });
    const media = await db.client.query<{ n: number; w: number }>(`SELECT count(*)::int n, min(width) w FROM app.content_media WHERE title LIKE $1 AND alt IS NOT NULL`, [`${DEMO_MARK}%`]);
    expect(media.rows[0]).toEqual({ n: 4, w: 640 });
    expect((await readdir(mediaDir)).length).toBeGreaterThan(0); // файлы вариантов записаны в медиатеку
    const live = await db.client.query<{ status: string; n: number }>(
      `SELECT status, count(*)::int n FROM (SELECT status FROM app.content_publications UNION ALL SELECT status FROM app.content_games UNION ALL SELECT status FROM app.content_pages) x GROUP BY 1`,
    );
    expect(live.rows).toEqual([{ status: 'published', n: 15 }]);
  });

  it('охват публикаций виден посетителю: сеть – всем, город – Новосибирску, филиал – Арбату', async () => {
    const now = clock.now();
    const titles = async (visitor: { cityId?: string; branchId?: string }) => (await listPublications(pool, { visitor, limit: 50, now })).items.map((i) => i.title).sort();
    const krasny = await titles({ branchId: await branchId('demo-nsk-krasny') });
    const arbat = await titles({ branchId: await branchId('demo-msk-arbat') });
    expect(krasny.filter((t) => t.includes('Новосибирск'))).toHaveLength(3);
    expect(krasny.filter((t) => t.includes('Арбат'))).toEqual([]);
    expect(arbat.filter((t) => t.includes('Арбат'))).toHaveLength(3);
    expect(arbat.filter((t) => t.includes('Новосибирск'))).toEqual([]);
    for (const list of [krasny, arbat]) expect(list.filter((t) => t.includes('вся сеть'))).toHaveLength(3);
    const types = await db.client.query<{ type: string; n: number }>(`SELECT type, count(*)::int n FROM app.content_publications GROUP BY 1 ORDER BY 1`);
    expect(types.rows).toEqual([{ type: 'giveaway', n: 3 }, { type: 'news', n: 3 }, { type: 'promotion', n: 3 }]);
  });

  it('игры доступны по филиалам; страницы и кампании на месте', async () => {
    const titles = async (code: string) => (await listGames(pool, { branchId: await branchId(code) })).items.map((g) => g.title).sort();
    expect(await titles('demo-nsk-krasny')).toEqual(['Beat Saber (демо)', 'Counter-Strike 2 (демо)']);
    expect(await titles('demo-msk-arbat')).toEqual(['Beat Saber (демо)', 'EA Sports FC (демо)']);
    expect((await getPage(pool, { key: 'about' }))?.title).toBe('О клубе (демо)');
    expect((await getPage(pool, { key: 'contacts_intro', cityId: await cityId('demo-nsk') }))?.title).toBe('Контакты в Новосибирске (демо)');
    const legal = await db.client.query(`SELECT 1 FROM app.content_pages WHERE key IN ('privacy-policy','personal-data-consent','cookie-policy','advertising-consent')`);
    expect(legal.rowCount).toBe(0); // демо-текст юридических документов не засевается
    const c = await db.client.query(`SELECT status, category, area_type, audience->>'kind' AS kind FROM app.notification_campaigns ORDER BY area_type`);
    expect(c.rows).toEqual([
      { status: 'draft', category: 'marketing', area_type: 'branch', kind: 'segment' },
      { status: 'draft', category: 'marketing', area_type: 'network', kind: 'client' },
    ]);
    const marked = await db.client.query<{ n: number }>(`SELECT count(*)::int n FROM app.notification_campaigns WHERE advertiser_note NOT LIKE $1 OR advertiser_note IS NULL`, [`${DEMO_MARK}%`]);
    expect(marked.rows[0]!.n).toBe(0);
    const slugs = await db.client.query<{ n: number }>(`SELECT count(*)::int n FROM app.content_publications WHERE slug NOT LIKE 'demo-%'`);
    expect(slugs.rows[0]!.n).toBe(0);
  });

  it('повтор не плодит дубли ни строк, ни версий, ни аудита – и в другой день тоже', async () => {
    const before = await counts();
    const again = await seedContent(pool, { env: { APP_ENV: 'stage' }, mediaDir }, clock);
    expect(again.created).toEqual({ media: 0, publications: 0, games: 0, availability: 0, pages: 0, campaigns: 0 });
    expect(again.publicationIds).toEqual(first.publicationIds);
    expect(again.campaignIds.sort()).toEqual([...first.campaignIds].sort());
    expect(await counts()).toEqual(before);
    await seedContent(pool, { env: { APP_ENV: 'dev' }, mediaDir }, fixedClock('2026-11-20T05:00:00Z'));
    expect(await counts()).toEqual(before);
  });
});

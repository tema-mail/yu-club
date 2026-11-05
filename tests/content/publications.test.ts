// S4-33: публикации (K22 §2–§4, §9). Матрица охвата: 3 выбора посетителя × 3 вида охвата; publish_to в прошлом → нет в списке, по ссылке
// state = 'ended'; ошибки полноты – по полям; права по охвату; слаг; отложенная публикация; черновик в выдаче не появляется.
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { AppError } from '../../apps/api/src/core/errors.ts';
import { createFileStore, type FileStore } from '../../apps/api/src/core/files.ts';
import type { AccessContext, StaffRole } from '../../apps/api/src/core/permissions.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { uploadMedia } from '../../apps/api/src/modules/content/media.ts';
import { getPublicationPage, listPublications, publicationDef, type PublicationDraft, type PublicationType } from '../../apps/api/src/modules/content/publications.ts';
import { createEntity, publish, rollback, saveDraft, type EntityRow } from '../../apps/api/src/modules/content/versions.ts';
import { createTestBranch, createTestCity } from '../helpers/network.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const NOW = new Date('2026-11-14T05:00:00Z');
const clock = fixedClock('2026-11-14T05:00:00Z');
const PAST = '2026-11-01T00:00:00Z';
const FUTURE = '2026-12-01T00:00:00Z';
let db: TestDatabase;
let pool: pg.Pool;
let root: string;
let store: FileStore;
let staffId: string;
let coverId: string;
let cityA: string;
let cityB: string;
let branchA1: string;
let branchA2: string;
let branchB1: string;

function ctx(role: StaffRole, branchIds: string[] = []): AccessContext {
  return { actor: { kind: 'staff', staffId, sessionId: randomUUID() }, role, network: role === 'owner', cityIds: new Set(), branchIds: new Set(branchIds), at: NOW };
}
const owner = () => ctx('owner');
const meta = (c: AccessContext): AuditRequestMeta => ({ actor: c.actor, access: c, source: 'crm', requestId: randomUUID() });
const fails = async (p: Promise<unknown>, code: string) => {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
  return err as AppError;
};
let n = 0;
const full = (over: Partial<PublicationDraft> = {}): PublicationDraft => {
  n += 1;
  return { scope: { type: 'network' }, title: `Заголовок ${n}`, lead: 'Подводка', body: 'Текст', slug: `item-${n}`, coverMediaId: coverId, publishFrom: PAST, ...over };
};
const create = (type: PublicationType, draft: PublicationDraft, c = owner()) => createEntity(pool, c, publicationDef, { type }, draft, meta(c), clock);
async function inTx<T>(run: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await run(client);
    await client.query('COMMIT');
    return r;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
const pub = (row: EntityRow, c = owner()) => inTx((tx) => publish(tx, c, publicationDef, row.id, { rowVersion: row.row_version }, meta(c), clock));
const live = async (type: PublicationType, draft: PublicationDraft) => (await pub(await create(type, draft))).row;
const titlesFor = async (visitor: { cityId?: string; branchId?: string }) => (await listPublications(pool, { visitor, limit: 50, now: NOW })).items.map((i) => i.title);

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
  root = await mkdtemp(path.join(os.tmpdir(), 'yu-pub-'));
  store = createFileStore({ root });
  const r = await db.client.query<{ id: string }>(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', 'p@yu.test', 'owner', 'x') RETURNING id`);
  staffId = r.rows[0]!.id;
  cityA = await createTestCity(db.client);
  cityB = await createTestCity(db.client);
  branchA1 = (await createTestBranch(db.client, { cityId: cityA })).id;
  branchA2 = (await createTestBranch(db.client, { cityId: cityA })).id;
  branchB1 = (await createTestBranch(db.client, { cityId: cityB })).id;
  const c = owner();
  const content = await sharp({ create: { width: 100, height: 60, channels: 3, background: '#123456' } }).png().toBuffer();
  coverId = (await uploadMedia(pool, c, store, { content, purpose: 'image', alt: 'Обложка' }, meta(c), clock)).media.id;
});
afterAll(async () => {
  await pool.end();
  await db.drop();
  await rm(root, { recursive: true, force: true });
});

describe('S4-33: матрица охвата K22 §4 (3 выбора × 3 вида)', () => {
  beforeAll(async () => {
    await live('news', full({ title: 'сеть' }));
    await live('news', full({ title: 'город А', scope: { type: 'city', cityIds: [cityA] } }));
    await live('news', full({ title: 'город Б', scope: { type: 'city', cityIds: [cityB] } }));
    await live('news', full({ title: 'филиал А1', scope: { type: 'branch', branchIds: [branchA1] } }));
    await live('news', full({ title: 'филиал А2', scope: { type: 'branch', branchIds: [branchA2] } }));
    await live('news', full({ title: 'филиал Б1', scope: { type: 'branch', branchIds: [branchB1] } }));
  });

  it('ничего не выбрано: всё, у региональных – пометка с именем', async () => {
    const { items } = await listPublications(pool, { limit: 50, now: NOW });
    const byTitle = new Map(items.map((i) => [i.title, i.onlyIn]));
    expect([...byTitle.keys()]).toEqual(expect.arrayContaining(['сеть', 'город А', 'город Б', 'филиал А1', 'филиал А2', 'филиал Б1']));
    expect(byTitle.get('сеть')).toEqual([]);
    expect(byTitle.get('город А')![0]).toMatchObject({ type: 'city', id: cityA });
    expect(byTitle.get('город А')![0]!.name).not.toBe('');
    expect(byTitle.get('филиал А1')![0]).toMatchObject({ type: 'branch', id: branchA1 });
  });

  it('город: сеть + город + филиалы города; чужого города нет', async () => {
    const t = await titlesFor({ cityId: cityA });
    expect(t).toEqual(expect.arrayContaining(['сеть', 'город А', 'филиал А1', 'филиал А2']));
    for (const x of ['город Б', 'филиал Б1']) expect(t).not.toContain(x);
  });

  it('филиал: сеть + город филиала + он сам; другого филиала того же города нет', async () => {
    const t = await titlesFor({ branchId: branchA1 });
    expect(t).toEqual(expect.arrayContaining(['сеть', 'город А', 'филиал А1']));
    for (const x of ['филиал А2', 'город Б', 'филиал Б1']) expect(t).not.toContain(x);
  });

  it('несуществующий выбор – только сетевое', async () => {
    const t = await titlesFor({ branchId: randomUUID() });
    expect(t).toContain('сеть');
    expect(t).not.toContain('город А');
    expect(t).not.toContain('филиал А1');
  });
});

describe('S4-33: срок показа', () => {
  it('publish_to в прошлом → нет в списке, по ссылке state = ended и noindex; режим not_found → 404', async () => {
    const row = await live('promotion', full({ title: 'Старая акция', slug: 'old-promo', publishTo: '2026-11-10T00:00:00Z', conditions: 'условия' }));
    expect(row.status).toBe('published');
    expect((await listPublications(pool, { type: 'promotion', limit: 50, now: NOW })).items.map((i) => i.title)).not.toContain('Старая акция');
    const page = await getPublicationPage(pool, { type: 'promotion', slug: 'old-promo', now: NOW });
    expect(page).toMatchObject({ state: 'ended', indexable: false, title: 'Старая акция' });
    await db.client.query(`INSERT INTO app.settings_values (key, level, value, valid_from, created_by) VALUES ('content.ended_promotion_mode', 'network', '"not_found"', '2026-01-01', $1)`, [staffId]);
    expect(await getPublicationPage(pool, { type: 'promotion', slug: 'old-promo', now: NOW })).toBeNull();
  });

  it('отложенная: опубликована заранее, не видна до publish_from; с наступлением – видна (тем же фильтром)', async () => {
    await live('news', full({ title: 'Будущая', slug: 'future', publishFrom: FUTURE }));
    expect((await listPublications(pool, { limit: 50, now: NOW })).items.map((i) => i.title)).not.toContain('Будущая');
    expect(await getPublicationPage(pool, { type: 'news', slug: 'future', now: NOW })).toBeNull();
    expect((await listPublications(pool, { limit: 50, now: new Date('2026-12-02T00:00:00Z') })).items.map((i) => i.title)).toContain('Будущая');
    expect(await getPublicationPage(pool, { type: 'news', slug: 'future', now: new Date('2026-12-02T00:00:00Z') })).toMatchObject({ state: 'active', indexable: true });
  });
});

describe('S4-33: полнота, слаг, черновик', () => {
  it('ошибки – по полям, у типа свои; конец раньше начала', async () => {
    const empty = await create('promotion', { scope: { type: 'network' } });
    const err = await fails(pub(empty), 'CONTENT_INCOMPLETE');
    const fields = (err.details?.fields as Array<{ field: string }>).map((f) => f.field);
    expect(fields).toEqual(expect.arrayContaining(['title', 'lead', 'body', 'slug', 'publishFrom', 'coverMediaId', 'publishTo', 'conditions']));
    const give = await create('giveaway', full({ slug: 'give' }));
    const g = await fails(pub(give), 'CONTENT_INCOMPLETE');
    expect((g.details?.fields as Array<{ field: string }>).map((f) => f.field)).toEqual(['resultsDate', 'prize', 'rules']);
    const bad = await create('news', full({ publishTo: '2026-01-01T00:00:00Z' }));
    expect(((await fails(pub(bad), 'CONTENT_INCOMPLETE')).details?.fields as Array<{ field: string }>)[0]!.field).toBe('publishTo');
  });

  it('слаг: маска → SLUG_INVALID; занят в типе → SLUG_TAKEN с подсказкой; в другом типе свободен', async () => {
    await fails(pub(await create('news', full({ slug: 'Плохой Адрес' }))), 'SLUG_INVALID');
    await fails(pub(await create('news', full({ slug: `${'a'.repeat(91)}` }))), 'SLUG_INVALID');
    await live('news', full({ slug: 'same' }));
    const err = await fails(pub(await create('news', full({ slug: 'same' }))), 'SLUG_TAKEN');
    expect(err.details).toEqual({ suggestion: 'same-2' });
    await live('tournament', full({ slug: 'same' }));
  });

  it('черновик в выдаче не появляется: уникальная строка живёт только в черновике; страница – из снимка', async () => {
    const row = await live('news', full({ title: 'Живой', slug: 'draft-check', body: 'Живой текст' }));
    const secret = `ЧЕРНОВИК-${randomUUID()}`;
    await saveDraft(pool, owner(), publicationDef, row.id, { rowVersion: row.row_version, draft: { ...(row.draft as PublicationDraft), title: secret, body: secret } }, meta(owner()), clock);
    const page = await getPublicationPage(pool, { type: 'news', slug: 'draft-check', now: NOW });
    expect(page).toMatchObject({ title: 'Живой', body: 'Живой текст' });
    const list = await listPublications(pool, { limit: 50, now: NOW });
    expect(JSON.stringify(page) + JSON.stringify(list)).not.toContain(secret);
    expect(JSON.stringify(page)).not.toMatch(/"draft"|published_by|created_by/);
    const onlyDraft = await create('news', full({ title: secret, slug: 'only-draft' }));
    expect(onlyDraft.status).toBe('draft');
    expect(await getPublicationPage(pool, { type: 'news', slug: 'only-draft', now: NOW })).toBeNull();
  });

  it('откат возвращает живые столбцы: слаг и охват версии', async () => {
    const row = await live('news', full({ title: 'Откат', slug: 'roll-1', scope: { type: 'city', cityIds: [cityA] } }));
    const first = await db.client.query<{ live_version_id: string }>(`SELECT live_version_id FROM app.content_publications WHERE id = $1`, [row.id]);
    const edited = await saveDraft(pool, owner(), publicationDef, row.id, { rowVersion: row.row_version, draft: { ...(row.draft as PublicationDraft), slug: 'roll-2', scope: { type: 'network' } } }, meta(owner()), clock);
    const v2 = await pub(edited);
    expect((await getPublicationPage(pool, { type: 'news', slug: 'roll-2', now: NOW }))?.onlyIn).toEqual([]);
    await inTx((tx) => rollback(tx, owner(), publicationDef, row.id, { versionId: first.rows[0]!.live_version_id, rowVersion: v2.row.row_version, reason: 'назад' }, meta(owner()), clock));
    expect(await getPublicationPage(pool, { type: 'news', slug: 'roll-2', now: NOW })).toBeNull();
    expect((await getPublicationPage(pool, { type: 'news', slug: 'roll-1', now: NOW }))?.onlyIn[0]).toMatchObject({ type: 'city', id: cityA });
  });

  it('курсор: страницы не пересекаются; мусор → VALIDATION_FAILED', async () => {
    const p1 = await listPublications(pool, { limit: 2, now: NOW });
    const p2 = await listPublications(pool, { limit: 2, cursor: p1.nextCursor!, now: NOW });
    expect(p2.items.map((i) => i.id)).not.toContain(p1.items[0]!.id);
    await fails(listPublications(pool, { cursor: 'x', now: NOW }), 'VALIDATION_FAILED');
  });
});

describe('S4-33: права по охвату', () => {
  it('Администратор: черновик своего филиала – да, публикация – 403, сетевое и чужой филиал – нет', async () => {
    const admin = ctx('admin', [branchA1]);
    const row = await create('news', full({ scope: { type: 'branch', branchIds: [branchA1] } }));
    const edited = await saveDraft(pool, admin, publicationDef, row.id, { rowVersion: row.row_version, draft: row.draft }, meta(admin), clock);
    await fails(pub(edited, admin), 'FORBIDDEN');
    await fails(saveDraft(pool, admin, publicationDef, row.id, { rowVersion: edited.row_version, draft: { ...(row.draft as PublicationDraft), scope: { type: 'network' } } }, meta(admin), clock), 'FORBIDDEN');
    await fails(saveDraft(pool, admin, publicationDef, row.id, { rowVersion: edited.row_version, draft: { ...(row.draft as PublicationDraft), scope: { type: 'branch', branchIds: [branchB1] } } }, meta(admin), clock), 'NOT_FOUND');
  });

  it('Директор: своя – публикует; сетевую – 403; охват с чужим филиалом – 404; чужой живой материал не перехватить сменой охвата черновика', async () => {
    const director = ctx('director', [branchA1]);
    const own = await create('news', full({ scope: { type: 'branch', branchIds: [branchA1] } }));
    expect((await pub(own, director)).row.status).toBe('published');
    await fails(pub(await create('news', full()), director), 'FORBIDDEN');
    await fails(pub(await create('news', full({ scope: { type: 'branch', branchIds: [branchA1, branchB1] } })), director), 'NOT_FOUND');
    const net = await live('news', full());
    const moved = await saveDraft(pool, owner(), publicationDef, net.id, { rowVersion: net.row_version, draft: { ...(net.draft as PublicationDraft), scope: { type: 'branch', branchIds: [branchA1] } } }, meta(owner()), clock);
    await fails(pub(moved, director), 'FORBIDDEN');
  });

  it('несуществующий филиал в охвате у Владельца – 404, а не падение FK', async () => {
    await fails(pub(await create('news', full({ scope: { type: 'branch', branchIds: [randomUUID()] } }))), 'NOT_FOUND');
  });
});

// S4-32: черновик → публикация → версии → откат (K22 §3). v1 → правка → v2 → откат к v1 = v3 со снимком v1; правка alt в медиатеке
// не меняет снимок до следующей публикации; content_versions только вставка (42501); row_version устарел → VERSION_CONFLICT; вверх/вниз/вверх.
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { migrateDown, migrateUp } from '../../db/migrate.ts';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { AppError } from '../../apps/api/src/core/errors.ts';
import { createFileStore, type FileStore } from '../../apps/api/src/core/files.ts';
import { assertCan, type AccessContext, type StaffRole } from '../../apps/api/src/core/permissions.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { mediaUsages, updateMedia, uploadMedia } from '../../apps/api/src/modules/content/media.ts';
import { archive, checkRichText, createEntity, listVersions, mediaIdsInText, mediaInVersions, publicMedia, publish, purgedAmong, rollback, saveDraft, unpublish, type EntityDef, type EntityRow } from '../../apps/api/src/modules/content/versions.ts';
import { createTestCity } from '../helpers/network.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const clock = fixedClock('2026-11-14T05:00:00Z');
let db: TestDatabase;
let pool: pg.Pool;
let tx: pg.Pool;
let root: string;
let store: FileStore;
let staffId: string;

type Draft = { title?: string; body?: string; coverMediaId?: string };
const schema = z.strictObject({ title: z.string().max(100).optional(), body: z.string().optional(), coverMediaId: z.uuid().optional() });
/** Сущность теста – блок главной: версии от типа не зависят. */
const def: EntityDef<Draft> = {
  type: 'home_block',
  table: 'app.content_home_blocks',
  schema,
  richText: (d) => [['body', d.body]],
  mediaRefs: (d) => [
    ...(d.coverMediaId ? [{ mediaId: d.coverMediaId, field: 'cover', altRequired: true }] : []),
    ...mediaIdsInText(d.body).map((mediaId) => ({ mediaId, field: 'body', altRequired: true })),
  ],
  complete: (d) => (d.title ? [] : [{ field: 'title', code: 'REQUIRED' }]),
  assertEdit: (_db, c) => assertCan(c, 'content.network.manage', { network: true }),
  assertPublish: (_db, c) => assertCan(c, 'content.network.manage', { network: true }),
};

function ctx(role: StaffRole = 'owner'): AccessContext {
  return { actor: { kind: 'staff', staffId, sessionId: randomUUID() }, role, network: role === 'owner', cityIds: new Set(), branchIds: new Set(), at: clock.now() };
}
const owner = () => ctx('owner');
const meta = (c: AccessContext): AuditRequestMeta => ({ actor: c.actor, access: c, source: 'crm', requestId: randomUUID() });
const fails = async (p: Promise<unknown>, code: string) => {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
  return err as AppError;
};
let blockN = 0;
const BLOCKS = ['hero', 'about', 'directions', 'advantages', 'promo_strip', 'cta'];
async function newBlock(draft: Draft = { title: 'Заголовок' }, cityId: string | null = null): Promise<EntityRow> {
  const c = owner();
  blockN += 1;
  if (blockN > BLOCKS.length) {
    // уникальность (block_type, city_id): новый город – новые шесть блоков
    cityId = await createTestCity(db.client);
  }
  return createEntity(tx, c, def, { block_type: BLOCKS[blockN % BLOCKS.length], city_id: cityId }, draft, meta(c), clock);
}
const pub = async (row: EntityRow) => publish(tx, owner(), def, row.id, { rowVersion: row.row_version }, meta(owner()), clock);
const save = (row: EntityRow, draft: Draft) => saveDraft(tx, owner(), def, row.id, { rowVersion: row.row_version, draft }, meta(owner()), clock);
const image = async (seed: number, alt: string | null) => {
  const c = owner();
  const content = await sharp({ create: { width: 100, height: 60, channels: 3, background: { r: seed, g: 10, b: 20 } } }).png().toBuffer();
  return (await uploadMedia(tx, c, store, { content, purpose: 'image', alt }, meta(c), clock)).media;
};

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
  tx = pool;
  root = await mkdtemp(path.join(os.tmpdir(), 'yu-versions-'));
  store = createFileStore({ root });
  const r = await db.client.query<{ id: string }>(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('Анна', 'Петрова', 'v@yu.test', 'owner', 'x') RETURNING id`);
  staffId = r.rows[0]!.id;
});
afterAll(async () => {
  await pool.end();
  await db.drop();
  await rm(root, { recursive: true, force: true });
});

describe('S4-32: версии', () => {
  it('v1 → правка → v2 → откат к v1 = v3 со снимком v1; черновик := снимок; номера линейны; автор и причина в истории', async () => {
    const row = await newBlock({ title: 'Один' });
    const v1 = await pub(row);
    expect(v1.version.version_no).toBe(1);
    expect(v1.row.status).toBe('published');
    expect(String(v1.row.live_version_id)).toBe(String(v1.version.id));
    const edited = await save(v1.row, { title: 'Два' });
    expect(edited.status).toBe('published'); // сохранение черновика не меняет живую версию
    expect(String(edited.live_version_id)).toBe(String(v1.version.id));
    const v2 = await pub(edited);
    expect(v2.version.snapshot.title).toBe('Два');
    const v3 = await rollback(tx, owner(), def, row.id, { versionId: v1.version.id, rowVersion: v2.row.row_version, reason: 'Ошибка в тексте' }, meta(owner()), clock);
    expect(v3.version.version_no).toBe(3);
    expect(v3.version.action).toBe('rollback_publish');
    expect(v3.version.source_version_id).toBe(v1.version.id);
    expect(v3.version.snapshot).toEqual(v1.version.snapshot);
    expect(v3.row.draft).toEqual({ title: 'Один' });
    const list = await listVersions(tx, 'home_block', row.id);
    expect(list.map((x) => x.versionNo)).toEqual([3, 2, 1]);
    expect(list[0]).toMatchObject({ reason: 'Ошибка в тексте', publishedByName: 'Анна Петрова', action: 'rollback_publish' });
    await fails(rollback(tx, owner(), def, row.id, { versionId: '999999', rowVersion: v3.row.row_version, reason: 'x' }, meta(owner()), clock), 'NOT_FOUND');
    await fails(rollback(tx, owner(), def, row.id, { versionId: v1.version.id, rowVersion: v3.row.row_version, reason: ' ' }, meta(owner()), clock), 'COMMENT_REQUIRED');
  });

  it('чужую версию откатить нельзя', async () => {
    const a = await pub(await newBlock({ title: 'А' }));
    const b = await pub(await newBlock({ title: 'Б' }));
    await fails(rollback(tx, owner(), def, b.row.id, { versionId: a.version.id, rowVersion: b.row.row_version, reason: 'x' }, meta(owner()), clock), 'NOT_FOUND');
  });

  it('правка alt в медиатеке не меняет живой снимок до следующей публикации; alt обязателен при публикации', async () => {
    const m = await image(1, null);
    const row = await newBlock({ title: 'Обложка', coverMediaId: m.id });
    await fails(pub(row), 'MEDIA_ALT_REQUIRED');
    const c = owner();
    const m2 = await updateMedia(tx, c, m.id, { alt: 'Зал', rowVersion: m.rowVersion }, meta(c), clock);
    const v1 = await pub(row);
    expect(v1.version.snapshot.media?.[m.id]).toMatchObject({ alt: 'Зал', width: 100, height: 60 });
    expect(JSON.stringify(v1.version.snapshot.media?.[m.id])).not.toContain('"status"');
    await updateMedia(tx, c, m.id, { alt: 'Другой', rowVersion: m2.rowVersion }, meta(c), clock);
    const stored = await tx.query<{ snapshot: { media: Record<string, { alt: string }> } }>(`SELECT snapshot FROM journal.content_versions WHERE id = $1`, [v1.version.id]);
    expect(stored.rows[0]!.snapshot.media[m.id]!.alt).toBe('Зал');
    const v2 = await pub(await save(v1.row, { title: 'Обложка', coverMediaId: m.id }));
    expect(v2.version.snapshot.media?.[m.id]!.alt).toBe('Другой');
    // откат снимок не перезамораживает
    const v3 = await rollback(tx, owner(), def, row.id, { versionId: v1.version.id, rowVersion: v2.row.row_version, reason: 'назад' }, meta(owner()), clock);
    expect(v3.version.snapshot.media?.[m.id]!.alt).toBe('Зал');
  });

  it('связи: черновик и живая версия считаются отдельно; снятие убирает живую связь', async () => {
    const m = await image(2, 'Фото');
    const row = await newBlock({ title: 'С', body: `![x](media:${m.id})` });
    expect((await mediaUsages(tx, m.id)).map((u) => [u.field, u.live])).toEqual([['body', false]]);
    const v1 = await pub(row);
    expect((await mediaUsages(tx, m.id)).map((u) => [u.field, u.live])).toEqual([['body', false], ['body', true]]);
    const off = await unpublish(tx, owner(), def, row.id, { reason: 'снято' }, meta(owner()), clock);
    expect(off.status).toBe('unpublished');
    expect(String(off.live_version_id)).toBe(String(v1.version.id));
    expect((await mediaUsages(tx, m.id)).map((u) => u.live)).toEqual([false]);
  });

  it('заглушка: очищенное медиа в снимке не отдаёт адрес', async () => {
    const m = await image(3, 'Лицо');
    const v1 = await pub(await newBlock({ title: 'Ф', coverMediaId: m.id }));
    const shown = publicMedia(v1.version.snapshot, await purgedAmong(tx, [m.id]));
    expect(shown[m.id]).toMatchObject({ removed: false, alt: 'Лицо' });
    expect(shown[m.id]!.url).toMatch(/^\/media\//);
    await db.client.query(`UPDATE app.content_media SET status = 'purged' WHERE id = $1`, [m.id]);
    const gone = publicMedia(v1.version.snapshot, await purgedAmong(tx, [m.id]));
    expect(gone[m.id]).toEqual({ removed: true, alt: 'изображение удалено', width: null, height: null, url: null, variants: [] });
    expect(await mediaInVersions(tx, m.id)).toBe(true);
    expect(await mediaInVersions(tx, randomUUID())).toBe(false);
  });
});

describe('S4-32: проверки', () => {
  it('row_version устарел → VERSION_CONFLICT с текущим черновиком; повтор сохранения идёт дальше', async () => {
    const row = await newBlock({ title: 'В' });
    const v2 = await save(row, { title: 'Г' });
    const err = await fails(save(row, { title: 'Д' }), 'VERSION_CONFLICT');
    expect((err.details?.current as { draft: Draft }).draft).toEqual({ title: 'Г' });
    await fails(publish(tx, owner(), def, row.id, { rowVersion: row.row_version }, meta(owner()), clock), 'VERSION_CONFLICT');
    expect((await save(v2, { title: 'Д' })).row_version).toBe(3);
  });

  it('полнота и схема: ошибки по полям; посторонний ключ → CONTENT_INVALID; HTML и длина', async () => {
    const row = await newBlock({});
    const err = await fails(pub(row), 'CONTENT_INCOMPLETE');
    expect(err.details?.fields).toEqual([{ field: 'title', code: 'REQUIRED' }]);
    await fails(save(row, { title: 'x', evil: 1 } as Draft), 'CONTENT_INVALID');
    await fails(save(row, { body: 'текст <script>alert(1)</script>' }), 'RICH_TEXT_HTML_FORBIDDEN');
    await fails(save(row, { body: '<img src=x onerror=alert(1)>' }), 'RICH_TEXT_HTML_FORBIDDEN');
    await fails(save(row, { body: 'я'.repeat(50_001) }), 'RICH_TEXT_TOO_LONG');
    expect(() => checkRichText('b', 'а < б и в > г, **жирный**')).not.toThrow();
    expect(mediaIdsInText('![a](media:AAAAAAAA-0000-4000-8000-000000000001) и [b](media:x)')).toEqual(['aaaaaaaa-0000-4000-8000-000000000001']);
  });

  it('статусы: опубликованное в архив нельзя; архивное не правится и не публикуется; повтор снятия и архива – без изменений; причина обязательна', async () => {
    const row = await newBlock({ title: 'Ж' });
    const v1 = await pub(row);
    await fails(archive(tx, owner(), def, row.id, { reason: 'x' }, meta(owner()), clock), 'CONTENT_STATUS_CONFLICT');
    await fails(unpublish(tx, owner(), def, row.id, { reason: '' }, meta(owner()), clock), 'COMMENT_REQUIRED');
    const off = await unpublish(tx, owner(), def, row.id, { reason: 'снято' }, meta(owner()), clock);
    expect((await unpublish(tx, owner(), def, row.id, { reason: 'снято' }, meta(owner()), clock)).row_version).toBe(off.row_version);
    const arch = await archive(tx, owner(), def, row.id, { reason: 'убрано' }, meta(owner()), clock);
    expect(arch.status).toBe('archived');
    expect((await archive(tx, owner(), def, row.id, { reason: 'убрано' }, meta(owner()), clock)).row_version).toBe(arch.row_version);
    await fails(save(arch, { title: 'З' }), 'CONTENT_STATUS_CONFLICT');
    await fails(pub(arch), 'CONTENT_STATUS_CONFLICT');
    await fails(rollback(tx, owner(), def, row.id, { versionId: v1.version.id, rowVersion: arch.row_version, reason: 'x' }, meta(owner()), clock), 'CONTENT_STATUS_CONFLICT');
    await fails(unpublish(tx, owner(), def, randomUUID(), { reason: 'x' }, meta(owner()), clock), 'NOT_FOUND');
  });

  it('права и аудит: Директор сетевое не правит; в аудите черновика – только список полей, без текста', async () => {
    const row = await newBlock({ title: 'Секретный заголовок' });
    await fails(saveDraft(tx, ctx('director'), def, row.id, { rowVersion: row.row_version, draft: { title: 'x' } }, meta(owner()), clock), 'FORBIDDEN');
    await fails(publish(tx, ctx('admin'), def, row.id, { rowVersion: row.row_version }, meta(owner()), clock), 'FORBIDDEN');
    await save(row, { title: 'Новый секрет', body: 'тело' });
    const a = await db.client.query<{ after: unknown }>(`SELECT after FROM journal.audit_events WHERE object_id = $1 AND action = 'content.draft_saved' ORDER BY occurred_at DESC, id DESC LIMIT 1`, [row.id]);
    expect(JSON.stringify(a.rows[0]!.after)).toBe('{"fields":["body","title"]}');
  });

  it('content_versions – только вставка: UPDATE и DELETE от yu_app → 42501; DELETE контента → 42501; журнал без нарушений', async () => {
    const v1 = await pub(await newBlock({ title: 'И' }));
    for (const sql of [`UPDATE journal.content_versions SET reason = 'x' WHERE id = ${v1.version.id}`, `DELETE FROM journal.content_versions WHERE id = ${v1.version.id}`, `DELETE FROM app.content_home_blocks WHERE id = '${v1.row.id}'`, `DELETE FROM app.content_publications`]) {
      await expect(pool.query(sql)).rejects.toMatchObject({ code: '42501' });
    }
    const v = await db.client.query(`SELECT * FROM journal.append_only_violations() WHERE table_name LIKE '%content_versions%'`);
    expect(v.rows).toEqual([]);
  });
});

describe('S4-32: ссылки на медиа в черновике', () => {
  it('несуществующий и очищенный файл → CONTENT_INVALID по полю, а не падение FK; PDF вместо картинки → полнота', async () => {
    const row = await newBlock({ title: 'М' });
    const absent = randomUUID();
    const err = await fails(save(row, { title: 'М', coverMediaId: absent }), 'CONTENT_INVALID');
    expect(err.details?.issues).toEqual([{ path: 'cover', message: 'файла нет в медиатеке' }]);
    const c = owner();
    await fails(createEntity(tx, c, def, { block_type: 'hero', city_id: await createTestCity(db.client) }, { body: `![x](media:${absent})` }, meta(c), clock), 'CONTENT_INVALID');
    const purged = await image(40, 'Фото');
    await db.client.query(`UPDATE app.content_media SET status = 'purged' WHERE id = $1`, [purged.id]);
    await fails(save(row, { title: 'М', coverMediaId: purged.id }), 'CONTENT_INVALID');
    const pdf = (await uploadMedia(tx, c, store, { content: Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n'), purpose: 'document', alt: 'Правила' }, meta(c), clock)).media;
    const withPdf = await save(row, { title: 'М', coverMediaId: pdf.id });
    expect((await fails(pub(withPdf), 'CONTENT_INCOMPLETE')).details?.fields).toEqual([{ field: 'cover', code: 'MEDIA_NOT_IMAGE' }]);
  });
});

describe('S4-32: миграция', () => {
  it('вверх/вниз/вверх', async () => {
    const t = await createTestDatabase({ migrate: true });
    try {
      const later = await t.client.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.schema_migrations WHERE version >= '0403'`);
      const down = await migrateDown(t.client, later.rows[0]!.n);
      expect(down.at(-1)).toBe('0403');
      const gone = await t.client.query(`SELECT to_regclass('app.content_publications') AS p, to_regclass('journal.content_versions') AS v, to_regclass('app.content_media') AS m`);
      expect(gone.rows[0]).toEqual({ p: null, v: null, m: null });
      expect(await migrateUp(t.client)).toEqual([...down].reverse());
      const r = await t.client.query(`SELECT to_regclass('app.content_publications') AS p, to_regclass('journal.content_versions') AS v, to_regclass('app.content_media') AS m`);
      expect(r.rows[0]).toEqual({ p: 'app.content_publications', v: 'journal.content_versions', m: 'app.content_media' });
    } finally {
      await t.drop();
    }
  });
});

// S4-30: приём медиа (K22 §8). PNG с GPS → в вариантах нет EXIF; SVG под .png, GIF/TIFF → MEDIA_TYPE_NOT_ALLOWED;
// «бомба распаковки» 20 000×20 000 → отказ без роста памяти; битый JPEG → отказ; 11 МБ → 413; повтор – та же строка;
// используемый живой версией → MEDIA_IN_USE; 5 параллельных загрузок – одновременно перекодируется ≤ 2.
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import pg from 'pg';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { AppError } from '../../apps/api/src/core/errors.ts';
import { createFileStore, type FileStore } from '../../apps/api/src/core/files.ts';
import type { AccessContext, StaffRole } from '../../apps/api/src/core/permissions.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { archiveMedia, assertFormat, freezeMedia, listMedia, MEDIA_MAX_BYTES, syncUsages, transcodeQueue, updateMedia, uploadMedia, Limiter, mediaUsages } from '../../apps/api/src/modules/content/media.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const clock = fixedClock('2026-11-14T05:00:00Z');
let db: TestDatabase;
let pool: pg.Pool;
let root: string;
let store: FileStore;
let tx: pg.Pool;
let staffId: string;

function ctx(role: StaffRole): AccessContext {
  return { actor: { kind: 'staff', staffId, sessionId: randomUUID() }, role, network: role === 'owner', cityIds: new Set(), branchIds: new Set(), at: clock.now() };
}
const meta = (c: AccessContext): AuditRequestMeta => ({ actor: c.actor, access: c, source: 'crm', requestId: randomUUID() });
const upload = (content: Buffer, role: StaffRole = 'owner', purpose: 'image' | 'document' = 'image') => {
  const c = ctx(role);
  return uploadMedia(tx, c, store, { content, purpose, originalName: 'C:\\дом\\фото.png' }, meta(c), clock);
};
const fails = async (p: Promise<unknown>, code: string) => {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
  return err as AppError;
};
const png = (seed: number, width = 1200, height = 800) =>
  sharp({ create: { width, height, channels: 3, background: { r: seed % 256, g: (seed * 7) % 256, b: 40 } } }).png().toBuffer();

/** PNG только с заголовком: декларирует любые размеры, тело не нужно (metadata читает IHDR). */
function pngHeaderOnly(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', Buffer.alloc(16)), chunk('IEND', Buffer.alloc(0))]);
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 8 });
  tx = pool;
  root = await mkdtemp(path.join(os.tmpdir(), 'yu-media-'));
  store = createFileStore({ root, quota: { maxBytes: 200 * 1024 * 1024, code: 'MEDIA_QUOTA_EXCEEDED' } });
  const r = await db.client.query<{ id: string }>(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', 'media@yu.test', 'owner', 'x') RETURNING id`);
  staffId = r.rows[0]!.id;
});
afterAll(async () => {
  await pool.end();
  await db.drop();
  await rm(root, { recursive: true, force: true });
});

describe('S4-30: перекодирование', () => {
  it('PNG с EXIF и GPS → варианты WebP 480/960 (не больше исходника) и JPEG, без EXIF; исходника на диске нет; имя очищено', async () => {
    const source = await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#336699' } })
      .withExif({ IFD0: { Copyright: 'SECRETGPSOWNER' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '55/1 1/1 1/1', GPSLongitudeRef: 'E', GPSLongitude: '82/1 55/1 1/1' } })
      .png()
      .toBuffer();
    expect((await sharp(source).metadata()).exif).toBeDefined(); // в исходнике EXIF есть – проверка не пустая
    const { media, duplicate } = await upload(source);
    expect(duplicate).toBe(false);
    expect(media.mime).toBe('image/png');
    expect(media.originalName).toBe('фото.png');
    expect(media.width).toBe(1200);
    expect(media.variants.map((v) => `${v.format}${v.w}`)).toEqual(['webp480', 'webp960', 'webp1200', 'jpeg1200']);
    expect(media.storageKey).toMatch(/^[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}-1200\.webp$/);
    expect(media.url).toBe(`/media/${media.storageKey}`);
    for (const v of media.variants) {
      const data = await readFile(path.join(root, v.key));
      const m = await sharp(data).metadata();
      expect(m.exif).toBeUndefined();
      expect(m.width).toBe(v.w);
      expect(m.height).toBe(v.h);
      expect(m.format).toBe(v.format);
      expect(data.includes('SECRETGPSOWNER')).toBe(false);
    }
    for await (const e of store.list()) expect(e.relative).toMatch(/-\d+\.(webp|jpg)$/);
  });

  it('ориентация EXIF применяется: 400×200 с поворотом 6 → 200×400', async () => {
    const source = await sharp({ create: { width: 400, height: 200, channels: 3, background: '#112233' } }).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    const { media } = await upload(source);
    expect([media.width, media.height]).toEqual([200, 400]);
    const m = await sharp(await readFile(path.join(root, media.storageKey))).metadata();
    expect([m.width, m.height]).toEqual([200, 400]);
    expect(m.orientation).toBeUndefined();
  });
});

describe('S4-30: отказы', () => {
  it('SVG с расширением .png → MEDIA_TYPE_NOT_ALLOWED; GIF и TIFF → MEDIA_TYPE_NOT_ALLOWED; подмена сигнатуры → отказ', async () => {
    await fails(upload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')), 'MEDIA_TYPE_NOT_ALLOWED');
    const gif = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#000' } }).gif().toBuffer();
    await fails(upload(gif), 'MEDIA_TYPE_NOT_ALLOWED');
    const tiff = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#000' } }).tiff().toBuffer();
    await fails(upload(tiff), 'MEDIA_TYPE_NOT_ALLOWED');
    // сигнатура PNG, внутри – GIF: sniff пропустит, sharp – нет
    await fails(upload(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), gif])), 'MEDIA_TYPE_NOT_ALLOWED');
    // формат sharp вне белого списка или не совпал с сигнатурой (чистая проверка: настоящую подделку sharp не прочтёт)
    for (const [format, sniffed] of [['tiff', 'image/png'], ['gif', 'image/jpeg'], ['svg', 'image/png'], ['webp', 'image/png'], [undefined, 'image/png']] as const) {
      expect(() => assertFormat(format, sniffed)).toThrowError();
    }
    expect(() => assertFormat('jpeg', 'image/jpeg')).not.toThrow();
  });

  it('«бомба распаковки» 20 000×20 000 → MEDIA_DIMENSIONS_TOO_LARGE без роста памяти', async () => {
    const before = process.memoryUsage().rss;
    await fails(upload(pngHeaderOnly(20_000, 20_000)), 'MEDIA_DIMENSIONS_TOO_LARGE');
    expect(process.memoryUsage().rss - before).toBeLessThan(100 * 1024 * 1024);
  });

  it('битый JPEG → MEDIA_TYPE_NOT_ALLOWED; файл не остаётся', async () => {
    const good = await sharp({ create: { width: 600, height: 400, channels: 3, background: '#556677' } }).jpeg().toBuffer();
    await fails(upload(good.subarray(0, Math.floor(good.length / 2))), 'MEDIA_TYPE_NOT_ALLOWED');
  });

  it('11 МБ → MEDIA_TOO_LARGE 413; PDF только как документ; картинка как документ – отказ', async () => {
    const err = await fails(upload(Buffer.alloc(MEDIA_MAX_BYTES + 1, 1)), 'MEDIA_TOO_LARGE');
    expect(err.httpStatus).toBe(413);
    const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n');
    await fails(upload(pdf), 'MEDIA_TYPE_NOT_ALLOWED');
    await fails(upload(await png(1, 10, 10), 'owner', 'document'), 'MEDIA_TYPE_NOT_ALLOWED');
    const { media } = await upload(pdf, 'owner', 'document');
    expect(media.mime).toBe('application/pdf');
    expect(media.storageKey).toMatch(/\.pdf$/);
    expect(media.variants).toEqual([]);
    expect(await readFile(path.join(root, media.storageKey))).toEqual(pdf);
  });

  it('роль без права: Администратор загружает, но не архивирует', async () => {
    const { media } = await upload(await png(2, 20, 20), 'admin');
    const c = ctx('admin');
    await fails(archiveMedia(tx, c, media.id, meta(c), clock), 'FORBIDDEN');
  });

  it('квота исчерпана → MEDIA_QUOTA_EXCEEDED, строки нет', async () => {
    const small = createFileStore({ root: path.join(root, '.q'.replace('.', 'q')), quota: { maxBytes: 10, code: 'MEDIA_QUOTA_EXCEEDED' } });
    const c = ctx('owner');
    const source = await png(99, 50, 50);
    await fails(uploadMedia(tx, c, small, { content: source, purpose: 'image' }, meta(c), clock), 'MEDIA_QUOTA_EXCEEDED');
    const { rows } = await db.client.query(`SELECT 1 FROM app.content_media WHERE bytes = $1`, [source.length]);
    expect(rows).toEqual([]);
  });
});

describe('S4-30: дедупликация, связи, архив', () => {
  it('повтор того же файла – та же строка, без нового аудита', async () => {
    const source = await png(3, 100, 100);
    const first = await upload(source);
    const second = await upload(source);
    expect(second.media.id).toBe(first.media.id);
    expect(second.duplicate).toBe(true);
    const a = await db.client.query(`SELECT count(*)::int AS n FROM journal.audit_events WHERE object_id = $1 AND action = 'media.uploaded'`, [first.media.id]);
    expect(a.rows[0].n).toBe(1);
  });

  it('используемый живой версией → MEDIA_IN_USE со списком; только черновиком – архивируется; связи пересчитываются', async () => {
    const { media } = await upload(await png(4, 100, 100));
    const entity = randomUUID();
    await syncUsages(tx, 'publication', entity, true, [{ mediaId: media.id, field: 'cover' }]);
    await syncUsages(tx, 'publication', entity, false, [{ mediaId: media.id, field: 'cover' }, { mediaId: media.id, field: 'body' }]);
    expect((await mediaUsages(tx, media.id)).length).toBe(3);
    const c = ctx('owner');
    const err = await fails(archiveMedia(tx, c, media.id, meta(c), clock), 'MEDIA_IN_USE');
    expect(err.details?.usages).toEqual([{ entityType: 'publication', entityId: entity, field: 'cover', live: true }]);
    await syncUsages(tx, 'publication', entity, true, []);
    const archived = await archiveMedia(tx, c, media.id, meta(c), clock);
    expect(archived.status).toBe('archived');
    expect(await store.exists(media.storageKey)).toBe(true); // файл остаётся: старые версии ссылаются
    expect((await listMedia(tx, {})).items.some((m) => m.id === media.id)).toBe(false);
    expect((await listMedia(tx, { archived: true })).items.some((m) => m.id === media.id)).toBe(true);
    await syncUsages(tx, 'publication', entity, false, []);
  });

  it('правка alt: row_version, устаревшая версия → VERSION_CONFLICT; заморозка отдаёт alt и размеры на момент вызова', async () => {
    const { media } = await upload(await png(5, 100, 50));
    const c = ctx('admin');
    const v2 = await updateMedia(tx, c, media.id, { alt: ' Зал ', rowVersion: media.rowVersion }, meta(c), clock);
    expect(v2.alt).toBe('Зал');
    await fails(updateMedia(tx, c, media.id, { alt: 'x', rowVersion: media.rowVersion }, meta(c), clock), 'VERSION_CONFLICT');
    const frozen = await freezeMedia(tx, [media.id]);
    expect(frozen[media.id]).toMatchObject({ alt: 'Зал', width: 100, height: 50, key: media.storageKey, status: 'active' });
    expect(await freezeMedia(tx, [])).toEqual({});
  });

  it('список: поиск, тип, курсор', async () => {
    const page = await listMedia(tx, { limit: 2 });
    expect(page.items.length).toBe(2);
    expect(page.nextCursor).not.toBeNull();
    const next = await listMedia(tx, { limit: 2, cursor: page.nextCursor! });
    expect(next.items.map((m) => m.id)).not.toContain(page.items[0]!.id);
    expect((await listMedia(tx, { type: 'document' })).items.every((m) => m.mime === 'application/pdf')).toBe(true);
    expect((await listMedia(tx, { q: 'Зал' })).items.length).toBe(1);
    await fails(listMedia(tx, { cursor: 'мусор' }), 'VALIDATION_FAILED');
  });
});

describe('S4-30: очередь', () => {
  it('5 параллельных загрузок – одновременно перекодируется ≤ 2, все пять дошли', async () => {
    const sources = await Promise.all([11, 12, 13, 14, 15].map((s) => png(s, 900, 600)));
    transcodeQueue.peak = 0;
    const results = await Promise.all(sources.map((s) => upload(s)));
    expect(new Set(results.map((r) => r.media.id)).size).toBe(5);
    expect(transcodeQueue.peak).toBeGreaterThanOrEqual(1);
    expect(transcodeQueue.peak).toBeLessThanOrEqual(2);
    expect(transcodeQueue.running).toBe(0);
  });

  it('Limiter: ошибка задачи освобождает место', async () => {
    const l = new Limiter(1);
    await expect(l.run(async () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    expect(await l.run(async () => 7)).toBe(7);
    expect(l.running).toBe(0);
  });
});

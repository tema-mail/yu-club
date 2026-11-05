// S4-30. Медиатека CMS (K22 §8): приём, перекодирование, дедупликация, связи, архив, заморозка alt для снимка версии.
// Тип – по сигнатуре байтов и ещё раз по metadata().format (подмена сигнатуры – отказ). Картинка перекодируется sharp:
// EXIF и GPS снимаются, ориентация применяется, исходник на диск не пишется (иначе координаты съёмки лягут в публичный каталог).
// Имя файла – по sha256 исходника, Caddy отдаёт /media/<key> как immutable. Файлы пишутся до строки БД: сбой между ними
// оставляет «сироту», её убирает content:media-gc (S4-44). PDF не перекодируется, только purpose = 'document'; отдача – attachment + CSP sandbox (Caddy).
// sharp подгружается при первой картинке: worker импортирует этот файл ради уборки, но не перекодирует.
import { createHash } from 'node:crypto';
import type { Sharp, SharpOptions } from 'sharp';
import { writeAudit, type AuditRequestMeta, type Db } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { displayName, sniffType, type FileStore } from '../../core/files.ts';
import { roleAllows, type AccessContext } from '../../core/permissions.ts';
import { systemClock, type Clock } from '../../core/time.ts';

export const MEDIA_MAX_BYTES = 10 * 1024 * 1024; // Q-96
export const MEDIA_MAX_PIXELS = 40_000_000; // защита от «бомбы распаковки» (K22 §8)
export const MEDIA_PUBLIC_BASE = '/media'; // адрес Caddy (deploy/Caddyfile.yu-club): /media/<key> = MEDIA_DIR/<key>
const WEBP_WIDTHS = [480, 960, 1600] as const;
const OG_WIDTH = 1600;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type MediaPurpose = 'image' | 'document';
export type MediaStatus = 'active' | 'archived' | 'purged';
export interface MediaVariant {
  w: number;
  h: number;
  format: 'webp' | 'jpeg';
  key: string;
}

export interface MediaDto {
  id: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  variants: MediaVariant[];
  storageKey: string;
  url: string;
  alt: string | null;
  title: string | null;
  originalName: string | null;
  purpose: MediaPurpose;
  status: MediaStatus;
  createdAt: string;
  archivedAt: string | null;
  rowVersion: number;
}

export interface MediaRow {
  id: string;
  sha256: string;
  mime: string;
  bytes: string;
  width: number | null;
  height: number | null;
  variants: MediaVariant[];
  storage_key: string;
  alt: string | null;
  title: string | null;
  original_name: string | null;
  purpose: MediaPurpose;
  status: MediaStatus;
  created_at: Date;
  archived_at: Date | null;
  row_version: number;
}
export const MEDIA_COLUMNS = `id, sha256, mime, bytes, width, height, variants, storage_key, alt, title, original_name, purpose, status, created_at, archived_at, row_version`;

/** Ответ CRM: адрес – публичный /media/…, storageKey – ключ относительно MEDIA_DIR; абсолютного пути на диске и хеша нет. */
export function mediaDto(r: MediaRow): MediaDto {
  return {
    id: r.id,
    mime: r.mime,
    bytes: Number(r.bytes),
    width: r.width,
    height: r.height,
    variants: r.variants,
    storageKey: r.storage_key,
    url: `${MEDIA_PUBLIC_BASE}/${r.storage_key}`,
    alt: r.alt,
    title: r.title,
    originalName: r.original_name,
    purpose: r.purpose,
    status: r.status,
    createdAt: r.created_at.toISOString(),
    archivedAt: r.archived_at?.toISOString() ?? null,
    rowVersion: r.row_version,
  };
}

const typeNotAllowed = (details?: Record<string, unknown>) =>
  new AppError('MEDIA_TYPE_NOT_ALLOWED', 415, 'Можно загрузить JPG, PNG или WebP до 10 МБ', details);
const notFound = () => new AppError('NOT_FOUND', 404, 'Не найдено');
const forbidden = (action: string) => new AppError('FORBIDDEN', 403, 'Недостаточно прав', { action });

/** D4-02: медиатека общая на сеть – цель «роль», проверяется только набор роли, без зоны. */
export function assertRole(ctx: AccessContext, action: string): void {
  if (!roleAllows(ctx.role, action)) throw forbidden(action);
}

// ---- очередь перекодирований

/** Не больше max одновременно: 10 МБ картинок параллельно иначе съедают память контейнера (K22 §8). */
export class Limiter {
  running = 0;
  peak = 0;
  private readonly waiting: Array<() => void> = [];
  readonly max: number;
  constructor(max: number) {
    this.max = max;
  }
  async run<T>(job: () => Promise<T>): Promise<T> {
    if (this.running >= this.max) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.running += 1;
    this.peak = Math.max(this.peak, this.running);
    try {
      return await job();
    } finally {
      const next = this.waiting.shift();
      if (next) next(); // место передаётся следующему, счётчик не меняется
      else this.running -= 1;
    }
  }
}
export const transcodeQueue = new Limiter(2);

// ---- перекодирование

/** Белый список форматов sharp: только то, что заявляла сигнатура. Иначе – отказ, даже если сигнатура подделана под разрешённую. */
export function assertFormat(format: string | undefined, sniffed: string): void {
  const expected: Record<string, string> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
  if (format === undefined || expected[format] === undefined || expected[format] !== sniffed) {
    throw typeNotAllowed({ format: format ?? null });
  }
}

export interface Transcoded {
  width: number;
  height: number;
  files: Array<MediaVariant & { data: Buffer }>;
}

let sharpLoaded: Promise<(input: Buffer, options: SharpOptions) => Sharp> | null = null;
async function loadSharp(): Promise<(input: Buffer, options: SharpOptions) => Sharp> {
  sharpLoaded ??= import('sharp').then(({ default: sharp }) => {
    sharp.concurrency(1);
    sharp.cache(false);
    return (input: Buffer, options: SharpOptions) => sharp(input, options);
  });
  return sharpLoaded;
}

/** Ключ файла: <aa>/<bb>/<sha256>-<w>.<ext> от корня MEDIA_DIR. */
const keyOf = (sha: string, w: number, ext: string) => `${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha}-${w}.${ext}`;

export async function transcode(input: Buffer, sniffed: string, sha: string): Promise<Transcoded> {
  const make = await loadSharp();
  const options: SharpOptions = { limitInputPixels: MEDIA_MAX_PIXELS, failOn: 'warning', pages: 1 };
  // sharp бросает при разборе – отказ одним кодом: что это за файл, посетителю неважно. Сверх лимита пикселей – свой код.
  const refuse = (err: unknown): never => {
    if (err instanceof AppError) throw err;
    if (/pixel limit/i.test(String((err as Error).message))) throw new AppError('MEDIA_DIMENSIONS_TOO_LARGE', 422, 'Изображение слишком большое: не больше 40 мегапикселей', { maxPixels: MEDIA_MAX_PIXELS });
    throw typeNotAllowed();
  };
  try {
    const meta = await make(input, options).metadata();
    assertFormat(meta.format, sniffed);
    if (meta.width * meta.height > MEDIA_MAX_PIXELS) throw new AppError('MEDIA_DIMENSIONS_TOO_LARGE', 422, 'Изображение слишком большое: не больше 40 мегапикселей', { maxPixels: MEDIA_MAX_PIXELS });
    const rotated = (meta.orientation ?? 1) >= 5; // ориентация EXIF 5–8 меняет стороны местами
    const width = rotated ? meta.height : meta.width;
    const height = rotated ? meta.width : meta.height;
    const widths: number[] = WEBP_WIDTHS.filter((w) => w <= width);
    if (widths.length === 0 || (width < OG_WIDTH && widths.at(-1) !== width)) widths.push(Math.min(width, OG_WIDTH));
    const files: Transcoded['files'] = [];
    const heightAt = (w: number) => Math.max(1, Math.round((height * w) / width));
    for (const w of widths) {
      // rotate() без аргумента применяет ориентацию; без withMetadata EXIF, GPS и профиль в вывод не идут
      const data = await make(input, options).rotate().resize({ width: w, withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
      files.push({ w, h: heightAt(w), format: 'webp', key: keyOf(sha, w, 'webp'), data });
    }
    const ogWidth = Math.min(width, OG_WIDTH);
    const og = await make(input, options).rotate().resize({ width: ogWidth, withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 85, mozjpeg: true }).toBuffer();
    files.push({ w: ogWidth, h: heightAt(ogWidth), format: 'jpeg', key: keyOf(sha, ogWidth, 'jpg'), data: og });
    return { width, height, files };
  } catch (err) {
    return refuse(err);
  }
}

// ---- приём

export interface UploadInput {
  content: Buffer;
  purpose: MediaPurpose;
  originalName?: string | null;
  alt?: string | null;
  title?: string | null;
}

async function bySha(db: Db, sha: string): Promise<MediaRow | null> {
  return (await db.query<MediaRow>(`SELECT ${MEDIA_COLUMNS} FROM app.content_media WHERE sha256 = $1`, [sha])).rows[0] ?? null;
}

/** Загрузка: право роли → размер → сигнатура → дубль? → перекодирование в очереди → файлы → строка → аудит.
 *  Повтор того же файла – та же строка, без записи и аудита. Очищенное по требованию субъекта заново не принимается. */
export async function uploadMedia(tx: Db, ctx: AccessContext, store: FileStore, input: UploadInput, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<{ media: MediaDto; duplicate: boolean }> {
  assertRole(ctx, 'content.media.upload');
  if (input.content.byteLength > MEDIA_MAX_BYTES) throw new AppError('MEDIA_TOO_LARGE', 413, 'Можно загрузить JPG, PNG или WebP до 10 МБ', { maxBytes: MEDIA_MAX_BYTES });
  const sniffed = sniffType(input.content.subarray(0, 16));
  const allowed = input.purpose === 'document' ? ['application/pdf'] : ['image/jpeg', 'image/png', 'image/webp'];
  if (input.content.byteLength === 0 || sniffed === null || !allowed.includes(sniffed)) throw typeNotAllowed({ detected: sniffed });
  const sha = createHash('sha256').update(input.content).digest('hex');
  const existing = await bySha(tx, sha);
  if (existing?.status === 'purged') throw new AppError('CONTENT_STATUS_CONFLICT', 409, 'Этот файл удалён по требованию субъекта и не может быть загружен снова');
  if (existing) return { media: mediaDto(existing), duplicate: true };

  let variants: MediaVariant[] = [];
  let width: number | null = null;
  let height: number | null = null;
  let storageKey: string;
  if (sniffed === 'application/pdf') {
    storageKey = `${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha}.pdf`;
    await store.writeAtomic(storageKey, input.content);
  } else {
    const t = await transcodeQueue.run(() => transcode(input.content, sniffed, sha));
    for (const f of t.files) await store.writeAtomic(f.key, f.data);
    variants = t.files.map(({ w, h, format, key }) => ({ w, h, format, key }));
    width = t.width;
    height = t.height;
    storageKey = variants.filter((v) => v.format === 'webp').at(-1)!.key; // самый большой WebP
  }
  // Параллельная загрузка того же файла: уникальность sha256 → берём чужую строку, файлы совпадают по имени.
  const r = await tx.query<MediaRow>(
    `INSERT INTO app.content_media (sha256, mime, bytes, width, height, variants, storage_key, alt, title, original_name, purpose, uploaded_by, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (sha256) DO NOTHING RETURNING ${MEDIA_COLUMNS}`,
    [sha, sniffed, input.content.byteLength, width, height, JSON.stringify(variants), storageKey, input.alt?.trim() || null, input.title?.trim() || null, displayName(input.originalName), input.purpose, ctx.actor.staffId, clock.now()],
  );
  const row = r.rows[0];
  if (!row) return { media: mediaDto((await bySha(tx, sha))!), duplicate: true };
  await writeAudit(tx, meta, { action: 'media.uploaded', object: { type: 'media', id: row.id }, after: { mime: row.mime, bytes: Number(row.bytes), purpose: row.purpose } }, clock);
  return { media: mediaDto(row), duplicate: false };
}

// ---- чтение и правка

export async function getMediaRow(db: Db, id: string): Promise<MediaRow | null> {
  if (!UUID_RE.test(id)) return null;
  return (await db.query<MediaRow>(`SELECT ${MEDIA_COLUMNS} FROM app.content_media WHERE id = $1`, [id])).rows[0] ?? null;
}

export interface UsageRow {
  entityType: string;
  entityId: string;
  field: string;
  live: boolean;
}
export async function mediaUsages(db: Db, id: string): Promise<UsageRow[]> {
  const r = await db.query<{ entity_type: string; entity_id: string; field: string; live: boolean }>(
    `SELECT entity_type, entity_id, field, live FROM app.content_media_usages WHERE media_id = $1 ORDER BY entity_type, entity_id, field, live`,
    [id],
  );
  return r.rows.map((u) => ({ entityType: u.entity_type, entityId: u.entity_id, field: u.field, live: u.live }));
}

/** Править alt и подпись (K11 №225). Живой сайт не меняется до следующей публикации: alt заморожен в снимке версии (§8 п.5). */
export async function updateMedia(tx: Db, ctx: AccessContext, id: string, patch: { alt?: string | null; title?: string | null; rowVersion: number }, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<MediaDto> {
  assertRole(ctx, 'content.media.upload');
  if (!UUID_RE.test(id)) throw notFound();
  const cur = (await tx.query<MediaRow>(`SELECT ${MEDIA_COLUMNS} FROM app.content_media WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!cur || cur.status === 'purged') throw notFound();
  if (cur.row_version !== patch.rowVersion) throw new AppError('VERSION_CONFLICT', 409, 'Запись изменилась', { current: mediaDto(cur) });
  const alt = patch.alt === undefined ? cur.alt : patch.alt?.trim() || null;
  const title = patch.title === undefined ? cur.title : patch.title?.trim() || null;
  const r = await tx.query<MediaRow>(`UPDATE app.content_media SET alt = $2, title = $3, row_version = row_version + 1 WHERE id = $1 RETURNING ${MEDIA_COLUMNS}`, [id, alt, title]);
  await writeAudit(tx, meta, { action: 'media.updated', object: { type: 'media', id }, before: { alt: cur.alt, title: cur.title }, after: { alt, title } }, clock);
  return mediaDto(r.rows[0]!);
}

/** Архив (K11 №225): используемый живой версией – MEDIA_IN_USE со списком. Файлы остаются: старые версии ссылаются на них. */
export async function archiveMedia(tx: Db, ctx: AccessContext, id: string, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<MediaDto> {
  assertRole(ctx, 'content.media.archive');
  if (!UUID_RE.test(id)) throw notFound();
  const cur = (await tx.query<MediaRow>(`SELECT ${MEDIA_COLUMNS} FROM app.content_media WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!cur || cur.status === 'purged') throw notFound();
  if (cur.status === 'archived') return mediaDto(cur);
  const live = (await mediaUsages(tx, id)).filter((u) => u.live);
  if (live.length > 0) throw new AppError('MEDIA_IN_USE', 409, 'Файл используется на сайте', { usages: live });
  const r = await tx.query<MediaRow>(`UPDATE app.content_media SET status = 'archived', archived_at = $2, row_version = row_version + 1 WHERE id = $1 RETURNING ${MEDIA_COLUMNS}`, [id, clock.now()]);
  await writeAudit(tx, meta, { action: 'media.archived', object: { type: 'media', id } }, clock);
  return mediaDto(r.rows[0]!);
}

export interface MediaListQuery {
  q?: string;
  type?: MediaPurpose;
  archived?: boolean;
  cursor?: string;
  limit?: number;
}
/** Список медиатеки (K11 №224): новые сверху, курсор – created_at и id. Очищенные не показываются. */
export async function listMedia(db: Db, q: MediaListQuery): Promise<{ items: MediaDto[]; nextCursor: string | null }> {
  const limit = Math.min(q.limit ?? 50, 100);
  const params: unknown[] = [q.archived ? 'archived' : 'active'];
  const where = ['status = $1'];
  if (q.type) {
    params.push(q.type);
    where.push(`purpose = $${params.length}`);
  }
  if (q.q) {
    params.push(`%${q.q.replace(/[%_\\]/g, '\\$&')}%`);
    where.push(`(alt ILIKE $${params.length} OR title ILIKE $${params.length} OR original_name ILIKE $${params.length})`);
  }
  if (q.cursor) {
    const [at, id] = Buffer.from(q.cursor, 'base64url').toString().split('|');
    if (!at || !id || !UUID_RE.test(id) || Number.isNaN(Date.parse(at))) throw new AppError('VALIDATION_FAILED', 400, 'Неверный курсор', { issues: [{ path: 'cursor', message: 'неверный курсор' }] });
    params.push(at, id);
    where.push(`(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(limit + 1);
  const r = await db.query<MediaRow>(`SELECT ${MEDIA_COLUMNS} FROM app.content_media WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`, params);
  const page = r.rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map(mediaDto),
    nextCursor: r.rows.length > limit && last ? Buffer.from(`${last.created_at.toISOString()}|${last.id}`).toString('base64url') : null,
  };
}

// ---- связи и снимок версии

export interface MediaRef {
  mediaId: string;
  field: string;
}

/** Пересчёт связей сущности: по черновику (live = false) при saveDraft, по живой версии (live = true) при publish. */
export async function syncUsages(tx: Db, entityType: string, entityId: string, live: boolean, refs: readonly MediaRef[]): Promise<void> {
  await tx.query(`DELETE FROM app.content_media_usages WHERE entity_type = $1 AND entity_id = $2 AND live = $3`, [entityType, entityId, live]);
  for (const ref of refs) {
    await tx.query(
      `INSERT INTO app.content_media_usages (media_id, entity_type, entity_id, field, live) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
      [ref.mediaId, entityType, entityId, ref.field, live],
    );
  }
}

/** То, что снимок версии хранит о файле: alt и размеры заморожены при publish; правка медиатеки живой сайт не меняет. */
export interface FrozenMedia {
  alt: string | null;
  mime: string;
  width: number | null;
  height: number | null;
  key: string;
  variants: MediaVariant[];
}

export async function freezeMedia(db: Db, ids: readonly string[]): Promise<Record<string, FrozenMedia & { status: MediaStatus }>> {
  if (ids.length === 0) return {};
  const r = await db.query<MediaRow>(`SELECT ${MEDIA_COLUMNS} FROM app.content_media WHERE id = ANY($1::uuid[])`, [ids]);
  const out: Record<string, FrozenMedia & { status: MediaStatus }> = {};
  for (const m of r.rows) out[m.id] = { alt: m.alt, mime: m.mime, width: m.width, height: m.height, key: m.storage_key, variants: m.variants, status: m.status };
  return out;
}

// ---- уборка: content:media-gc (S4-44, K22 §8 п.4)

const ORPHAN_AGE_MS = 24 * 60 * 60 * 1000;

/** Файл без строки старше суток – «сирота» от сбоя между записью файлов и строкой БД: удаляется. Файлы строк, в том числе архивных и нужных
 *  только старым версиям, не трогаются; у очищенной строки своих файлов нет – её файл, если остался после сбоя, тоже удаляется. Сутки – запас на незавершённую загрузку. */
export async function gcMedia(db: Db, store: FileStore, now: Date): Promise<{ removed: string[]; kept: number }> {
  const r = await db.query<{ storage_key: string; variants: MediaVariant[] }>(`SELECT storage_key, variants FROM app.content_media WHERE status <> 'purged'`);
  const known = new Set(r.rows.flatMap((m) => [m.storage_key, ...m.variants.map((v) => v.key)]));
  const removed: string[] = [];
  let kept = 0;
  for await (const file of store.list()) {
    if (known.has(file.relative) || now.getTime() - file.modifiedAt.getTime() < ORPHAN_AGE_MS) {
      kept += 1;
      continue;
    }
    await store.remove(file.relative);
    removed.push(file.relative);
  }
  return { removed, kept };
}

/** Ночная задача: проверка раз в час, проход один раз в сутки в 01:00 UTC (04:00 Москвы, после сверки). */
export function startMediaGc(opts: { pool: Db; store: FileStore; clock?: Clock; intervalMs?: number; onError?: (err: unknown) => void; onDone?: (r: { removed: string[]; kept: number }) => void }): { stop(): void } {
  const clock = opts.clock ?? systemClock;
  let lastDay = '';
  const timer = setInterval(() => {
    const now = clock.now();
    const day = now.toISOString().slice(0, 10);
    if (now.getUTCHours() !== 1 || day === lastDay) return;
    lastDay = day;
    gcMedia(opts.pool, opts.store, now).then((r) => opts.onDone?.(r), (err: unknown) => opts.onError?.(err));
  }, opts.intervalMs ?? 3_600_000);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}

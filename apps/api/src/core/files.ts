// S3-06. Общий адаптер диска ядра и закрытые вложения Э3 (K19 §9, model-dannyh 0302).
// Адаптер (FileStore) – один на корень каталога: безопасный путь только внутри корня, атомарная запись (временный файл
// в <корень>/.tmp → fsync → rename → fsync каталога), адрес по sha256, тип по сигнатуре первых байтов, а не по заявленному
// MIME. Э4 его не пишет заново, а расширяет (S4-06: квота, корни MEDIA_DIR / EXPORT_DIR; медиа CMS – content/media.ts).
// Вложения поверх адаптера: каталог ATTACHMENTS_DIR вне веб-корня (Caddy его не раздаёт, S3-94), выдача – только через
// API с правом на объект-владелец (реестр registerAttachmentOwner), версия вместо замены (supersedes), ошибочная –
// status 'invalid' с причиной. Файл пишется до строки базы: откат транзакции оставляет безвредный файл без строки (D3-06).
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, type ReadStream } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { writeAudit, type AuditRequestMeta, type Db } from './audit.ts';
import { AppError } from './errors.ts';
import type { AccessContext } from './permissions.ts';
import { resolveSettings } from './settings.ts';
import { systemClock, type Clock } from './time.ts';

// ---- распознавание типа по сигнатуре

/** Типы, которые адаптер распознаёт. Разрешённые для вложений – подмножество (attachments.mime_types, Q-96). */
export type SniffedType = 'image/jpeg' | 'image/png' | 'application/pdf' | 'image/webp' | 'image/gif';
const SNIFF_BYTES = 16;

const startsWith = (b: Uint8Array, sig: readonly number[], at = 0) => sig.every((x, i) => b[at + i] === x);

/** Тип по первым байтам; не распознан (в том числе исполняемый MZ/ELF) – null. */
export function sniffType(head: Uint8Array): SniffedType | null {
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(head, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf'; // %PDF-
  if (startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head, [0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  if (startsWith(head, [0x47, 0x49, 0x46, 0x38]) && (head[4] === 0x37 || head[4] === 0x39) && head[5] === 0x61) return 'image/gif';
  return null;
}

// ---- безопасный путь

export class UnsafePathError extends Error {
  constructor(relative: string) {
    super(`files: путь вне корня или недопустимый: ${JSON.stringify(relative)}`);
    this.name = 'UnsafePathError';
  }
}

const SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

/** Абсолютный путь внутри корня. Только относительный путь из безопасных сегментов: без «..», «.», обратной косой,
 *  нулевого байта, абсолютного начала; итог обязан лежать внутри корня (и после нормализации). */
export function safeJoin(root: string, relative: string): string {
  if (typeof relative !== 'string' || relative === '' || relative.includes('\0') || relative.includes('\\') || path.isAbsolute(relative)) {
    throw new UnsafePathError(relative);
  }
  const segments = relative.split('/');
  if (!segments.every((s) => SEGMENT_RE.test(s) && s !== '.' && s !== '..')) throw new UnsafePathError(relative);
  const base = path.resolve(root);
  const full = path.resolve(base, ...segments);
  if (!full.startsWith(base + path.sep)) throw new UnsafePathError(relative);
  return full;
}

// ---- адаптер диска

export type FileSource = Uint8Array | AsyncIterable<Uint8Array>;
export interface PutLimits {
  maxBytes: number;
  /** Разрешённые типы по сигнатуре; пусто – любые распознанные. */
  allowedTypes: readonly string[];
}
export interface StoredFile {
  storageKey: string; // '<sha[0:2]>/<sha256>'
  sha256: string;
  sizeBytes: number;
  mimeType: SniffedType;
}

export interface FileStore {
  readonly root: string;
  /** Записать по адресу содержимого. Лимит – по ходу записи (больше лимита на диск не попадает), тип – по сигнатуре. */
  putContent(source: FileSource, limits: PutLimits): Promise<StoredFile>;
  /** Атомарная запись по явному относительному пути (экспорты Э4). На месте итогового имени – либо прежний файл, либо новый целиком. */
  writeAtomic(relative: string, source: FileSource, opts?: { maxBytes?: number }): Promise<{ sizeBytes: number; sha256: string; head: Uint8Array }>;
  pathOf(relative: string): string;
  exists(relative: string): Promise<boolean>;
  read(relative: string): Promise<Buffer>;
  openRead(relative: string): ReadStream;
}

async function* chunks(source: FileSource): AsyncIterable<Uint8Array> {
  if (source instanceof Uint8Array) yield source;
  else yield* source;
}

const tooLarge = (maxBytes: number) => new AppError('ATTACHMENT_TOO_LARGE', 413, 'Файл больше допустимого размера', { maxBytes });

async function fsyncDir(dir: string): Promise<void> {
  const h = await open(dir, 'r');
  try {
    await h.sync();
  } finally {
    await h.close();
  }
}

export function createFileStore(opts: { root: string }): FileStore {
  const root = path.resolve(opts.root);
  const tmpDir = path.join(root, '.tmp');

  /** Временный файл → fsync → rename → fsync каталога. Любая ошибка посреди записи удаляет временный файл. */
  async function writeTemp(source: FileSource, maxBytes: number | undefined): Promise<{ tmp: string; sizeBytes: number; sha256: string; head: Uint8Array }> {
    await mkdir(tmpDir, { recursive: true, mode: 0o700 });
    const tmp = path.join(tmpDir, `${randomBytes(12).toString('hex')}.part`);
    const h = await open(tmp, 'wx', 0o600);
    const hash = createHash('sha256');
    let size = 0;
    const head = new Uint8Array(SNIFF_BYTES);
    let headLen = 0;
    try {
      for await (const chunk of chunks(source)) {
        size += chunk.byteLength;
        if (maxBytes !== undefined && size > maxBytes) throw tooLarge(maxBytes);
        if (headLen < SNIFF_BYTES) {
          const take = chunk.subarray(0, SNIFF_BYTES - headLen);
          head.set(take, headLen);
          headLen += take.byteLength;
        }
        hash.update(chunk);
        await h.write(chunk);
      }
      await h.sync();
      await h.close();
    } catch (err) {
      await h.close().catch(() => {});
      await rm(tmp, { force: true });
      throw err;
    }
    return { tmp, sizeBytes: size, sha256: hash.digest('hex'), head: head.subarray(0, headLen) };
  }

  async function commit(tmp: string, finalPath: string): Promise<void> {
    try {
      await mkdir(path.dirname(finalPath), { recursive: true, mode: 0o700 });
      await rename(tmp, finalPath);
      await fsyncDir(path.dirname(finalPath));
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  return {
    root,
    async putContent(source, limits) {
      const t = await writeTemp(source, limits.maxBytes);
      const mimeType = sniffType(t.head);
      if (t.sizeBytes === 0 || mimeType === null || (limits.allowedTypes.length > 0 && !limits.allowedTypes.includes(mimeType))) {
        await rm(t.tmp, { force: true });
        throw new AppError('ATTACHMENT_TYPE_NOT_ALLOWED', 415, 'Тип файла не разрешён', { allowed: limits.allowedTypes });
      }
      const storageKey = `${t.sha256.slice(0, 2)}/${t.sha256}`;
      await commit(t.tmp, safeJoin(root, storageKey)); // тот же адрес – то же содержимое: rename атомарно заменяет копию
      return { storageKey, sha256: t.sha256, sizeBytes: t.sizeBytes, mimeType };
    },
    async writeAtomic(relative, source, o = {}) {
      const finalPath = safeJoin(root, relative);
      const t = await writeTemp(source, o.maxBytes);
      await commit(t.tmp, finalPath);
      return { sizeBytes: t.sizeBytes, sha256: t.sha256, head: t.head };
    },
    pathOf: (relative) => safeJoin(root, relative),
    async exists(relative) {
      try {
        return (await stat(safeJoin(root, relative))).isFile();
      } catch (err) {
        if (err instanceof UnsafePathError) throw err;
        return false;
      }
    },
    read: (relative) => readFile(safeJoin(root, relative)),
    openRead: (relative) => createReadStream(safeJoin(root, relative)),
  };
}

// ---- вложения (K19 §9)

/** Право на объект-владелец: бросает NOT_FOUND (нет объекта или вне зоны) / FORBIDDEN (в зоне, нет права). */
export interface AttachmentOwner {
  canRead(db: Db, ctx: AccessContext, ownerId: string): Promise<void>;
  canWrite(db: Db, ctx: AccessContext, ownerId: string): Promise<void>;
}

const OWNER_TYPE_RE = /^[a-z][a-z_]{1,30}$/;
const owners = new Map<string, AttachmentOwner>();

/** Модуль-владелец регистрирует свой тип (equipment, repair, event) при старте. Без регистрации тип отклоняется. */
export function registerAttachmentOwner(type: string, owner: AttachmentOwner): void {
  if (!OWNER_TYPE_RE.test(type)) throw new Error(`registerAttachmentOwner: недопустимый тип «${type}»`);
  if (owners.has(type)) throw new Error(`registerAttachmentOwner: тип «${type}» уже зарегистрирован`);
  owners.set(type, owner);
}

export const DOC_TYPES = ['photo', 'receipt', 'check', 'invoice', 'act', 'warranty_card', 'waybill', 'service_report', 'other'] as const;
export type DocType = (typeof DOC_TYPES)[number];

export interface AttachmentDto {
  id: string;
  ownerType: string;
  ownerId: string;
  docType: DocType;
  sha256: string;
  sizeBytes: number;
  mimeType: string;
  originalName: string | null;
  comment: string | null;
  supersedes: string | null;
  status: 'active' | 'invalid';
  invalidReason: string | null;
  invalidatedAt: string | null;
  createdById: string | null;
  createdAt: string;
}

interface AttachmentRow {
  id: string;
  owner_type: string;
  owner_id: string;
  doc_type: DocType;
  storage_key: string;
  sha256: string;
  size_bytes: string;
  mime_type: string;
  original_name: string | null;
  comment: string | null;
  supersedes: string | null;
  status: 'active' | 'invalid';
  invalid_reason: string | null;
  invalidated_at: Date | null;
  created_by_id: string | null;
  created_at: Date;
}

const COLUMNS = `id, owner_type, owner_id, doc_type, storage_key, sha256, size_bytes, mime_type, original_name, comment, supersedes,
  status, invalid_reason, invalidated_at, created_by_id, created_at`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toDto(r: AttachmentRow): AttachmentDto {
  return {
    id: r.id,
    ownerType: r.owner_type,
    ownerId: r.owner_id,
    docType: r.doc_type,
    sha256: r.sha256,
    sizeBytes: Number(r.size_bytes),
    mimeType: r.mime_type,
    originalName: r.original_name,
    comment: r.comment,
    supersedes: r.supersedes,
    status: r.status,
    invalidReason: r.invalid_reason,
    invalidatedAt: r.invalidated_at?.toISOString() ?? null,
    createdById: r.created_by_id,
    createdAt: r.created_at.toISOString(),
  };
}

const notFound = () => new AppError('NOT_FOUND', 404, 'Не найдено');
const invalid = (message: string, field: string) => new AppError('VALIDATION_FAILED', 400, message, { issues: [{ path: field, message }] });

function ownerOf(type: string): AttachmentOwner {
  const o = owners.get(type);
  if (!o) throw invalid('Неизвестный тип объекта вложения', 'ownerType');
  return o;
}

/** Имя файла – только подпись: последний сегмент без управляющих символов, ≤ 255. Путь из него не строится никогда. */
export function displayName(name: string | null | undefined): string | null {
  if (!name) return null;
  const last = name.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex -- вырезаем управляющие символы
  const clean = last.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 255);
  return clean === '' || clean === '.' || clean === '..' ? null : clean;
}

async function loadRow(db: Db, id: string): Promise<AttachmentRow | null> {
  if (!UUID_RE.test(id)) return null;
  return (await db.query<AttachmentRow>(`SELECT ${COLUMNS} FROM app.attachments WHERE id = $1`, [id])).rows[0] ?? null;
}

export interface AddAttachmentInput {
  ownerType: string;
  ownerId: string;
  docType: string;
  content: FileSource;
  /** Content-Type запроса: должен совпасть с типом по сигнатуре (подмена MIME – отказ). */
  declaredType?: string | null;
  originalName?: string | null;
  comment?: string | null;
  /** Новая версия этого вложения (замены нет: прежняя строка остаётся, 10 §11). */
  supersedes?: string | null;
}

/** Добавить вложение: право записи владельца → лимит и типы из настроек → файл на диск → строка → аудит. */
export async function addAttachment(
  tx: Db,
  ctx: AccessContext,
  store: FileStore,
  input: AddAttachmentInput,
  meta: AuditRequestMeta,
  clock: Clock = systemClock,
): Promise<AttachmentDto> {
  const owner = ownerOf(input.ownerType);
  if (!UUID_RE.test(input.ownerId)) throw notFound();
  await owner.canWrite(tx, ctx, input.ownerId);
  if (!(DOC_TYPES as readonly string[]).includes(input.docType)) throw invalid('Неизвестный тип документа', 'docType');
  if (input.supersedes != null) {
    const prev = await loadRow(tx, input.supersedes);
    if (!prev || prev.owner_type !== input.ownerType || prev.owner_id !== input.ownerId) throw notFound();
  }
  const now = clock.now();
  const s = await resolveSettings(tx, ['attachments.max_bytes', 'attachments.mime_types'], { network: true }, now);
  const stored = await store.putContent(input.content, { maxBytes: s['attachments.max_bytes'].value, allowedTypes: s['attachments.mime_types'].value });
  const declared = input.declaredType?.split(';')[0]?.trim().toLowerCase();
  if (declared && declared !== 'application/octet-stream' && declared !== stored.mimeType) {
    throw new AppError('ATTACHMENT_TYPE_NOT_ALLOWED', 415, 'Тип файла не совпадает с содержимым', { declared, detected: stored.mimeType });
  }
  let row: AttachmentRow;
  try {
    await tx.query('SAVEPOINT attachment_add');
    row = (
      await tx.query<AttachmentRow>(
        `INSERT INTO app.attachments (owner_type, owner_id, doc_type, storage_key, sha256, size_bytes, mime_type, original_name, comment, supersedes,
                                      created_by_type, created_by_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'staff', $11, $12) RETURNING ${COLUMNS}`,
        [
          input.ownerType,
          input.ownerId,
          input.docType,
          stored.storageKey,
          stored.sha256,
          stored.sizeBytes,
          stored.mimeType,
          displayName(input.originalName),
          input.comment?.trim() || null,
          input.supersedes ?? null,
          ctx.actor.staffId,
          now,
        ],
      )
    ).rows[0]!;
    await tx.query('RELEASE SAVEPOINT attachment_add');
  } catch (err) {
    await tx.query('ROLLBACK TO SAVEPOINT attachment_add');
    if ((err as { code?: string }).code === '23505' && (err as { constraint?: string }).constraint === 'attachments_supersedes_key') {
      throw new AppError('VERSION_CONFLICT', 409, 'У этого вложения уже есть новая версия', { supersedes: input.supersedes });
    }
    throw err;
  }
  const dto = toDto(row);
  await writeAudit(
    tx,
    meta,
    { action: 'attachment.added', object: { type: 'attachment', id: dto.id }, after: { ownerType: dto.ownerType, ownerId: dto.ownerId, docType: dto.docType, sha256: dto.sha256, sizeBytes: dto.sizeBytes, mimeType: dto.mimeType, supersedes: dto.supersedes } },
    clock,
  );
  return dto;
}

/** Вложение для выдачи: право чтения владельца; чужое и несуществующее – одинаковый NOT_FOUND. */
export async function getAttachment(db: Db, ctx: AccessContext, id: string): Promise<{ attachment: AttachmentDto; storageKey: string }> {
  const row = await loadRow(db, id);
  if (!row) throw notFound();
  const owner = owners.get(row.owner_type);
  if (!owner) throw notFound();
  await owner.canRead(db, ctx, row.owner_id);
  return { attachment: toDto(row), storageKey: row.storage_key };
}

/** Все версии вложений объекта, новые сверху (недействительные – тоже, с причиной). */
export async function listAttachments(db: Db, ctx: AccessContext, ownerType: string, ownerId: string): Promise<AttachmentDto[]> {
  const owner = ownerOf(ownerType);
  if (!UUID_RE.test(ownerId)) throw notFound();
  await owner.canRead(db, ctx, ownerId);
  const r = await db.query<AttachmentRow>(`SELECT ${COLUMNS} FROM app.attachments WHERE owner_type = $1 AND owner_id = $2 ORDER BY created_at DESC, id`, [ownerType, ownerId]);
  return r.rows.map(toDto);
}

/** «Недействителен» с причиной (10 §11): файл и строка остаются; повтор – без изменений. */
export async function invalidateAttachment(
  tx: Db,
  ctx: AccessContext,
  id: string,
  input: { reason: string },
  meta: AuditRequestMeta,
  clock: Clock = systemClock,
): Promise<AttachmentDto> {
  const row = await loadRow(tx, id);
  if (!row) throw notFound();
  const owner = owners.get(row.owner_type);
  if (!owner) throw notFound();
  await owner.canWrite(tx, ctx, row.owner_id);
  const reason = input.reason?.trim() ?? '';
  if (reason === '') throw new AppError('COMMENT_REQUIRED', 422, 'Укажите причину', { field: 'reason' });
  const r = await tx.query<AttachmentRow>(
    `UPDATE app.attachments SET status = 'invalid', invalid_reason = $2, invalidated_by = $3, invalidated_at = $4
      WHERE id = $1 AND status = 'active' RETURNING ${COLUMNS}`,
    [row.id, reason, ctx.actor.staffId, clock.now()],
  );
  if (!r.rows[0]) return toDto((await loadRow(tx, row.id))!);
  const dto = toDto(r.rows[0]);
  await writeAudit(tx, meta, { action: 'attachment.invalidated', object: { type: 'attachment', id: dto.id }, reason }, clock);
  return dto;
}

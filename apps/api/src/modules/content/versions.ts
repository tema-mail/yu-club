// S4-32. Черновик, публикация, версии, откат (K22 §3) – общие для всех сущностей контента. Сущность описывает себя
// EntityDef (таблица, схема черновика, права, связи с медиа, полнота, живые столбцы), команды здесь одни.
// Черновик посетителю недоступен по построению: публичные чтения идут через snapshot версии и столбцы живой версии, а
// столбец draft они не выбирают. publish замораживает alt и размеры медиа в снимке: правка медиатеки живой сайт не меняет.
// Откат – новая версия с дословным снимком выбранной: история линейна, старые версии не меняются. Строка журнала только вставляется.
import type { ZodType } from 'zod';
import { writeAudit, type AuditObjectType, type AuditRequestMeta, type Db } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import type { AccessContext } from '../../core/permissions.ts';
import { systemClock, type Clock } from '../../core/time.ts';
import { freezeMedia, MEDIA_PUBLIC_BASE, syncUsages, type FrozenMedia, type MediaRef, type MediaVariant } from './media.ts';

export type EntityType = 'publication' | 'game' | 'room_page' | 'branch_page' | 'content_page' | 'home_block';
export type ContentStatus = 'draft' | 'published' | 'unpublished' | 'archived';

export interface EntityRow {
  id: string;
  status: ContentStatus;
  draft: Record<string, unknown>;
  draft_updated_at: Date;
  draft_updated_by: string;
  live_version_id: string | null;
  row_version: number;
  created_by: string;
  created_at: Date;
  archived_at: Date | null;
  [column: string]: unknown;
}

export interface FieldIssue {
  field: string;
  code: string;
}

/** Ссылка на медиа в черновике: alt обязателен при publish, если картинка не декоративная (K22 §8 п.5). */
export interface DraftMediaRef extends MediaRef {
  altRequired: boolean;
}

export interface EntityDef<D extends Record<string, unknown>> {
  type: EntityType;
  table: string;
  schema: ZodType<D>;
  /** Поля Markdown: размер и запрет сырого HTML – при saveDraft (K22 §6). */
  richText(draft: D): Array<[field: string, text: string | null | undefined]>;
  mediaRefs(draft: D): DraftMediaRef[];
  /** Проверка полноты перед publish (K22 §9): пусто – можно. */
  complete(draft: D, row: EntityRow): FieldIssue[];
  /** Право на черновик; при смене охвата – и на старый, и на новый (draft – новый черновик). */
  assertEdit(db: Db, ctx: AccessContext, row: EntityRow, draft: D): Promise<void> | void;
  /** Право на publish / unpublish / archive / rollback. */
  assertPublish(db: Db, ctx: AccessContext, row: EntityRow, draft: D): Promise<void> | void;
  /** Столбцы живой версии и связанные строки (охват, слаг) – только здесь и только из publish. */
  applyLive?(tx: Db, row: EntityRow, draft: D, ctx: AccessContext): Promise<void>;
  /** Что добавить к снимку сверх черновика (например, версия документа). */
  snapshotExtra?(draft: D, row: EntityRow): Record<string, unknown>;
}

export interface VersionRow {
  id: string;
  version_no: number;
  snapshot: Snapshot;
  action: 'publish' | 'rollback_publish';
  published_by: string;
  published_at: Date;
  reason: string | null;
  source_version_id: string | null;
}

/** То, что видит посетитель: поля черновика на момент публикации + замороженные медиа. */
export type Snapshot = Record<string, unknown> & { media?: Record<string, FrozenMedia> };

export interface DraftDto {
  id: string;
  status: ContentStatus;
  draft: Record<string, unknown>;
  rowVersion: number;
  liveVersionId: string | null;
  draftUpdatedAt: string;
  draftUpdatedBy: string;
  createdAt: string;
  archivedAt: string | null;
}

export function draftDto(r: EntityRow): DraftDto {
  return {
    id: r.id,
    status: r.status,
    draft: r.draft,
    rowVersion: r.row_version,
    liveVersionId: r.live_version_id,
    draftUpdatedAt: r.draft_updated_at.toISOString(),
    draftUpdatedBy: r.draft_updated_by,
    createdAt: r.created_at.toISOString(),
    archivedAt: r.archived_at?.toISOString() ?? null,
  };
}

export const RICH_TEXT_MAX = 50_000;
const RAW_HTML_RE = /<\/?[a-z!?][^>]*>/i;
const MEDIA_LINK_RE = /!\[[^\]]*\]\(media:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/gi;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Вход Markdown (K22 §6): только размер и запрет сырого HTML. Очистка – на выходе, в сайте (lib/rich-text.ts). */
export function checkRichText(field: string, text: string | null | undefined): void {
  if (!text) return;
  if (text.length > RICH_TEXT_MAX) throw new AppError('RICH_TEXT_TOO_LONG', 422, `Текст длиннее ${RICH_TEXT_MAX} знаков`, { field, max: RICH_TEXT_MAX });
  if (RAW_HTML_RE.test(text)) throw new AppError('RICH_TEXT_HTML_FORBIDDEN', 422, 'В тексте нельзя использовать HTML', { field });
  // Картинка – только в форме ![подпись](media:<id>): подпись, заголовок или сноска в другой форме не нашлись бы при очистке по ГК ст. 152.1.
  const rest = text.replace(MEDIA_LINK_RE, '');
  if (rest.includes('![') || /media(:|&#|%3a|\\:)/i.test(rest)) {
    throw new AppError('CONTENT_INVALID', 400, 'Картинка в тексте – только из медиатеки', { issues: [{ path: field, message: 'картинка только в виде ![подпись](media:id)' }] });
  }
}

/** Картинки медиатеки в Markdown: ![alt](media:<id>). */
export function mediaIdsInText(text: string | null | undefined): string[] {
  if (!text) return [];
  return [...text.matchAll(MEDIA_LINK_RE)].map((m) => m[1]!.toLowerCase());
}

/** Все ссылки черновика на медиа: объявленные сущностью и картинки каждого поля Markdown – чтобы ни одна не прошла мимо снимка и очистки. */
export function refsOf<D extends Record<string, unknown>>(def: EntityDef<D>, draft: D): DraftMediaRef[] {
  const refs = [...def.mediaRefs(draft)];
  const seen = new Set(refs.map((r) => `${r.field}:${r.mediaId}`));
  for (const [field, text] of def.richText(draft)) {
    for (const mediaId of mediaIdsInText(text)) {
      if (seen.has(`${field}:${mediaId}`)) continue;
      seen.add(`${field}:${mediaId}`);
      refs.push({ mediaId, field, altRequired: true });
    }
  }
  return refs;
}

const notFound = () => new AppError('NOT_FOUND', 404, 'Не найдено');
const statusConflict = (status: ContentStatus, action: string) =>
  new AppError('CONTENT_STATUS_CONFLICT', 409, 'Действие недоступно в этом статусе', { status, action });

function requireReason(reason: string | null | undefined): string {
  const r = reason?.trim() ?? '';
  if (r === '') throw new AppError('COMMENT_REQUIRED', 422, 'Укажите причину', { field: 'reason' });
  return r;
}

/** Ссылка черновика – на существующий и не очищенный файл: иначе FK связей дал бы 500, а экран – непонятную ошибку. */
async function assertMediaUsable(tx: Db, refs: readonly MediaRef[]): Promise<void> {
  const frozen = await freezeMedia(tx, refs.map((r) => r.mediaId));
  const bad = refs.filter((r) => !frozen[r.mediaId] || frozen[r.mediaId]!.status === 'purged');
  if (bad.length > 0) throw new AppError('CONTENT_INVALID', 400, 'Файла нет в медиатеке', { issues: bad.map((r) => ({ path: r.field, message: 'файла нет в медиатеке' })) });
}

function parseDraft<D extends Record<string, unknown>>(def: EntityDef<D>, value: unknown): D {
  const r = def.schema.safeParse(value);
  if (!r.success) {
    throw new AppError('CONTENT_INVALID', 400, 'Черновик заполнен неверно', { issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  }
  for (const [field, text] of def.richText(r.data)) checkRichText(field, text);
  return r.data;
}

/** Черновик строки для прав и проверок: сохранённый черновик мог быть записан старой схемой – права его читают как есть. */
const storedDraft = <D extends Record<string, unknown>>(row: EntityRow) => row.draft as D;

export async function lockEntity(tx: Db, table: string, id: string): Promise<EntityRow> {
  if (!UUID_RE.test(id)) throw notFound();
  const row = (await tx.query<EntityRow>(`SELECT * FROM ${table} WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!row) throw notFound();
  return row;
}

export async function loadEntity(db: Db, table: string, id: string): Promise<EntityRow> {
  if (!UUID_RE.test(id)) throw notFound();
  const row = (await db.query<EntityRow>(`SELECT * FROM ${table} WHERE id = $1`, [id])).rows[0];
  if (!row) throw notFound();
  return row;
}

function checkVersion(row: EntityRow, rowVersion: number): void {
  if (row.row_version !== rowVersion) {
    throw new AppError('VERSION_CONFLICT', 409, 'Черновик изменился, обновите страницу', { current: draftDto(row) });
  }
}

const auditObject = (type: EntityType, id: string) => ({ type: type satisfies AuditObjectType, id });

/** Создание: строка со своими постоянными столбцами (тип, направление, ключ, комната) и черновиком. Право проверяет вызывающий. */
export async function createEntity<D extends Record<string, unknown>>(
  tx: Db,
  ctx: AccessContext,
  def: EntityDef<D>,
  columns: Record<string, unknown>,
  draftInput: unknown,
  meta: AuditRequestMeta,
  clock: Clock = systemClock,
): Promise<EntityRow> {
  const draft = parseDraft(def, draftInput);
  await assertMediaUsable(tx, refsOf(def, draft));
  const names = Object.keys(columns);
  const values = names.map((n) => columns[n]);
  const now = clock.now();
  const placeholders = names.map((_, i) => `$${i + 5}`);
  const r = await tx.query<EntityRow>(
    `INSERT INTO ${def.table} (draft, draft_updated_at, draft_updated_by, created_by, created_at${names.map((n) => `, ${n}`).join('')})
     VALUES ($1, $2, $3, $4, $2${placeholders.map((p) => `, ${p}`).join('')}) RETURNING *`,
    [JSON.stringify(draft), now, ctx.actor.staffId, ctx.actor.staffId, ...values],
  );
  const row = r.rows[0]!;
  await syncUsages(tx, def.type, row.id, false, refsOf(def, draft));
  await writeAudit(tx, meta, { action: 'content.draft_saved', object: auditObject(def.type, row.id), after: { fields: Object.keys(draft).sort(), created: true } }, clock);
  return row;
}

/** Сохранение черновика (K22 §3): сайт не меняется. В аудит – только список изменённых полей, без текста. */
export async function saveDraft<D extends Record<string, unknown>>(
  tx: Db,
  ctx: AccessContext,
  def: EntityDef<D>,
  id: string,
  input: { rowVersion: number; draft: unknown },
  meta: AuditRequestMeta,
  clock: Clock = systemClock,
): Promise<EntityRow> {
  const row = await lockEntity(tx, def.table, id);
  const draft = parseDraft(def, input.draft);
  await def.assertEdit(tx, ctx, row, draft);
  if (row.status === 'archived') throw statusConflict(row.status, 'save_draft');
  checkVersion(row, input.rowVersion);
  await assertMediaUsable(tx, refsOf(def, draft));
  const before = row.draft;
  const fields = [...new Set([...Object.keys(before), ...Object.keys(draft)])].filter((k) => JSON.stringify(before[k]) !== JSON.stringify(draft[k])).sort();
  const r = await tx.query<EntityRow>(
    `UPDATE ${def.table} SET draft = $2, draft_updated_at = $3, draft_updated_by = $4, row_version = row_version + 1 WHERE id = $1 RETURNING *`,
    [id, JSON.stringify(draft), clock.now(), ctx.actor.staffId],
  );
  await syncUsages(tx, def.type, id, false, refsOf(def, draft));
  await writeAudit(tx, meta, { action: 'content.draft_saved', object: auditObject(def.type, id), after: { fields } }, clock);
  return r.rows[0]!;
}

async function insertVersion(
  tx: Db,
  def: { type: EntityType },
  id: string,
  ctx: AccessContext,
  input: { snapshot: Snapshot; action: VersionRow['action']; reason: string | null; sourceVersionId: string | null },
  clock: Clock,
): Promise<VersionRow> {
  const r = await tx.query<VersionRow>(
    `INSERT INTO journal.content_versions (entity_type, entity_id, version_no, snapshot, action, published_by, published_at, reason, source_version_id)
     SELECT $1, $2, COALESCE(MAX(version_no), 0) + 1, $3, $4, $5, $6, $7, $8 FROM journal.content_versions WHERE entity_type = $1 AND entity_id = $2
     RETURNING id, version_no, snapshot, action, published_by, published_at, reason, source_version_id`,
    [def.type, id, JSON.stringify(input.snapshot), input.action, ctx.actor.staffId, clock.now(), input.reason, input.sourceVersionId],
  );
  return r.rows[0]!;
}

async function goLive<D extends Record<string, unknown>>(tx: Db, ctx: AccessContext, def: EntityDef<D>, row: EntityRow, draft: D, versionId: string, extraSet = ''): Promise<EntityRow> {
  await def.applyLive?.(tx, row, draft, ctx);
  const r = await tx.query<EntityRow>(
    `UPDATE ${def.table} SET status = 'published', live_version_id = $2, row_version = row_version + 1${extraSet} WHERE id = $1 RETURNING *`,
    [row.id, versionId],
  );
  await syncUsages(tx, def.type, row.id, true, refsOf(def, draft));
  return r.rows[0]!;
}

/** Публикация: полнота K22 §9 → заморозка медиа → новая версия → живые столбцы. Одна транзакция, строка под FOR UPDATE. */
export async function publish<D extends Record<string, unknown>>(
  tx: Db,
  ctx: AccessContext,
  def: EntityDef<D>,
  id: string,
  input: { rowVersion: number; reason?: string | null },
  meta: AuditRequestMeta,
  clock: Clock = systemClock,
): Promise<{ row: EntityRow; version: VersionRow }> {
  const row = await lockEntity(tx, def.table, id);
  const draft = parseDraft(def, row.draft);
  await def.assertPublish(tx, ctx, row, draft);
  if (row.status === 'archived') throw statusConflict(row.status, 'publish');
  checkVersion(row, input.rowVersion);
  const issues = def.complete(draft, row);
  const refs = refsOf(def, draft);
  const frozen = await freezeMedia(tx, refs.map((r) => r.mediaId));
  for (const ref of refs) {
    const m = frozen[ref.mediaId];
    if (!m || m.status === 'purged') issues.push({ field: ref.field, code: 'MEDIA_MISSING' });
    else if (ref.altRequired && m.mime === 'application/pdf') issues.push({ field: ref.field, code: 'MEDIA_NOT_IMAGE' }); // PDF – только правила розыгрыша
  }
  if (issues.length > 0) throw new AppError('CONTENT_INCOMPLETE', 422, 'Заполните обязательные поля', { fields: issues });
  const noAlt = refs.filter((r) => r.altRequired && !frozen[r.mediaId]?.alt?.trim());
  if (noAlt.length > 0) {
    throw new AppError('MEDIA_ALT_REQUIRED', 422, 'Заполните описание картинки (alt)', { fields: noAlt.map((r) => ({ field: r.field, mediaId: r.mediaId })) });
  }
  const media: Record<string, FrozenMedia> = {};
  for (const [mediaId, m] of Object.entries(frozen)) media[mediaId] = { alt: m.alt, mime: m.mime, width: m.width, height: m.height, key: m.key, variants: m.variants };
  const snapshot: Snapshot = { ...draft, ...def.snapshotExtra?.(draft, row), media };
  const version = await insertVersion(tx, def, id, ctx, { snapshot, action: 'publish', reason: input.reason?.trim() || null, sourceVersionId: null }, clock);
  const live = await goLive(tx, ctx, def, row, draft, version.id);
  await writeAudit(tx, meta, { action: 'content.published', object: auditObject(def.type, id), after: { versionNo: version.version_no, versionId: version.id }, reason: input.reason?.trim() || null }, clock);
  return { row: live, version };
}

/** Снять с сайта: live_version_id остаётся для истории, сайт перестаёт показывать; причина обязательна (12 §9.5). */
export async function unpublish<D extends Record<string, unknown>>(tx: Db, ctx: AccessContext, def: EntityDef<D>, id: string, input: { reason: string }, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<EntityRow> {
  const row = await lockEntity(tx, def.table, id);
  await def.assertPublish(tx, ctx, row, storedDraft<D>(row));
  const reason = requireReason(input.reason);
  if (row.status === 'unpublished') return row; // повтор
  if (row.status !== 'published') throw statusConflict(row.status, 'unpublish');
  const r = await tx.query<EntityRow>(`UPDATE ${def.table} SET status = 'unpublished', row_version = row_version + 1 WHERE id = $1 RETURNING *`, [id]);
  await syncUsages(tx, def.type, id, true, []);
  await writeAudit(tx, meta, { action: 'content.unpublished', object: auditObject(def.type, id), reason }, clock);
  return r.rows[0]!;
}

/** В архив – только из draft/unpublished: опубликованное сначала снять. Удаления нет (12 §9.5, приёмка 18). */
export async function archive<D extends Record<string, unknown>>(tx: Db, ctx: AccessContext, def: EntityDef<D>, id: string, input: { reason: string }, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<EntityRow> {
  const row = await lockEntity(tx, def.table, id);
  await def.assertPublish(tx, ctx, row, storedDraft<D>(row));
  const reason = requireReason(input.reason);
  if (row.status === 'archived') return row; // повтор
  if (row.status === 'published') throw statusConflict(row.status, 'archive');
  const r = await tx.query<EntityRow>(`UPDATE ${def.table} SET status = 'archived', archived_at = $2, row_version = row_version + 1 WHERE id = $1 RETURNING *`, [id, clock.now()]);
  await syncUsages(tx, def.type, id, false, []);
  await writeAudit(tx, meta, { action: 'content.archived', object: auditObject(def.type, id), reason }, clock);
  return r.rows[0]!;
}

/** Откат: черновик := снимок выбранной версии, новая версия с action = rollback_publish и тем же снимком (alt не перезамораживается).
 *  Полноту не проверяем: снимок уже был опубликован; очищенное фото при показе заменится заглушкой (S4-45). */
export async function rollback<D extends Record<string, unknown>>(
  tx: Db,
  ctx: AccessContext,
  def: EntityDef<D>,
  id: string,
  input: { versionId: string; rowVersion: number; reason: string },
  meta: AuditRequestMeta,
  clock: Clock = systemClock,
): Promise<{ row: EntityRow; version: VersionRow }> {
  const row = await lockEntity(tx, def.table, id);
  await def.assertPublish(tx, ctx, row, storedDraft<D>(row));
  const reason = requireReason(input.reason);
  if (row.status === 'archived') throw statusConflict(row.status, 'rollback');
  checkVersion(row, input.rowVersion);
  if (!/^\d{1,18}$/.test(input.versionId)) throw notFound();
  const source = (
    await tx.query<VersionRow>(
      `SELECT id, version_no, snapshot, action, published_by, published_at, reason, source_version_id FROM journal.content_versions WHERE id = $1 AND entity_type = $2 AND entity_id = $3`,
      [input.versionId, def.type, id],
    )
  ).rows[0];
  if (!source) throw notFound();
  // Журнал не правится, но новая версия не повторяет подпись и alt очищенного фото (K22 §8): показ остальных полей – дословно.
  const snapshot = scrubPurged(source.snapshot, await purgedAmong(tx, mediaIdsOfSnapshot(source.snapshot)));
  const fields: Record<string, unknown> = { ...snapshot };
  delete fields.media;
  const draft = fields as D;
  await def.assertPublish(tx, ctx, row, draft); // цель снимка может быть иной, чем у текущего черновика
  const version = await insertVersion(tx, def, id, ctx, { snapshot, action: 'rollback_publish', reason, sourceVersionId: source.id }, clock);
  await tx.query(`UPDATE ${def.table} SET draft = $2, draft_updated_at = $3, draft_updated_by = $4 WHERE id = $1`, [id, JSON.stringify(draft), clock.now(), ctx.actor.staffId]);
  const live = await goLive(tx, ctx, def, row, draft, version.id);
  await syncUsages(tx, def.type, id, false, refsOf(def, draft));
  await writeAudit(tx, meta, { action: 'content.rolled_back', object: auditObject(def.type, id), after: { versionNo: version.version_no, fromVersionNo: source.version_no }, reason }, clock);
  return { row: live, version };
}

export interface VersionDto {
  id: string;
  versionNo: number;
  action: VersionRow['action'];
  publishedBy: string;
  publishedByName: string | null;
  publishedAt: string;
  reason: string | null;
  sourceVersionId: string | null;
  snapshot: Snapshot;
}

/** Версии с автором, датой, причиной и снимком – для сравнения по полям в CRM. */
export async function listVersions(db: Db, type: EntityType, id: string): Promise<VersionDto[]> {
  if (!UUID_RE.test(id)) throw notFound();
  const r = await db.query<VersionRow & { author: string | null }>(
    `SELECT v.id, v.version_no, v.snapshot, v.action, v.published_by, v.published_at, v.reason, v.source_version_id,
            (SELECT s.first_name || ' ' || s.last_name FROM app.staff s WHERE s.id = v.published_by) AS author
       FROM journal.content_versions v WHERE v.entity_type = $1 AND v.entity_id = $2 ORDER BY v.version_no DESC`,
    [type, id],
  );
  return r.rows.map((v) => ({
    id: v.id,
    versionNo: v.version_no,
    action: v.action,
    publishedBy: v.published_by,
    publishedByName: v.author,
    publishedAt: v.published_at.toISOString(),
    reason: v.reason,
    sourceVersionId: v.source_version_id,
    snapshot: v.snapshot,
  }));
}

/** Файл упомянут хотя бы в одной версии: обычное удаление такого запрещено (K22 §8). */
export async function mediaInVersions(db: Db, mediaId: string): Promise<boolean> {
  const r = await db.query<{ found: boolean }>(`SELECT EXISTS (SELECT 1 FROM journal.content_versions WHERE snapshot->'media' ? $1) AS found`, [mediaId]);
  return r.rows[0]!.found;
}

// ---- показ снимка посетителю

export interface PublicVariant {
  w: number;
  h: number;
  format: MediaVariant['format'];
  url: string;
}
export interface PublicMedia {
  removed: boolean;
  alt: string;
  width: number | null;
  height: number | null;
  url: string | null;
  variants: PublicVariant[];
}

export const REMOVED_MEDIA_ALT = 'изображение удалено';
const REMOVED: PublicMedia = { removed: true, alt: REMOVED_MEDIA_ALT, width: null, height: null, url: null, variants: [] };

const mediaUrl = (key: string) => `${MEDIA_PUBLIC_BASE}/${key}`;

/** Какие из файлов очищены по требованию субъекта: при показе любого снимка ссылка заменяется заглушкой (K22 §8). */
export async function purgedAmong(db: Db, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const r = await db.query<{ id: string }>(`SELECT id FROM app.content_media WHERE id = ANY($1::uuid[]) AND status = 'purged'`, [ids]);
  return new Set(r.rows.map((x) => x.id));
}

/** Все файлы снимка: из карты media и из текста. */
export function mediaIdsOfSnapshot(snapshot: Snapshot): string[] {
  const inText = [...JSON.stringify(snapshot).matchAll(/media:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi)].map((m) => m[1]!.toLowerCase());
  return [...new Set([...Object.keys(snapshot.media ?? {}), ...inText])];
}

/** Снимок для новой версии: у очищенных файлов – ни подписи в тексте, ни alt и адресов в карте. Ссылка остаётся, при показе – заглушка. */
export function scrubPurged(snapshot: Snapshot, purged: ReadonlySet<string>): Snapshot {
  if (purged.size === 0) return snapshot;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return v.replace(MEDIA_LINK_RE, (whole, id: string) => (purged.has(id.toLowerCase()) ? `![](media:${id})` : whole));
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  const { media, ...fields } = snapshot;
  const kept: Record<string, FrozenMedia> = {};
  for (const [id, m] of Object.entries(media ?? {})) kept[id] = purged.has(id) ? { alt: null, mime: m.mime, width: null, height: null, key: '', variants: [] } : m;
  return { ...(walk(fields) as Record<string, unknown>), media: kept };
}

/** Медиа снимка в виде для сайта. alt и размеры – из снимка, адреса строятся; у очищенного – заглушка без адресов. */
export function publicMedia(snapshot: Snapshot, purged: ReadonlySet<string>): Record<string, PublicMedia> {
  const out: Record<string, PublicMedia> = {};
  for (const [id, m] of Object.entries(snapshot.media ?? {})) {
    out[id] = purged.has(id)
      ? REMOVED
      : { removed: false, alt: m.alt ?? '', width: m.width, height: m.height, url: mediaUrl(m.key), variants: m.variants.map((v) => ({ w: v.w, h: v.h, format: v.format, url: mediaUrl(v.key) })) };
  }
  return out;
}

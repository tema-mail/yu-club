// S4-45. Принудительная очистка фото по требованию субъекта (ГК ст. 152.1, K22 §8, Q-135): только Владелец и только с основанием.
// Файлы всех вариантов удаляются, даже если медиа использовано в версиях. Журнал content_versions не правится: живая сущность получает новую версию
// без фото (снимок живой версии минус ссылка, черновик в неё не попадает), черновики очищаются, а при показе любого старого снимка – в том числе после
// отката – publicMedia подставляет заглушку «изображение удалено» (status = 'purged'). sha256 остаётся: тот же файл заново не загрузить.
// Файлы стираются ПОСЛЕ фиксации транзакции (routes.media.ts): откат базы не должен оставить снимки без файлов; сбой удаления подберёт content:media-gc.
import { writeAudit, type AuditRequestMeta, type Db } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { assertCan, type AccessContext } from '../../core/permissions.ts';
import { systemClock, type Clock } from '../../core/time.ts';
import { MEDIA_COLUMNS, type MediaRow } from './media.ts';
import { entityTable } from './preview.ts';
import type { EntityType, Snapshot } from './versions.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTITY_TYPES: readonly EntityType[] = ['publication', 'game', 'room_page', 'branch_page', 'content_page', 'home_block'];
/** Столбцы живой версии со ссылкой на медиа (0404). */
const LIVE_COLUMNS: Partial<Record<EntityType, readonly string[]>> = {
  publication: ['cover_media_id', 'rules_media_id'],
  game: ['cover_media_id'],
};

/** Убрать ссылки на файл из значения черновика или снимка: поле-идентификатор и элемент массива исчезают, картинка в Markdown вырезается. */
export function stripMedia<T>(value: T, mediaId: string): T {
  const image = new RegExp(`!\\[[^\\]]*\\]\\(media:${mediaId}\\)`, 'gi');
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return v.replace(image, '');
    if (Array.isArray(v)) return v.filter((x) => x !== mediaId).map(walk);
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) if (x !== mediaId) out[k] = walk(x);
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

export interface PurgeAffected {
  entityType: EntityType;
  entityId: string;
  /** Новая версия живой сущности; null – правился только черновик. */
  versionNo: number | null;
}

export interface PurgeResult {
  files: string[];
  affected: PurgeAffected[];
}

async function republishWithout(tx: Db, ctx: AccessContext, type: EntityType, mediaId: string, reason: string, now: Date): Promise<PurgeAffected[]> {
  const table = entityTable(type);
  const live = await tx.query<{ id: string; snapshot: Snapshot }>(
    `SELECT t.id, v.snapshot FROM ${table} t JOIN journal.content_versions v ON v.id = t.live_version_id
      WHERE t.status = 'published' AND v.snapshot::text LIKE '%' || $1 || '%' FOR UPDATE OF t`,
    [mediaId],
  );
  const out: PurgeAffected[] = [];
  for (const row of live.rows) {
    const { media, ...fields } = row.snapshot;
    const rest = { ...(media ?? {}) };
    delete rest[mediaId];
    const snapshot: Snapshot = { ...stripMedia(fields, mediaId), media: rest };
    const v = await tx.query<{ id: string; version_no: number }>(
      `INSERT INTO journal.content_versions (entity_type, entity_id, version_no, snapshot, action, published_by, published_at, reason)
       SELECT $1, $2, COALESCE(MAX(version_no), 0) + 1, $3, 'publish', $4, $5, $6 FROM journal.content_versions WHERE entity_type = $1 AND entity_id = $2
       RETURNING id, version_no`,
      [type, row.id, JSON.stringify(snapshot), ctx.actor.staffId, now, `Очистка фото: ${reason}`],
    );
    await tx.query(`UPDATE ${table} SET live_version_id = $2, row_version = row_version + 1 WHERE id = $1`, [row.id, v.rows[0]!.id]);
    out.push({ entityType: type, entityId: row.id, versionNo: v.rows[0]!.version_no });
  }
  return out;
}

async function cleanDrafts(tx: Db, type: EntityType, mediaId: string): Promise<string[]> {
  const table = entityTable(type);
  const rows = await tx.query<{ id: string; draft: Record<string, unknown> }>(`SELECT id, draft FROM ${table} WHERE draft::text LIKE '%' || $1 || '%' FOR UPDATE`, [mediaId]);
  for (const row of rows.rows) {
    await tx.query(`UPDATE ${table} SET draft = $2, row_version = row_version + 1 WHERE id = $1`, [row.id, JSON.stringify(stripMedia(row.draft, mediaId))]);
  }
  for (const column of LIVE_COLUMNS[type] ?? []) {
    await tx.query(`UPDATE ${table} SET ${column} = NULL WHERE ${column} = $1`, [mediaId]);
  }
  return rows.rows.map((r) => r.id);
}

/** Очистка в транзакции. Файлы для удаления – в ответе, стирает вызывающий после фиксации. Повтор по очищенному – без изменений. */
export async function purgeMedia(tx: Db, ctx: AccessContext, id: string, input: { reason: string; basis: string }, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<PurgeResult> {
  assertCan(ctx, 'content.media.purge', { network: true });
  const reason = input.reason?.trim() ?? '';
  const basis = input.basis?.trim() ?? '';
  if (reason === '') throw new AppError('COMMENT_REQUIRED', 422, 'Укажите причину', { field: 'reason' });
  if (basis === '') throw new AppError('COMMENT_REQUIRED', 422, 'Укажите основание', { field: 'basis' });
  if (!UUID_RE.test(id)) throw new AppError('NOT_FOUND', 404, 'Не найдено');
  const row = (await tx.query<MediaRow>(`SELECT ${MEDIA_COLUMNS} FROM app.content_media WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!row) throw new AppError('NOT_FOUND', 404, 'Не найдено');
  if (row.status === 'purged') return { files: [], affected: [] };

  const now = clock.now();
  const byEntity = new Map<string, PurgeAffected>();
  for (const type of ENTITY_TYPES) {
    for (const a of await republishWithout(tx, ctx, type, id, reason, now)) byEntity.set(`${type}:${a.entityId}`, a);
    for (const entityId of await cleanDrafts(tx, type, id)) {
      if (!byEntity.has(`${type}:${entityId}`)) byEntity.set(`${type}:${entityId}`, { entityType: type, entityId, versionNo: null });
    }
  }
  await tx.query(`DELETE FROM app.content_media_usages WHERE media_id = $1`, [id]);
  // Подписи тоже могут называть человека – очищаются вместе с файлом; sha256 держит запрет повторной загрузки.
  await tx.query(`UPDATE app.content_media SET status = 'purged', alt = NULL, title = NULL, original_name = NULL, variants = '[]', archived_at = COALESCE(archived_at, $2), row_version = row_version + 1 WHERE id = $1`, [id, now]);
  const affected = [...byEntity.values()];
  const files = [...new Set([row.storage_key, ...row.variants.map((v) => v.key)])];
  // Основание – без данных субъекта: его пишет Владелец, ФИО сюда не вносить (подсказка в CRM). Журнал очисток – вход регламента восстановления бэкапа.
  await writeAudit(tx, meta, { action: 'media.purged', object: { type: 'media', id }, reason, after: { basis, sha256: row.sha256, files: files.length, affected } }, clock);
  return { files, affected };
}

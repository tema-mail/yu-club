// S4-40. Токен предпросмотра черновика (K22 §11): base64url(полезная нагрузка) + HMAC-SHA256 на PREVIEW_SECRET. Срок 10 минут, привязан к
// row_version черновика и сотруднику: новая правка делает токен недействительным. Любая ошибка – PREVIEW_TOKEN_INVALID (404, как нет страницы).
// Токен сам по себе ничего не открывает: черновик отдаёт только внутренний маршрут с X-Preview-Secret (S4-42).
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Db } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { freezeMedia } from './media.ts';
import { publicMedia, purgedAmong, type EntityRow, type EntityType, type PublicMedia, type Snapshot } from './versions.ts';

export const PREVIEW_TTL_MS = 10 * 60 * 1000;

const ENTITY_TABLES: Record<EntityType, string> = {
  publication: 'app.content_publications',
  game: 'app.content_games',
  room_page: 'app.content_room_pages',
  branch_page: 'app.content_branch_pages',
  content_page: 'app.content_pages',
  home_block: 'app.content_home_blocks',
};
export const entityTable = (type: EntityType) => ENTITY_TABLES[type];

const claimsSchema = z.strictObject({
  entityType: z.enum(['publication', 'game', 'room_page', 'branch_page', 'content_page', 'home_block']),
  entityId: z.uuid(),
  draftRowVersion: z.number().int().min(1),
  staffId: z.uuid(),
  branchId: z.uuid().optional(),
  exp: z.number().int(),
});
export type PreviewClaims = z.infer<typeof claimsSchema>;

const invalid = () => new AppError('PREVIEW_TOKEN_INVALID', 404, 'Не найдено');
const sign = (secret: string, payload: string) => createHmac('sha256', secret).update(payload).digest();

export function issuePreviewToken(secret: string, claims: Omit<PreviewClaims, 'exp'>, now: Date): string {
  const payload = Buffer.from(JSON.stringify({ ...claims, exp: now.getTime() + PREVIEW_TTL_MS })).toString('base64url');
  return `${payload}.${sign(secret, payload).toString('base64url')}`;
}

/** Подпись и срок. Подпись сверяется до разбора содержимого; сравнение – за постоянное время. */
export function verifyPreviewToken(secret: string, token: string, now: Date): PreviewClaims {
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined) throw invalid();
  const given = Buffer.from(signature, 'base64url');
  const expected = sign(secret, payload);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString());
  } catch {
    throw invalid();
  }
  const claims = claimsSchema.safeParse(parsed);
  if (!claims.success || claims.data.exp <= now.getTime()) throw invalid();
  return claims.data;
}

export interface PreviewDraft {
  entityType: EntityType;
  entityId: string;
  branchId: string | null;
  /** Постоянные столбцы сущности (тип публикации, направление игры, ключ страницы) – для выбора шаблона. */
  kind: string | null;
  draft: Record<string, unknown>;
  media: Record<string, PublicMedia>;
}

const KIND_COLUMN: Partial<Record<EntityType, string>> = { publication: 'type', game: 'direction', content_page: 'key', home_block: 'block_type' };

/** Черновик по токену: сотрудник действует и не заблокирован, row_version совпадает. Медиа – текущие из медиатеки (как будет при publish). */
export async function resolvePreview(db: Db, secret: string, token: string, now: Date, mediaIds: (draft: Record<string, unknown>) => string[]): Promise<PreviewDraft> {
  const claims = verifyPreviewToken(secret, token, now);
  const staff = await db.query(`SELECT 1 FROM app.staff WHERE id = $1 AND status = 'active'`, [claims.staffId]);
  if (staff.rows.length === 0) throw invalid();
  const row = (await db.query<EntityRow>(`SELECT * FROM ${entityTable(claims.entityType)} WHERE id = $1`, [claims.entityId])).rows[0];
  if (!row || row.row_version !== claims.draftRowVersion || row.status === 'archived') throw invalid();
  const ids = mediaIds(row.draft);
  const frozen = await freezeMedia(db, ids);
  const purged = await purgedAmong(db, ids);
  const snapshot: Snapshot = { media: frozen };
  const column = KIND_COLUMN[claims.entityType];
  return {
    entityType: claims.entityType,
    entityId: claims.entityId,
    branchId: claims.branchId ?? null,
    kind: column ? String(row[column]) : null,
    draft: row.draft,
    media: publicMedia(snapshot, purged),
  };
}

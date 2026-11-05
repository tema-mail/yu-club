// S4-34. Игры (K22 §2, §9; 12 §6): карточка одна на сеть, доступность – по филиалам. Без строки доступности игра в филиале
// недоступна (12 §6.1, приёмка 9); доступность – оперативный факт: не версионируется, аудит есть. Без full – только плитка, страницы нет.
import { z } from 'zod';
import { writeAudit, type AuditRequestMeta, type Db } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { assertCan, type AccessContext } from '../../core/permissions.ts';
import { systemClock, type Clock } from '../../core/time.ts';
import { assertSlug, assertSlugFree, mediaOf, seoDto, seoShape, showMedia, uuid, withSlugConflict, type SeoDto } from './common.ts';
import { mediaIdsInText, type EntityDef, type EntityRow, type FieldIssue, type PublicMedia, type Snapshot } from './versions.ts';

export const GAME_DIRECTIONS = ['pc', 'vr', 'playstation'] as const;
export type GameDirection = (typeof GAME_DIRECTIONS)[number];
const AGE_RATINGS = ['0+', '6+', '12+', '16+', '18+'] as const;

export const gameDraft = z.strictObject({
  title: z.string().max(120).optional(),
  short: z.string().max(200).optional(),
  full: z.string().optional(),
  slug: z.string().max(200).optional(),
  coverMediaId: uuid.optional(),
  genres: z.array(z.string().min(1).max(60)).max(20).optional(),
  ageRating: z.enum(AGE_RATINGS).optional(),
  platforms: z.array(z.string().min(1).max(60)).max(20).optional(),
  sortOrder: z.number().int().min(0).max(100_000).optional(),
  ...seoShape,
});
export type GameDraft = z.infer<typeof gameDraft>;

const manage = (ctx: AccessContext) => assertCan(ctx, 'content.network.manage', { network: true });

function gameComplete(d: GameDraft, row: EntityRow): FieldIssue[] {
  const issues: FieldIssue[] = (['title', 'short', 'coverMediaId'] as const).filter((f) => !String(d[f] ?? '').trim()).map((field) => ({ field, code: 'REQUIRED' }));
  if (row.direction === 'playstation' && !d.platforms?.length) issues.push({ field: 'platforms', code: 'REQUIRED' }); // 12 §6.4
  if (d.full?.trim() && !d.slug?.trim()) issues.push({ field: 'slug', code: 'REQUIRED' }); // есть страница – нужен адрес
  return issues;
}

export const gameDef: EntityDef<GameDraft> = {
  type: 'game',
  table: 'app.content_games',
  schema: gameDraft,
  richText: (d) => [['full', d.full]],
  mediaRefs: (d) => [
    ...(d.coverMediaId ? [{ mediaId: d.coverMediaId, field: 'cover', altRequired: true }] : []),
    ...(d.ogMediaId ? [{ mediaId: d.ogMediaId, field: 'og', altRequired: false }] : []),
    ...mediaIdsInText(d.full).map((mediaId) => ({ mediaId, field: 'full', altRequired: true })),
  ],
  complete: gameComplete,
  assertEdit: (_db, ctx) => manage(ctx),
  assertPublish: (_db, ctx) => manage(ctx),
  // Смена слага у живой версии – место истории адресов K23 §5 (S4-50).
  async applyLive(tx, row, d) {
    const slug = d.slug?.trim() || null;
    if (slug) {
      assertSlug(slug);
      await assertSlugFree(tx, 'app.content_games', 'direction', String(row.direction), slug, row.id);
    }
    await withSlugConflict(tx, slug ?? '', () =>
      tx.query(`UPDATE app.content_games SET slug = $2, has_full = $3, cover_media_id = $4, sort_order = $5 WHERE id = $1`, [row.id, slug, Boolean(d.full?.trim()), d.coverMediaId ?? null, d.sortOrder ?? 0]),
    );
  },
};

export interface GameAvailability {
  gameId: string;
  branchId: string;
  available: boolean;
  note: string | null;
}

/** Доступность игры в филиале (K11 №220). Директор – своего филиала, Владелец – любого. */
export async function setGameBranch(tx: Db, ctx: AccessContext, gameId: string, branchId: string, input: { available: boolean; note?: string | null }, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<GameAvailability> {
  assertCan(ctx, 'content.catalog.availability', { branchId });
  const game = uuid.safeParse(gameId).success ? await tx.query(`SELECT 1 FROM app.content_games WHERE id = $1`, [gameId]) : { rows: [] };
  if (game.rows.length === 0) throw new AppError('NOT_FOUND', 404, 'Не найдено');
  const note = input.note?.trim() || null;
  if (note && note.length > 120) throw new AppError('VALIDATION_FAILED', 400, 'Примечание длиннее 120 знаков', { issues: [{ path: 'note', message: 'не длиннее 120 знаков' }] });
  await tx.query(
    `INSERT INTO app.content_game_branches (game_id, branch_id, available, note, updated_by, updated_at) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (game_id, branch_id) DO UPDATE SET available = EXCLUDED.available, note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
    [gameId, branchId, input.available, note, ctx.actor.staffId, clock.now()],
  );
  await writeAudit(tx, meta, { action: 'content.availability_changed', object: { type: 'game', id: gameId }, branchId, after: { available: input.available, note } }, clock);
  return { gameId, branchId, available: input.available, note };
}

// ---- показ посетителю

export interface GameCard {
  id: string;
  direction: GameDirection;
  slug: string | null;
  hasPage: boolean;
  title: string;
  short: string;
  cover: PublicMedia | null;
  genres: string[];
  ageRating: string | null;
  platforms: string[];
  /** Заметка филиала при ?branch= (K22 §2, content_game_branches.note). */
  note: string | null;
}

export interface GameBranchRef {
  id: string;
  name: string;
  slug: string;
  citySlug: string;
  note: string | null;
}

export interface GamePage extends GameCard {
  full: string;
  media: Record<string, PublicMedia>;
  availableIn: GameBranchRef[];
  seo: SeoDto;
  liveVersionId: string;
}

interface LiveGame {
  id: string;
  direction: GameDirection;
  slug: string | null;
  has_full: boolean;
  live_version_id: string;
  snapshot: Snapshot;
  note?: string | null;
}
const LIVE = `SELECT g.id, g.direction, g.slug, g.has_full, g.live_version_id, v.snapshot FROM app.content_games g JOIN journal.content_versions v ON v.id = g.live_version_id`;

function gameCard(g: LiveGame, media: Record<string, PublicMedia>): GameCard {
  const d = g.snapshot as Snapshot & GameDraft;
  return {
    id: g.id,
    direction: g.direction,
    slug: g.slug,
    hasPage: g.has_full,
    title: d.title ?? '',
    short: d.short ?? '',
    cover: mediaOf(media, d.coverMediaId),
    genres: d.genres ?? [],
    ageRating: d.ageRating ?? null,
    platforms: d.platforms ?? [],
    note: g.note ?? null,
  };
}

/** Каталог: при branchId – только доступные там (не подменять играми другого филиала, 12 §14.1); без – сетевой с пометкой. */
export async function listGames(db: Db, q: { direction?: GameDirection | undefined; branchId?: string | undefined; limit?: number | undefined }): Promise<{ items: GameCard[]; networkCatalog: boolean; versionIds: string[] }> {
  const params: unknown[] = [];
  const where = [`g.status = 'published'`];
  let from = LIVE;
  if (q.branchId) {
    params.push(q.branchId);
    from = `SELECT g.id, g.direction, g.slug, g.has_full, g.live_version_id, v.snapshot, gb.note FROM app.content_games g
      JOIN journal.content_versions v ON v.id = g.live_version_id
      JOIN app.content_game_branches gb ON gb.game_id = g.id AND gb.branch_id = $${params.length} AND gb.available`;
  }
  if (q.direction) {
    params.push(q.direction);
    where.push(`g.direction = $${params.length}`);
  }
  params.push(Math.min(q.limit ?? 500, 500));
  const r = await db.query<LiveGame>(`${from} WHERE ${where.join(' AND ')} ORDER BY g.sort_order, g.id LIMIT $${params.length}`, params);
  const media = await showMedia(db, r.rows.map((x) => x.snapshot));
  return { items: r.rows.map((g, i) => gameCard(g, media[i]!)), networkCatalog: !q.branchId, versionIds: r.rows.map((x) => x.live_version_id) };
}

/** Страница игры: без full – null (карточки нет, плитка в каталоге остаётся). availableIn – только рабочие филиалы. */
export async function getGamePage(db: Db, q: { direction: GameDirection; slug: string }): Promise<GamePage | null> {
  const r = await db.query<LiveGame>(`${LIVE} WHERE g.direction = $1 AND g.slug = $2 AND g.status = 'published' AND g.has_full`, [q.direction, q.slug]);
  const g = r.rows[0];
  if (!g) return null;
  const [media] = await showMedia(db, [g.snapshot]);
  const branches = await db.query<{ id: string; name: string; slug: string; city_slug: string; note: string | null }>(
    `SELECT b.id, b.name, b.slug, c.slug AS city_slug, gb.note FROM app.content_game_branches gb
       JOIN app.branches b ON b.id = gb.branch_id JOIN app.cities c ON c.id = b.city_id
      WHERE gb.game_id = $1 AND gb.available AND b.status <> 'archived' ORDER BY c.slug, b.slug`,
    [g.id],
  );
  const d = g.snapshot as Snapshot & GameDraft;
  return {
    ...gameCard(g, media!),
    full: d.full ?? '',
    media: media!,
    availableIn: branches.rows.map((b) => ({ id: b.id, name: b.name, slug: b.slug, citySlug: b.city_slug, note: b.note })),
    seo: seoDto(g.snapshot, media!, d.coverMediaId),
    liveVersionId: g.live_version_id,
  };
}

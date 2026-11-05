// S4-33. Публикации: новости, акции, розыгрыши, турниры (K22 §2–§4, §9). Охват сеть / город / филиалы, срок показа – фильтром
// запроса, завершённая акция – по ссылке с state = 'ended' или 404 по настройке content.ended_promotion_mode.
// Публичные чтения идут только через snapshot живой версии: столбец draft они не выбирают.
import { z } from 'zod';
import type { Db } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { assertCan, type AccessContext, type Target } from '../../core/permissions.ts';
import { resolveSettings } from '../../core/settings.ts';
import { assertSlug, assertSlugFree, internalPath, isoDate, mediaOf, seoDto, seoShape, showMedia, uuid, withSlugConflict, type SeoDto } from './common.ts';
import type { PublicMedia, Snapshot, EntityDef, EntityRow, FieldIssue } from './versions.ts';
import { mediaIdsInText } from './versions.ts';

export const PUBLICATION_TYPES = ['news', 'promotion', 'giveaway', 'tournament'] as const;
export type PublicationType = (typeof PUBLICATION_TYPES)[number];

const scopeSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('network') }),
  z.strictObject({ type: z.literal('city'), cityIds: z.array(uuid).min(1).max(100) }),
  z.strictObject({ type: z.literal('branch'), branchIds: z.array(uuid).min(1).max(200) }),
]);
export type Scope = z.infer<typeof scopeSchema>;

/** Черновик: поля могут быть пусты (полнота – при publish), кроме охвата: от него зависят права с первого сохранения. */
export const publicationDraft = z.strictObject({
  scope: scopeSchema,
  title: z.string().max(120).optional(),
  lead: z.string().max(300).optional(),
  body: z.string().optional(),
  slug: z.string().max(200).optional(),
  coverMediaId: uuid.optional(),
  publishFrom: isoDate.optional(),
  publishTo: isoDate.optional(),
  eventDate: isoDate.optional(),
  conditions: z.string().max(5000).optional(),
  restrictions: z.string().max(5000).optional(),
  ctaLabel: z.string().max(60).optional(),
  ctaUrl: internalPath.optional(),
  resultsDate: isoDate.optional(),
  prize: z.string().max(500).optional(),
  rulesBody: z.string().optional(),
  rulesMediaId: uuid.optional(),
  indexable: z.boolean().optional(),
  ...seoShape,
});
export type PublicationDraft = z.infer<typeof publicationDraft>;

function targetsOf(scope: Scope): Target[] | 'network' {
  if (scope.type === 'network') return 'network';
  if (scope.type === 'city') return scope.cityIds.map((cityId) => ({ cityId }));
  return scope.branchIds.map((branchId) => ({ branchId }));
}

/** Сетевое – content.network.manage; город и филиал – действие по охвату, на КАЖДУЮ цель (K22 §4, §10). */
export function assertScope(ctx: AccessContext, scope: Scope, localAction: 'content.draft.edit' | 'content.publish'): void {
  const t = targetsOf(scope);
  if (t === 'network') {
    assertCan(ctx, 'content.network.manage', { network: true });
    return;
  }
  for (const target of t) assertCan(ctx, localAction, target);
}

/** Охват живой версии: правка и публикация не должны менять чужой живой материал, даже если охват черновика уже свой. */
async function liveScope(db: Db, id: string): Promise<Scope | null> {
  const r = await db.query<{ scope_type: Scope['type']; city_id: string | null; branch_id: string | null }>(`SELECT scope_type, city_id, branch_id FROM app.content_publication_scopes WHERE publication_id = $1`, [id]);
  const first = r.rows[0];
  if (!first) return null;
  if (first.scope_type === 'network') return { type: 'network' };
  if (first.scope_type === 'city') return { type: 'city', cityIds: r.rows.map((x) => x.city_id!) };
  return { type: 'branch', branchIds: r.rows.map((x) => x.branch_id!) };
}

function publicationComplete(d: PublicationDraft, row: EntityRow): FieldIssue[] {
  const required: Array<keyof PublicationDraft> = ['title', 'lead', 'body', 'slug', 'publishFrom', 'coverMediaId'];
  if (row.type === 'promotion') required.push('publishTo', 'conditions');
  if (row.type === 'giveaway') required.push('resultsDate', 'prize');
  const issues: FieldIssue[] = required.filter((f) => !String(d[f] ?? '').trim()).map((field) => ({ field, code: 'REQUIRED' }));
  if (row.type === 'giveaway' && !d.rulesBody?.trim() && !d.rulesMediaId) issues.push({ field: 'rules', code: 'REQUIRED' });
  if (d.publishFrom && d.publishTo && Date.parse(d.publishTo) <= Date.parse(d.publishFrom)) issues.push({ field: 'publishTo', code: 'BEFORE_START' });
  return issues;
}

async function assertScopeExists(tx: Db, scope: Scope): Promise<void> {
  const [table, ids] = scope.type === 'city' ? ['app.cities', scope.cityIds] : scope.type === 'branch' ? ['app.branches', scope.branchIds] : [null, []];
  if (!table) return;
  const r = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE id = ANY($1::uuid[])`, [ids]);
  if (r.rows[0]!.n !== new Set(ids).size) throw new AppError('NOT_FOUND', 404, 'Не найдено');
}

/** Живые столбцы и охват – только из publish и rollback. Смена слага у живой версии – место истории адресов K23 §5 (S4-50). */
async function applyLive(tx: Db, row: EntityRow, d: PublicationDraft): Promise<void> {
  await assertScopeExists(tx, d.scope);
  const slug = d.slug!;
  assertSlug(slug);
  await assertSlugFree(tx, 'app.content_publications', 'type', String(row.type), slug, row.id);
  await withSlugConflict(tx, slug, () =>
    tx.query(`UPDATE app.content_publications SET slug = $2, publish_from = $3, publish_to = $4, indexable = $5, cover_media_id = $6, rules_media_id = $7 WHERE id = $1`, [
      row.id,
      slug,
      d.publishFrom ?? null,
      d.publishTo ?? null,
      d.indexable ?? true,
      d.coverMediaId ?? null,
      d.rulesMediaId ?? null,
    ]),
  );
  await tx.query(`DELETE FROM app.content_publication_scopes WHERE publication_id = $1`, [row.id]);
  if (d.scope.type === 'network') {
    await tx.query(`INSERT INTO app.content_publication_scopes (publication_id, scope_type) VALUES ($1, 'network')`, [row.id]);
  } else if (d.scope.type === 'city') {
    await tx.query(`INSERT INTO app.content_publication_scopes (publication_id, scope_type, city_id) SELECT $1, 'city', x FROM unnest($2::uuid[]) x`, [row.id, [...new Set(d.scope.cityIds)]]);
  } else {
    await tx.query(`INSERT INTO app.content_publication_scopes (publication_id, scope_type, branch_id) SELECT $1, 'branch', x FROM unnest($2::uuid[]) x`, [row.id, [...new Set(d.scope.branchIds)]]);
  }
}

export const publicationDef: EntityDef<PublicationDraft> = {
  type: 'publication',
  table: 'app.content_publications',
  schema: publicationDraft,
  richText: (d) => [['body', d.body], ['rulesBody', d.rulesBody], ['conditions', d.conditions], ['restrictions', d.restrictions]],
  mediaRefs: (d) => [
    ...(d.coverMediaId ? [{ mediaId: d.coverMediaId, field: 'cover', altRequired: true }] : []),
    ...(d.ogMediaId ? [{ mediaId: d.ogMediaId, field: 'og', altRequired: false }] : []),
    ...(d.rulesMediaId ? [{ mediaId: d.rulesMediaId, field: 'rules', altRequired: false }] : []),
    ...mediaIdsInText(d.body).map((mediaId) => ({ mediaId, field: 'body', altRequired: true })),
    ...mediaIdsInText(d.rulesBody).map((mediaId) => ({ mediaId, field: 'rulesBody', altRequired: true })),
  ],
  complete: publicationComplete,
  assertEdit: async (db, ctx, row, draft) => {
    assertScope(ctx, draft.scope, 'content.draft.edit');
    assertScope(ctx, (row.draft as PublicationDraft).scope, 'content.draft.edit');
    const live = await liveScope(db, row.id);
    if (live) assertScope(ctx, live, 'content.draft.edit');
  },
  assertPublish: async (db, ctx, row, draft) => {
    assertScope(ctx, draft.scope, 'content.publish');
    const live = await liveScope(db, row.id);
    if (live) assertScope(ctx, live, 'content.publish');
  },
  applyLive,
};

// ---- показ посетителю (K22 §3, §4, §12)

export interface VisitorChoice {
  cityId?: string | undefined;
  branchId?: string | undefined;
}

export interface OnlyIn {
  type: 'city' | 'branch';
  id: string;
  name: string;
}

export interface PublicationCard {
  id: string;
  type: PublicationType;
  slug: string;
  title: string;
  lead: string;
  cover: PublicMedia | null;
  publishFrom: string;
  publishTo: string | null;
  eventDate: string | null;
  /** Пусто – вся сеть; иначе пометка «только в {город}/{филиал}» (K22 §4). */
  onlyIn: OnlyIn[];
}

export interface PublicationPage extends PublicationCard {
  body: string;
  conditions: string | null;
  restrictions: string | null;
  ctaLabel: string | null;
  ctaUrl: string | null;
  resultsDate: string | null;
  prize: string | null;
  rulesBody: string | null;
  rules: PublicMedia | null;
  rulesUrl: string | null;
  media: Record<string, PublicMedia>;
  state: 'active' | 'ended';
  /** false – страница с плашкой и noindex: завершённая акция или снятый флаг (K23 §2). */
  indexable: boolean;
  seo: SeoDto;
  liveVersionId: string;
}

interface LiveRow {
  id: string;
  type: PublicationType;
  slug: string;
  publish_from: Date;
  publish_to: Date | null;
  indexable: boolean;
  live_version_id: string;
  snapshot: Snapshot;
}
const LIVE_SELECT = `SELECT p.id, p.type, p.slug, p.publish_from, p.publish_to, p.indexable, p.live_version_id, v.snapshot
  FROM app.content_publications p JOIN journal.content_versions v ON v.id = p.live_version_id`;

type ScopeRow = { publication_id: string; scope_type: Scope['type']; city_id: string | null; branch_id: string | null; name: string | null };

async function onlyInOf(db: Db, ids: readonly string[]): Promise<Map<string, OnlyIn[]>> {
  const out = new Map<string, OnlyIn[]>();
  if (ids.length === 0) return out;
  const r = await db.query<ScopeRow>(
    `SELECT s.publication_id, s.scope_type, s.city_id, s.branch_id, COALESCE(c.name, b.name) AS name
       FROM app.content_publication_scopes s
       LEFT JOIN app.cities c ON c.id = s.city_id
       LEFT JOIN app.branches b ON b.id = s.branch_id
      WHERE s.publication_id = ANY($1::uuid[])`,
    [ids],
  );
  for (const s of r.rows) {
    if (s.scope_type === 'network') continue;
    const list = out.get(s.publication_id) ?? [];
    list.push({ type: s.scope_type, id: (s.city_id ?? s.branch_id)!, name: s.name ?? '' });
    out.set(s.publication_id, list);
  }
  return out;
}

function card(r: LiveRow, media: Record<string, PublicMedia>, onlyIn: OnlyIn[]): PublicationCard {
  const s = r.snapshot as Snapshot & PublicationDraft;
  return {
    id: r.id,
    type: r.type,
    slug: r.slug,
    title: s.title ?? '',
    lead: s.lead ?? '',
    cover: mediaOf(media, s.coverMediaId),
    publishFrom: r.publish_from.toISOString(),
    publishTo: r.publish_to?.toISOString() ?? null,
    eventDate: s.eventDate ?? null,
    onlyIn,
  };
}

/** Условие охвата для выбора посетителя (матрица K22 §4): ничего – всё; город – сеть + город + филиалы города; филиал – сеть + его город + он сам. */
async function scopeCondition(db: Db, visitor: VisitorChoice, params: unknown[]): Promise<string> {
  let cityId: string | undefined = visitor.cityId;
  let branchIds: string[];
  if (visitor.branchId) {
    const b = await db.query<{ city_id: string }>(`SELECT city_id FROM app.branches WHERE id = $1`, [visitor.branchId]);
    cityId = b.rows[0]?.city_id;
    branchIds = [visitor.branchId];
  } else if (visitor.cityId) {
    const b = await db.query<{ id: string }>(`SELECT id FROM app.branches WHERE city_id = $1`, [visitor.cityId]);
    branchIds = b.rows.map((x) => x.id);
  } else {
    return 'true';
  }
  params.push(cityId ?? null, branchIds);
  return `EXISTS (SELECT 1 FROM app.content_publication_scopes s WHERE s.publication_id = p.id
            AND (s.scope_type = 'network' OR s.city_id = $${params.length - 1}::uuid OR s.branch_id = ANY($${params.length}::uuid[])))`;
}

export interface ListQuery {
  type?: PublicationType | undefined;
  visitor?: VisitorChoice;
  cursor?: string | undefined;
  limit?: number | undefined;
  now: Date;
}

/** Активные публикации: срок показа – фильтр запроса, отложенная и завершённая не видны. Порядок (publish_from DESC, id). */
export async function listPublications(db: Db, q: ListQuery): Promise<{ items: PublicationCard[]; nextCursor: string | null; versionIds: string[] }> {
  const limit = Math.min(q.limit ?? 20, 50);
  const params: unknown[] = [q.now];
  const where = [`p.status = 'published'`, `p.publish_from <= $1`, `(p.publish_to IS NULL OR p.publish_to > $1)`];
  if (q.type) {
    params.push(q.type);
    where.push(`p.type = $${params.length}`);
  }
  where.push(await scopeCondition(db, q.visitor ?? {}, params));
  if (q.cursor) {
    const [at, id] = Buffer.from(q.cursor, 'base64url').toString().split('|');
    if (!at || !id || !uuid.safeParse(id).success || Number.isNaN(Date.parse(at))) throw new AppError('VALIDATION_FAILED', 400, 'Неверный курсор', { issues: [{ path: 'cursor', message: 'неверный курсор' }] });
    params.push(at, id);
    where.push(`(p.publish_from, p.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(limit + 1);
  const r = await db.query<LiveRow>(`${LIVE_SELECT} WHERE ${where.join(' AND ')} ORDER BY p.publish_from DESC, p.id DESC LIMIT $${params.length}`, params);
  const page = r.rows.slice(0, limit);
  const media = await showMedia(db, page.map((x) => x.snapshot));
  const only = await onlyInOf(db, page.map((x) => x.id));
  const last = page.at(-1);
  return {
    items: page.map((x, i) => card(x, media[i]!, only.get(x.id) ?? [])),
    nextCursor: r.rows.length > limit && last ? Buffer.from(`${last.publish_from.toISOString()}|${last.id}`).toString('base64url') : null,
    versionIds: page.map((x) => x.live_version_id),
  };
}

/** Страница по адресу. Не опубликовано, отложено – null. Завершённая: state = 'ended' и noindex, либо null при режиме not_found.
 *  Адрес один на сеть: охват меняет видимость в списках, но не страницу (K22 §4). */
export async function getPublicationPage(db: Db, q: { type: PublicationType; slug: string; now: Date }): Promise<PublicationPage | null> {
  const r = await db.query<LiveRow>(`${LIVE_SELECT} WHERE p.type = $1 AND p.slug = $2 AND p.status = 'published' AND p.publish_from <= $3`, [q.type, q.slug, q.now]);
  const row = r.rows[0];
  if (!row) return null;
  const ended = row.publish_to !== null && row.publish_to <= q.now;
  if (ended) {
    const s = await resolveSettings(db, ['content.ended_promotion_mode'], { network: true }, q.now);
    if (s['content.ended_promotion_mode'].value === 'not_found') return null;
  }
  const [media] = await showMedia(db, [row.snapshot]);
  const only = await onlyInOf(db, [row.id]);
  const d = row.snapshot as Snapshot & PublicationDraft;
  const rules = mediaOf(media!, d.rulesMediaId);
  return {
    ...card(row, media!, only.get(row.id) ?? []),
    body: d.body ?? '',
    conditions: d.conditions ?? null,
    restrictions: d.restrictions ?? null,
    ctaLabel: d.ctaLabel ?? null,
    ctaUrl: d.ctaUrl ?? null,
    resultsDate: d.resultsDate ?? null,
    prize: d.prize ?? null,
    rulesBody: d.rulesBody ?? null,
    rules,
    rulesUrl: rules?.url ?? null,
    media: media!,
    state: ended ? 'ended' : 'active',
    indexable: row.indexable && !ended,
    seo: seoDto(row.snapshot, media!, d.coverMediaId),
    liveVersionId: row.live_version_id,
  };
}

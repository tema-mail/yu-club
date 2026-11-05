// S4-36. Блоки главной (K22 §2; 12 §5): фиксированный список типов дизайна, payload по схеме типа, уровень сеть и город (филиала нет:
// главная одна на сеть, Q-146). Городская опубликованная версия подменяет сетевой блок того же типа; порядок – из сетевого списка
// или своей подмены. Сетевое – content.network.manage; городское – content.publish по cityId (K11 №228).
import { z } from 'zod';
import { writeAudit, type AuditRequestMeta, type Db } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { assertCan, type AccessContext, type Target } from '../../core/permissions.ts';
import { systemClock, type Clock } from '../../core/time.ts';
import { internalPath, seoShape, showMedia, uuid } from './common.ts';
import { createEntity, type EntityDef, type EntityRow, type PublicMedia, type Snapshot } from './versions.ts';

export const BLOCK_TYPES = ['hero', 'about', 'directions', 'advantages', 'promo_strip', 'cta'] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];

const item = z.strictObject({ title: z.string().min(1).max(120), text: z.string().max(500).optional(), mediaId: uuid.optional() });
const direction = z.strictObject({ direction: z.enum(['pc', 'vr', 'playstation']), title: z.string().min(1).max(120), text: z.string().max(500).optional(), mediaId: uuid.optional() });

export const blockDraft = z.discriminatedUnion('blockType', [
  z.strictObject({
    blockType: z.literal('hero'),
    payload: z.strictObject({ title: z.string().min(1).max(120), subtitle: z.string().max(300).optional(), mediaId: uuid.optional(), ctaLabel: z.string().max(60).optional(), ctaUrl: internalPath.optional() }),
    ...seoShape,
  }),
  z.strictObject({ blockType: z.literal('about'), payload: z.strictObject({ title: z.string().max(120).optional(), body: z.string().min(1).max(5000) }) }),
  z.strictObject({ blockType: z.literal('directions'), payload: z.strictObject({ items: z.array(direction).min(1).max(3) }) }),
  z.strictObject({ blockType: z.literal('advantages'), payload: z.strictObject({ title: z.string().max(120).optional(), items: z.array(item).min(1).max(12) }) }),
  z.strictObject({ blockType: z.literal('promo_strip'), payload: z.strictObject({ text: z.string().min(1).max(200), url: internalPath.optional() }) }),
  z.strictObject({ blockType: z.literal('cta'), payload: z.strictObject({ title: z.string().min(1).max(120), text: z.string().max(300).optional(), label: z.string().min(1).max(60), url: internalPath }) }),
]);
export type BlockDraft = z.infer<typeof blockDraft>;

function blockMedia(d: BlockDraft): Array<{ mediaId: string; field: string; altRequired: boolean }> {
  const refs: Array<{ mediaId: string; field: string; altRequired: boolean }> = [];
  if (d.blockType === 'hero' && d.payload.mediaId) refs.push({ mediaId: d.payload.mediaId, field: 'payload.mediaId', altRequired: true });
  if (d.blockType === 'directions' || d.blockType === 'advantages') {
    d.payload.items.forEach((it, i) => {
      if (it.mediaId) refs.push({ mediaId: it.mediaId, field: `payload.items.${i}.mediaId`, altRequired: true });
    });
  }
  return refs;
}

const targetOf = (cityId: unknown): { action: 'content.network.manage' | 'content.publish'; target: Target } =>
  typeof cityId === 'string' ? { action: 'content.publish', target: { cityId } } : { action: 'content.network.manage', target: { network: true } };

function assertBlockRight(ctx: AccessContext, cityId: unknown): void {
  const { action, target } = targetOf(cityId);
  assertCan(ctx, action, target);
}

export const blockDef: EntityDef<BlockDraft> = {
  type: 'home_block',
  table: 'app.content_home_blocks',
  schema: blockDraft,
  richText: (d) => (d.blockType === 'about' ? [['payload.body', d.payload.body]] : []),
  mediaRefs: blockMedia,
  complete: () => [], // схема типа проверяется при каждом сохранении и при публикации (K22 §9)
  assertEdit(_db, ctx, row, draft) {
    if (draft.blockType !== row.block_type) throw new AppError('CONTENT_INVALID', 400, 'Тип блока не меняется', { issues: [{ path: 'blockType', message: 'тип блока не меняется' }] });
    assertBlockRight(ctx, row.city_id);
  },
  assertPublish: (_db, ctx, row) => assertBlockRight(ctx, row.city_id),
};

/** Создание блока типа на уровне сети или города: тип на уровне один (UNIQUE), повтор – та же строка. */
export async function ensureBlock(tx: Db, ctx: AccessContext, input: { blockType: BlockType; cityId: string | null; draft: unknown }, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<{ row: EntityRow; created: boolean }> {
  assertBlockRight(ctx, input.cityId);
  const found = await tx.query<EntityRow>(`SELECT * FROM app.content_home_blocks WHERE block_type = $1 AND city_id IS NOT DISTINCT FROM $2::uuid`, [input.blockType, input.cityId]);
  if (found.rows[0]) return { row: found.rows[0], created: false };
  const parsed = blockDraft.safeParse(input.draft);
  if (parsed.success && parsed.data.blockType !== input.blockType) throw new AppError('CONTENT_INVALID', 400, 'Тип блока не совпадает', { issues: [{ path: 'blockType', message: 'не совпадает с типом блока' }] });
  const row = await createEntity(tx, ctx, blockDef, { block_type: input.blockType, city_id: input.cityId, sort_order: BLOCK_TYPES.indexOf(input.blockType) }, input.draft, meta, clock);
  return { row, created: true };
}

/** Порядок блоков уровня (K11 №228): оперативное свойство показа, не версионируется; аудит – как правка черновика. Чужая строка – 404. */
export async function reorderBlocks(tx: Db, ctx: AccessContext, input: { cityId: string | null; ids: string[] }, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<void> {
  assertBlockRight(ctx, input.cityId);
  const rows = await tx.query<{ id: string }>(`SELECT id FROM app.content_home_blocks WHERE city_id IS NOT DISTINCT FROM $1::uuid AND id = ANY($2::uuid[]) FOR UPDATE`, [input.cityId, input.ids]);
  if (rows.rows.length !== new Set(input.ids).size) throw new AppError('NOT_FOUND', 404, 'Не найдено');
  for (const [i, id] of input.ids.entries()) {
    await tx.query(`UPDATE app.content_home_blocks SET sort_order = $2, row_version = row_version + 1 WHERE id = $1`, [id, i]);
    await writeAudit(tx, meta, { action: 'content.draft_saved', object: { type: 'home_block', id }, after: { fields: ['sort_order'], sortOrder: i } }, clock);
  }
}

export interface HomeBlock {
  id: string;
  blockType: BlockType;
  cityOverride: boolean;
  payload: Record<string, unknown>;
  media: Record<string, PublicMedia>;
  liveVersionId: string;
}

interface LiveBlock {
  id: string;
  block_type: BlockType;
  city_id: string | null;
  sort_order: number;
  live_version_id: string;
  snapshot: Snapshot;
}

/** Блоки главной: опубликованные, городской подменяет сетевой того же типа; неопубликованный городской – сетевой остаётся. */
export async function getHomeBlocks(db: Db, q: { cityId?: string | undefined }): Promise<{ blocks: HomeBlock[]; versionIds: string[] }> {
  const r = await db.query<LiveBlock>(
    `SELECT b.id, b.block_type, b.city_id, b.sort_order, b.live_version_id, v.snapshot
       FROM app.content_home_blocks b JOIN journal.content_versions v ON v.id = b.live_version_id
      WHERE b.status = 'published' AND (b.city_id IS NULL OR b.city_id = $1::uuid)`,
    [q.cityId ?? null],
  );
  const byType = new Map<BlockType, LiveBlock>();
  for (const b of r.rows) {
    const cur = byType.get(b.block_type);
    if (!cur || (b.city_id !== null && cur.city_id === null)) byType.set(b.block_type, b);
  }
  const chosen = [...byType.values()].sort((a, b) => a.sort_order - b.sort_order || BLOCK_TYPES.indexOf(a.block_type) - BLOCK_TYPES.indexOf(b.block_type));
  const media = await showMedia(db, chosen.map((b) => b.snapshot));
  return {
    blocks: chosen.map((b, i) => ({
      id: b.id,
      blockType: b.block_type,
      cityOverride: b.city_id !== null,
      payload: (b.snapshot as Snapshot & { payload: Record<string, unknown> }).payload,
      media: media[i]!,
      liveVersionId: b.live_version_id,
    })),
    versionIds: chosen.map((b) => b.live_version_id),
  };
}

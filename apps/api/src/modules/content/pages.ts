// S4-35. Страницы из CMS (K22 §2, §5, §7): about, rules, contacts_intro, юридические с document_version, страницы комнат и филиалов.
// Ключ вне списка – PAGE_KEY_UNKNOWN: страницы не плодятся редактором (правило «не дорвеи»). Юридические – только сетевые и только
// Владелец (один оператор ПДн). document_version неизменна у версии: тот же номер с другим текстом не публикуется – иначе согласие
// в журнале ссылалось бы на текст, которого человек не видел. Факты (адрес, часы, вместимость) – у network и resources, здесь только текст.
import { z } from 'zod';
import type { AuditRequestMeta, Db } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { assertCan, type AccessContext } from '../../core/permissions.ts';
import { systemClock, type Clock } from '../../core/time.ts';
import { mediaOf, seoDto, seoShape, showMedia, uuid, type SeoDto } from './common.ts';
import { createEntity, mediaIdsInText, type EntityDef, type EntityRow, type FieldIssue, type PublicMedia, type Snapshot } from './versions.ts';

export const LEGAL_KEYS = ['privacy-policy', 'personal-data-consent', 'cookie-policy', 'advertising-consent'] as const;
export const PAGE_KEYS = ['about', 'contacts_intro', 'rules', ...LEGAL_KEYS] as const;
export type PageKey = (typeof PAGE_KEYS)[number];
const isLegal = (key: unknown) => (LEGAL_KEYS as readonly unknown[]).includes(key);

export function assertPageKey(key: string): asserts key is PageKey {
  if (!(PAGE_KEYS as readonly string[]).includes(key)) throw new AppError('PAGE_KEY_UNKNOWN', 404, 'Такой страницы нет', { key });
}

const DOC_VERSION_RE = /^[a-z-]+-\d{4}-\d{2}-\d{2}(-\d+)?$/;

export const pageDraft = z.strictObject({
  title: z.string().max(200).optional(),
  body: z.string().optional(),
  documentVersion: z.string().max(80).optional(),
  ...seoShape,
});
export type PageDraft = z.infer<typeof pageDraft>;

const managePage = (ctx: AccessContext, key: unknown) => assertCan(ctx, isLegal(key) ? 'content.legal.publish' : 'content.network.manage', { network: true });

export const pageDef: EntityDef<PageDraft> = {
  type: 'content_page',
  table: 'app.content_pages',
  schema: pageDraft,
  richText: (d) => [['body', d.body]],
  mediaRefs: (d) => [
    ...(d.ogMediaId ? [{ mediaId: d.ogMediaId, field: 'og', altRequired: false }] : []),
    ...mediaIdsInText(d.body).map((mediaId) => ({ mediaId, field: 'body', altRequired: true })),
  ],
  complete(d, row) {
    const issues: FieldIssue[] = (['title', 'body'] as const).filter((f) => !d[f]?.trim()).map((field) => ({ field, code: 'REQUIRED' }));
    if (isLegal(row.key)) {
      if (!d.documentVersion) issues.push({ field: 'documentVersion', code: 'REQUIRED' });
      else if (!DOC_VERSION_RE.test(d.documentVersion) || !d.documentVersion.startsWith(`${String(row.key)}-`)) issues.push({ field: 'documentVersion', code: 'FORMAT' });
    }
    return issues;
  },
  assertEdit: (_db, ctx, row) => managePage(ctx, row.key),
  assertPublish: (_db, ctx, row) => managePage(ctx, row.key),
  async applyLive(tx, row, d) {
    const version = isLegal(row.key) ? (d.documentVersion ?? null) : null;
    if (version) {
      // тот же номер документа – только с тем же текстом: откат к прежней версии проходит, правка текста без нового номера – нет
      const other = await tx.query(
        `SELECT 1 FROM journal.content_versions WHERE entity_type = 'content_page' AND entity_id = $1 AND snapshot->>'documentVersion' = $2 AND snapshot->>'body' IS DISTINCT FROM $3 LIMIT 1`,
        [row.id, version, d.body ?? ''],
      );
      if (other.rows.length > 0) throw new AppError('CONTENT_INCOMPLETE', 422, 'Текст изменился – нужна новая версия документа', { fields: [{ field: 'documentVersion', code: 'REUSED' }] });
    }
    await tx.query(`UPDATE app.content_pages SET document_version = $2 WHERE id = $1`, [row.id, version]);
  },
};

/** Строка страницы по ключу и городу: создаётся при первом сохранении черновика (адрес фиксирован картой сайта, отдельного «создать» нет). */
export async function ensurePage(tx: Db, ctx: AccessContext, key: string, cityId: string | null, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<EntityRow> {
  assertPageKey(key);
  managePage(ctx, key);
  if (cityId !== null && (isLegal(key) || !uuid.safeParse(cityId).success)) throw new AppError('CONTENT_INVALID', 400, 'Юридические страницы – только сетевые', { issues: [{ path: 'cityId', message: 'только сетевая страница' }] });
  const found = await tx.query<EntityRow>(`SELECT * FROM app.content_pages WHERE key = $1 AND city_id IS NOT DISTINCT FROM $2::uuid`, [key, cityId]);
  if (found.rows[0]) return found.rows[0];
  if (cityId !== null && (await tx.query(`SELECT 1 FROM app.cities WHERE id = $1`, [cityId])).rows.length === 0) throw new AppError('NOT_FOUND', 404, 'Не найдено');
  return createEntity(tx, ctx, pageDef, { key, city_id: cityId }, {}, meta, clock);
}

export interface PublicPage {
  key: PageKey;
  title: string;
  body: string;
  documentVersion: string | null;
  updatedAt: string;
  media: Record<string, PublicMedia>;
  seo: SeoDto;
  liveVersionId: string;
}

interface LivePage {
  key: PageKey;
  city_id: string | null;
  document_version: string | null;
  live_version_id: string;
  published_at: Date;
  snapshot: Snapshot;
}

/** Страница по ключу: своя версия города, если опубликована, иначе сетевая. Не опубликована – null (сайт: «Документ готовится»). */
export async function getPage(db: Db, q: { key: string; cityId?: string | undefined }): Promise<PublicPage | null> {
  assertPageKey(q.key);
  const r = await db.query<LivePage>(
    `SELECT p.key, p.city_id, p.document_version, p.live_version_id, v.published_at, v.snapshot
       FROM app.content_pages p JOIN journal.content_versions v ON v.id = p.live_version_id
      WHERE p.key = $1 AND p.status = 'published' AND (p.city_id IS NULL OR p.city_id = $2::uuid)
      ORDER BY p.city_id NULLS LAST LIMIT 1`,
    [q.key, q.cityId ?? null],
  );
  const p = r.rows[0];
  if (!p) return null;
  const [media] = await showMedia(db, [p.snapshot]);
  const d = p.snapshot as Snapshot & PageDraft;
  return {
    key: p.key,
    title: d.title ?? '',
    body: d.body ?? '',
    documentVersion: p.document_version,
    updatedAt: p.published_at.toISOString(),
    media: media!,
    seo: seoDto(p.snapshot, media!),
    liveVersionId: p.live_version_id,
  };
}

/** Живые версии юридических документов (K5 №215): для галочек входа, настроек и согласия на рекламу (K22 §7). */
export async function legalVersions(db: Db): Promise<{ privacyPolicy: string | null; personalDataConsent: string | null; cookiePolicy: string | null; advertisingConsent: string | null }> {
  const r = await db.query<{ key: string; document_version: string | null }>(`SELECT key, document_version FROM app.content_pages WHERE city_id IS NULL AND status = 'published' AND key = ANY($1::text[])`, [LEGAL_KEYS]);
  const by = new Map(r.rows.map((x) => [x.key, x.document_version]));
  return {
    privacyPolicy: by.get('privacy-policy') ?? null,
    personalDataConsent: by.get('personal-data-consent') ?? null,
    cookiePolicy: by.get('cookie-policy') ?? null,
    advertisingConsent: by.get('advertising-consent') ?? null,
  };
}

// ---- страницы комнат и филиалов

const gallery = z.array(uuid).max(20).optional();
const features = z.array(z.string().min(1).max(120)).max(30).optional();

export const roomPageDraft = z.strictObject({
  description: z.string().optional(),
  gallery,
  features,
  rentFormatsText: z.string().max(2000).optional(),
  ...seoShape,
});
export type RoomPageDraft = z.infer<typeof roomPageDraft>;

export const branchPageDraft = z.strictObject({
  description: z.string().optional(),
  gallery,
  features,
  howToGet: z.string().max(2000).optional(),
  postal: z.strictObject({ street: z.string().max(200), locality: z.string().max(120), region: z.string().max(120), postalCode: z.string().regex(/^\d{6}$/) }).optional(),
  geo: z.strictObject({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).optional(),
  ...seoShape,
});
export type BranchPageDraft = z.infer<typeof branchPageDraft>;

const galleryRefs = (d: { gallery?: string[] | undefined; description?: string | undefined; ogMediaId?: string | undefined }) => [
  ...(d.gallery ?? []).map((mediaId, i) => ({ mediaId, field: `gallery.${i}`, altRequired: true })),
  ...(d.ogMediaId ? [{ mediaId: d.ogMediaId, field: 'og', altRequired: false }] : []),
  ...mediaIdsInText(d.description).map((mediaId) => ({ mediaId, field: 'description', altRequired: true })),
];
const needDescription = (d: { description?: string | undefined }): FieldIssue[] => (d.description?.trim() ? [] : [{ field: 'description', code: 'REQUIRED' }]);

async function branchOfRoom(db: Db, roomId: string): Promise<string> {
  const r = uuid.safeParse(roomId).success ? await db.query<{ branch_id: string }>(`SELECT branch_id FROM app.rooms WHERE id = $1`, [roomId]) : { rows: [] };
  const branchId = r.rows[0]?.branch_id;
  if (!branchId) throw new AppError('NOT_FOUND', 404, 'Не найдено');
  return branchId;
}

export const roomPageDef: EntityDef<RoomPageDraft> = {
  type: 'room_page',
  table: 'app.content_room_pages',
  schema: roomPageDraft,
  richText: (d) => [['description', d.description]],
  mediaRefs: galleryRefs,
  complete: needDescription,
  assertEdit: async (db, ctx, row) => assertCan(ctx, 'content.draft.edit', { branchId: await branchOfRoom(db, String(row.room_id)) }),
  assertPublish: async (db, ctx, row) => assertCan(ctx, 'content.publish', { branchId: await branchOfRoom(db, String(row.room_id)) }),
};

export const branchPageDef: EntityDef<BranchPageDraft> = {
  type: 'branch_page',
  table: 'app.content_branch_pages',
  schema: branchPageDraft,
  richText: (d) => [['description', d.description], ['howToGet', d.howToGet]],
  mediaRefs: galleryRefs,
  complete: needDescription,
  assertEdit: (_db, ctx, row) => assertCan(ctx, 'content.draft.edit', { branchId: String(row.branch_id) }),
  assertPublish: (_db, ctx, row) => assertCan(ctx, 'content.publish', { branchId: String(row.branch_id) }),
};

/** Страница комнаты: цель прав – филиал комнаты; комната чужого филиала и несуществующая – одинаковый 404. */
export async function ensureRoomPage(tx: Db, ctx: AccessContext, roomId: string, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<EntityRow> {
  assertCan(ctx, 'content.view', { branchId: await branchOfRoom(tx, roomId) });
  const found = await tx.query<EntityRow>(`SELECT * FROM app.content_room_pages WHERE room_id = $1`, [roomId]);
  if (found.rows[0]) return found.rows[0];
  assertCan(ctx, 'content.draft.edit', { branchId: await branchOfRoom(tx, roomId) });
  return createEntity(tx, ctx, roomPageDef, { room_id: roomId }, {}, meta, clock);
}

export async function ensureBranchPage(tx: Db, ctx: AccessContext, branchId: string, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<EntityRow> {
  if (!uuid.safeParse(branchId).success) throw new AppError('NOT_FOUND', 404, 'Не найдено');
  assertCan(ctx, 'content.view', { branchId });
  const exists = await tx.query(`SELECT 1 FROM app.branches WHERE id = $1`, [branchId]);
  if (exists.rows.length === 0) throw new AppError('NOT_FOUND', 404, 'Не найдено');
  const found = await tx.query<EntityRow>(`SELECT * FROM app.content_branch_pages WHERE branch_id = $1`, [branchId]);
  if (found.rows[0]) return found.rows[0];
  assertCan(ctx, 'content.draft.edit', { branchId });
  return createEntity(tx, ctx, branchPageDef, { branch_id: branchId }, {}, meta, clock);
}

export interface PublicRoomPage {
  description: string;
  gallery: PublicMedia[];
  features: string[];
  rentFormatsText: string | null;
  media: Record<string, PublicMedia>;
  seo: SeoDto;
  liveVersionId: string;
}

export interface PublicBranchPage {
  description: string;
  gallery: PublicMedia[];
  features: string[];
  howToGet: string | null;
  postal: BranchPageDraft['postal'] | null;
  geo: BranchPageDraft['geo'] | null;
  media: Record<string, PublicMedia>;
  seo: SeoDto;
  liveVersionId: string;
}

const galleryOf = (ids: string[] | undefined, media: Record<string, PublicMedia>) => (ids ?? []).map((id) => mediaOf(media, id)).filter((m): m is PublicMedia => m !== null);

/** Страница комнаты: is_published у resources – единственный выключатель «комната есть на сайте» (K5 №4). */
export async function getRoomPage(db: Db, roomId: string): Promise<PublicRoomPage | null> {
  if (!uuid.safeParse(roomId).success) return null;
  const r = await db.query<{ snapshot: Snapshot; live_version_id: string }>(
    `SELECT v.snapshot, p.live_version_id FROM app.content_room_pages p JOIN journal.content_versions v ON v.id = p.live_version_id
       JOIN app.rooms rm ON rm.id = p.room_id WHERE p.room_id = $1 AND p.status = 'published' AND rm.is_published`,
    [roomId],
  );
  const row = r.rows[0];
  if (!row) return null;
  const [media] = await showMedia(db, [row.snapshot]);
  const d = row.snapshot as Snapshot & RoomPageDraft;
  return { description: d.description ?? '', gallery: galleryOf(d.gallery, media!), features: d.features ?? [], rentFormatsText: d.rentFormatsText ?? null, media: media!, seo: seoDto(row.snapshot, media!, d.gallery?.[0]), liveVersionId: row.live_version_id };
}

export async function getBranchPage(db: Db, branchId: string): Promise<PublicBranchPage | null> {
  if (!uuid.safeParse(branchId).success) return null;
  const r = await db.query<{ snapshot: Snapshot; live_version_id: string }>(
    `SELECT v.snapshot, p.live_version_id FROM app.content_branch_pages p JOIN journal.content_versions v ON v.id = p.live_version_id
       JOIN app.branches b ON b.id = p.branch_id WHERE p.branch_id = $1 AND p.status = 'published' AND b.status <> 'archived'`,
    [branchId],
  );
  const row = r.rows[0];
  if (!row) return null;
  const [media] = await showMedia(db, [row.snapshot]);
  const d = row.snapshot as Snapshot & BranchPageDraft;
  return { description: d.description ?? '', gallery: galleryOf(d.gallery, media!), features: d.features ?? [], howToGet: d.howToGet ?? null, postal: d.postal ?? null, geo: d.geo ?? null, media: media!, seo: seoDto(row.snapshot, media!, d.gallery?.[0]), liveVersionId: row.live_version_id };
}

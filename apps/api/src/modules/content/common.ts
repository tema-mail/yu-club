// S4-33. Общее для сущностей контента: слаг (K23 §3), SEO-поля черновика (K23 §4), показ снимка посетителю, идентификаторы.
import { z } from 'zod';
import type { Db } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { MEDIA_PUBLIC_BASE } from './media.ts';
import { publicMedia, purgedAmong, type PublicMedia, type Snapshot } from './versions.ts';

export const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const SLUG_MAX = 90;

export function assertSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) throw new AppError('SLUG_INVALID', 422, 'Адрес: только латиница, цифры и дефис', { rule: 'mask' });
  if (slug.length > SLUG_MAX) throw new AppError('SLUG_INVALID', 422, `Адрес длиннее ${SLUG_MAX} знаков`, { rule: 'length', max: SLUG_MAX });
}

/** Слаг свободен у родителя (тип публикации, направление игры). Занят – SLUG_TAKEN с подсказкой -2, -3… (K23 §3). */
export async function assertSlugFree(tx: Db, table: string, parentColumn: string, parent: string, slug: string, selfId: string): Promise<void> {
  const free = async (s: string) => (await tx.query(`SELECT 1 FROM ${table} WHERE ${parentColumn} = $1 AND slug = $2 AND id <> $3`, [parent, s, selfId])).rows.length === 0;
  if (await free(slug)) return;
  let n = 2;
  while (!(await free(`${slug}-${n}`))) n += 1;
  throw new AppError('SLUG_TAKEN', 409, 'Такой адрес уже занят', { suggestion: `${slug}-${n}` });
}

/** Гонка двух публикаций с одним слагом: проверка выше пройдена обеими, UNIQUE ловит вторую. Точка сохранения – чтобы транзакция не умерла. */
export async function withSlugConflict<T>(tx: Db, slug: string, run: () => Promise<T>): Promise<T> {
  await tx.query('SAVEPOINT content_slug');
  try {
    const r = await run();
    await tx.query('RELEASE SAVEPOINT content_slug');
    return r;
  } catch (err) {
    await tx.query('ROLLBACK TO SAVEPOINT content_slug');
    if ((err as { code?: string }).code === '23505') throw new AppError('SLUG_TAKEN', 409, 'Такой адрес уже занят', { suggestion: `${slug}-2` });
    throw err;
  }
}

/** Ручные SEO-поля любой сущности со страницей (K23 §4): хранятся в черновике и снимке, меняются только публикацией. */
export const seoShape = {
  seoTitle: z.string().max(120).optional(),
  seoDescription: z.string().max(300).optional(),
  h1: z.string().max(90).optional(),
  ogMediaId: z.uuid().optional(),
};
export interface SeoDraft {
  seoTitle?: string | undefined;
  seoDescription?: string | undefined;
  h1?: string | undefined;
  ogMediaId?: string | undefined;
}

export const isoDate = z.iso.datetime({ offset: true });
export const uuid = z.uuid();
/** Внутренний путь сайта: ровно один «/» в начале (//host и /\host браузер читает как чужой домен). */
export const internalPath = z.string().max(500).regex(/^\/(?![/\\])[^\s\\]*$/, 'только путь этого сайта');

export interface SeoDto {
  title: string | null;
  description: string | null;
  h1: string | null;
  ogImage: string | null;
}

/** Адрес JPEG для og:image: очищенное фото и картинка без JPEG не дают адреса. */
function ogImage(media: Record<string, PublicMedia>, id: string | undefined): string | null {
  if (!id) return null;
  const jpeg = media[id]?.variants.find((v) => v.format === 'jpeg');
  return jpeg?.url ?? null;
}

export function seoDto(snapshot: Snapshot, media: Record<string, PublicMedia>, fallbackOgId?: string): SeoDto {
  const s = snapshot as Snapshot & SeoDraft;
  return { title: s.seoTitle ?? null, description: s.seoDescription ?? null, h1: s.h1 ?? null, ogImage: ogImage(media, s.ogMediaId) ?? ogImage(media, fallbackOgId) };
}

/** Снимки → их медиа для посетителя: очищенные по требованию субъекта заменены заглушкой (K22 §8). Запрос один на все снимки. */
export async function showMedia(db: Db, snapshots: readonly Snapshot[]): Promise<Array<Record<string, PublicMedia>>> {
  const ids = [...new Set(snapshots.flatMap((s) => Object.keys(s.media ?? {})))];
  const purged = await purgedAmong(db, ids);
  return snapshots.map((s) => publicMedia(s, purged));
}

export const mediaOf = (media: Record<string, PublicMedia>, id: unknown): PublicMedia | null => (typeof id === 'string' ? (media[id] ?? null) : null);

export { MEDIA_PUBLIC_BASE };

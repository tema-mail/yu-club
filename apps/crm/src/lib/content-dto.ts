// Типы ответов API content (versions.ts, publications.ts, media.ts) – без JSX и браузера: их импортируют экраны (через content.tsx)
// и мок tests/mock-*.ts, который собирает и корневой tsc (tests/core/mock-vs-api-routes.test.ts).

export type ContentStatus = 'draft' | 'published' | 'unpublished' | 'archived';
export type PublicationType = 'news' | 'promotion' | 'giveaway' | 'tournament';
export type Scope = { type: 'network' } | { type: 'city'; cityIds: string[] } | { type: 'branch'; branchIds: string[] };
export type EntityType = 'publication' | 'game' | 'room_page' | 'branch_page' | 'content_page' | 'home_block';
export type AllowedAction = 'edit' | 'publish' | 'unpublish' | 'archive' | 'rollback';

/** draftDto сервера (versions.ts). У ещё не созданной страницы id = null и rowVersion = 1. */
export interface DraftDto {
  id: string | null;
  status: ContentStatus;
  draft: Record<string, unknown>;
  rowVersion: number;
  liveVersionId: string | null;
  draftUpdatedAt?: string;
  draftUpdatedBy?: string;
  createdAt?: string;
  archivedAt?: string | null;
}
export interface PublicationDto extends DraftDto {
  id: string;
  type: PublicationType;
  slug: string | null;
  live?: Record<string, unknown> | null;
  allowedActions: AllowedAction[];
}
export interface VersionDto {
  id: string;
  versionNo: number;
  action: 'publish' | 'rollback_publish';
  publishedBy: string;
  publishedByName: string | null;
  publishedAt: string;
  reason: string | null;
  sourceVersionId: string | null;
  snapshot: Record<string, unknown>;
}
/** media.ts mediaDto сервера: variants – файлы-размеры (WebP/JPEG), storageKey – ключ относительно MEDIA_DIR. */
export interface MediaVariant { w: number; h: number; format: 'webp' | 'jpeg'; key: string }
export interface MediaDto {
  id: string; mime: string; bytes: number; width: number | null; height: number | null; variants: MediaVariant[]; storageKey: string; url: string; alt: string | null; title: string | null;
  originalName: string | null; purpose: 'image' | 'document'; status: 'active' | 'archived' | 'purged'; createdAt: string; archivedAt: string | null; rowVersion: number;
}
export interface BranchRef { id: string; name: string; cityId: string; cityName: string; timezone: string }

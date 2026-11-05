// S4-42. Внутренний маршрут черновика для предпросмотра K22 §11: GET /api/internal/v1/content/preview/{token}.
// Доступен только с X-Preview-Secret; без него и при любой ошибке токена – 404, как нет страницы. Публичный домен сюда не пускает (Caddy → 404, S4-07).
// Единственное место, откуда черновик выходит за пределы CRM: его забирает сервер сайта и рисует страницу для iframe CRM.
import type { FastifyInstance } from 'fastify';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Db } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { systemClock, type Clock } from '../../core/time.ts';
import { blockDef, type BlockDraft } from './blocks.ts';
import { gameDef, type GameDraft } from './games.ts';
import { branchPageDef, pageDef, roomPageDef, type BranchPageDraft, type PageDraft, type RoomPageDraft } from './pages.ts';
import { resolvePreview } from './preview.ts';
import { publicationDef, type PublicationDraft } from './publications.ts';
import type { EntityType } from './versions.ts';

export interface InternalContentDeps {
  pool: Db;
  previewSecret: string;
  clock?: Clock;
}

/** Сравнение секрета за постоянное время: сравниваем хеши, длина заголовка не утекает. */
function secretMatches(given: unknown, secret: string): boolean {
  if (typeof given !== 'string') return false;
  const digest = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(digest(given), digest(secret));
}

const MEDIA_OF: Record<EntityType, (draft: Record<string, unknown>) => string[]> = {
  publication: (d) => publicationDef.mediaRefs(d as PublicationDraft).map((r) => r.mediaId),
  game: (d) => gameDef.mediaRefs(d as GameDraft).map((r) => r.mediaId),
  room_page: (d) => roomPageDef.mediaRefs(d as RoomPageDraft).map((r) => r.mediaId),
  branch_page: (d) => branchPageDef.mediaRefs(d as BranchPageDraft).map((r) => r.mediaId),
  content_page: (d) => pageDef.mediaRefs(d as PageDraft).map((r) => r.mediaId),
  home_block: (d) => blockDef.mediaRefs(d as BlockDraft).map((r) => r.mediaId),
};

export async function contentInternalRoutes(app: FastifyInstance, deps: InternalContentDeps): Promise<void> {
  const clock = deps.clock ?? systemClock;
  // Звёздочка, а не :token: токен длиннее предела параметра Fastify (maxParamLength = 100, иначе 414). Косая в токене не пройдёт проверку подписи.
  app.get('/content/preview/*', async (request, reply) => {
    if (!secretMatches(request.headers['x-preview-secret'], deps.previewSecret)) throw new AppError('NOT_FOUND', 404, 'Не найдено');
    const token = (request.params as { '*': string })['*'];
    // тип сущности подписан в токене: resolvePreview сам выбирает, какие медиа нужны, по entityType
    const preview = await resolvePreview(deps.pool, deps.previewSecret, token, clock.now(), (draft, type) => MEDIA_OF[type](draft));
    void reply.header('cache-control', 'no-store');
    return preview;
  });
}

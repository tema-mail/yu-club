// S4-53: №216 разрешение старого адреса и №217 записи карты сайта (K23 §5, §8).
// S4-37. Публичный API контента K5 №207–215 (K22 §12): без сессии, только живые версии. Ответы – Cache-Control: public, max-age=60 и
// ETag по live_version_id вошедших сущностей (рассчитаны на сервер сайта). DTO без draft, автора и created_by – поля перечислены явно в модулях.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Db } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { resolveSettings } from '../../core/settings.ts';
import { systemClock, type Clock } from '../../core/time.ts';
import { getHomeBlocks } from './blocks.ts';
import { GAME_DIRECTIONS, getGamePage, listGames } from './games.ts';
import { getBranchPage, getPage, getRoomPage, legalVersions } from './pages.ts';
import { resolveLegacyPath, sitemapEntries } from './paths.ts';
import { getPublicationPage, listPublications, PUBLICATION_TYPES } from './publications.ts';

export interface ContentPublicDeps {
  pool: Db;
  clock?: Clock;
}

const notFound = () => new AppError('NOT_FOUND', 404, 'Не найдено');

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value ?? {});
  if (!r.success) throw new AppError('VALIDATION_FAILED', 400, 'Неверные параметры запроса', { issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  return r.data;
}

const id = z.uuid().optional();
const homeQuery = z.object({ city: id });
const listQuery = z.object({ type: z.enum(PUBLICATION_TYPES).optional(), city: id, branch: id, cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(50).optional() });
const pubParams = z.object({ type: z.enum(PUBLICATION_TYPES), slug: z.string().max(200) });
const pubQuery = z.object({ branch: id });
const gamesQuery = z.object({ direction: z.enum(GAME_DIRECTIONS).optional(), branch: id });
const gameParams = z.object({ direction: z.enum(GAME_DIRECTIONS), slug: z.string().max(200) });
const pageQuery = z.object({ city: id });
/** Только путь этого сайта: без хоста, параметров и доли (K23 §8). */
const resolveQuery = z.object({ path: z.string().max(300).regex(/^\/(?![/\\])[^\s\\?#]*$/) });
/** Реквизиты оператора – ключи K7 «Реквизиты оператора» (№218). */
const REQUISITE_KEYS = ['legal.operator_name', 'legal.inn', 'legal.ogrn', 'legal.address', 'legal.phone', 'legal.email'] as const;

/** Кэш: тело + ETag по версиям вошедших сущностей; совпал If-None-Match – 304 без тела. */
function cached(request: FastifyRequest, reply: FastifyReply, versionIds: readonly string[], body: unknown) {
  const hash = createHash('sha256').update([...versionIds].sort().join(',')).digest('base64url').slice(0, 27);
  const etag = `"${hash}"`;
  void reply.header('cache-control', 'public, max-age=60').header('etag', etag);
  if (request.headers['if-none-match'] === etag) return reply.code(304).send();
  return reply.send(body);
}

/** Внутренний номер версии посетителю не нужен: он – только вход ETag. */
function withoutVersion<T extends { liveVersionId: string }>(page: T): Omit<T, 'liveVersionId'> {
  const copy: Partial<T> = { ...page };
  delete copy.liveVersionId;
  return copy as Omit<T, 'liveVersionId'>;
}

export async function contentPublicRoutes(app: FastifyInstance, deps: ContentPublicDeps): Promise<void> {
  const clock = deps.clock ?? systemClock;
  const db = deps.pool;

  // №207 главная
  app.get('/content/home', async (request, reply) => {
    const { city } = parse(homeQuery, request.query);
    const now = clock.now();
    const visitor = city ? { cityId: city } : {};
    const [home, promos, news, games] = await Promise.all([
      getHomeBlocks(db, { cityId: city }),
      listPublications(db, { type: 'promotion', visitor, limit: 6, now }),
      listPublications(db, { type: 'news', visitor, limit: 3, now }),
      listGames(db, { limit: 20 }),
    ]);
    const versions = [...home.versionIds, ...promos.versionIds, ...news.versionIds, ...games.versionIds];
    return cached(request, reply, versions, { blocks: home.blocks.map(withoutVersion), promos: promos.items, news: news.items, games: games.items });
  });

  // №208 список публикаций
  app.get('/content/publications', async (request, reply) => {
    const q = parse(listQuery, request.query);
    const r = await listPublications(db, { type: q.type, visitor: q.branch ? { branchId: q.branch } : q.city ? { cityId: q.city } : {}, cursor: q.cursor, limit: q.limit, now: clock.now() });
    return cached(request, reply, r.versionIds, { items: r.items, nextCursor: r.nextCursor });
  });

  // №209 страница публикации: при ?branch= – действует ли она в выбранном филиале (12 §8.5)
  app.get('/content/publications/:type/:slug', async (request, reply) => {
    const p = parse(pubParams, request.params);
    const { branch } = parse(pubQuery, request.query);
    const page = await getPublicationPage(db, { type: p.type, slug: p.slug, now: clock.now() });
    if (!page) throw notFound();
    let appliesHere: boolean | null = null;
    if (branch) {
      const b = await db.query<{ city_id: string }>(`SELECT city_id FROM app.branches WHERE id = $1`, [branch]);
      appliesHere = page.onlyIn.length === 0 || page.onlyIn.some((o) => o.id === branch || o.id === b.rows[0]?.city_id);
    }
    return cached(request, reply, [page.liveVersionId], { ...withoutVersion(page), appliesHere });
  });

  // №210 каталог игр
  app.get('/content/games', async (request, reply) => {
    const q = parse(gamesQuery, request.query);
    const r = await listGames(db, { direction: q.direction, branchId: q.branch });
    return cached(request, reply, r.versionIds, { items: r.items, networkCatalog: r.networkCatalog });
  });

  // №211 карточка игры: без full – 404
  app.get('/content/games/:direction/:slug', async (request, reply) => {
    const p = parse(gameParams, request.params);
    const page = await getGamePage(db, { direction: p.direction, slug: p.slug });
    if (!page) throw notFound();
    return cached(request, reply, [page.liveVersionId], withoutVersion(page));
  });

  // №212 страница по ключу: ключ вне списка – PAGE_KEY_UNKNOWN; не опубликована – 404 (сайт рисует «Документ готовится»)
  app.get('/content/pages/:key', async (request, reply) => {
    const { city } = parse(pageQuery, request.query);
    const page = await getPage(db, { key: (request.params as { key: string }).key, cityId: city });
    if (!page) throw notFound();
    return cached(request, reply, [page.liveVersionId], withoutVersion(page));
  });

  // №213 страница комнаты
  app.get('/content/rooms/:roomId', async (request, reply) => {
    const page = await getRoomPage(db, (request.params as { roomId: string }).roomId);
    if (!page) throw notFound();
    return cached(request, reply, [page.liveVersionId], withoutVersion(page));
  });

  // №214 страница филиала
  app.get('/content/branches/:branchId', async (request, reply) => {
    const page = await getBranchPage(db, (request.params as { branchId: string }).branchId);
    if (!page) throw notFound();
    return cached(request, reply, [page.liveVersionId], withoutVersion(page));
  });

  // №215 живые версии юридических документов
  app.get('/content/legal-versions', async (request, reply) => {
    const versions = await legalVersions(db);
    return cached(request, reply, Object.values(versions).map((v) => v ?? '-'), versions);
  });

  // №218 реквизиты оператора (K7 «Реквизиты оператора»): настройки сети legal.*, читает /contacts/ и юридические тексты сайта.
  // Пустые – null: сайт блок не рисует. Версий сущностей у настроек нет – ETag по самим значениям; кэш тот же, 60 с.
  app.get('/content/requisites', async (request, reply) => {
    const s = await resolveSettings(db, REQUISITE_KEYS, { network: true }, clock.now());
    const v = (key: (typeof REQUISITE_KEYS)[number]) => s[key].value.trim() || null;
    const body = { operatorName: v('legal.operator_name'), inn: v('legal.inn'), ogrn: v('legal.ogrn'), address: v('legal.address'), phone: v('legal.phone'), email: v('legal.email') };
    return cached(request, reply, [JSON.stringify(body)], body);
  });

  // №216 старый адрес → текущий канонический одним переходом; не найдено – 404 (кэш тот же: посетитель с мусорным адресом не нагружает базу)
  app.get('/redirects/resolve', async (request, reply) => {
    const { path } = parse(resolveQuery, request.query);
    const hit = await resolveLegacyPath(db, path, clock.now());
    void reply.header('cache-control', 'public, max-age=60');
    if (!hit) throw notFound();
    return { location: hit.location };
  });

  // №217 индексируемые сущности контента для sitemap.xml и /sitemap/ (факты городов, филиалов и комнат сайт берёт из K5 №1–4)
  app.get('/seo/sitemap-entries', async (_request, reply) => {
    const items = await sitemapEntries(db, clock.now());
    void reply.header('cache-control', 'public, max-age=60');
    return { items };
  });
}

// S4-110. Клиент публичного API контента (K22 §12, K5 №207–215) для SSR сайта: кэш в памяти процесса.
// Свежий ответ ≤ TTL (CONTENT_CACHE_TTL_SECONDS, по умолчанию 60 с) – без запроса; дальше – запрос с If-None-Match, 304 продлевает запись.
// Сбой API (сеть, 5xx) при записи не старше 10 минут – устаревший ответ с записью в лог (stale-if-error), иначе ApiError 503.
// Нет или не опубликовано (404) – null, тоже кэшируется на TTL: публикация видна не позже чем через TTL.
// Через кэш идут только пути /content/…: доступность, удержания и ЛК – мимо (Q-81 «доступность – сразу»).
import { ApiError, API_PREFIX, apiBase } from './api.ts';
import type { MediaMap, RichMedia } from './rich-text.ts';

// ---- DTO – как отдаёт apps/api/src/modules/content (publications.ts, games.ts, pages.ts, blocks.ts)

export type PublicationType = 'news' | 'promotion' | 'giveaway' | 'tournament';
export type GameDirection = 'pc' | 'vr' | 'playstation';
export interface SeoDto { title: string | null; description: string | null; h1: string | null; ogImage: string | null }
export interface OnlyIn { type: 'city' | 'branch'; id: string; name: string }

export interface PublicationCard {
  id: string; type: PublicationType; slug: string; title: string; lead: string; cover: RichMedia | null;
  publishFrom: string; publishTo: string | null; eventDate: string | null;
  /** Пусто – вся сеть; иначе «только в {город}/{филиал}» (K22 §4). */
  onlyIn: OnlyIn[];
}
export interface PublicationPage extends PublicationCard {
  body: string; conditions: string | null; restrictions: string | null; ctaLabel: string | null; ctaUrl: string | null;
  resultsDate: string | null; prize: string | null; rulesBody: string | null; rules: RichMedia | null; rulesUrl: string | null;
  media: MediaMap; state: 'active' | 'ended'; indexable: boolean; seo: SeoDto;
  /** null – филиал не передан; false – публикация в выбранном филиале не действует (12 §8.5). */
  appliesHere: boolean | null;
}

export interface GameCard {
  id: string; direction: GameDirection; slug: string | null; hasPage: boolean; title: string; short: string; cover: RichMedia | null;
  genres: string[]; ageRating: string | null; platforms: string[]; note: string | null;
}
export interface GameBranchRef { id: string; name: string; slug: string; citySlug: string; note: string | null }
export interface GamePage extends GameCard { full: string; media: MediaMap; availableIn: GameBranchRef[]; seo: SeoDto }

export type BlockType = 'hero' | 'about' | 'directions' | 'advantages' | 'promo_strip' | 'cta';
export interface HomeBlock { id: string; blockType: BlockType; cityOverride: boolean; payload: Record<string, unknown>; media: MediaMap }
/** seo – ручные поля баннера hero для мета главной (K22 §12 №207, K23 §4); нет живого баннера – null. */
export interface HomeContent { blocks: HomeBlock[]; seo: SeoDto | null; promos: PublicationCard[]; news: PublicationCard[]; games: GameCard[] }

export type PageKey = 'about' | 'rules' | 'contacts_intro' | 'privacy-policy' | 'personal-data-consent' | 'cookie-policy' | 'advertising-consent';
export interface PublicPage { key: PageKey; title: string; body: string; documentVersion: string | null; updatedAt: string; media: MediaMap; seo: SeoDto }
export interface RoomPage { description: string; gallery: RichMedia[]; features: string[]; rentFormatsText: string | null; media: MediaMap; seo: SeoDto }
export interface BranchPage {
  description: string; gallery: RichMedia[]; features: string[]; howToGet: string | null;
  postal: { street: string; locality: string; region: string; postalCode: string } | null;
  geo: { lat: number; lng: number } | null; media: MediaMap; seo: SeoDto;
}
export interface LegalVersions { privacyPolicy: string | null; personalDataConsent: string | null; cookiePolicy: string | null; advertisingConsent: string | null }
/** K5 №218: реквизиты оператора из настроек сети legal.* (K7); не заданы – null, блок на /contacts/ не рисуется. */
export interface Requisites { operatorName: string | null; inn: string | null; ogrn: string | null; address: string | null; phone: string | null; email: string | null }

// ---- кэш

interface Entry { body: unknown; etag: string | null; checkedAt: number }

export interface ContentClientOptions {
  fetch?: typeof fetch;
  now?: () => number;
  ttlMs?: number;
  /** Сколько отдавать устаревшее при сбое API (K22 §12: 10 минут). */
  staleMs?: number;
  max?: number;
  base?: () => string;
  log?: (message: string, err: unknown) => void;
}

const ttlFromEnv = () => {
  const s = Number(process.env.CONTENT_CACHE_TTL_SECONDS);
  return Number.isFinite(s) && s >= 0 ? s * 1000 : 60_000;
};

/** Ответ API или null (404). 304 – прежнее тело. */
type Fetched = { kind: 'body'; body: unknown; etag: string | null } | { kind: 'same' };

export function createContentClient(opts: ContentClientOptions = {}) {
  const doFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const now = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? ttlFromEnv();
  const staleMs = opts.staleMs ?? 10 * 60_000;
  const max = opts.max ?? 500;
  const base = opts.base ?? apiBase;
  const log = opts.log ?? ((m: string, e: unknown) => console.error(m, e));
  const cache = new Map<string, Entry>(); // порядок вставки = порядок использования (LRU)
  const inflight = new Map<string, Promise<unknown>>();

  function remember(path: string, e: Entry) {
    cache.delete(path);
    cache.set(path, e);
    while (cache.size > max) cache.delete(cache.keys().next().value!);
  }

  async function load(path: string, etag: string | null): Promise<Fetched> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (etag) headers['if-none-match'] = etag;
    let res: Response;
    try {
      res = await doFetch(`${base()}${API_PREFIX}${path}`, { headers, redirect: 'manual' });
    } catch {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'API не отвечает');
    }
    if (res.status === 304) return { kind: 'same' };
    if (res.status === 404) return { kind: 'body', body: null, etag: null };
    if (!res.ok) {
      let body: { error?: { code?: string; message?: string } } = {};
      try {
        body = (await res.json()) as typeof body;
      } catch {
        // не JSON
      }
      throw new ApiError(res.status, body.error?.code ?? 'INTERNAL', body.error?.message ?? 'Ошибка сервера');
    }
    return { kind: 'body', body: await res.json(), etag: res.headers.get('etag') };
  }

  async function refresh(path: string): Promise<unknown> {
    const old = cache.get(path);
    try {
      const r = await load(path, old?.etag ?? null);
      const body = r.kind === 'same' ? old!.body : r.body;
      remember(path, { body, etag: r.kind === 'same' ? old!.etag : r.etag, checkedAt: now() });
      return body;
    } catch (err) {
      const serverSide = !(err instanceof ApiError) || err.status >= 500;
      if (serverSide && old && now() - old.checkedAt <= staleMs) {
        log(`site: API контента не ответил, отдаём сохранённое (${path})`, err);
        return old.body;
      }
      if (serverSide) throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'API контента не отвечает');
      throw err;
    }
  }

  /** Ответ пути /content/… или null (нет / не опубликовано). */
  async function get<T>(path: string): Promise<T | null> {
    if (!path.startsWith('/content/')) throw new Error(`Кэш контента – только /content/…, не ${path}`);
    const hit = cache.get(path);
    if (hit && now() - hit.checkedAt < ttl) {
      remember(path, hit);
      return hit.body as T | null;
    }
    let p = inflight.get(path);
    if (!p) {
      p = refresh(path).finally(() => inflight.delete(path));
      inflight.set(path, p);
    }
    return (await p) as T | null;
  }

  return { get, clear: () => cache.clear(), size: () => cache.size };
}

const q = (params: Record<string, string | number | null | undefined>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v));
  const t = s.toString();
  return t ? `?${t}` : '';
};
const seg = encodeURIComponent;

/** Один кэш на процесс сайта. */
export const contentCache = createContentClient();

/** Обязательный ответ: null от API здесь – тоже ошибка данных, страницы 503. */
async function must<T>(p: Promise<T | null>): Promise<T> {
  const r = await p;
  if (r === null) throw new ApiError(404, 'NOT_FOUND', 'Не найдено');
  return r;
}

export const content = {
  home: (cityId?: string) => must(contentCache.get<HomeContent>(`/content/home${q({ city: cityId })}`)),
  publications: (o: { type?: PublicationType; cityId?: string | undefined; branchId?: string | undefined; cursor?: string | undefined; limit?: number }) =>
    must(contentCache.get<{ items: PublicationCard[]; nextCursor: string | null }>(`/content/publications${q({ type: o.type, city: o.cityId, branch: o.branchId, cursor: o.cursor, limit: o.limit })}`)),
  publication: (type: PublicationType, slug: string, branchId?: string) =>
    contentCache.get<PublicationPage>(`/content/publications/${type}/${seg(slug)}${q({ branch: branchId })}`),
  games: (o: { direction?: GameDirection | undefined; branchId?: string | undefined }) =>
    must(contentCache.get<{ items: GameCard[]; networkCatalog: boolean }>(`/content/games${q({ direction: o.direction, branch: o.branchId })}`)),
  game: (direction: GameDirection, slug: string) => contentCache.get<GamePage>(`/content/games/${direction}/${seg(slug)}`),
  page: (key: PageKey, cityId?: string) => contentCache.get<PublicPage>(`/content/pages/${key}${q({ city: cityId })}`),
  room: (roomId: string) => contentCache.get<RoomPage>(`/content/rooms/${seg(roomId)}`),
  branch: (branchId: string) => contentCache.get<BranchPage>(`/content/branches/${seg(branchId)}`),
  legalVersions: () => must(contentCache.get<LegalVersions>('/content/legal-versions')),
  requisites: () => must(contentCache.get<Requisites>('/content/requisites')),
};

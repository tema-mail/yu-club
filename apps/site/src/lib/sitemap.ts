/// <reference types="vite/client" />
// K23 §7 (S4-56). Один список адресов для sitemap.xml и HTML-карты /sitemap/: решение индексации – isIndexablePage (K23 §2), поэтому meta robots,
// sitemap.xml и /sitemap/ не расходятся. Факты городов, филиалов, комнат – K5 №1–4; контент и даты – K5 №217.
// Адрес попадает в карту, только если у него есть страница на сайте: разделы Э4 включаются сами с появлением файла в src/pages (hasRoute).
import { STATIC_PATHS, branchPath, cityPath, gamesPath, parsePath, publicationsPath, roomPath, type GameDirection, type PublicationType } from '../../../../packages/contracts/src/paths.ts';
import { apiBase, API_PREFIX, branchRooms, site, type CityWithBranches } from './api.ts';
import { isIndexablePage } from './seo.ts';

export interface ContentEntry {
  path: string;
  title: string | null;
  lastmod: string | null;
}
export interface SitemapItem {
  path: string;
  title: string;
  lastmod: string | null;
}
export interface SitemapSection {
  title: string;
  items: SitemapItem[];
}

export interface SitemapInput {
  network: CityWithBranches[];
  /** Опубликованные комнаты по id филиала (K5 №4 других не отдаёт). */
  rooms: ReadonlyMap<string, ReadonlyArray<{ slug: string; name: string }>>;
  entries: readonly ContentEntry[];
  /** Файлы страниц относительно src/pages. */
  routes: readonly string[];
}

const DIRECTION_TITLE: Record<GameDirection, string> = { pc: 'Игры на ПК', vr: 'Игры VR', playstation: 'Игры на PlayStation' };
const PUBLICATION_TITLE: Record<PublicationType, string> = { news: 'Новости', promotion: 'Акции', giveaway: 'Розыгрыши', tournament: 'Турниры' };
const PUBLICATION_DIR: Record<PublicationType, string> = { news: 'news', promotion: 'promotions', giveaway: 'giveaways', tournament: 'tournaments' };

/** Есть ли страница: точный файл или его форма с index. */
const exists = (routes: readonly string[], base: string) => routes.includes(`${base}.astro`) || routes.includes(`${base}/index.astro`);
/** Динамическая страница внутри каталога: имя параметра не важно ([slug], [game]). */
const existsDynamic = (routes: readonly string[], re: RegExp) => routes.some((r) => re.test(r));

export function buildSitemap(input: SitemapInput): SitemapSection[] {
  const { network, rooms, entries, routes } = input;
  const dates = new Map(entries.map((e) => [e.path, e.lastmod]));
  const item = (path: string, title: string): SitemapItem => ({ path, title, lastmod: dates.get(path) ?? null });
  const infoPages = existsDynamic(routes, /^info\/\[[^\]]+\]\.astro$/);
  const content = entries.map((e) => ({ e, m: parsePath(e.path) }));

  const main: SitemapItem[] = [item(STATIC_PATHS.home, 'Главная')];
  if (exists(routes, 'schedule')) main.push(item(STATIC_PATHS.schedule, 'Расписание и запись'));
  if (exists(routes, 'rooms')) main.push(item(STATIC_PATHS.rooms, 'Комнаты'));
  if (exists(routes, 'birthday')) main.push(item(STATIC_PATHS.birthday, 'День рождения'));
  // Страница из CMS: нет живой версии – «О клубе» отдаёт 404, в карте её быть не должно.
  if ((exists(routes, 'about') || infoPages) && dates.has(STATIC_PATHS.about)) main.push(item(STATIC_PATHS.about, 'О клубе'));
  if (exists(routes, 'contacts')) main.push(item(STATIC_PATHS.contacts, 'Контакты'));
  main.push(item(STATIC_PATHS.rules, 'Правила клуба'));
  if (exists(routes, 'sitemap')) main.push(item(STATIC_PATHS.sitemap, 'Карта сайта'));

  const clubs: SitemapItem[] = [];
  for (const c of network) {
    if (isIndexablePage({ kind: 'city', openBranches: c.branches.length })) clubs.push(item(cityPath(c.slug), c.name));
    for (const b of c.branches) {
      if (!isIndexablePage({ kind: 'branch', status: b.status })) continue;
      clubs.push(item(branchPath(c.slug, b.slug), `${c.name}: ${b.name}`));
      for (const r of rooms.get(b.id) ?? []) {
        if (isIndexablePage({ kind: 'room', published: true, branchStatus: b.status })) clubs.push(item(roomPath(c.slug, b.slug, r.slug), `${b.name}: ${r.name}`));
      }
    }
  }

  const games: SitemapItem[] = [];
  if (exists(routes, 'games')) games.push(item(gamesPath(), 'Все игры'));
  if (existsDynamic(routes, /^games\/\[[^\]]+\](\/index)?\.astro$/)) {
    for (const d of Object.keys(DIRECTION_TITLE) as GameDirection[]) games.push(item(gamesPath(d), DIRECTION_TITLE[d]));
  }
  if (existsDynamic(routes, /^games\/\[[^\]]+\]\/\[[^\]]+\]\.astro$/)) {
    for (const { e, m } of content) if (m?.kind === 'game' && e.title) games.push(item(e.path, e.title));
  }

  const publications: SitemapItem[] = [];
  for (const type of Object.keys(PUBLICATION_TITLE) as PublicationType[]) {
    const live = content.filter(({ m }) => m?.kind === 'publication' && m.type === type);
    const dir = PUBLICATION_DIR[type];
    // Хаб турниров без материала – noindex (K23 §2); остальные хабы индексируются всегда.
    if (exists(routes, dir) && (type !== 'tournament' || isIndexablePage({ kind: 'hubWithMaterial', hasMaterial: live.length > 0 }))) {
      publications.push(item(publicationsPath(type), PUBLICATION_TITLE[type]));
    }
    if (existsDynamic(routes, new RegExp(`^${dir}/\\[[^\\]]+\\]\\.astro$`))) {
      for (const { e } of live) if (e.title) publications.push(item(e.path, e.title));
    }
  }

  return [
    { title: 'Главное', items: main },
    { title: 'Клубы и комнаты', items: clubs },
    { title: 'Игры', items: games },
    { title: 'Новости и акции', items: publications },
  ].filter((s) => s.items.length > 0);
}

/** Адреса страниц: разделы Э4 попадают в карту сами, когда появляется файл страницы. */
const PAGE_FILES = Object.keys(import.meta.glob('/src/pages/**/*.astro')).map((f) => f.replace('/src/pages/', ''));

/** Всё для карты по живым данным. Сбой API – исключение: страницы отвечают 503, а не урезанной картой. */
export async function loadSitemap(network: CityWithBranches[]): Promise<SitemapSection[]> {
  const branches = network.flatMap((c) => c.branches);
  const [roomLists, res] = await Promise.all([
    Promise.all(branches.map(async (b) => [b.id, branchRooms(await site.resources(b.id)).map((r) => ({ slug: r.slug, name: r.name }))] as const)),
    fetch(`${apiBase()}${API_PREFIX}/seo/sitemap-entries`, { headers: { accept: 'application/json' }, redirect: 'manual' }),
  ]);
  if (!res.ok) throw new Error(`seo/sitemap-entries: ${res.status}`);
  const { items } = (await res.json()) as { items: ContentEntry[] };
  return buildSitemap({ network, rooms: new Map(roomLists), entries: items, routes: PAGE_FILES });
}

// K23 §1. Реестр адресов публичного сайта – единственный источник шаблонов (карта сайта docs/karta-sayta.md, разделы 1 и 3).
// Строители и обратный разбор: parsePath(buildPath(x)) = x для каждого шаблона. Новый адрес – только правкой карты сайта
// и этого файла (правило «не дорвеи»: город и филиал не размножают сетевые страницы, карта п.2.9).
// Без зависимостей: файл импортируют сайт (SSR и острова), API (content/paths.ts, K23 §5) и тесты.
// CRM – отдельный домен (карта, дерево), в реестр сайта не входит.

/** Слаг: нижний регистр, латиница и цифры, дефис между словами (карта п.2.1). Длины – K23 §3 (город 40, игра и публикация 90). */
export const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Первый сегмент служебных адресов – слаг города не может с ним совпасть (карта п.2.8 + адреса Э4; CHECK 0405). */
export const RESERVED_CITY_SLUGS = [
  'rooms', 'games', 'schedule', 'birthday', 'news', 'promotions', 'giveaways', 'tournaments', 'reviews', 'about', 'contacts',
  'rules', 'privacy-policy', 'personal-data-consent', 'cookie-policy', 'advertising-consent', 'login', 'account', 'sitemap',
  'api', 'admin', 'crm', 'assets', 'media', 'preview', 'unsubscribe', 'info',
] as const;
const RESERVED = new Set<string>(RESERVED_CITY_SLUGS);

export const GAME_DIRECTIONS = ['pc', 'vr', 'playstation'] as const;
export type GameDirection = (typeof GAME_DIRECTIONS)[number];

/** Тип публикации K22 §2 → сегмент адреса (K23 §1). */
export const PUBLICATION_SEGMENT = { news: 'news', promotion: 'promotions', giveaway: 'giveaways', tournament: 'tournaments' } as const;
export type PublicationType = keyof typeof PUBLICATION_SEGMENT;

export const LEGAL_KEYS = ['privacy-policy', 'personal-data-consent', 'cookie-policy', 'advertising-consent'] as const;
export type LegalKey = (typeof LEGAL_KEYS)[number];

/** Страницы без параметров (карта 3.1, 3.3, 3.5): ключ → адрес. */
export const STATIC_PATHS = {
  home: '/',
  rooms: '/rooms/',
  games: '/games/',
  schedule: '/schedule/',
  birthday: '/birthday/',
  reviews: '/reviews/',
  about: '/about/',
  contacts: '/contacts/',
  rules: '/rules/',
  login: '/login/',
  notFound: '/404',
  sitemap: '/sitemap/',
  sitemapXml: '/sitemap.xml',
  robots: '/robots.txt',
} as const;
export type StaticPage = keyof typeof STATIC_PATHS;

/** Разделы ЛК (карта 3.6, за логином, noindex); '' – обзор /account/. */
export const ACCOUNT_SECTIONS = ['', 'profile', 'bookings', 'visits', 'bonuses', 'certificates', 'payments', 'notifications', 'settings', 'support'] as const;
export type AccountSection = (typeof ACCOUNT_SECTIONS)[number];

export type PathMatch =
  | { kind: 'static'; page: StaticPage }
  | { kind: 'city'; city: string }
  | { kind: 'branch'; city: string; branch: string }
  | { kind: 'branchRooms'; city: string; branch: string } // промежуточный сегмент: 301 на /{city}/{branch}/#rooms (карта п.2.11)
  | { kind: 'room'; city: string; branch: string; room: string }
  | { kind: 'gamesDirection'; direction: GameDirection }
  | { kind: 'game'; direction: GameDirection; game: string }
  | { kind: 'publications'; type: PublicationType }
  | { kind: 'publication'; type: PublicationType; slug: string }
  | { kind: 'giveawayRules'; slug: string }
  | { kind: 'legal'; key: LegalKey }
  | { kind: 'account'; section: AccountSection }
  | { kind: 'accountBooking'; id: string };

// ---- строители (значения – слаги из данных; проверку слагов делают владельцы при сохранении, K23 §3)

export const cityPath = (city: string) => `/${city}/`;
export const branchPath = (city: string, branch: string) => `/${city}/${branch}/`;
export const roomPath = (city: string, branch: string, room: string) => `/${city}/${branch}/rooms/${room}/`;
export const gamesPath = (direction?: GameDirection) => (direction ? `/games/${direction}/` : '/games/');
export const gamePath = (direction: GameDirection, slug: string) => `/games/${direction}/${slug}/`;
export const publicationsPath = (type: PublicationType) => `/${PUBLICATION_SEGMENT[type]}/`;
export const publicationPath = (type: PublicationType, slug: string) => `/${PUBLICATION_SEGMENT[type]}/${slug}/`;
export const giveawayRulesPath = (slug: string) => `/giveaways/${slug}/rules/`;
export const accountPath = (section: AccountSection = '') => (section ? `/account/${section}/` : '/account/');

/** Ключ страницы CMS (K22 §5) → адрес; contacts_intro – текст на /contacts/. */
export function pagePath(key: 'about' | 'rules' | 'contacts_intro' | LegalKey): string {
  if (key === 'about') return STATIC_PATHS.about;
  if (key === 'rules') return STATIC_PATHS.rules;
  if (key === 'contacts_intro') return STATIC_PATHS.contacts;
  return `/${key}/`;
}

export function buildPath(m: PathMatch): string {
  switch (m.kind) {
    case 'static':
      return STATIC_PATHS[m.page];
    case 'city':
      return cityPath(m.city);
    case 'branch':
      return branchPath(m.city, m.branch);
    case 'branchRooms':
      return `/${m.city}/${m.branch}/rooms/`;
    case 'room':
      return roomPath(m.city, m.branch, m.room);
    case 'gamesDirection':
      return gamesPath(m.direction);
    case 'game':
      return gamePath(m.direction, m.game);
    case 'publications':
      return publicationsPath(m.type);
    case 'publication':
      return publicationPath(m.type, m.slug);
    case 'giveawayRules':
      return giveawayRulesPath(m.slug);
    case 'legal':
      return `/${m.key}/`;
    case 'account':
      return accountPath(m.section);
    case 'accountBooking':
      return `/account/bookings/${m.id}/`;
  }
}

// ---- разбор

const STATIC_BY_PATH = new Map<string, StaticPage>(Object.entries(STATIC_PATHS).map(([k, v]) => [v, k as StaticPage]));
const SEGMENT_TO_TYPE = new Map<string, PublicationType>(
  Object.entries(PUBLICATION_SEGMENT).map(([t, s]) => [s, t as PublicationType]),
);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isSlug = (s: string | undefined, max = 90): s is string => s !== undefined && s.length <= max && SLUG_RE.test(s);
const isDirection = (s: string | undefined): s is GameDirection => (GAME_DIRECTIONS as readonly string[]).includes(s ?? '');

/** Только нормализованный путь (нижний регистр, слеш в конце, без параметров – K23 §1); иначе null.
 *  Ненормализованный адрес middleware сначала приводит normalizePath и отдаёт 301. */
export function parsePath(pathname: string): PathMatch | null {
  const fixed = STATIC_BY_PATH.get(pathname);
  if (fixed) return { kind: 'static', page: fixed };
  if (!pathname.startsWith('/') || !pathname.endsWith('/') || pathname.includes('//')) return null;
  const seg = pathname.slice(1, -1).split('/');
  const [a, b, c, d] = seg;
  const n = seg.length;
  if (a === 'games') {
    if (n === 2 && isDirection(b)) return { kind: 'gamesDirection', direction: b };
    if (n === 3 && isDirection(b) && isSlug(c)) return { kind: 'game', direction: b, game: c };
    return null;
  }
  const type = SEGMENT_TO_TYPE.get(a ?? '');
  if (type) {
    if (n === 1) return { kind: 'publications', type };
    if (n === 2 && isSlug(b)) return { kind: 'publication', type, slug: b };
    if (n === 3 && type === 'giveaway' && isSlug(b) && c === 'rules') return { kind: 'giveawayRules', slug: b };
    return null;
  }
  if (n === 1 && (LEGAL_KEYS as readonly string[]).includes(a!)) return { kind: 'legal', key: a as LegalKey };
  if (a === 'account') {
    if (n === 1) return { kind: 'account', section: '' };
    if (n === 2 && b !== '' && (ACCOUNT_SECTIONS as readonly string[]).includes(b!)) return { kind: 'account', section: b as AccountSection };
    if (n === 3 && b === 'bookings' && UUID_RE.test(c!)) return { kind: 'accountBooking', id: c! };
    return null;
  }
  // Город в корне: зарезервированное слово городом не бывает (карта п.2.8).
  if (!isSlug(a, 40) || RESERVED.has(a)) return null;
  if (n === 1) return { kind: 'city', city: a };
  if (!isSlug(b)) return null;
  if (n === 2) return { kind: 'branch', city: a, branch: b };
  if (n === 3 && c === 'rooms') return { kind: 'branchRooms', city: a, branch: b };
  if (n === 4 && c === 'rooms' && isSlug(d)) return { kind: 'room', city: a, branch: b, room: d };
  return null;
}

/** Нормальная форма адреса (K23 §1): нижний регистр, слеш в конце; файлы (/sitemap.xml, /robots.txt) и /404 – без слеша.
 *  Отличается от входа – middleware отдаёт 301 на результат, сохраняя параметры. */
export function normalizePath(pathname: string): string {
  const lower = pathname.toLowerCase().replace(/\/{2,}/g, '/');
  const bare = lower.replace(/\/+$/, '');
  if (STATIC_BY_PATH.has(bare) && !bare.endsWith('/') && /\.(xml|txt)$|^\/404$/.test(bare)) return bare;
  return `${bare}/`;
}

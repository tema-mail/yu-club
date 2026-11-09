// Мок публичного API контента (K5 №207–215, S4-110…S4-122) – точно по apps/api/src/modules/content/routes.public.ts:
// пути, параметры (type/direction – перечисления, city/branch – UUID, иначе 400 VALIDATION_FAILED), ответы DTO
// (publications.ts, games.ts, pages.ts, blocks.ts), 404 NOT_FOUND / PAGE_KEY_UNKNOWN, Cache-Control: public, max-age=60 и ETag с 304.
// Охват (K22 §4): без выбора – всё; город – сеть + город + его филиалы; филиал – сеть + его город + он сам.
// Срок показа – от «сейчас» процесса (зафиксирован tests/support/e2e.ts). Черновики здесь не лежат вовсе: API их не отдаёт.
// Только для e2e: POST /__mock/content { advertisingConsent?: boolean, home?: 'full' | 'empty' } – переключатели состояния.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';

type Fail = (reply: FastifyReply, status: number, code: string, message: string) => unknown;
export interface ContentDeps { branchCity: (branchId: string) => string | undefined; cityBranches: (cityId: string) => string[]; fail: Fail }

const DAY = 86_400_000;
const iso = (deltaDays: number) => new Date(Date.now() + deltaDays * DAY).toISOString();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NSK = '0b0c0000-0000-4000-8000-000000000001';
const KRASNY = '0b0b0000-0000-4000-8000-000000000011';
const LENINA = '0b0b0000-0000-4000-8000-000000000021';
const M = (n: number) => `aaaaaaaa-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
const seo = { title: null, description: null, h1: null, ogImage: null };

function media(id: string, alt: string, kind: 'img' | 'pdf' = 'img') {
  if (kind === 'pdf') return { removed: false, alt, width: null, height: null, url: `/media/${id.slice(0, 2)}/rules-${id.slice(-2)}.pdf`, variants: [] };
  const u = (w: number, f: string) => `/media/${id.slice(0, 2)}/${id.slice(-2)}/img-${w}.${f}`;
  return { removed: false, alt, width: 1600, height: 900, url: u(1600, 'webp'), variants: [{ w: 480, h: 270, format: 'webp', url: u(480, 'webp') }, { w: 1600, h: 900, format: 'webp', url: u(1600, 'webp') }, { w: 1600, h: 900, format: 'jpeg', url: u(1600, 'jpg') }] };
}

type Scope = { type: 'network' } | { type: 'city'; ids: string[] } | { type: 'branch'; ids: string[] };
const NAMES: Record<string, string> = { [NSK]: 'Новосибирск', [KRASNY]: 'Ю-Клуб на Красном', [LENINA]: 'Ю-Клуб на Ленина' };

interface Pub {
  id: string; type: 'news' | 'promotion' | 'giveaway' | 'tournament'; slug: string; title: string; lead: string; body: string; scope: Scope;
  from: number; to: number | null; indexable?: boolean; eventDate?: number; conditions?: string; restrictions?: string; ctaLabel?: string; ctaUrl?: string;
  resultsDate?: number; prize?: string; rulesBody?: string; rulesPdf?: boolean; version: string;
}

const PUBS: Pub[] = [
  { id: 'cccccccc-0000-4000-8000-000000000001', type: 'news', slug: 'live-news', title: 'Живая новость', lead: 'В сети обновили компьютеры в залах ПК.', body: 'Видеокарты заменили во **всех** клубах сети.\n\n[Записаться](/schedule/)', scope: { type: 'network' }, from: -3, to: null, version: 'v1' },
  { id: 'cccccccc-0000-4000-8000-000000000002', type: 'news', slug: 'tomsk-opening', title: 'Новый зал в Томске', lead: 'На Ленина открыли второй зал PS5.', body: 'Зал работает с 10:00.', scope: { type: 'branch', ids: [LENINA] }, from: -1, to: null, version: 'v1' },
  { id: 'cccccccc-0000-4000-8000-000000000003', type: 'news', slug: 'nsk-hours', title: 'Часы в Новосибирске', lead: 'Клубы Новосибирска работают до полуночи.', body: 'По пятницам и субботам.', scope: { type: 'city', ids: [NSK] }, from: -2, to: null, indexable: false, version: 'v1' },
  { id: 'cccccccc-0000-4000-8000-000000000004', type: 'news', slug: 'future-news', title: 'Будущая новость', lead: 'Ещё не наступила.', body: 'x', scope: { type: 'network' }, from: 2, to: null, version: 'v1' },
  { id: 'cccccccc-0000-4000-8000-000000000011', type: 'promotion', slug: 'happy-hours', title: 'Счастливые часы', lead: 'Будни с 10 до 14 – скидка на зал ПК.', body: 'Скидка считается в клубе при оплате.', scope: { type: 'network' }, from: -5, to: 20, conditions: 'Только по будням с 10:00 до 14:00.', restrictions: 'Не суммируется с другими акциями.', ctaLabel: 'Записаться на будни', ctaUrl: '/schedule/', version: 'v1' },
  { id: 'cccccccc-0000-4000-8000-000000000012', type: 'promotion', slug: 'summer-promo', title: 'Летняя акция', lead: 'Акция прошла летом.', body: 'Спасибо, что были с нами.', scope: { type: 'network' }, from: -120, to: -30, conditions: 'Летом.', version: 'v1' },
  { id: 'cccccccc-0000-4000-8000-000000000021', type: 'giveaway', slug: 'autumn-giveaway', title: 'Осенний розыгрыш', lead: 'Разыгрываем три часа в комнате PS5.', body: 'Подпишитесь на клуб и запишитесь на любой сеанс до конца ноября.', scope: { type: 'city', ids: [NSK] }, from: -4, to: 25, eventDate: 20, resultsDate: 26, prize: 'Три часа в комнате PS5 на компанию', rulesBody: 'Организатор – Ю-Клуб. Участие бесплатное.', version: 'v1' },
  { id: 'cccccccc-0000-4000-8000-000000000022', type: 'giveaway', slug: 'pdf-giveaway', title: 'Розыгрыш с правилами в PDF', lead: 'Правила – файлом.', body: 'Условия в правилах.', scope: { type: 'network' }, from: -2, to: 10, resultsDate: 12, prize: 'Сертификат на 1000 ₽', rulesPdf: true, version: 'v1' },
];

interface Game { id: string; direction: 'pc' | 'vr' | 'playstation'; slug: string | null; title: string; short: string; full: string | null; genres: string[]; ageRating: string | null; platforms: string[]; at: Record<string, string | null> }
const GAMES: Game[] = [
  { id: 'dddddddd-0000-4000-8000-000000000001', direction: 'pc', slug: 'counter-strike-2', title: 'Counter-Strike 2', short: 'Командный шутер пять на пять.', full: 'Классический **командный** шутер.', genres: ['Шутер'], ageRating: '16+', platforms: [], at: { [KRASNY]: null, [LENINA]: 'Турнирные ПК' } },
  { id: 'dddddddd-0000-4000-8000-000000000002', direction: 'pc', slug: 'dota-2', title: 'Dota 2', short: 'Командная стратегия.', full: null, genres: ['Стратегия'], ageRating: '12+', platforms: [], at: { [KRASNY]: null } },
  { id: 'dddddddd-0000-4000-8000-000000000003', direction: 'vr', slug: 'alyx', title: 'Half-Life: Alyx', short: 'Сюжетный шутер в VR.', full: 'Полноценная VR-игра.', genres: ['Шутер', 'Приключения'], ageRating: '16+', platforms: [], at: { [KRASNY]: null } },
  { id: 'dddddddd-0000-4000-8000-000000000004', direction: 'vr', slug: 'beat-saber', title: 'Beat Saber', short: 'Ритм-игра со световыми мечами.', full: null, genres: ['Ритм'], ageRating: '6+', platforms: [], at: { [LENINA]: null } },
  { id: 'dddddddd-0000-4000-8000-000000000005', direction: 'playstation', slug: 'gran-turismo-7', title: 'Gran Turismo 7', short: 'Гоночный симулятор.', full: 'Гонки на PlayStation 5 с рулём.', genres: ['Гонки'], ageRating: '6+', platforms: ['PS5'], at: { [LENINA]: 'С рулём' } },
];

const PAGES: Record<string, { title: string; body: string; documentVersion: string | null; updatedAt: string; city?: string } | undefined> = {
  about: { title: 'О клубе', body: 'Ю-Клуб – сеть компьютерных клубов: **ПК, VR и PlayStation**.', documentVersion: null, updatedAt: '2026-11-03T10:00:00.000Z' },
  rules: { title: 'Правила клуба', body: 'Приходите за 10 минут до начала сеанса.\n\nОтмена – не позже чем за 2 часа.', documentVersion: null, updatedAt: '2026-11-01T10:00:00.000Z' },
  contacts_intro: { title: 'Контакты', body: 'Звоните в клуб или пишите администратору.', documentVersion: null, updatedAt: '2026-11-02T10:00:00.000Z' },
  'privacy-policy': { title: 'Политика обработки персональных данных', body: 'Оператор – ООО «Ю-Клуб».', documentVersion: 'privacy-policy-2026-11-01', updatedAt: '2026-11-01T10:00:00.000Z' },
  'advertising-consent': { title: 'Согласие на получение рекламных сообщений', body: 'Я согласен получать рекламу.', documentVersion: 'advertising-consent-2026-11-01', updatedAt: '2026-11-01T10:00:00.000Z' },
};
const PAGE_KEYS = ['about', 'contacts_intro', 'rules', 'privacy-policy', 'personal-data-consent', 'cookie-policy', 'advertising-consent'];

const ROOM_PAGES: Record<string, unknown> = {
  // Комната VR+PS4 «Красного» (mock-resources.ts: roomId 0b0f0011-…-32)
  '0b0f0011-0000-4000-8000-000000000032': { description: 'Комната на 10 гостей: **два VR-шлема** и PS4.', gallery: [M(31)], features: ['Два шлема Quest 3', 'Диван на 6 мест'], rentFormatsText: 'Можно взять одно VR-место или всю комнату.' },
};
const BRANCH_PAGES: Record<string, unknown> = {
  [LENINA]: { description: 'Клуб в центре Томска, **второй этаж**.', gallery: [M(41), M(42)], features: ['Парковка у входа', 'Кофе-автомат'], howToGet: 'Вход со двора, домофон 12.', postal: { street: 'проспект Ленина, 80', locality: 'Томск', region: 'Томская область', postalCode: '634050' }, geo: { lat: 56.4847, lng: 84.9482 } },
};

const state = { advertisingConsent: true, home: 'full' as 'full' | 'empty' };
/** Живая версия согласия на рекламу (K5 №215) – её же пишет вход и настройки в журнал согласий (mock-clients.ts), как legalVersions в API. */
export const liveAdvertisingVersion = () => (state.advertisingConsent ? PAGES['advertising-consent']!.documentVersion : null);

function inScope(s: Scope, deps: ContentDeps, q: { city?: string; branch?: string }): boolean {
  if (!q.city && !q.branch) return true;
  if (s.type === 'network') return true;
  const city = q.branch ? deps.branchCity(q.branch) : q.city;
  const branches = q.branch ? [q.branch] : deps.cityBranches(q.city!);
  return s.type === 'city' ? s.ids.includes(city ?? '') : s.ids.some((b) => branches.includes(b));
}

/** Действует сейчас: дни – от «сейчас» процесса. */
const live = (p: Pub) => p.from <= 0 && (p.to === null || p.to > 0);
function card(p: Pub) {
  return {
    id: p.id, type: p.type, slug: p.slug, title: p.title, lead: p.lead, cover: media(M(Number(p.id.slice(-2))), `Обложка: ${p.title}`),
    publishFrom: iso(p.from), publishTo: p.to === null ? null : iso(p.to), eventDate: p.eventDate === undefined ? null : iso(p.eventDate),
    onlyIn: p.scope.type === 'network' ? [] : p.scope.ids.map((id) => ({ type: p.scope.type as 'city' | 'branch', id, name: NAMES[id] ?? '' })),
  };
}
function gameCard(g: Game, branch?: string) {
  const cover = media(M(50 + Number(g.id.slice(-1))), `Обложка: ${g.title}`);
  return { id: g.id, direction: g.direction, slug: g.slug, hasPage: g.full !== null, title: g.title, short: g.short, cover, genres: g.genres, ageRating: g.ageRating, platforms: g.platforms, note: branch ? (g.at[branch] ?? null) : null };
}

function cached(request: FastifyRequest, reply: FastifyReply, versions: string[], body: unknown) {
  const etag = `"${createHash('sha256').update([...versions].sort().join(',')).digest('base64url').slice(0, 27)}"`;
  void reply.header('cache-control', 'public, max-age=60').header('etag', etag);
  if (request.headers['if-none-match'] === etag) return reply.code(304).send();
  return reply.send(body);
}

export function registerContent(app: FastifyInstance, P: string, deps: ContentDeps) {
  const bad = (reply: FastifyReply) => deps.fail(reply, 400, 'VALIDATION_FAILED', 'Неверные параметры запроса');
  const notFound = (reply: FastifyReply) => deps.fail(reply, 404, 'NOT_FOUND', 'Не найдено');
  const badId = (v: unknown) => v !== undefined && (typeof v !== 'string' || !UUID.test(v));

  app.post('/__mock/content', async (req) => {
    const b = (req.body ?? {}) as Partial<typeof state>;
    if (typeof b.advertisingConsent === 'boolean') state.advertisingConsent = b.advertisingConsent;
    if (b.home === 'full' || b.home === 'empty') state.home = b.home;
    return state;
  });

  const list = (type: Pub['type'] | undefined, q: { city?: string; branch?: string }) => {
    return PUBS.filter((p) => (!type || p.type === type) && live(p) && inScope(p.scope, deps, q)).sort((a, b) => b.from - a.from || b.id.localeCompare(a.id));
  };

  // №207
  app.get(`${P}/content/home`, async (req, reply) => {
    const { city } = req.query as { city?: string };
    if (badId(city)) return bad(reply);
    if (state.home === 'empty') return cached(req, reply, [], { blocks: [], promos: [], news: [], games: [] });
    const blocks = [
      { id: 'eeeeeeee-0000-4000-8000-000000000001', blockType: 'hero', cityOverride: false, payload: { title: 'Играй с друзьями в Ю-Клуб', subtitle: 'ПК, VR и PlayStation 5 рядом с домом.', mediaId: M(61), ctaLabel: 'Записаться онлайн', ctaUrl: '/schedule/' }, media: { [M(61)]: media(M(61), 'Зал клуба') } },
      { id: 'eeeeeeee-0000-4000-8000-000000000002', blockType: 'about', cityOverride: false, payload: { title: 'О клубе', body: 'Мы открыты **каждый день**.' }, media: {} },
      { id: 'eeeeeeee-0000-4000-8000-000000000003', blockType: 'directions', cityOverride: false, payload: { items: [{ direction: 'pc', title: 'Компьютеры', text: 'Мощные ПК.' }, { direction: 'vr', title: 'VR', text: 'Шлемы Quest.' }, { direction: 'playstation', title: 'PlayStation', text: 'PS5 и PS4.' }] }, media: {} },
      { id: 'eeeeeeee-0000-4000-8000-000000000004', blockType: 'promo_strip', cityOverride: false, payload: { text: 'Счастливые часы по будням', url: '/promotions/happy-hours/' }, media: {} },
    ];
    const games = GAMES.map((g) => gameCard(g)).slice(0, 20);
    return cached(req, reply, ['home'], { blocks, promos: list('promotion', { city }).slice(0, 6).map(card), news: list('news', { city }).slice(0, 3).map(card), games });
  });

  // №208
  app.get(`${P}/content/publications`, async (req, reply) => {
    const q = req.query as { type?: string; city?: string; branch?: string; limit?: string };
    if (q.type !== undefined && !['news', 'promotion', 'giveaway', 'tournament'].includes(q.type)) return bad(reply);
    if (badId(q.city) || badId(q.branch)) return bad(reply);
    const limit = q.limit === undefined ? 20 : Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) return bad(reply);
    const items = list(q.type as Pub['type'] | undefined, q.branch ? { branch: q.branch } : q.city ? { city: q.city } : {});
    return cached(req, reply, items.map((p) => p.version), { items: items.slice(0, limit).map(card), nextCursor: null });
  });

  // №209: завершённая – state 'ended' (настройка content.ended_promotion_mode по умолчанию – показывать с плашкой)
  app.get(`${P}/content/publications/:type/:slug`, async (req, reply) => {
    const { type, slug } = req.params as { type: string; slug: string };
    const { branch } = req.query as { branch?: string };
    if (!['news', 'promotion', 'giveaway', 'tournament'].includes(type) || slug.length > 200 || badId(branch)) return bad(reply);
    const p = PUBS.find((x) => x.type === type && x.slug === slug && x.from <= 0);
    if (!p) return notFound(reply);
    const ended = p.to !== null && p.to <= 0;
    const rules = p.rulesPdf ? media(M(90), 'Правила розыгрыша', 'pdf') : null;
    const appliesHere = branch ? p.scope.type === 'network' || (p.scope.type === 'branch' ? p.scope.ids.includes(branch) : p.scope.ids.includes(deps.branchCity(branch) ?? '')) : null;
    return cached(req, reply, [p.version], {
      ...card(p), body: p.body, conditions: p.conditions ?? null, restrictions: p.restrictions ?? null, ctaLabel: p.ctaLabel ?? null, ctaUrl: p.ctaUrl ?? null,
      resultsDate: p.resultsDate === undefined ? null : iso(p.resultsDate), prize: p.prize ?? null, rulesBody: p.rulesBody ?? null, rules, rulesUrl: rules?.url ?? null,
      media: { [M(Number(p.id.slice(-2)))]: card(p).cover, ...(rules ? { [M(90)]: rules } : {}) }, state: ended ? 'ended' : 'active', indexable: (p.indexable ?? true) && !ended, seo, appliesHere,
    });
  });

  // №210: при branch – только доступные там; без – сетевой каталог
  app.get(`${P}/content/games`, async (req, reply) => {
    const q = req.query as { direction?: string; branch?: string };
    if ((q.direction !== undefined && !['pc', 'vr', 'playstation'].includes(q.direction)) || badId(q.branch)) return bad(reply);
    const items = GAMES.filter((g) => (!q.direction || g.direction === q.direction) && (!q.branch || q.branch in g.at)).map((g) => gameCard(g, q.branch));
    return cached(req, reply, items.map((g) => g.id), { items, networkCatalog: !q.branch });
  });

  // №211: без full – 404
  app.get(`${P}/content/games/:direction/:slug`, async (req, reply) => {
    const { direction, slug } = req.params as { direction: string; slug: string };
    if (!['pc', 'vr', 'playstation'].includes(direction) || slug.length > 200) return bad(reply);
    const g = GAMES.find((x) => x.direction === direction && x.slug === slug && x.full !== null);
    if (!g) return notFound(reply);
    const c = gameCard(g);
    const availableIn = Object.keys(g.at).map((id) => ({ id, name: NAMES[id] ?? '', slug: id === KRASNY ? 'krasny-prospekt' : 'lenina', citySlug: id === KRASNY ? 'novosibirsk' : 'tomsk', note: g.at[id] ?? null }));
    return cached(req, reply, [g.id], { ...c, full: g.full, media: c.cover ? { [M(50 + Number(g.id.slice(-1)))]: c.cover } : {}, availableIn, seo });
  });

  // №212: ключ вне списка – PAGE_KEY_UNKNOWN 404; не опубликована – 404
  app.get(`${P}/content/pages/:key`, async (req, reply) => {
    const { key } = req.params as { key: string };
    const { city } = req.query as { city?: string };
    if (badId(city)) return bad(reply);
    if (!PAGE_KEYS.includes(key)) return deps.fail(reply, 404, 'PAGE_KEY_UNKNOWN', 'Такой страницы нет');
    const p = key === 'advertising-consent' && !state.advertisingConsent ? undefined : PAGES[key];
    if (!p) return notFound(reply);
    return cached(req, reply, [key], { key, title: p.title, body: p.body, documentVersion: p.documentVersion, updatedAt: p.updatedAt, media: {}, seo });
  });

  // №213, №214
  for (const [path, store] of [['rooms/:id', ROOM_PAGES], ['branches/:id', BRANCH_PAGES]] as const) {
    app.get(`${P}/content/${path}`, async (req, reply) => {
      const { id } = req.params as { id: string };
      const page = store[id] as { gallery: string[] } | undefined;
      if (!page) return notFound(reply);
      const mediaMap = Object.fromEntries(page.gallery.map((m) => [m, media(m, 'Фото клуба')]));
      return cached(req, reply, [id], { ...page, gallery: page.gallery.map((m) => mediaMap[m]), media: mediaMap, seo });
    });
  }

  // №215
  app.get(`${P}/content/legal-versions`, async (req, reply) =>
    cached(req, reply, [String(state.advertisingConsent)], {
      privacyPolicy: PAGES['privacy-policy']!.documentVersion,
      personalDataConsent: null,
      cookiePolicy: null,
      advertisingConsent: state.advertisingConsent ? PAGES['advertising-consent']!.documentVersion : null,
    }),
  );
}

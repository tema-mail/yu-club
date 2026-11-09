// На каждый запрос: сеть (города и филиалы из API, K5 №1–2), выбор посетителя из куки yu_branch, режим индексации.
// API недоступен – network = null: страницы, которым нужны данные, отвечают 503, остальные открываются.
// Стенд (APP_ENV ≠ prod): X-Robots-Tag noindex на всём, включая robots.txt, sitemap.xml и 404.
// Клиент (K9): /account/ целиком за входом (без сессии – 302 на /login/?next=), /login/ с живой сессией – сразу дальше;
// обе всегда noindex и no-store. Прокси /api/* идёт мимо: ему не нужны ни сеть, ни сессия.
// Адреса (K23 §1, §5, S4-53): ненормальный адрес (регистр, нет слеша) и старый адрес из истории – 301 одним переходом, параметры сохраняются;
// сначала страница строится по текущим данным, 404 – спрашиваем GET /redirects/resolve (K5 №216); ответа API нет – 503, а не ложный 404 для поисковика.
import { defineMiddleware } from 'astro:middleware';
import { LEGAL_KEYS, normalizePath, parsePath } from '../../../packages/contracts/src/paths.ts';
import { API_PREFIX, BRANCH_COOKIE, apiBase, findBranch, isIndexable, loadNetwork, parseBranchCookie, siteUrl, type CityWithBranches } from './lib/api.ts';
import { CLIENT_COOKIE, safeNext, serverMe, type Me } from './lib/client.ts';

declare global {
  // Astro описывает locals только через глобальное пространство App.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace App {
    interface Locals {
      network: CityWithBranches[] | null;
      choice: { city: string; branch: string } | null;
      indexable: boolean;
      origin: string;
      /** Есть кука сессии клиента – шапка показывает «Кабинет» (без запроса /me на каждой странице). */
      hasSession: boolean;
      /** Профиль – только на /account/ (проверен через GET /me). */
      client: Me | null;
    }
  }
}

function withHeaders(res: Response, headers: Record<string, string>): Response {
  try {
    for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
    return res;
  } catch {
    // У Response.redirect заголовки неизменяемые – копируем ответ.
    const copy = new Response(res.body, res);
    for (const [k, v] of Object.entries(headers)) copy.headers.set(k, v);
    return copy;
  }
}

const unavailable = () =>
  new Response(
    '<!doctype html><html lang="ru"><meta charset="utf-8"><title>Кабинет недоступен</title>' +
      '<p>Сервис не отвечает. Обновите страницу через минуту.</p></html>',
    { status: 503, headers: { 'content-type': 'text/html; charset=utf-8', 'retry-after': '30' } },
  );

/** Адреса вне реестра страниц: токены чувствительны к регистру, файлы отдаёт сервер; /404/ – внутренняя подмена страниц.
 *  Процент-кодирование (кириллица, пробел): слаг такого не содержит, а URL снова поднимает регистр %XX – нижний регистр дал бы вечную петлю 301. */
const OUTSIDE_REGISTRY = /^\/(api|_astro|media|preview|unsubscribe)(\/|$)|^\/404\/?$|\.[a-z0-9]+\/?$|%/i;

/** Страницы CMS (S4-120, K22 §5): канонический адрес /{key}/ рисует src/pages/info/[key].astro; прямой /info/{key}/ – 301 на канонический. */
const INFO_KEYS = new Set<string>(['about', 'rules', ...LEGAL_KEYS]);
const INFO_DIRECT = /^\/info\/([a-z-]+)\/$/;
const INFO_CANONICAL = /^\/([a-z-]+)\/$/;

/** K5 №216: текущий адрес старого пути или null. Сбой API – исключение. */
async function resolveLegacy(path: string): Promise<string | null> {
  const res = await fetch(`${apiBase()}${API_PREFIX}/redirects/resolve?path=${encodeURIComponent(path)}`, { headers: { accept: 'application/json' }, redirect: 'manual' });
  if (res.status === 404 || res.status === 400) return null;
  if (!res.ok) throw new Error(`redirects/resolve: ${res.status}`);
  return ((await res.json()) as { location: string }).location;
}

/** 301 с параметрами исходного запроса; доля адреса (#rooms) остаётся в конце. */
function moved(location: string, search: string): Response {
  const [path = '', hash] = location.split('#');
  return new Response(null, { status: 301, headers: { location: `${path}${search}${hash ? `#${hash}` : ''}` } });
}

export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname, search } = context.url;
  if (pathname.startsWith('/api/')) return next();

  const isRead = context.request.method === 'GET' || context.request.method === 'HEAD';
  const inRegistry = isRead && !OUTSIDE_REGISTRY.test(pathname);
  if (inRegistry && normalizePath(pathname) !== pathname) {
    const normal = normalizePath(pathname);
    // Один переход и для старого адреса в ненормальном виде: сразу на текущий, без промежуточного нормального.
    let target = normal;
    try {
      target = (await resolveLegacy(normal)) ?? normal;
    } catch (e) {
      console.error('site: redirects/resolve не ответил', e);
    }
    return isIndexable() ? moved(target, search) : withHeaders(moved(target, search), { 'x-robots-tag': 'noindex, nofollow' });
  }

  const direct = isRead ? INFO_DIRECT.exec(pathname) : null;
  if (direct && INFO_KEYS.has(direct[1]!)) {
    const to = moved(`/${direct[1]}/`, search);
    return isIndexable() ? to : withHeaders(to, { 'x-robots-tag': 'noindex, nofollow' });
  }
  const infoKey = inRegistry ? INFO_CANONICAL.exec(pathname)?.[1] : undefined;

  const isAccount = pathname === '/account/' || pathname.startsWith('/account/');
  const isLogin = pathname === '/login/';
  const cookie = context.request.headers.get('cookie') ?? '';
  const hasSession = context.cookies.has(CLIENT_COOKIE);
  context.locals.hasSession = hasSession;
  context.locals.client = null;
  const privateHeaders = { 'x-robots-tag': 'noindex, nofollow', 'cache-control': 'no-store' };

  if (isAccount || (isLogin && hasSession)) {
    const toLogin = () => withHeaders(context.redirect(`/login/?next=${encodeURIComponent(pathname + search)}`, 302), privateHeaders);
    if (isAccount && !hasSession) return toLogin();
    let me: Me | null;
    try {
      me = await serverMe(cookie);
    } catch (e) {
      console.error('site: GET /me не ответил', e);
      if (isAccount) return withHeaders(unavailable(), privateHeaders);
      me = null;
    }
    if (!me) {
      context.cookies.delete(CLIENT_COOKIE, { path: '/', secure: true, httpOnly: true, sameSite: 'lax' });
      context.locals.hasSession = false;
      if (isAccount) return toLogin();
    } else if (isLogin) {
      return withHeaders(context.redirect(safeNext(context.url.searchParams.get('next'), context.url.origin), 302), privateHeaders);
    }
    context.locals.client = me;
  }

  let network: CityWithBranches[] | null = null;
  try {
    network = await loadNetwork();
  } catch (e) {
    console.error('site: сеть из API не загрузилась', e);
  }
  const raw = parseBranchCookie(context.cookies.get(BRANCH_COOKIE)?.value);
  context.locals.network = network;
  context.locals.choice = raw && network && findBranch(network, raw.city, raw.branch) ? raw : null;
  context.locals.indexable = isIndexable();
  context.locals.origin = siteUrl(context.url.origin);

  // /{city}/{branch}/rooms/ страница переводит на раздел #rooms; у несуществующего филиала сразу 404 – иначе старый адрес дал бы два перехода.
  const match = inRegistry ? parsePath(pathname) : null;
  const noBranch = match?.kind === 'branchRooms' && network !== null && !findBranch(network, match.city, match.branch);
  const res = noBranch ? await context.rewrite('/404/') : infoKey && INFO_KEYS.has(infoKey) ? await next(`/info/${infoKey}/`) : await next();
  if (inRegistry && res.status === 404) {
    let location: string | null;
    try {
      location = await resolveLegacy(pathname);
    } catch (e) {
      console.error('site: redirects/resolve не ответил', e);
      return withHeaders(new Response('Сервис временно недоступен', { status: 503, headers: { 'retry-after': '60' } }), context.locals.indexable ? {} : { 'x-robots-tag': 'noindex, nofollow' });
    }
    if (location) return context.locals.indexable ? moved(location, search) : withHeaders(moved(location, search), { 'x-robots-tag': 'noindex, nofollow' });
  }
  if (isAccount || isLogin) return withHeaders(res, privateHeaders);
  return context.locals.indexable ? res : withHeaders(res, { 'x-robots-tag': 'noindex, nofollow' });
});

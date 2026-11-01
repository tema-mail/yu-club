// На каждый запрос: сеть (города и филиалы из API, K5 №1–2), выбор посетителя из куки yu_branch, режим индексации.
// API недоступен – network = null: страницы, которым нужны данные, отвечают 503, остальные открываются.
// Стенд (APP_ENV ≠ prod): X-Robots-Tag noindex на всём, включая robots.txt, sitemap.xml и 404.
// Клиент (K9): /account/ целиком за входом (без сессии – 302 на /login/?next=), /login/ с живой сессией – сразу дальше;
// обе всегда noindex и no-store. Прокси /api/* идёт мимо: ему не нужны ни сеть, ни сессия.
import { defineMiddleware } from 'astro:middleware';
import { BRANCH_COOKIE, findBranch, isIndexable, loadNetwork, parseBranchCookie, siteUrl, type CityWithBranches } from './lib/api.ts';
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

export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname, search } = context.url;
  if (pathname.startsWith('/api/')) return next();

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

  const res = await next();
  if (isAccount || isLogin) return withHeaders(res, privateHeaders);
  return context.locals.indexable ? res : withHeaders(res, { 'x-robots-tag': 'noindex, nofollow' });
});

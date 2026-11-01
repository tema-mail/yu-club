// На каждый запрос: сеть (города и филиалы из API, K5 №1–2), выбор посетителя из куки yu_branch, режим индексации.
// API недоступен – network = null: страницы, которым нужны данные, отвечают 503, остальные открываются.
// Стенд (APP_ENV ≠ prod): X-Robots-Tag noindex на всём, включая robots.txt, sitemap.xml и 404.
import { defineMiddleware } from 'astro:middleware';
import { BRANCH_COOKIE, findBranch, isIndexable, loadNetwork, parseBranchCookie, siteUrl, type CityWithBranches } from './lib/api.ts';

declare global {
  // Astro описывает locals только через глобальное пространство App.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace App {
    interface Locals {
      network: CityWithBranches[] | null;
      choice: { city: string; branch: string } | null;
      indexable: boolean;
      origin: string;
    }
  }
}

export const onRequest = defineMiddleware(async (context, next) => {
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
  if (context.locals.indexable) return res;
  try {
    res.headers.set('x-robots-tag', 'noindex, nofollow');
    return res;
  } catch {
    // У Response.redirect заголовки неизменяемые – копируем ответ.
    const copy = new Response(res.body, res);
    copy.headers.set('x-robots-tag', 'noindex, nofollow');
    return copy;
  }
});

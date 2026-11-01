// sitemap.xml (карта сайта 3.5): только страницы с «Индекс = да», без параметров. Филиалы и города – из API.
// Стенд – пустая карта: индексировать нечего. API недоступен – 503, а не урезанная карта.
import type { APIRoute } from 'astro';
import { branchPath } from '../lib/api.ts';

const xml = (urls: string[]) =>
  '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
  urls.map((u) => `  <url><loc>${u}</loc></url>\n`).join('') +
  '</urlset>\n';

export const GET: APIRoute = ({ locals }) => {
  const headers = { 'content-type': 'application/xml; charset=utf-8' };
  if (!locals.indexable) return new Response(xml([]), { headers });
  if (!locals.network) return new Response('Сервис временно недоступен', { status: 503, headers: { 'retry-after': '60' } });

  const paths = ['/', '/rules/'];
  for (const c of locals.network) {
    if (c.branches.length >= 2) paths.push(`/${c.slug}/`);
    for (const b of c.branches) paths.push(branchPath(c.slug, b.slug));
  }
  return new Response(xml(paths.map((p) => `${locals.origin}${p}`)), { headers });
};

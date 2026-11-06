// sitemap.xml (K23 §7, карта сайта 3.5): только страницы с «Индекс = да» из общего списка lib/sitemap.ts, без параметров, priority и changefreq;
// lastmod – дата живой версии контента, нет её – нет тега. Стенд – пустая карта: индексировать нечего. API недоступен – 503, а не урезанная карта.
import type { APIRoute } from 'astro';
import { loadSitemap, type SitemapItem } from '../lib/sitemap.ts';

const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const xml = (urls: Array<Pick<SitemapItem, 'lastmod'> & { loc: string }>) =>
  '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
  urls.map((u) => `  <url><loc>${escapeXml(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}</url>\n`).join('') +
  '</urlset>\n';

const unavailable = () => new Response('Сервис временно недоступен', { status: 503, headers: { 'retry-after': '60' } });

export const GET: APIRoute = async ({ locals }) => {
  const headers = { 'content-type': 'application/xml; charset=utf-8' };
  if (!locals.indexable) return new Response(xml([]), { headers });
  if (!locals.network) return unavailable();
  try {
    const sections = await loadSitemap(locals.network);
    return new Response(xml(sections.flatMap((s) => s.items).map((i) => ({ loc: `${locals.origin}${i.path}`, lastmod: i.lastmod }))), { headers });
  } catch (e) {
    console.error('site: sitemap не собрался', e);
    return unavailable();
  }
};

// sitemap.xml (карта сайта 3.5): только страницы с «Индекс = да», без параметров. Филиалы и города – из API.
// Стенд – пустая карта: индексировать нечего. API недоступен – 503, а не урезанная карта.
// Карточки комнат (S1-21) – из ресурсов каждого филиала (K5 №4: только опубликованные комнаты), запросы параллельно.
import type { APIRoute } from 'astro';
import { branchPath, branchRooms, roomPath, site } from '../lib/api.ts';

const xml = (urls: string[]) =>
  '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
  urls.map((u) => `  <url><loc>${u}</loc></url>\n`).join('') +
  '</urlset>\n';

export const GET: APIRoute = async ({ locals }) => {
  const headers = { 'content-type': 'application/xml; charset=utf-8' };
  if (!locals.indexable) return new Response(xml([]), { headers });
  if (!locals.network) return new Response('Сервис временно недоступен', { status: 503, headers: { 'retry-after': '60' } });

  const paths = ['/', '/rules/'];
  const pairs = locals.network.flatMap((c) => c.branches.map((b) => ({ c, b })));
  let rooms: string[][];
  try {
    rooms = await Promise.all(pairs.map(async ({ c, b }) => branchRooms(await site.resources(b.id)).map((r) => roomPath(c.slug, b.slug, r.slug))));
  } catch (e) {
    console.error('site: sitemap – ресурсы филиала не загрузились', e);
    return new Response('Сервис временно недоступен', { status: 503, headers: { 'retry-after': '60' } });
  }
  for (const c of locals.network) {
    if (c.branches.length >= 2) paths.push(`/${c.slug}/`);
    for (const b of c.branches) {
      paths.push(branchPath(c.slug, b.slug));
      paths.push(...(rooms[pairs.findIndex((p) => p.b.id === b.id)] ?? []));
    }
  }
  return new Response(xml(paths.map((p) => `${locals.origin}${p}`)), { headers });
};

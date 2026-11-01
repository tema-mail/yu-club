// robots.txt по режиму (карта сайта 3.5). Стенд – закрыт целиком; бой – закрыты ЛК, вход и API, ссылка на sitemap.
import type { APIRoute } from 'astro';

export const GET: APIRoute = ({ locals }) => {
  const body = locals.indexable
    ? ['User-agent: *', 'Disallow: /account/', 'Disallow: /login/', 'Disallow: /api/', '', `Sitemap: ${locals.origin}/sitemap.xml`, '']
    : ['User-agent: *', 'Disallow: /', ''];
  return new Response(body.join('\n'), { headers: { 'content-type': 'text/plain; charset=utf-8' } });
};

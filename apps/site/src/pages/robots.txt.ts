// robots.txt по режиму (K23 §7, карта сайта 3.5). Стенд – закрыт целиком; бой – закрыты ЛК, вход, API и предпросмотр, ссылка на sitemap.
// Clean-param – директива Яндекса: параметры-фильтры не плодят дублей адреса (canonical страницы уже без них).
import type { APIRoute } from 'astro';

export const GET: APIRoute = ({ locals }) => {
  const body = locals.indexable
    ? ['User-agent: *', 'Disallow: /account/', 'Disallow: /login/', 'Disallow: /api/', 'Disallow: /preview/', 'Clean-param: branch&zone&game&genre&occasion /', '', `Sitemap: ${locals.origin}/sitemap.xml`, '']
    : ['User-agent: *', 'Disallow: /', ''];
  return new Response(body.join('\n'), { headers: { 'content-type': 'text/plain; charset=utf-8' } });
};

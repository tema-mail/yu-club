// Прокси браузер → API: /api/public/v1/* этого сервера сайта → ${API_URL}/api/public/v1/*.
// Нужен, чтобы кука yu_client (K9: HttpOnly, Secure, SameSite=Lax) была своей для домена сайта.
// На бою Caddy может отдавать /api/* в api напрямую – тогда этот маршрут просто не вызывается.
// CSRF (K5 «Общее»): изменяющие запросы – только с заголовком X-Requested-With: yu-site и своим Origin.
import type { APIRoute } from 'astro';
import { API_PREFIX, apiBase } from '../../../../lib/api.ts';
import { clientIp, parseTrusted } from '../../../../lib/client-ip.ts';

const FORWARD_REQUEST = ['accept', 'content-type', 'cookie', 'idempotency-key', 'user-agent', 'x-requested-with'];
const FORWARD_RESPONSE = ['content-type', 'retry-after', 'idempotent-replay'];

const deny = (status: number, code: string, message: string) =>
  Response.json({ error: { code, message } }, { status, headers: { 'cache-control': 'no-store' } });

/** Origin запроса – этот же сайт: хост из заголовка Host (Caddy передаёт его как есть) или PUBLIC_SITE_URL.
 *  Без Origin (старые браузеры, тот же источник у части GET-подобных) – пропускаем: защищает X-Requested-With. */
function sameOrigin(origin: string | null, host: string | null): boolean {
  if (origin === null) return true;
  let o: URL;
  try {
    o = new URL(origin);
  } catch {
    return false;
  }
  const site = process.env.PUBLIC_SITE_URL;
  return (host !== null && o.host === host) || (site !== undefined && o.origin === new URL(site).origin);
}

export const ALL: APIRoute = async ({ request, params, clientAddress, url }) => {
  const path = params.path ?? '';
  if (path.includes('..') || path.includes('//')) return deny(400, 'VALIDATION_FAILED', 'Неверный адрес');

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    if (request.headers.get('x-requested-with') !== 'yu-site' || !sameOrigin(request.headers.get('origin'), request.headers.get('host'))) {
      return deny(403, 'FORBIDDEN', 'Запрос отклонён');
    }
  }

  const headers = new Headers();
  for (const name of FORWARD_REQUEST) {
    const v = request.headers.get(name);
    if (v) headers.set(name, v);
  }
  // Адрес посетителя для лимитов K9: за Caddy clientAddress у всех один – см. lib/client-ip.ts.
  headers.set('x-forwarded-for', clientIp(clientAddress, request.headers.get('x-forwarded-for'), parseTrusted(process.env.TRUSTED_PROXIES)));

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  let upstream: Response;
  try {
    upstream = await fetch(`${apiBase()}${API_PREFIX}/${path}${url.search}`, {
      method: request.method,
      headers,
      body: hasBody ? await request.arrayBuffer() : undefined,
      redirect: 'manual',
    });
  } catch {
    return deny(503, 'SERVICE_UNAVAILABLE', 'Сервис временно недоступен');
  }

  const out = new Headers({ 'cache-control': 'no-store' });
  for (const name of FORWARD_RESPONSE) {
    const v = upstream.headers.get(name);
    if (v) out.set(name, v);
  }
  for (const c of upstream.headers.getSetCookie()) out.append('set-cookie', c);
  const body = upstream.status === 204 ? null : await upstream.arrayBuffer();
  return new Response(body, { status: upstream.status, headers: out });
};

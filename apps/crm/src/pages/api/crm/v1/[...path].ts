// Прокси браузер → API: /api/crm/v1/* этого сервера CRM → ${API_URL}/api/crm/v1/*.
// Нужен, чтобы кука yu_staff (K12: HttpOnly, SameSite=Strict, домен CRM) была своей для браузера.
// На проде Caddy может отдавать /api/* в api напрямую – тогда этот маршрут просто не вызывается.
import type { APIRoute } from 'astro';
import { API_PREFIX, apiBase } from '../../../../lib/api.ts';

const FORWARD_REQUEST = ['accept', 'content-type', 'cookie', 'idempotency-key', 'user-agent'];
const FORWARD_RESPONSE = ['content-type', 'retry-after', 'cache-control'];

export const ALL: APIRoute = async ({ request, params, clientAddress }) => {
  const path = params.path ?? '';
  if (path.includes('..')) return new Response(null, { status: 400 });

  const headers = new Headers();
  for (const name of FORWARD_REQUEST) {
    const v = request.headers.get(name);
    if (v) headers.set(name, v);
  }
  headers.set('x-forwarded-for', clientAddress);

  const url = new URL(request.url);
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
    return Response.json(
      { error: { code: 'SERVICE_UNAVAILABLE', message: 'Сервер CRM не отвечает. Повторите через минуту.' } },
      { status: 503 },
    );
  }

  const out = new Headers();
  for (const name of FORWARD_RESPONSE) {
    const v = upstream.headers.get(name);
    if (v) out.set(name, v);
  }
  for (const c of upstream.headers.getSetCookie()) out.append('set-cookie', c);
  const body = upstream.status === 204 ? null : await upstream.arrayBuffer();
  return new Response(body, { status: upstream.status, headers: out });
};

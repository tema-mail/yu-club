// Охрана CRM: всё, кроме /login и прокси API, – только после входа (K12).
// На каждый запрос: GET /me + список филиалов зоны (K11 №1, №18) → locals; затем контекст сеть/город/филиал.
// Права меню здесь лишь для показа; защищает сервер API (K1: чужое → 404).
import { defineMiddleware } from 'astro:middleware';
import { ApiError, crm, safeNext, serverCall, type Branch, type Me, type Staff } from './lib/api.ts';

export const CTX_COOKIE = 'yu_ctx';

export type CrmContext =
  | { kind: 'network' }
  | { kind: 'city'; cityId: string; cityName: string }
  | { kind: 'branch'; branch: Branch }
  | { kind: 'none' };

declare global {
  // Astro описывает locals только через глобальное пространство App.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace App {
    interface Locals {
      me: Me;
      branches: Branch[];
      ctx: CrmContext;
      cookie: string;
    }
  }
}

/** Значение куки yu_ctx → контекст в пределах доступа. Чужое или устаревшее – молча на значение по умолчанию. */
export function resolveContext(raw: string | undefined, me: Me, branches: Branch[]): CrmContext {
  const city = (id: string): CrmContext | null => {
    const b = branches.find((x) => x.cityId === id);
    return b && (me.access.network || me.access.cityIds.includes(id)) ? { kind: 'city', cityId: id, cityName: b.cityName } : null;
  };
  if (raw === 'network' && me.access.network) return { kind: 'network' };
  if (raw?.startsWith('city:')) {
    const c = city(raw.slice(5));
    if (c) return c;
  }
  if (raw?.startsWith('branch:')) {
    const b = branches.find((x) => x.id === raw.slice(7));
    if (b) return { kind: 'branch', branch: b };
  }
  if (me.access.network) return { kind: 'network' };
  for (const id of me.access.cityIds) {
    const c = city(id);
    if (c) return c;
  }
  const first = branches[0];
  return first ? { kind: 'branch', branch: first } : { kind: 'none' };
}

function unavailable(): Response {
  return new Response(
    '<!doctype html><html lang="ru"><meta charset="utf-8"><title>CRM недоступна</title>' +
      '<p>Сервер CRM не отвечает. Обновите страницу через минуту.</p></html>',
    { status: 503, headers: { 'content-type': 'text/html; charset=utf-8', 'retry-after': '30' } },
  );
}

const PASSWORD_PAGE = '/account/password';

export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname, search } = context.url;
  if (pathname.startsWith('/api/')) return next();

  const cookie = context.request.headers.get('cookie') ?? '';
  const hasSession = context.cookies.has('yu_staff');
  const isLogin = pathname === '/login' || pathname === '/login/';

  if (!hasSession) {
    return isLogin ? next() : context.redirect(`/login?next=${encodeURIComponent(pathname + search)}`);
  }

  let me: Me;
  let branches: Branch[];
  try {
    [me, branches] = await Promise.all([crm.me(cookie), crm.branches(cookie)]);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      context.cookies.delete('yu_staff', { path: '/' });
      return isLogin ? next() : context.redirect(`/login?next=${encodeURIComponent(pathname + search)}`);
    }
    // K12: после сброса/засева пароля сервер пускает только в session/password/logout – ведём на смену пароля.
    if (e instanceof ApiError && e.code === 'PASSWORD_CHANGE_REQUIRED') {
      let staff: Staff & { mustChangePassword?: boolean };
      try {
        ({ staff } = await serverCall<{ staff: Staff & { mustChangePassword?: boolean } }>(cookie, '/auth/session'));
      } catch {
        return unavailable();
      }
      if (!staff.mustChangePassword) return context.redirect(pathname + search); // флаг уже снят – повторить
      if (pathname.replace(/\/+$/, '') !== PASSWORD_PAGE) return context.redirect(PASSWORD_PAGE);
      context.locals.me = { staff, access: { network: false, cityIds: [], branchIds: [] }, actions: [] };
      context.locals.branches = [];
      context.locals.cookie = cookie;
      context.locals.ctx = { kind: 'none' };
      const res = await next();
      res.headers.set('cache-control', 'no-store');
      return res;
    }
    return unavailable();
  }

  if (isLogin) return context.redirect(safeNext(context.url.searchParams.get('next'), context.url.origin));

  context.locals.me = me;
  context.locals.branches = branches;
  context.locals.cookie = cookie;
  context.locals.ctx = resolveContext(context.cookies.get(CTX_COOKIE)?.value, me, branches);
  const res = await next();
  res.headers.set('cache-control', 'no-store');
  return res;
});

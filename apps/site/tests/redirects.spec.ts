// S4-53: нормализация и 301 по истории (K23 §1, §5) на собранном сайте. Каждый старый адрес – один переход и без петель: цель сама не редиректит;
// параметры сохраняются; несуществующее – 404 с кодом 404; API молчит – 503; файлы, токены и не-GET не трогаются.
import { expect, test, type APIRequestContext } from '@playwright/test';
import { PREVIEW_SECRET, PROD_PORT } from '../playwright.config.ts';

const PROD = `http://127.0.0.1:${PROD_PORT}`;
const hop = (request: APIRequestContext, path: string) => request.get(path, { maxRedirects: 0 });

async function oneHop(request: APIRequestContext, path: string, location: string) {
  const res = await hop(request, path);
  expect(res.status(), path).toBe(301);
  expect(res.headers().location, path).toBe(location);
}

test('нормализация: регистр и слеш – 301 на нормальный адрес, параметры сохраняются', async ({ request }) => {
  await oneHop(request, '/News/', '/news/');
  await oneHop(request, '/news', '/news/');
  // Без слеша первым отвечает сам Astro (trailingSlash: 'always', до middleware) кодом 301; регистр – вторым переходом, петли нет.
  await oneHop(request, '/News', '/News/');
  await oneHop(request, '/Tomsk/Lenina/', '/tomsk/lenina/');
  await oneHop(request, '/Tomsk/Lenina/?branch=1&utm_source=x', '/tomsk/lenina/?branch=1&utm_source=x');
  await oneHop(request, '/tomsk/lenina?zone=pc', '/tomsk/lenina/?zone=pc');
  const res = await hop(request, `${PROD}//other-host.test/`); // чужой хост в начале пути не становится адресом перехода
  expect(res.status()).toBe(404);
  expect(res.headers().location).toBeUndefined();
});

test('старые адреса города, филиала и комнаты: один переход, цель отвечает 200', async ({ request }) => {
  const cases: Array<[string, string]> = [
    ['/old-nsk/', '/novosibirsk/'],
    ['/old-nsk/krasny-prospekt/', '/novosibirsk/krasny-prospekt/'],
    ['/tomsk/old-lenina/', '/tomsk/lenina/'],
    ['/old-tomsk/', '/tomsk/lenina/'],
    ['/novosibirsk/closed-club/', '/novosibirsk/'],
    ['/tomsk/lenina/rooms/hidden-room/', '/tomsk/lenina/'],
  ];
  for (const [from, to] of cases) {
    await oneHop(request, from, to);
    const target = await hop(request, to);
    expect(target.status(), `${from} → ${to}`).toBe(200);
  }
  // Старый адрес с другим регистром – всё равно один переход, сразу на текущий.
  await oneHop(request, '/Old-Nsk/Krasny-Prospekt/', '/novosibirsk/krasny-prospekt/');
  await oneHop(request, '/OLD-TOMSK/', '/tomsk/lenina/');
  // Без слеша: первый 301 даёт Astro (до middleware), второй – на текущий адрес (D4-27, TEHDOLG-zapusk 1.16; канонические адреса и ссылки всегда со слешем).
  await oneHop(request, '/old-tomsk', '/old-tomsk/');
  // Параметры идут за переходом; промежуточный /rooms/ старого адреса – сразу на раздел.
  await oneHop(request, '/old-nsk/krasny-prospekt/?zone=pc', '/novosibirsk/krasny-prospekt/?zone=pc');
  await oneHop(request, '/old-nsk/krasny-prospekt/rooms/', '/novosibirsk/krasny-prospekt/#rooms');
  await oneHop(request, '/old-nsk/krasny-prospekt/rooms/?a=1', '/novosibirsk/krasny-prospekt/?a=1#rooms');
  // Архивный филиал города без страницы – на контакты.
  await oneHop(request, '/tomsk/closed-club/', '/contacts/');
});

test('бой: те же 301, без X-Robots-Tag', async ({ request }) => {
  const res = await hop(request, `${PROD}/old-nsk/krasny-prospekt/`);
  expect(res.status()).toBe(301);
  expect(res.headers().location).toBe('/novosibirsk/krasny-prospekt/');
  expect(res.headers()['x-robots-tag']).toBeUndefined();
  expect((await hop(request, `${PROD}/News`)).status()).toBe(301);
});

test('несуществующее – 404 с кодом 404 и закрыто от поиска, текущий адрес не редиректит сам на себя', async ({ request }) => {
  for (const path of ['/nope/', '/tomsk/nope/', '/tomsk/nope/rooms/', '/tomsk/lenina/rooms/nope/', '/a/b/c/d/', '/news/nope/', '/omsk/']) {
    const res = await hop(request, path);
    expect(res.status(), path).toBe(404);
    expect(await res.text(), path).toContain('content="noindex, nofollow"');
  }
  expect((await hop(request, `${PROD}/nope/`)).status()).toBe(404);
  expect((await hop(request, '/novosibirsk/krasny-prospekt/')).status()).toBe(200);
  // Существующий филиал: промежуточный адрес по-прежнему ведёт на раздел.
  await oneHop(request, '/tomsk/lenina/rooms/', '/tomsk/lenina/#rooms');
});

test('кириллица и процент-кодирование: 404 с кодом 404 без петли, в том числе с заглавными сегментами', async ({ request }) => {
  for (const path of ['/%D0%9F/', '/%d0%9f/', '/Tomsk/%D0%9F/', `/${encodeURIComponent('новосибирск')}/`, '/a%20b/']) {
    const res = await hop(request, path);
    expect(res.status(), path).toBe(404);
    expect(res.headers().location, path).toBeUndefined();
    expect((await hop(request, `${PROD}${path}`)).status(), path).toBe(404);
  }
});

test('стенд: переход нормализации тоже с X-Robots-Tag; бой – без него', async ({ request }) => {
  expect((await hop(request, '/News/')).headers()['x-robots-tag']).toBe('noindex, nofollow');
  expect((await hop(request, `${PROD}/News/`)).headers()['x-robots-tag']).toBeUndefined();
});

test('параметры сохраняются и на переходах самих страниц: город с одним филиалом, раздел комнат', async ({ request }) => {
  await oneHop(request, '/tomsk/?utm_source=x', '/tomsk/lenina/?utm_source=x');
  await oneHop(request, '/tomsk/lenina/rooms/?utm_source=x', '/tomsk/lenina/?utm_source=x#rooms');
});

test('API истории молчит: 503, а не ложный 404; ненормальный адрес всё равно нормализуется', async ({ request }) => {
  const res = await hop(request, '/api-down/');
  expect(res.status()).toBe(503);
  expect(res.headers()['retry-after']).toBe('60');
  await oneHop(request, '/API-DOWN/', '/api-down/');
});

test('не трогаем: файлы, токены с регистром, запись', async ({ request }) => {
  for (const path of ['/robots.txt', '/sitemap.xml', '/sw.js']) expect((await hop(request, path)).status(), path).toBe(200);
  const preview = await request.get('/preview/Draft-Token/', { maxRedirects: 0, headers: { 'x-preview-secret': PREVIEW_SECRET } });
  expect(preview.status()).toBe(404); // токен с заглавными не приводится к нижнему регистру
  const post = await request.post('/News/', { maxRedirects: 0 });
  expect(post.status()).not.toBe(301);
  expect((await hop(request, '/login/?next=/Account/')).status()).toBe(200);
});

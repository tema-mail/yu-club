// S4-56: три вывода совпадают по каждому адресу – meta robots, sitemap.xml, /sitemap/. Стенд – пустая карта. Черновик и архив в карту не попадают
// (их не отдаёт API), адрес без страницы тоже. Город с одним филиалом и готовящийся филиал – нет.
import { expect, test, type APIRequestContext } from '../../../tests/support/e2e.ts';
import { MOCK_PORT, PROD_PORT } from '../playwright.config.ts';

const PROD = `http://127.0.0.1:${PROD_PORT}`;
const ORIGIN = 'https://yu-club.test';
const xmlPaths = async (request: APIRequestContext) =>
  [...(await (await request.get(`${PROD}/sitemap.xml`)).text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!.replace(ORIGIN, ''));

test('три вывода совпадают: каждый адрес карты отвечает 200 с index, follow и есть в HTML-карте', async ({ request }) => {
  const xml = await xmlPaths(request);
  expect(xml.length).toBeGreaterThan(5);
  const html = await (await request.get(`${PROD}/sitemap/`)).text();
  const main = html.slice(html.indexOf('<main'), html.indexOf('</main>'));
  const links = [...main.matchAll(/data-testid="sitemap-list"[^>]*>(.*?)<\/ul>/gs)].flatMap((m) => [...m[1]!.matchAll(/href="([^"]+)"/g)].map((x) => x[1]!));
  expect([...links].sort()).toEqual([...xml].sort());
  for (const path of xml) {
    const res = await request.get(`${PROD}${path}`, { maxRedirects: 0 });
    expect(res.status(), path).toBe(200);
    expect(await res.text(), path).toContain('<meta name="robots" content="index, follow">');
  }
});

test('в карте только индексируемое: нет города с одним филиалом, готовящегося, закрытых страниц, адресов без страницы и параметров', async ({ request }) => {
  const xml = await xmlPaths(request);
  for (const p of ['/', '/rules/', '/schedule/', '/sitemap/', '/novosibirsk/', '/novosibirsk/krasny-prospekt/', '/novosibirsk/akademgorodok/', '/tomsk/lenina/', '/news/', '/news/live-news/']) expect(xml, p).toContain(p);
  for (const p of ['/tomsk/', '/novosibirsk/gorskiy/', '/omsk/', '/omsk/mira/', '/login/', '/account/', '/privacy-policy/', '/games/vr/alyx/']) expect(xml, p).not.toContain(p);
  expect(xml.filter((p) => p.includes('?'))).toEqual([]);
  expect(new Set(xml).size).toBe(xml.length);
});

test('lastmod только у страниц с живой версией; priority и changefreq нет', async ({ request }) => {
  const text = await (await request.get(`${PROD}/sitemap.xml`)).text();
  expect(text).toContain(`<loc>${ORIGIN}/rules/</loc><lastmod>2026-11-01T10:00:00.000Z</lastmod>`);
  expect(text).toContain(`<loc>${ORIGIN}/novosibirsk/krasny-prospekt/</loc><lastmod>2026-11-02T10:00:00.000Z</lastmod>`);
  expect(text).toContain(`<loc>${ORIGIN}/tomsk/lenina/</loc></url>`);
  expect(text).not.toMatch(/priority|changefreq/);
});

test('стенд: sitemap.xml пустая и закрыта, /sitemap/ – noindex', async ({ request }) => {
  const res = await request.get('/sitemap.xml');
  expect(await res.text()).not.toContain('<url>');
  expect(res.headers()['x-robots-tag']).toBe('noindex, nofollow');
  const page = await request.get('/sitemap/');
  expect(page.status()).toBe(200);
  expect(await page.text()).toContain('<meta name="robots" content="noindex, nofollow">');
});

test('API недоступен: sitemap.xml и /sitemap/ – 503, а не урезанная карта; стенд всё равно пустой', async ({ request }) => {
  const toggle = (down: boolean) => request.post(`http://127.0.0.1:${MOCK_PORT}/__mock/sitemap-down`, { data: { down } });
  await toggle(true);
  try {
    expect((await request.get(`${PROD}/sitemap.xml`)).status()).toBe(503);
    const page = await request.get(`${PROD}/sitemap/`);
    expect(page.status()).toBe(503);
    expect(await page.text()).toContain('Список страниц сейчас недоступен');
    expect((await request.get('/sitemap.xml')).status()).toBe(200);
  } finally {
    await toggle(false);
  }
  expect((await request.get(`${PROD}/sitemap.xml`)).status()).toBe(200);
});

test('HTML-карта: один H1, canonical без параметров, ссылки подписаны', async ({ request }) => {
  const html = await (await request.get(`${PROD}/sitemap/?branch=1`)).text();
  expect((html.match(/<h1[\s>]/g) ?? []).length).toBe(1);
  expect(html).toContain(`<link rel="canonical" href="${ORIGIN}/sitemap/">`);
  expect(html).toContain('Новосибирск: Ю-Клуб на Красном');
});

// S4-54: мета на собранных страницах (K23 §4): шаблоны title, description, H1 один на страницу; canonical и og:url без параметров; индекс по единому решению.
import { expect, test, type APIRequestContext } from '@playwright/test';
import { PROD_PORT } from '../playwright.config.ts';

const PROD = `http://127.0.0.1:${PROD_PORT}`;
const html = async (request: APIRequestContext, path: string) => (await request.get(`${PROD}${path}`)).text();
const h1Count = (s: string) => (s.match(/<h1[\s>]/g) ?? []).length;

test('филиал: шаблон title и description, один H1, canonical и og:url без параметров', async ({ request }) => {
  const s = await html(request, '/tomsk/lenina/?branch=1&zone=pc&utm_source=x');
  expect(s).toContain('<title>Ю-Клуб на Ленина, Томск – проспект Ленина, 80</title>');
  expect(s).toMatch(/<meta name="description" content="[^"]*Сегодня: 10:00–22:00\. Онлайн-запись на сайте\."/);
  expect(s).toContain('<link rel="canonical" href="https://yu-club.test/tomsk/lenina/">');
  expect(s).toContain('<meta property="og:url" content="https://yu-club.test/tomsk/lenina/">');
  expect(s).toContain('<meta property="og:type" content="website">');
  expect(s).toContain('<meta name="robots" content="index, follow">');
  expect(h1Count(s)).toBe(1);
  expect(s).not.toContain('Ю-Клуб Ю-Клуб');
});

test('город с двумя филиалами: шаблон, индекс; временно закрытый филиал остаётся в индексе', async ({ request }) => {
  const s = await html(request, '/novosibirsk/');
  expect(s).toContain('<title>Компьютерные клубы Ю-Клуб в городе Новосибирск: 2 адреса</title>');
  expect(s).toContain('<meta name="robots" content="index, follow">');
  expect(h1Count(s)).toBe(1);
  expect(s).toMatch(/<h1[^>]*>Ю-Клуб в городе Новосибирск<\/h1>/);
  const closed = await html(request, '/novosibirsk/akademgorodok/');
  expect(closed).toContain('<meta name="robots" content="index, follow">');
  expect(closed).toMatch(/<meta name="description" content="[^"]*Временно закрыт\."/);
});

test('юридическая – noindex, правила – индекс, стенд – noindex на тех же страницах', async ({ request }) => {
  expect(await html(request, '/privacy-policy/')).toContain('content="noindex, nofollow"');
  expect(await html(request, '/rules/')).toContain('content="index, follow"');
  for (const path of ['/tomsk/lenina/', '/novosibirsk/', '/rules/']) {
    expect(await (await request.get(path)).text(), path).toContain('<meta name="robots" content="noindex, nofollow">');
  }
});

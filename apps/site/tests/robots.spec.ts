// S4-57: robots.txt по таблице K23 §7. Бой – закрыты ЛК, вход, API, предпросмотр, Clean-param фильтров, ссылка на карту; стенд – Disallow: / и noindex.
// Файл .spec.ts: это проверка на собранном сайте в обоих режимах (план называет robots.test.ts, vitest сайт не поднимает).
import { expect, test } from '@playwright/test';
import { PROD_PORT } from '../playwright.config.ts';

test('бой: ровно таблица K23 §7, индексация открыта', async ({ request }) => {
  const res = await request.get(`http://127.0.0.1:${PROD_PORT}/robots.txt`);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('text/plain');
  expect(res.headers()['x-robots-tag']).toBeUndefined();
  expect(await res.text()).toBe(
    ['User-agent: *', 'Disallow: /account/', 'Disallow: /login/', 'Disallow: /api/', 'Disallow: /preview/', 'Clean-param: branch&zone&game&genre&occasion /', '', 'Sitemap: https://yu-club.test/sitemap.xml', ''].join('\n'),
  );
});

test('стенд: закрыт целиком, без ссылки на карту', async ({ request }) => {
  const res = await request.get('/robots.txt');
  expect(await res.text()).toBe('User-agent: *\nDisallow: /\n');
  expect(res.headers()['x-robots-tag']).toBe('noindex, nofollow');
});

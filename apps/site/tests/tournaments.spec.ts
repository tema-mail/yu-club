// S4-116: /tournaments/. В моке турниров нет (как на старте сети): хаб – noindex на бою и пустое состояние, в карте сайта его нет;
// неизвестный турнир – 404. Страница турнира рисуется тем же PublicationPage, что новости и акции (publications.spec.ts).
import { expect, test } from '../../../tests/support/e2e.ts';
import { PROD_PORT } from '../playwright.config.ts';

const PROD = `http://127.0.0.1:${PROD_PORT}`;

test('без турниров: пустое состояние, один H1, noindex на бою, хаба нет в sitemap.xml', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/tournaments/');
  await expect(page.locator('h1')).toHaveText('Турниры');
  await expect(page.getByTestId('publications-empty')).toContainText('Турниров пока нет');
  const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(scroll).toBeLessThanOrEqual(client);
  const html = await (await request.get(`${PROD}/tournaments/`)).text();
  expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
  expect(await (await request.get(`${PROD}/sitemap.xml`)).text()).not.toContain('/tournaments/');
});

test('неизвестный турнир – 404 с кодом 404', async ({ request }) => {
  const res = await request.get(`${PROD}/tournaments/nope/`);
  expect(res.status()).toBe(404);
  expect(await res.text()).toContain('content="noindex, nofollow"');
});

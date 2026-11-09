// S4-115: /giveaways/{slug}/rules/ – noindex всегда (и на бою), текст из CMS очищен; правила файлом – ссылка на PDF в /media/; без правил и розыгрыша – 404.
import { expect, test } from '../../../tests/support/e2e.ts';
import { PROD_PORT } from '../playwright.config.ts';

const PROD = `http://127.0.0.1:${PROD_PORT}`;

test('правила текстом: один H1, текст из CMS, noindex на бою, 390 px без прокрутки', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/giveaways/autumn-giveaway/rules/');
  await expect(page.locator('h1')).toHaveText('Правила розыгрыша «Осенний розыгрыш»');
  await expect(page.getByTestId('giveaway-rules')).toContainText('Организатор – Ю-Клуб.');
  const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(scroll).toBeLessThanOrEqual(client);
  const html = await (await request.get(`${PROD}/giveaways/autumn-giveaway/rules/`)).text();
  expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
});

test('правила файлом – ссылка на PDF в /media/; неизвестный розыгрыш – 404; в карте сайта правил нет', async ({ page, request }) => {
  await page.goto('/giveaways/pdf-giveaway/rules/');
  await expect(page.getByTestId('rules-pdf')).toHaveAttribute('href', /^\/media\/.+\.pdf$/);
  expect((await request.get(`${PROD}/giveaways/nope/rules/`)).status()).toBe(404);
  expect(await (await request.get(`${PROD}/sitemap.xml`)).text()).not.toMatch(/giveaways\/[^<]+\/rules\//);
});

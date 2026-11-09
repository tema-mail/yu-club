// S4-114: /giveaways/. Без формы участия; приз и дата итогов – из данных; правила – ссылкой на страницу или PDF в /media/.
import { expect, test } from '../../../tests/support/e2e.ts';
import { PROD_PORT } from '../playwright.config.ts';

const PROD = `http://127.0.0.1:${PROD_PORT}`;

test('390 px без горизонтальной прокрутки; список – действующие розыгрыши', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ['/giveaways/', '/giveaways/autumn-giveaway/']) {
    await page.goto(path);
    const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    expect(scroll, path).toBeLessThanOrEqual(client);
  }
  await page.screenshot({ path: 'test-results/screens/390-giveaway.png', fullPage: true });
  await page.goto('/giveaways/');
  const list = page.getByTestId('publications');
  await expect(list.getByRole('link', { name: 'Осенний розыгрыш' })).toBeVisible();
  await expect(list.getByRole('link', { name: 'Розыгрыш с правилами в PDF' })).toBeVisible();
});

test('страница: приз и дата итогов из данных, без формы участия, правила – страницей', async ({ page }) => {
  await page.goto('/giveaways/autumn-giveaway/');
  await expect(page.locator('h1')).toHaveText('Осенний розыгрыш');
  await expect(page.getByTestId('pub-prize')).toHaveText('Три часа в комнате PS5 на компанию');
  await expect(page.getByTestId('pub-results')).toHaveText(/\d+ \S+ 2026/);
  await expect(page.locator('main form, main input, main textarea')).toHaveCount(0);
  await expect(page.getByTestId('pub-rules')).toHaveAttribute('href', '/giveaways/autumn-giveaway/rules/');
  await expect(page.getByTestId('pub-scope')).toHaveText('Только в городе Новосибирск');
});

test('правила файлом – ссылка на PDF в /media/; неизвестный розыгрыш – 404; страница в индексе', async ({ page, request }) => {
  await page.goto('/giveaways/pdf-giveaway/');
  await expect(page.getByTestId('pub-rules')).toHaveAttribute('href', /^\/media\/.+\.pdf$/);
  expect((await request.get(`${PROD}/giveaways/nope/`)).status()).toBe(404);
  const html = await (await request.get(`${PROD}/giveaways/autumn-giveaway/`)).text();
  expect(html).toContain('<meta name="robots" content="index, follow">');
  expect((html.match(/<h1[\s>]/g) ?? []).length).toBe(1);
});

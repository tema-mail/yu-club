// S4-113: /promotions/. Действующая – в списке со сроком, условиями и кнопкой; завершённая – нет в списке, по ссылке плашка, noindex, без кнопки;
// цена на сайте не появляется (12 §8.3). 390 px без горизонтальной прокрутки, один H1, разметка Offer без цены.
import { expect, test } from '../../../tests/support/e2e.ts';
import { PROD_PORT } from '../playwright.config.ts';

const PROD = `http://127.0.0.1:${PROD_PORT}`;

test('390 px: список и страница акции без горизонтальной прокрутки', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ['/promotions/', '/promotions/happy-hours/', '/promotions/summer-promo/']) {
    await page.goto(path);
    const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    expect(scroll, path).toBeLessThanOrEqual(client);
    await page.screenshot({ path: `test-results/screens/390-${path.replaceAll('/', '_').replace(/^_|_$/g, '')}.png`, fullPage: true });
  }
});

test('список: только действующие, срок «до …»', async ({ page }) => {
  await page.goto('/promotions/');
  await expect(page.locator('h1')).toHaveText('Акции');
  const list = page.getByTestId('publications');
  await expect(list.getByRole('link', { name: 'Счастливые часы' })).toHaveAttribute('href', '/promotions/happy-hours/');
  await expect(list.locator('li', { hasText: 'Счастливые часы' })).toContainText(/до \d+ \S+ 2026/);
  await expect(list.getByText('Летняя акция')).toHaveCount(0);
});

test('действующая: условия, ограничения, кнопка ≥ 44 px во внутренний путь, без цены', async ({ page }) => {
  await page.goto('/promotions/happy-hours/');
  await expect(page.locator('h1')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Условия' })).toBeVisible();
  await expect(page.getByText('Только по будням с 10:00 до 14:00.')).toBeVisible();
  await expect(page.getByText('Не суммируется с другими акциями.')).toBeVisible();
  const cta = page.getByTestId('pub-cta');
  await expect(cta).toHaveAttribute('href', '/schedule/');
  expect((await cta.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expect(page.getByTestId('pub-ended')).toHaveCount(0);
  await expect(page.locator('main')).not.toContainText('₽');
});

test('завершённая: по ссылке плашка «Акция завершена», без кнопки, noindex; на бою Offer Discontinued', async ({ page, request }) => {
  await page.goto('/promotions/summer-promo/');
  await expect(page.getByTestId('pub-ended')).toHaveText('Акция завершена');
  await expect(page.getByTestId('pub-cta')).toHaveCount(0);
  const html = await (await request.get(`${PROD}/promotions/summer-promo/`)).text();
  expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
  expect(html).toContain('https://schema.org/Discontinued');
  const live = await (await request.get(`${PROD}/promotions/happy-hours/`)).text();
  expect(live).toContain('<meta name="robots" content="index, follow">');
  expect(live).toContain('"@type":"Offer"');
  expect(live).not.toMatch(/"price"/);
  expect((await request.get(`${PROD}/promotions/nope/`)).status()).toBe(404);
});

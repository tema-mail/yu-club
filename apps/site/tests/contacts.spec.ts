// S4-122: /contacts/ – все открытые клубы, часы по недельному графику из network, текст из CMS; готовящийся и архивный – нет;
// один H1, индекс на бою, 390 px без горизонтальной прокрутки.
import { expect, test } from '../../../tests/support/e2e.ts';
import { PROD_PORT } from '../playwright.config.ts';

const PROD = `http://127.0.0.1:${PROD_PORT}`;

test('клубы, часы из графика, текст CMS; готовящегося нет', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/contacts/');
  await expect(page.locator('h1')).toHaveText('Контакты');
  await expect(page.getByTestId('contacts-intro')).toContainText('Звоните в клуб');
  await expect(page.getByTestId('contacts-lenina').getByRole('link', { name: 'Ю-Клуб на Ленина' })).toHaveAttribute('href', '/tomsk/lenina/');
  await expect(page.getByTestId('contacts-lenina').getByTestId('contacts-hours')).toHaveText('Пн–Вс 10:00–22:00');
  await expect(page.getByTestId('contacts-akademgorodok')).toContainText('Временно закрыт');
  await expect(page.getByTestId('contacts-gorskiy')).toHaveCount(0);
  await expect(page.getByText('Ю-Клуб на Мира')).toHaveCount(0);
  const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(scroll).toBeLessThanOrEqual(client);
  await page.screenshot({ path: 'test-results/screens/390-contacts.png', fullPage: true });
});

test('бой: индекс, один H1, есть в sitemap.xml', async ({ request }) => {
  const html = await (await request.get(`${PROD}/contacts/`)).text();
  expect(html).toContain('<meta name="robots" content="index, follow">');
  expect((html.match(/<h1[\s>]/g) ?? []).length).toBe(1);
  expect(await (await request.get(`${PROD}/sitemap.xml`)).text()).toContain('<loc>https://yu-club.test/contacts/</loc>');
});

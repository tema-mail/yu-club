// S4-122: /contacts/ – все открытые клубы, часы по недельному графику из network, текст из CMS; готовящийся и архивный – нет;
// один H1, индекс на бою, 390 px без горизонтальной прокрутки. Реквизиты оператора (K5 №218, настройки legal.*): блок только из заполненных
// полей, незаполненные строки не рисуются; реквизитов нет – блока нет, выдуманных нет.
import { expect, test } from '../../../tests/support/e2e.ts';
import { MOCK_PORT, PROD_PORT } from '../playwright.config.ts';

const PROD = `http://127.0.0.1:${PROD_PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;

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

test('реквизиты: блок из заполненных полей, пустые строки не рисуются, телефон – ссылкой; реквизитов нет – блока нет', async ({ page, request }) => {
  await page.goto('/contacts/');
  const block = page.getByTestId('contacts-requisites');
  await expect(page.getByRole('heading', { name: 'Реквизиты' })).toBeVisible();
  await expect(block.locator('dt')).toHaveText(['Оператор', 'ИНН', 'Адрес', 'Телефон']);
  await expect(block).toContainText('ООО «Ю-Клуб»');
  await expect(block).toContainText('5405123456');
  await expect(block.getByRole('link', { name: '+7 383 000-00-00' })).toHaveAttribute('href', 'tel:+73830000000');
  await expect(block).not.toContainText('ОГРН');
  await expect(block).not.toContainText('Почта');
  await request.post(`${MOCK}/__mock/content`, { data: { requisites: 'empty' } });
  try {
    await page.goto('/contacts/');
    await expect(page.locator('h1')).toHaveText('Контакты');
    await expect(page.getByTestId('contacts-requisites')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Реквизиты' })).toHaveCount(0);
    await expect(page.getByTestId('contacts-lenina')).toBeVisible();
  } finally {
    await request.post(`${MOCK}/__mock/content`, { data: { requisites: 'full' } });
  }
});

test('бой: индекс, один H1, есть в sitemap.xml', async ({ request }) => {
  const html = await (await request.get(`${PROD}/contacts/`)).text();
  expect(html).toContain('<meta name="robots" content="index, follow">');
  expect((html.match(/<h1[\s>]/g) ?? []).length).toBe(1);
  expect(await (await request.get(`${PROD}/sitemap.xml`)).text()).toContain('<loc>https://yu-club.test/contacts/</loc>');
});

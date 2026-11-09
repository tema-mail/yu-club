// S4-123: ЛК «Уведомления» на моке tests/mock-notifications.ts. Без сессии – 302 на вход; только свои; реклама при выключенной «Рекламе»
// не видна; «связано с отменённой записью»; открыть центр – не прочитать; нажатие – прочтение и переход; «Отметить все»; 390 px.
import { expect, test, type Page } from '../../../tests/support/e2e.ts';
import { MOCK_PORT, STAGE_PORT } from '../playwright.config.ts';
import { MOCK_CODE } from './mock-api.ts';

test.use({ baseURL: `http://localhost:${STAGE_PORT}` });
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;

async function login(page: Page) {
  await page.goto('/login/?next=/account/notifications/');
  await page.getByLabel('Телефон').fill('9131234567');
  await page.getByRole('button', { name: 'Получить код' }).click();
  await page.getByLabel('Код из SMS').fill(MOCK_CODE);
  await page.getByLabel(/согласие на обработку/).check();
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(/^[^?]*\/account\/notifications\/$/);
}

test.beforeEach(async ({ request }) => {
  await request.post(`${MOCK}/__test/inbox-reset`);
});

test('без сессии – 302 на вход с возвратом, noindex', async ({ request }) => {
  const res = await request.get('/account/notifications/', { maxRedirects: 0 });
  expect(res.status()).toBe(302);
  expect(res.headers().location).toBe('/login/?next=%2Faccount%2Fnotifications%2F');
  expect(res.headers()['x-robots-tag']).toBe('noindex, nofollow');
});

test('список: свои, по времени, «Новое» словом, отменённая запись словами; рекламы при выключенной настройке нет; открыть – не прочитать', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await expect(page.locator('h1')).toHaveText('Уведомления');
  const items = page.getByTestId('nc-item');
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toContainText('Запись отменена клубом');
  await expect(items.nth(0)).toContainText('Новое');
  await expect(items.nth(0).getByTestId('nc-booking')).toHaveText('Связано с отменённой записью');
  await expect(items.nth(2)).toContainText('Запись уже прошла');
  await expect(items.nth(2)).not.toContainText('Новое');
  await expect(page.getByText('Чужое уведомление')).toHaveCount(0);
  await expect(page.getByText(/Реклама\./)).toHaveCount(0);
  const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(scroll).toBeLessThanOrEqual(client);
  for (const b of await page.locator('.nc__open').all()) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: 'test-results/screens/390-account-notifications.png', fullPage: true });
  const calls = (await (await request.get(`${MOCK}/__test/inbox-calls`)).json()) as string[];
  expect(calls.filter((c) => c.endsWith('/read'))).toEqual([]);
});

test('нажатие – прочтение и переход по ссылке; «Отметить все прочитанными» снимает «Новое»', async ({ page }) => {
  await login(page);
  await page.getByTestId('nc-item').filter({ hasText: 'Напоминание о сеансе' }).getByRole('button').click();
  await expect(page).toHaveURL(/\/account\/$/);
  await page.goto('/account/notifications/');
  await expect(page.getByTestId('nc-item').filter({ hasText: 'Напоминание о сеансе' })).not.toContainText('Новое');
  await expect(page.getByTestId('nc-item').filter({ hasText: 'Запись отменена клубом' })).toContainText('Новое');
  await page.getByRole('button', { name: 'Отметить все прочитанными' }).click();
  await expect(page.getByText('Новое', { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('nc-item').first()).toBeVisible();
  await expect(page.getByText('Новое', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Отметить все прочитанными' })).toHaveCount(0);
});

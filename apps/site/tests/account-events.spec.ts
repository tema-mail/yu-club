// e2e ЛК «Мои мероприятия» (S3-93) на моке tests/mock-events.ts (П3 по apps/api/src/modules/events/routes.public.ts): только свои,
// от «подтверждено» (заявка и отменённое не видны), дата, филиал, состав без цен и себестоимости; чужое не видно; пустое состояние;
// 390 px без горизонтальной прокрутки.
import { expect, test, type Page } from '../../../tests/support/e2e.ts';
import { MOCK_PORT, STAGE_PORT } from '../playwright.config.ts';
import { MOCK_CODE } from './mock-api.ts';

test.use({ baseURL: `http://localhost:${STAGE_PORT}` });

async function login(page: Page, phone: string) {
  await page.goto('/login/?next=/account/');
  await page.getByLabel('Телефон').fill(phone);
  await page.getByRole('button', { name: 'Получить код' }).click();
  await page.getByLabel('Код из SMS').fill(MOCK_CODE);
  await page.getByLabel(/согласие на обработку/).check();
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(/^[^?]*\/account\/$/);
  await expect(page.getByTestId('profile')).toBeVisible();
}

test.beforeEach(async ({ request }) => {
  await request.post(`http://127.0.0.1:${MOCK_PORT}/__test/events-reset`);
});

test('только свои от «подтверждено»: дата, филиал, состав без цен; заявки, отменённого и чужого нет', async ({ page }) => {
  await login(page, '9131234567');
  const events = page.getByTestId('event');
  await expect(events).toHaveCount(2);
  await expect(events.nth(0)).toContainText('День рождения № EV-000201');
  await expect(events.nth(0)).toContainText('Подтверждено');
  await expect(events.nth(0).getByTestId('event-when')).toHaveText(/^\d{1,2} [а-я]+ \d{4} г\., 14:00–16:00$/);
  await expect(events.nth(0)).toContainText('Ю-Клуб на Красном, Красный проспект, 25');
  await expect(events.nth(0).getByTestId('event-lines').locator('li')).toHaveText(['Аренда комнаты VR+PS4 – 2 ч', 'Праздничный стол – 1 шт']);
  await expect(events.nth(1)).toContainText('Выпускной в VR № EV-000187');
  await expect(events.nth(1)).toContainText('Прошло');

  const block = page.getByTestId('my-events');
  await expect(block).not.toContainText('₽'); // ни цены, ни себестоимости
  await expect(block).not.toContainText('EV-000210'); // заявка new_request
  await expect(block).not.toContainText('EV-000190'); // отменённое
  await expect(block).not.toContainText('EV-000205'); // мероприятие Петра
  const raw = await page.evaluate(async () => JSON.stringify(await (await fetch('/api/public/v1/me/events/')).json()));
  expect(raw).not.toMatch(/price|cost|Kop/i);
});

test('нет мероприятий – пустое состояние со ссылкой на /birthday/', async ({ page }) => {
  await login(page, '9130000079');
  await expect(page.getByTestId('events-empty')).toContainText('Мероприятий пока нет');
  await expect(page.getByTestId('events-empty').getByRole('link')).toHaveAttribute('href', '/birthday/');
});

test('390 px: без горизонтальной прокрутки', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, '9131234567');
  await expect(page.getByTestId('event')).toHaveCount(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.getByTestId('my-events').screenshot({ path: 'test-results/account-events-390.png' });
});

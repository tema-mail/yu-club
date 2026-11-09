// S4-95: глобальный поиск в шапке – группы по типам в пределах прав, маска клиента без client.view.full, «ничего не найдено» – не
// ошибка, короткий запрос – подсказка; клавиатура: «/» – фокус, стрелки – по найденному, Enter – открыть, Escape – закрыть.
import { expect, test, type Page } from '../../../tests/support/e2e.ts';
import { MOCK_PASSWORD } from './mock-api.ts';

test.beforeEach(async ({ request }) => {
  await request.post(`${process.env.MOCK_URL ?? 'http://127.0.0.1:4012'}/__test/reset`);
});
async function login(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Почта').fill(email);
  await page.getByLabel('Пароль', { exact: true }).fill(MOCK_PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).not.toHaveURL(/\/login/);
}
async function open(page: Page, url: string) {
  await page.goto(url);
  await page.waitForLoadState('load');
  await expect(page.locator('astro-island[ssr]')).toHaveCount(0);
}
const box = (page: Page) => page.getByRole('combobox', { name: 'Поиск по CRM' });
const results = (page: Page) => page.getByTestId('search-results');

test('Владелец: клиенты и сотрудники отдельными группами, бронь по номеру', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, '/reports');
  await box(page).fill('Ольга');
  await expect(results(page).getByTestId('search-group-client')).toContainText('Ольга Смирнова');
  await expect(results(page).getByTestId('search-group-client')).toContainText('+79131234567');
  await expect(results(page).getByTestId('search-group-staff')).toContainText('Ольга Владимирова');
  await expect(results(page).getByTestId('search-group-staff')).toContainText('Владелец');
  await expect(results(page).getByRole('group')).toHaveCount(2);
  await box(page).fill('1001');
  await expect(results(page).getByTestId('search-group-booking').getByRole('link')).toHaveAttribute('href', /^\/bookings\/b0000000-/);
  await expect(results(page).getByTestId('search-group-booking')).toContainText('Бронь № 1001');
});

test('ничего не найдено – подсказка, а не ошибка; короткий запрос и телефон из 3 цифр – подсказка', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, '/reports');
  await box(page).fill('Щщщ');
  await expect(results(page).getByTestId('search-empty')).toContainText('По запросу «Щщщ» ничего не нашлось');
  await expect(results(page).getByRole('alert')).toHaveCount(0);
  await box(page).fill('Щ');
  await expect(results(page).getByTestId('search-hint')).toHaveText('Введите не меньше 2 символов');
  await box(page).fill('+7 9');
  await expect(results(page).getByTestId('search-hint')).toHaveText('Для поиска по телефону нужно от 4 цифр.');
  await box(page).press('Escape');
  await expect(results(page)).toHaveCount(0);
});

test('клавиатура: «/» – фокус, стрелки и Enter открывают найденное', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, '/reports');
  await page.locator('main h1').click();
  await page.keyboard.press('/');
  await expect(box(page)).toBeFocused();
  await expect(box(page)).toHaveValue('');
  await page.keyboard.type('Ольга');
  await expect(results(page).getByRole('option')).toHaveCount(2);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(results(page).getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowUp');
  await expect(results(page).getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/clients\/c0000000-0000-4000-8000-000000000001$/);
});

test('Администратор: клиент своей зоны в маске, сотрудников и кассы нет; «/» в поле ввода – просто символ', async ({ page }) => {
  await login(page, 'admin@yu.test');
  await open(page, '/reports/bookings?from=2026-11-01&to=2026-11-10');
  await box(page).fill('Ив');
  const clients = results(page).getByTestId('search-group-client');
  await expect(clients).toContainText('Иван П.');
  await expect(clients).toContainText('+7 *** ***-65-43');
  await expect(clients).not.toContainText('Петров');
  await box(page).fill('Ма'); // Мария – клиент Томска, вне зоны
  await expect(results(page).getByTestId('search-empty')).toBeVisible();
  await expect(results(page).getByTestId('search-group-staff')).toHaveCount(0);
  await page.locator('main [name=from]').focus();
  await page.keyboard.press('/');
  await expect(box(page)).not.toBeFocused();
});

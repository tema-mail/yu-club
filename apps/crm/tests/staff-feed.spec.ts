// S4-97: лента событий CRM со значком в шапке (13 §11, S4-28). Событие ведёт в карточку и становится прочитанным; чужая зона
// и чужая смена не видны; «Только непрочитанные», «Отметить все прочитанными», Escape закрывает. Мок – строго по API S4-28.
import { expect, test, type Page } from '../../../tests/support/e2e.ts';
import { MOCK_PASSWORD } from './mock-api.ts';

const MOCK = process.env.MOCK_URL ?? 'http://127.0.0.1:4012';
test.beforeEach(async ({ request }) => {
  await request.post(`${MOCK}/__test/reset`);
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
const bell = (page: Page) => page.getByRole('button', { name: /^События/ });
const feed = (page: Page) => page.getByTestId('staff-feed');

test('Администратор: значок с числом, своя смена и события своего филиала; томского ремонта нет', async ({ page }) => {
  await login(page, 'admin@yu.test');
  await open(page, '/schedule');
  await expect(page.getByTestId('feed-badge')).toHaveText('3');
  await expect(bell(page)).toHaveAccessibleName('События, непрочитанных: 3');
  await bell(page).click();
  const items = feed(page).getByTestId('feed-item');
  await expect(items).toHaveCount(4);
  await expect(items.nth(0)).toContainText('Ваша смена изменена');
  await expect(items.nth(0)).toContainText('Смена · Ю Клуб на Красном');
  await expect(items.nth(0).getByRole('link')).toHaveAttribute('href', '/shifts/5f000000-0000-4000-8000-000000000001');
  await expect(items.nth(1).getByRole('link')).toHaveAttribute('href', '/repairs/e7000000-0000-4000-8000-000000000001');
  await expect(items.nth(2).getByRole('link')).toHaveAttribute('href', '/clients/c0000000-0000-4000-8000-000000000001');
  await expect(items.nth(2)).toContainText('Нет канала push');
  await expect(items.nth(3)).toHaveAttribute('data-read', 'true');
  await expect(feed(page)).not.toContainText('Т-3');
  await page.keyboard.press('Escape');
  await expect(feed(page)).toHaveCount(0);
});

test('чужая смена не видна: Томский администратор видит только ремонт своего филиала; Директор Новосибирска – без смены Анны', async ({ page }) => {
  await login(page, 'tomsk@yu.test');
  await open(page, '/schedule');
  await bell(page).click();
  await expect(feed(page).getByTestId('feed-item')).toHaveCount(1);
  await expect(feed(page)).toContainText('Новый ремонт № Т-3');
  await expect(feed(page)).not.toContainText('Ваша смена');

  await page.context().clearCookies();
  await login(page, 'director@yu.test');
  await open(page, '/schedule');
  await bell(page).click();
  await expect(feed(page)).toContainText('Новый ремонт № Р-12');
  await expect(feed(page)).not.toContainText('Ваша смена');
  await expect(feed(page)).not.toContainText('Т-3');
});

test('событие ведёт в карточку и становится прочитанным; число на значке уменьшается', async ({ page }) => {
  await login(page, 'admin@yu.test');
  await open(page, '/schedule');
  await bell(page).click();
  await feed(page).getByRole('link', { name: /Новый ремонт № Р-12/ }).click();
  await expect(page).toHaveURL(/\/repairs\/e7000000-0000-4000-8000-000000000001$/);
  await open(page, '/schedule');
  await expect(page.getByTestId('feed-badge')).toHaveText('2');
  await bell(page).click();
  await expect(feed(page).getByTestId('feed-item').filter({ hasText: 'Р-12' })).toHaveAttribute('data-read', 'true');
});

test('только непрочитанные и «Отметить все прочитанными»: значок пропадает, пустой список – спокойная подсказка', async ({ page }) => {
  await login(page, 'admin@yu.test');
  await open(page, '/schedule');
  await bell(page).click();
  await feed(page).getByLabel('Только непрочитанные').check();
  await expect(feed(page).getByTestId('feed-item')).toHaveCount(3);
  await feed(page).getByRole('button', { name: 'Отметить все прочитанными' }).click();
  await expect(feed(page).getByTestId('feed-empty')).toHaveText('Непрочитанных событий нет.');
  await expect(page.getByTestId('feed-badge')).toHaveCount(0);
  await expect(bell(page)).toHaveAccessibleName('События');
  await expect(feed(page).getByRole('alert')).toHaveCount(0);
  await feed(page).getByLabel('Только непрочитанные').uncheck();
  await expect(feed(page).getByTestId('feed-item')).toHaveCount(4);
  await expect(feed(page).locator('[data-read="false"]')).toHaveCount(0);
});

test('новое событие появляется после обновления страницы', async ({ page, request }) => {
  await login(page, 'admin@yu.test');
  await open(page, '/schedule');
  await expect(page.getByTestId('feed-badge')).toHaveText('3');
  await request.post(`${MOCK}/__test/staff-feed/add`, { data: { title: 'Новый ремонт № Р-99' } });
  await open(page, '/schedule');
  await expect(page.getByTestId('feed-badge')).toHaveText('4');
  await bell(page).click();
  await expect(feed(page).getByTestId('feed-item').first()).toContainText('Новый ремонт № Р-99');
});

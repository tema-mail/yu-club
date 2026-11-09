// S4-82: шаблоны сообщений. Владелец создаёт, правит и архивирует; неизвестная подстановка – ошибка у поля; Директор
// и Администратор видят список без кнопок и полей; шаблон в форме сообщения подставляет категорию, заголовок и текст.
import { expect, test, type Page } from '../../../tests/support/e2e.ts';
import { MOCK_PASSWORD } from './mock-api.ts';
import { TEMPLATE_IDS } from './mock-notifications.ts';

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
const body = (page: Page) => page.locator('textarea[name=body]');

test('Владелец: новый шаблон, неизвестная подстановка у поля, правка и архив', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, '/notifications');
  await page.getByRole('link', { name: 'Шаблоны' }).click();
  await expect(page.getByTestId(`tpl-${TEMPLATE_IDS.rules}`)).toContainText('Правила клуба');
  await page.getByRole('button', { name: 'Новый шаблон' }).click();
  await page.getByLabel('Название').fill('Акция выходных');
  await page.getByLabel('Категория').selectOption('marketing');
  await page.getByLabel('Заголовок').fill('Реклама. Выходные');
  await body(page).fill('{client.name}, ждём в {branch.name}!');
  await page.getByRole('button', { name: 'Сохранить шаблон' }).click();
  await expect(body(page)).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#tpl-body-err')).toContainText('неизвестная подстановка');
  await body(page).fill('{client.firstName}, ждём в {branch.name}!');
  await expect(body(page)).not.toHaveAttribute('aria-invalid', 'true');
  await page.getByRole('button', { name: 'Сохранить шаблон' }).dblclick();
  await expect(page.getByRole('status')).toContainText('Шаблон создан');
  await expect(page.getByTestId('templates').locator('li')).toHaveCount(3);

  const rules = page.getByTestId(`tpl-${TEMPLATE_IDS.rules}`);
  await rules.getByRole('button', { name: 'Изменить' }).click();
  await expect(page.getByLabel('Категория')).toBeDisabled();
  await page.getByLabel('Заголовок').fill('Перед визитом');
  await page.getByRole('button', { name: 'Сохранить шаблон' }).click();
  await expect(page.getByRole('status')).toContainText('Уже созданные сообщения не изменились');
  await expect(rules).toContainText('Перед визитом');
  await rules.getByRole('button', { name: 'В архив' }).click();
  await expect(rules).toContainText('в архиве');
  await open(page, '/notifications/new');
  await expect(page.getByLabel('Шаблон').locator('option')).toHaveText(['Без шаблона', 'Акция выходных', 'Будни со скидкой']);
});

test('Директор видит, не правит; шаблон в форме подставляет категорию и текст', async ({ page }) => {
  await login(page, 'director@yu.test');
  await open(page, '/notifications/templates');
  await expect(page.getByTestId('tpl-readonly')).toBeVisible();
  await expect(page.getByTestId(`tpl-${TEMPLATE_IDS.promo}`)).toContainText('Будни со скидкой');
  await expect(page.getByRole('button', { name: 'Новый шаблон' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Изменить' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'В архив' })).toHaveCount(0);
  await open(page, '/notifications/new');
  await page.getByLabel('Шаблон').selectOption({ label: 'Будни со скидкой' });
  await expect(page.getByLabel('Категория')).toHaveValue('marketing');
  await expect(page.getByLabel('Заголовок')).toHaveValue('Реклама. Скидка в будни');
  await expect(body(page)).toHaveValue('В {branch.name} днём в будни дешевле.');
});

test('Администратор: в форме только сервисные шаблоны, раздел шаблонов – только чтение', async ({ page }) => {
  await login(page, 'admin@yu.test');
  await open(page, '/notifications/new');
  await expect(page.getByLabel('Шаблон').locator('option')).toHaveText(['Без шаблона', 'Правила клуба']);
  await open(page, '/notifications/templates');
  await expect(page.getByTestId('tpl-readonly')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Новый шаблон' })).toHaveCount(0);
});

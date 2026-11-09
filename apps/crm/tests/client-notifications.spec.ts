// S4-83: блок «Уведомления» в карточке клиента (09 §12.3). Реклама и напоминания – с датой изменения; push – «N браузеров»
// без технических идентификаторов; последние отправки в пределах зоны; повтор критичного – только с правом notifications.retry.
import { expect, test, type Page } from '../../../tests/support/e2e.ts';
import { MOCK_PASSWORD } from './mock-api.ts';
import { ROW_IDS } from './mock-notifications.ts';

const C1 = 'c0000000-0000-4000-8000-000000000001';
const C2 = 'c0000000-0000-4000-8000-000000000002';

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
const block = (page: Page) => page.getByTestId('client-notifications');
const recent = (page: Page) => page.getByTestId('cn-recent').locator('li');

test('Директор: настройки с датой изменения, «2 браузера» без идентификаторов, повтор критичного с причиной', async ({ page }) => {
  await login(page, 'director@yu.test');
  await open(page, `/clients/${C1}`);
  await expect(block(page).getByTestId('cn-marketing')).toHaveText('Включена, изменено 01.10.2026, 12:00 на сайте');
  await expect(block(page).getByTestId('cn-reminders')).toHaveText('Включены, изменено 05.10.2026, 14:30');
  await expect(block(page).getByTestId('cn-push')).toHaveText('есть 2 браузера');
  await expect(block(page)).not.toContainText(/endpoint|p256dh|auth|https:\/\//i);
  await expect(recent(page)).toHaveCount(4);
  await expect(page.getByTestId(`cn-${ROW_IDS.networkAd}`)).toHaveCount(0);
  const failed = page.getByTestId(`cn-${ROW_IDS.personalError}`);
  await expect(failed).toContainText('Ошибка');
  await failed.getByRole('button', { name: 'Повторить' }).click();
  await page.getByRole('dialog').getByLabel('Причина').fill('Клиент обновил браузер');
  await page.getByRole('dialog').getByRole('button', { name: 'Повторить отправку' }).dblclick();
  await expect(block(page).getByRole('status')).toContainText('Повтор поставлен');
  await expect(recent(page)).toHaveCount(5);
  await expect(block(page)).toContainText('повтор');
  await expect(block(page).getByRole('link', { name: 'Все отправки клиента' })).toHaveAttribute('href', `/notifications?tab=rows&clientId=${C1}`);
});

test('Администратор: без кнопки повтора; «Написать клиенту» открывает форму на этого клиента', async ({ page }) => {
  await login(page, 'admin@yu.test');
  await open(page, `/clients/${C1}`);
  await expect(recent(page)).toHaveCount(4);
  await expect(block(page).getByRole('button', { name: 'Повторить' })).toHaveCount(0);
  await block(page).getByRole('link', { name: 'Написать клиенту' }).click();
  await expect(page.locator('astro-island[ssr]')).toHaveCount(0);
  await page.getByLabel('Категория').selectOption('service');
  await expect(page.getByRole('button', { name: 'Один клиент' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('cf-client')).toBeVisible();
});

test('клиент без подписки и без согласия на рекламу; Владелец видит и сетевую рассылку; 390 px', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, `/clients/${C2}`);
  await expect(block(page).getByTestId('cn-marketing')).toHaveText('Выключена, не менялось');
  await expect(block(page).getByTestId('cn-reminders')).toHaveText('Выключены, изменено 16.10.2026, 10:00');
  await expect(block(page).getByTestId('cn-push')).toContainText('нет подписки');
  await open(page, `/clients/${C1}`);
  await expect(recent(page)).toHaveCount(5);
  await expect(page.getByTestId(`cn-${ROW_IDS.networkAd}`)).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, `/clients/${C1}`);
  await expect(recent(page)).toHaveCount(5);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

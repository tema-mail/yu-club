// Экран «Настройки» (K7 «HTTP CRM») на моке mock-settings.ts: Владелец меняет окно записи филиала и видит «свой уровень»,
// возвращает к наследованию через окно (старое – в истории), max < default – понятный отказ; Директор – ключи Владельца
// только смотрит, чужой филиал – 404; Администратору раздел недоступен. 390 px – без горизонтальной прокрутки.
import { expect, test, type Page } from '../../../tests/support/e2e.ts';
import { MOCK_PASSWORD } from './mock-api.ts';

const MOCK = process.env.MOCK_URL ?? 'http://127.0.0.1:4012';
const SHOTS = process.env.SCREENSHOT_DIR ?? 'test-results/screens';
const BRANCH = '/settings?scope=branch&id=b-nsk-krasny';

test.describe.configure({ mode: 'serial' });
test.beforeAll(async ({ request }) => {
  expect((await request.post(`${MOCK}/__test/reset`)).ok()).toBe(true);
});
test.afterAll(async ({ request }) => {
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
const row = (page: Page, key: string) => page.getByTestId(`setting-${key}`);
const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test('Владелец меняет окно записи филиала – «свой уровень», затем возврат к наследованию с историей', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await expect(page.getByRole('link', { name: 'Настройки' })).toBeVisible();
  await open(page, BRANCH);
  await expect(page.getByTestId('settings-scope')).toHaveText('Ю Клуб на Красном · Новосибирск');
  const w = row(page, 'booking.window_default_days');
  await expect(w.getByTestId('source')).toHaveText('Системное значение');
  await expect(w).toContainText('Допустимо от 1 до 30 дн.');
  await w.getByRole('button', { name: 'Изменить' }).click();
  await w.getByLabel('Новое значение, дн.').fill('10');
  await w.getByLabel('Причина (видна в истории)').fill('праздники');
  await w.getByRole('button', { name: 'Сохранить' }).click();
  await expect(w.getByRole('status')).toContainText('Сохранено: 10 дн. с этой минуты.');
  await expect(w.getByTestId('value')).toHaveText('10 дн.');
  await expect(w.getByTestId('source')).toHaveText('Свой уровень');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: `${SHOTS}/settings-1440.png`, fullPage: true });

  // Будущее изменение – в «Запланировано», действующее значение не меняется.
  const buf = row(page, 'booking.buffer_minutes');
  await buf.getByRole('button', { name: 'Изменить' }).click();
  await buf.getByLabel('Новое значение, мин').fill('10');
  const later = await page.evaluate(() => new Date(Date.now() + 5 * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Novosibirsk' }));
  await buf.getByLabel('Действует с').fill(later);
  await buf.getByRole('button', { name: 'Сохранить' }).click();
  await expect(buf.getByTestId('upcoming')).toContainText('10 мин (филиал)');
  await expect(buf.getByTestId('value')).toHaveText('0 мин');

  await w.getByRole('button', { name: 'Вернуть к наследованию…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Вернуть к наследованию?' });
  await expect(dialog).toContainText('«Окно записи по умолчанию» сейчас: 10 дн.');
  await dialog.getByRole('button', { name: 'Вернуть' }).click();
  await expect(w.getByTestId('value')).toHaveText('7 дн.');
  await expect(w.getByTestId('source')).toHaveText('Системное значение');
  await expect(w.getByRole('button', { name: 'Вернуть к наследованию…' })).toHaveCount(0);
  await w.getByRole('button', { name: 'История' }).click();
  await expect(w.getByTestId('history')).toContainText('Завершено · 10 дн. · филиал (этот уровень)');
  await expect(w.getByTestId('history')).toContainText('праздники');

  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, BRANCH);
  expect(await noHorizontalScroll(page)).toBe(true);
  await row(page, 'booking.window_max_days').getByRole('button', { name: 'Изменить' }).click();
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.screenshot({ path: `${SHOTS}/settings-390.png`, fullPage: true });
});

test('окно max меньше окна по умолчанию – понятный отказ, значение не меняется; вне пределов – подсказка', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, BRANCH);
  const max = row(page, 'booking.window_max_days');
  await max.getByRole('button', { name: 'Изменить' }).click();
  await max.getByLabel('Новое значение, дн.').fill('95');
  await max.getByRole('button', { name: 'Сохранить' }).click();
  await expect(max.getByRole('status')).toHaveText('Допустимо от 1 до 90 дн.');
  await max.getByLabel('Новое значение, дн.').fill('5');
  await max.getByRole('button', { name: 'Сохранить' }).click();
  await expect(max.getByRole('status')).toHaveText(
    'Максимальное окно записи (5 дн.) не может быть меньше окна по умолчанию (7 дн.). Сначала уменьшите окно по умолчанию или выберите значение побольше.',
  );
  await page.reload();
  await expect(row(page, 'booking.window_max_days').getByTestId('value')).toHaveText('30 дн.');
});

test('Директор: ключи Владельца только смотрит, чужой филиал – 404', async ({ page }) => {
  await login(page, 'director@yu.test');
  await open(page, BRANCH);
  const cash = row(page, 'finance.negative_balance_allowed');
  await expect(cash).toContainText('Меняет только Владелец.');
  await expect(cash.getByRole('button', { name: 'Изменить' })).toHaveCount(0);
  const hold = row(page, 'booking.hold_minutes');
  await expect(hold).toContainText('Задаётся на уровне: сеть.');
  await expect(hold.getByRole('button', { name: 'Изменить' })).toHaveCount(0);
  await expect(hold.getByRole('button', { name: 'История' })).toBeVisible();
  const r = await page.goto('/settings?scope=branch&id=b-tsk-lenina');
  expect(r?.status()).toBe(404);
  await expect(page.getByTestId('not-found')).toBeVisible();
});

test('Администратор: пункта меню нет, экран недоступен', async ({ page }) => {
  await login(page, 'admin@yu.test');
  await expect(page.getByRole('link', { name: 'Настройки' })).toHaveCount(0);
  const r = await page.goto('/settings');
  expect(r?.status()).toBe(403);
  await expect(page.getByTestId('no-access')).toContainText('Раздел недоступен');
});

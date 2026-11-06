// Проверка S0-15c (план 6.1), экран «Сотрудники»: Директор создаёт только Администратора (опции «Директор» нет),
// временный пароль – один раз с «Скопировать»; Администратору экран недоступен (404); блокировка через окно
// с причиной – и заблокированный не входит; устаревший rowVersion – понятное сообщение; 1440 и 390 без прокрутки.
import { expect, test, type Page } from '../../../tests/support/e2e.ts';
import { MOCK_PASSWORD } from './mock-api.ts';

const MOCK = process.env.MOCK_URL ?? 'http://127.0.0.1:4012';
const SHOTS = process.env.SCREENSHOT_DIR ?? 'test-results/screens';

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

const rows = (page: Page) => page.getByTestId('staff').locator('tbody tr');

test('Директор: своя зона, создание только Администратора, временный пароль один раз', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await login(page, 'director@yu.test');
  await page.getByRole('navigation', { name: 'Разделы' }).getByRole('link', { name: 'Сотрудники' }).click();
  await expect(page).toHaveURL(/\/staff$/);
  await expect(rows(page)).toHaveCount(2); // порция по 2 (MOCK_PAGE_SIZE)
  await page.getByRole('button', { name: 'Показать ещё' }).click();
  await expect(rows(page)).toHaveCount(4); // Админова, Двухфилиальная (S3-72), Директоров, Новиков – Новосибирск
  await expect(page.getByTestId('staff')).not.toContainText('Томский');
  expect((await page.goto('/staff/s-admin-tsk'))?.status()).toBe(404);

  await page.goto('/staff');
  await page.getByRole('link', { name: 'Добавить сотрудника' }).click();
  await expect(page).toHaveURL(/\/staff\/new$/);
  await expect(page.getByLabel('Роль *').locator('option')).toHaveText(['Администратор']);

  await page.getByRole('button', { name: 'Создать сотрудника' }).click();
  await expect(page.getByText('Проверьте отмеченные поля.')).toBeVisible();
  await expect(page.getByText('Отметьте хотя бы один филиал или город')).toBeVisible();

  await page.getByLabel('Фамилия *').fill('Сменов');
  await page.getByLabel('Имя *').fill('Пётр');
  await page.getByLabel('Почта (логин) *').fill('admin@yu.test');
  await page.getByLabel('Телефон').fill('8 913 555-44-33');
  await page.getByLabel('Ю Клуб на Красном').check();
  await page.getByRole('button', { name: 'Создать сотрудника' }).click();
  await expect(page.getByText('Сотрудник с такой почтой уже есть').first()).toBeVisible();

  await page.getByLabel('Почта (логин) *').fill('smenov@yu.test');
  await page.getByRole('button', { name: 'Создать сотрудника' }).click();
  const created = page.getByTestId('staff-created');
  await expect(created).toContainText('Сотрудник создан: Пётр Сменов');
  const password = (await page.getByTestId('temp-password').textContent()) ?? '';
  expect(password).toMatch(/^[\w-]{16}$/);
  await expect(created).toContainText('Пароль показан один раз');
  await created.getByRole('button', { name: 'Скопировать' }).click();
  await expect(created.getByText('Скопировано.')).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(password);

  await created.getByRole('link', { name: 'Открыть карточку' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Сменов Пётр');
  expect(await page.content()).not.toContain(password);
  await expect(page.getByLabel('Телефон')).toHaveValue('+79135554433');
  await expect(page.getByTestId('history')).toContainText('Создание');
  await expect(page.getByTestId('history')).toContainText('Филиалы: Ю Клуб на Красном');
});

test('Администратору экран сотрудников недоступен', async ({ page }) => {
  await login(page, 'admin@yu.test');
  await expect(page.getByRole('navigation', { name: 'Разделы' }).getByRole('link', { name: 'Сотрудники' })).toHaveCount(0);
  for (const path of ['/staff', '/staff/new', '/staff/s-director', '/staff/s-admin']) {
    expect((await page.goto(path))?.status()).toBe(404);
    await expect(page.getByTestId('not-found')).toBeVisible();
  }
  const api = await page.request.get('/api/crm/v1/staff');
  expect(api.status()).toBe(403);
});

test('блокировка через окно с причиной: заблокированный не входит; разблокировка', async ({ page, browser }) => {
  await login(page, 'owner@yu.test');
  await page.goto('/staff/s-admin');
  await page.getByRole('button', { name: 'Заблокировать…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Заблокировать сотрудника?' });
  await expect(dialog).toContainText('сразу выйдет из CRM');
  await dialog.getByRole('button', { name: 'Заблокировать' }).click();
  await expect(dialog.getByText('Укажите причину.')).toBeVisible();
  await dialog.getByLabel('Причина *').fill('Увольнение');
  await dialog.getByRole('button', { name: 'Заблокировать' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('staff-status')).toHaveText('Заблокирован');
  const first = page.getByTestId('history').locator('.yc-history__item').first();
  await expect(first).toContainText('Блокировка');
  await expect(first).toContainText('Причина: Увольнение');
  await expect(first).toContainText('Статус: Работает → Заблокирован');

  const other = await (await browser.newContext()).newPage();
  await other.goto('/login');
  await other.getByLabel('Почта').fill('admin@yu.test');
  await other.getByLabel('Пароль', { exact: true }).fill(MOCK_PASSWORD);
  await other.getByRole('button', { name: 'Войти' }).click();
  await expect(other.getByText('Неверная почта или пароль')).toBeVisible();

  await page.getByRole('button', { name: 'Разблокировать…' }).click();
  const back = page.getByRole('dialog', { name: 'Разблокировать сотрудника?' });
  await back.getByLabel('Причина *').fill('Вернулся');
  await back.getByRole('button', { name: 'Разблокировать' }).click();
  await expect(page.getByTestId('staff-status')).toHaveText('Работает');
});

test('устаревший rowVersion – понятное сообщение', async ({ page, browser }) => {
  await login(page, 'owner@yu.test');
  const other = await (await browser.newContext()).newPage();
  await login(other, 'owner@yu.test');
  await page.goto('/staff/s-admin-tsk');
  await other.goto('/staff/s-admin-tsk');

  await other.getByLabel('Телефон').fill('+79130001122');
  await other.getByRole('button', { name: 'Сохранить' }).click();
  await expect(other.getByText('Сохранено.')).toBeVisible();

  await page.getByLabel('Имя *').fill('Тимофей');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByText('Карточку уже изменил другой сотрудник. Обновите страницу')).toBeVisible();

  // То же для блокировки по старой версии.
  await page.getByRole('button', { name: 'Заблокировать…' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Причина *').fill('Проверка');
  await dialog.getByRole('button', { name: 'Заблокировать' }).click();
  await expect(dialog.getByText('Карточку уже изменил другой сотрудник')).toBeVisible();
});

test('снимки сотрудников 1440 и 390, без горизонтальной прокрутки', async ({ browser }) => {
  for (const [w, h] of [[1440, 900], [390, 844]] as const) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: w === 390 ? 2 : 1 });
    const page = await ctx.newPage();
    await login(page, 'owner@yu.test');
    const noScroll = async () => expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(w);
    await page.goto('/staff');
    await expect(rows(page)).toHaveCount(2);
    await page.screenshot({ path: `${SHOTS}/staff-list-${w}.png`, fullPage: true });
    await noScroll();
    await page.goto('/staff/new');
    await page.screenshot({ path: `${SHOTS}/staff-new-${w}.png`, fullPage: true });
    await noScroll();
    await page.goto('/staff/s-admin');
    await expect(page.getByTestId('history')).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/staff-card-${w}.png`, fullPage: true });
    await noScroll();
    await page.getByRole('button', { name: 'Заблокировать…' }).click();
    await page.screenshot({ path: `${SHOTS}/staff-block-dialog-${w}.png` });
    await ctx.close();
  }
});

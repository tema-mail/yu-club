// Карточка сотрудника (S3-70) на моке mock-shifts-staff.ts: история ставок, «Не настроена ставка», новая ставка и исправление (копейки без потерь),
// «Временно не работает» со списком смен «требуют решения», права: Директор видит историю без кнопки и получает 403 от сервера, чужой город – 404, Администратору – 404.
import { expect, test, type Page } from '@playwright/test';
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
async function open(page: Page, url: string) {
  await page.goto(url);
  await page.waitForLoadState('load');
  await expect(page.locator('astro-island[ssr]')).toHaveCount(0);
}
const headers = () => ({ 'idempotency-key': crypto.randomUUID() });

test('Владелец: история, текущая ставка, новая и исправление', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, '/staff/s-admin');
  await expect(page.getByTestId('rate-current')).toContainText('350,50 ₽');
  await expect(page.getByTestId('rate-row')).toHaveCount(2);
  await expect(page.getByTestId('rate-missing')).toHaveCount(0);

  await page.getByRole('button', { name: 'Новая ставка' }).click();
  const form = page.getByTestId('rate-form');
  await form.getByLabel('Стоимость часа, ₽').fill('410,05');
  await form.getByLabel('Ставка за выход, ₽').fill('600');
  await form.getByRole('button', { name: 'Сохранить ставку' }).click();
  await expect(form.getByRole('alert')).toContainText('Укажите причину');
  await form.getByLabel('Причина *').fill('Индексация');
  await form.getByRole('button', { name: 'Сохранить ставку' }).click();
  await expect(page.getByTestId('rate-notice')).toContainText('сохранена');
  await expect(page.getByTestId('rate-current')).toContainText('410,05 ₽');
  await expect(page.getByTestId('rate-row')).toHaveCount(3);
  const stored = (await (await page.request.get('/api/crm/v1/staff/s-admin/rates')).json()) as { items: Array<{ hourlyKop: number; attendanceFeeKop: number }> };
  expect(stored.items[0]).toMatchObject({ hourlyKop: 41005, attendanceFeeKop: 60000 }); // ровно копейки

  await page.getByTestId('rate-row').first().getByRole('button', { name: 'Исправить' }).click();
  await expect(form.getByLabel('Действует с')).toBeDisabled();
  await form.getByLabel('Стоимость часа, ₽').fill('410,10');
  await form.getByLabel('Причина *').fill('Опечатка в сумме');
  await form.getByRole('button', { name: 'Сохранить ставку' }).click();
  await expect(page.getByTestId('rate-current')).toContainText('410,10 ₽');
  await expect(page.getByTestId('rate-row')).toHaveCount(4);
  await expect(page.getByTestId('rate-row').nth(1)).toContainText('заменена исправлением');
});

test('«Не настроена ставка» видна; ноль – это ставка', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, '/staff/s-two');
  await expect(page.getByTestId('rate-missing')).toContainText('Не настроена ставка оплаты');
  await page.getByRole('button', { name: 'Новая ставка' }).click();
  const form = page.getByTestId('rate-form');
  await form.getByLabel('Стоимость часа, ₽').fill('0');
  await form.getByLabel('Ставка за выход, ₽').fill('0');
  await form.getByLabel('Причина *').fill('Волонтёр');
  await form.getByRole('button', { name: 'Сохранить ставку' }).click();
  await expect(page.getByTestId('rate-missing')).toHaveCount(0);
  await expect(page.getByTestId('rate-current')).toContainText('0,00 ₽');
});

test('Директор: история без кнопки, сервер отказывает; чужой город – 404', async ({ page }) => {
  await login(page, 'director@yu.test');
  await open(page, '/staff/s-admin');
  await expect(page.getByTestId('rate-row').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Новая ставка' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Исправить' })).toHaveCount(0);
  const denied = await page.request.post('/api/crm/v1/staff/s-admin/rates', { data: { validFrom: '2026-01-01', hourlyKop: 1, attendanceFeeKop: 1, reason: 'x' }, headers: headers() });
  expect(denied.status()).toBe(403);
  expect((await page.goto('/staff/s-admin-tsk'))?.status()).toBe(404);
  expect((await page.request.get('/api/crm/v1/staff/s-admin-tsk/rates')).status()).toBe(404);
});

test('Администратор: карточки и ставок нет', async ({ page }) => {
  await login(page, 'admin@yu.test');
  expect((await page.goto('/staff/s-admin'))?.status()).toBe(404);
  expect((await page.request.get('/api/crm/v1/staff/s-fresh/rates')).status()).toBe(403);
});

test('«Временно не работает»: смены не отменены, статус переживает перезагрузку', async ({ page }) => {
  await login(page, 'director@yu.test');
  await open(page, '/staff/s-fresh');
  await expect(page.getByTestId('planning-status')).toContainText('Доступен');
  await expect(page.getByTestId('work-dates')).toContainText('с 01.01.2026');
  await page.getByRole('button', { name: 'Временно не работает' }).click();
  await page.getByRole('button', { name: 'Подтвердить' }).click();
  await expect(page.getByTestId('planning-status')).toContainText('Временно не работает');
  await expect(page.getByTestId('planning-pending').getByRole('link')).toHaveCount(1);
  await open(page, '/staff/s-fresh');
  await expect(page.getByTestId('planning-status')).toContainText('Временно не работает');
  await page.getByRole('button', { name: 'Вернуть в планирование' }).click();
  await page.getByRole('button', { name: 'Подтвердить' }).click();
  await expect(page.getByTestId('planning-status')).toContainText('Доступен');
});

for (const [w, h] of [[1440, 900], [390, 844]] as const) {
  test(`снимок карточки ${w} px без горизонтальной прокрутки`, async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: w === 390 ? 2 : 1 });
    const page = await ctx.newPage();
    await login(page, 'owner@yu.test');
    await open(page, '/staff/s-admin');
    await page.screenshot({ path: `${SHOTS}/s3-70-staff-rates-${w}.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(w);
    await ctx.close();
  });
}

// «Моё расписание» (S3-72) на моке: свои смены, TC-15 в интерфейсе (Администратор двух филиалов планирует в обоих, пересечение через филиалы – отказ), снять будущую,
// срок 24 часа, двойной клик «Пришёл» – одна отметка, уход, баннер чужой правки с «ознакомлен», без сумм. 1440 и 390 px.
import { expect, test, type Page } from '@playwright/test';
import { MOCK_PASSWORD } from './mock-api.ts';

const MOCK = process.env.MOCK_URL ?? 'http://127.0.0.1:4012';
const SHOTS = process.env.SCREENSHOT_DIR ?? 'test-results/screens';
const dayOf = (n: number) => new Date(Date.now() + n * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Novosibirsk' });

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
async function plan(page: Page, branch: string, date: string, start = '10:00', end = '14:00') {
  await page.getByRole('button', { name: 'Запланировать смену' }).click();
  const form = page.getByTestId('my-form');
  await form.getByLabel('Филиал').selectOption(branch);
  await form.getByLabel('Дата').fill(date);
  await form.getByLabel('Начало').fill(start);
  await form.getByLabel('Конец').fill(end);
  await form.getByRole('button', { name: 'Запланировать' }).click();
}

test('TC-15: Администратор двух филиалов планирует в обоих, пересечение через филиалы не проходит', async ({ page }) => {
  await login(page, 'two@yu.test');
  await open(page, '/shifts/my');
  await expect(page.getByRole('navigation', { name: 'Разделы' }).getByRole('link', { name: 'Моё расписание' })).toBeVisible();
  await plan(page, 'b-nsk-krasny', dayOf(5));
  await expect(page.getByTestId('my-notice')).toContainText('запланирована');
  await plan(page, 'b-tsk-lenina', dayOf(6));
  await expect(page.getByTestId('my-shift').filter({ hasText: 'на Красном' })).toHaveCount(2); // sh-rateless в прошлом + новая
  await expect(page.getByTestId('my-shift').filter({ hasText: 'на Ленина' })).toHaveCount(1);

  await plan(page, 'b-tsk-lenina', dayOf(5), '12:00', '16:00');
  await expect(page.getByTestId('my-form-error')).toContainText('Конфликт времени');
  await expect(page.getByTestId('my-form')).toBeVisible();
  await page.getByTestId('my-form').getByRole('button', { name: 'Отмена' }).click();
  await expect(page.getByTestId('my-shift').filter({ hasText: 'на Ленина' })).toHaveCount(1);
});

test('чужой филиал и срок 24 часа – понятные отказы', async ({ page }) => {
  await login(page, 'admin@yu.test');
  await open(page, '/shifts/my');
  await expect(page.getByLabel('Филиал').locator('option')).toHaveCount(1);
  const foreign = await page.request.post('/api/crm/v1/shifts', {
    data: { staffId: 's-admin', branchId: 'b-tsk-lenina', start: new Date(Date.now() + 5 * 86_400_000).toISOString(), end: new Date(Date.now() + 5 * 86_400_000 + 3_600_000).toISOString() },
    headers: { 'idempotency-key': crypto.randomUUID() },
  });
  expect(foreign.status()).toBe(404);
  await plan(page, 'b-nsk-krasny', dayOf(0), '21:00', '22:00'); // ближе 24 часов или в прошлом
  await expect(page.getByTestId('my-form-error')).not.toBeEmpty();
  await page.getByTestId('my-form').getByRole('button', { name: 'Отмена' }).click();
});

test('баннер чужой правки: виден, «ознакомлен» убирает и не возвращается', async ({ page }) => {
  await login(page, 'admin@yu.test');
  await open(page, '/shifts/my');
  await expect(page.getByTestId('my-change')).toHaveCount(1);
  await expect(page.getByTestId('my-change')).toContainText('Перенос по графику');
  await page.getByTestId('my-change').getByRole('button', { name: 'Ознакомлен' }).click();
  await expect(page.getByTestId('my-changes')).toHaveCount(0);
  await open(page, '/shifts/my');
  await expect(page.getByTestId('my-schedule')).toBeVisible();
  await expect(page.getByTestId('my-changes')).toHaveCount(0);
});

test('двойной клик «Пришёл» – одна отметка; затем «Ушёл» – смена отработана; сумм на экране нет', async ({ page }) => {
  await login(page, 'admin@yu.test');
  await open(page, '/shifts/my');
  const row = page.locator('[data-shift="sh-now"]');
  await row.getByRole('button', { name: 'Пришёл' }).dblclick();
  await expect(page.getByTestId('my-notice')).toContainText('Приход отмечен');
  await expect(row.getByRole('button', { name: 'Ушёл' })).toBeVisible();
  const tl = (await (await page.request.get('/api/crm/v1/shifts/sh-now/timeline')).json()) as { items: Array<{ action: string }> };
  expect(tl.items.filter((x) => x.action === 'shift.attendance_set')).toHaveLength(1);
  // второй запрос с другим ключом сервер тоже не задваивает
  await page.request.post('/api/crm/v1/shifts/sh-now/check-in', { headers: { 'idempotency-key': crypto.randomUUID() }, data: {} });
  const tl2 = (await (await page.request.get('/api/crm/v1/shifts/sh-now/timeline')).json()) as { items: Array<{ action: string }> };
  expect(tl2.items.filter((x) => x.action === 'shift.attendance_set')).toHaveLength(1);
  await row.getByRole('button', { name: 'Ушёл' }).click();
  await expect(row).toContainText('Отработана');
  await expect(page.getByTestId('my-schedule')).not.toContainText('₽');
  const self = (await (await page.request.get('/api/crm/v1/shifts/sh-now')).json()) as { plannedAccrualKop: unknown; factAccrualKop: unknown };
  expect([self.plannedAccrualKop, self.factAccrualKop]).toEqual([null, null]); // Q-108: и свои суммы скрыты
});

test('снять будущую смену: окно внутри записи, причина обязательна, запись остаётся отменённой', async ({ page }) => {
  await login(page, 'admin@yu.test');
  await open(page, '/shifts/my');
  const row = page.locator('[data-shift="sh-future"]');
  await row.getByRole('button', { name: 'Снять смену' }).click();
  const dlg = page.getByRole('dialog');
  await expect(dlg.getByRole('button', { name: 'Снять смену' })).toBeDisabled();
  await dlg.getByLabel('Причина *').fill('Семейные обстоятельства');
  await dlg.getByRole('button', { name: 'Снять смену' }).click();
  await expect(row).toContainText('Отменена');
  await expect(row.getByRole('button', { name: 'Снять смену' })).toHaveCount(0);
});

for (const [w, h] of [[1440, 900], [390, 844]] as const) {
  test(`снимок «Моё расписание» ${w} px без горизонтальной прокрутки`, async ({ browser, request }) => {
    expect((await request.post(`${MOCK}/__test/reset`)).ok()).toBe(true);
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: w === 390 ? 2 : 1 });
    const page = await ctx.newPage();
    await login(page, 'admin@yu.test');
    await open(page, '/shifts/my');
    await expect(page.getByTestId('my-shift').first()).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/s3-72-my-schedule-${w}.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(w);
    await ctx.close();
  });
}

// «Зарплата» (S3-74) на моке: постоянная подпись, прогноз отдельно от факта, детализация = итог, фильтры, статусы, закрытие: список причин со ссылками на смены, закрытый период – только
// корректировки, новый период встык. Права: Директор – своя зона без закрытия, Администратору – 404/403. 1440 и 390 px.
import { expect, test, type Page } from '@playwright/test';
import { MOCK_PASSWORD } from './mock-api.ts';

const MOCK = process.env.MOCK_URL ?? 'http://127.0.0.1:4012';
const SHOTS = process.env.SCREENSHOT_DIR ?? 'test-results/screens';
const key = () => ({ 'idempotency-key': crypto.randomUUID() });

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
const row = (page: Page, id: string) => page.locator(`[data-testid="payroll-row"][data-staff="${id}"]`);
const kop = (s: string | null) => Number((s ?? '').replace(/[^\d,−-]/g, '').replace(',', '').replace('−', '-'));

test('Владелец: подпись, прогноз отдельно от факта, детализация сходится с итогом', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, '/payroll');
  await expect(page.getByRole('navigation', { name: 'Разделы' }).getByRole('link', { name: 'Зарплата' })).toBeVisible();
  await expect(page.getByTestId('payroll-note')).toContainText('Управленческий расчёт, не бухгалтерия');
  await expect(page.getByTestId('total-forecast')).toContainText('в журнал не пишется');
  await expect(page.getByTestId('total-issues')).toContainText('смен без решения');
  await expect(page.getByTestId('total-penalties')).toHaveCount(0); // флаг штрафов выключен

  const r = row(page, 's-admin');
  await expect(r.getByTestId('row-accrued')).toContainText('3 304,00 ₽'); // 480 мин × 350,50 ₽/ч + 500 ₽ за выход, вчера
  await r.getByRole('button', { name: 'Детализация' }).click();
  const d = page.getByTestId('payroll-detail');
  const accrued = kop(await r.getByTestId('row-accrued').textContent());
  await expect(d.getByTestId('detail-entry')).toHaveCount(1);
  expect(kop(await d.getByTestId('detail-entry').locator('strong').textContent())).toBe(accrued); // детализация = итог
  await expect(d.getByTestId('detail-shift').filter({ hasText: 'Отработана' })).toHaveCount(1);
  await expect(d.getByTestId('detail-shift').filter({ hasText: 'Запланирована' }).first()).toContainText('прогноз');
  await expect(d.getByTestId('no-statement')).toContainText('Рассчитать');
});

test('фильтры: филиал и сотрудник сужают строки; статус ведомости', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, '/payroll');
  await expect(row(page, 's-admin-tsk')).toBeVisible();
  await page.getByLabel('Филиал').selectOption('b-nsk-krasny');
  await expect(row(page, 's-admin-tsk')).toHaveCount(0);
  await page.getByLabel('Филиал').selectOption('');
  await page.getByLabel('Сотрудник').selectOption('s-fresh');
  await expect(page.getByTestId('payroll-row')).toHaveCount(1);
  await page.getByLabel('Сотрудник').selectOption('');
  await page.getByLabel('Статус ведомости').selectOption('paid');
  await expect(page.getByTestId('payroll-empty')).toBeVisible();
});

test('закрытие: список причин со ссылками на смены, период остаётся открытым', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, '/payroll');
  await page.getByRole('button', { name: 'Закрыть период' }).click();
  await page.getByTestId('close-form').getByRole('button', { name: 'Закрыть период' }).click();
  const list = page.getByTestId('close-unresolved');
  await expect(list).toContainText('Период не закрыт');
  const fresh = page.getByTestId('unresolved-item').filter({ hasText: 'требует проверки' });
  await expect(fresh).toContainText('Фёдор Новиков');
  await expect(fresh.getByRole('link')).toHaveAttribute('href', '/shifts/sh-review');
  await expect(page.getByTestId('unresolved-item').filter({ hasText: 'не настроена ставка' }).getByRole('link')).toHaveAttribute('href', '/shifts/sh-rateless');
  await expect(page.getByTestId('unresolved-item').filter({ hasText: 'не подтверждён факт' }).first()).toBeVisible();
  await expect(page.getByTestId('period-status')).toContainText('Период открыт');
  await fresh.getByRole('link').click();
  await expect(page).toHaveURL(/\/shifts\/sh-review$/);
});

test('новый период встык закрывается; разрыв – понятный отказ', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, '/payroll');
  await page.getByRole('button', { name: 'Новый период' }).click();
  const form = page.getByTestId('new-period-form');
  const from = await form.getByLabel('С').inputValue();
  const gap = new Date(Date.parse(`${from}T12:00:00Z`) + 5 * 86_400_000).toISOString().slice(0, 10);
  const end = new Date(Date.parse(`${from}T12:00:00Z`) + 40 * 86_400_000).toISOString().slice(0, 10);
  await form.getByLabel('По').fill(end);
  await form.getByLabel('С').fill(gap);
  await form.getByRole('button', { name: 'Создать период' }).click();
  await expect(page.getByTestId('new-period-error')).toContainText('без разрывов');
  await form.getByLabel('С').fill(from);
  await form.getByRole('button', { name: 'Создать период' }).click();
  await expect(form).toBeHidden();
  await expect(page.getByTestId('payroll-empty')).toBeVisible();
  await page.getByRole('button', { name: 'Закрыть период' }).click();
  await page.getByTestId('close-form').getByRole('button', { name: 'Закрыть период' }).click();
  await expect(page.getByTestId('pay-notice')).toContainText('только корректировки');
  await expect(page.getByTestId('period-status')).toContainText('Период закрыт');
  await expect(page.getByRole('button', { name: 'Закрыть период' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Рассчитать ведомости' })).toHaveCount(0);
});

test('Директор: своя зона, ведомость проверяет, закрыть и создать период не может; чужое – 404', async ({ page }) => {
  await login(page, 'director@yu.test');
  await open(page, '/payroll');
  await expect(row(page, 's-admin')).toBeVisible();
  await expect(row(page, 's-admin-tsk')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Закрыть период' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Новый период' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Рассчитать ведомости' }).click();
  await expect(page.getByTestId('pay-notice')).toContainText('пересчитаны');
  await row(page, 's-admin').getByRole('button', { name: 'Детализация' }).click();
  await page.getByTestId('statement').getByRole('button', { name: 'Проверено' }).click();
  await expect(page.getByTestId('statement-status')).toContainText('Проверена');
  await expect(page.getByTestId('statement').getByRole('button', { name: 'Готова к выплате' })).toHaveCount(0);
  await expect(page.getByTestId('statement')).toContainText('после закрытия периода');
  expect((await page.request.get('/api/crm/v1/payroll/report?periodId=p-closed&branchIds=b-tsk-lenina')).status()).toBe(404);
  expect((await page.request.get('/api/crm/v1/payroll/statements/st-tsk')).status()).toBe(404);
  expect((await page.request.post('/api/crm/v1/payroll/periods/p-open/close', { data: {}, headers: key() })).status()).toBe(403);
});

test('Администратор: зарплаты нет – пункта меню нет, страница 404, API 403', async ({ page }) => {
  await login(page, 'admin@yu.test');
  await open(page, '/shifts/my');
  await expect(page.getByRole('navigation', { name: 'Разделы' }).getByRole('link', { name: 'Зарплата' })).toHaveCount(0);
  expect((await page.goto('/payroll'))?.status()).toBe(404);
  expect((await page.request.get('/api/crm/v1/payroll/periods')).status()).toBe(403);
  expect((await page.request.get('/api/crm/v1/payroll/report?periodId=p-open')).status()).toBe(403);
});

for (const [w, h] of [[1440, 900], [390, 844]] as const) {
  test(`снимок зарплаты ${w} px без горизонтальной прокрутки, кнопки ≥ 44 px`, async ({ browser, request }) => {
    expect((await request.post(`${MOCK}/__test/reset`)).ok()).toBe(true);
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: w === 390 ? 2 : 1 });
    const page = await ctx.newPage();
    await login(page, 'owner@yu.test');
    await open(page, '/payroll');
    await row(page, 's-admin').getByRole('button', { name: 'Детализация' }).click();
    await expect(page.getByTestId('payroll-detail')).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/s3-74-payroll-${w}.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(w);
    if (w === 390) {
      for (const b of await page.locator('[data-testid="payroll-bar"] button, [data-testid="payroll-table"] button').all()) {
        if (await b.isVisible()) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      }
    }
    await ctx.close();
  });
}

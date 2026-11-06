// «Расписание сотрудников» (S3-71) на моке mock-shifts-staff.ts: день/неделя/месяц, по филиалу и по сотруднику, пустые интервалы при частично закрытом дне,
// время по зоне филиала (браузер в другой зоне), конфликт подсвечен и не сохранён, сотрудник не назначен, права и зоны. 1440 и 390 px.
import { expect, test, type Page } from '@playwright/test';
import { MOCK_PASSWORD } from './mock-api.ts';

const MOCK = process.env.MOCK_URL ?? 'http://127.0.0.1:4012';
const SHOTS = process.env.SCREENSHOT_DIR ?? 'test-results/screens';
const dayOf = (n: number, tz = 'Asia/Novosibirsk') => new Date(Date.now() + n * 86_400_000).toLocaleDateString('en-CA', { timeZone: tz });

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
const day = (page: Page, date: string) => page.locator(`[data-testid="shift-day"][data-date="${date}"]`);
async function gotoDay(page: Page, date: string) {
  await page.getByRole('group', { name: 'Масштаб' }).getByRole('button', { name: 'Месяц' }).click();
  if (date.slice(0, 7) !== dayOf(0).slice(0, 7)) await page.getByRole('button', { name: 'Позже' }).click();
  await page.locator(`[data-testid="month-tile"][data-date="${date}"]`).click();
}

test('Директор: день с дырами видит пустые интервалы; браузер в другой зоне – время всё равно по филиалу', async ({ browser }) => {
  const ctx = await browser.newContext({ timezoneId: 'Europe/London' });
  const page = await ctx.newPage();
  await login(page, 'director@yu.test');
  await open(page, '/shifts');
  await expect(page.getByRole('navigation', { name: 'Разделы' }).getByRole('link', { name: 'Расписание сотрудников' })).toBeVisible();
  await gotoDay(page, dayOf(1));
  const d = day(page, dayOf(1));
  await expect(d.getByTestId('shift-item')).toHaveCount(1);
  await expect(d.getByTestId('shift-item')).toContainText('14:00–18:00');
  await expect(d.getByTestId('coverage-state')).toContainText('пустые интервалы');
  await expect(d.getByTestId('coverage-gap')).toHaveCount(2);
  await expect(d.getByTestId('coverage-gap').first()).toContainText('10:00–14:00');
  await expect(d.getByTestId('coverage-gap').nth(1)).toContainText('18:00–22:00');
  await ctx.close();
});

test('масштабы и фильтр: неделя 7 дней, месяц плитками, статус сужает, по сотруднику – его смены', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, '/shifts');
  await expect(page.getByTestId('shift-day')).toHaveCount(7);
  await page.getByRole('group', { name: 'Масштаб' }).getByRole('button', { name: 'Месяц' }).click();
  await expect.poll(() => page.getByTestId('month-tile').count()).toBeGreaterThanOrEqual(28);
  await page.getByRole('group', { name: 'Масштаб' }).getByRole('button', { name: 'Неделя' }).click();
  await page.getByLabel('Статус').selectOption('cancelled');
  await expect(page.getByTestId('shift-item')).toHaveCount(0);
  await page.getByLabel('Статус').selectOption('');
  await page.getByRole('button', { name: 'По сотруднику' }).click();
  await page.getByLabel('Сотрудник', { exact: true }).first().selectOption('s-admin-tsk');
  await gotoDay(page, dayOf(1));
  await expect(day(page, dayOf(1)).getByTestId('shift-item')).toContainText('Ю Клуб на Ленина');
});

test('создание с пустого интервала; конфликт подсвечен и не сохраняется', async ({ page }) => {
  await login(page, 'director@yu.test');
  await open(page, '/shifts');
  await gotoDay(page, dayOf(1));
  const d = day(page, dayOf(1));
  await d.getByTestId('coverage-gap').first().getByRole('button', { name: 'Поставить смену' }).click();
  const form = page.getByTestId('shift-form');
  await expect(form.getByLabel('Начало')).toHaveValue('10:00');
  await expect(form.getByLabel('Конец')).toHaveValue('14:00');
  await form.getByLabel('Сотрудник').selectOption('s-fresh');
  await form.getByLabel('Конец').fill('15:00'); // сотрудник уже работает 14:00–18:00
  await form.getByRole('button', { name: 'Сохранить смену' }).click();
  await expect(page.getByTestId('shift-form-error')).toContainText('Конфликт времени');
  await expect(form).toBeVisible();
  await expect(page.locator('[data-shift="sh-fresh-next"]')).toHaveClass(/yc-sh-item--conflict/);
  await expect(d.getByTestId('shift-item')).toHaveCount(1);

  await form.getByLabel('Конец').fill('14:00'); // стык 14:00/14:00 – не конфликт
  await form.getByRole('button', { name: 'Сохранить смену' }).click();
  await expect(form).toBeHidden();
  await expect(d.getByTestId('shift-item')).toHaveCount(2);
  await expect(d.getByTestId('coverage-gap')).toHaveCount(1);
});

test('не назначен на филиал: понятный отказ, смена не создана', async ({ page }) => {
  await login(page, 'director@yu.test');
  await open(page, '/shifts');
  await page.getByRole('button', { name: 'Новая смена' }).click();
  const form = page.getByTestId('shift-form');
  await form.getByLabel('Сотрудник').selectOption('s-admin');
  await form.getByLabel('Филиал').selectOption('b-nsk-akadem');
  await form.getByLabel('Дата').fill(dayOf(5));
  await form.getByRole('button', { name: 'Сохранить смену' }).click();
  await expect(page.getByTestId('shift-form-error')).toContainText('не назначен на этот филиал');
});

test('Администратор: расписание видит, создавать чужие не может, чужого филиала нет', async ({ page }) => {
  await login(page, 'admin@yu.test');
  await open(page, '/shifts');
  await expect(page.getByTestId('shift-calendar')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Новая смена' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'По сотруднику' })).toHaveCount(0);
  await gotoDay(page, dayOf(1));
  await expect(day(page, dayOf(1)).getByTestId('shift-item').first()).toContainText('Коллега');
  const list = (await (await page.request.get(`/api/crm/v1/shifts?branchIds=b-nsk-krasny&from=${dayOf(-1)}&to=${dayOf(1)}`)).json()) as { items: Array<{ plannedAccrualKop: unknown; factAccrualKop: unknown }> };
  expect(list.items.length).toBeGreaterThan(0);
  for (const x of list.items) expect([x.plannedAccrualKop, x.factAccrualKop]).toEqual([null, null]); // суммы не уходят даже в ответе
  expect((await page.request.get(`/api/crm/v1/shifts?branchIds=b-tsk-lenina&from=${dayOf(0)}&to=${dayOf(1)}`)).status()).toBe(404);
  const denied = await page.request.post('/api/crm/v1/shifts', { data: { staffId: 's-fresh', branchId: 'b-nsk-krasny', start: new Date().toISOString(), end: new Date().toISOString() }, headers: { 'idempotency-key': crypto.randomUUID() } });
  expect(denied.status()).toBe(403);
});

for (const [w, h] of [[1440, 900], [390, 844]] as const) {
  test(`снимки расписания ${w} px без горизонтальной прокрутки, кнопки ≥ 44 px`, async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: w === 390 ? 2 : 1 });
    const page = await ctx.newPage();
    await login(page, 'director@yu.test');
    await open(page, '/shifts');
    await expect(page.getByTestId('shift-day').first()).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/s3-71-shifts-week-${w}.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(w);
    await page.getByRole('group', { name: 'Масштаб' }).getByRole('button', { name: 'Месяц' }).click();
    await expect(page.getByTestId('month-tile').first()).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/s3-71-shifts-month-${w}.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(w);
    if (w === 390) {
      for (const b of await page.locator('[data-testid="shift-calendar"] button').all()) {
        if (!(await b.isVisible())) continue;
        expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      }
    }
    await ctx.close();
  });
}

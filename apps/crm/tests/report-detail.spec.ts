// S4-91: детализация показателя – итог = число карточки, переход в карточку брони и в кассу операции, недоступное – словами,
// на 390 px таблица прокручивается только внутри своего блока; S4-91 (графики) – точные значения по наведению и касанию, подпись цвета текстом.
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
const P = 'from=2026-11-01&to=2026-11-10';
const detail = (page: Page) => page.getByTestId('detail');

test('итог детализации = число карточки, номер брони ведёт в карточку брони', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, `/reports/bookings?${P}`);
  const value = (await page.getByTestId('card-visited').getByTestId('value').textContent())!.trim();
  await page.getByTestId('card-visited').click();
  await expect(page).toHaveURL(/metric=visited/);
  await expect(detail(page).getByTestId('detail-total')).toContainText(`Итог: ${value} – совпадает с карточкой`);
  await expect(detail(page).getByTestId('detail-table').locator('tbody tr')).toHaveCount(Number(value));
  const first = detail(page).getByTestId('detail-table').locator('tbody tr').first();
  await expect(first.getByRole('link', { name: /^№ \d+$/ })).toHaveAttribute('href', /^\/bookings\/b0000000-/);
  await expect(first.getByRole('link').nth(1)).toHaveAttribute('href', /^\/clients\//);
  await page.getByTestId('card-visited').click();
  await expect(detail(page)).toHaveCount(0);
});

test('операция кассы ведёт в кассу филиала; адрес с metric открывает записи сразу', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, `/reports/finance?${P}&metric=refunds`);
  const value = (await page.getByTestId('card-refunds').getByTestId('value').textContent())!.trim();
  await expect(detail(page).getByTestId('detail-total')).toContainText(`Итог: ${value} – совпадает с карточкой`);
  await expect(detail(page).getByTestId('detail-table').locator('tbody tr').first().getByRole('link').first()).toHaveAttribute('href', /^\/finance\/b-/);
  await expect(detail(page).getByTestId('detail-table')).toContainText('Возврат');
});

test('деньги сотрудников без права: причина словами, строк нет', async ({ page }) => {
  await login(page, 'director@yu.test');
  await open(page, `/reports/staff?${P}&metric=paid`);
  await expect(detail(page).getByTestId('detail-total')).toContainText('Итог: Нет права на эти данные');
  await expect(detail(page).getByTestId('detail-table')).toHaveCount(0);
});

test('390 px: таблица записей прокручивается внутри блока, страница – нет', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await page.setViewportSize({ width: 390, height: 900 });
  await open(page, `/reports/bookings?${P}&metric=created`);
  await expect(detail(page).getByTestId('detail-table')).toBeVisible();
  const box = detail(page).getByTestId('detail-scroll');
  expect(await box.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  if (process.env.CRM_SHOTS) await page.screenshot({ path: `${process.env.CRM_SHOTS}/report-detail-390.png`, fullPage: true });
});

test('график загрузки: точные значения по наведению, фокусу и касанию, цвет подписан, сегмент открывает записи дня', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, `/reports/utilization?${P}`);
  const chart = page.getByTestId('chart');
  await expect(chart.getByTestId('legend').locator('li')).toHaveText(['Голубой – забронировано', 'Синий – использовано']);
  await expect(chart.locator('g[role=button]')).toHaveCount(10);
  await chart.getByTestId('bar-2026-11-05').hover();
  const tip = chart.getByTestId('chart-tip');
  await expect(tip).toContainText('05.11.2026');
  await expect(tip).toContainText(/Синий – использовано: \d/);
  await chart.getByTestId('bar-2026-11-03').focus();
  await expect(tip).toContainText('03.11.2026');
  await chart.getByTestId('bar-2026-11-04').dispatchEvent('click'); // касание: сначала значения, переход – кнопкой
  await expect(tip).toContainText('04.11.2026');
  await expect(detail(page)).toHaveCount(0);
  const used = (await tip.locator('span > span', { hasText: 'Синий – использовано' }).textContent())!.split(': ')[1]!.trim();
  await tip.getByRole('button', { name: 'Единицы за этот день' }).click();
  await expect(detail(page)).toContainText('Использовано: записи – 04.11.2026');
  await expect(detail(page).getByTestId('detail-total')).toContainText(`Итог: ${used}`);
  await chart.locator('summary').click();
  await expect(chart.getByTestId('chart-table').locator('tbody tr')).toHaveCount(10);
  if (process.env.CRM_SHOTS) await page.screenshot({ path: `${process.env.CRM_SHOTS}/report-chart-1440.png`, fullPage: true });
});

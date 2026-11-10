// D5-10 на экране: API занят отчётами – 503 REPORT_BUSY с Retry-After. Экран пишет «Сейчас считается много отчётов – повторим через N с»,
// ждёт Retry-After и повторяет запрос один раз; второй отказ – ошибка с кнопкой «Повторить», без бесконечных повторов.
// 503 отдаёт маршрут поверх мока (флаг busy – сколько первых ответов «заняты»): mock-reports.ts уже на пределе 800 строк.
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
/** Флаг мока: после busyReports(...).busy = N первые N ответов на url – 503 REPORT_BUSY с Retry-After 1, дальше – настоящий мок.
 *  Флаг ставится после загрузки экрана: при открытии экран шлёт запрос дважды (первый отменяется), и 503 достался бы отменённому. */
async function busyReports(page: Page, url: string): Promise<{ busy: number; calls: number }> {
  const seen = { busy: 0, calls: 0 };
  await page.route(url, async (route) => {
    if (seen.busy === 0 && seen.calls === 0) return route.continue().catch(() => {});
    seen.calls += 1;
    if (seen.calls <= seen.busy) {
      await route.fulfill({
        status: 503,
        headers: { 'content-type': 'application/json', 'retry-after': '1' },
        body: JSON.stringify({ error: { code: 'REPORT_BUSY', message: 'Отчёты заняты – повторите через несколько секунд', details: { retryAfterSec: 1 }, requestId: 'r' } }),
      });
      return;
    }
    await route.continue().catch(() => {});
  });
  return seen;
}
const P = 'from=2026-11-01&to=2026-11-10';

async function readyThenBusy(page: Page, busy: number): Promise<{ busy: number; calls: number }> {
  await login(page, 'owner@yu.test');
  const seen = await busyReports(page, '**/api/crm/v1/reports/bookings?*');
  await open(page, `/reports/bookings?${P}`);
  await expect(page.getByTestId('report')).toHaveAttribute('data-state', 'ready');
  seen.busy = busy;
  await page.getByRole('button', { name: 'Обновить' }).click();
  return seen;
}

test('отчёт: 503 REPORT_BUSY – фраза с секундами, один автоповтор по Retry-After, затем данные', async ({ page }) => {
  const seen = await readyThenBusy(page, 1);
  await expect(page.getByTestId('report-loading')).toHaveText('Сейчас считается много отчётов – повторим через 1 с.');
  await expect(page.getByTestId('report')).toHaveAttribute('data-state', 'ready');
  await expect(page.getByTestId('card-visited').getByTestId('value')).toHaveText(/^\d+$/);
  expect(seen.calls).toBe(2);
});

test('отчёт: повтор тоже 503 – ошибка с секундами и кнопкой, больше сам не повторяет; «Повторить» – данные', async ({ page }) => {
  const seen = await readyThenBusy(page, 2);
  await expect(page.getByTestId('report-error')).toContainText('Сейчас считается много отчётов – повторите через 1 с.');
  await page.waitForTimeout(1500);
  expect(seen.calls).toBe(2); // один автоповтор, не цикл
  await page.getByTestId('report-error').getByRole('button', { name: 'Повторить' }).click();
  await expect(page.getByTestId('report')).toHaveAttribute('data-state', 'ready');
  expect(seen.calls).toBe(3);
});

test('рабочий стол: 503 REPORT_BUSY – та же фраза и один автоповтор, затем карточки', async ({ page }) => {
  await login(page, 'owner@yu.test');
  const seen = await busyReports(page, '**/api/crm/v1/reports/dashboard?*');
  await open(page, '/');
  const desk = page.getByTestId('dashboard');
  await expect(desk.getByTestId('desk-card-created')).toBeVisible();
  seen.busy = 1;
  await desk.getByRole('button', { name: 'Этот месяц' }).click();
  await expect(desk.getByRole('status')).toHaveText('Сейчас считается много отчётов – повторим через 1 с.');
  await expect(desk.getByTestId('desk-card-created')).toBeVisible();
  expect(seen.calls).toBe(2);
});

// S4-94: рабочие столы Владельца и Директора на главной CRM (13 §6.2–6.4) – каждая карточка открывает отчёт с тем же периодом и
// областью; деньги, возвраты, расходы, движение и остаток – раздельно; у Владельца – предупреждение о расхождениях ночной сверки.
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
const desk = (page: Page) => page.getByTestId('dashboard');

test('Владелец: карточки по группам, деньги раздельно, предупреждения, карточка ведёт в отчёт с тем же фильтром', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, '/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Филиалы сети');
  await expect(desk(page)).toContainText('09.11.2026 – 15.11.2026'); // неделя по умолчанию, «сейчас» e2e – среда 11.11
  for (const key of ['incomeSession', 'refunds', 'expenses', 'netMovement', 'cashClosing', 'eventsCount', 'emptyIntervals', 'unclosedShifts', 'openFaults', 'downtime', 'actualLoad']) {
    await expect(desk(page).getByTestId(`desk-card-${key}`)).toBeVisible();
  }
  await expect(desk(page)).not.toContainText(/прибыль/i);
  const warn = desk(page).getByTestId('desk-warnings');
  await expect(warn.getByRole('link', { name: 'Ночная сверка 11.11.2026 нашла расхождения: 3' })).toHaveAttribute('href', '/reports/reconcile');
  await expect(warn.getByRole('link', { name: /Брони ждут решения: \d+/ })).toBeVisible();

  const created = desk(page).getByTestId('desk-card-created');
  await expect(created).toHaveAttribute('href', '/reports/bookings?from=2026-11-09&to=2026-11-15&metric=created');
  const value = (await created.locator('.rp-card__value').textContent())!.trim();
  await created.click();
  await expect(page.getByTestId('card-created').getByTestId('value')).toHaveText(value);
  await expect(page.getByTestId('detail').getByTestId('detail-total')).toContainText(`Итог: ${value} – совпадает с карточкой`);

  await open(page, '/');
  await desk(page).getByRole('button', { name: 'Этот месяц' }).click();
  await expect(desk(page)).toContainText('01.11.2026 – 30.11.2026');
  await expect(desk(page).getByTestId('desk-card-downtime')).toHaveAttribute('href', '/reports/equipment?from=2026-11-01&to=2026-11-30&metric=downtimeMinutes');
});

test('Директор: стол своего города без предупреждений Владельца, ссылки несут город', async ({ page }) => {
  await login(page, 'director@yu.test');
  await open(page, '/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Филиалы: Новосибирск');
  await expect(desk(page).getByTestId('desk-card-visited')).toHaveAttribute('href', /cityId=c-nsk&metric=visited$/);
  await expect(desk(page).getByTestId('desk-card-expenses')).toBeVisible();
  await expect(desk(page).getByTestId('desk-warnings')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 900 });
  await open(page, '/');
  await expect(desk(page).getByTestId('desk-card-visited')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  if (process.env.CRM_SHOTS) await page.screenshot({ path: `${process.env.CRM_SHOTS}/dashboard-390.png`, fullPage: true });
});

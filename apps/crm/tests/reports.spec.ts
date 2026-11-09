// S4-90: экран отчёта 14 §15 – список отчётов по правам, период и фильтры, карточки и таблица, время расчёта и правило суток.
// Смена филиала сбрасывает зависимые фильтры; быстрая смена фильтра не смешивает старые и новые данные; «–» при нулевой базе;
// недоступное – словами; тяжёлый отчёт с длинным периодом – по кнопке; чужой филиал – как несуществующий; 390 px без прокрутки.
import { expect, test, type Page } from '../../../tests/support/e2e.ts';
import { MOCK_PASSWORD } from './mock-api.ts';

const SHOTS = process.env.CRM_SHOTS;

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
const card = (page: Page, key: string) => page.getByTestId(`card-${key}`);
const noScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test('Владелец: список отчётов, карточки, таблица, время расчёта и правило суток', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, '/reports');
  await expect(page.getByTestId('report-list').getByRole('link')).toHaveCount(10);
  await page.getByRole('link', { name: /Бронирования и посещаемость/ }).click();
  await expect(page).toHaveURL(/\/reports\/bookings$/);
  await open(page, `/reports/bookings?${P}`);
  await expect(page.getByTestId('report')).toHaveAttribute('data-state', 'ready');
  await expect(card(page, 'visited').getByTestId('value')).toHaveText(/^\d+$/);
  await expect(card(page, 'avgMinutes')).toContainText('по дате сеанса');
  await expect(card(page, 'created')).toContainText('по дате создания');
  await expect(card(page, 'awaitingDecision')).toContainText('на момент запроса');
  await expect(page.getByTestId('computed-at')).toContainText('Рассчитано: ');
  await expect(page.getByTestId('report-meta')).toContainText('Сутки – по времени каждого филиала');
  await expect(page.getByTestId('report-meta')).toContainText('Сравнение: 22.10.2026 – 31.10.2026');
  await expect(page.getByTestId('metrics-table').locator('tbody tr')).toHaveCount(10);
  await expect(page.locator('main [name=resourceType]')).toBeVisible();
  await expect(page.locator('main [name=status]')).toBeVisible();
});

test('«–» при нулевой базе, недоступное – словами, а не нулём', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, `/reports/finance?${P}`);
  await expect(card(page, 'incomeEvent').getByTestId('value')).toHaveText('0,00 ₽');
  await expect(card(page, 'incomeEvent').getByTestId('delta')).toHaveText('к прошлому периоду: –');
  await open(page, `/reports/equipment?${P}`);
  await expect(card(page, 'avgRepairMinutes').getByTestId('value')).toHaveText('Не хватает данных для расчёта');

  await page.context().clearCookies();
  await login(page, 'director@yu.test');
  await open(page, `/reports/staff?${P}`);
  await expect(card(page, 'paid').getByTestId('value')).toHaveText('Нет права на эти данные');
  await expect(card(page, 'accrued').getByTestId('value')).toContainText('₽');
});

test('смена города сбрасывает филиал, смена филиала – зависимые фильтры', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, `/reports/bookings?${P}&cityId=c-nsk&branchIds=b-nsk-krasny&resourceType=vr`);
  await expect(page.locator('main [name=resourceType]')).toHaveValue('vr');
  await page.locator('main [name=branchId]').selectOption('b-nsk-akadem');
  await expect(page.locator('main [name=resourceType]')).toHaveValue('');
  await expect(page).toHaveURL(/branchIds=b-nsk-akadem/);
  await expect(page).not.toHaveURL(/resourceType/);
  await page.locator('main [name=cityId]').selectOption('c-tsk');
  await expect(page.locator('main [name=branchId]')).toHaveValue('');
  await expect(page.locator('main [name=branchId]').locator('option')).toHaveText(['Все филиалы', 'Ю Клуб на Ленина']);
  await expect(page.getByTestId('report-meta')).toContainText('Томск – весь город');
});

test('быстрая смена фильтра: ответ на прежний запрос не показывается', async ({ page }) => {
  await login(page, 'owner@yu.test');
  let first = true;
  await page.route('**/api/crm/v1/reports/bookings?*', async (route) => {
    if (first && route.request().url().includes('from=2026-11-01')) {
      first = false;
      await new Promise((r) => setTimeout(r, 1500));
    }
    await route.continue().catch(() => {}); // отменённый запрос браузер уже закрыл
  });
  await open(page, `/reports/bookings?${P}`);
  await page.getByLabel('С', { exact: true }).fill('2026-11-05');
  await expect(page.getByTestId('report')).toHaveAttribute('data-state', 'ready');
  await expect(page.getByTestId('report')).toHaveAttribute('data-period', '2026-11-05..2026-11-10');
  await page.waitForTimeout(1700);
  await expect(page.getByTestId('report')).toHaveAttribute('data-period', '2026-11-05..2026-11-10');
});

test('тяжёлый отчёт с длинным периодом – по кнопке; больше 92 дней – совет сформировать файл', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, '/reports/utilization?from=2026-09-01&to=2026-10-31');
  await expect(page.getByTestId('needs-run')).toBeVisible();
  await expect(page.getByTestId('cards')).toHaveCount(0);
  await page.getByRole('button', { name: 'Сформировать' }).click();
  await expect(card(page, 'actualLoad').getByTestId('value')).toContainText('%');
  await open(page, '/reports/bookings?from=2026-01-01&to=2026-11-10');
  await expect(page.getByTestId('report-error')).toContainText('Период длиннее 92 дней');
  await expect(page.getByTestId('report-error')).toContainText('Сформировать файл');
});

test('Администратор: только свои отчёты, чужой отчёт и чужой филиал – как несуществующие', async ({ page }) => {
  await login(page, 'admin@yu.test');
  await open(page, '/reports');
  await expect(page.getByTestId('report-list').getByRole('link')).toHaveText([/Бронирования/, /Загрузка ресурсов/, /Оборудование и ремонты/]);
  const r = await page.goto('/reports/finance');
  expect(r?.status()).toBe(404);
  await expect(page.getByTestId('not-found')).toBeVisible();
  await open(page, `/reports/bookings?${P}&branchIds=b-tsk-lenina`);
  await expect(page.getByTestId('report-error')).toContainText('нет в вашей зоне');
  await expect(page.getByTestId('cards')).toHaveCount(0);
});

test('1440 и 390 px без горизонтальной прокрутки', async ({ page }) => {
  await login(page, 'director@yu.test');
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await open(page, `/reports/bookings?${P}`);
    await expect(page.getByTestId('report')).toHaveAttribute('data-state', 'ready');
    expect(await noScroll(page)).toBe(true);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/reports-${width}.png`, fullPage: true });
  }
});

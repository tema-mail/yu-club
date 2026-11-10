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
  // K21 §9, K24 §4: ошибки критичных уведомлений – GET /notifications/failures/summary {critical, periodFrom, periodTo}; ведёт в журнал отправок с ошибкой за период
  await expect(warn.getByRole('link', { name: 'Критичные уведомления не дошли: 2 (10.11.2026 – 11.11.2026)' }))
    .toHaveAttribute('href', '/notifications?tab=rows&status=error&from=2026-11-10&to=2026-11-11');

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

// S4-94 (13 §6.1, K24 §4): рабочий стол Администратора – «/» в контексте филиала. Сегодня в филиале: брони и приходы, требуют решения,
// кассовая смена (остатка Администратору нет – 06 §14), открытые ремонты, блокировки, мероприятия дня, лента событий, быстрые действия.
// Данные – из существующих API (брони дня, смена, предпросмотр остатка, ремонты, календарь, мероприятия, лента).
test('Администратор: рабочий стол филиала на главной – брони, смена без остатка, ремонты, мероприятия дня, лента', async ({ page }) => {
  await login(page, 'admin@yu.test');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Ю Клуб на Красном: сегодня');
  const d = page.getByTestId('branch-desk');
  await expect(d.getByTestId('bd-bookings').getByRole('link', { name: /^№\d+ · / })).toHaveCount(2);
  await expect(d.getByTestId('bd-bookings')).toContainText('Требует решения');
  await expect(d.getByTestId('bd-cash')).toContainText('Кассовая смена в филиале не ведётся');
  await expect(d.getByTestId('bd-cash')).not.toContainText('₽');
  const repairs = d.getByTestId('bd-repairs');
  await expect(repairs.getByRole('link', { name: /^R-\d{6}/ })).toHaveCount(4);
  await expect(repairs).not.toContainText('R-000003'); // томский ремонт – чужой филиал
  await expect(repairs).not.toContainText('R-000004'); // закрытый
  await expect(d.getByTestId('bd-events').getByRole('link', { name: /День рождения Анны/ })).toHaveAttribute('href', /^\/events\//);
  const feed = d.getByTestId('bd-feed');
  await expect(feed.getByRole('link', { name: 'Новый ремонт № Р-12' })).toHaveAttribute('href', '/repairs/e7000000-0000-4000-8000-000000000001');
  await expect(feed).not.toContainText('Т-3');
  await expect(d.getByRole('link', { name: 'Создать бронь' })).toHaveAttribute('href', '/schedule');
  await expect(d.getByRole('link', { name: 'Зарегистрировать неисправность' })).toHaveAttribute('href', '/repairs/new');
  await expect(page.getByTestId('dashboard')).toHaveCount(0); // денег сети и отчётных карточек Администратору нет
  await page.setViewportSize({ width: 390, height: 900 });
  await open(page, '/');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  if (process.env.CRM_SHOTS) await page.screenshot({ path: `${process.env.CRM_SHOTS}/branch-desk-390.png`, fullPage: true });
});

test('Владелец в контексте филиала: тот же стол с остатками кассы; карточка филиала – по ссылке', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await page.getByLabel('Контекст').selectOption({ label: 'Ю Клуб на Красном' });
  await expect(page).toHaveURL(/\/branches\/b-nsk-krasny$/);
  await open(page, '/');
  const cash = page.getByTestId('branch-desk').getByTestId('bd-cash');
  await expect(cash).toContainText(/Наличные сейчас: [\d\s]+,\d{2} ₽/);
  await expect(cash).toContainText(/Безнал сейчас: [\d\s]+,\d{2} ₽/);
  await expect(page.getByTestId('branch-desk').getByRole('link', { name: 'Карточка филиала' })).toHaveAttribute('href', '/branches/b-nsk-krasny');
});

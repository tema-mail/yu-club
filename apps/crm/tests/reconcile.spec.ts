// S4-96: экран ночной сверки – только Владелец и Директор; расхождение ведёт в объект; Директор видит только свою зону,
// без сетевых объектов, числа по сети и текста сбоя (K11 №248).
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
const RUN = 'run-9e000000-0000-4000-8000-000000000003';

test('Владелец: запуски с итогом словами, расхождения со ссылками на объект, сбой виден', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, '/reports');
  await page.getByRole('link', { name: 'Ночная сверка' }).click();
  await expect(page).toHaveURL(/\/reports\/reconcile$/);
  await expect(page.locator('[data-testid^=run-]').getByTestId('run-status')).toHaveText(['Есть расхождения', 'Расхождений нет', 'Не завершилась']);
  const run = page.getByTestId(RUN);
  await expect(run).toContainText('Ночь на 11.11.2026');
  await expect(run).toContainText('расхождений по сети: 3');
  const rows = run.getByTestId('discrepancies').locator('tbody tr');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('Остаток места денег');
  await expect(rows.nth(0)).toContainText('Ю Клуб на Красном');
  await expect(rows.nth(0)).toContainText('12 500,00 ₽');
  await expect(rows.nth(0).getByRole('link', { name: 'Открыть' })).toHaveAttribute('href', '/finance/b-nsk-krasny');
  await expect(rows.nth(2)).toContainText('Вся сеть');
  await expect(rows.nth(2).getByRole('link', { name: 'Открыть' })).toHaveAttribute('href', '/clients/c0000000-0000-4000-8000-000000000001');
  await expect(page.getByTestId('run-9e000000-0000-4000-8000-000000000001')).toContainText('Сбой: connection terminated');
});

test('Директор: только расхождения своей зоны, без числа по сети и текста сбоя; Администратору экрана нет', async ({ page }) => {
  await login(page, 'director@yu.test');
  await open(page, '/reports/reconcile');
  const run = page.getByTestId(RUN);
  await expect(run.getByTestId('discrepancies').locator('tbody tr')).toHaveCount(1);
  await expect(run).not.toContainText('расхождений по сети');
  await expect(page.getByTestId('reconcile')).not.toContainText('Сбой');

  await page.context().clearCookies();
  await login(page, 'admin@yu.test');
  await open(page, '/reports');
  await expect(page.getByRole('link', { name: 'Ночная сверка' })).toHaveCount(0);
  expect((await page.goto('/reports/reconcile'))?.status()).toBe(404);
});

// Поздний ответ сервера (docs/OTCHET-dlya-programmistov.md §10): ответ прежнего запроса, пришедший после нового, не подменяет свежие данные,
// а подгрузка после монтирования не перетирает поля, которые человек уже изменил. Каждый тест задерживает один ответ через page.route
// и проверяет экран после того, как поздний ответ дошёл. Образец – repair-card.spec.ts «По, введённое до прихода предложенного периода».
import { expect, test, type Page } from '../../../tests/support/e2e.ts';
import { MOCK_PASSWORD } from './mock-api.ts';

const MOCK = process.env.MOCK_URL ?? 'http://127.0.0.1:4012';

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
const pause = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
/** Задерживает ответы, чей адрес подходит под match; возвращает обещание «задержанный ответ дошёл до страницы». */
function slow(page: Page, match: (url: URL) => boolean, ms = 1500) {
  void page.route((u) => match(u), async (r) => {
    await pause(ms);
    await r.continue();
  });
  return page.waitForResponse((res) => match(new URL(res.url())), { timeout: ms + 15_000 });
}

test('Зарплата: ответ без фильтра, пришедший после выбора филиала, не возвращает чужие строки', async ({ page }) => {
  await login(page, 'owner@yu.test');
  const late = slow(page, (u) => u.pathname.endsWith('/payroll/report') && !u.searchParams.has('branchIds'));
  await open(page, '/payroll');
  await page.getByLabel('Филиал').selectOption('b-nsk-krasny');
  await late;
  await pause(200);
  await expect(page.locator('[data-testid="payroll-row"][data-staff="s-admin-tsk"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="payroll-row"][data-staff="s-admin"]')).toBeVisible();
});

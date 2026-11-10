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
/** Задерживает первый запрос к API, чей адрес подходит под match; обещание выполняется, когда задержанный ответ дошёл до страницы. */
function slow(page: Page, match: (url: URL) => boolean, ms = 1500): Promise<void> {
  let taken = false;
  return new Promise((done) => {
    void page.route((u) => u.pathname.startsWith('/api/') && match(u), async (r) => {
      if (taken) return r.fallback();
      taken = true;
      await pause(ms);
      await r.continue();
      await r.request().response();
      await pause(300); // ответ разобран островом
      done();
    });
  });
}

test('Зарплата: ответ без фильтра, пришедший после выбора филиала, не возвращает чужие строки', async ({ page }) => {
  await login(page, 'owner@yu.test');
  const late = slow(page, (u) => u.pathname.endsWith('/payroll/report') && !u.searchParams.has('branchIds'));
  await open(page, '/payroll');
  await page.getByLabel('Филиал').selectOption('b-nsk-krasny');
  await late;
  await expect(page.locator('[data-testid="payroll-row"][data-staff="s-admin-tsk"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="payroll-row"][data-staff="s-admin"]')).toBeVisible();
});

test('Смены: ответ «все статусы», пришедший после выбора «Отменена», не возвращает смены в календарь', async ({ page }) => {
  await login(page, 'director@yu.test'); // у Директора на этой неделе есть смены (shifts.spec «день с дырами»)
  const late = slow(page, (u) => u.pathname.endsWith('/shifts') && !u.searchParams.has('status'));
  await open(page, '/shifts');
  await page.getByLabel('Статус').selectOption('cancelled');
  await late;
  await expect(page.getByTestId('shift-item')).toHaveCount(0);
  await page.getByLabel('Статус').selectOption('');
  await expect(page.getByTestId('shift-item').first()).toBeVisible(); // задержанный ответ был не пустой
});

test('Моё расписание: ответ текущего окна, пришедший после листания вперёд, не подменяет пустое окно', async ({ page }) => {
  await login(page, 'two@yu.test');
  const late = slow(page, (u) => u.pathname.endsWith('/shifts'));
  await open(page, '/shifts/my');
  await page.getByRole('button', { name: 'Позже' }).click();
  await page.getByRole('button', { name: 'Позже' }).click();
  await expect(page.getByTestId('my-empty')).toBeVisible();
  await late;
  await expect(page.getByTestId('my-shift')).toHaveCount(0);
});

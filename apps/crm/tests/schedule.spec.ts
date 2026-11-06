// Проверка S1-24 (план 6.2, TC-17), график и исключения: перед сокращением часов – список затронутых броней,
// автоотмены нет; подтверждение с confirmedAffected; 409 AFFECTED_CHANGED – понятное сообщение и новый список;
// отмена исключения через окно; Администратор только смотрит; чужой филиал – 404; 390 px без прокрутки.
import { expect, test, type Page } from '../../../tests/support/e2e.ts';
import { MOCK_PASSWORD } from './mock-api.ts';

const MOCK = process.env.MOCK_URL ?? 'http://127.0.0.1:4012';
const SHOTS = process.env.SCREENSHOT_DIR ?? 'test-results/screens';
const URL = '/resources/b-nsk-krasny/schedule';
const DAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

/** Дата филиала (Новосибирск) через n дней и её день недели. */
function day(n: number): { iso: string; wd: string } {
  const base = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Novosibirsk' }).format(new Date());
  const d = new Date(Date.parse(`${base}T00:00:00Z`) + n * 86_400_000);
  return { iso: d.toISOString().slice(0, 10), wd: DAYS[(d.getUTCDay() + 6) % 7]! };
}

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

test('сокращение часов: предпросмотр затронутых, подтверждение, брони не отменяются', async ({ page }) => {
  await login(page, 'director@yu.test');
  await page.goto(URL);
  const hours = page.getByTestId('hours');
  await expect(hours.locator('dl')).toContainText('10:00–22:00');
  const { wd } = day(1);
  await hours.getByLabel(`${wd}, закрытие`).fill('19:00');
  await hours.getByRole('button', { name: 'Проверить затронутые брони' }).click();
  const affected = page.getByTestId('hours-affected');
  await expect(affected).toContainText('Затронутые брони: 1.');
  await expect(affected).toContainText('bk-pc1-evening');
  await expect(affected).toContainText('Автоматически не отменяются');
  await affected.getByRole('button', { name: 'Сохранить график, затронуто: 1' }).click();
  await expect(hours.getByText('Сохранено.')).toBeVisible();
  await expect(page.getByTestId('hours-planned')).toContainText(`${wd} с ${day(1).iso.split('-').reverse().join('.')} – 10:00–19:00`);
});

test('исключение: список изменился между проверкой и сохранением – 409 и новый список; отмена через окно', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await page.goto(URL);
  const box = page.getByTestId('exceptions');
  await expect(box).toContainText('Исключений нет');

  await box.getByLabel('Дата').fill(day(3).iso);
  await box.getByLabel('Вид').selectOption({ label: 'Особые часы' });
  await box.getByLabel('Открытие').fill('18:00');
  await box.getByLabel('Закрытие').fill('12:00');
  await box.getByLabel('Причина *').fill('Проверка');
  await box.getByRole('button', { name: 'Проверить затронутые брони' }).click();
  await expect(box.getByText(/Время закрытия должно быть позже открытия/)).toBeVisible();

  await box.getByLabel('Вид').selectOption({ label: 'Технический день – закрыто' });
  await box.getByLabel('Причина *').fill('Замена проводки');
  // Предпросмотр «до» чужой брони: сервер на сохранении видит уже другой список.
  await page.route('**/calendar-exceptions/preview', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ affectedBookingIds: [] }) }));
  await box.getByRole('button', { name: 'Проверить затронутые брони' }).click();
  const affected = page.getByTestId('exception-affected');
  await expect(affected).toContainText('Будущих броней это изменение не затрагивает.');
  await page.unroute('**/calendar-exceptions/preview');
  await affected.getByRole('button', { name: 'Сохранить исключение' }).click();
  await expect(box.getByText('Пока вы смотрели, список затронутых броней изменился.')).toBeVisible();
  await expect(affected).toContainText('bk-vrroom');
  await affected.getByRole('button', { name: 'Сохранить исключение, затронуто: 1' }).click();
  await expect(box.getByText('Сохранено.')).toBeVisible();
  const item = box.locator('.yc-history__item').first();
  await expect(item).toContainText('Технический день – закрыто · Весь филиал');
  await expect(item).toContainText('Причина: Замена проводки');

  await item.getByRole('button', { name: 'Отменить…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Отменить исключение?' });
  await dialog.getByLabel('Причина отмены *').fill('Перенесли работы');
  await dialog.getByRole('button', { name: 'Проверить затронутые брони' }).click();
  await expect(dialog.getByTestId('cancel-affected')).toContainText('не затрагивает');
  await dialog.getByRole('button', { name: 'Отменить исключение' }).click();
  await expect(dialog).toBeHidden();
  await expect(box.locator('.yc-history__item').first()).toContainText('Отменено');
});

test('Администратор видит график без правки; чужой филиал – 404', async ({ page }) => {
  await login(page, 'admin@yu.test');
  await page.goto(URL);
  await expect(page.getByTestId('hours').locator('dl')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Проверить затронутые брони' })).toHaveCount(0);
  expect((await page.goto('/resources/b-tsk-lenina/schedule'))?.status()).toBe(404);
  expect((await page.goto(`${URL}/x`))?.status()).toBe(404);
});

test('снимки графика 1440 и 390, без горизонтальной прокрутки', async ({ browser }) => {
  for (const [w, h] of [[1440, 900], [390, 844]] as const) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: w === 390 ? 2 : 1 });
    const page = await ctx.newPage();
    await login(page, 'owner@yu.test');
    await page.goto(URL);
    const hours = page.getByTestId('hours');
    await hours.getByLabel(`${day(2).wd}, закрытие`).fill('21:00');
    await hours.getByRole('button', { name: 'Проверить затронутые брони' }).click();
    await expect(page.getByTestId('hours-affected')).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/schedule-${w}.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(w);
    await ctx.close();
  }
});

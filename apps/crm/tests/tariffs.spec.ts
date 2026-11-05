// Проверка S1-24 (план 6.2), тарифы: филиал × тип × длительность; цена неизменна – смена цены новым тарифом;
// конфликт приоритета – ошибка до отправки и от сервера; архив через окно; Директор только смотрит; чужой – 404.
import { expect, test, type Page } from '../../../tests/support/e2e.ts';
import { MOCK_PASSWORD } from './mock-api.ts';

const MOCK = process.env.MOCK_URL ?? 'http://127.0.0.1:4012';
const SHOTS = process.env.SCREENSHOT_DIR ?? 'test-results/screens';
const URL = '/resources/b-nsk-krasny/tariffs';

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

const rows = (page: Page) => page.getByTestId('tariffs').locator('tbody tr');

test('смена цены – новым тарифом, старый в архив через окно', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await page.goto(URL);
  await expect(rows(page)).toHaveCount(2);
  const vr = rows(page).filter({ hasText: 'VR – базовый' });
  await expect(vr).toContainText('250 ₽ за 15 мин');
  await vr.getByRole('button', { name: 'Сменить цену' }).click();
  await expect(page.getByText('Условия «VR – базовый» скопированы')).toBeVisible();
  await expect(page.getByLabel('Приоритет')).toHaveValue('1');
  await page.getByLabel('Цена за единицу, ₽ *').fill('300');
  await page.getByRole('button', { name: 'Создать тариф' }).click();
  await expect(page.getByText('Тариф создан.')).toBeVisible();
  await expect(rows(page)).toHaveCount(3);
  await expect(rows(page).filter({ hasText: 'VR – базовый (новая цена)' })).toContainText('300 ₽ за 15 мин');

  await rows(page).filter({ hasText: /^VR – базовыйСменить/ }).getByRole('button', { name: 'В архив…' }).click();
  await page.getByRole('dialog', { name: 'Убрать тариф в архив?' }).getByRole('button', { name: 'В архив' }).click();
  await expect(page.getByText('Тариф в архиве.')).toBeVisible();
  await expect(rows(page)).toHaveCount(2);
  await page.getByRole('button', { name: 'Архив', exact: true }).click();
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText('В архиве');
});

test('конфликт приоритета: ошибка до отправки и от сервера', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await page.goto(URL);
  let posts = 0;
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/tariffs')) posts++; });
  await page.getByLabel('Тип места').selectOption({ label: 'ПК' });
  await page.getByLabel('Название *').fill('ПК – вечер');
  await page.getByLabel('Цена за единицу, ₽ *').fill('180');
  await page.getByRole('button', { name: 'Создать тариф' }).click();
  await expect(page.getByText(/Конфликт приоритета с тарифом «ПК – базовый»/)).toBeVisible();
  expect(posts).toBe(0);

  // Черновик не конфликтует; при включении сервер отвечает TARIFF_PRIORITY_CONFLICT.
  await page.getByLabel('Статус').selectOption({ label: 'Черновик' });
  await page.getByRole('button', { name: 'Создать тариф' }).click();
  await expect(page.getByText('Тариф создан.')).toBeVisible();
  const draft = rows(page).filter({ hasText: 'ПК – вечер' });
  await expect(draft).toContainText('Черновик');
  await draft.getByRole('button', { name: 'Включить' }).click();
  await expect(page.getByText('Конфликт приоритета: такой тариф уже действует')).toBeVisible();
  await expect(draft).toContainText('Черновик');
});

test('Директор видит тарифы без правки; чужой филиал – 404', async ({ page }) => {
  await login(page, 'director@yu.test');
  await page.goto(URL);
  await expect(rows(page).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Новый тариф' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Сменить цену' })).toHaveCount(0);
  expect((await page.goto('/resources/b-tsk-lenina/tariffs'))?.status()).toBe(404);
});

test('снимки тарифов 1440 и 390, без горизонтальной прокрутки', async ({ browser }) => {
  for (const [w, h] of [[1440, 900], [390, 844]] as const) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: w === 390 ? 2 : 1, locale: 'ru-RU', timezoneId: 'Asia/Novosibirsk' });
    const page = await ctx.newPage();
    await login(page, 'owner@yu.test');
    await page.goto(URL);
    await expect(rows(page).first()).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/tariffs-${w}.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(w);
    await ctx.close();
  }
});

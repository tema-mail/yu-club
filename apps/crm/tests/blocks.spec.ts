// Проверка S1-24 (план 6.2), блокировки ресурсов: создание со списком затронутых броней (брони не удаляются),
// обязательный комментарий для причины «Другое», снятие через окно; Администратор – в своём филиале; чужой – 404.
import { expect, test, type Page } from '@playwright/test';
import { MOCK_PASSWORD } from './mock-api.ts';

const MOCK = process.env.MOCK_URL ?? 'http://127.0.0.1:4012';
const SHOTS = process.env.SCREENSHOT_DIR ?? 'test-results/screens';
const URL = '/resources/b-nsk-krasny/blocks';

/** Значение datetime-local через n дней в hh:mm (время браузера = Новосибирск, playwright.config). */
function at(n: number, hm: string): string {
  const base = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Novosibirsk' }).format(new Date());
  return `${new Date(Date.parse(`${base}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)}T${hm}`;
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

test('Администратор блокирует комнату: список затронутых броней, брони не удалены; снятие через окно', async ({ page }) => {
  await login(page, 'admin@yu.test');
  await page.goto(URL);
  await page.getByRole('button', { name: 'Заблокировать' }).click();
  await expect(page.getByText('Выберите, что блокировать.')).toBeVisible();

  await page.getByLabel('Что блокировать').selectOption({ label: 'Комнату целиком (все её единицы)' });
  await page.getByLabel('Комната').selectOption({ label: 'VR-комната' });
  await page.getByLabel('Начало').fill(at(3, '00:00'));
  await page.getByLabel('Конец').fill(at(4, '00:00'));
  await page.getByLabel('Причина').selectOption({ label: 'Другое' });
  await page.getByRole('button', { name: 'Заблокировать' }).click();
  await expect(page.getByText('Для этой причины нужен комментарий.')).toBeVisible();
  await page.getByLabel('Причина').selectOption({ label: 'Ремонт' });
  await page.getByRole('button', { name: 'Заблокировать' }).click();

  const created = page.getByTestId('block-created');
  await expect(created).toContainText('Блокировка: VR-комната');
  await expect(page.getByTestId('block-status')).toHaveText('Действует');
  await expect(page.getByTestId('block-affected')).toContainText('Затронутые брони: 1.');
  await expect(page.getByTestId('block-affected')).toContainText('bk-vrroom');
  await expect(page.getByTestId('block-affected')).toContainText('не удалены и не перенесены');

  await created.getByRole('button', { name: 'Снять блокировку…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Снять блокировку?' });
  await dialog.getByLabel('Комментарий').fill('Починили раньше');
  await dialog.getByRole('button', { name: 'Снять' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('block-status')).toHaveText('Снята');
});

test('блокировка мест без броней; чужой филиал – 404', async ({ page }) => {
  await login(page, 'director@yu.test');
  await page.goto(URL);
  await page.getByLabel('ПК 2').check();
  await page.getByLabel('Начало').fill(at(2, '10:00'));
  await page.getByLabel('Конец').fill(at(2, '12:00'));
  await page.getByRole('button', { name: 'Заблокировать' }).click();
  await expect(page.getByTestId('block-created')).toContainText('Блокировка: ПК 2');
  await expect(page.getByTestId('block-affected')).toHaveText('Броней на это время нет.');
  expect((await page.goto('/resources/b-tsk-lenina/blocks'))?.status()).toBe(404);
});

test('снимки блокировок 1440 и 390, без горизонтальной прокрутки', async ({ browser }) => {
  for (const [w, h] of [[1440, 900], [390, 844]] as const) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: w === 390 ? 2 : 1, timezoneId: 'Asia/Novosibirsk', locale: 'ru-RU' });
    const page = await ctx.newPage();
    await login(page, 'owner@yu.test');
    await page.goto(URL);
    await page.getByLabel('Что блокировать').selectOption({ label: 'Комнату целиком (все её единицы)' });
    await page.getByLabel('Комната').selectOption({ label: 'VR-комната' });
    await page.getByLabel('Начало').fill(at(3, '00:00'));
    await page.getByLabel('Конец').fill(at(4, '00:00'));
    await page.getByRole('button', { name: 'Заблокировать' }).click();
    await expect(page.getByTestId('block-created')).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/blocks-${w}.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(w);
    await ctx.close();
  }
});

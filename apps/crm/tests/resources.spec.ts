// Проверка S1-24 (план 6.2), комнаты и места: создание, правка, архив через окно (комнату с местами – нельзя),
// составная конфигурация (VR-комната = VR1 + VR2 + PS4) со снимком состава; смена состава при будущей брони –
// список затронутых из dryRun и отказ; чужой филиал и запись чужого филиала – 404; Администратор только смотрит.
import { expect, test, type Page } from '@playwright/test';
import { MOCK_PASSWORD } from './mock-api.ts';

const MOCK = process.env.MOCK_URL ?? 'http://127.0.0.1:4012';
const SHOTS = process.env.SCREENSHOT_DIR ?? 'test-results/screens';
const K = '/resources/b-nsk-krasny';

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

const rows = (page: Page, id: string) => page.getByTestId(id).locator('tbody tr');

test('Владелец: комната – создание, правка, архив; комнату с местами в архив не отправить', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await page.goto('/resources');
  await expect(page).toHaveURL(new RegExp(`${K}/rooms$`));
  await expect(rows(page, 'rooms')).toHaveCount(2);

  await page.getByRole('link', { name: 'Добавить комнату' }).click();
  await page.getByRole('button', { name: 'Создать комнату' }).click();
  await expect(page.getByText('Проверьте отмеченные поля.')).toBeVisible();
  await page.getByLabel('Название *').fill('PS-комната');
  await page.getByLabel('Адрес на сайте (slug) *').fill('vr');
  await page.getByRole('button', { name: 'Создать комнату' }).click();
  await expect(page.getByText('Адрес (slug) уже занят в филиале')).toBeVisible();
  await page.getByLabel('Адрес на сайте (slug) *').fill('ps');
  await page.getByLabel('Вместимость, человек').fill('4');
  await page.getByRole('button', { name: 'Создать комнату' }).click();
  await expect(page).toHaveURL(new RegExp(`${K}/rooms/r-[0-9a-f]{8}$`));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('PS-комната');
  await expect(page.getByTestId('history')).toContainText('Создание');

  await page.getByLabel('Вместимость, человек').fill('6');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByText('Сохранено.')).toBeVisible();
  await expect(page.getByTestId('history').locator('.yc-history__item').first()).toContainText('Вместимость, человек: 4 → 6');

  await page.getByRole('button', { name: 'Удалить…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'В архив' }).click();
  await expect(page.getByRole('heading', { name: 'Запись в архиве' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Сохранить' })).toHaveCount(0);

  await page.goto(`${K}/rooms/r-vr`);
  await page.getByRole('button', { name: 'Удалить…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'В архив' }).click();
  await expect(page.getByRole('dialog')).toContainText('Сначала уберите в архив вложенные объекты');
});

test('составная конфигурация: снимок состава, проверка будущих броней и отказ', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await page.goto(`${K}/resources/new`);
  await page.getByLabel('Название *').fill('VR-комната: аренда вечером');
  await page.getByLabel('Тип *').selectOption({ label: 'Комната целиком' });
  await page.getByLabel('Комната', { exact: true }).selectOption({ label: 'VR-комната' });
  await page.getByRole('button', { name: 'Создать место' }).click();
  await expect(page).toHaveURL(new RegExp(`${K}/resources/res-[0-9a-f]{8}$`));
  const comp = page.getByTestId('composition');
  await expect(comp.getByTestId('composition-current')).toContainText('Состав не задан');

  for (const code of ['VR1 – VR1', 'VR2 – VR2', 'PS4 – PS4 в VR-комнате']) await comp.getByLabel(code).check();
  await comp.getByRole('button', { name: 'Проверить брони' }).click();
  await expect(comp.getByText('Будущих броней на старом составе нет – можно сохранять.')).toBeVisible();
  await comp.getByRole('button', { name: 'Сохранить состав' }).click();
  await expect(comp.getByText(/Состав сохранён/)).toBeVisible();
  await expect(comp.getByTestId('composition-current').locator('li')).toHaveText(['PS4 – PS4 в VR-комнате', 'VR1 – VR1', 'VR2 – VR2']);

  // Действующая VR-комната целиком: на ней будущая бронь – убрать PS4 нельзя.
  await page.goto(`${K}/resources/res-vrroom`);
  const live = page.getByTestId('composition');
  await expect(live.getByTestId('composition-current').locator('li')).toHaveCount(3);
  await live.getByLabel('PS4 – PS4 в VR-комнате').uncheck();
  await live.getByRole('button', { name: 'Проверить брони' }).click();
  await expect(live.getByText(/есть будущие брони \(1\)/)).toBeVisible();
  await expect(live.getByTestId('composition-affected')).toContainText('bk-vrroom');
  await live.getByRole('button', { name: 'Сохранить состав' }).click();
  await expect(live.getByText(/Состав не изменён: у места есть будущие брони/)).toBeVisible();
  await expect(live.getByTestId('composition-affected')).toContainText('bk-vrroom');
  await expect(live.getByTestId('composition-current').locator('li')).toHaveCount(3);

  // Единица без своего места.
  await live.getByLabel('Код').fill('PS5');
  await live.getByLabel('Название').fill('PS5 в VR-комнате');
  await live.getByRole('button', { name: 'Добавить единицу' }).click();
  await expect(live.getByText('Единица PS5 добавлена')).toBeVisible();
  await expect(live.getByLabel('PS5 – PS5 в VR-комнате')).toBeVisible();
});

test('Администратор: только просмотр; чужой филиал и запись чужого филиала – 404', async ({ page }) => {
  await login(page, 'admin@yu.test');
  await page.goto('/resources');
  await expect(page).toHaveURL(new RegExp(`${K}/rooms$`));
  await expect(page.getByRole('link', { name: 'Добавить комнату' })).toHaveCount(0);
  await page.goto(`${K}/resources/res-vrroom`);
  await expect(page.getByLabel('Название', { exact: true })).toHaveAttribute('readonly', '');
  await expect(page.getByRole('button', { name: 'Удалить…' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Сохранить состав' })).toHaveCount(0);
  await expect(page.getByTestId('composition-current').locator('li')).toHaveCount(3);
  for (const path of ['/resources/b-tsk-lenina/rooms', `${K}/rooms/r-tsk-hall`, `${K}/rooms/new`, `${K}/nope`]) {
    expect((await page.goto(path))?.status()).toBe(404);
    await expect(page.getByTestId('not-found')).toBeVisible();
  }
});

test('Директор: чужой город – 404', async ({ page }) => {
  await login(page, 'director@yu.test');
  expect((await page.goto('/resources/b-tsk-lenina/resources'))?.status()).toBe(404);
  expect((await page.goto('/resources/b-tsk-lenina/resources/res-tsk-pc1'))?.status()).toBe(404);
  await page.goto(`${K}/resources`);
  await expect(rows(page, 'resources')).toHaveCount(2);
});

test('снимки ресурсов 1440 и 390, без горизонтальной прокрутки', async ({ browser }) => {
  for (const [w, h] of [[1440, 900], [390, 844]] as const) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: w === 390 ? 2 : 1 });
    const page = await ctx.newPage();
    await login(page, 'owner@yu.test');
    const noScroll = async () => expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(w);
    await page.goto(`${K}/resources`);
    await expect(rows(page, 'resources')).toHaveCount(2);
    await page.screenshot({ path: `${SHOTS}/resources-list-${w}.png`, fullPage: true });
    await noScroll();
    await page.goto(`${K}/resources/res-vrroom`);
    await page.getByTestId('composition').getByRole('button', { name: 'Проверить брони' }).click();
    await page.screenshot({ path: `${SHOTS}/resource-composition-${w}.png`, fullPage: true });
    await noScroll();
    await ctx.close();
  }
});

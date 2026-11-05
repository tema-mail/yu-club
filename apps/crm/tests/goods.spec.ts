// Товары за баллы (S2-66) на моке mock-loyalty.ts: каталог филиала с ценами в ₽ и баллах раздельно и архивом;
// Директор создаёт, меняет и убирает в архив (окном внутри записи); Администратор только смотрит – кнопок нет,
// сервер правку не принимает; нехватка (баллов или остатка) – выдача в карточке клиента недоступна; 390 px.
import { expect, test, type Page } from '../../../tests/support/e2e.ts';
import { MOCK_PASSWORD } from './mock-api.ts';

const MOCK = process.env.MOCK_URL ?? 'http://127.0.0.1:4012';
const SHOTS = process.env.SCREENSHOT_DIR ?? 'test-results/screens';
const KRASNY = '/goods/b-nsk-krasny';
const OLGA = '/clients/c0000000-0000-4000-8000-000000000001';

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
const row = (page: Page, name: string) => page.getByTestId('goods-table').locator('tbody tr').filter({ hasText: name });
const dlg = (page: Page) => page.getByRole('dialog');
const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test('Директор: каталог с ценами в ₽ и баллах, создание, правка, архив', async ({ page }) => {
  await login(page, 'director@yu.test');
  await open(page, KRASNY);
  await expect(row(page, 'Энергетик')).toContainText('30 баллов');
  await expect(row(page, 'Энергетик')).toContainText('150 ₽');
  await expect(row(page, 'Энергетик')).toContainText('5 шт.');
  await expect(row(page, 'Кружка клуба')).toContainText('не ведётся');
  await expect(row(page, 'Чипсы')).toContainText('В архиве');

  await page.getByRole('button', { name: 'Новый товар…' }).click();
  await dlg(page).getByLabel('Название *').fill('Наклейка');
  await dlg(page).getByLabel('Цена в кассе, ₽ (необязательно)').fill('50');
  await dlg(page).getByRole('button', { name: 'Сохранить' }).click();
  await expect(dlg(page).getByRole('alert')).toHaveText('Цена в баллах – число больше нуля, до двух знаков после запятой.');
  await dlg(page).getByLabel('Цена в баллах *').fill('7,5');
  await dlg(page).getByLabel(/Остаток в филиале/).fill('10');
  await dlg(page).getByRole('button', { name: 'Сохранить' }).dblclick();
  await expect(page.getByTestId('goods-notice')).toHaveText('Товар «Наклейка» добавлен.');
  await expect(row(page, 'Наклейка')).toHaveCount(1); // двойной клик – один товар
  await expect(row(page, 'Наклейка')).toContainText('7,5 балла');
  await expect(row(page, 'Наклейка')).toContainText('50 ₽');

  await row(page, 'Энергетик').getByRole('button', { name: 'Изменить…' }).click();
  await expect(dlg(page).getByLabel('Цена в баллах *')).toHaveValue('30');
  await dlg(page).getByLabel(/Остаток в филиале/).fill('0');
  await dlg(page).getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByTestId('goods-notice')).toHaveText('Товар «Энергетик» сохранён.');
  await expect(row(page, 'Энергетик')).toContainText('Закончился');

  await row(page, 'Наклейка').getByRole('button', { name: 'В архив…' }).click();
  await expect(dlg(page).getByTestId('before-after')).toContainText('история выдач сохраняется');
  await dlg(page).getByRole('button', { name: 'В архив', exact: true }).click();
  await expect(row(page, 'Наклейка')).toContainText('В архиве');
  await expect(row(page, 'Наклейка').getByRole('button', { name: 'Вернуть из архива…' })).toBeVisible();
});

test('Администратор: только просмотр, правку сервер не принимает; выдача недоступна при нехватке', async ({ page }) => {
  await login(page, 'admin@yu.test');
  await expect(page.getByRole('navigation', { name: 'Разделы' }).getByRole('link', { name: 'Товары за баллы' })).toBeVisible();
  await open(page, '/goods');
  await expect(page.getByRole('heading', { name: 'Каталог – Ю Клуб на Красном' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Новый товар…' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Изменить…' })).toHaveCount(0);
  const res = await page.request.patch('/api/crm/v1/goods/90000000-0000-4000-8000-000000000001', { data: { rowVersion: 2, name: 'в обход' } });
  expect(res.status()).toBe(403);
  expect((await page.request.get('/api/crm/v1/branches/b-tsk-lenina/goods')).status()).toBe(404);

  await open(page, OLGA);
  await page.getByTestId('loyalty').getByRole('button', { name: 'Выдать товар…' }).click();
  const goods = dlg(page).getByTestId('loy-goods');
  await expect(goods).toContainText('Энергетик – 30 баллов (в кассе 150 ₽) · закончился');
  await expect(goods).toContainText('Кружка клуба – 100 баллов (в кассе 500 ₽) · не хватает 61 балл');
  await expect(goods).not.toContainText('Чипсы');
  await expect(dlg(page).getByLabel(/Энергетик/)).toBeDisabled();
  await expect(dlg(page).getByLabel(/Кружка клуба/)).toBeDisabled();
  await expect(dlg(page).getByRole('button', { name: 'Выдать' })).toBeDisabled();
});

test('390 px: каталог без горизонтальной прокрутки', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, 'director@yu.test');
  await open(page, KRASNY);
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.getByTestId('goods').screenshot({ path: `${SHOTS}/goods-390.png` });
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, KRASNY);
  await page.getByTestId('goods').screenshot({ path: `${SHOTS}/goods-1280.png` });
});

// S4-84: «Контент» – список публикаций (поиск, фильтры типа, статуса, города, филиала; 12 §14.2) и редактор с охватом (K22 §4).
// Ошибки полноты – у полей (CONTENT_INCOMPLETE), «Опубликовать» нет у Администратора, VERSION_CONFLICT предлагает обновить, чужое – 404,
// 390 px без горизонтальной прокрутки.
import { expect, test, type Page } from '../../../tests/support/e2e.ts';
import { CONTENT_IDS } from './mock-content.ts';
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
const rows = (page: Page) => page.getByTestId('ct-list').locator('tbody tr');
const noScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test('Владелец: список, поиск и фильтры; пустой результат со сбросом', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, '/content');
  await expect(page).toHaveURL(/\/content\/publications$/);
  await expect(rows(page)).toHaveCount(4);
  const find = () => page.getByRole('button', { name: 'Найти' }).click();
  await page.getByLabel('Тип').selectOption({ label: 'Акция' });
  await find();
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText('Скидка 20% по будням');
  await expect(rows(page).first()).toContainText('Новосибирск');
  await open(page, '/content/publications?status=published');
  await expect(rows(page)).toHaveCount(2);
  await open(page, '/content/publications?branchId=b-nsk-krasny');
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText('Новые кресла на Красном');
  await page.getByLabel('Поиск по заголовку').fill('нет такого');
  await find();
  await expect(page.getByTestId('ct-empty')).toContainText('По этим условиям материалов нет');
  await page.getByRole('link', { name: 'Сбросить фильтры' }).click();
  await expect(rows(page)).toHaveCount(4);
});

test('Администратор: только своя зона, «Опубликовать» нет, сетевое – только чтение, чужое – 404', async ({ page }) => {
  await login(page, 'admin@yu.test');
  await open(page, '/content/publications');
  await expect(rows(page)).toHaveCount(2);
  await open(page, `/content/publications/${CONTENT_IDS.pubBranch}`);
  await expect(page.getByRole('button', { name: 'Сохранить черновик' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Опубликовать/ })).toHaveCount(0);
  await page.getByLabel('Заголовок').fill('Новые кресла и мониторы на Красном');
  await page.getByRole('button', { name: 'Сохранить черновик' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Черновик сохранён' })).toBeVisible();
  await open(page, `/content/publications/${CONTENT_IDS.pubNetwork}`);
  await expect(page.getByLabel('Заголовок')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Сохранить черновик' })).toHaveCount(0);
  const res = await page.goto(`/content/publications/${CONTENT_IDS.pubTomsk}`);
  expect(res?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'Не найдено' })).toBeVisible();
});

test('Директор: новый черновик филиала, публикация без полей – ошибки у полей', async ({ page }) => {
  await login(page, 'director@yu.test');
  await open(page, '/content/publications');
  await page.getByRole('link', { name: '+ Новость' }).click();
  await expect(page.getByRole('heading', { name: 'Новый материал: новость' })).toBeVisible();
  await expect(page.getByLabel('Вся сеть')).toHaveCount(0); // сеть – только Владельцу
  await page.getByLabel('Филиалы').check();
  await page.getByRole('button', { name: 'Сохранить черновик' }).click();
  await expect(page.getByText('Выберите хотя бы один филиал')).toBeVisible();
  await page.getByLabel('Ю Клуб на Красном').check();
  await page.getByLabel('Заголовок').fill('Ночь CS2 на Красном');
  await page.getByRole('button', { name: 'Сохранить черновик' }).click();
  await expect(page).toHaveURL(/\/content\/publications\/[0-9a-f-]{36}\?created=1/);
  await expect(page.getByText('Черновик создан.')).toBeVisible();
  await page.getByRole('button', { name: 'Опубликовать…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Опубликовать' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Не опубликовано: заполните отмеченные поля.' })).toBeVisible();
  for (const id of ['pub-lead', 'pub-body', 'pub-publishFrom', 'pub-cover']) await expect(page.locator(`#${id}`)).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#pub-lead-error')).toHaveText('Заполните поле – без него не опубликовать');
});

test('VERSION_CONFLICT: второй редактор видит предложение обновить черновик', async ({ page, context }) => {
  await login(page, 'owner@yu.test');
  const other = await context.newPage();
  for (const p of [page, other]) await open(p, `/content/publications/${CONTENT_IDS.pubCity}`);
  await other.getByLabel('Заголовок').fill('Скидка 25% по будням');
  await other.getByRole('button', { name: 'Сохранить черновик' }).click();
  await expect(other.getByRole('status').filter({ hasText: 'Черновик сохранён' })).toBeVisible();
  await page.getByLabel('Анонс').fill('Мой анонс');
  await page.getByRole('button', { name: 'Сохранить черновик' }).click();
  await expect(page.getByText('Черновик уже изменил другой сотрудник')).toBeVisible();
  await page.getByRole('button', { name: 'Обновить черновик' }).click();
  await expect(page.getByLabel('Заголовок')).toHaveValue('Скидка 25% по будням');
  await expect(page.getByText('Черновик уже изменил другой сотрудник')).toHaveCount(0);
});

test('390 px: список и редактор без горизонтальной прокрутки', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, '/content/publications');
  expect(await noScroll(page)).toBe(true);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/content-list-390.png`, fullPage: true });
  await open(page, `/content/publications/${CONTENT_IDS.pubNetwork}`);
  expect(await noScroll(page)).toBe(true);
});

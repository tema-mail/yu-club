// S3-76: «Оборудование» – список с фильтрами 10 §13.1, карточка с 7 вкладками 10 §13.2. Администратор не видит вкладку учёток,
// списанное – только чтение, чужое – 404, 390 px без горизонтальной прокрутки, кнопки ≥44 px.
import { expect, test, type Page } from '../../../tests/support/e2e.ts';
import { MOCK_PASSWORD } from './mock-api.ts';

const QUEST = 'e0000000-0000-4000-8000-000000000001';
const WRITTEN_OFF = 'e0000000-0000-4000-8000-000000000005';
const TOMSK = 'e0000000-0000-4000-8000-000000000007';
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
const rows = (page: Page) => page.getByTestId('eq-list').locator('tbody tr');
const noScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const smallButtons = (page: Page) => page.locator('main button:visible, main a.yc-btn:visible').evaluateAll((els) => els.filter((e) => e.getBoundingClientRect().height < 44).map((e) => e.textContent));

test('Владелец: все филиалы и фильтры 10 §13.1', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, '/equipment');
  await expect(rows(page)).toHaveCount(7);
  await expect(page.getByTestId('eq-INV-000001')).toContainText('VR-шлем Quest 3');
  await expect(page.getByTestId('eq-INV-000001')).toContainText('VR-комната · VR1');
  await expect(page.getByTestId('eq-INV-000007')).toContainText('Томск');
  for (const name of ['cityId', 'branchId', 'categoryId', 'status', 'roomId', 'serial', 'warrantyDays', 'hasOpenRepair']) await expect(page.locator(`main [name=${name}]`)).toBeVisible();

  const find = () => page.getByRole('button', { name: 'Найти' }).click();
  await page.getByLabel('Серийный номер').fill('SN-PS-5');
  await find();
  await expect(rows(page)).toHaveCount(1);
  await expect(page.getByTestId('eq-INV-000002')).toBeVisible();
  await open(page, '/equipment');
  await page.getByLabel('Статус').selectOption({ label: 'Списано' });
  await find();
  await expect(rows(page)).toHaveCount(1);
  await expect(page.getByTestId('eq-INV-000005')).toBeVisible();
  await open(page, '/equipment');
  await page.getByLabel('Открытый ремонт').selectOption({ label: 'Есть' });
  await find();
  await expect(rows(page)).toHaveCount(4);
  await open(page, '/equipment');
  await page.getByLabel('Гарантия истекает').selectOption({ value: '365' });
  await find();
  await expect(rows(page)).toHaveCount(1);
  await open(page, '/equipment?cityId=c-tsk');
  await expect(rows(page)).toHaveCount(1);
  await open(page, '/equipment?serial=none');
  await expect(page.getByTestId('eq-empty')).toBeVisible();
});

test('Администратор: только своя зона, вкладки учёток нет ни в интерфейсе, ни в ответе; чужое – 404', async ({ page }) => {
  await login(page, 'admin@yu.test');
  await open(page, '/equipment');
  await expect(rows(page)).toHaveCount(5);
  await expect(page.getByTestId('eq-INV-000007')).toHaveCount(0);
  await open(page, `/equipment/${QUEST}`);
  await expect(page.getByRole('tab')).toHaveCount(6);
  await expect(page.getByRole('tab', { name: 'Учётные записи' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Сменить статус…' })).toHaveCount(0);
  const body = await page.evaluate(async (id) => (await fetch(`/api/crm/v1/equipment/${id}`)).json(), QUEST);
  expect('accounts' in body).toBe(false);
  await page.getByRole('tab', { name: 'История' }).click();
  await expect(page.getByTestId('eq-history-denied')).toBeVisible();
  const res = await page.goto(`/equipment/${TOMSK}`);
  expect(res?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'Не найдено' })).toBeVisible();
});

test('Владелец: 7 вкладок с данными; смена статуса только предлагает блокировку', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, `/equipment/${QUEST}`);
  await expect(page.getByRole('tab')).toHaveCount(7);
  await expect(page.getByTestId('eq-status')).toHaveText('В эксплуатации');
  await expect(page.getByTestId('eq-place')).toContainText('VR1');
  await expect(page.getByTestId('eq-open-repairs')).toContainText('2');
  await page.getByRole('tab', { name: 'Размещение' }).click();
  await expect(page.getByTestId('eq-placements')).toContainText('Постановка на учёт');
  await page.getByRole('tab', { name: 'Учётные записи' }).click();
  await expect(page.getByTestId('eq-accounts')).toContainText('quest1@club.example');
  await page.getByRole('tab', { name: 'Ремонт' }).click();
  await expect(page.getByTestId('eq-repairs')).toContainText('R-000005');
  await page.getByRole('tab', { name: 'Гарантия' }).click();
  await expect(page.getByTestId('eq-warranties')).toContainText('12 месяцев');

  await page.getByRole('button', { name: 'Добавить гарантию…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('начало и конец');
  await page.getByLabel('Начало *').fill('2026-01-01');
  await page.getByLabel('Конец *').fill('2030-01-01');
  await page.getByRole('dialog').getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByTestId('eq-warranties')).toContainText('01.01.2030');

  await page.getByRole('tab', { name: 'Основное' }).click();
  await page.getByRole('button', { name: 'Сменить статус…' }).click();
  await page.getByLabel('Новый статус').selectOption('unavailable');
  await page.getByRole('dialog').getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('причину');
  await page.getByLabel('Причина *').fill('Сломано крепление');
  await page.getByRole('dialog').getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByTestId('eq-status')).toHaveText('Временно недоступно');
  await expect(page.getByTestId('eq-proposal')).toContainText('сама она ничего не закрыла');
  await page.getByRole('tab', { name: 'История' }).click();
  await expect(page.getByTestId('eq-history')).toContainText('Смена статуса');
});

test('Списанное – только чтение; списание – окно внутри записи с выбором архива', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, `/equipment/${WRITTEN_OFF}`);
  await expect(page.getByTestId('eq-readonly')).toContainText('только для чтения');
  await expect(page.getByRole('button', { name: 'Сменить статус…' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Убрать из работы…' })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Гарантия' }).click();
  await expect(page.getByRole('button', { name: 'Добавить гарантию…' })).toHaveCount(0);

  await open(page, `/equipment/${QUEST}`);
  await page.getByRole('button', { name: 'Убрать из работы…' }).click();
  await expect(page.getByRole('dialog')).toContainText('Карточки не удаляются');
  await expect(page.getByLabel('В архив как «Списано»')).toBeChecked();
  await page.getByLabel('Причина *').fill('Разбит');
  await page.getByRole('dialog').getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByTestId('eq-status')).toHaveText('Списано');
  await expect(page.getByTestId('eq-readonly')).toBeVisible();
  await expect(page.getByTestId('eq-place')).not.toContainText('VR1');
});

test('Директор: нет кнопки списания; 390 px без прокрутки, кнопки ≥44', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, 'director@yu.test');
  await open(page, '/equipment');
  expect(await noScroll(page)).toBe(true);
  expect(await smallButtons(page)).toEqual([]);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/equipment-list-390.png`, fullPage: true });
  await open(page, `/equipment/${QUEST}`);
  await expect(page.getByRole('button', { name: 'Убрать из работы…' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Сменить статус…' })).toBeVisible();
  for (const t of ['Основное', 'Размещение', 'Учётные записи', 'Ремонт', 'Гарантия', 'Документы', 'История']) {
    await page.getByRole('tab', { name: t }).click();
    await expect(page.getByRole('tabpanel')).toBeVisible();
    expect(await noScroll(page), t).toBe(true);
    expect(await smallButtons(page), t).toEqual([]);
  }
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/equipment-card-390.png`, fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  if (SHOTS) {
    await open(page, '/equipment');
    await page.screenshot({ path: `${SHOTS}/equipment-list-1440.png`, fullPage: true });
  }
});

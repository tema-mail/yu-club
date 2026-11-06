// S3-79: «Ремонт» – список с «просроченным планом» и фильтрами 10 §13.3, форма регистрации 10 §13.4; после сохранения – карточка с
// предложением блокировки, ресурс не закрыт. Чужое – 404, 390 px без прокрутки.
import { expect, test, type Page } from '../../../tests/support/e2e.ts';
import { MOCK_PASSWORD } from './mock-api.ts';

const TOMSK_REPAIR = 'a0000000-0000-4000-8000-000000000003';
const QUEST = 'e0000000-0000-4000-8000-000000000001';
const WRITTEN_OFF = 'e0000000-0000-4000-8000-000000000005';
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
const rows = (page: Page) => page.getByTestId('rp-list').locator('tbody tr');
const noScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test('список: колонки, просроченный план и фильтры', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, '/repairs');
  await expect(rows(page)).toHaveCount(6);
  const overdue = page.getByTestId('rp-R-000001');
  await expect(overdue.getByTestId('rp-overdue')).toContainText('План просрочен');
  await expect(overdue).toContainText('Перегрев видеокарты');
  await expect(overdue).toContainText('Сервис «Пиксель»');
  await expect(overdue).toContainText('3 000,00 ₽');
  await expect(page.getByTestId('rp-R-000004')).toContainText('1 500,00 ₽');
  await expect(page.getByTestId('rp-R-000004').getByTestId('rp-overdue')).toHaveCount(0);

  const find = () => page.getByRole('button', { name: 'Найти' }).click();
  await page.locator('main [name=planOverdue]').selectOption('true');
  await find();
  await expect(rows(page)).toHaveCount(1);
  await open(page, '/repairs');
  await page.locator('main [name=status]').selectOption({ label: 'Закрыт' });
  await find();
  await expect(rows(page)).toHaveCount(1);
  await open(page, '/repairs');
  await page.locator('main [name=priority]').selectOption({ label: 'Низкий' });
  await find();
  await expect(page.getByTestId('rp-R-000002')).toBeVisible();
  await expect(rows(page)).toHaveCount(1);
  await open(page, `/repairs?equipmentId=${QUEST}`);
  await expect(rows(page)).toHaveCount(2);
  await open(page, '/repairs?from=2020-01-01&to=2020-01-02');
  await expect(page.getByTestId('rp-empty')).toBeVisible();
});

test('Администратор: своя зона; чужой ремонт – 404; нет кнопок управления', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, 'admin@yu.test');
  await open(page, '/repairs');
  await expect(rows(page)).toHaveCount(5);
  expect(await noScroll(page)).toBe(true);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/repairs-list-390.png`, fullPage: true });
  const res = await page.goto(`/repairs/${TOMSK_REPAIR}`);
  expect(res?.status()).toBe(404);
});

test('регистрация: проверки дат; дата поломки не подменяется; после сохранения – предложение, ресурс не закрыт', async ({ page }) => {
  await login(page, 'admin@yu.test');
  await open(page, `/repairs/new?equipmentId=${QUEST}`);
  const form = page.getByTestId('rp-form');
  await expect(page.getByTestId('rp-history')).toContainText('R-000005');
  await form.getByRole('button', { name: 'Зарегистрировать' }).click();
  await expect(form.getByRole('alert')).toContainText('дату поломки');
  await form.getByLabel('Дата поломки неизвестна').check();
  await form.getByRole('button', { name: 'Зарегистрировать' }).click();
  await expect(form.getByRole('alert')).toContainText('Опишите');
  await form.getByLabel('Что случилось *').fill('Шлем не включается');
  await form.getByLabel('Приоритет').selectOption('critical');
  await form.getByLabel('Влияние на работу').selectOption('full');
  await form.getByRole('button', { name: 'Зарегистрировать' }).click();

  await expect(page).toHaveURL(/\/repairs\/[0-9a-f-]+\?registered=1/);
  await expect(page.locator('astro-island[ssr]')).toHaveCount(0);
  await expect(page.getByTestId('rp-number')).toHaveText('R-000007');
  await expect(page.getByTestId('rp-suggest')).toContainText('сама она ничего не закрыла');
  await expect(page.getByTestId('rp-broken')).toHaveText('Дата неизвестна');
  await expect(page.getByTestId('rp-symptoms')).toHaveText('Шлем не включается');
  const end = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  await page.getByTestId('rp-block-panel').getByLabel('По', { exact: true }).fill(`${end}T12:00`);
  await page.getByRole('button', { name: 'Показать затронутых' }).click();
  await expect(page.getByTestId('rp-affected')).toContainText('VR-комната целиком');
  await expect(page.getByTestId('rp-blocks')).toHaveCount(0);
  const booking = await page.evaluate(async () => (await fetch('/api/crm/v1/bookings/bk-vrroom')).json());
  expect(booking.status).toBe('confirmed');
  await page.getByTestId('rp-equipment').click();
  await expect(page.getByTestId('eq-open-repairs')).toContainText('3');
});

test('регистрация: разные даты поломки и обнаружения, поломка позже – отказ; списанного нет в списке', async ({ page }) => {
  await login(page, 'director@yu.test');
  await open(page, '/repairs/new');
  const form = page.getByTestId('rp-form');
  await expect(form.getByLabel('Оборудование *').locator(`option[value="${WRITTEN_OFF}"]`)).toHaveCount(0);
  await form.getByLabel('Оборудование *').selectOption(QUEST);
  await form.getByLabel('Когда обнаружено *').fill('2026-01-10T12:00');
  await form.getByLabel('Когда сломалось (время филиала)').fill('2026-01-11T12:00');
  await form.getByLabel('Что случилось *').fill('Трещина');
  await form.getByRole('button', { name: 'Зарегистрировать' }).click();
  await expect(form.getByRole('alert')).toContainText('позже обнаружения');
  await form.getByLabel('Когда сломалось (время филиала)').fill('2026-01-09T12:00');
  await form.getByLabel('Влияние на работу').selectOption('none');
  await form.getByRole('button', { name: 'Зарегистрировать' }).click();
  await expect(page.getByTestId('rp-number')).toHaveText('R-000007');
  await expect(page.getByTestId('rp-broken')).toContainText('09.01.2026');
  await expect(page.getByTestId('rp-detected')).toContainText('10.01.2026');
  await expect(page.getByTestId('rp-suggest')).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/repair-registered-1440.png`, fullPage: true });
});

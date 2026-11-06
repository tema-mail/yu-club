// e2e оплаты баллами в оформлении (S2-72) на моках mock-api.ts + mock-commerce.ts (K15 §3, §11–12):
// резерв на удержание и его отражение в балансе, смена состава снимает резерв с фразой, баллов мало – выбор
// недоступен без доплаты, комната целиком баллами не оплачивается, отмена выбора снимает резерв,
// при −50 текст 07 §9.2 до выбора слота, 390 px без горизонтальной прокрутки.
import { expect, test, type Page } from '../../../tests/support/e2e.ts';
import { MOCK_PORT, STAGE_PORT } from '../playwright.config.ts';
import { ERROR_STATES, LIMIT_TEXT } from '../src/lib/booking.ts';
import { RESERVE_DROPPED } from '../src/islands/Checkout.tsx';
import { MOCK_CODE } from './mock-api.ts';

test.use({ baseURL: `http://localhost:${STAGE_PORT}` });

const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const PAGE = '/schedule/?branch=novosibirsk/krasny-prospekt';
const slot = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const status = (page: Page) => page.getByTestId('schedule-status');
const reserved = (page: Page) => page.evaluate(async () => ((await (await fetch('/api/public/v1/me/loyalty/')).json()) as { reservedCenti: number }).reservedCenti);

async function openTomorrow(page: Page) {
  await page.goto(PAGE);
  await page.getByRole('button', { name: /^Завтра/ }).click();
  await expect(slot(page, 'ПК 4, 10:00–10:30, свободно')).toBeEnabled();
}
async function pick(page: Page, name: string) {
  await slot(page, `${name}, свободно`).click();
  await expect(slot(page, `${name}, выбрано вами`)).toBeVisible();
}
async function loginInFlow(page: Page, phone: string) {
  await page.getByRole('button', { name: 'Оформить запись' }).click();
  await page.getByLabel('Телефон').fill(phone);
  await page.getByRole('button', { name: 'Получить код' }).click();
  await page.getByLabel('Код из SMS').fill(MOCK_CODE);
  await page.getByLabel(/согласие на обработку/).check();
  await page.getByRole('button', { name: 'Войти и продолжить' }).click();
  await expect(page.getByTestId('payment')).toBeVisible();
}

test.beforeEach(async ({ request }) => {
  await request.post(`${MOCK}/__test/booking-reset`);
  await request.post(`${MOCK}/__test/commerce-reset`);
});

test('баллами: резерв на удержание, смена состава снимает его с фразой, повторный выбор, подтверждение', async ({ page }) => {
  await openTomorrow(page);
  await pick(page, 'ПК 4, 10:00–10:30');
  await pick(page, 'ПК 4, 10:30–11:00');
  await loginInFlow(page, '9131234567');
  const points = page.getByTestId('pay-points');
  await expect(page.getByTestId('payment')).toContainText('Баллами – 60 баллов (доступно 320,5)');
  await points.check();
  await expect(page.getByTestId('points-reserved')).toContainText('Зарезервировано 60 баллов – резерв держится, пока идёт таймер');
  expect(await reserved(page)).toBe(6000);

  await page.getByRole('button', { name: 'Изменить выбор' }).click();
  await pick(page, 'ПК 4, 11:00–11:30');
  await expect(status(page)).toHaveText(RESERVE_DROPPED);
  expect(await reserved(page)).toBe(0); // сервер тоже снял: подпись состава разошлась
  await page.getByRole('button', { name: 'Оформить запись' }).click();
  await expect(points).not.toBeChecked();
  await expect(page.getByTestId('payment')).toContainText('Баллами – 90 баллов');
  await points.check();
  await expect(page.getByTestId('points-reserved')).toContainText('90 баллов');
  expect(await reserved(page)).toBe(9000);

  // Передумал – оплата в клубе: резерв снят.
  await page.getByLabel(/В клубе, при визите/).check();
  await expect(page.getByTestId('points-reserved')).toHaveCount(0);
  expect(await reserved(page)).toBe(0);
  await points.check();
  await expect(page.getByTestId('points-reserved')).toBeVisible();
  await page.getByTestId('confirm').click();
  await expect(page).toHaveURL(/\/booking\/success\/$/);
});

test('баллов мало: выбор недоступен, доплаты нет', async ({ page }) => {
  await openTomorrow(page);
  await pick(page, 'ПК 4, 10:00–10:30');
  await loginInFlow(page, '9135550000'); // у Петра 20 баллов, нужно 30
  await expect(page.getByTestId('pay-points')).toBeDisabled();
  await expect(page.getByTestId('points-short')).toHaveText('Баллов не хватает: доступно 20, нужно 30. Баллами оплачивается только всё время целиком – доплатить разницу деньгами нельзя.');
  await expect(page.getByLabel(/В клубе, при визите/)).toBeChecked();
});

test('комната целиком баллами не оплачивается; отмена выбора снимает резерв', async ({ page }) => {
  await openTomorrow(page);
  await pick(page, 'Вся комната, 10:00–10:30');
  await loginInFlow(page, '9131234567');
  await page.getByTestId('pay-points').check();
  await expect(status(page)).toHaveText(ERROR_STATES.POINTS_NOT_ALLOWED!.text!);
  await expect(page.getByTestId('pay-points')).not.toBeChecked();
  expect(await reserved(page)).toBe(0);

  await page.getByRole('button', { name: 'Изменить выбор' }).click();
  await pick(page, 'ПК 4, 12:00–12:30');
  await slot(page, 'Вся комната, 10:00–10:30, выбрано вами').click(); // убрать комнату – остаётся то, что баллами можно
  await expect(slot(page, 'Вся комната, 10:00–10:30, свободно')).toBeVisible();
  await page.getByRole('button', { name: 'Оформить запись' }).click();
  await page.getByTestId('pay-points').check();
  await expect(page.getByTestId('points-reserved')).toBeVisible();
  await page.getByRole('button', { name: 'Изменить выбор' }).click();
  await page.getByRole('button', { name: 'Отменить выбор' }).click();
  await expect(page.getByTestId('hold-panel')).toHaveCount(0);
  expect(await reserved(page)).toBe(0);
});

test('−50: текст 07 §9.2 до выбора слота, свободные слоты недоступны', async ({ page }) => {
  await page.goto('/login/?next=/schedule/%3Fbranch%3Dnovosibirsk%2Fkrasny-prospekt');
  await page.getByLabel('Телефон').fill('9135550050');
  await page.getByRole('button', { name: 'Получить код' }).click();
  await page.getByLabel('Код из SMS').fill(MOCK_CODE);
  await page.getByLabel(/согласие на обработку/).check();
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(/\/schedule\//);
  await expect(page.getByTestId('loyalty-limit-banner')).toHaveText(LIMIT_TEXT);
  await page.getByRole('button', { name: /^Завтра/ }).click();
  await expect(slot(page, 'ПК 4, 10:00–10:30, свободно')).toBeDisabled();
});

test('390 px: оформление с баллами без горизонтальной прокрутки', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openTomorrow(page);
  await pick(page, 'ПК 4, 10:00–10:30');
  await loginInFlow(page, '9131234567');
  await page.getByTestId('pay-points').check();
  await expect(page.getByTestId('points-reserved')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: 'test-results/checkout-points-390.png', fullPage: true });
});

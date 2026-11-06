// Бонусный счёт в карточке клиента (S2-65) на моке mock-loyalty.ts: баланс, доступно, резерв, пометка «по расписанию»,
// история с основанием и партиями; корректировка Директором с причиной; Администратор кнопки не видит и сервер ему
// отказывает; −50: причина блокировки предзаписи, «требует решения» закрывает Владелец в режиме «ниже предела»
// (Директору – понятный отказ); выдача товара (нехватка – недоступно) и возврат через окно с причиной; 390 px.
import { expect, test, type Page } from '../../../tests/support/e2e.ts';
import { MOCK_PASSWORD } from './mock-api.ts';

const MOCK = process.env.MOCK_URL ?? 'http://127.0.0.1:4012';
const SHOTS = process.env.SCREENSHOT_DIR ?? 'test-results/screens';
const OLGA = '/clients/c0000000-0000-4000-8000-000000000001';
const IVAN = '/clients/c0000000-0000-4000-8000-000000000002';

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
const loy = (page: Page) => page.getByTestId('loyalty');
const dlg = (page: Page) => page.getByRole('dialog');
const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test('Директор: баланс, резерв, история с партиями; корректировка с причиной', async ({ page }) => {
  await login(page, 'director@yu.test');
  await open(page, OLGA);
  await expect(page.getByTestId('loy-balance')).toHaveText('45 баллов');
  await expect(page.getByTestId('loy-available')).toHaveText('39 баллов');
  await expect(page.getByTestId('loy-reserved')).toContainText('6 баллов');
  await expect(page.getByTestId('loy-basis')).toContainText('по расписанию');
  await expect(page.getByTestId('loy-blocked')).toHaveCount(0);
  const accrual = page.getByTestId('loy-history').locator('tbody tr').filter({ hasText: '+20 баллов' });
  await expect(accrual).toContainText('Начисление за посещение');
  await expect(accrual).toContainText('осталось 15 баллов, бессрочно'); // штраф −5 списан с этой, более ранней партии (FEFO)
  await expect(page.getByTestId('loy-batches').locator('tbody tr')).toHaveCount(2);

  await loy(page).getByRole('button', { name: 'Корректировка…' }).click();
  await dlg(page).getByLabel('Баллов *').fill('10,5');
  await expect(dlg(page).getByTestId('before-after')).toContainText('55,5 балла');
  await dlg(page).getByRole('button', { name: 'Провести' }).click();
  await expect(dlg(page).getByRole('alert')).toHaveText('Укажите причину корректировки.');
  await dlg(page).getByLabel('Причина *').fill('Компенсация за сбой ПК');
  await dlg(page).getByRole('button', { name: 'Провести' }).dblclick();
  await expect(page.getByTestId('loy-notice')).toHaveText('Корректировка проведена: +10,5 балла.');
  await expect(page.getByTestId('loy-balance')).toHaveText('55,5 балла');
  await expect(page.getByTestId('loy-history').locator('tbody tr').first()).toContainText('Компенсация за сбой ПК');
  await expect(page.getByTestId('loy-history').locator('tbody tr').filter({ hasText: 'Компенсация за сбой ПК' })).toHaveCount(1); // двойной клик – одна операция
});

test('Администратор не видит корректировку, и сервер её не проводит', async ({ page }) => {
  await login(page, 'admin@yu.test');
  await open(page, OLGA);
  await expect(page.getByTestId('loy-balance')).toBeVisible();
  await expect(loy(page).getByRole('button', { name: 'Корректировка…' })).toHaveCount(0);
  const res = await page.request.post(`/api/crm/v1${OLGA}/loyalty/adjust`, { data: { deltaCenti: 100, reason: 'в обход' }, headers: { 'idempotency-key': crypto.randomUUID() } });
  expect(res.status()).toBe(403);
});

test('−50: причина блокировки; Директору ниже предела – отказ, Владелец закрывает «требует решения»', async ({ page }) => {
  await login(page, 'director@yu.test');
  await open(page, IVAN);
  await expect(page.getByTestId('loy-balance')).toHaveText('−50 баллов');
  await expect(page.getByTestId('loy-blocked')).toContainText('Предварительная запись временно недоступна');
  await page.getByTestId('loy-issues').getByRole('button', { name: 'Закрыть корректировкой…' }).click();
  await expect(dlg(page).getByLabel('Баллов *')).toHaveValue('10');
  await dlg(page).getByLabel('Причина *').fill('Сторно начисления вручную');
  await dlg(page).getByRole('button', { name: 'Провести' }).click();
  await expect(dlg(page).getByRole('alert')).toHaveText('Ниже −50 баллов может опустить только Владелец.');
  await dlg(page).getByRole('button', { name: 'Не менять' }).click();

  await page.context().clearCookies();
  await login(page, 'owner@yu.test');
  await open(page, IVAN);
  await page.getByTestId('loy-issues').getByRole('button', { name: 'Закрыть корректировкой…' }).click();
  await dlg(page).getByLabel('Причина *').fill('Сторно начисления вручную');
  await dlg(page).getByLabel('Ниже предела −50 (право Владельца)').check();
  await expect(dlg(page).getByTestId('before-after')).toContainText('−60 баллов');
  await dlg(page).getByRole('button', { name: 'Провести' }).click();
  await expect(page.getByTestId('loy-notice')).toHaveText('Задача закрыта корректировкой.');
  await expect(page.getByTestId('loy-issues')).toHaveCount(0);
  await expect(page.getByTestId('loy-balance')).toHaveText('−60 баллов');
});

test('Администратор выдаёт товар (дорогой – недоступен) и возвращает его через окно с причиной; 390 px', async ({ page }) => {
  await login(page, 'admin@yu.test');
  await open(page, OLGA);
  await loy(page).getByRole('button', { name: 'Выдать товар…' }).click();
  const mug = dlg(page).getByLabel(/Кружка клуба/);
  await expect(mug).toBeDisabled();
  await expect(dlg(page).getByTestId('loy-goods')).toContainText('Кружка клуба – 100 баллов (в кассе 500 ₽) · не хватает 50,5 балла');
  await expect(dlg(page).getByRole('button', { name: 'Выдать' })).toBeDisabled();
  await dlg(page).getByLabel(/Энергетик/).check();
  await expect(dlg(page).getByTestId('before-after')).toContainText('25,5 балла');
  await dlg(page).getByRole('button', { name: 'Выдать' }).click();
  await expect(page.getByTestId('loy-notice')).toHaveText('Выдан товар «Энергетик» за 30 баллов.');
  await expect(page.getByTestId('loy-balance')).toHaveText('25,5 балла');
  await expect(page.getByTestId('loy-orders')).toContainText('Энергетик');

  await page.getByTestId('loy-orders').getByRole('button', { name: 'Вернуть…' }).click();
  await expect(dlg(page).getByTestId('before-after')).toContainText('+30 баллов в исходные партии');
  await dlg(page).getByRole('button', { name: 'Вернуть' }).click();
  await expect(dlg(page).getByRole('alert')).toHaveText('Укажите причину возврата.');
  await dlg(page).getByLabel('Причина возврата *').fill('Товара не оказалось на складе');
  await dlg(page).getByRole('button', { name: 'Вернуть' }).click();
  await expect(page.getByTestId('loy-notice')).toContainText('возвращён');
  await expect(page.getByTestId('loy-balance')).toHaveText('55,5 балла');
  await expect(page.getByTestId('loy-orders')).toContainText('Возвращён: Товара не оказалось на складе');
  await expect(page.getByTestId('loy-orders').getByRole('button', { name: 'Вернуть…' })).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, OLGA);
  expect(await noHorizontalScroll(page)).toBe(true);
  await loy(page).screenshot({ path: `${SHOTS}/loyalty-390.png` });
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, OLGA);
  await loy(page).screenshot({ path: `${SHOTS}/loyalty-1280.png` });
});

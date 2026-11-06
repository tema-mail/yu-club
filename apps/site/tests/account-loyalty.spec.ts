// e2e ЛК «Баллы» (S2-70) на моке tests/mock-commerce.ts (K15 §11): баланс, доступно, резерв, ближайшее истечение,
// история с «не возвращено», каталог; при −50 – текст 07 §9.2, а кабинет и история доступны (07 §9.3);
// пустой счёт; «Мои записи» и «Уведомления» на месте; 390 px без горизонтальной прокрутки.
import { expect, test, type Page } from '../../../tests/support/e2e.ts';
import { MOCK_PORT, STAGE_PORT } from '../playwright.config.ts';
import { LIMIT_TEXT } from '../src/lib/booking.ts';
import { MOCK_CODE, resourceId } from './mock-api.ts';

test.use({ baseURL: `http://localhost:${STAGE_PORT}` });

const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const KRASNY = '0b0b0000-0000-4000-8000-000000000011';

async function login(page: Page, phone: string) {
  await page.goto('/login/?next=/account/');
  await page.getByLabel('Телефон').fill(phone);
  await page.getByRole('button', { name: 'Получить код' }).click();
  await page.getByLabel('Код из SMS').fill(MOCK_CODE);
  await page.getByLabel(/согласие на обработку/).check();
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(/\/account\/$/);
}

test.beforeEach(async ({ request }) => {
  await request.post(`${MOCK}/__test/booking-reset`);
  await request.post(`${MOCK}/__test/commerce-reset`);
});

test('баланс, доступно, ближайшее истечение, история с «не возвращено», каталог; соседние блоки на месте', async ({ page }) => {
  await login(page, '9131234567');
  const block = page.getByTestId('loyalty');
  await expect(page.getByTestId('loyalty-balance')).toHaveText('320,5 балла');
  await expect(page.getByTestId('loyalty-available')).toHaveText('320,5');
  await expect(page.getByTestId('loyalty-reserved')).toHaveText('0');
  await expect(page.getByTestId('loyalty-expiry')).toContainText('120 баллов');
  await expect(page.getByTestId('loyalty-limit')).toHaveCount(0);
  const history = page.getByTestId('loyalty-history').locator('li');
  await expect(history).toHaveCount(7); // 6 операций + строка «не возвращено»
  await expect(history.nth(0)).toContainText('Не возвращено 10 балла: срок партии истёк');
  await expect(history.nth(1)).toContainText('Возврат баллов');
  await expect(history.nth(1)).toContainText('+30,5');
  await expect(block).toContainText('Штраф за неявку');
  await expect(block).toContainText('−50');
  await expect(block).toContainText('запись № 997');
  await expect(page.getByTestId('loyalty-goods')).toContainText('150 ₽ или 150 баллов');
  await expect(page.getByTestId('my-bookings')).toBeVisible();
  await expect(page.getByRole('checkbox')).toHaveCount(2); // «Уведомления»
});

test('резерв на удержание виден в ЛК: доступно уменьшается, баланс прежний', async ({ page }) => {
  await login(page, '9131234567');
  await expect(page.getByTestId('loyalty-balance')).toHaveText('320,5 балла');
  const tomorrow = new Date(Date.now() + 7 * 3600_000 + 86_400_000).toISOString().slice(0, 10);
  const r = await page.evaluate(async ({ branchId, resource, start, end }) => {
    const h = { 'content-type': 'application/json', 'x-requested-with': 'yu-site' };
    await fetch(`/api/public/v1/branches/${branchId}/availability/?date=${start.slice(0, 10)}`);
    const hold = await (await fetch('/api/public/v1/holds/', { method: 'POST', headers: { ...h, 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify({ branchId, items: [{ resourceId: resource, start, end }] }) })).json() as { id: string };
    const res = await fetch(`/api/public/v1/holds/${hold.id}/points-reserve/`, { method: 'POST', headers: { ...h, 'idempotency-key': crypto.randomUUID() }, body: '{}' });
    return { status: res.status, body: await res.json() as { amountCenti: number } };
  }, { branchId: KRASNY, resource: resourceId(KRASNY, 'pc4'), start: `${tomorrow}T05:00:00.000Z`, end: `${tomorrow}T05:30:00.000Z` });
  expect(r.status).toBe(201);
  expect(r.body.amountCenti).toBe(3000); // 30 минут = 30 баллов
  await page.reload();
  await expect(page.getByTestId('loyalty-balance')).toHaveText('320,5 балла');
  await expect(page.getByTestId('loyalty-reserved')).toHaveText('30');
  await expect(page.getByTestId('loyalty-available')).toHaveText('290,5');
});

test('−50: текст 07 §9.2, минус виден, история и кабинет доступны', async ({ page }) => {
  await login(page, '9135550050');
  await expect(page.getByTestId('loyalty-limit')).toHaveText(LIMIT_TEXT);
  await expect(page.getByTestId('loyalty-balance')).toHaveText('−50 баллов');
  await expect(page.getByTestId('loyalty-available')).toHaveText('0');
  await expect(page.getByTestId('loyalty-history').locator('li')).toHaveCount(2);
  await expect(page.getByTestId('my-bookings')).toBeVisible();
});

test('новый клиент: нулевой баланс и пустая история', async ({ page }) => {
  await login(page, '9130000078');
  await expect(page.getByTestId('loyalty-balance')).toHaveText('0 баллов');
  await expect(page.getByTestId('loyalty-expiry')).toHaveText('Нет');
  await expect(page.getByTestId('loyalty-history-empty')).toBeVisible();
});

test('390 px: «Баллы» без горизонтальной прокрутки', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, '9131234567');
  await expect(page.getByTestId('loyalty-history')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'test-results/account-loyalty-390.png', fullPage: true });
});

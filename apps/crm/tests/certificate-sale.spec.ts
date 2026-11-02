// Продажа сертификата (S2-68) на моке mock-certificates.ts: предупреждение R-03, номер и код ОДИН раз (скопировать,
// печать, «код больше не покажем»), двойной клик – один сертификат, после закрытия и обновления кода нет нигде,
// повтор того же ключа API отдаёт pin: null; Администратор не продаёт (кнопки нет, API – 403); 1440 и 390 px.
import { expect, test, type Page } from '@playwright/test';
import { MOCK_PASSWORD } from './mock-api.ts';

const MOCK = process.env.MOCK_URL ?? 'http://127.0.0.1:4012';
const SHOTS = process.env.SCREENSHOT_DIR ?? 'test-results/screens';

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
const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test('Владелец продаёт: R-03, код один раз, копирование и печать; после закрытия и обновления кода нет', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.addInitScript(() => {
    (window as unknown as { __prints: number }).__prints = 0;
    window.print = () => { (window as unknown as { __prints: number }).__prints++; };
  });
  await login(page, 'owner@yu.test');
  await open(page, '/certificates');
  const before = await page.getByTestId('cert-list').locator('tbody tr').count();
  await page.getByRole('button', { name: 'Продать сертификат' }).click();
  const dlg = page.getByRole('dialog');
  await expect(dlg.getByTestId('sell-r03')).toContainText('сеанс оплачивается только целиком');
  await dlg.getByRole('button', { name: 'Оформить и получить код' }).click();
  await expect(dlg.getByRole('alert')).toContainText('Введите номинал в рублях');
  await dlg.getByLabel('Филиал продажи').selectOption({ label: 'Ю Клуб на Красном' });
  await dlg.getByLabel('Номинал, ₽').fill('2 500,5');
  await dlg.getByRole('button', { name: 'Карта' }).click();
  await dlg.getByRole('button', { name: 'Оформить и получить код' }).dblclick();
  const number = (await dlg.getByTestId('sell-number').textContent())!;
  const pin = (await dlg.getByTestId('sell-pin').textContent())!;
  expect(number).toMatch(/^YC-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  expect(pin).toMatch(/^\d{4}$/);
  await expect(dlg.getByTestId('sell-result')).toContainText('2 500,50');
  await expect(dlg.getByTestId('sell-once')).toContainText('Код больше не покажем');
  await dlg.getByRole('button', { name: 'Скопировать номер и код' }).click();
  await expect(dlg.getByRole('status')).toHaveText('Номер и код скопированы.');
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain(`Номер: ${number}`);
  expect(clip).toContain(`Код: ${pin}`);
  await dlg.getByRole('button', { name: 'Печать' }).click();
  expect(await page.evaluate(() => (window as unknown as { __prints: number }).__prints)).toBe(1);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: `${SHOTS}/certificate-sale-1440.png` });

  await dlg.getByRole('button', { name: 'Код передан клиенту – закрыть' }).click();
  await expect(page.getByTestId('cert-number')).toHaveText(number);
  await expect(page.getByTestId('cert-nominal')).toHaveText('2 500,50 ₽');
  await expect(page.getByTestId('sell-pin')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('cert-number')).toHaveText(number);
  await expect(page.getByText(`Код: ${pin}`)).toHaveCount(0);
  expect(await page.content()).not.toContain(`"pin"`);
  await open(page, '/certificates');
  await expect(page.getByTestId('cert-list').locator('tbody tr')).toHaveCount(before + 1); // двойной клик – один сертификат
  // Продажа попала в кассу филиала доходом «продажа сертификата».
  await open(page, '/finance/b-nsk-krasny');
  await expect(page.getByTestId('fin-journal').locator('tbody tr').filter({ hasText: '2 500,50' })).toContainText('Продажа сертификата');
});

test('Повтор того же ключа: тот же сертификат, кода в ответе нет (pin: null)', async ({ page }) => {
  await login(page, 'director@yu.test');
  await open(page, '/certificates');
  const r = await page.evaluate(async () => {
    const key = crypto.randomUUID();
    const call = () => fetch('/api/crm/v1/branches/b-nsk-krasny/certificates', {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify({ nominalKop: 100000, method: 'cash' }),
    }).then((x) => x.json());
    const first = await call();
    const second = await call();
    return { first, second };
  });
  expect(r.first.pin).toMatch(/^\d{4}$/);
  expect(r.second.pin).toBeNull();
  expect(r.second.pinShownOnce).toBe(true);
  expect(r.second.certificate.id).toBe(r.first.certificate.id);
});

test('Администратор не продаёт: кнопки нет, API отвечает 403', async ({ page }) => {
  await login(page, 'admin@yu.test');
  await open(page, '/certificates');
  await expect(page.getByTestId('cert-list')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Продать сертификат' })).toHaveCount(0);
  const status = await page.evaluate(() => fetch('/api/crm/v1/branches/b-nsk-krasny/certificates', {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify({ nominalKop: 100000, method: 'cash' }),
  }).then((x) => x.status));
  expect(status).toBe(403);
});

test('390 px: форма и результат продажи без горизонтальной прокрутки, кнопки ≥ 44 px', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, 'owner@yu.test');
  await open(page, '/certificates');
  await page.getByRole('button', { name: 'Продать сертификат' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Номинал, ₽').fill('3000');
  expect(await noHorizontalScroll(page)).toBe(true);
  await dlg.getByRole('button', { name: 'Оформить и получить код' }).click();
  await expect(dlg.getByTestId('sell-pin')).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);
  for (const name of ['Скопировать номер и код', 'Печать', 'Код передан клиенту – закрыть']) {
    expect((await dlg.getByRole('button', { name }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  await page.screenshot({ path: `${SHOTS}/certificate-sale-390.png` });
});

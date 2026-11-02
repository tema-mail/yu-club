// Сертификаты (S2-67) на моке mock-certificates.ts: список с фильтрами и «истекающими», карточка с 8 разделами
// и крупными номером/статусом/остатком/сроком; Владелец корректирует остаток и отменяет продажу окном с причиной
// (возврат – в журнале кассы); у использованного отмены нет; Директор – своя зона; Администратор – без кнопок; 1440 и 390.
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
const rows = (page: Page) => page.getByTestId('cert-list').locator('tbody tr');
async function openCard(page: Page, number: string) {
  await open(page, `/certificates?q=${number}`);
  await page.getByRole('link', { name: number }).click();
  await expect(page.getByTestId('cert-number')).toHaveText(number);
  await expect(page.locator('astro-island[ssr]')).toHaveCount(0);
}

test('Владелец: список зоны, «истекающие» 7 дней, статус и поиск', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, '/certificates');
  await expect(rows(page)).toHaveCount(5);
  await page.getByRole('link', { name: 'Истекают за 7 дней' }).click();
  await expect(rows(page)).toHaveCount(1);
  await expect(page.getByTestId('cert-YC-7K2M-9QXD')).toContainText('3 000,00 ₽');
  await page.getByRole('link', { name: 'Все', exact: true }).click();
  await page.getByLabel('Статус').selectOption({ label: 'Истёк' });
  await page.getByRole('button', { name: 'Найти' }).click();
  await expect(rows(page)).toHaveCount(1);
  await expect(page.getByTestId('cert-YC-2B6C-8DFG')).toBeVisible();
  await open(page, '/certificates?q=4h8p');
  await expect(rows(page)).toHaveCount(1);
  await open(page, '/certificates?expiring=60&status=cancelled');
  await expect(page.getByTestId('cert-empty')).toHaveText('Сертификатов, истекающих в ближайшие 60 дней, нет.');
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '/certificates');
  await page.screenshot({ path: `${SHOTS}/certificates-list-1440.png`, fullPage: true });
});

test('Карточка: крупно номер, статус, остаток, срок; 8 разделов; использованный не отменить; корректировка Владельца', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await openCard(page, 'YC-4H8P-2RTW');
  await expect(page.getByTestId('cert-status')).toHaveText('Частично использован');
  await expect(page.getByTestId('cert-balance')).toHaveText('3 500,00 ₽');
  await expect(page.getByTestId('cert-nominal')).toHaveText('5 000,00 ₽');
  await expect(page.getByTestId('cert-branch')).toHaveText('Ю Клуб на Красном');
  await expect(page.getByRole('heading', { level: 2 })).toHaveText([
    '1. Основные данные', '2. Покупатель и получатель', '3. Номинал и остаток', '4. Срок действия',
    '5. История погашений', '6. История передач и привязки', '7. Отмена и корректировки', '8. Аудит: движение остатка',
  ]);
  await expect(page.getByTestId('cert-redemptions')).toContainText('1 500,00 ₽');
  await expect(page.getByRole('button', { name: 'Отменить продажу…' })).toHaveCount(0);
  await expect(page.getByText('Сертификат использовался: простая отмена невозможна')).toBeVisible();
  await expect(page.locator('body')).not.toContainText(/код\s*:?\s*\d{4}/i);

  await page.getByRole('button', { name: 'Корректировать остаток…' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Сумма, ₽').fill('500');
  await dlg.getByRole('button', { name: 'Сохранить' }).click();
  await expect(dlg.getByRole('alert')).toHaveText('Укажите причину – без неё не сохранить.');
  await dlg.getByLabel('Причина корректировки').fill('Ошибка кассира при погашении');
  await dlg.getByRole('button', { name: 'Увеличить' }).click();
  await dlg.getByLabel('Сумма, ₽').fill('2000');
  await dlg.getByRole('button', { name: 'Сохранить' }).click();
  await expect(dlg.getByRole('alert')).toHaveText('Остаток после корректировки больше номинала');
  await dlg.getByLabel('Сумма, ₽').fill('500');
  await dlg.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByRole('status')).toHaveText('Остаток скорректирован на +500,00 ₽.');
  await expect(page.getByTestId('cert-balance')).toHaveText('4 000,00 ₽');
  await expect(page.getByTestId('cert-timeline')).toContainText('Ошибка кассира при погашении');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: `${SHOTS}/certificate-card-1440.png`, fullPage: true });
});

test('Отмена продажи окном внутри записи: причина обязательна, возврат денег – в журнале кассы', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await openCard(page, 'YC-7K2M-9QXD');
  await expect(page.getByTestId('cert-term')).toContainText('Осталось дней:');
  await page.getByRole('button', { name: 'Отменить продажу…' }).click();
  const dlg = page.getByRole('dialog');
  await expect(dlg.getByLabel(/Вернуть 3\s000,00\s₽ покупателю из кассы \(наличные\)/)).toBeChecked();
  await dlg.getByRole('button', { name: 'Отменить продажу' }).click();
  await expect(dlg.getByRole('alert')).toHaveText('Укажите причину – без неё не сохранить.');
  await dlg.getByLabel('Причина отмены').fill('Клиент вернул сертификат в день покупки');
  await dlg.getByRole('button', { name: 'Отменить продажу' }).dblclick();
  await expect(page.getByRole('status')).toContainText('Продажа отменена');
  await expect(page.getByTestId('cert-status')).toHaveText('Продажа отменена');
  await expect(page.getByTestId('cert-balance')).toHaveText('0,00 ₽');
  await expect(page.getByTestId('cert-cancel-reason')).toHaveText('Причина отмены: Клиент вернул сертификат в день покупки');
  await expect(page.getByRole('button', { name: 'Отменить продажу…' })).toHaveCount(0);
  await open(page, '/finance/b-nsk-krasny');
  await expect(page.getByTestId('fin-journal').locator('tbody tr').filter({ hasText: 'Отмена продажи сертификата YC-7K2M-9QXD' })).toHaveCount(1);
});

test('Директор: только своя зона, чужой сертификат – 404', async ({ page, request }) => {
  await login(page, 'director@yu.test');
  await open(page, '/certificates');
  await expect(rows(page)).toHaveCount(4);
  await expect(page.getByTestId('cert-YC-5T7V-1XYZ')).toHaveCount(0);
  // id томского сертификата – из ответа мока Владельцу
  const owner = await request.post(`${MOCK}/api/crm/v1/auth/login`, { data: { email: 'owner@yu.test', password: MOCK_PASSWORD } });
  const cookie = owner.headers()['set-cookie']!.split(';')[0]!;
  const all = await (await request.get(`${MOCK}/api/crm/v1/certificates?q=5T7V`, { headers: { cookie } })).json() as { items: Array<{ id: string }> };
  expect((await page.goto(`/certificates/${all.items[0]!.id}`))?.status()).toBe(404);
});

test('Администратор: видит сертификаты филиала, отмены и корректировки нет', async ({ page }) => {
  await login(page, 'admin@yu.test');
  await open(page, '/certificates');
  await expect(rows(page)).toHaveCount(4);
  await openCard(page, 'YC-4H8P-2RTW');
  await expect(page.getByRole('button', { name: 'Отменить продажу…' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Корректировать остаток…' })).toHaveCount(0);
  await expect(page.getByText('Отмену продажи и корректировку остатка делают Директор и Владелец.')).toBeVisible();
});

test('390 px: список и карточка без горизонтальной прокрутки, ссылки и кнопки ≥ 44 px', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, 'owner@yu.test');
  await open(page, '/certificates');
  expect(await noHorizontalScroll(page)).toBe(true);
  expect((await page.getByRole('link', { name: 'YC-4H8P-2RTW' }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect((await page.getByRole('button', { name: 'Найти' }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: `${SHOTS}/certificates-list-390.png`, fullPage: true });
  await openCard(page, 'YC-4H8P-2RTW');
  expect(await noHorizontalScroll(page)).toBe(true);
  expect((await page.getByRole('button', { name: 'Корректировать остаток…' }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: `${SHOTS}/certificate-card-390.png`, fullPage: true });
});

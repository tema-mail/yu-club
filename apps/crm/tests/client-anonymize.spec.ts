// Обезличивание клиента в CRM (K9, K11 №249, D4-60…D4-65): кнопку видит только Владелец (client.anonymize);
// окно – необратимость, что стирается, основание кодом; 200 – «Клиент обезличен» и карточка без ПДн, повтор – alreadyAnonymized;
// 409 CLIENT_HAS_ACTIVE_RECORDS – понятный текст про будущие брони и мероприятия; Администратору кнопки нет, API – 403.
import { expect, test, type Page } from '../../../tests/support/e2e.ts';
import { MOCK_PASSWORD } from './mock-api.ts';

const MOCK = process.env.MOCK_URL ?? 'http://127.0.0.1:4012';
const OLGA = 'c0000000-0000-4000-8000-000000000001'; // брони впереди и праздник в работе
const MARIA = 'c0000000-0000-4000-8000-000000000003'; // одна будущая бронь bk-tsk, мероприятий нет

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

const anonymizeButton = (page: Page) => page.getByRole('button', { name: 'Обезличить', exact: true });

test('409: у клиента будущие брони и праздник – понятный отказ, данные на месте', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await page.goto(`/clients/${OLGA}`);
  await anonymizeButton(page).click();
  const dialog = page.getByRole('dialog', { name: /Обезличить клиента/ });
  await expect(dialog).toContainText('Действие необратимо');
  await expect(dialog).toContainText('телефон, email, дата рождения');
  await dialog.getByRole('button', { name: 'Обезличить навсегда' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Выберите основание.');
  await dialog.getByLabel('По просьбе клиента').check();
  await dialog.getByRole('button', { name: 'Обезличить навсегда' }).click();
  await expect(dialog.getByRole('alert')).toContainText('есть будущие брони или мероприятия в работе (броней: 2, мероприятий: 1)');
  await dialog.getByRole('button', { name: 'Не обезличивать' }).click();
  await page.reload();
  await expect(page.getByTestId('client-status')).toHaveText('Активен');
  await expect(page.getByTestId('client-full')).toContainText('olga@yu.test');
});

test('Владелец обезличивает: окно, основание, «Клиент обезличен», карточка без ПДн; повтор – alreadyAnonymized', async ({ page }) => {
  await login(page, 'owner@yu.test');
  // Сначала отменить единственную живую бронь клиента – иначе 409 (D4-63).
  const bk = (await (await page.request.get('/api/crm/v1/bookings/bk-tsk')).json()) as { rowVersion: number };
  const reasons = (await (await page.request.get('/api/crm/v1/dictionaries/reasons?domain=booking_cancel_club')).json()) as { items: Array<{ id: string; code: string }> };
  const reasonId = reasons.items.find((r) => r.code === 'equipment_failure')!.id;
  const cancel = await page.request.post('/api/crm/v1/bookings/bk-tsk/cancel', {
    headers: { 'idempotency-key': crypto.randomUUID() }, data: { rowVersion: bk.rowVersion, initiator: 'club', reasonId, comment: 'Отмена перед обезличиванием' },
  });
  expect(cancel.status()).toBe(200);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/clients/${MARIA}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Кузнецова Мария');
  await anonymizeButton(page).click();
  const dialog = page.getByRole('dialog', { name: 'Обезличить клиента Кузнецова Мария?' });
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await dialog.getByLabel('Истёк срок хранения данных').check();
  await dialog.getByRole('button', { name: 'Обезличить навсегда' }).click();

  await expect(page).toHaveURL(new RegExp(`/clients/${MARIA}\\?anonymized=1$`));
  await expect(page.getByTestId('client-anonymized')).toContainText('Клиент обезличен');
  await expect(page.getByTestId('client-status')).toHaveText('Обезличен');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Без имени');
  await expect(anonymizeButton(page)).toHaveCount(0);
  const html = await page.content();
  for (const pd of ['maria@yu.test', '+79230001122', 'Кузнецова']) expect(html).not.toContain(pd);

  const again = await page.request.post(`/api/crm/v1/clients/${MARIA}/anonymize`, {
    headers: { 'idempotency-key': crypto.randomUUID() }, data: { reason: 'client_request' },
  });
  expect(again.status()).toBe(200);
  expect(await again.json()).toEqual({ clientId: MARIA, status: 'anonymized', alreadyAnonymized: true, affected: {} });
});

test('Повтор из открытого окна (уже обезличен другим запросом) – тоже «Клиент обезличен»', async ({ page, request }) => {
  expect((await request.post(`${MOCK}/__test/reset`)).ok()).toBe(true);
  await login(page, 'owner@yu.test');
  const bk = (await (await page.request.get('/api/crm/v1/bookings/bk-tsk')).json()) as { rowVersion: number };
  const reasons = (await (await page.request.get('/api/crm/v1/dictionaries/reasons?domain=booking_cancel_club')).json()) as { items: Array<{ id: string; code: string }> };
  await page.request.post('/api/crm/v1/bookings/bk-tsk/cancel', {
    headers: { 'idempotency-key': crypto.randomUUID() },
    data: { rowVersion: bk.rowVersion, initiator: 'club', reasonId: reasons.items.find((r) => r.code === 'equipment_failure')!.id, comment: 'Отмена' },
  });
  await page.goto(`/clients/${MARIA}`);
  await anonymizeButton(page).click();
  const first = await page.request.post(`/api/crm/v1/clients/${MARIA}/anonymize`, { headers: { 'idempotency-key': crypto.randomUUID() }, data: { reason: 'client_request' } });
  expect(((await first.json()) as { alreadyAnonymized: boolean }).alreadyAnonymized).toBe(false);
  const dialog = page.getByRole('dialog', { name: /Обезличить клиента/ });
  await dialog.getByLabel('По просьбе клиента').check();
  await dialog.getByRole('button', { name: 'Обезличить навсегда' }).click();
  await expect(page.getByTestId('client-anonymized')).toContainText('Клиент обезличен');
  await expect(page.getByTestId('client-status')).toHaveText('Обезличен');
});

test('Администратор: кнопки нет, прямой запрос – 403', async ({ page, request }) => {
  expect((await request.post(`${MOCK}/__test/reset`)).ok()).toBe(true);
  await login(page, 'admin@yu.test');
  await page.goto(`/clients/${OLGA}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Смирнова Ольга');
  await expect(anonymizeButton(page)).toHaveCount(0);
  await expect(page.getByTestId('client-anonymize')).toHaveCount(0);
  const r = await page.request.post(`/api/crm/v1/clients/${OLGA}/anonymize`, { headers: { 'idempotency-key': crypto.randomUUID() }, data: { reason: 'client_request' } });
  expect(r.status()).toBe(403);
  expect(((await r.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');
});

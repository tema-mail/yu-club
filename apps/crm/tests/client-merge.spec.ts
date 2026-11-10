// Слияние дублей в CRM (03 §11.2, K9 «Слияние», K11 №251–252, D5-01…D5-08): кнопку «Объединить с…» видит только Владелец
// (client.merge); вторая карточка – поиском; предпросмотр «было / стало» с конфликтами – опасное действие с подтверждением
// (04 §10.4: галочка «один человек» и основание кодом); итог – основная с отметкой, старая карточка – факт объединения со
// ссылкой, без ПДн; поиск по старому телефону её не находит; повтор – 409. Гость основной – нельзя, карточки меняются местами.
import { expect, test, type Page } from '../../../tests/support/e2e.ts';
import { MOCK_PASSWORD } from './mock-api.ts';

const MOCK = process.env.MOCK_URL ?? `http://127.0.0.1:${process.env.E2E_PORT_BASE ?? 4012}`;
const OLGA = 'c0000000-0000-4000-8000-000000000001'; // активна, Красный
const IVAN = 'c0000000-0000-4000-8000-000000000002'; // гость, Красный, +7 ••• ••• ••-43

test.describe.configure({ mode: 'serial' });
test.beforeEach(async ({ request }) => {
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

const mergeButton = (page: Page) => page.getByRole('button', { name: 'Объединить с…' });

async function pick(page: Page, q: string, label: RegExp) {
  await mergeButton(page).click();
  const dialog = page.getByRole('dialog', { name: /Объединить карточку/ });
  await dialog.getByLabel('Вторая карточка').fill(q);
  await dialog.getByRole('button', { name: 'Найти' }).click();
  await dialog.getByTestId('merge-found').getByRole('button', { name: label }).click();
}

test('Владелец объединяет: поиск, «было / стало», подтверждение, основание; старая карточка – факт объединения', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/clients/${OLGA}`);
  await pick(page, 'Петров', /Петров Иван/);

  const preview = page.getByTestId('merge-preview');
  await expect(preview).toBeVisible();
  await expect(preview.getByTestId('merge-primary')).toHaveText('Смирнова Ольга');
  await expect(preview.getByTestId('merge-secondary')).toHaveText('Петров Иван');
  await expect(preview.getByTestId('merge-modules')).toContainText('Брони впереди');
  await expect(preview.getByTestId('merge-modules')).toContainText('Баллы');
  await expect(preview.getByTestId('merge-conflicts')).toContainText('Имя: Ольга (основная) / Иван (вторая)');
  await expect(preview.getByTestId('merge-conflicts')).toContainText('Статус: Активен (основная) / Гость (вторая)');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  await preview.getByRole('button', { name: 'Объединить навсегда' }).click();
  await expect(preview.getByRole('alert')).toHaveText('Подтвердите, что это один и тот же человек.');
  await preview.getByLabel('Я проверил: это один и тот же человек').check();
  await preview.getByRole('button', { name: 'Объединить навсегда' }).click();
  await expect(preview.getByRole('alert')).toHaveText('Выберите основание.');
  await preview.getByLabel('Повторная регистрация').check();
  await preview.getByRole('button', { name: 'Объединить навсегда' }).click();

  await expect(page).toHaveURL(new RegExp(`/clients/${OLGA}\\?merged=${IVAN}$`));
  await expect(page.getByTestId('client-merge-done')).toContainText('Карточки объединены');
  await expect(page.getByTestId('client-status')).toHaveText('Активен');

  await page.goto(`/clients/${IVAN}`);
  await expect(page.getByTestId('client-status')).toHaveText('Объединён');
  await expect(page.getByTestId('client-merged')).toContainText('Карточка объединена');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Без имени');
  await expect(page.getByTestId('client-full')).toHaveCount(0);
  await expect(mergeButton(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Обезличить', exact: true })).toHaveCount(0);
  const html = await page.content();
  for (const pd of ['+79139876543', 'Петров']) expect(html).not.toContain(pd);
  await page.getByTestId('client-merged').getByRole('link', { name: 'Перейти к основной карточке' }).click();
  await expect(page).toHaveURL(new RegExp(`/clients/${OLGA}$`));

  // поиск: по старому телефону и фамилии – нет, по id – факт объединения
  const byPhone = (await (await page.request.get(`/api/crm/v1/clients?q=${encodeURIComponent('+79139876543')}`)).json()) as { items: unknown[] };
  expect(byPhone.items).toEqual([]);
  const byId = (await (await page.request.get(`/api/crm/v1/clients?q=${IVAN}`)).json()) as { items: Array<{ id: string; status: string }> };
  expect(byId.items).toEqual([expect.objectContaining({ id: IVAN, status: 'merged' })]);
  const again = await page.request.post(`/api/crm/v1/clients/${OLGA}/merge`, { headers: { 'idempotency-key': crypto.randomUUID() }, data: { secondaryId: IVAN, reason: 'same_person_confirmed' } });
  expect(again.status()).toBe(409);
  expect(((await again.json()) as { error: { code: string } }).error.code).toBe('CLIENT_MERGED');
});

test('гость основной при зарегистрированной второй – нельзя; «Сделать основной другую карточку» исправляет', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await page.goto(`/clients/${IVAN}`);
  await pick(page, 'Смирнова', /Смирнова Ольга/);
  const preview = page.getByTestId('merge-preview');
  await expect(preview.getByTestId('merge-primary')).toHaveText('Петров Иван');
  await expect(preview).toContainText('Основной должна быть зарегистрированная карточка');
  await expect(preview.getByRole('button', { name: 'Объединить навсегда' })).toBeDisabled();
  await preview.getByRole('button', { name: 'Сделать основной другую карточку' }).click();
  await expect(preview.getByTestId('merge-primary')).toHaveText('Смирнова Ольга');
  await expect(preview.getByRole('button', { name: 'Объединить навсегда' })).toBeEnabled();
  await preview.getByLabel('Я проверил: это один и тот же человек').check();
  await preview.getByLabel('Клиент подтвердил, что это он').check();
  await preview.getByRole('button', { name: 'Объединить навсегда' }).click();
  await expect(page).toHaveURL(new RegExp(`/clients/${OLGA}\\?merged=${IVAN}$`));
});

test('Администратор: кнопки нет, прямые запросы – 403', async ({ page }) => {
  await login(page, 'admin@yu.test');
  await page.goto(`/clients/${OLGA}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Смирнова Ольга');
  await expect(mergeButton(page)).toHaveCount(0);
  await expect(page.getByTestId('client-merge')).toHaveCount(0);
  const prev = await page.request.get(`/api/crm/v1/clients/${OLGA}/merge-preview?with=${IVAN}`);
  expect(prev.status()).toBe(403);
  const r = await page.request.post(`/api/crm/v1/clients/${OLGA}/merge`, { headers: { 'idempotency-key': crypto.randomUUID() }, data: { secondaryId: IVAN, reason: 'same_person_confirmed' } });
  expect(r.status()).toBe(403);
  expect(((await r.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');
});

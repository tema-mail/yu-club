// Делегирование прав (S3-87) на моке mock-staff.ts (по staff/grants.ts, №380–382): Владелец выдаёт право со сроком из закрытого списка,
// видит действующие, истёкшие и отозванные, отзывает; client.merge – с пометкой; неделегируемое не предлагается и сервером отклоняется (422);
// зона вне назначений – 422, повтор на те же даты – 409, себе – 403; Директору блока нет, сервер – 403.
import { expect, test, type Page } from '../../../tests/support/e2e.ts';
import { MOCK_PASSWORD } from './mock-api.ts';

const MOCK = process.env.MOCK_URL ?? 'http://127.0.0.1:4012';
const DELEGABLE = ['block.manage', 'network.hours.manage', 'finance.income.create', 'finance.expense.create',
  'equipment.view.accounts', 'client.merge', 'shift.manage', 'payroll.view', 'network.branch.create'];

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
const post = (page: Page, path: string, data: unknown, key: string | null = crypto.randomUUID()) =>
  page.request.post(`/api/crm/v1${path}`, { data, headers: key ? { 'idempotency-key': key } : {} });
const today = async (page: Page) => (await page.locator('#grant-from').inputValue());

test('Владелец: выдать со сроком, повтор отклонён, отозвать; истёкшее – в архиве списка', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, '/staff/s-director');
  const block = page.getByTestId('staff-grants');
  await expect(block).toBeVisible();
  await expect(page.getByTestId('grants-current-empty')).toBeVisible();
  await expect(page.getByTestId('grants-past').getByTestId('grant-row')).toHaveCount(1);
  await expect(page.getByTestId('grants-past')).toContainText('Просмотр зарплаты');
  await expect(page.getByTestId('grants-past')).toContainText('Истекло');

  await block.getByRole('button', { name: 'Выдать право' }).click();
  const form = page.getByTestId('grant-form');
  // Только закрытый список сервера: 9 прав + «Выберите».
  const values = await form.locator('#grant-action option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value).filter(Boolean));
  expect(values).toEqual(DELEGABLE);
  expect(values).not.toContain('client.view.full');

  await form.getByRole('button', { name: 'Выдать' }).click();
  await expect(form.getByRole('alert')).toContainText('Выберите право');
  await form.getByLabel('Право').selectOption('client.merge');
  await expect(page.getByTestId('grant-action-hint')).toContainText('Заработает, когда появится слияние клиентов');
  // Директор назначен на Новосибирск: город и два его филиала, Томска нет.
  const zones = await form.locator('#grant-zone option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value).filter(Boolean));
  expect(zones).toEqual(['c-nsk', 'b-nsk-krasny', 'b-nsk-akadem']);
  await form.getByLabel('Где действует').selectOption('b-nsk-krasny');
  const from = await today(page);
  await form.getByLabel('Действует по').fill('2099-12-31');
  await form.getByLabel('Причина').fill('Отпуск Владельца');
  await form.getByRole('button', { name: 'Выдать' }).click();
  await expect(page.getByTestId('grant-notice')).toContainText('выдано');
  const current = page.getByTestId('grants-current');
  await expect(current.getByTestId('grant-row')).toHaveCount(1);
  await expect(current).toContainText('Объединение карточек клиентов');
  await expect(current.getByTestId('grant-merge-note')).toContainText('слияние клиентов');
  await expect(current).toContainText('по 31.12.2099');
  await expect(current).toContainText('Действует');

  const list = (await (await page.request.get('/api/crm/v1/staff/grants?staffId=s-director')).json()) as { items: Array<Record<string, unknown>> };
  expect(list.items[0]).toMatchObject({ staffId: 's-director', action: 'client.merge', branchId: 'b-nsk-krasny', cityId: null, validFrom: from, validTo: '2099-12-31', grantedBy: 's-owner', revokedAt: null });

  // То же право в той же зоне на пересекающиеся даты – 409 от сервера, текст в форме.
  await block.getByRole('button', { name: 'Выдать право' }).click();
  await form.getByLabel('Право').selectOption('client.merge');
  await form.getByLabel('Где действует').selectOption('b-nsk-krasny');
  await form.getByRole('button', { name: 'Выдать' }).click();
  await expect(form.getByRole('alert')).toContainText('уже выдано');
  // Создание филиалов – только на город.
  await form.getByLabel('Право').selectOption('network.branch.create');
  const cityOnly = await form.locator('#grant-zone option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value).filter(Boolean));
  expect(cityOnly).toEqual(['c-nsk']);
  await form.getByRole('button', { name: 'Отмена' }).click();

  await current.getByRole('button', { name: 'Отозвать' }).click();
  const rf = page.getByTestId('revoke-form');
  await expect(rf).toContainText('Объединение карточек клиентов');
  await rf.getByRole('button', { name: 'Отозвать' }).click();
  await expect(page.getByTestId('grant-notice')).toContainText('отозвано');
  await expect(page.getByTestId('grants-current-empty')).toBeVisible();
  await expect(page.getByTestId('grants-past').getByTestId('grant-row')).toHaveCount(2);
  await expect(page.getByTestId('grants-past')).toContainText('Отозвано');
});

test('Сервер: неделегируемое – 422, зона вне назначений – 422, себе – 403, без ключа – 400, повтор ключа – тот же ответ', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, '/staff/s-admin');
  await expect(page.getByTestId('grants-past')).toContainText('Внесение доходов');
  await expect(page.getByTestId('grants-past')).toContainText('Отозвано');
  const from = await page.getByTestId('staff-grants').evaluate(() => new Date().toISOString().slice(0, 10));

  const notDelegable = await post(page, '/staff/s-admin/grants', { action: 'client.view.full', branchId: 'b-nsk-krasny', validFrom: from });
  expect(notDelegable.status()).toBe(422);
  expect(((await notDelegable.json()) as { error: { code: string } }).error.code).toBe('GRANT_ACTION_NOT_DELEGABLE');
  const outside = await post(page, '/staff/s-admin/grants', { action: 'block.manage', branchId: 'b-tsk-lenina', validFrom: from });
  expect(outside.status()).toBe(422);
  expect(((await outside.json()) as { error: { code: string } }).error.code).toBe('GRANT_SCOPE_INVALID');
  const self = await post(page, '/staff/s-owner/grants', { action: 'block.manage', cityId: 'c-nsk', validFrom: from });
  expect(self.status()).toBe(403);
  const noKey = await post(page, '/staff/s-admin/grants', { action: 'block.manage', branchId: 'b-nsk-krasny', validFrom: from }, null);
  expect(noKey.status()).toBe(400);
  const past = await post(page, '/staff/s-admin/grants', { action: 'block.manage', branchId: 'b-nsk-krasny', validFrom: '2020-01-01' });
  expect(past.status()).toBe(400);

  const key = crypto.randomUUID();
  const body = { action: 'block.manage', branchId: 'b-nsk-krasny', validFrom: from };
  const first = await post(page, '/staff/s-admin/grants', body, key);
  expect(first.status()).toBe(201);
  const again = await post(page, '/staff/s-admin/grants', body, key);
  expect(again.status()).toBe(201);
  expect(((await again.json()) as { id: string }).id).toBe(((await first.json()) as { id: string }).id);
  const list = (await (await page.request.get('/api/crm/v1/staff/grants?staffId=s-admin')).json()) as { items: unknown[] };
  expect(list.items).toHaveLength(2);
});

test('Директор: блока нет, список и выдача – 403; на своей карточке Владельца блока нет', async ({ page }) => {
  await login(page, 'director@yu.test');
  await open(page, '/staff/s-admin');
  await expect(page.getByRole('heading', { name: 'Админова Анна' })).toBeVisible();
  await expect(page.getByTestId('staff-grants')).toHaveCount(0);
  expect((await page.request.get('/api/crm/v1/staff/grants')).status()).toBe(403);
  expect((await post(page, '/staff/s-admin/grants', { action: 'block.manage', branchId: 'b-nsk-krasny', validFrom: '2099-01-01' })).status()).toBe(403);

  await page.context().clearCookies();
  await login(page, 'owner@yu.test');
  await open(page, '/staff/s-owner');
  await expect(page.getByTestId('staff-grants')).toHaveCount(0);
});

// Штрафы, корректировки, выплата, расход (S3-75) на моке: TC-19 в интерфейсе – повтор нажатия даёт один расход, второй – PAYOUT_EXPENSE_EXISTS; штрафов нет при выключенном флаге
// (и сервер FEATURE_DISABLED), при включённом – подпись «юридическая допустимость не проверена», отмена и правка окном внутри записи; Директор – только с филиалом; корректировка – Владелец.
import { expect, test, type Page } from '../../../tests/support/e2e.ts';
import { MOCK_PASSWORD } from './mock-api.ts';

const MOCK = process.env.MOCK_URL ?? 'http://127.0.0.1:4012';
const SHOTS = process.env.SCREENSHOT_DIR ?? 'test-results/screens';
const key = () => ({ 'idempotency-key': crypto.randomUUID() });
const dayOf = (n: number) => new Date(Date.now() + n * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Novosibirsk' });

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
const row = (page: Page, id: string) => page.locator(`[data-testid="payroll-row"][data-staff="${id}"]`);
const pickClosed = (page: Page) => page.getByLabel('Период', { exact: true }).selectOption('p-closed');
async function setFlag(page: Page, value: boolean) {
  const r = await page.request.get('/api/crm/v1/settings?scope=network');
  const item = ((await r.json()) as { items: Array<{ key: string; rowVersion?: number; source: { valueId: string | null } }> }).items.find((i) => i.key === 'payroll.penalties_enabled')!;
  const put = await page.request.put('/api/crm/v1/settings/payroll.penalties_enabled?scope=network', { data: { value, validFrom: dayOf(0), rowVersion: item.rowVersion ?? null, reason: 'Тест' }, headers: key() });
  expect(put.ok()).toBe(true);
}

test('флаг выключен: штрафов нет ни в экране, ни на сервере', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, '/payroll');
  await row(page, 's-admin').getByRole('button', { name: 'Детализация' }).click();
  await expect(page.getByTestId('payroll-detail')).toBeVisible();
  await expect(page.getByTestId('legal-note')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Добавить штраф' })).toHaveCount(0);
  const res = await page.request.post('/api/crm/v1/payroll/penalties', { data: { staffId: 's-admin', branchId: 'b-nsk-krasny', date: dayOf(0), amountKop: 100, reason: 'x' }, headers: key() });
  expect(((await res.json()) as { error: { code: string } }).error.code).toBe('FEATURE_DISABLED');
});

test('TC-19: отметка выплаты и «Создать расход» с подтверждением – повтор нажатия даёт один расход', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, '/payroll');
  await pickClosed(page);
  await row(page, 's-admin').getByRole('button', { name: 'Детализация' }).click();
  await expect(page.getByTestId('statement-status')).toContainText('Готова к выплате');
  await expect(page.getByRole('button', { name: 'Создать расход' })).toHaveCount(0); // до выплаты расхода нет

  await page.getByRole('button', { name: 'Отметить выплату' }).click();
  const paid = page.getByTestId('paid-form');
  await expect(paid).toContainText('2 900,00 ₽'); // 480 мин × 300 ₽/ч + 500 ₽ за выход – ставка на дату смены
  await paid.getByRole('button', { name: 'Подтвердить выплату' }).click();
  await expect(page.getByTestId('payout-notice')).toContainText('Расход в кассу создаётся отдельно');
  await expect(page.getByTestId('statement-status')).toContainText('Выплачена');
  await expect(row(page, 's-admin').getByTestId('row-status')).toContainText('Выплачена');
  await expect(page.getByRole('button', { name: 'Отметить выплату' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Создать расход' }).click();
  const exp = page.getByTestId('expense-form');
  await exp.getByRole('button', { name: 'Создать расход' }).dblclick();
  await expect(page.getByTestId('payout-notice')).toContainText('Расход создан: Ю Клуб на Красном – 2 900,00 ₽');

  // повтор: второе нажатие кнопки и прямой вызов с новым ключом – второго расхода нет
  await page.getByRole('button', { name: 'Создать расход' }).click();
  await exp.getByRole('button', { name: 'Создать расход' }).click();
  await expect(page.getByTestId('payout-error')).toContainText('уже создан');
  const again = await page.request.post('/api/crm/v1/payroll/statements/st-admin/payout-expense', { data: { place: 'cash', method: 'cash', split: 'by_branch', occurredAt: new Date().toISOString() }, headers: key() });
  expect(again.status()).toBe(409);
  const body = (await again.json()) as { error: { code: string; details: { operationIds: string[] } } };
  expect(body.error.code).toBe('PAYOUT_EXPENSE_EXISTS');
  expect(body.error.details.operationIds).toHaveLength(1);
});

test('привязка ручного расхода: окно выбора операции кассы, сумма должна совпасть, второго расхода нет', async ({ page, request }) => {
  expect((await request.post(`${MOCK}/__test/reset`)).ok()).toBe(true);
  await login(page, 'owner@yu.test');
  const cats = (await (await page.request.get('/api/crm/v1/finance/categories?kind=expense')).json()) as { items: Array<{ id: string; name: string; children: Array<{ id: string; name: string }> }> };
  const top = cats.items.find((c) => c.name === 'Персонал')!;
  const sub = top.children.find((c) => c.name === 'Зарплата')!;
  const other = top.children.find((c) => c.name === 'Выплаты за смены')!;
  const expense = async (amountKop: number, comment: string) => {
    const r = await page.request.post('/api/crm/v1/branches/b-nsk-krasny/finance/expense', { data: { method: 'card', amountKop, categoryId: top.id, subcategoryId: sub.id, comment, occurredAt: new Date(Date.now() - 60_000).toISOString() }, headers: key() });
    expect(r.ok(), await r.text()).toBe(true);
    return ((await r.json()) as { id: string }).id;
  };
  const wrong = await expense(10_000, 'Аванс наличными');
  await expense(290_000, 'Зарплата Анне вручную');
  // Выдали из кассы другого филиала, ранним утром по его часам (в UTC это ещё вчера).
  const tsk = await page.request.post('/api/crm/v1/branches/b-tsk-lenina/finance/expense', { data: { method: 'cash', amountKop: 5_000, categoryId: top.id, subcategoryId: sub.id, comment: 'Ночная выдача', occurredAt: new Date(`${dayOf(0)}T01:00:00+07:00`).toISOString() }, headers: key() });
  expect(tsk.ok(), await tsk.text()).toBe(true);

  await open(page, '/payroll');
  await pickClosed(page);
  await row(page, 's-admin').getByRole('button', { name: 'Детализация' }).click();
  await expect(page.getByRole('button', { name: 'Привязать из кассы' })).toHaveCount(0); // до выплаты привязывать нечего
  await page.getByRole('button', { name: 'Отметить выплату' }).click();
  await page.getByTestId('paid-form').getByRole('button', { name: 'Подтвердить выплату' }).click();
  await expect(page.getByTestId('statement-status')).toContainText('Выплачена');

  await page.getByRole('button', { name: 'Привязать из кассы' }).click();
  const form = page.getByTestId('link-form');
  await expect(form.getByTestId('link-op')).toHaveCount(3); // только «Зарплата», в том числе из кассы другого филиала: коммунальные и закупки из засева не предлагаются
  await expect(form.getByTestId('link-op').filter({ hasText: 'Ю Клуб на Ленина' })).toHaveCount(1);
  await expect(form.getByTestId('link-op').filter({ hasText: 'Ночная выдача' })).toContainText(dayOf(0).split('-').reverse().join('.')); // дата – по суткам филиала, а не UTC
  const submit = form.getByRole('button', { name: 'Привязать', exact: true });
  await expect(submit).toBeDisabled();
  await form.getByTestId('link-op').filter({ hasText: 'Аванс наличными' }).getByRole('checkbox').check();
  await expect(form.getByTestId('link-sum')).toContainText('сумма должна совпасть');
  await expect(submit).toBeDisabled();
  // Прямой вызов мимо окна: та же сумма, другая категория – отказ сервера.
  const foreignOp = await page.request.post('/api/crm/v1/branches/b-nsk-krasny/finance/expense', { data: { method: 'cash', amountKop: 290_000, categoryId: top.id, subcategoryId: other.id, comment: 'Не зарплата', occurredAt: new Date(Date.now() - 60_000).toISOString() }, headers: key() });
  expect(foreignOp.ok(), await foreignOp.text()).toBe(true);
  const foreignId = ((await foreignOp.json()) as { id: string }).id;
  const denied = await page.request.post('/api/crm/v1/payroll/statements/st-admin/payout-expense/link', { data: { operationIds: [foreignId] }, headers: key() });
  expect([denied.status(), ((await denied.json()) as { error: { details: { reason: string } } }).error.details.reason]).toEqual([422, 'category']);
  const mismatch = await page.request.post('/api/crm/v1/payroll/statements/st-admin/payout-expense/link', { data: { operationIds: [wrong] }, headers: key() });
  expect([mismatch.status(), ((await mismatch.json()) as { error: { code: string } }).error.code]).toEqual([422, 'PAYOUT_AMOUNT_MISMATCH']);
  await form.getByTestId('link-op').filter({ hasText: 'Аванс наличными' }).getByRole('checkbox').uncheck();
  await form.getByTestId('link-op').filter({ hasText: 'Зарплата Анне вручную' }).getByRole('checkbox').check();
  await submit.click();
  await expect(form).toBeHidden();
  await expect(page.getByTestId('payout-notice')).toContainText('Расход привязан');
  await expect(page.getByTestId('payout-notice')).toContainText('2 900,00 ₽');

  // Привязанный расход и есть расход этой выплаты: новый не создаётся.
  await page.getByRole('button', { name: 'Создать расход' }).click();
  await page.getByTestId('expense-form').getByRole('button', { name: 'Создать расход' }).click();
  await expect(page.getByTestId('payout-error')).toContainText('уже создан');
});

test('закрытый период: статусы до выплаты, только корректировка в открытом периоде', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, '/payroll');
  await pickClosed(page);
  await expect(page.getByTestId('period-status')).toContainText('только корректировкой');
  await row(page, 's-admin-tsk').getByRole('button', { name: 'Детализация' }).click();
  await page.getByTestId('statement').getByRole('button', { name: 'Проверено' }).click();
  await expect(page.getByTestId('statement-status')).toContainText('Проверена');
  await page.getByTestId('statement').getByRole('button', { name: 'Готова к выплате' }).click();
  await expect(page.getByTestId('statement-status')).toContainText('Готова к выплате');

  await page.getByRole('button', { name: 'Корректировка' }).click();
  const form = page.getByTestId('penalty-form');
  await form.getByLabel('Сумма со знаком, ₽').fill('−150,25');
  await form.getByRole('button', { name: 'Подтвердить' }).click();
  await expect(page.getByTestId('penalty-form-error')).toContainText('причину');
  await form.getByLabel('Причина *').fill('Ошибка в часах');
  await form.getByRole('button', { name: 'Подтвердить' }).click();
  await expect(page.getByTestId('penalty-notice')).toContainText('−150,25 ₽');
  await expect(page.getByTestId('penalty-notice')).toContainText('в открытом периоде');

  await page.getByLabel('Период', { exact: true }).selectOption('p-open');
  await expect(row(page, 's-admin-tsk').getByTestId('row-corrections')).toContainText('−150,25 ₽');
});

test('Директор: корректировки и выплаты нет, сервер отказывает', async ({ page }) => {
  await login(page, 'director@yu.test');
  await open(page, '/payroll');
  await pickClosed(page);
  await row(page, 's-admin').getByRole('button', { name: 'Детализация' }).click();
  await expect(page.getByTestId('payroll-detail')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Корректировка' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Создать расход' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Привязать из кассы' })).toHaveCount(0);
  expect((await page.request.post('/api/crm/v1/payroll/corrections', { data: { staffId: 's-admin', amountKop: 100, ref: { type: 'payroll_statement', id: 'st-admin' }, reason: 'x' }, headers: key() })).status()).toBe(403);
  expect((await page.request.post('/api/crm/v1/payroll/statements/st-admin/paid', { data: { rowVersion: 1, actualPayoutDate: dayOf(0) }, headers: key() })).status()).toBe(403);
});

test('флаг включён: подпись, штраф, сторно окном внутри записи, правка; Директор – только с филиалом', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await setFlag(page, true);
  await page.context().clearCookies();
  await login(page, 'director@yu.test');
  await open(page, '/payroll');
  await row(page, 's-admin').getByRole('button', { name: 'Детализация' }).click();
  await expect(page.getByTestId('legal-note')).toContainText('Юридическая допустимость не проверена');
  await page.getByRole('button', { name: 'Добавить штраф' }).click();
  const form = page.getByTestId('penalty-form');
  await expect(form).toContainText('Юридическая допустимость не проверена');
  await expect(form.getByLabel('Филиал').locator('option', { hasText: 'Без филиала' })).toHaveCount(0);
  await form.getByLabel('Сумма, ₽').fill('500,50');
  await form.getByLabel('Причина *').fill('Опоздание');
  await form.getByRole('button', { name: 'Подтвердить' }).click();
  await expect(page.getByTestId('penalty-item')).toContainText('500,50 ₽');
  await expect(row(page, 's-admin').getByTestId('row-penalties')).toContainText('500,50 ₽');
  await expect(page.getByTestId('total-penalties')).toContainText('500,50 ₽');
  const noBranch = await page.request.post('/api/crm/v1/payroll/penalties', { data: { staffId: 's-admin', date: dayOf(0), amountKop: 100, reason: 'x' }, headers: key() });
  expect(((await noBranch.json()) as { error: { code: string } }).error.code).toBe('BRANCH_REQUIRED');

  await page.getByTestId('penalty-item').getByRole('button', { name: 'Исправить' }).click();
  await form.getByLabel('Сумма, ₽').fill('300');
  await form.getByLabel('Почему исправляете *').fill('Пересчитали минуты');
  await form.getByRole('button', { name: 'Подтвердить' }).click();
  await expect(page.getByTestId('penalty-item')).toHaveCount(2);
  await expect(page.locator('[data-testid="penalty-item"][data-status="cancelled"]')).toContainText('Пересчитали минуты');
  await expect(row(page, 's-admin').getByTestId('row-penalties')).toContainText('300,00 ₽');

  await page.locator('[data-testid="penalty-item"][data-status="active"]').getByRole('button', { name: 'Отменить' }).click();
  await form.getByRole('button', { name: 'Подтвердить' }).click();
  await expect(page.getByTestId('penalty-form-error')).toContainText('причину');
  await form.getByLabel('Причина отмены *').fill('Опоздание по вине клуба');
  await form.getByRole('button', { name: 'Подтвердить' }).click();
  await expect(page.locator('[data-testid="penalty-item"][data-status="cancelled"]')).toHaveCount(2);
  await expect(row(page, 's-admin').getByTestId('row-penalties')).toContainText('0,00 ₽');
});

for (const [w, h] of [[1440, 900], [390, 844]] as const) {
  test(`снимок выплаты и штрафов ${w} px без горизонтальной прокрутки`, async ({ browser, request }) => {
    expect((await request.post(`${MOCK}/__test/reset`)).ok()).toBe(true);
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: w === 390 ? 2 : 1 });
    const page = await ctx.newPage();
    await login(page, 'owner@yu.test');
    await setFlag(page, true);
    await open(page, '/payroll');
    await pickClosed(page);
    await row(page, 's-admin').getByRole('button', { name: 'Детализация' }).click();
    await page.getByRole('button', { name: 'Отметить выплату' }).click();
    await page.screenshot({ path: `${SHOTS}/s3-75-payout-${w}.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(w);
    await page.getByTestId('paid-form').getByRole('button', { name: 'Подтвердить выплату' }).click();
    await page.getByRole('button', { name: 'Привязать из кассы' }).click();
    await expect(page.getByTestId('link-empty')).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/s3-75-payout-link-${w}.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(w);
    await ctx.close();
  });
}

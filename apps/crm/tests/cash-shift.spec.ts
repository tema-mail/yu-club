// Кассовая смена (S2-62) на моке mock-shifts.ts: флаг выключен – блока нет; включён – Администратор открывает и
// закрывает с пересчётом вслепую (ни ожидаемого остатка, ни разницы ни на экране, ни в ответе API), расхождение –
// needs_resolution; при включённом флаге наличные без открытой смены – CASH_SHIFT_REQUIRED, в смене – с её shift_id.
// Директор решает (причина обязательна): «исправить ошибку» – корректировка на разницу, «принять пересчёт» – расход
// «Недостача кассы» / доход «Излишек кассы»; Администратор решать не может (403). 390 и 1440 px.
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { MOCK_PASSWORD } from './mock-api.ts';

const MOCK = process.env.MOCK_URL ?? 'http://127.0.0.1:4012';
const SHOTS = process.env.SCREENSHOT_DIR ?? 'test-results/screens';
const BRANCH = 'b-nsk-krasny'; // наличные в засеве: 10 000 + 3 000 + 2 000 − 300 = 14 700 ₽

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
/** finance.cash_shift_enabled филиала включает Владелец (уровень «филиал»). */
const cashExpense = async (page: Page) => {
  const cats = (await (await page.request.get('/api/crm/v1/finance/categories')).json()) as { items: Array<{ id: string; name: string }> };
  return page.request.post(`/api/crm/v1/branches/${BRANCH}/finance/expense`, {
    data: { method: 'cash', amountKop: 10000, categoryId: cats.items.find((c) => c.name === 'Прочее')!.id, comment: 'Мелкие расходы', occurredAt: new Date().toISOString() },
    headers: { 'idempotency-key': crypto.randomUUID() },
  });
};
async function setShiftFlag(request: APIRequestContext, value: boolean) {
  expect((await request.post(`${MOCK}/api/crm/v1/auth/login`, { data: { email: 'owner@yu.test', password: MOCK_PASSWORD } })).ok()).toBe(true);
  const st = (await (await request.get(`${MOCK}/api/crm/v1/settings?scope=branch&id=${BRANCH}`)).json()) as { scope: { today: string }; items: Array<{ key: string; rowVersion: string }> };
  const rowVersion = st.items.find((i) => i.key === 'finance.cash_shift_enabled')!.rowVersion;
  const r = await request.put(`${MOCK}/api/crm/v1/settings/finance.cash_shift_enabled?scope=branch&id=${BRANCH}`, {
    data: { value, validFrom: st.scope.today, rowVersion }, headers: { 'idempotency-key': crypto.randomUUID() },
  });
  expect(r.ok()).toBe(true);
}

test('флаг выключен – экрана смены нет', async ({ page }) => {
  await login(page, 'admin@yu.test');
  await open(page, '/finance');
  await expect(page.getByTestId('fin-scope')).toBeVisible();
  await expect(page.getByTestId('cash-shift')).toHaveCount(0);
  const cur = (await (await page.request.get(`/api/crm/v1/branches/${BRANCH}/cash-shifts/current`)).json()) as { enabled: boolean };
  expect(cur.enabled).toBe(false);
});

test('Администратор открывает и закрывает вслепую; расхождение ждёт решения; решать не может', async ({ page, request }) => {
  await setShiftFlag(request, true);
  await login(page, 'admin@yu.test');
  await open(page, '/finance');
  const box = page.getByTestId('cash-shift');
  await expect(box.getByTestId('shift-state')).toHaveText('Не открыта');
  const blocked = await cashExpense(page);
  expect(blocked.status()).toBe(409);
  expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe('CASH_SHIFT_REQUIRED');
  await box.getByRole('button', { name: 'Открыть смену' }).click();
  await expect(box.getByRole('alert').first()).toContainText('Введите пересчитанную сумму');
  await box.getByLabel('Пересчёт наличных при открытии, ₽').fill('14 700');
  await box.getByRole('button', { name: 'Открыть смену' }).click();
  await expect(box.getByTestId('shift-notice')).toHaveText('Смена открыта.');
  await expect(box.getByTestId('shift-state')).toContainText('Открыта с');
  await expect(box.getByTestId('shift-state')).toContainText('(вы)');
  await expect(box.getByTestId('shift-opening')).toHaveCount(0); // сумм Администратору нет
  const inShift = await cashExpense(page); // расход 100 ₽ в смене: в системе станет 14 600
  expect(inShift.status()).toBe(201);
  const shiftId = ((await (await page.request.get(`/api/crm/v1/branches/${BRANCH}/cash-shifts/current`)).json()) as { openShift: { shiftId: string } }).openShift.shiftId;
  expect(((await inShift.json()) as { shiftId: string }).shiftId).toBe(shiftId);

  await box.getByLabel('Пересчёт наличных при закрытии, ₽').fill('14 550');
  await box.getByRole('button', { name: 'Закрыть смену' }).click();
  await expect(box.getByTestId('shift-notice')).toHaveText('Смена закрыта. Пересчёт передан Директору: если есть расхождение, он его разберёт.');
  await expect(box).not.toContainText('14 700');
  await expect(box.getByTestId('shift-state')).toHaveText('Не открыта');
  const list = (await (await page.request.get(`/api/crm/v1/branches/${BRANCH}/cash-shifts`)).json()) as { items: Array<Record<string, unknown>> };
  expect(list.items).toHaveLength(1);
  expect(list.items[0]!.status).toBe('needs_resolution');
  expect(list.items[0]).not.toHaveProperty('closingExpectedKop');
  expect(list.items[0]).not.toHaveProperty('closingDiffKop');
  await expect(box.getByTestId('shift-pending')).toHaveCount(0);
  const denied = await page.request.post(`/api/crm/v1/cash-shifts/${list.items[0]!.shiftId as string}/resolve`, {
    data: { action: 'accept', reason: 'сам решу' }, headers: { 'idempotency-key': crypto.randomUUID() },
  });
  expect(denied.status()).toBe(403);

  await page.setViewportSize({ width: 390, height: 844 });
  await box.locator('summary').click();
  await expect(box.getByTestId('shift-list')).toContainText('Расхождение – ждёт решения');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await box.screenshot({ path: `${SHOTS}/cash-shift-admin-390.png` });
});

test('Директор: «исправить ошибку» – корректировка; «принять пересчёт» – излишек доходом; сошлось – закрыта', async ({ page }) => {
  await login(page, 'director@yu.test');
  await open(page, `/finance/${BRANCH}`);
  const box = page.getByTestId('cash-shift');
  const pending = box.getByTestId('shift-pending');
  await expect(pending).toContainText('насчитано 14 550,00 ₽, в системе 14 600,00 ₽, разница −50,00 ₽');
  await pending.getByRole('button', { name: 'Решить…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Решение по расхождению' });
  await expect(dlg.getByRole('radio', { name: 'Принять пересчёт: недостача 50,00 ₽ – расходом «Недостача кассы»' })).toBeChecked();
  await dlg.getByRole('radio', { name: /Исправить ошибку: нашли ошибочную операцию – корректировка кассы на −50,00 ₽/ }).check();
  await dlg.getByRole('button', { name: 'Сохранить решение' }).click();
  await expect(dlg.getByRole('alert')).toHaveText('Укажите причину – без неё решение не сохранить.');
  await dlg.getByLabel('Причина *').fill('Расход 50 ₽ провели дважды – исправлено');
  await page.setViewportSize({ width: 1440, height: 900 });
  await dlg.screenshot({ path: `${SHOTS}/cash-shift-resolve-1440.png` });
  await dlg.getByRole('button', { name: 'Сохранить решение' }).click();
  await expect(box.getByTestId('shift-notice')).toHaveText('Ошибка исправлена: корректировка кассы на −50,00 ₽.');
  await expect(box.getByTestId('shift-pending')).toHaveCount(0);
  const ops = (await (await page.request.get(`/api/crm/v1/branches/${BRANCH}/finance/operations?limit=200`)).json()) as { items: Array<{ kind: string; amountKop: number; direction: string; shiftId: string | null }> };
  const corr = ops.items.filter((o) => o.kind === 'correction');
  expect(corr).toHaveLength(1);
  expect(corr[0]).toMatchObject({ amountKop: 5000, direction: 'out' });
  expect(corr[0]!.shiftId).not.toBeNull();

  // новая смена: в системе теперь 14 550; при закрытии насчитали больше – принять пересчёт (излишек доходом)
  await box.getByLabel('Пересчёт наличных при открытии, ₽').fill('14 550');
  await box.getByRole('button', { name: 'Открыть смену' }).click();
  await expect(box.getByTestId('shift-opening')).toHaveText('При открытии пересчитано 14 550,00 ₽, в системе было 14 550,00 ₽ – сошлось.');
  await box.getByLabel('Пересчёт наличных при закрытии, ₽').fill('14 600,00');
  await box.getByRole('button', { name: 'Закрыть смену' }).click();
  await expect(box.getByTestId('shift-notice')).toHaveText('Смена закрыта с расхождением +50,00 ₽ (в системе 14 550,00 ₽). Нужно решение.');
  await box.getByTestId('shift-pending').getByRole('button', { name: 'Решить…' }).click();
  await expect(dlg.getByRole('radio', { name: 'Принять пересчёт: излишек 50,00 ₽ – доходом «Излишек кассы»' })).toBeChecked();
  await dlg.getByLabel('Причина *').fill('Сдача из прошлой смены, проверено');
  await dlg.getByRole('button', { name: 'Сохранить решение' }).click();
  await expect(box.getByTestId('shift-notice')).toHaveText('Пересчёт принят: излишек 50,00 ₽ – доходом «Излишек кассы».');
  const ops2 = (await (await page.request.get(`/api/crm/v1/branches/${BRANCH}/finance/operations?limit=200`)).json()) as { items: Array<{ kind: string; source: string | null; amountKop: number; ref: { type: string } | null }> };
  expect(ops2.items.filter((o) => o.kind === 'correction')).toHaveLength(1);
  expect(ops2.items.filter((o) => o.kind === 'income' && o.ref?.type === 'shift')).toMatchObject([{ source: 'other', amountKop: 5000 }]);

  await box.getByLabel('Пересчёт наличных при открытии, ₽').fill('14 600');
  await box.getByRole('button', { name: 'Открыть смену' }).click();
  await box.getByLabel('Пересчёт наличных при закрытии, ₽').fill('14 600');
  await box.getByRole('button', { name: 'Закрыть смену' }).click();
  await expect(box.getByTestId('shift-notice')).toHaveText('Смена закрыта: пересчёт сошёлся.');
  await box.locator('summary').click();
  await expect(box.getByTestId('shift-list').locator('li')).toHaveCount(3);
  await expect(box.getByTestId('shift-list')).toContainText('пересчёт принят: Сдача из прошлой смены, проверено');
  await box.screenshot({ path: `${SHOTS}/cash-shift-director-1440.png` });
});

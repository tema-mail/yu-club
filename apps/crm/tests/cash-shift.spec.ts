// Кассовая смена (S2-62) на моке mock-shifts.ts: флаг выключен – блока нет; включён – Администратор открывает и
// закрывает с пересчётом вслепую (ни ожидаемого остатка, ни разницы ни на экране, ни в ответе API), расхождение –
// needs_resolution; Директор решает: корректировка на разницу (операция кассы) или «принято без проводки», причина
// обязательна; Администратор решать не может (403). 390 и 1440 px.
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
  await box.getByRole('button', { name: 'Открыть смену' }).click();
  await expect(box.getByRole('alert').first()).toContainText('Введите пересчитанную сумму');
  await box.getByLabel('Пересчёт наличных при открытии, ₽').fill('14 700');
  await box.getByRole('button', { name: 'Открыть смену' }).click();
  await expect(box.getByTestId('shift-notice')).toHaveText('Смена открыта.');
  await expect(box.getByTestId('shift-state')).toContainText('Открыта с');
  await expect(box.getByTestId('shift-state')).toContainText('(вы)');
  await expect(box.getByTestId('shift-opening')).toHaveCount(0); // сумм Администратору нет

  await box.getByLabel('Пересчёт наличных при закрытии, ₽').fill('14 650');
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

test('Директор: корректировка на разницу; затем расхождение «принято без проводки»; сошлось – закрыта', async ({ page }) => {
  await login(page, 'director@yu.test');
  await open(page, `/finance/${BRANCH}`);
  const box = page.getByTestId('cash-shift');
  const pending = box.getByTestId('shift-pending');
  await expect(pending).toContainText('насчитано 14 650,00 ₽, в системе 14 700,00 ₽, разница −50,00 ₽');
  await pending.getByRole('button', { name: 'Решить…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Решение по расхождению' });
  await expect(dlg.getByRole('radio', { name: 'Провести корректировку кассы на −50,00 ₽' })).toBeChecked();
  await dlg.getByRole('button', { name: 'Сохранить решение' }).click();
  await expect(dlg.getByRole('alert')).toHaveText('Укажите причину – без неё решение не сохранить.');
  await dlg.getByLabel('Причина *').fill('Недостача при пересчёте, объяснительная');
  await page.setViewportSize({ width: 1440, height: 900 });
  await dlg.screenshot({ path: `${SHOTS}/cash-shift-resolve-1440.png` });
  await dlg.getByRole('button', { name: 'Сохранить решение' }).click();
  await expect(box.getByTestId('shift-notice')).toHaveText('Проведена корректировка кассы на −50,00 ₽.');
  await expect(box.getByTestId('shift-pending')).toHaveCount(0);
  const ops = (await (await page.request.get(`/api/crm/v1/branches/${BRANCH}/finance/operations?limit=200`)).json()) as { items: Array<{ kind: string; amountKop: number; direction: string; shiftId: string | null }> };
  const corr = ops.items.filter((o) => o.kind === 'correction');
  expect(corr).toHaveLength(1);
  expect(corr[0]).toMatchObject({ amountKop: 5000, direction: 'out' });
  expect(corr[0]!.shiftId).not.toBeNull();

  // новая смена: в системе теперь 14 650; при закрытии насчитали больше – принять без проводки
  await box.getByLabel('Пересчёт наличных при открытии, ₽').fill('14 650');
  await box.getByRole('button', { name: 'Открыть смену' }).click();
  await expect(box.getByTestId('shift-opening')).toHaveText('При открытии пересчитано 14 650,00 ₽, в системе было 14 650,00 ₽ – сошлось.');
  await box.getByLabel('Пересчёт наличных при закрытии, ₽').fill('14 700,00');
  await box.getByRole('button', { name: 'Закрыть смену' }).click();
  await expect(box.getByTestId('shift-notice')).toHaveText('Смена закрыта с расхождением +50,00 ₽ (в системе 14 650,00 ₽). Нужно решение.');
  await box.getByTestId('shift-pending').getByRole('button', { name: 'Решить…' }).click();
  await dlg.getByRole('radio', { name: 'Принять без проводки' }).check();
  await dlg.getByLabel('Причина *').fill('Сдача из прошлой смены, проверено');
  await dlg.getByRole('button', { name: 'Сохранить решение' }).click();
  await expect(box.getByTestId('shift-notice')).toHaveText('Расхождение принято без проводки.');
  const ops2 = (await (await page.request.get(`/api/crm/v1/branches/${BRANCH}/finance/operations?limit=200`)).json()) as { items: Array<{ kind: string }> };
  expect(ops2.items.filter((o) => o.kind === 'correction')).toHaveLength(1);

  await box.getByLabel('Пересчёт наличных при открытии, ₽').fill('14 650');
  await box.getByRole('button', { name: 'Открыть смену' }).click();
  await box.getByLabel('Пересчёт наличных при закрытии, ₽').fill('14 650');
  await box.getByRole('button', { name: 'Закрыть смену' }).click();
  await expect(box.getByTestId('shift-notice')).toHaveText('Смена закрыта: пересчёт сошёлся.');
  await box.locator('summary').click();
  await expect(box.getByTestId('shift-list').locator('li')).toHaveCount(3);
  await expect(box.getByTestId('shift-list')).toContainText('без проводки: Сдача из прошлой смены, проверено');
  await box.screenshot({ path: `${SHOTS}/cash-shift-director-1440.png` });
});

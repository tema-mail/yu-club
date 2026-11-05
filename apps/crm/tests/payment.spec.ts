// Оплата в карточке брони (S2-63) на моке mock-payments.ts: до прихода оплаты нет (и API – BOOKING_NOT_PAYABLE),
// после прихода – способы от сервера; наличные двойным кликом – один платёж; баллов мало – видно сколько нужно;
// сертификат: неверный код – понятный отказ, 5-й – блок, 6-я попытка – тоже блок; при выключенной доплате второй
// строки нет (TC-07), при включённой – весь остаток + карта; возврат частичный и полный с причиной; после полного
// возврата – повторная оплата баллами, где резерв этой брони учитывается сервером. 1440 и 390 px.
import { expect, test, type APIRequestContext, type Page } from '../../../tests/support/e2e.ts';
import { MOCK_PASSWORD } from './mock-api.ts';

const MOCK = process.env.MOCK_URL ?? 'http://127.0.0.1:4012';
const SHOTS = process.env.SCREENSHOT_DIR ?? 'test-results/screens';
const BRANCH = 'b-nsk-krasny';
const B1 = 'b0000000-0000-4000-8000-000000000001'; // ПК 2, идёт сейчас, 300 ₽, Ольга (баллы 45, резерв этой брони 6)
const B2 = 'b0000000-0000-4000-8000-000000000002'; // VR1, прошла без отметки, 1000 ₽
const C1 = 'c0000000-0000-4000-8000-000000000001';

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
const post = (page: Page, path: string, data: unknown) =>
  page.request.post(`/api/crm/v1${path}`, { data, headers: { 'idempotency-key': crypto.randomUUID() } });
const payment = async (page: Page, id: string) => (await (await page.request.get(`/api/crm/v1/bookings/${id}/payment`)).json()) as {
  payment: { attempt: number; status: string; lines: Array<{ method: string; amountKop: number }> } | null; allowedMethods: string[];
};

/** Сертификат продаёт Директор через API: номер и код приходят один раз. */
async function sell(page: Page, nominalKop: number) {
  const r = await post(page, `/branches/${BRANCH}/certificates`, { nominalKop, method: 'cash' });
  expect(r.status()).toBe(201);
  const b = (await r.json()) as { certificate: { number: string }; pin: string };
  return { number: b.certificate.number, pin: b.pin };
}
/** «Сертификат + доплата» (R-03) включает Владелец на уровне сети. */
async function setTopup(request: APIRequestContext, value: boolean) {
  expect((await request.post(`${MOCK}/api/crm/v1/auth/login`, { data: { email: 'owner@yu.test', password: MOCK_PASSWORD } })).ok()).toBe(true);
  const st = (await (await request.get(`${MOCK}/api/crm/v1/settings?scope=network`)).json()) as { scope: { today: string }; items: Array<{ key: string; rowVersion: string }> };
  const rowVersion = st.items.find((i) => i.key === 'payment.certificate_topup_enabled')!.rowVersion;
  const r = await request.put(`${MOCK}/api/crm/v1/settings/payment.certificate_topup_enabled?scope=network`, {
    data: { value, validFrom: st.scope.today, rowVersion }, headers: { 'idempotency-key': crypto.randomUUID() },
  });
  expect(r.ok()).toBe(true);
}

test('Администратор: до прихода – нельзя; после – наличные двойным кликом, один платёж; баллов мало; возврата нет', async ({ page }) => {
  await login(page, 'admin@yu.test');
  await open(page, `/bookings/${B1}`);
  const pay = page.getByTestId('payment');
  await expect(pay.getByTestId('pay-status')).toHaveText('Не оплачено');
  await expect(pay.getByTestId('pay-wait')).toContainText('Оплата – после прихода клиента');
  await expect(pay.getByTestId('pay-form')).toHaveCount(0);
  const early = await post(page, `/bookings/${B1}/payment`, { lines: [{ method: 'cash', amountKop: 30000 }] });
  expect(early.status()).toBe(409);
  expect(((await early.json()) as { error: { code: string } }).error.code).toBe('BOOKING_NOT_PAYABLE');

  await page.getByRole('button', { name: 'Отметить приход' }).click();
  const form = pay.getByTestId('pay-form');
  await expect(form.getByTestId('pay-due')).toHaveText('300,00 ₽');
  await expect(form.getByTestId('points-short')).toContainText('нужно 90 баллов, доступно 45 баллов');
  await expect(form.getByRole('radio', { name: 'Баллы' })).toBeDisabled();
  await expect(form.getByRole('button', { name: /Провести оплату/ })).toBeDisabled();
  await form.getByRole('radio', { name: 'Наличные' }).check();
  await form.getByLabel('Чек пробит').check();
  await form.getByRole('button', { name: 'Провести оплату · 300,00 ₽' }).dblclick();
  await expect(pay.getByTestId('pay-notice')).toContainText('Оплата проведена: 300,00 ₽');
  await expect(pay.getByTestId('pay-status')).toHaveText('Оплачено');
  await expect(pay.getByTestId('pay-line')).toHaveText('Наличные – 300,00 ₽');
  await expect(pay.getByRole('button', { name: 'Вернуть оплату…' })).toHaveCount(0);

  const p = await payment(page, B1);
  expect(p.payment?.attempt).toBe(1);
  expect(p.allowedMethods).toEqual([]);
  const ops = (await (await page.request.get(`/api/crm/v1/branches/${BRANCH}/finance/operations?limit=200`)).json()) as { items: Array<{ source: string | null; amountKop: number; receiptIssued: boolean | null }> };
  const session = ops.items.filter((o) => o.source === 'session' && o.amountKop === 30000);
  expect(session).toHaveLength(1);
  expect(session[0]!.receiptIssued).toBe(true);
  const again = await post(page, `/bookings/${B1}/payment`, { lines: [{ method: 'cash', amountKop: 30000 }] });
  expect(((await again.json()) as { error: { code: string } }).error.code).toBe('ALREADY_PAID');
  const refund = await post(page, `/payments/${crypto.randomUUID()}/refund`, { rowVersion: 1, lines: [{ lineNo: 1 }], reason: 'тест' });
  expect(refund.status()).toBe(404);

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await noHorizontalScroll(page)).toBe(true);
  await pay.screenshot({ path: `${SHOTS}/payment-paid-390.png` });
});

test('Сертификат: неверный код – отказ, 5-й – блок, 6-я – блок; доплата выключена – второй строки нет, включена – остаток + карта', async ({ page, request }) => {
  await login(page, 'director@yu.test');
  await open(page, `/bookings/${B2}`);
  await page.getByRole('button', { name: 'Отметить приход' }).click();
  const pay = page.getByTestId('payment');
  const form = pay.getByTestId('pay-form');
  await expect(form.getByTestId('pay-due')).toHaveText('1 000,00 ₽');
  await form.getByRole('radio', { name: 'Сертификат' }).check();

  const locked = await sell(page, 50000);
  await form.getByLabel('Номер сертификата').fill(locked.number);
  const wrong = locked.pin === '0000' ? '1111' : '0000';
  await form.getByLabel('Код (4 цифры)').fill('12');
  await form.getByRole('button', { name: 'Проверить сертификат' }).click();
  await expect(form.getByTestId('cert-error')).toHaveText('Код – 4 цифры из сертификата.');
  await form.getByLabel('Код (4 цифры)').fill(wrong);
  for (let i = 1; i <= 4; i++) {
    await form.getByRole('button', { name: 'Проверить сертификат' }).click();
    await expect(form.getByTestId('cert-error')).toHaveText('Сертификат не найден или код неверен. Проверьте номер и 4 цифры кода.');
  }
  await form.getByRole('button', { name: 'Проверить сертификат' }).click();
  await expect(form.getByTestId('cert-error')).toContainText('Слишком много неверных кодов: проверка этого сертификата заблокирована на 15 мин.');
  await expect(form.getByRole('button', { name: 'Проверить сертификат' })).toBeDisabled();
  const sixth = await post(page, '/certificates/check', { branchId: BRANCH, number: locked.number, pin: locked.pin });
  expect(sixth.status()).toBe(429);
  expect(((await sixth.json()) as { error: { code: string } }).error.code).toBe('CERTIFICATE_PIN_LOCKED');

  // доплата выключена (по умолчанию): 500 ₽ на 1000 ₽ – сертификатом не оплатить, второй строки нет
  const half = await sell(page, 50000);
  await open(page, `/bookings/${B2}`);
  await form.getByRole('radio', { name: 'Сертификат' }).check();
  await form.getByLabel('Номер сертификата').fill(half.number);
  await form.getByLabel('Код (4 цифры)').fill(half.pin);
  await form.getByRole('button', { name: 'Проверить сертификат' }).click();
  await expect(form.getByTestId('cert-ok')).toContainText('остаток 500,00 ₽');
  await expect(form.getByTestId('cert-short')).toContainText('Доплата к сертификату выключена');
  await expect(form.getByTestId('cert-topup')).toHaveCount(0);
  await expect(form.getByRole('button', { name: /Провести оплату/ })).toBeDisabled();
  const mixed = await post(page, `/bookings/${B2}/payment`, { lines: [{ method: 'certificate', amountKop: 50000, certificate: half }, { method: 'cash', amountKop: 50000 }] });
  expect(((await mixed.json()) as { error: { code: string } }).error.code).toBe('PAYMENT_METHODS_COMBINED');

  await setTopup(request, true);
  await open(page, `/bookings/${B2}`);
  await form.getByRole('radio', { name: 'Сертификат' }).check();
  await form.getByLabel('Номер сертификата').fill(half.number);
  await form.getByLabel('Код (4 цифры)').fill(half.pin);
  await form.getByRole('button', { name: 'Проверить сертификат' }).click();
  await expect(form.getByTestId('cert-topup')).toContainText('Спишется весь остаток 500,00 ₽, доплата 500,00 ₽');
  await form.getByLabel('Способ доплаты').selectOption('card');
  await form.getByRole('button', { name: 'Провести оплату · 1 000,00 ₽' }).click();
  await expect(pay.getByTestId('pay-status')).toHaveText('Оплачено');
  await expect(pay.getByTestId('pay-line')).toHaveText(['Сертификат – 500,00 ₽', 'Карта – 500,00 ₽']);
  await setTopup(request, false);
});

test('Возврат: частичный денег с причиной, затем полный; повторная оплата баллами с резервом этой брони', async ({ page }) => {
  await login(page, 'director@yu.test');
  await open(page, `/bookings/${B2}`);
  const pay = page.getByTestId('payment');
  await pay.getByRole('button', { name: 'Вернуть оплату…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Вернуть оплату?' });
  await dlg.getByRole('radio', { name: 'Часть денег' }).check();
  await dlg.getByLabel('Сумма возврата, ₽').fill('600');
  await dlg.getByLabel('Причина *').fill('Клиент ушёл раньше');
  await dlg.getByRole('button', { name: /^Вернуть/ }).click();
  await expect(dlg.getByRole('alert')).toHaveText('Введите сумму от 0,01 до 500,00 ₽.');
  await dlg.getByLabel('Сумма возврата, ₽').fill('200');
  await dlg.getByLabel('Причина *').fill('');
  await dlg.getByRole('button', { name: 'Вернуть 200,00 ₽' }).click();
  await expect(dlg.getByRole('alert')).toContainText('Укажите причину возврата');
  await dlg.getByLabel('Причина *').fill('Клиент ушёл раньше');
  await expect(dlg.getByTestId('refund-diff')).toContainText('вернётся 200,00 ₽, останется оплачено 800,00 ₽');
  await page.setViewportSize({ width: 390, height: 844 });
  await dlg.screenshot({ path: `${SHOTS}/payment-refund-390.png` });
  await dlg.getByRole('button', { name: 'Вернуть 200,00 ₽' }).dblclick();
  await expect(pay.getByTestId('pay-status')).toHaveText('Оплачено, часть возвращена');
  await expect(pay.getByTestId('pay-refunds')).toContainText('Возврат 200,00 ₽ · Карта');
  await expect(pay.getByTestId('pay-refunds')).toContainText('Причина: Клиент ушёл раньше');
  await expect(pay.getByTestId('pay-refunds').locator('li')).toHaveCount(1);

  await pay.getByRole('button', { name: 'Вернуть оплату…' }).click();
  await expect(dlg.getByRole('radio', { name: 'Всё, что осталось: 800,00 ₽' })).toBeChecked();
  await dlg.getByLabel('Причина *').fill('Сеанс не состоялся');
  await dlg.getByRole('button', { name: 'Вернуть 800,00 ₽' }).click();
  await expect(pay.getByTestId('pay-status')).toHaveText('Возвращено полностью');
  await expect(pay.getByTestId('pay-refunds').locator('li')).toHaveCount(3);
  await expect(pay.getByTestId('pay-form')).toBeVisible(); // сеанс снова к оплате (attempt 2)
  await page.setViewportSize({ width: 1440, height: 900 });
  await pay.screenshot({ path: `${SHOTS}/payment-refunded-1440.png` });

  // B1: полный возврат наличных, +45 баллов Ольге – с резервом этой брони (6) хватает ровно на 90
  await open(page, `/bookings/${B1}`);
  await pay.getByRole('button', { name: 'Вернуть оплату…' }).click();
  await dlg.getByLabel('Причина *').fill('Оплатит баллами');
  await dlg.getByRole('button', { name: 'Вернуть 300,00 ₽' }).click();
  await expect(pay.getByTestId('pay-status')).toHaveText('Возвращено полностью');
  expect((await post(page, `/clients/${C1}/loyalty/adjust`, { deltaCenti: 4500, reason: 'Бонус за отзыв' })).status()).toBe(201);
  await open(page, `/bookings/${B1}`);
  const form = pay.getByTestId('pay-form');
  await form.getByRole('radio', { name: 'Баллы' }).check();
  await form.getByRole('button', { name: 'Провести оплату · 300,00 ₽' }).click();
  await expect(pay.getByTestId('pay-line')).toHaveText('Баллы – 90 баллов (300,00 ₽)');
  expect((await payment(page, B1)).payment?.attempt).toBe(2);
});

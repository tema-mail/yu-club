// S2-82 в CRM: контрольные сценарии 18 §6.3, которые видны в интерфейсе, сквозным путём на моке (mock-payments.ts,
// mock-certificates.ts, mock-finance.ts, mock-loyalty.ts): приход → оплата → возврат, сертификат от продажи до остатка,
// баллы оплатой и возвратом, журнал кассы. Полный путь с журналом K3, партиями и штрафом – tests/finance/commerce-e2e.test.ts
// (мок не начисляет баллы и не ставит штрафы: п.7 и п.8 здесь – только то, что показывает карточка клиента).
//   п.1 двойной клик – один платёж; п.2 один способ (R-03 выключен по умолчанию, Q-24); п.3 сверх остатка; п.4 истёкший –
//   карточка «Истёк, остаток сгорел» (код засеянного сертификата мок не выдаёт – отказ оплаты истёкшим проверяет API);
//   п.5 частичное погашение; п.6 продажа и погашение – одно поступление; п.8 −50 и блок записи; п.9 возврат баллов;
//   п.10 возврат не стирает первичный платёж и операцию кассы.
import { expect, test, type Page } from '../../../tests/support/e2e.ts';
import { MOCK_PASSWORD } from './mock-api.ts';

const MOCK = process.env.MOCK_URL ?? 'http://127.0.0.1:4012';
const SHOTS = process.env.SCREENSHOT_DIR ?? 'test-results/screens';
const BRANCH = 'b-nsk-krasny';
const B1 = 'b0000000-0000-4000-8000-000000000001'; // ПК 2, идёт сейчас, 300 ₽, Ольга (45 баллов, резерв этой брони 6)
const B2 = 'b0000000-0000-4000-8000-000000000002'; // VR1, прошла без отметки, 1000 ₽
const OLGA = 'c0000000-0000-4000-8000-000000000001';
const IVAN = 'c0000000-0000-4000-8000-000000000002'; // −50

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
const post = (page: Page, path: string, data: unknown) => page.request.post(`/api/crm/v1${path}`, { data, headers: { 'idempotency-key': crypto.randomUUID() } });
const errCode = async (r: Awaited<ReturnType<typeof post>>) => ((await r.json()) as { error: { code: string } }).error.code;
interface Op { id: string; kind: string; source: string | null; amountKop: number; ref: { type: string; id: string } | null }
const ops = async (page: Page) => ((await (await page.request.get(`/api/crm/v1/branches/${BRANCH}/finance/operations?limit=200`)).json()) as { items: Op[] }).items;
const paymentOf = async (page: Page, id: string) => (await (await page.request.get(`/api/crm/v1/bookings/${id}/payment`)).json()) as {
  payment: { id: string; attempt: number; status: string; lines: Array<{ method: string; amountKop: number }> } | null; allowedMethods: string[]; pointsAvailableCenti: number | null;
};
async function sell(page: Page, nominalKop: number) {
  const r = await post(page, `/branches/${BRANCH}/certificates`, { nominalKop, method: 'card' });
  expect(r.status()).toBe(201);
  const b = (await r.json()) as { certificate: { id: string; number: string }; pin: string };
  return { id: b.certificate.id, number: b.certificate.number, pin: b.pin };
}
async function refundAll(page: Page, reason: string, sum: string) {
  const pay = page.getByTestId('payment');
  await pay.getByRole('button', { name: 'Вернуть оплату…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Вернуть оплату?' });
  await dlg.getByLabel('Причина *').fill(reason);
  await dlg.getByRole('button', { name: `Вернуть ${sum}` }).click();
  await expect(pay.getByTestId('pay-status')).toHaveText('Возвращено полностью');
}

test('п.1 и п.10: двойной клик – один платёж и одна операция кассы; возврат – новые записи, первичный платёж виден', async ({ page }) => {
  await login(page, 'director@yu.test');
  await open(page, `/bookings/${B1}`);
  const pay = page.getByTestId('payment');
  await page.getByRole('button', { name: 'Отметить приход' }).click();
  const form = pay.getByTestId('pay-form');
  await form.getByRole('radio', { name: 'Наличные' }).check();
  const before = (await ops(page)).length;
  await form.getByRole('button', { name: 'Провести оплату · 300,00 ₽' }).dblclick();
  await expect(pay.getByTestId('pay-status')).toHaveText('Оплачено');
  const paid = await paymentOf(page, B1);
  expect([paid.payment?.attempt, paid.allowedMethods]).toEqual([1, []]);
  const session = (await ops(page)).filter((o) => o.source === 'session' && o.ref?.id === paid.payment!.id);
  expect([session.length, (await ops(page)).length - before]).toEqual([1, 1]);
  expect(await errCode(await post(page, `/bookings/${B1}/payment`, { lines: [{ method: 'cash', amountKop: 30_000 }] }))).toBe('ALREADY_PAID');

  // исправление прихода по сеансу – только возвратом (сторно сеанса Владельцу – USE_PAYMENT_REFUND, проверяет API-тест)
  await refundAll(page, 'Оплатит баллами', '300,00 ₽');
  await expect(pay.getByTestId('pay-line')).toHaveText('Наличные – 300,00 ₽');
  await expect(pay.getByTestId('pay-refunds')).toContainText('Возврат 300,00 ₽ · Наличные');
  const after = await ops(page);
  expect(after.filter((o) => o.id === session[0]!.id)).toHaveLength(1);
  expect(after.filter((o) => o.kind === 'refund' && o.ref?.id === session[0]!.id).map((o) => o.amountKop)).toEqual([30_000]);
  await expect(pay.getByTestId('pay-form')).toBeVisible(); // сеанс снова к оплате – оплата №2
});

test('п.9: оплата баллами и её возврат – баллы снова доступны той же записи; касса не меняется', async ({ page }) => {
  await login(page, 'director@yu.test');
  expect((await post(page, `/clients/${OLGA}/loyalty/adjust`, { deltaCenti: 4_500, reason: 'Бонус за отзыв' })).status()).toBe(201);
  await open(page, `/bookings/${B1}`);
  const pay = page.getByTestId('payment');
  const form = pay.getByTestId('pay-form');
  const before = (await ops(page)).length;
  const available = (await paymentOf(page, B1)).pointsAvailableCenti;
  await form.getByRole('radio', { name: 'Баллы' }).check();
  await form.getByRole('button', { name: 'Провести оплату · 300,00 ₽' }).click();
  await expect(pay.getByTestId('pay-line')).toHaveText('Баллы – 90 баллов (300,00 ₽)');
  expect((await paymentOf(page, B1)).payment?.attempt).toBe(2);
  await refundAll(page, 'Клиент передумал', '300,00 ₽');
  const back = await paymentOf(page, B1);
  expect(back.pointsAvailableCenti).toBe(available); // баллы вернулись целиком
  expect(back.allowedMethods).toContain('points');
  await expect(form.getByRole('radio', { name: 'Баллы' })).toBeEnabled();
  expect((await ops(page)).length).toBe(before); // баллы – не деньги кассы
});

test('п.2, п.3, п.5, п.6: сертификат – один способ, сверх остатка нельзя, частичное погашение, одно поступление в кассу', async ({ page }) => {
  await login(page, 'director@yu.test');
  await open(page, `/bookings/${B2}`);
  await page.getByRole('button', { name: 'Отметить приход' }).click();
  const pay = page.getByTestId('payment');
  const form = pay.getByTestId('pay-form');

  // п.2/п.3: 500 ₽ на 1000 ₽ – не хватает, доплаты нет (R-03 выключен), кнопка недоступна, API отказывает
  const small = await sell(page, 50_000);
  await form.getByRole('radio', { name: 'Сертификат' }).check();
  await form.getByLabel('Номер сертификата').fill(small.number);
  await form.getByLabel('Код (4 цифры)').fill(small.pin);
  await form.getByRole('button', { name: 'Проверить сертификат' }).click();
  await expect(form.getByTestId('cert-short')).toContainText('Остатка 500,00 ₽ не хватает на 1 000,00 ₽');
  await expect(form.getByTestId('cert-topup')).toHaveCount(0);
  await expect(form.getByRole('button', { name: /Провести оплату/ })).toBeDisabled();
  const cert = { number: small.number, pin: small.pin };
  expect(await errCode(await post(page, `/bookings/${B2}/payment`, { lines: [{ method: 'certificate', amountKop: 100_000, certificate: cert }] }))).toBe('CERTIFICATE_INSUFFICIENT');
  expect(await errCode(await post(page, `/bookings/${B2}/payment`, { lines: [{ method: 'certificate', amountKop: 50_000, certificate: cert }, { method: 'cash', amountKop: 50_000 }] }))).toBe('PAYMENT_METHODS_COMBINED');
  expect(await errCode(await post(page, `/bookings/${B2}/payment`, { lines: [{ method: 'cash', amountKop: 50_000 }, { method: 'card', amountKop: 50_000 }] }))).toBe('PAYMENT_METHODS_COMBINED');
  expect((await paymentOf(page, B2)).payment).toBeNull();

  // п.5/п.6: 1500 ₽ – спишется 1000 ₽, останется 500 ₽; в кассе – только продажа
  const big = await sell(page, 150_000);
  const sales = (await ops(page)).filter((o) => o.source === 'certificate_sale' && o.ref?.id === big.id);
  expect(sales.map((o) => o.amountKop)).toEqual([150_000]);
  const before = (await ops(page)).length;
  await open(page, `/bookings/${B2}`);
  await form.getByRole('radio', { name: 'Сертификат' }).check();
  await form.getByLabel('Номер сертификата').fill(big.number);
  await form.getByLabel('Код (4 цифры)').fill(big.pin);
  await form.getByRole('button', { name: 'Проверить сертификат' }).click();
  await expect(form.getByTestId('cert-ok')).toContainText('остаток 1 500,00 ₽');
  await expect(form.getByTestId('cert-ok')).toContainText('Остатка хватает – спишется сумма сеанса.');
  await form.getByRole('button', { name: 'Провести оплату · 1 000,00 ₽' }).dblclick();
  await expect(pay.getByTestId('pay-status')).toHaveText('Оплачено');
  await expect(pay.getByTestId('pay-line')).toHaveText('Сертификат – 1 000,00 ₽');
  expect((await ops(page)).length).toBe(before); // погашение – не денежное поступление
  await page.setViewportSize({ width: 390, height: 844 });
  await pay.screenshot({ path: `${SHOTS}/commerce-cert-paid-390.png` });
  await page.setViewportSize({ width: 1440, height: 900 });

  await open(page, `/certificates/${big.id}`);
  await expect(page.getByTestId('cert-status')).toHaveText('Частично использован');
  await expect(page.getByTestId('cert-balance')).toHaveText('500,00 ₽');
  await expect(page.getByTestId('cert-redemptions')).toContainText('1 000,00 ₽');
  await expect(page.getByTestId('cert-redemptions').locator('tbody tr')).toHaveCount(1); // двойной клик – одно погашение
});

test('п.4 и п.8: истёкший сертификат – «Истёк», остаток сгорел; −50 – запись заблокирована', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, '/certificates?q=YC-2B6C-8DFG');
  await page.getByRole('link', { name: 'YC-2B6C-8DFG' }).click();
  await expect(page.getByTestId('cert-status')).toHaveText('Истёк');
  await expect(page.getByTestId('cert-balance')).toHaveText('0,00 ₽');
  await expect(page.getByText('Срок истёк, неиспользованный остаток сгорел.')).toBeVisible();
  await expect(page.locator('body')).toContainText('Сгорание по сроку');

  await open(page, `/clients/${IVAN}`);
  await expect(page.getByTestId('loy-balance')).toHaveText('−50 баллов');
  await expect(page.getByTestId('loy-blocked')).toContainText('Предварительная запись временно недоступна');
  await expect(page.getByTestId('loy-history').locator('tbody tr').filter({ hasText: 'Штраф' })).toHaveCount(1);
});

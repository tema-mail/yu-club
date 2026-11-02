// «К оплате» на рабочем столе (S2-64) на моке mock-payments.ts: до прихода записи в списке нет, пришедший без оплаты –
// есть (время по зоне филиала, браузер – в Москве), после оплаты в карточке и возврата «Назад» – исчезает, после полного
// возврата – снова в списке с пометкой; 390 px без горизонтальной прокрутки.
import { expect, test, type Page } from '@playwright/test';
import { MOCK_PASSWORD } from './mock-api.ts';

const MOCK = process.env.MOCK_URL ?? 'http://127.0.0.1:4012';
const SHOTS = process.env.SCREENSHOT_DIR ?? 'test-results/screens';
const B1 = 'b0000000-0000-4000-8000-000000000001';
const TZ = 'Asia/Novosibirsk';

test.use({ timezoneId: 'Europe/Moscow' });
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
const post = (page: Page, path: string, data: unknown) =>
  page.request.post(`/api/crm/v1${path}`, { data, headers: { 'idempotency-key': crypto.randomUUID() } });
const hm = (iso: string) => new Intl.DateTimeFormat('ru-RU', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));

test('пришедший без оплаты – в списке; после оплаты исчезает; после полного возврата – снова', async ({ page }) => {
  await login(page, 'admin@yu.test');
  await open(page, '/schedule');
  const list = page.getByTestId('desk-unpaid');
  await expect(list).toContainText('Все пришедшие сегодня оплатили.');

  expect((await post(page, `/bookings/${B1}/arrive`, { rowVersion: 1 })).ok()).toBe(true);
  const card = (await (await page.request.get(`/api/crm/v1/bookings/${B1}`)).json()) as { number: number; start: string; end: string };
  await open(page, '/schedule');
  const row = list.getByTestId('unpaid-row');
  await expect(row).toHaveCount(1);
  // время по зоне филиала (Новосибирск), хотя браузер в Москве
  await expect(row).toContainText(`№${card.number} · ${hm(card.start)}–${hm(card.end)} · ПК 2`);
  await expect(row).toContainText('к оплате 300,00 ₽');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await list.screenshot({ path: `${SHOTS}/unpaid-desk-390.png` });

  await row.getByRole('link').click();
  await expect(page).toHaveURL(new RegExp(`/bookings/${B1}`));
  const form = page.getByTestId('pay-form');
  await form.getByRole('radio', { name: 'Карта' }).check();
  await form.getByRole('button', { name: 'Провести оплату · 300,00 ₽' }).click();
  await expect(page.getByTestId('pay-status')).toHaveText('Оплачено');
  await page.goBack();
  await expect(list.getByTestId('unpaid-row')).toHaveCount(0);
  await expect(list).toContainText('Все пришедшие сегодня оплатили.');
});

test('после полного возврата запись снова к оплате, с пометкой', async ({ page }) => {
  await login(page, 'director@yu.test');
  const info = (await (await page.request.get(`/api/crm/v1/bookings/${B1}/payment`)).json()) as { payment: { id: string }; session: { rowVersion: number } };
  const r = await post(page, `/payments/${info.payment.id}/refund`, { rowVersion: info.session.rowVersion, lines: [{ lineNo: 1 }], reason: 'Ошиблись способом' });
  expect(r.status()).toBe(201);
  await open(page, '/schedule?branch=b-nsk-krasny');
  const row = page.getByTestId('desk-unpaid').getByTestId('unpaid-row');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('после возврата');
});

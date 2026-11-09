// S4-126: согласие на рекламу с версией документа. Галочка при входе – пустая, со ссылкой на /advertising-consent/, необязательная;
// в журнале согласий – живая document_version; в настройках так же; документа нет – галочки и переключателя рекламы нет.
import { expect, test, type APIRequestContext, type Page } from '../../../tests/support/e2e.ts';
import { MOCK_PORT, STAGE_PORT } from '../playwright.config.ts';
import { MOCK_CODE } from './mock-api.ts';

test.use({ baseURL: `http://localhost:${STAGE_PORT}` });
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const VERSION = 'advertising-consent-2026-11-01';
const newPhone = () => `913${String(Math.floor(1_000_000 + Math.random() * 8_999_999))}`;
const setDoc = (request: APIRequestContext, on: boolean) => request.post(`${MOCK}/__mock/content`, { data: { advertisingConsent: on } });
const journal = async (request: APIRequestContext, phone: string) =>
  ((await (await request.get(`${MOCK}/__test/consents`)).json()) as Array<{ phone: string; granted: boolean; documentVersion: string | null; source: string }>).filter((x) => x.phone === `+7${phone}`);

async function toCode(page: Page, phone: string) {
  await page.goto('/login/?next=/account/');
  await page.getByLabel('Телефон').fill(phone);
  await page.getByRole('button', { name: 'Получить код' }).click();
  await page.getByLabel('Код из SMS').fill(MOCK_CODE);
}
async function finish(page: Page) {
  await page.getByLabel(/согласие на обработку/).check();
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(/^[^?]*\/account\/$/);
}

test.afterEach(async ({ request }) => {
  await setDoc(request, true);
});

test('вход: галочка рекламы пустая, со ссылкой, не обязательна; отмеченная – в журнале живая версия', async ({ page, request }) => {
  const phone = newPhone();
  await toCode(page, phone);
  const box = page.getByLabel(/согласие на получение рекламных сообщений/);
  await expect(box).not.toBeChecked();
  await expect(page.locator('#code-form a[href="/advertising-consent/"]')).toBeVisible();
  await box.check();
  await finish(page);
  expect(await journal(request, phone)).toEqual([expect.objectContaining({ granted: true, documentVersion: VERSION, source: 'site' })]);
  await expect(page.getByTestId('notifications').getByLabel(/Реклама и акции/)).toBeChecked();
});

test('вход без галочки рекламы – записи о рекламе нет, реклама выключена; в настройках включение пишет живую версию', async ({ page, request }) => {
  const phone = newPhone();
  await toCode(page, phone);
  await finish(page);
  expect(await journal(request, phone)).toEqual([]);
  const toggle = page.getByTestId('notifications').getByLabel(/Реклама и акции/);
  await expect(toggle).not.toBeChecked();
  await expect(page.getByTestId('notifications').locator('a[href="/advertising-consent/"]')).toBeVisible();
  await toggle.check();
  await expect(toggle).toBeEnabled();
  await expect.poll(() => journal(request, phone)).toEqual([expect.objectContaining({ granted: true, documentVersion: VERSION, source: 'account' })]);
});

test('документа нет: при входе галочки рекламы нет, в настройках переключателя нет', async ({ page, request }) => {
  await setDoc(request, false);
  const phone = newPhone();
  await toCode(page, phone);
  await expect(page.getByLabel(/согласие на получение рекламных сообщений/)).toHaveCount(0);
  await finish(page);
  await expect(page.getByTestId('notifications').getByLabel(/Напоминания о сеансе/)).toBeVisible();
  await expect(page.getByTestId('notifications').getByLabel(/Реклама и акции/)).toHaveCount(0);
  expect(await journal(request, phone)).toEqual([]);
});

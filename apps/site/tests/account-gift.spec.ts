// e2e ЛК «Мой подарок» (S3-91) на моке tests/mock-events.ts (П1 по apps/api/src/modules/events/routes.gifts.ts): условия словами 11 §9.1,
// срок, статус; «Записаться» – только у действующего, у истёкшего кнопки нет; отменённый не показывается; подарок не в «Моих сертификатах»;
// чужой подарок не виден, его окна – 404; пустое состояние; 390 px без горизонтальной прокрутки.
import { expect, test, type Page } from '../../../tests/support/e2e.ts';
import { MOCK_PORT, STAGE_PORT } from '../playwright.config.ts';
import { MOCK_CODE } from './mock-api.ts';

test.use({ baseURL: `http://localhost:${STAGE_PORT}` });

const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const KRASNY = '0b0b0000-0000-4000-8000-000000000011';

async function login(page: Page, phone: string) {
  await page.goto('/login/?next=/account/');
  await page.getByLabel('Телефон').fill(phone);
  await page.getByRole('button', { name: 'Получить код' }).click();
  await page.getByLabel('Код из SMS').fill(MOCK_CODE);
  await page.getByLabel(/согласие на обработку/).check();
  await page.getByRole('button', { name: 'Войти' }).click();
  // /\/account\/$/ совпадает и с /login/?next=/account/ – ждём сам кабинет, иначе evaluate попадает на переход
  await expect(page).toHaveURL(/^[^?]*\/account\/$/);
  await expect(page.getByTestId('profile')).toBeVisible();
}

const gift = (page: Page, number: string) => page.getByTestId('gift').filter({ hasText: `№ ${number}` });

test.beforeEach(async ({ request }) => {
  await request.post(`${MOCK}/__test/events-reset`);
  await request.post(`${MOCK}/__test/booking-reset`);
});

test('действующий – условия, срок и «Записаться»; истёкший – без кнопки; отменённого и чужого нет; не среди сертификатов', async ({ page }) => {
  await login(page, '9131234567');
  await expect(page.getByTestId('gift')).toHaveCount(2);
  const active = gift(page, 'GF-000101');
  await expect(active.getByTestId('gift-status')).toHaveText('Действует');
  await expect(active.getByTestId('gift-term')).toContainText('Действует до');
  await expect(active.getByTestId('gift-terms').locator('li')).toHaveText([
    '2 устройства Meta Quest 3S',
    'по 30 минут на каждое устройство',
    'суммарная продолжительность использования комнаты – 40 минут с учётом подготовки',
    'срок действия – 60 дней',
    'посещение по предварительной записи',
    'доступность с понедельника по пятницу, кроме праздничных дней',
    'PS4, PS VR и еда в подарок не входят',
  ]);
  await expect(active.getByRole('link', { name: 'Записаться' })).toHaveAttribute('href', /^\/schedule\/\?gift=[0-9a-f-]{36}$/);

  const expired = gift(page, 'GF-000042');
  await expect(expired.getByTestId('gift-status')).toHaveText('Истёк');
  await expect(expired.getByTestId('gift-term')).toContainText('Срок истёк');
  await expect(expired.getByRole('link', { name: 'Записаться' })).toHaveCount(0);

  await expect(page.getByTestId('my-gift')).not.toContainText('GF-000013'); // отменённый
  await expect(page.getByTestId('my-gift')).not.toContainText('GF-000150'); // подарок Петра
  await expect(page.getByTestId('certificate')).toHaveCount(3);
  await expect(page.getByTestId('certificates')).not.toContainText('GF-');
});

test('чужой подарок: окна и удержание – 404, как несуществующий', async ({ page, browser }) => {
  const other = await browser.newContext();
  const petr = await other.newPage();
  await login(petr, '9135550000');
  await expect(petr.getByTestId('gift')).toHaveCount(1); // кабинет загрузился – дальше никакой навигации
  const petrGift = await petr.evaluate(async () => ((await (await fetch('/api/public/v1/me/gifts/')).json()) as { items: Array<{ id: string }> }).items[0]!.id);
  await other.close();

  await login(page, '9131234567');
  const r = await page.evaluate(async ({ id, branchId }) => {
    const slots = await fetch(`/api/public/v1/me/gifts/${id}/slots/?branchId=${branchId}&date=2030-01-10`);
    const hold = await fetch(`/api/public/v1/me/gifts/${id}/hold/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'yu-site', 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({ branchId, start: '2030-01-10T05:00:00.000Z' }),
    });
    return [slots.status, hold.status];
  }, { id: petrGift, branchId: KRASNY });
  expect(r).toEqual([404, 404]);
});

test('нет подарка – понятное пустое состояние', async ({ page }) => {
  await login(page, '9130000079');
  await expect(page.getByTestId('gift-empty')).toContainText('Подарка пока нет');
});

test('390 px: блок подарка без горизонтальной прокрутки, кнопка от 44 px', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, '9131234567');
  const book = gift(page, 'GF-000101').getByRole('link', { name: 'Записаться' });
  await expect(book).toBeVisible();
  expect((await book.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.getByTestId('my-gift').screenshot({ path: 'test-results/account-gift-390.png' });
});

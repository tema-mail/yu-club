// e2e записи по подарку (S3-92) на моке tests/mock-events.ts + mock-api.ts (П1, П2 по apps/api/src/modules/events/routes.gifts.ts):
// из ЛК «Записаться» → расписание в режиме подарка (переживает выбор клуба); дни – только будни в пределах срока и окна, праздник
// закрывает сервер; занят один шлем – окна, пересекающие его, не предлагаются; удержание – обычное K5 (таймер 15 минут), цена 0,
// оформление без выбора оплаты; после записи подарок «Есть запись» и без кнопки. 390 и 1440 px без горизонтальной прокрутки.
import { expect, test, type Page } from '../../../tests/support/e2e.ts';
import { MOCK_PORT, STAGE_PORT } from '../playwright.config.ts';
import { UI_STATES } from '../src/lib/booking.ts';
import { MOCK_CODE, resourceId } from './mock-api.ts';
import { mockHoliday } from './mock-events.ts';

test.use({ baseURL: `http://localhost:${STAGE_PORT}` });

const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const KRASNY = '0b0b0000-0000-4000-8000-000000000011';
const TZ_MS = 7 * 3600_000;
const localDate = (t: number) => new Date(t + TZ_MS).toISOString().slice(0, 10);
const plusDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const weekday = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay() || 7;
const at = (d: string, hhmm: string) => new Date(Date.parse(`${d}T${hhmm}:00Z`) - TZ_MS).toISOString();
const TODAY = localDate(Date.now());
/** Ближайший будний день после сегодня, не праздник мока. */
let WORKDAY = plusDays(TODAY, 1);
while (weekday(WORKDAY) > 5 || WORKDAY === mockHoliday()) WORKDAY = plusDays(WORKDAY, 1);

async function login(page: Page, phone = '9131234567') {
  await page.goto('/login/?next=/account/');
  await page.getByLabel('Телефон').fill(phone);
  await page.getByRole('button', { name: 'Получить код' }).click();
  await page.getByLabel('Код из SMS').fill(MOCK_CODE);
  await page.getByLabel(/согласие на обработку/).check();
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(/^[^?]*\/account\/$/);
  await expect(page.getByTestId('profile')).toBeVisible();
}

/** ЛК → «Записаться» → список клубов (выбора нет) → «Красный»: режим подарка держится во вкладке. */
async function openGiftSchedule(page: Page) {
  await login(page);
  await page.getByTestId('gift').filter({ hasText: 'GF-000101' }).getByRole('link', { name: 'Записаться' }).click();
  await expect(page.getByTestId('schedule-branches')).toBeVisible();
  await page.getByRole('link', { name: 'Ю-Клуб на Красном' }).click();
  await expect(page.getByTestId('gift-mode')).toContainText('Запись по подарку имениннику № GF-000101');
}
const day = (page: Page, d: string) => page.locator(`.yu-sched__day[data-date="${d}"]`);
const giftWindow = (page: Page, from: string, to: string) => page.getByRole('button', { name: `Подарок, ${from}–${to}`, exact: true });

test.beforeEach(async ({ request }) => {
  await request.post(`${MOCK}/__test/booking-reset`);
  await request.post(`${MOCK}/__test/events-reset`);
});

test('дни – только будни срока и окна; праздник и выходной клуба – фразой; сетки обычной записи нет', async ({ page }) => {
  await openGiftSchedule(page);
  const dates = await page.locator('.yu-sched__day').evaluateAll((els) => els.map((e) => e.getAttribute('data-date')!));
  expect(dates.length).toBeGreaterThan(10);
  expect(dates.every((d) => weekday(d) <= 5)).toBe(true);
  expect(dates[0]! >= TODAY && dates.at(-1)! < plusDays(TODAY, 30)).toBe(true);
  await expect(page.locator('.yu-sched__grid')).toHaveCount(0);

  await day(page, mockHoliday()).click();
  await expect(page.getByTestId('schedule-status')).toHaveText('Это праздничный день – в праздники подарок не действует. Выберите другой день.');
  await day(page, WORKDAY).click();
  await expect(giftWindow(page, '10:00', '10:40')).toBeVisible();
  await expect(giftWindow(page, '10:15', '10:55')).toBeVisible();
  // «Обычная запись» – выход из режима, сетка возвращается
  await page.getByRole('button', { name: 'Обычная запись' }).click();
  await expect(page.getByTestId('gift-mode')).toHaveCount(0);
  await expect(page).not.toHaveURL(/gift=/);
});

test('занят один шлем – пересекающие окна не предлагаются', async ({ page, browser }) => {
  const other = await browser.newContext();
  const guest = await other.newPage();
  await guest.goto('/schedule/?branch=novosibirsk/krasny-prospekt');
  await expect(guest.getByTestId('schedule-status')).not.toHaveText(UI_STATES.loading); // доступность выдала куку посетителя
  const status = await guest.evaluate(async (item) => {
    const res = await fetch('/api/public/v1/holds/', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'yu-site', 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({ branchId: item.branchId, items: [{ resourceId: item.resourceId, start: item.start, end: item.end }] }),
    });
    return res.status;
  }, { branchId: KRASNY, resourceId: resourceId(KRASNY, 'vr1'), start: at(WORKDAY, '15:00'), end: at(WORKDAY, '15:15') });
  expect(status).toBe(201);

  await openGiftSchedule(page);
  await day(page, WORKDAY).click();
  await expect(giftWindow(page, '14:15', '14:55')).toBeVisible();
  for (const from of ['14:30', '14:45', '15:00']) await expect(page.getByRole('button', { name: new RegExp(`^Подарок, ${from}`) })).toHaveCount(0);
  await expect(giftWindow(page, '15:15', '15:55')).toBeVisible();
  await other.close();
});

test('запись: удержание K5 с таймером, цена 0, оформление без оплаты, подарок «Есть запись»', async ({ page }) => {
  await openGiftSchedule(page);
  await day(page, WORKDAY).click();
  await giftWindow(page, '10:00', '10:40').click();
  const panel = page.getByTestId('hold-panel');
  await expect(panel).toContainText('Подарок: 2 VR');
  await expect(panel.getByTestId('hold-total')).toHaveText('0 ₽');
  await expect(panel.getByRole('timer')).toHaveText(/^1[45]:\d\d$/);
  await expect(page.getByTestId('gift-windows')).toHaveCount(0); // одна запись на подарок: он «reserved», окон больше нет
  await expect(page.getByTestId('schedule-status')).toHaveText(UI_STATES.held);
  await panel.getByRole('button', { name: 'Оформить запись' }).click();
  await expect(page.getByTestId('gift-free')).toHaveText('Подарок имениннику – оплата не нужна.');
  await expect(page.getByTestId('payment')).toHaveCount(0);
  await expect(page.getByTestId('checkout-total')).toHaveText('0 ₽');
  await page.getByTestId('confirm').click();
  await expect(page).toHaveURL(/\/booking\/success\/$/);
  await expect(page.getByTestId('success-list')).toContainText('Подарок: 2 VR');
  expect(await page.evaluate(() => sessionStorage.getItem('yu_gift'))).toBeNull();

  await page.goto('/account/');
  const g = page.getByTestId('gift').filter({ hasText: 'GF-000101' });
  await expect(g.getByTestId('gift-status')).toHaveText('Есть запись');
  await expect(g.getByRole('link', { name: 'Записаться' })).toHaveCount(0);
  await expect(page.getByTestId('my-bookings')).toContainText('Подарок: 2 VR');
});

test('без входа – просьба войти со ссылкой назад в режим подарка', async ({ page }) => {
  await page.goto('/schedule/?branch=novosibirsk/krasny-prospekt&gift=0b0b0000-0000-4000-8000-0000000000aa');
  await expect(page.getByTestId('schedule-status')).toHaveText('Чтобы записаться по подарку, войдите в личный кабинет.');
  await expect(page.getByRole('link', { name: 'Войти', exact: true }).last()).toHaveAttribute('href', /^\/login\/\?next=%2Fschedule%2F%3Fgift%3D/);
});

for (const width of [390, 1440]) {
  test(`${width} px: режим подарка без горизонтальной прокрутки, окна от 44 px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openGiftSchedule(page);
    await day(page, WORKDAY).click();
    await giftWindow(page, '10:00', '10:40').click();
    await expect(page.getByTestId('hold-panel')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const small = await page.getByTestId('schedule').locator('button').evaluateAll((els) => els.filter((e) => e.getBoundingClientRect().height < 44).length);
    expect(small).toBe(0);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `test-results/gift-booking-${width}.png`, fullPage: true });
  });
}

// e2e острова расписания (S1-19) на моке tests/mock-api.ts: 6 состояний слота, фильтр зоны, окно 7/30 дней,
// таймер удержания от серверного времени (часы браузера подменены – отсчёт не меняется), добавление слота
// перезапускает таймер, истечение – фраза и сброс; 390 и 1440 без прокрутки страницы, сетка листается внутри блока.
// Адрес – localhost: куки yu_visitor / yu_client с Secure браузер принимает по http только там.
import { expect, test, type Page } from '../../../tests/support/e2e.ts';
import { MOCK_PORT, STAGE_PORT } from '../playwright.config.ts';
import { UI_STATES } from '../src/lib/booking.ts';

test.use({ baseURL: `http://localhost:${STAGE_PORT}` });

const PAGE = '/schedule/?branch=novosibirsk/krasny-prospekt';
const slot = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const status = (page: Page) => page.getByTestId('schedule-status');
const seconds = async (page: Page) => {
  const [m, s] = ((await page.getByTestId('hold-timer').textContent()) ?? '').split(':').map(Number) as [number, number];
  return m * 60 + s;
};

/** При остановленных часах рендер Preact и ответы сети ждут таймеров страницы: двигаем их понемногу, пока условие не выполнится. */
async function settle(page: Page, check: () => Promise<void>) {
  await expect(async () => {
    await page.clock.runFor(100);
    await check();
  }).toPass({ timeout: 20_000, intervals: [100] });
}

async function openTomorrow(page: Page) {
  await page.goto(PAGE);
  await page.getByRole('button', { name: /^Завтра/ }).click();
  await expect(slot(page, 'ПК 4, 10:00–10:30, свободно')).toBeEnabled();
}

test.beforeEach(async ({ request }) => {
  await request.post(`http://127.0.0.1:${MOCK_PORT}/__test/booking-reset`);
});

test('сетка: 6 состояний, шаг VR 15 / ПК 30, фильтр зоны, окно 7 → 30 дней, сегодня – нет слотов', async ({ page }) => {
  await page.goto(PAGE);
  await expect(page).toHaveTitle(/Расписание и запись – Ю-Клуб на Красном/);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', /\/schedule\/$/);
  await expect(status(page)).toHaveText(UI_STATES.empty); // у «Красного» сегодня выходной
  await expect(page.locator('.yu-sched__day[data-date]')).toHaveCount(7);
  await page.getByRole('button', { name: 'Ещё дни – до 30' }).click();
  await expect(page.locator('.yu-sched__day[data-date]')).toHaveCount(30);

  await page.getByRole('button', { name: /^Завтра/ }).click();
  await expect(status(page)).toHaveText(UI_STATES.loaded);
  await expect(slot(page, 'ПК 1, 10:00–10:30, занято')).toBeDisabled();
  await expect(slot(page, 'ПК 2, 10:00–10:30, удерживается другим гостем')).toBeDisabled();
  await expect(slot(page, 'ПК 3, 10:00–10:30, на обслуживании')).toBeDisabled();
  await expect(slot(page, 'ПК 5, 20:00–20:30, вне графика')).toBeDisabled();
  await expect(slot(page, 'VR 1, 10:00–10:15, свободно')).toBeEnabled();
  await slot(page, 'ПК 4, 10:00–10:30, свободно').click();
  await expect(slot(page, 'ПК 4, 10:00–10:30, выбрано вами')).toHaveAttribute('aria-pressed', 'true');
  await expect(status(page)).toHaveText(UI_STATES.held);
  await expect(page.getByTestId('hold-total')).toHaveText('150 ₽');

  await page.getByRole('button', { name: 'VR и PS4', exact: true }).click();
  await expect(page.getByText('ПК 1', { exact: true })).toHaveCount(0);
  await expect(slot(page, 'Вся комната, 10:00–10:30, свободно')).toBeVisible();

  await page.getByRole('button', { name: 'Отменить выбор' }).click();
  await expect(status(page)).toHaveText(UI_STATES.cancelled);
  await expect(page.getByTestId('hold-panel')).toHaveCount(0);
});

test('таймер – от серверного времени: перевод часов браузера его не меняет, добавление слота перезапускает, истечение сбрасывает', async ({ page }) => {
  test.slow(); // прокрутка 20 минут часов идёт больше 25 с и под нагрузкой не укладывается в 30 с
  await page.clock.install();
  await openTomorrow(page);
  await slot(page, 'ПК 4, 10:00–10:30, свободно').click();
  await expect(page.getByTestId('hold-timer')).toBeVisible();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  const start = await seconds(page);
  expect(start).toBeGreaterThan(14 * 60);

  // Часы браузера ушли на 3 часа вперёд, монотонное время – на 1 секунду: таймер минус секунда, не «истекло».
  await page.clock.setSystemTime(new Date(Date.now() + 3 * 3600_000));
  await page.clock.runFor(1000);
  expect(Math.abs((await seconds(page)) - (start - 1))).toBeLessThanOrEqual(1);
  await expect(page.getByTestId('hold-panel')).toBeVisible();
  await expect(status(page)).toHaveText(UI_STATES.held);

  await page.clock.runFor(5 * 60_000);
  expect(Math.abs((await seconds(page)) - (start - 301))).toBeLessThanOrEqual(1);

  // Второй слот: сервер продлил удержание – таймер снова 15 минут.
  await slot(page, 'ПК 4, 10:30–11:00, свободно').click();
  await settle(page, () => expect(page.getByTestId('hold-total')).toHaveText('300 ₽', { timeout: 100 }));
  await settle(page, async () => expect(await seconds(page)).toBeGreaterThanOrEqual(15 * 60 - 3)); // таймер перерисуется тиком после суммы

  await page.clock.runFor(13 * 60_000 + 10_000);
  await settle(page, () => expect(status(page)).toHaveText(UI_STATES.expiring, { timeout: 100 }));
  await page.clock.runFor(2 * 60_000);
  await settle(page, () => expect(status(page)).toHaveText(UI_STATES.expired, { timeout: 100 }));
  await expect(page.getByTestId('hold-panel')).toHaveCount(0);
  // release при истечении – слот снова свободен
  await settle(page, () => expect(slot(page, 'ПК 4, 10:00–10:30, свободно')).toBeEnabled({ timeout: 100 }));
});

test('филиал ведёт в запись; без клуба – список; закрытый клуб – без сетки', async ({ page }) => {
  await page.goto('/novosibirsk/krasny-prospekt/');
  await page.getByTestId('branch-book').click();
  await expect(page).toHaveURL(/\/schedule\/\?branch=novosibirsk\/krasny-prospekt$/);
  await expect(page.getByTestId('schedule')).toBeVisible();
  await page.getByRole('link', { name: 'Другой клуб' }).click();
  await expect(page.getByTestId('schedule-branches').getByRole('link')).toHaveCount(3);
  await page.goto('/schedule/?branch=novosibirsk/akademgorodok');
  await expect(page.getByTestId('schedule-closed')).toBeVisible();
  await expect(page.getByTestId('schedule')).toHaveCount(0);
});

for (const width of [390, 1440]) {
  test(`${width} px: страница без горизонтальной прокрутки, сетка листается внутри блока`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openTomorrow(page);
    await slot(page, 'ПК 4, 10:00–10:30, свободно').click();
    await expect(page.getByTestId('hold-panel')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const grid = page.locator('.yu-sched__scroll');
    expect(await grid.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    const small = await page.locator('.yu-slot:not(.yu-legend__mark), .yu-sched__day, .yu-sched__zone, .yu-hold .yu-btn').evaluateAll((els) =>
      els.filter((el) => el.getBoundingClientRect().height < 44).length,
    );
    expect(small).toBe(0);
    await page.screenshot({ path: `test-results/schedule-${width}.png`, fullPage: true });
  });
}

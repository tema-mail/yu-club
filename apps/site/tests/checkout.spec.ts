// e2e оформления записи (S1-20) на моке tests/mock-api.ts: вход по коду прямо в потоке (удержание переходит к клиенту),
// CLIENT_OVERLAP – понятная фраза, сводка с ценой из ответа, двойное «Подтвердить» – одна бронь и один ключ,
// экран успеха с переходом в ЛК; каждое из 12 состояний tz/01 §15.1 показывает свою фразу; 390 и 1440 без прокрутки.
// Ошибки сервера подменяются через /__test/fail-next (следующий вызов операции мока отвечает заданным кодом).
import { expect, test, type APIRequestContext, type Page } from '../../../tests/support/e2e.ts';
import { MOCK_PORT, STAGE_PORT } from '../playwright.config.ts';
import { ERROR_STATES, UI_STATES, type UiState } from '../src/lib/booking.ts';
import { MOCK_CODE } from './mock-api.ts';

test.use({ baseURL: `http://localhost:${STAGE_PORT}` });

const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const PAGE = '/schedule/?branch=novosibirsk/krasny-prospekt';
const slot = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const status = (page: Page) => page.getByTestId('schedule-status');
const failNext = (request: APIRequestContext, data: { op: string; status: number; code: string; delayMs?: number }) => request.post(`${MOCK}/__test/fail-next`, { data });
const bookings = async (request: APIRequestContext) => ((await (await request.get(`${MOCK}/__test/bookings`)).json()) as { items: Array<{ checkoutId: string }> }).items;

async function openTomorrow(page: Page) {
  await page.goto(PAGE);
  await page.getByRole('button', { name: /^Завтра/ }).click();
  await expect(slot(page, 'ПК 4, 10:00–10:30, свободно')).toBeEnabled();
}

async function pick(page: Page, name: string) {
  await slot(page, `${name}, свободно`).click();
  await expect(slot(page, `${name}, выбрано вами`)).toBeVisible();
}

async function loginInFlow(page: Page, phone = '9131234567') {
  await page.getByRole('button', { name: 'Оформить запись' }).click();
  await page.getByLabel('Телефон').fill(phone);
  await page.getByRole('button', { name: 'Получить код' }).click();
  await page.getByLabel('Код из SMS').fill(MOCK_CODE);
  const consent = page.getByLabel(/согласие на обработку/);
  await expect(consent).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Войти и продолжить' })).toBeDisabled();
  await consent.check();
  await page.getByRole('button', { name: 'Войти и продолжить' }).click();
}

test.beforeEach(async ({ request }) => {
  await request.post(`${MOCK}/__test/booking-reset`);
});

test('вход в потоке: удержание переходит к клиенту, сводка с ценой, двойное «Подтвердить» – одна бронь, успех и ЛК', async ({ page, request }) => {
  await openTomorrow(page);
  await pick(page, 'ПК 4, 10:00–10:30');
  await pick(page, 'ПК 4, 10:30–11:00');
  await pick(page, 'VR 1, 12:00–12:15');
  await expect(page.getByTestId('header-account')).toHaveText('Войти');
  await loginInFlow(page);

  await expect(page.getByTestId('checkout-items').locator('li')).toHaveCount(3);
  // Шапка узнала о входе без перезагрузки.
  await expect(page.getByTestId('header-account')).toHaveText('Кабинет');
  await expect(page.getByTestId('header-account')).toHaveAttribute('href', '/account/');
  await expect(page.getByTestId('checkout-total')).toHaveText('500 ₽'); // 150 + 150 + 200 – из ответа API
  await expect(page.getByTestId('hold-timer')).toBeVisible();

  const before = (await bookings(request)).length;
  const keys: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/confirm/')) keys.push(r.headers()['idempotency-key'] ?? '');
  });
  await page.getByTestId('confirm').dblclick();
  await expect(page).toHaveURL(/\/booking\/success\/$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Запись подтверждена');
  await expect(page.getByText(UI_STATES.success)).toBeVisible();
  await expect(page.getByTestId('success-list').locator('li')).toHaveCount(2); // ПК 4 встык – одна бронь, VR – вторая

  const after = await bookings(request);
  expect(after.length - before).toBe(2);
  expect(new Set(after.slice(before).map((b) => b.checkoutId)).size).toBe(1);
  expect(keys.length).toBeGreaterThanOrEqual(1);
  expect(new Set(keys).size).toBe(1);

  await page.getByTestId('to-account').click();
  await expect(page).toHaveURL(/\/account\/$/);
  await expect(page.getByTestId('profile-name')).toHaveText('Алина Сафронова');
});

test('повтор подтверждения после сбоя идёт с тем же ключом – одна бронь', async ({ page, request }) => {
  await openTomorrow(page);
  await pick(page, 'PS5 1, 15:00–15:30');
  await loginInFlow(page);
  await expect(page.getByTestId('checkout-total')).toHaveText('250 ₽');
  const keys: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/confirm/')) keys.push(r.headers()['idempotency-key'] ?? '');
  });
  const before = (await bookings(request)).length;
  // Ответ потерялся (502 по дороге) – повторное нажатие идёт с тем же ключом.
  await failNext(request, { op: 'confirm', status: 502, code: 'BAD_GATEWAY' });
  await page.getByTestId('confirm').click();
  await expect(status(page)).toHaveText('Сервис временно недоступен. Попробуйте ещё раз через минуту.');
  await expect(page.getByTestId('checkout-items').locator('li')).toHaveCount(1); // ошибка не сбросила выбор
  await page.getByTestId('confirm').click();
  await expect(page).toHaveURL(/\/booking\/success\/$/);
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  expect((await bookings(request)).length - before).toBe(1);
});

test('CLIENT_OVERLAP при входе: понятная фраза, выбор сохраняется, подтверждение недоступно', async ({ page }) => {
  // У Алины бронь на завтра 14:00–14:30 в Томске – слот 14:00 в Новосибирске пересекается по сети.
  await openTomorrow(page);
  await pick(page, 'ПК 4, 14:00–14:30');
  await loginInFlow(page);
  await expect(status(page)).toHaveText(ERROR_STATES.CLIENT_OVERLAP!.text!);
  await expect(page.getByTestId('checkout-items').locator('li')).toHaveCount(1);
  await expect(page.getByTestId('confirm')).toBeDisabled();
  await page.getByRole('button', { name: 'Изменить выбор' }).click();
  await expect(slot(page, 'ПК 4, 14:00–14:30, выбрано вами')).toBeVisible();
});

// ── 12 состояний tz/01 §15.1: у каждого своя фраза ──────────
const REACH: Record<UiState, (page: Page, request: APIRequestContext) => Promise<void>> = {
  loading: async (page, request) => {
    await failNext(request, { op: 'availability', status: 0, code: '', delayMs: 3000 });
    await page.goto(PAGE);
  },
  loaded: async (page) => openTomorrow(page),
  empty: async (page) => {
    await page.goto(PAGE); // сегодня у «Красного» выходной
  },
  held: async (page) => {
    await openTomorrow(page);
    await pick(page, 'ПК 4, 10:00–10:30');
  },
  expiring: async (page) => {
    await page.clock.install();
    await openTomorrow(page);
    await pick(page, 'ПК 4, 10:00–10:30');
    await page.clock.runFor(13 * 60_000 + 30_000);
  },
  expired: async (page, request) => {
    await openTomorrow(page);
    await pick(page, 'ПК 4, 10:00–10:30');
    await failNext(request, { op: 'add', status: 410, code: 'HOLD_EXPIRED' });
    await slot(page, 'ПК 4, 11:00–11:30, свободно').click();
  },
  conflict: async (page, request) => {
    await openTomorrow(page);
    await failNext(request, { op: 'create', status: 409, code: 'SLOT_TAKEN' });
    await slot(page, 'ПК 4, 10:00–10:30, свободно').click();
  },
  load_error: async (page, request) => {
    await failNext(request, { op: 'availability', status: 503, code: 'SERVICE_UNAVAILABLE' });
    await page.goto(PAGE);
  },
  forbidden: async (page, request) => {
    await openTomorrow(page);
    await failNext(request, { op: 'create', status: 403, code: 'CLIENT_RESTRICTED' });
    await slot(page, 'ПК 4, 10:00–10:30, свободно').click();
  },
  blocked: async (page, request) => {
    await openTomorrow(page);
    await failNext(request, { op: 'create', status: 409, code: 'RESOURCE_BLOCKED' });
    await slot(page, 'ПК 4, 10:00–10:30, свободно').click();
  },
  cancelled: async (page) => {
    await openTomorrow(page);
    await pick(page, 'ПК 4, 10:00–10:30');
    await page.getByRole('button', { name: 'Отменить выбор' }).click();
  },
  success: async (page) => {
    await openTomorrow(page);
    await pick(page, 'ПК 5, 12:00–12:30');
    await loginInFlow(page);
    await page.getByTestId('confirm').click();
  },
};

test('12 фраз состояний разные', () => {
  const phrases = Object.values(UI_STATES);
  expect(phrases).toHaveLength(12);
  expect(new Set(phrases).size).toBe(12);
});

for (const [state, reach] of Object.entries(REACH) as Array<[UiState, (typeof REACH)[UiState]]>) {
  test(`состояние «${state}» – своя фраза`, async ({ page, request }) => {
    await reach(page, request);
    if (state === 'success') {
      await expect(page.locator('#success-status')).toHaveText(UI_STATES.success);
      return;
    }
    if (state === 'expiring') {
      await expect(async () => {
        await page.clock.runFor(250);
        await expect(status(page)).toHaveText(UI_STATES.expiring, { timeout: 100 });
      }).toPass({ timeout: 5000 });
      return;
    }
    await expect(status(page).locator('span')).toHaveText(UI_STATES[state]); // рядом может быть кнопка «Повторить»
    await expect(status(page)).toHaveAttribute('data-state', state);
    if (state === 'load_error') {
      await page.getByRole('button', { name: 'Повторить' }).click();
      await expect(status(page)).toHaveText(UI_STATES.empty);
    }
    if (state === 'conflict' || state === 'blocked' || state === 'forbidden') {
      await expect(page.getByTestId('hold-panel')).toHaveCount(0); // ошибка не придумала выбор
    }
    if (state === 'expired') await expect(page.getByTestId('hold-panel')).toHaveCount(0);
  });
}

/** Шапка – первый блок вверху: страница не прокручена, шапка в y=0, крошки и заголовок шага – под ней и видны. */
async function headerFirst(page: Page, heading: string) {
  await expect.poll(() => page.evaluate(() => Math.round(window.scrollY))).toBe(0);
  const header = (await page.locator('.yu-header').boundingBox())!;
  expect(header.y).toBe(0);
  const crumbs = (await page.locator('.yu-crumbs').boundingBox())!;
  expect(crumbs.y).toBeGreaterThanOrEqual(header.y + header.height);
  await expect(page.getByRole('heading', { name: heading, exact: true })).toBeInViewport();
}

test('390 px: шапка вверху и заголовок шага виден после каждого перехода', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openTomorrow(page);
  await headerFirst(page, 'Расписание и запись');
  await pick(page, 'PS5 3, 21:00–21:30'); // нижний ряд сетки – кнопка «Оформить» далеко внизу
  await page.getByRole('button', { name: 'Оформить запись' }).scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: 'Оформить запись' }).click();
  await headerFirst(page, 'Оформление записи');
  await page.getByLabel('Телефон').fill('9131234567');
  await page.getByRole('button', { name: 'Получить код' }).click();
  await expect(page.getByLabel('Код из SMS')).toBeVisible();
  await headerFirst(page, 'Оформление записи');
  await page.getByLabel('Код из SMS').fill(MOCK_CODE);
  await page.getByLabel(/согласие на обработку/).check();
  await page.getByRole('button', { name: 'Войти и продолжить' }).click();
  await expect(page.getByTestId('confirm')).toBeEnabled();
  await page.getByRole('button', { name: 'Изменить выбор' }).scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: 'Изменить выбор' }).click();
  await headerFirst(page, 'Расписание и запись');
  await page.getByRole('button', { name: 'Оформить запись' }).scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: 'Оформить запись' }).click();
  await headerFirst(page, 'Оформление записи');
  await page.screenshot({ path: 'test-results/checkout-summary-390.png', fullPage: true });
});

for (const width of [390, 1440]) {
  test(`${width} px: оформление без горизонтальной прокрутки, поля 16 px, кнопки ≥ 44 px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openTomorrow(page);
    await pick(page, 'ПК 4, 10:00–10:30');
    await page.getByRole('button', { name: 'Оформить запись' }).click();
    const phone = page.getByLabel('Телефон');
    await expect(phone).toBeVisible();
    expect(await phone.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const small = await page.locator('.yu-checkout .yu-btn').evaluateAll((els) => els.filter((el) => el.getBoundingClientRect().height < 44).length);
    expect(small).toBe(0);
    await page.screenshot({ path: `test-results/checkout-${width}.png`, fullPage: true });
  });
}

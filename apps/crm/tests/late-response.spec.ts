// Поздний ответ сервера (docs/OTCHET-dlya-programmistov.md §10): ответ прежнего запроса, пришедший после нового, не подменяет свежие данные,
// а подгрузка после монтирования не перетирает поля, которые человек уже изменил. Каждый тест задерживает один ответ через page.route
// и проверяет экран после того, как поздний ответ дошёл. Образец – repair-card.spec.ts «По, введённое до прихода предложенного периода».
import { expect, test, type Page } from '../../../tests/support/e2e.ts';
import { openEvent } from './event-helpers.ts';
import { MOCK_PASSWORD } from './mock-api.ts';
import { CONTENT_IDS } from './mock-content.ts';

const MOCK = process.env.MOCK_URL ?? 'http://127.0.0.1:4012';

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
const pause = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
/** Задерживает ответ на первый запрос к API, чей адрес подходит под match; обещание выполняется, когда задержанный ответ дошёл до страницы. */
function slow(page: Page, match: (url: URL) => boolean, ms = 1500): Promise<void> {
  let taken = false;
  return new Promise((done) => {
    void page.route((u) => u.pathname.startsWith('/api/') && match(u), async (r) => {
      if (taken) return r.fallback();
      taken = true;
      const res = await r.fetch(); // сервер отвечает сразу, а до страницы ответ доходит позже – как на медленной сети
      await pause(ms);
      await r.fulfill({ response: res });
      await r.request().response();
      await pause(300); // ответ разобран островом
      done();
    });
  });
}

test('Зарплата: ответ без фильтра, пришедший после выбора филиала, не возвращает чужие строки', async ({ page }) => {
  await login(page, 'owner@yu.test');
  const late = slow(page, (u) => u.pathname.endsWith('/payroll/report') && !u.searchParams.has('branchIds'));
  await open(page, '/payroll');
  await page.getByLabel('Филиал').selectOption('b-nsk-krasny');
  await late;
  await expect(page.locator('[data-testid="payroll-row"][data-staff="s-admin-tsk"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="payroll-row"][data-staff="s-admin"]')).toBeVisible();
});

test('Смены: ответ «все статусы», пришедший после выбора «Отменена», не возвращает смены в календарь', async ({ page }) => {
  await login(page, 'director@yu.test'); // у Директора на этой неделе есть смены (shifts.spec «день с дырами»)
  const late = slow(page, (u) => u.pathname.endsWith('/shifts') && !u.searchParams.has('status'));
  await open(page, '/shifts');
  await page.getByLabel('Статус').selectOption('cancelled');
  await late;
  await expect(page.getByTestId('shift-item')).toHaveCount(0);
  await page.getByLabel('Статус').selectOption('');
  await expect(page.getByTestId('shift-item').first()).toBeVisible(); // задержанный ответ был не пустой
});

test('Моё расписание: ответ текущего окна, пришедший после листания вперёд, не подменяет пустое окно', async ({ page }) => {
  await login(page, 'two@yu.test');
  const late = slow(page, (u) => u.pathname.endsWith('/shifts'));
  await open(page, '/shifts/my');
  await page.getByRole('button', { name: 'Позже' }).click();
  await page.getByRole('button', { name: 'Позже' }).click();
  await expect(page.getByTestId('my-empty')).toBeVisible();
  await late;
  await expect(page.getByTestId('my-shift')).toHaveCount(0);
});

test('Праздники: ответ текущего года, пришедший после перехода на следующий, не подменяет список', async ({ page }) => {
  const year = new Date().getUTCFullYear();
  await login(page, 'owner@yu.test');
  const late = slow(page, (u) => u.pathname.endsWith('/holidays') && u.searchParams.get('from') === `${year}-01-01`);
  await open(page, '/dictionaries/holidays');
  await page.getByRole('button', { name: 'Следующий год' }).click();
  await expect(page.getByTestId('holiday-year')).toHaveText(String(year + 1));
  await late;
  await expect(page.locator(`[data-testid^="holiday-${year}-"]`)).toHaveCount(0);
  await page.getByRole('button', { name: 'Предыдущий год' }).click();
  await expect(page.locator(`[data-testid^="holiday-${year}-"]`).first()).toBeVisible(); // задержанный ответ был не пустой
});

test('Подарок: окна первого дня, пришедшие после выбора второго, не подменяют окна – запись уходит на выбранный день', async ({ page }) => {
  await login(page, 'admin@yu.test');
  await openEvent(page, 'EV-000127', 'Подарки');
  await page.getByRole('button', { name: 'Выдать подарок…' }).click();
  await page.getByTestId('gift-issue').getByRole('button', { name: 'Выдать' }).click();
  const gift = page.getByTestId('gift-GF-000041');
  await expect(gift.getByTestId('gift-status')).toHaveText('Выдан');
  await gift.getByRole('button', { name: 'Записать…' }).click();
  const d = page.getByTestId('gift-book');
  const days = d.getByTestId('gift-days').locator('option');
  await expect(days.nth(2)).toBeAttached();
  const values = (await days.evaluateAll((o) => o.map((x) => (x as HTMLOptionElement).value))).filter(Boolean);
  const late = slow(page, (u) => u.pathname.endsWith('/slots') && u.searchParams.get('date') === values[0]);
  await d.getByTestId('gift-days').selectOption(values[0]!);
  await d.getByTestId('gift-days').selectOption(values[1]!);
  await expect(d.getByTestId('gift-slots').getByRole('button').first()).toBeVisible();
  await late;
  await d.getByTestId('gift-slots').getByRole('button').first().click();
  const sent = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/book'));
  await d.getByRole('button', { name: 'Записать', exact: true }).click();
  expect(((await sent).postDataJSON() as { start: string }).start.slice(0, 10)).toBe(values[1]);
});

test('Касса: подсказка «остаток после» прежней суммы, пришедшая позже, не подменяет подсказку новой', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, '/finance/b-nsk-krasny');
  await expect(page.getByRole('status').filter({ hasText: 'Загружаем' })).toHaveCount(0);
  const late = slow(page, (u) => u.pathname.endsWith('/finance/preview'), 2500);
  const dlg = page.getByRole('dialog');
  await page.getByRole('button', { name: 'Внести доход' }).click();
  await dlg.getByLabel('Источник').selectOption({ label: 'Мероприятие' });
  const first = page.waitForRequest((r) => r.url().endsWith('/finance/preview'));
  await dlg.getByLabel('Сумма, ₽').fill('100');
  await first;
  await dlg.getByLabel('Сумма, ₽').fill('200');
  await expect(dlg.getByTestId('op-preview')).toHaveText('Остаток (наличные): 14 700,00 ₽ → 14 900,00 ₽');
  await late;
  await expect(dlg.getByTestId('op-preview')).toHaveText('Остаток (наличные): 14 700,00 ₽ → 14 900,00 ₽');
});

test('Касса: журнал, начатый до операции и пришедший после, не прячет внесённую операцию', async ({ page }) => {
  await login(page, 'owner@yu.test');
  const late = slow(page, (u) => u.pathname.endsWith('/finance/operations'), 4000);
  await page.goto('/finance/b-nsk-krasny');
  await expect(page.locator('astro-island[ssr]')).toHaveCount(0);
  const dlg = page.getByRole('dialog');
  await page.getByRole('button', { name: 'Внести доход' }).click();
  await dlg.getByLabel('Источник').selectOption({ label: 'Мероприятие' });
  await dlg.getByLabel('Сумма, ₽').fill('50');
  await dlg.getByLabel('Комментарий (необязательно)').fill('Поздний журнал');
  await dlg.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByTestId('op-saved')).toBeVisible();
  await late;
  await expect(page.getByTestId('fin-journal').locator('tbody tr').filter({ hasText: 'Поздний журнал' })).toHaveCount(1);
});

test('График филиала: перечитывание после нового исключения не стирает несохранённые часы недели', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, '/resources/b-nsk-krasny/schedule');
  const hours = page.getByTestId('hours');
  await hours.getByLabel('Пт, закрытие').fill('19:30');
  const box = page.getByTestId('exceptions');
  const d = new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10);
  await box.getByLabel('Дата').fill(d);
  await box.getByLabel('Вид').selectOption({ label: 'Технический день – закрыто' });
  await box.getByLabel('Причина *').fill('Поздний ответ');
  await box.getByRole('button', { name: 'Проверить затронутые брони' }).click();
  const reread = page.waitForResponse((r) => r.request().method() === 'GET' && new URL(r.url()).pathname.endsWith('/hours'));
  await page.getByTestId('exception-affected').getByRole('button', { name: /^Сохранить исключение/ }).click();
  await expect(box.getByText('Сохранено.')).toBeVisible();
  await expect(box.locator('.yc-history__item').filter({ hasText: 'Поздний ответ' })).toHaveCount(1);
  await reread;
  await pause(300); // эффект графика срабатывает после отрисовки
  await expect(hours.getByLabel('Пт, закрытие')).toHaveValue('19:30');
});

test('Карточка брони: перечитывание после действия не стирает набранный и не сохранённый комментарий', async ({ page }) => {
  await login(page, 'admin@yu.test');
  await open(page, '/bookings/b0000000-0000-4000-8000-000000000001'); // идёт сейчас (crm-booking.spec STARTED)
  await page.getByLabel('Служебный комментарий').fill('Попросил второй геймпад');
  await page.getByRole('button', { name: 'Отметить приход' }).click();
  await expect(page.getByTestId('booking-status')).toHaveText('Пришёл');
  await expect(page.getByLabel('Служебный комментарий')).toHaveValue('Попросил второй геймпад');
});

test('Медиатека: список без фильтра, пришедший после поиска, не подменяет найденное', async ({ page }) => {
  await login(page, 'owner@yu.test');
  const late = slow(page, (u) => u.pathname.endsWith('/content/media') && !u.searchParams.has('q'));
  await open(page, '/content/media');
  const search = page.getByLabel('Поиск', { exact: true });
  await search.fill('zal');
  await search.press('Enter');
  const tiles = page.getByTestId('media-grid').locator('li');
  await expect(tiles.first()).toBeVisible();
  await late;
  await expect(tiles.filter({ hasNotText: /zal/i })).toHaveCount(0);
});

test('Выбор из медиатеки: список при открытии, пришедший после поиска, не подменяет найденное', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, `/content/publications/${CONTENT_IDS.pubCity}`);
  const late = slow(page, (u) => u.pathname.endsWith('/content/media') && !u.searchParams.has('q'));
  await page.getByRole('button', { name: 'Выбрать из медиатеки…' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Поиск по описанию и имени').fill('zal');
  await dlg.getByRole('button', { name: 'Найти' }).click();
  await expect(dlg.getByRole('button', { name: 'Выбрать: zal-krasny.jpg' })).toBeVisible();
  await late;
  await expect(dlg.getByRole('button', { name: /^Выбрать:/ })).toHaveCount(1);
});

test('Новое мероприятие: смена заказчика меняет подставленные имя и телефон, ответ по прежнему клиенту не применяется', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, '/events');
  await page.getByRole('button', { name: 'Новое мероприятие' }).click();
  const form = page.getByTestId('event-form');
  const pick = form.getByTestId('pick-customer');
  const choose = async (q: string) => {
    await pick.getByRole('searchbox').fill(q);
    await pick.getByRole('button', { name: 'Найти' }).click();
    await pick.getByRole('button', { name: new RegExp(`^${q}`) }).click();
  };
  await choose('Смирнова');
  await expect(form.getByLabel('Заказчик: телефон')).toHaveValue('+79131234567');
  const late = slow(page, (u) => u.pathname.endsWith('/clients/c0000000-0000-4000-8000-000000000001'));
  await pick.getByRole('button', { name: 'Убрать' }).click();
  await choose('Смирнова'); // ответ задержан
  await pick.getByRole('button', { name: 'Убрать' }).click();
  await choose('Петров');
  await expect(form.getByLabel('Заказчик: имя')).toHaveValue('Петров Иван');
  await expect(form.getByLabel('Заказчик: телефон')).toHaveValue('+79139876543');
  await late;
  await expect(form.getByLabel('Заказчик: телефон')).toHaveValue('+79139876543');
  await form.getByLabel('Заказчик: телефон').fill('+7 913 000-00-01'); // руками – смена заказчика не трогает
  await pick.getByRole('button', { name: 'Убрать' }).click();
  await choose('Смирнова');
  await expect(form.getByLabel('Заказчик: имя')).toHaveValue('Смирнова Ольга');
  await pause(500);
  await expect(form.getByLabel('Заказчик: телефон')).toHaveValue('+7 913 000-00-01');
});

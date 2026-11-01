// Проверка S1-23 (план 6.2): бронь администратором и действия карточки. Создание без профиля (телефон+имя)
// и с клиентом из поиска, пересечение – понятный отказ без сброса ввода, двойной клик – одна запись.
import { expect, test, type Page } from '@playwright/test';
import { MOCK_PASSWORD } from './mock-api.ts';

const MOCK = process.env.MOCK_URL ?? 'http://127.0.0.1:4012';
const SHOTS = process.env.SCREENSHOT_DIR ?? 'test-results/screens';
const TZ = 'Asia/Novosibirsk';
const BRANCH = 'b-nsk-krasny';
const day = (n: number) => {
  const base = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
  return new Date(Date.parse(`${base}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
};

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
const dayBookings = async (page: Page, date: string) =>
  ((await (await page.request.get(`/api/crm/v1/branches/${BRANCH}/bookings?date=${date}&limit=100`)).json()) as { items: Array<{ id: string; resourceName: string; client: { name: string | null; isGuest: boolean } }> }).items;

test('создание без профиля из слота календаря: телефон+имя, двойной клик – одна запись', async ({ page }) => {
  await login(page, 'admin@yu.test');
  await page.goto(`/schedule?date=${day(2)}`);
  await page.getByRole('button', { name: 'ПК 1, 12:00 – новая запись' }).click();
  const dialog = page.getByRole('dialog', { name: 'Новая запись' });
  await expect(dialog.getByLabel('Место')).toHaveValue('res-pc1');
  await expect(dialog.getByLabel('Начало')).toHaveValue('12:00');
  await dialog.getByRole('button', { name: 'Без профиля' }).click();
  await dialog.getByRole('button', { name: 'Записать' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Укажите телефон клиента полностью');
  await dialog.getByLabel('Телефон *').fill('+7 913 555-44-33');
  await dialog.getByLabel('Имя *').fill('Пётр');
  await dialog.getByLabel('Фамилия').fill('Гостев');
  await dialog.getByRole('button', { name: 'Записать' }).dblclick();
  const done = page.getByTestId('booking-created');
  await expect(done).toContainText('создана');
  await expect(done).toContainText('ПК 1, ' + `${day(2).slice(8, 10)}.${day(2).slice(5, 7)}, 12:00–13:00`);
  const list = (await dayBookings(page, day(2))).filter((b) => b.client.name === 'Пётр Гостев');
  expect(list).toHaveLength(1);
  expect(list[0]!.client.isGuest).toBe(true);
  await done.getByRole('button', { name: 'Закрыть' }).click();
  await expect(page.getByTestId('desk-day')).toContainText('Пётр Гостев');
  await expect(page.getByTestId('cal-lane-res-pc1').getByTestId('cal-item')).toHaveAttribute('aria-label', /Пётр Гостев/);
});

test('пересечение – понятный отказ, ввод сохраняется; клиент из поиска; пересечение у клиента', async ({ page }) => {
  await login(page, 'admin@yu.test');
  await page.goto(`/schedule?date=${day(1)}`);
  await page.getByRole('button', { name: 'Новая запись', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Новая запись' });
  await dialog.getByLabel('Телефон или фамилия').fill('Петров');
  await dialog.getByRole('button', { name: 'Найти' }).click();
  await expect(dialog.getByRole('radio', { name: /Иван Петров/ })).toBeChecked(); // единственный найденный выбран
  await dialog.getByLabel('Место').selectOption('res-pc1');
  await dialog.getByLabel('Начало').fill('20:30');
  await dialog.getByRole('button', { name: 'Записать' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Запись не создана. Это время уже занято другой записью. Выберите другое время или место.');
  await expect(dialog.getByLabel('Начало')).toHaveValue('20:30');
  await expect(dialog.getByRole('radio', { name: /Иван Петров/ })).toBeChecked();
  await page.screenshot({ path: `${SHOTS}/booking-overlap-1440.png` });

  // Ольга уже записана на ПК 1 в 20:00 – на ПК 2 в то же время нельзя (пересечение у клиента по сети).
  await dialog.getByLabel('Телефон или фамилия').fill('Смирнова');
  await dialog.getByRole('button', { name: 'Найти' }).click();
  await dialog.getByLabel('Место').selectOption('res-pc2');
  await dialog.getByRole('button', { name: 'Записать' }).click();
  await expect(dialog.getByRole('alert')).toContainText('У клиента уже есть запись на это время');

  await dialog.getByLabel('Начало').fill('18:00');
  await dialog.getByRole('button', { name: 'Записать' }).click();
  await expect(page.getByTestId('booking-created')).toContainText('Ольга Смирнова');
});

const card = (page: Page, id: string) => page.goto(`/bookings/${id}`);
const timeline = (page: Page) => page.getByTestId('booking-timeline').locator('li');
const STARTED = 'b0000000-0000-4000-8000-000000000001'; // идёт сейчас (ПК 2)
const ENDED = 'b0000000-0000-4000-8000-000000000002'; // прошёл без отметки (VR1)

test('отмена без комментария невозможна; окно «было → станет»; после отмены кнопок нет', async ({ page }) => {
  await login(page, 'admin@yu.test');
  await card(page, 'bk-pc1-evening');
  await expect(page.getByTestId('booking-status')).toHaveText('Подтверждена');
  await page.getByRole('button', { name: 'Отменить запись…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Отменить запись?' });
  await expect(dialog.getByTestId('before-after')).toContainText('Подтверждена · ПК 1');
  await expect(dialog.getByTestId('before-after')).toContainText('Отменена клубом');
  await dialog.getByRole('button', { name: 'Отменить запись' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Укажите комментарий – без него отмену не сохранить.');
  await expect(page.getByTestId('booking-status')).toHaveText('Подтверждена');
  // и сервер не принимает пустой комментарий
  const b = (await (await page.request.get('/api/crm/v1/bookings/bk-pc1-evening')).json()) as { rowVersion: number };
  const r = await page.request.post('/api/crm/v1/bookings/bk-pc1-evening/cancel', {
    headers: { 'idempotency-key': crypto.randomUUID() }, data: { rowVersion: b.rowVersion, initiator: 'club', reasonId: '00000000-0000-4000-8000-000000000007', comment: '  ' },
  });
  expect(r.status()).toBe(422);
  expect(((await r.json()) as { error: { code: string } }).error.code).toBe('COMMENT_REQUIRED');

  await dialog.getByLabel('Клиент по телефону').check();
  await expect(dialog.getByTestId('before-after')).toContainText('Отменена клиентом');
  await expect(dialog.getByLabel('Причина *')).toHaveValue(/.+/); // первая причина нужного домена выбрана сама
  await dialog.getByLabel('Причина *').selectOption({ label: 'Изменились планы' });
  await dialog.getByLabel('Комментарий *').fill('Позвонил, заболел');
  await dialog.getByRole('button', { name: 'Отменить запись' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('booking-status')).toHaveText('Отменена клиентом');
  await expect(page.getByTestId('booking-cancel')).toContainText('Изменились планы · «Позвонил, заболел»');
  await expect(page.getByTestId('booking-actions')).toHaveCount(0);
  await expect(timeline(page).first()).toContainText('Запись отменена');
  await expect(timeline(page).first()).toContainText('Причина: Позвонил, заболел');
});

test('приход дважды – одно посещение; завершение', async ({ page }) => {
  await login(page, 'admin@yu.test');
  await card(page, STARTED);
  await expect(page.getByRole('button', { name: 'Неявка…' })).toBeVisible(); // сеанс начался
  await page.getByRole('button', { name: 'Отметить приход' }).dblclick();
  await expect(page.getByTestId('booking-status')).toHaveText('Пришёл');
  await expect(page.getByTestId('booking-visit')).toContainText('пришёл в');
  await expect(timeline(page).filter({ hasText: 'Отмечен приход' })).toHaveCount(1);
  // повтор с другой вкладки (новый ключ, свежая версия) – отказ, посещение одно
  const b = (await (await page.request.get(`/api/crm/v1/bookings/${STARTED}`)).json()) as { rowVersion: number; timeline: Array<{ action: string }> };
  const again = await page.request.post(`/api/crm/v1/bookings/${STARTED}/arrive`, { headers: { 'idempotency-key': crypto.randomUUID() }, data: { rowVersion: b.rowVersion } });
  expect(again.status()).toBe(409);
  expect(b.timeline.filter((e) => e.action === 'visit.confirmed')).toHaveLength(1);
  await expect(page.getByRole('button', { name: 'Отметить приход' })).toHaveCount(0); // только разрешённые действия
  await page.getByRole('button', { name: 'Завершить сеанс' }).click();
  await expect(page.getByTestId('booking-status')).toHaveText('Завершена');
  await expect(page.getByTestId('booking-visit')).toContainText('завершено в');
});

test('неявка у прошедшей записи; исправление с причиной – у Директора, у Администратора кнопки нет', async ({ page, browser }) => {
  await login(page, 'admin@yu.test');
  await card(page, ENDED);
  await expect(page.getByText('Требует решения')).toBeVisible();
  await page.getByRole('button', { name: 'Неявка…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Отметить неявку?' });
  await expect(dialog.getByTestId('before-after')).toContainText('Неявка · посещение не создаётся');
  await dialog.getByRole('button', { name: 'Отметить неявку' }).click();
  await expect(page.getByTestId('booking-status')).toHaveText('Неявка');
  await expect(page.getByRole('button', { name: 'Исправить отметку…' })).toHaveCount(0); // нет booking.visit.correct

  const director = await (await browser.newContext()).newPage();
  await login(director, 'director@yu.test');
  await card(director, ENDED);
  await director.getByRole('button', { name: 'Исправить отметку…' }).click();
  const fix = director.getByRole('dialog', { name: 'Исправить отметку?' });
  await fix.getByRole('button', { name: 'Исправить' }).click();
  await expect(fix.getByRole('alert')).toHaveText('Укажите причину исправления.');
  await fix.getByLabel('Причина исправления *').fill('Клиент пришёл, отметили по ошибке');
  await fix.getByRole('button', { name: 'Исправить' }).click();
  await expect(director.getByTestId('booking-status')).toHaveText('Подтверждена');
  await expect(timeline(director).first()).toContainText('Отметка неявки исправлена');
  await expect(timeline(director).first()).toContainText('Директор');
  await expect(director.getByRole('button', { name: 'Отметить приход' })).toBeVisible();
  await director.context().close();
});

test('409 по rowVersion – понятное сообщение и обновлённая карточка; повтор проходит', async ({ page }) => {
  await login(page, 'admin@yu.test');
  await card(page, 'bk-vrroom');
  // другой сотрудник успел поменять запись
  const r = await page.request.patch('/api/crm/v1/bookings/bk-vrroom', { headers: { 'idempotency-key': crypto.randomUUID() }, data: { rowVersion: 1, internalComment: 'Просили два геймпада' } });
  expect(r.status()).toBe(200);
  await page.getByRole('button', { name: 'Отменить запись…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Отменить запись?' });
  await dialog.getByLabel('Комментарий *').fill('Ремонт VR');
  await dialog.getByRole('button', { name: 'Отменить запись' }).click();
  await expect(page.getByTestId('booking-notice')).toHaveText('Запись уже изменил другой сотрудник. Карточка обновлена – проверьте данные и повторите действие.');
  await expect(page.getByLabel('Служебный комментарий')).toHaveValue('Просили два геймпада');
  await expect(page.getByTestId('booking-status')).toHaveText('Подтверждена');
  await page.getByRole('button', { name: 'Отменить запись…' }).click();
  await dialog.getByLabel('Комментарий *').fill('Ремонт VR');
  await dialog.getByRole('button', { name: 'Отменить запись' }).click();
  await expect(page.getByTestId('booking-status')).toHaveText('Отменена клубом');
});

test('Администратор чужого филиала – 404 на карточку и действия', async ({ page }) => {
  await login(page, 'admin@yu.test');
  expect((await card(page, 'bk-tsk'))?.status()).toBe(404);
  await expect(page.getByTestId('not-found')).toBeVisible();
  const r = await page.request.post('/api/crm/v1/bookings/bk-tsk/arrive', { headers: { 'idempotency-key': crypto.randomUUID() }, data: { rowVersion: 1 } });
  expect(r.status()).toBe(404);
});

test('перенос: новый слот из календаря, «было → станет», причина обязательна, вторая версия', async ({ page, request }) => {
  expect((await request.post(`${MOCK}/__test/reset`)).ok()).toBe(true);
  await login(page, 'admin@yu.test');
  await card(page, 'bk-pc1-evening');
  await page.getByRole('button', { name: 'Перенести…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Перенести запись' });
  await expect(dialog.getByTestId('cal-lane-res-pc1').locator('.yc-cal__item--current')).toBeVisible(); // переносимая подсвечена
  await dialog.getByRole('button', { name: 'Перенести', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Выберите новое время в календаре.');
  await dialog.getByRole('button', { name: 'ПК 2, 18:00 – перенести сюда' }).click();
  const d = `${day(1).slice(8, 10)}.${day(1).slice(5, 7)}`;
  await expect(dialog.getByTestId('before-after')).toContainText(`ПК 1, ${d}, 20:00–22:00`);
  await expect(dialog.getByTestId('before-after')).toContainText(`ПК 2, ${d}, 18:00–20:00`); // длительность сохранена
  await dialog.getByRole('button', { name: 'Перенести', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Укажите причину переноса.');
  await dialog.getByLabel('Причина переноса *').fill('Клиент попросил пораньше');
  await page.screenshot({ path: `${SHOTS}/booking-reschedule-1440.png` });
  await dialog.getByRole('button', { name: 'Перенести', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('booking-notice')).toHaveText('Запись перенесена.');
  await expect(page.getByTestId('booking-time')).toContainText(`${d}, 18:00–20:00`);
  await expect(page.getByTestId('booking-versions').locator('li')).toHaveCount(2);
  await expect(page.getByTestId('booking-versions').locator('li').first()).toContainText('Версия 2 (текущая): ПК 2');
  await expect(timeline(page).first()).toContainText('Запись перенесена');
  await expect(timeline(page).first()).toContainText(`ПК 2, ${d}, 18:00–20:00`);
  // календарь видит новое место
  await page.goto(`/schedule?date=${day(1)}`);
  await expect(page.getByTestId('cal-lane-res-pc2').getByTestId('cal-item')).toHaveAttribute('aria-label', /18:00–20:00, Ольга Смирнова/);
  await expect(page.getByTestId('cal-lane-res-pc1').getByTestId('cal-item')).toHaveCount(0);
});

test('снимки карточки и окна отмены 1440 и 390 без горизонтальной прокрутки', async ({ browser, request }) => {
  expect((await request.post(`${MOCK}/__test/reset`)).ok()).toBe(true);
  for (const [w, h] of [[1440, 900], [390, 844]] as const) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: w === 390 ? 2 : 1, timezoneId: TZ, locale: 'ru-RU' });
    const page = await ctx.newPage();
    await login(page, 'admin@yu.test');
    await card(page, 'bk-pc1-evening');
    await expect(page.getByTestId('booking-props')).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/booking-card-${w}.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(w);
    await page.getByRole('button', { name: 'Отменить запись…' }).click();
    await page.screenshot({ path: `${SHOTS}/booking-cancel-${w}.png` });
    await ctx.close();
  }
});

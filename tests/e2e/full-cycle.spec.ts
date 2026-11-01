// S1-27: сквозной цикл на живом стенде. Сайт → выбор клуба → расписание → слот → удержание → вход по коду прямо
// в потоке (код – из лога API стенда) → подтверждение → ЛК «Мои записи» → CRM (демо-Администратор Арбата) видит
// бронь в календаре → приход → завершение → в ЛК запись в «Прошлых» и «Посещениях». Плюс отмена клиентом из ЛК
// и отмена клубом из CRM с запланированным уведомлением клиенту (app.notifications, SQL по ssh).
// Клиент – новый номер на каждый прогон; слоты – первые свободные завтрашние, поэтому повторный прогон не упирается
// в занятое прошлым. Отменённые брони время освобождают; завершённая остаётся в истории (так и должно быть).
import { expect, test, type Browser, type Page } from '@playwright/test';
import {
  CRM_URL, DEMO_ADMIN, SITE_URL, SiteClient, at, branchBySlug, crmLogin, dayIn, ddmm, localPhone, logMark, otpCode,
  hydrated, randomPhone, resourcesOf, sql, type BookingDto, type StandBranch, type StandResource,
} from './stand.ts';

test.use({ baseURL: SITE_URL });
test.describe.configure({ mode: 'serial' });

let branch: StandBranch;
let pcs: StandResource[];
let site: Page;
let crm: Page;
let client: SiteClient;
const phone = randomPhone();
let main: BookingDto;
const leftovers: string[] = [];

const timeIn = (iso: string, tz: string) =>
  new Intl.DateTimeFormat('ru-RU', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));

/** Первый свободный слот ПК на день (+n), не раньше from: имя ресурса и время – для aria-label сетки. */
async function freePc(day: number, from = '12:00', skip: string[] = []) {
  const date = dayIn(branch.timezone, day);
  const a = await client.availability(branch.id, date);
  const min = Date.parse(at(date, from, branch.timezone));
  for (const r of pcs) {
    const s = a.resources.find((x) => x.resourceId === r.id)?.slots.find((x) => x.state === 'free' && Date.parse(x.start) >= min && !skip.includes(`${r.id}@${x.start}`));
    if (s) return { r, slot: s, label: `${r.name}, ${timeIn(s.start, branch.timezone)}–${timeIn(s.end, branch.timezone)}` };
  }
  throw new Error(`на ${date} нет свободных ПК`);
}

async function openCrm(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'ru-RU', timezoneId: branch.timezone, viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  await crmLogin(p, DEMO_ADMIN.email, DEMO_ADMIN.password());
  return p;
}

async function myTab(name: 'Будущие' | 'Прошлые' | 'Отменённые' | 'Посещения') {
  await site.goto('/account/');
  await hydrated(site);
  await site.getByRole('tab', { name }).click();
  await expect(site.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true');
  return site.getByRole('tabpanel');
}

test.beforeAll(async ({ browser }) => {
  const ctx = await browser.newContext({ baseURL: SITE_URL, ignoreHTTPSErrors: true, locale: 'ru-RU', timezoneId: 'Europe/Moscow' });
  site = await ctx.newPage();
  client = new SiteClient(site.request, phone);
  branch = await branchBySlug(site.request, 'moskva', 'arbat');
  pcs = (await resourcesOf(site.request, branch.id)).filter((r) => r.type === 'pc');
  expect(pcs.length).toBeGreaterThan(0);
});

test.afterAll(async () => {
  if (leftovers.length) await client.cleanup(leftovers).catch(() => undefined);
  await crm?.context().close();
  await site?.context().close();
});

test('сайт: клуб → расписание → слот → удержание → вход по коду в потоке → подтверждение → ЛК', async () => {
  await site.goto('/');
  // остров выбора клуба оживает после загрузки скрипта – до этого клик ничего не открывает
  const toggle = site.getByTestId('branch-picker').locator('.yu-picker__toggle');
  await expect(async () => {
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true', { timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  await site.getByRole('button', { name: /Ю Клуб Арбат/ }).click();
  await expect(site).toHaveURL(/\/moskva\/arbat\/$/);
  await expect(site.getByTestId('branch-title')).toHaveText(branch.name);
  await site.getByTestId('branch-book').click();
  await expect(site).toHaveURL(/\/schedule\/\?branch=moskva\/arbat/);
  await expect(site.getByTestId('schedule-branch')).toContainText(branch.name);

  const tomorrow = site.getByRole('button', { name: /^Завтра/ });
  await expect(async () => {
    await tomorrow.click();
    await expect(tomorrow).toHaveAttribute('aria-pressed', 'true', { timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  const pick = await freePc(1);
  const cell = site.getByRole('button', { name: `${pick.label}, свободно`, exact: true });
  await cell.click();
  await expect(site.getByRole('button', { name: `${pick.label}, выбрано вами`, exact: true })).toBeVisible();
  await expect(site.getByTestId('hold-panel')).toContainText(pick.r.name);
  await expect(site.getByTestId('schedule-status')).toHaveAttribute('data-state', 'held');

  await site.getByRole('button', { name: 'Оформить запись' }).click();
  await site.getByLabel('Телефон').fill(localPhone(phone));
  const mark = logMark();
  await site.getByRole('button', { name: 'Получить код' }).click();
  await site.getByLabel('Код из SMS').fill(await otpCode(phone, mark));
  await site.getByLabel(/согласие на обработку/).check();
  await site.getByRole('button', { name: 'Войти и продолжить' }).click();
  await expect(site.getByTestId('checkout-items').locator('li')).toHaveCount(1);
  await expect(site.getByTestId('checkout-total')).toHaveText(/₽/);
  await expect(site.getByTestId('confirm')).toBeEnabled();

  const confirmed = site.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('/confirm/'));
  await site.getByTestId('confirm').click();
  expect((await confirmed).status()).toBe(201);
  // тело ответа уходит вместе с переходом на страницу успеха – бронь берём из «Моих записей» клиента
  main = (await client.my('upcoming')).items.find((b) => b.resourceId === pick.r.id && Date.parse(b.start) === Date.parse(pick.slot.start))!;
  expect(main, 'бронь в «Моих записях»').toBeTruthy();
  leftovers.push(main.id);
  await expect(site).toHaveURL(/\/booking\/success\/$/);
  await expect(site.getByRole('heading', { level: 1 })).toHaveText('Запись подтверждена');
  await expect(site.getByTestId('success-list')).toContainText(pick.r.name);

  await site.getByTestId('to-account').click();
  await expect(site).toHaveURL(/\/account\/$/);
  const item = site.getByTestId('my-list-upcoming').getByTestId('my-booking').filter({ hasText: `№ ${main.number} ·` });
  await expect(item).toContainText(pick.r.name);
  await expect(item).toContainText('Подтверждена');
  await expect(item).toContainText(branch.name);
});

test('CRM: Администратор видит бронь в календаре, отмечает приход и завершает; ЛК – «Прошлые» и «Посещения»', async ({ browser }) => {
  test.skip(!main, 'нет брони из первого шага');
  crm = await openCrm(browser);
  const date = dayIn(branch.timezone, 1);
  await crm.goto(`${CRM_URL}/schedule?branch=${branch.id}&date=${date}`);
  const lane = crm.getByTestId(`cal-lane-${main.resourceId}`);
  const cal = lane.locator(`[data-testid="cal-item"][aria-label^="Бронь №${main.number},"]`);
  await expect(cal.first()).toHaveAttribute('aria-label', new RegExp(`Бронь №${main.number}, .*Подтверждена`));
  // рабочий стол «Записи дня» – та же бронь: время, место и маскированный телефон клиента
  const row = crm.getByTestId('desk-day').locator('.yc-desk__row').filter({ hasText: `${timeIn(main.start, branch.timezone)}–${timeIn(main.end, branch.timezone)} · ${main.resourceName}` }).filter({ hasText: `••-${phone.slice(-2)}` });
  await expect(row).toContainText('Подтверждена');
  await expect(row).not.toContainText(phone.slice(2));
  await cal.first().click();
  await expect(crm).toHaveURL(new RegExp(`/bookings/${main.id}$`));
  await hydrated(crm);
  await expect(crm.getByTestId('booking-status')).toHaveText('Подтверждена');
  await expect(crm.getByTestId('booking-time')).toContainText(ddmm(date));

  await crm.getByRole('button', { name: 'Отметить приход' }).click();
  await expect(crm.getByTestId('booking-status')).toHaveText('Пришёл');
  await expect(crm.getByTestId('booking-visit')).toContainText('пришёл в');
  await crm.getByRole('button', { name: 'Завершить сеанс' }).click();
  await expect(crm.getByTestId('booking-status')).toHaveText('Завершена');
  await expect(crm.getByTestId('booking-visit')).toContainText('завершено в');
  await expect(crm.getByTestId('booking-timeline').locator('li').filter({ hasText: 'Отмечен приход' })).toHaveCount(1);
  await crm.screenshot({ path: test.info().outputPath('crm-booking-completed.png'), fullPage: true });

  const past = await myTab('Прошлые');
  const item = past.getByTestId('my-booking').filter({ hasText: `№ ${main.number} ·` });
  await expect(item).toBeVisible();
  await expect(item.locator('[data-status]')).toHaveAttribute('data-status', 'completed');
  await expect(item.getByRole('button', { name: 'Отменить запись' })).toHaveCount(0);
  const visits = await myTab('Посещения');
  await expect(visits.locator('li').filter({ hasText: `№ ${main.number} ·` })).toContainText('пришли в');
  await expect(site.getByRole('tab', { name: 'Будущие' })).toBeVisible();
  await site.screenshot({ path: test.info().outputPath('lk-visits.png'), fullPage: true });
});

test('отмена клиентом из ЛК: запись уходит в «Отменённые», время снова свободно', async () => {
  const pick = await freePc(1, '15:00');
  const [b] = await client.book(branch.id, [{ resourceId: pick.r.id, start: pick.slot.start, end: pick.slot.end }]);
  leftovers.push(b!.id);
  await myTab('Будущие');
  const item = site.getByTestId('my-list-upcoming').getByTestId('my-booking').filter({ hasText: `№ ${b!.number} ·` });
  await item.getByRole('button', { name: 'Отменить запись' }).click();
  const dialog = site.getByRole('dialog');
  await expect(dialog).toContainText(`Отменить запись № ${b!.number}?`);
  await dialog.getByRole('button', { name: 'Да, отменить' }).click();
  await expect(dialog).toBeHidden();
  await expect(item).toHaveCount(0);
  const cancelled = await myTab('Отменённые');
  await expect(cancelled.getByTestId('my-booking').filter({ hasText: `№ ${b!.number} ·` })).toContainText('Отменена вами');
  const a = await client.availability(branch.id, dayIn(branch.timezone, 1));
  expect(a.resources.find((x) => x.resourceId === pick.r.id)!.slots.find((s) => s.start === pick.slot.start)!.state).toBe('free');
  // клиент отменил сам – сообщения об отмене нет (K14: видит в ЛК)
  expect(sql(`SELECT count(*) FROM app.notifications WHERE booking_id = '${b!.id}' AND kind = 'booking_cancelled'`)).toEqual(['0']);
});

test('отмена клубом из CRM: комментарий обязателен, хронология, ЛК «Отменена клубом», уведомление запланировано', async ({ browser }) => {
  const pick = await freePc(1, '18:00');
  const [b] = await client.book(branch.id, [{ resourceId: pick.r.id, start: pick.slot.start, end: pick.slot.end }]);
  leftovers.push(b!.id);
  crm ??= await openCrm(browser);
  await crm.goto(`${CRM_URL}/bookings/${b!.id}`);
  await hydrated(crm);
  await expect(crm.getByTestId('booking-status')).toHaveText('Подтверждена');
  await crm.getByRole('button', { name: 'Отменить запись…' }).click();
  const dialog = crm.getByRole('dialog', { name: 'Отменить запись?' });
  await expect(dialog.getByTestId('before-after')).toContainText('Отменена клубом');
  await dialog.getByRole('button', { name: 'Отменить запись' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Укажите комментарий – без него отмену не сохранить.');
  await dialog.getByLabel('Комментарий *').fill('e2e S1-27: проверка отмены клубом');
  await dialog.getByRole('button', { name: 'Отменить запись' }).click();
  await expect(dialog).toBeHidden();
  await expect(crm.getByTestId('booking-status')).toHaveText('Отменена клубом');
  await expect(crm.getByTestId('booking-cancel')).toContainText('проверка отмены клубом');
  await expect(crm.getByTestId('booking-timeline').locator('li').first()).toContainText('Запись отменена');

  const cancelled = await myTab('Отменённые');
  await expect(cancelled.getByTestId('my-booking').filter({ hasText: `№ ${b!.number} ·` })).toContainText('Отменена клубом');
  // сообщение клиенту об отмене клубом – сервисное, планирует обработчик события (worker), ждём до 30 с
  await expect.poll(() => sql(`SELECT kind || ':' || category FROM app.notifications WHERE booking_id = '${b!.id}' AND kind = 'booking_cancelled'`), { timeout: 30_000, intervals: [1000] })
    .toEqual(['booking_cancelled:service']);
  // напоминания по отменённой брони не уйдут: плановые строки погашены
  expect(sql(`SELECT count(*) FROM app.notifications WHERE booking_id = '${b!.id}' AND kind LIKE 'reminder%' AND status = 'planned'`)).toEqual(['0']);
});

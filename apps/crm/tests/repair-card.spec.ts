// S3-80: карточка ремонта. TC-12 в интерфейсе: бронь в списке, не отменена молча; блокировка только после подтверждения; отмена из
// списка – команда клубом (сервисное уведомление по K4 booking.cancelled проверяет сквозной S3-97 на стенде), новая запись на период –
// RESOURCE_BLOCKED. План, статусы, согласование, закрытие со stillBlocked, расход без двойного учёта.
import { expect, test, type Page } from '../../../tests/support/e2e.ts';
import { MOCK_PASSWORD } from './mock-api.ts';

const OVERDUE = 'a0000000-0000-4000-8000-000000000001';
const PS5 = 'a0000000-0000-4000-8000-000000000002';
const CHECK = 'a0000000-0000-4000-8000-000000000005';
const SHOTS = process.env.CRM_SHOTS;

test.beforeEach(async ({ request }) => {
  await request.post(`${process.env.MOCK_URL ?? 'http://127.0.0.1:4012'}/__test/reset`);
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
const noScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const smallButtons = (page: Page) => page.locator('main button:visible, main a.yc-btn:visible').evaluateAll((els) => els.filter((e) => e.getBoundingClientRect().height < 44).map((e) => e.textContent));
const api = (page: Page, path: string) => page.evaluate(async (p) => (await fetch(`/api/crm/v1${p}`)).json(), path);
/** Шлем Quest в единице VR1: брони bk-vrroom (через 3 дня) и мероприятие (через 5 дней) в период предложения. */
async function registerOnVr1(page: Page) {
  await open(page, '/repairs/new?equipmentId=e0000000-0000-4000-8000-000000000001');
  const form = page.getByTestId('rp-form');
  await form.getByLabel('Дата поломки неизвестна').check();
  await form.getByLabel('Что случилось *').fill('Шлем VR1 не включается');
  await form.getByRole('button', { name: 'Зарегистрировать' }).click();
  await expect(page.getByTestId('rp-number')).toHaveText('R-000007');
  await expect(page.locator('astro-island[ssr]')).toHaveCount(0);
}
const period = async (page: Page, days: number) => {
  const end = new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  await page.getByTestId('rp-block-panel').getByLabel('По', { exact: true }).fill(`${end}T12:00`);
  await page.getByRole('button', { name: 'Показать затронутых' }).click();
};

test('TC-12: бронь и мероприятие в списке, блокировка только после подтверждения, отмена из списка – клубом, новая запись – отказ', async ({ page }) => {
  await login(page, 'admin@yu.test');
  await registerOnVr1(page);
  await period(page, 7);
  const affected = page.getByTestId('rp-booking-bk-vrroom');
  await expect(affected.getByTestId('rp-booking-status')).toHaveText('Подтверждена');
  await expect(page.getByTestId('rp-events')).toContainText('M-000042');
  await expect(page.getByTestId('rp-blocks')).toHaveCount(0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/repair-block-proposal-1440.png`, fullPage: true });

  await page.getByRole('button', { name: 'Заблокировать…' }).click();
  const dlg = page.getByRole('dialog');
  await expect(page.getByTestId('rp-confirm-note')).toContainText('не отменятся');
  await dlg.getByRole('button', { name: 'Не блокировать' }).click();
  await expect(page.getByTestId('rp-blocks')).toHaveCount(0);
  await page.getByRole('button', { name: 'Заблокировать…' }).click();
  await dlg.getByRole('button', { name: 'Подтвердить блокировку' }).click();
  await expect(page.getByTestId('rp-notice')).toContainText('требуют решения: 1');
  await expect(page.getByTestId('rp-blocks')).toContainText('Активна');
  await expect(affected.getByTestId('rp-booking-status')).toHaveText('Подтверждена');
  expect((await api(page, '/bookings/bk-vrroom')).status).toBe('confirmed');

  const blocked = await page.evaluate(async () => {
    const day = new Date(Date.now() + 2 * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Novosibirsk' });
    const r = await fetch('/api/crm/v1/branches/b-nsk-krasny/bookings', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify({ resourceId: 'res-vr1', start: `${day}T12:00:00+07:00`, end: `${day}T12:15:00+07:00`, client: { phone: '+79131112233', firstName: 'Гость' } }) });
    return (await r.json()).error?.code;
  });
  expect(blocked).toBe('RESOURCE_BLOCKED');

  await affected.getByRole('button', { name: 'Отменить клубом…' }).click();
  await dlg.getByRole('button', { name: 'Отменить запись' }).click();
  await expect(dlg.getByRole('alert')).toContainText('комментарий');
  await dlg.getByLabel('Причина *').selectOption({ label: 'Неисправность оборудования' });
  await dlg.getByLabel('Комментарий *').fill('Сломан шлем');
  const cancel = page.waitForRequest((r) => r.url().endsWith('/bookings/bk-vrroom/cancel'));
  await dlg.getByRole('button', { name: 'Отменить запись' }).click();
  expect(JSON.parse((await cancel).postData() ?? '{}').initiator).toBe('club');
  await expect(affected.getByTestId('rp-booking-status')).toHaveText('Отменена клубом');
  await expect(affected).toContainText('сервисное уведомление');
  const card = await api(page, '/bookings/bk-vrroom');
  expect(card.status).toBe('cancelled_by_club');
});

test('перенос из списка – диалог брони с календарём', async ({ page }) => {
  await login(page, 'director@yu.test');
  await registerOnVr1(page);
  await period(page, 7);
  await page.getByTestId('rp-booking-bk-vrroom').getByRole('button', { name: 'Перенести…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Перенести запись' });
  await dialog.getByRole('button', { name: 'VR-комната целиком, 18:00 – перенести сюда' }).click({ timeout: 15_000 });
  await dialog.getByLabel('Причина переноса *').fill('Шлем в ремонте');
  await dialog.getByRole('button', { name: 'Перенести', exact: true }).click();
  await expect(dialog).toBeHidden();
  const row = page.getByTestId('rp-booking-bk-vrroom');
  await expect(row).toContainText('18:00–20:00');
  await expect(row.getByTestId('rp-booking-status')).toHaveText('Подтверждена');
});

test('план, статусы, порог согласования: Директор упирается, Владелец согласует; просрочка видна', async ({ page }) => {
  await login(page, 'director@yu.test');
  await open(page, `/repairs/${PS5}`);
  await expect(page.getByTestId('rp-status')).toHaveText('Диагностика');
  await page.getByLabel('Плановая сумма, ₽').fill('15000');
  await page.getByLabel('Что планируем сделать').fill('Заменить блок питания');
  await page.getByRole('button', { name: 'Новый исполнитель…' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Наименование или ФИО *').fill('Мастер Пётр');
  await dlg.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: /^Исполнитель/ })).toHaveValue(/.+/);
  await page.getByRole('button', { name: 'Сохранить план' }).click();
  await expect(page.getByTestId('rp-notice')).toContainText('нужно согласование');

  await page.getByRole('button', { name: 'Запланирован…' }).click();
  await dlg.getByRole('button', { name: 'Сохранить' }).click();
  await expect(dlg.getByRole('alert')).toContainText('комментарий');
  await dlg.getByLabel('Комментарий *').fill('Можно начинать');
  await dlg.getByRole('button', { name: 'Сохранить' }).click();
  await expect(dlg.getByRole('alert')).toContainText('согласование Владельца');
  await dlg.getByRole('button', { name: 'Не менять' }).click();
  await page.getByRole('button', { name: 'На согласование…' }).click();
  await dlg.getByLabel('Комментарий *').fill('Дорого');
  await dlg.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByTestId('rp-status')).toHaveText('Ждёт согласования');
  await expect(page.getByTestId('rp-needs-approval')).toContainText('ждёт согласования Владельца');
  await expect(page.getByRole('button', { name: 'Согласовать…' })).toHaveCount(0);
  await page.context().clearCookies();

  await login(page, 'owner@yu.test');
  await open(page, `/repairs/${PS5}`);
  await page.getByRole('button', { name: 'Согласовать…' }).click();
  await dlg.getByLabel('Комментарий *').fill('Берём');
  await dlg.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByTestId('rp-status')).toHaveText('Запланирован');
  await expect(page.getByTestId('rp-approved')).toBeVisible();
  await expect(page.getByTestId('rp-timeline')).toContainText('Решение по согласованию');
  await open(page, `/repairs/${OVERDUE}`);
  await expect(page.getByTestId('rp-overdue')).toContainText('План просрочен');
});

test('отмена ремонта – окно внутри записи; запись остаётся; Администратор не управляет статусами', async ({ page }) => {
  await login(page, 'admin@yu.test');
  await open(page, `/repairs/${PS5}`);
  await expect(page.getByTestId('rp-plan-view')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Отменить ремонт…' })).toHaveCount(0);
  await page.context().clearCookies();
  await login(page, 'director@yu.test');
  await open(page, `/repairs/${PS5}`);
  await page.getByRole('button', { name: 'Отменить ремонт…' }).click();
  await expect(page.getByTestId('rp-cancel-note')).toContainText('не удаляются');
  await page.getByRole('dialog').getByLabel('Комментарий *').fill('Создан по ошибке');
  await page.getByRole('dialog').getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByTestId('rp-status')).toHaveText('Отменён');
  await open(page, '/repairs?status=cancelled');
  await expect(page.getByTestId('rp-R-000002')).toBeVisible();
});

test('закрытие: не хватает данных; другой открытый ремонт – stillBlocked показан; снятие блокировки', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, 'director@yu.test');
  await open(page, `/repairs/${CHECK}`);
  await period(page, 2);
  await page.getByRole('button', { name: 'Заблокировать…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Подтвердить блокировку' }).click();
  await expect(page.getByTestId('rp-blocks')).toContainText('Активна');
  expect(await noScroll(page)).toBe(true);
  expect(await smallButtons(page)).toEqual([]);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/repair-card-390.png`, fullPage: true });

  await page.getByRole('button', { name: 'Закрыть ремонт…' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Выполненные работы *').fill('');
  await dlg.getByRole('button', { name: 'Закрыть ремонт' }).click();
  await expect(dlg.getByRole('alert')).toContainText('выполненные работы');
  await dlg.getByLabel('Выполненные работы *').fill('Заменена линза');
  await dlg.getByRole('checkbox', { name: 'Без затрат' }).check();
  await dlg.getByRole('button', { name: 'Закрыть ремонт' }).click();
  await expect(dlg.getByRole('alert')).toContainText('с комментарием');
  await dlg.getByRole('checkbox', { name: 'Без затрат' }).uncheck();
  await dlg.getByLabel('Фактическая сумма, ₽ *').fill('5000');
  await dlg.getByTestId('rp-lift').getByRole('checkbox').check();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/repair-close-390.png` });
  await dlg.getByRole('button', { name: 'Закрыть ремонт' }).click();

  await expect(page.getByTestId('rp-status')).toHaveText('Закрыт');
  await expect(page.getByTestId('rp-still')).toContainText('другой открытый ремонт');
  await expect(page.getByTestId('rp-blocks')).toContainText('Активна');
  // Снятие – с настоящей rowVersion блокировки из карточки; 409 – сообщение без тихого повтора
  const ver = ((await api(page, `/repairs/${CHECK}`)).blocks as Array<{ active: boolean; rowVersion: number }>).find((b) => b.active)!.rowVersion;
  expect(ver).toEqual(expect.any(Number));
  const lifts: number[] = [];
  await page.route('**/blocks/*/lift', async (route) => {
    lifts.push((route.request().postDataJSON() as { rowVersion: number }).rowVersion);
    if (lifts.length > 1) return route.continue();
    return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'VERSION_CONFLICT', message: 'Запись изменилась', details: { current: ver + 1 } } }) });
  });
  await page.getByRole('button', { name: 'Снять блокировку' }).click();
  await expect(page.getByTestId('rp-block-panel').getByRole('alert')).toContainText('изменил другой сотрудник');
  expect(lifts).toEqual([ver]);
  await page.getByRole('button', { name: 'Снять блокировку' }).click();
  await expect(page.getByTestId('rp-blocks')).toContainText('Снята');
  expect(lifts).toEqual([ver, ver]);
  await page.unroute('**/blocks/*/lift');
  await expect(page.getByRole('button', { name: 'Закрыть ремонт…' })).toHaveCount(0);
});

test('расход: подтверждение; двойной клик – одна операция; связь из кассы без новой; без затрат нельзя при расходе', async ({ page }) => {
  await login(page, 'director@yu.test');
  await open(page, `/repairs/${CHECK}`);
  let posts = 0;
  page.on('request', (r) => { if (r.url().endsWith(`/repairs/${CHECK}/expense`)) posts++; });
  const before = (await api(page, '/branches/b-nsk-krasny/finance/operations?kind=expense')).items.length;
  await page.getByRole('button', { name: 'Создать расход…' }).click();
  const dlg = page.getByRole('dialog');
  await expect(page.getByTestId('rp-expense-note')).toContainText('одна операция');
  await expect(dlg.getByLabel('Сумма, ₽ *')).toHaveValue('5000');
  await dlg.getByLabel('Сумма, ₽ *').fill('1000');
  await dlg.getByRole('button', { name: 'Создать расход' }).dblclick();
  await expect(page.getByTestId('rp-paid')).toContainText('1 000,00 ₽');
  await expect(page.getByTestId('rp-paid')).toContainText('операций: 1');
  expect(posts).toBeLessThanOrEqual(1);
  const after = (await api(page, '/branches/b-nsk-krasny/finance/operations?kind=expense')).items;
  expect(after.length).toBe(before + 1);

  await page.getByRole('button', { name: 'Связать расход из кассы…' }).click();
  await expect(dlg.getByLabel('Расход *').locator('option')).not.toHaveCount(1);
  const options = await dlg.getByLabel('Расход *').locator('option').count();
  expect(options).toBeGreaterThan(1);
  await dlg.getByLabel('Расход *').selectOption({ index: 1 });
  await dlg.getByRole('button', { name: 'Связать' }).click();
  await expect(page.getByTestId('rp-paid')).toContainText('операций: 2');
  const noNew = (await api(page, '/branches/b-nsk-krasny/finance/operations?kind=expense')).items.length;
  expect(noNew).toBe(after.length);

  await page.getByRole('button', { name: 'Закрыть ремонт…' }).click();
  await dlg.getByRole('checkbox', { name: 'Без затрат' }).check();
  await dlg.getByLabel('Почему без затрат *').fill('Гарантия');
  await dlg.getByRole('button', { name: 'Закрыть ремонт' }).click();
  await expect(dlg.getByRole('alert')).toContainText('отметка «без затрат»');
  await dlg.getByRole('button', { name: 'Не сейчас' }).click();
  await page.context().clearCookies();
  await login(page, 'admin@yu.test');
  await open(page, `/repairs/${CHECK}`);
  await expect(page.getByRole('button', { name: 'Создать расход…' })).toHaveCount(0);
});

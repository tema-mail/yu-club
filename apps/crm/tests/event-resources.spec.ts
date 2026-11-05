// S3-83, TC-13 в интерфейсе: правила праздника до сохранения, сервер – окончательно; перенос двигает все ресурсы или ничего (EVENT_MOVE_RESOURCES_INVALID);
// мероприятие видно в календаре филиала занятостью, обычная бронь на это время – SLOT_TAKEN.
import { expect, test, type Page } from '@playwright/test';
import { eventIdOf, key, login, noHorizontalScroll, open, openEvent, resetMock, SHOTS, tapTargetsOk } from './event-helpers.ts';
import { MOCK } from './event-helpers.ts';

test.describe.configure({ mode: 'serial' });
test.beforeAll(async ({ request }) => resetMock(request));
test.afterAll(async ({ request }) => { await request.post(`${MOCK}/__test/reset`); });

const API = '/api/crm/v1';
const nskDate = (at: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Novosibirsk' }).format(new Date(at));
async function card(page: Page, number: string) {
  return (await (await page.request.get(`${API}/events/${await eventIdOf(page, number)}`)).json()) as { id: string; plannedStart: string; rowVersion: number; resources: Array<{ id: string; resourceId: string; start: string; end: string; status: string }> };
}

test('TC-13: правила праздника до сохранения, занятое время – ошибка сервера, потом комната занята', async ({ page }) => {
  await login(page, 'owner@yu.test');
  const party = await card(page, 'EV-000124');
  const date = nskDate(party.plannedStart);
  await openEvent(page, 'EV-000125', 'Брони и ресурсы');
  const form = page.getByTestId('reserve-form');
  await expect(form.getByLabel('Ресурс').locator('option', { hasText: 'VR1' })).toBeAttached();
  await form.getByLabel('Ресурс').selectOption({ label: 'VR1' });
  await form.getByLabel('Дата').fill(date);
  await form.getByLabel('С', { exact: true }).fill('14:00');
  await form.getByLabel('До', { exact: true }).fill('16:00');
  await expect(page.getByTestId('party-problem')).toContainText('только в комнате VR+PS4 целиком');
  await form.getByLabel('Ресурс').selectOption({ label: 'VR-комната целиком' });
  await form.getByLabel('До', { exact: true }).fill('15:30');
  await expect(page.getByTestId('party-problem')).toContainText('не меньше 120 минут');
  await form.getByRole('button', { name: 'Занять' }).click();
  await expect(form.getByRole('alert')).toContainText('не меньше 120 минут');
  await form.getByLabel('До', { exact: true }).fill('16:00');
  await expect(page.getByTestId('party-problem')).toHaveCount(0);
  await form.getByRole('button', { name: 'Занять' }).click();
  await expect(form.getByRole('alert')).toContainText('занято'); // комнату держит EV-000124
  await form.getByLabel('С', { exact: true }).fill('17:00');
  await form.getByLabel('До', { exact: true }).fill('19:00');
  await form.getByRole('button', { name: 'Занять' }).click();
  await expect(page.getByTestId('res-VR-комната целиком')).toContainText('17:00–19:00');
  await expect(page.getByTestId('request-warning')).toBeVisible();
  await expect(page.getByTestId('event-when')).toContainText('17:00–19:00'); // дата взялась из занятого времени
  // сервер окончательно: мимо формы
  const id = await eventIdOf(page, 'EV-000125');
  const direct = await page.request.post(`${API}/events/${id}/resources`, { headers: key(), data: { resourceId: 'res-vr1', start: party.plannedStart, end: new Date(Date.parse(party.plannedStart) + 7200_000).toISOString() } });
  expect((await direct.json()).error.code).toBe('PARTY_RESOURCE_INVALID');
  await page.screenshot({ path: `${SHOTS}/event-resources-1440.png`, fullPage: true });
});

test('Перенос: устаревшая карточка без нового ресурса – EVENT_MOVE_RESOURCES_INVALID и откат; потом успешно', async ({ page }) => {
  await login(page, 'owner@yu.test');
  const before = await card(page, 'EV-000126');
  await openEvent(page, 'EV-000126', 'Брони и ресурсы');
  await page.getByRole('button', { name: 'Перенести…' }).click();
  const d = page.getByTestId('move-dialog');
  await d.getByLabel('Начало').fill('15:00');
  await d.getByLabel('Конец').fill('17:00');
  await d.getByRole('button', { name: 'Перенести' }).click();
  await expect(d.getByRole('alert')).toContainText('причину');
  await d.getByLabel('Причина переноса').fill('Школа попросила позже');
  // пока окно открыто, другой сотрудник занял ещё один ресурс
  const extra = await page.request.post(`${API}/events/${before.id}/resources`, { headers: key(), data: { resourceId: 'res-pc2', start: before.resources[0]!.start, end: before.resources[0]!.end } });
  expect(extra.status()).toBe(201);
  await d.getByRole('button', { name: 'Перенести' }).click();
  await expect(d.getByRole('alert')).toContainText('все занятые ресурсы');
  expect((await card(page, 'EV-000126')).plannedStart).toBe(before.plannedStart); // дата не уехала от комнаты
  await d.getByRole('button', { name: 'Перенести' }).click(); // карточка перечитана – теперь оба ресурса
  await expect(page.getByTestId('event-when')).toContainText('15:00–17:00');
  await expect(page.getByTestId('res-ПК 1')).toContainText('15:00–17:00');
  await expect(page.getByTestId('res-ПК 2')).toContainText('15:00–17:00');
  // API: дубль и вне дат
  const c = await card(page, 'EV-000126');
  const items = c.resources.filter((r) => r.status === 'active').map((r) => ({ eventResourceId: r.id, resourceId: r.resourceId, start: r.start, end: r.end }));
  const dup = await page.request.post(`${API}/events/${c.id}/move`, { headers: key(), data: { rowVersion: c.rowVersion, plannedStart: items[0]!.start, plannedEnd: items[0]!.end, resources: [items[0], items[0]], reason: 'x' } });
  expect((await dup.json()).error.details.reason).toBe('duplicate');
  const outside = await page.request.post(`${API}/events/${c.id}/move`, { headers: key(), data: { rowVersion: c.rowVersion, plannedStart: items[0]!.start, plannedEnd: new Date(Date.parse(items[0]!.start) + 60_000).toISOString(), resources: items, reason: 'x' } });
  expect((await outside.json()).error.details.reason).toBe('outside_planned');
  // освобождение – окном с причиной, строка в истории
  await page.getByTestId('res-ПК 2').getByRole('button', { name: 'Освободить…' }).click();
  const r = page.getByTestId('release-dialog');
  await r.getByLabel('Причина').fill('Лишний компьютер');
  await r.getByRole('button', { name: 'Освободить' }).click();
  await expect(page.getByTestId('res-ПК 2')).toHaveCount(0);
  await expect(page.getByTestId('tab-resources')).toContainText('Освобождённые: 1');
});

test('Календарь филиала: мероприятие видно занятостью на всех своих дорожках, бронь поверх – SLOT_TAKEN; неделя и 390', async ({ page }) => {
  await login(page, 'admin@yu.test');
  const party = await card(page, 'EV-000124');
  const date = nskDate(party.plannedStart);
  await open(page, `/schedule?date=${date}&view=day`);
  const room = page.getByTestId('cal-lane-res-vrroom').getByTestId('cal-event').filter({ hasText: 'EV-000124' });
  await expect(room).toHaveAttribute('aria-label', /EV-000124/);
  await expect(page.getByTestId('cal-lane-res-vr1').getByTestId('cal-event').first()).toBeVisible(); // VR1 внутри комнаты
  await expect(page.getByTestId('cal-lane-res-pc2').getByTestId('cal-event')).toHaveCount(0);
  const booked = await page.request.post(`${API}/branches/b-nsk-krasny/bookings`, { headers: key(), data: { resourceId: 'res-vr1', start: party.plannedStart, end: new Date(Date.parse(party.plannedStart) + 15 * 60_000).toISOString(), client: { phone: '+79131112233', firstName: 'Гость' } } });
  expect((await booked.json()).error.code).toBe('SLOT_TAKEN');
  await page.screenshot({ path: `${SHOTS}/calendar-event-1440.png`, fullPage: true });
  await room.click();
  await expect(page).toHaveURL(/\/events\//);
  await expect(page.getByTestId('event-number')).toHaveText('EV-000124');

  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, `/schedule?date=${date}&view=week`);
  await expect(page.getByTestId(`week-res-vrroom-${date}`).getByTestId('cal-event').first()).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);
  await openEvent(page, 'EV-000124', 'Брони и ресурсы');
  expect(await noHorizontalScroll(page)).toBe(true);
  expect(await tapTargetsOk(page)).toEqual([]);
  await page.screenshot({ path: `${SHOTS}/event-resources-390.png`, fullPage: true });
});

test('Связанная бронь – только ссылка: снять окном, сама бронь на месте', async ({ page }) => {
  await login(page, 'owner@yu.test');
  const b = (await (await page.request.get(`${API}/bookings/bk-vrroom`)).json()) as { number: number };
  const ev = await eventIdOf(page, 'EV-000126');
  expect((await page.request.post(`${API}/events/${ev}/bookings`, { headers: key(), data: { bookingId: 'bk-vrroom' } })).status()).toBe(200);
  await openEvent(page, 'EV-000126', 'Брони и ресурсы');
  await expect(page.getByTestId('event-bookings')).toContainText('Бронь 1');
  await page.getByRole('button', { name: 'Снять связь…' }).click();
  await page.getByTestId('unlink-dialog').getByRole('button', { name: 'Снять связь' }).click();
  await expect(page.getByTestId('event-bookings')).toHaveCount(0);
  expect((await (await page.request.get(`${API}/bookings/bk-vrroom`)).json()).number).toBe(b.number);
});

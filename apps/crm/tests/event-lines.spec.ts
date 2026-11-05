// S3-82: состав, пакет и чек-лист мероприятия. Приёмка: изменение пакета в заказе не меняет шаблон; удалённая строка видна с причиной; план – только при event.money.view.
import { expect, test } from '@playwright/test';
import { eventIdOf, key, login, noHorizontalScroll, openEvent, resetMock, SHOTS, tapTargetsOk } from './event-helpers.ts';
import { MOCK } from './event-helpers.ts';

test.describe.configure({ mode: 'serial' });
test.beforeAll(async ({ request }) => resetMock(request));
test.afterAll(async ({ request }) => { await request.post(`${MOCK}/__test/reset`); });

test('Строка: копейки целыми, скидка только с причиной, сумма как у сервера', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await openEvent(page, 'EV-000126', 'Состав и пакет');
  await expect(page.getByTestId('lines-total')).toHaveText('9 000,00 ₽');
  await page.getByRole('button', { name: 'Добавить строку' }).click();
  const d = page.getByTestId('line-dialog');
  await d.getByLabel('Название').fill('Аниматор');
  await d.getByLabel('Количество').fill('1,5');
  await d.getByLabel('Цена за единицу, ₽').fill('1000,50');
  await expect(d.getByTestId('line-preview')).toHaveText('Сумма строки: 1 500,75 ₽');
  await d.getByLabel('Скидка, ₽').fill('100');
  await d.getByRole('button', { name: 'Сохранить' }).click();
  await expect(d.getByRole('alert')).toContainText('причину скидки');
  await d.getByLabel('Причина скидки').fill('Постоянный клиент');
  await d.getByLabel('Плановая себестоимость, ₽').fill('800');
  await d.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByTestId('lines-total')).toHaveText('10 400,75 ₽');
  await expect(page.getByTestId('sum-agreed')).toHaveText('10 400,75 ₽');
  await expect(page.getByTestId('line-Аниматор')).toContainText('1,5 шт');
  await expect(page.getByTestId('line-Аниматор').getByTestId('line-plan')).toContainText('800,00 ₽');
  await page.screenshot({ path: `${SHOTS}/event-lines-1440.png`, fullPage: true });
});

test('Пакет: копия в заказ, шаблон прежний; удалённая строка видна с причиной', async ({ page }) => {
  await login(page, 'owner@yu.test');
  const before = await (await page.request.get('/api/crm/v1/event-packages')).json();
  await openEvent(page, 'EV-000125', 'Состав и пакет');
  await page.getByTestId('package-apply').getByRole('button', { name: 'Применить…' }).click();
  await expect(page.getByTestId('package-dialog')).toContainText('Аниматор');
  await page.getByTestId('package-dialog').getByRole('button', { name: 'Применить' }).click();
  await expect(page.getByTestId('lines-total')).toHaveText('15 000,00 ₽');
  await page.getByRole('button', { name: 'Открыть строку Аниматор' }).click();
  const d = page.getByTestId('line-dialog');
  await d.getByLabel('Количество').fill('3');
  await d.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByTestId('lines-total')).toHaveText('17 500,00 ₽');
  expect(await (await page.request.get('/api/crm/v1/event-packages')).json()).toEqual(before);

  await page.getByRole('button', { name: 'Открыть строку Аниматор' }).click();
  await d.getByRole('button', { name: 'Удалить…' }).click();
  const rm = page.getByTestId('line-remove');
  await rm.getByRole('button', { name: 'Удалить из состава' }).click();
  await expect(rm.getByRole('alert')).toContainText('причину');
  await rm.getByLabel('Причина удаления').fill('Аниматор не нужен');
  await rm.getByRole('button', { name: 'Удалить из состава' }).click();
  await expect(page.getByTestId('lines-total')).toHaveText('10 000,00 ₽');
  await expect(page.getByTestId('lines-removed')).toContainText('Аниматор');
  await expect(page.getByTestId('lines-removed')).toContainText('Причина: Аниматор не нужен');
});

test('Администратор: плана нет, цену не меняет; сервер отклоняет чужую цену', async ({ page }) => {
  await login(page, 'admin@yu.test');
  await openEvent(page, 'EV-000124', 'Состав и пакет');
  await expect(page.getByTestId('line-plan')).toHaveCount(0);
  await expect(page.getByTestId('tab-lines')).toContainText('Цену и скидку задают');
  await page.getByRole('button', { name: 'Добавить строку' }).click();
  const d = page.getByTestId('line-dialog');
  await expect(d.getByLabel('Цена за единицу, ₽')).toHaveAttribute('readonly', '');
  await expect(d.getByLabel('Плановая себестоимость, ₽')).toHaveCount(0);
  await d.getByLabel('Название').fill('Шарики');
  await d.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByTestId('line-Шарики')).toContainText('0,00 ₽');
  const id = await eventIdOf(page, 'EV-000124');
  const r = await page.request.post(`/api/crm/v1/events/${id}/lines`, { headers: key(), data: { kind: 'other', name: 'Своя цена', quantity: 1, unit: 'шт', priceKop: 100 } });
  expect(r.status()).toBe(403);
});

test('Чек-лист: 10 пунктов, «не нужно» вместо удаления, свой пункт, оплата показывает остаток; 390', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, 'admin@yu.test');
  await openEvent(page, 'EV-000127', 'Чек-лист');
  const list = page.getByTestId('event-checklist').locator('> li');
  await expect(list).toHaveCount(10);
  await expect(page.getByTestId('check-payment').getByTestId('check-due')).toContainText('3 000,00 ₽');
  await page.getByTestId('check-date').getByRole('button', { name: 'Сделано' }).click();
  await expect(page.getByTestId('check-progress')).toContainText('Сделано 1 из 10');
  await page.getByTestId('check-catering').getByRole('button', { name: 'Не нужно' }).click();
  await expect(page.getByTestId('check-progress')).toContainText('Сделано 1 из 9');
  await page.getByLabel('Новый пункт').fill('Купить свечи');
  await page.getByRole('button', { name: 'Добавить', exact: true }).click();
  await expect(list).toHaveCount(11);
  await expect(page.getByTestId('tab-checklist').getByRole('button', { name: /Удалить/ })).toHaveCount(0);
  expect(await noHorizontalScroll(page)).toBe(true);
  expect(await tapTargetsOk(page)).toEqual([]);
  await page.screenshot({ path: `${SHOTS}/event-checklist-390.png`, fullPage: true });
});

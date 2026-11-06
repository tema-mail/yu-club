// S3-81: карточка мероприятия. 9 вкладок и финсводка 11 §11.3 отдельными показателями; Администратор без сумм себестоимости; чужой филиал – 404; 1440 и 390.
import { expect, test } from '@playwright/test';
import { eventIdOf, login, noHorizontalScroll, openEvent, resetMock, SHOTS, tapTargetsOk } from './event-helpers.ts';
import { MOCK } from './event-helpers.ts';

test.describe.configure({ mode: 'serial' });
test.beforeAll(async ({ request }) => resetMock(request));
test.afterAll(async ({ request }) => { await request.post(`${MOCK}/__test/reset`); });

test('Владелец: дата, филиал, статус, заказчик, 8 показателей раздельно, 9 вкладок', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await openEvent(page, 'EV-000124');
  await expect(page.getByTestId('event-status')).toHaveText('Подтверждено');
  await expect(page.getByTestId('event-when')).toContainText('14:00–16:00');
  for (const [id, text] of [['agreed', '13 800,00 ₽'], ['received', '5 000,00 ₽'], ['refunded', '0,00 ₽'], ['due', '8 800,00 ₽'], ['plan', '4 400,00 ₽'], ['fact', '0,00 ₽'], ['result', '5 000,00 ₽'], ['deviation', '−4 400,00 ₽']] as const) {
    await expect(page.getByTestId(`sum-${id}`)).toHaveText(text);
  }
  await expect(page.getByRole('tab')).toHaveText(['Основное', 'Заказчик и участники', 'Состав и пакет', 'Брони и ресурсы', 'Чек-лист', 'Поступления', 'Расходы и себестоимость', 'Подарки', 'История']);
  await page.getByRole('tab', { name: 'История' }).click();
  await expect(page.getByTestId('event-timeline')).toContainText('Ожидает подтверждения → Подтверждено');
  await page.screenshot({ path: `${SHOTS}/event-card-1440.png`, fullPage: true });
});

test('Администратор: только остаток, ни одной суммы плана и результата – ни на экране, ни в данных острова', async ({ page }) => {
  await login(page, 'admin@yu.test');
  await openEvent(page, 'EV-000124');
  await expect(page.getByTestId('sum-due')).toHaveText('8 800,00 ₽');
  for (const id of ['agreed', 'received', 'plan', 'fact', 'result', 'deviation']) await expect(page.getByTestId(`sum-${id}`)).toHaveCount(0);
  expect(await page.content()).not.toContain('planCostKop');
  const r = await page.request.get(`/api/crm/v1/events/${await eventIdOf(page, 'EV-000124')}/money`);
  expect(r.status()).toBe(403);
  await page.getByRole('tab', { name: 'История' }).click();
  await expect(page.getByTestId('tab-history')).toContainText('Подробности изменений видят');
});

test('Чужой филиал – 404; статус: не готово – понятно почему; отмена – окном с причиной и списком «требует решения»', async ({ page, browser }) => {
  await login(page, 'owner@yu.test');
  const tomsk = await eventIdOf(page, 'EV-000128');
  const other = await (await browser.newContext()).newPage();
  await login(other, 'admin@yu.test');
  expect((await other.goto(`/events/${tomsk}`))?.status()).toBe(404);
  await expect(other.getByTestId('not-found')).toBeVisible();

  await openEvent(page, 'EV-000125');
  await page.getByTestId('event-actions').getByRole('button', { name: 'Ждёт подтверждения' }).click();
  await expect(page.getByTestId('event-status')).toHaveText('Ожидает подтверждения');
  await page.getByTestId('event-actions').getByRole('button', { name: 'Подтвердить' }).click();
  await expect(page.getByTestId('event-error')).toContainText('дата и время начала');
  await expect(page.getByTestId('event-error')).toContainText('занятая комната');
  await page.getByTestId('event-actions').getByRole('button', { name: 'Отменить…' }).click();
  const dlg = page.getByTestId('event-close-dialog');
  await dlg.getByRole('button', { name: 'Отменить мероприятие' }).click();
  await expect(dlg.getByRole('alert')).toContainText('Укажите причину');
  await dlg.getByLabel('Причина').fill('Клиент передумал');
  await dlg.getByRole('button', { name: 'Отменить мероприятие' }).click();
  await expect(page.getByTestId('event-status')).toHaveText('Отменено');
  await expect(page.getByTestId('needs-decision')).toContainText('Система ничего из этого не отменяла');
  await expect(page.getByTestId('event-cancel-reason')).toContainText('Клиент передумал');
  await expect(page.getByTestId('event-actions')).toHaveCount(0);
});

test('Правка оргданных и заказчика; адрес вкладки; все 9 вкладок на 390 без прокрутки, кнопки ≥ 44', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, 'owner@yu.test');
  await openEvent(page, 'EV-000126');
  const form = page.getByTestId('event-main-form');
  await expect(form.getByLabel('Дата')).toBeDisabled(); // ресурс занят: дату меняет перенос
  await form.getByLabel('Название').fill('Группа школы №5, 7А');
  await form.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByTestId('event-notice')).toHaveText('Данные сохранены.');
  await page.getByRole('tab', { name: 'Заказчик и участники' }).click();
  await expect(page).toHaveURL(/#people$/);
  await page.getByLabel('Участников', { exact: true }).fill('14');
  await page.getByTestId('event-people-form').getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByTestId('event-notice')).toContainText('сохранены');
  await page.reload();
  await expect(page.locator('astro-island[ssr]')).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Заказчик и участники' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('tab-people')).toContainText('14');
  for (const t of ['Основное', 'Заказчик и участники', 'Состав и пакет', 'Брони и ресурсы', 'Чек-лист', 'Поступления', 'Расходы и себестоимость', 'Подарки', 'История']) {
    await page.getByRole('tab', { name: t, exact: true }).click();
    expect(await noHorizontalScroll(page), t).toBe(true);
    expect(await tapTargetsOk(page), t).toEqual([]);
  }
  await page.getByRole('tab', { name: 'Основное' }).click();
  await page.screenshot({ path: `${SHOTS}/event-card-390.png`, fullPage: true });
});

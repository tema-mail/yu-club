// S3-81 на моке mock-events.ts (строго по apps/api/src/modules/events/routes.crm.ts): список 11 §11.1 с фильтрами и суммами только при
// event.money.view, создание без брони и профиля. Администратор – только остаток к оплате, ни одной суммы себестоимости. 1440 и 390.
import { expect, test } from '@playwright/test';
import { login, noHorizontalScroll, open, resetMock, SHOTS, tapTargetsOk } from './event-helpers.ts';

test.describe.configure({ mode: 'serial' });
test.beforeAll(async ({ request }) => resetMock(request));
test.afterAll(async ({ request }) => resetMock(request));

const rows = (page: import('@playwright/test').Page) => page.getByTestId('event-list').locator('tbody tr');

test('Владелец: все колонки 11 §11.1, суммы раздельно, фильтры', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await page.getByRole('navigation', { name: 'Разделы' }).getByRole('link', { name: 'Мероприятия' }).click();
  await expect(page).toHaveURL(/\/events$/);
  for (const h of ['Номер и название', 'Тип', 'Дата и время', 'Филиал', 'Заказчик', 'Участников', 'Статус', 'Плановая стоимость', 'Поступило', 'Остаток к оплате', 'Факт. расходы', 'Ответственный']) {
    await expect(page.getByTestId('event-list').getByRole('columnheader', { name: h, exact: true })).toBeVisible();
  }
  await expect(rows(page)).toHaveCount(5);
  const party = page.getByTestId('event-EV-000124');
  await expect(party).toContainText('День рождения Ивана');
  await expect(party).toContainText('13 800,00 ₽'); // согласовано: 10 000 + 8 × 500 − 200
  await expect(party).toContainText('5 000,00 ₽'); // поступило
  await expect(party).toContainText('8 800,00 ₽'); // остаток
  await expect(party).toContainText('14:00–16:00'); // зона филиала
  await expect(page.getByTestId('event-EV-000126').getByTestId('hold-remind')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/events-list-1440.png`, fullPage: true });

  await page.getByLabel('Статус').selectOption({ label: 'Подтверждено' });
  await page.getByRole('button', { name: 'Найти' }).click();
  await expect(rows(page)).toHaveCount(1);
  await open(page, '/events?customer=4321');
  await expect(rows(page)).toHaveCount(1);
  await expect(page.getByTestId('event-EV-000125')).toContainText('Пётр Без Профиля');
  await open(page, '/events');
  await page.getByLabel('Неоплаченный остаток').selectOption({ label: 'Есть' });
  await page.getByRole('button', { name: 'Найти' }).click();
  await expect(rows(page)).toHaveCount(3);
});

test('Создание: без брони и профиля; проверки формы до сервера', async ({ page }) => {
  await login(page, 'admin@yu.test');
  await open(page, '/events');
  await page.getByRole('button', { name: 'Новое мероприятие' }).click();
  const form = page.getByTestId('event-form');
  await form.getByLabel('Тип').selectOption({ label: 'Платный праздник' });
  await form.getByRole('button', { name: 'Создать' }).click();
  await expect(form.getByRole('alert')).toContainText('имя заказчика');
  await form.getByLabel('Заказчик: имя').fill('Елена Гость');
  await form.getByLabel('Заказчик: телефон').fill('+7 913 555-66-77');
  await form.getByLabel(/Гостей/).fill('11');
  await form.getByRole('button', { name: 'Создать' }).click();
  await expect(form.getByRole('alert')).toContainText('не больше 10 гостей');
  await form.getByLabel(/Гостей/).fill('6');
  await form.getByRole('button', { name: 'Создать' }).click();
  await expect(page).toHaveURL(/\/events\/[0-9a-f-]{36}$/);
});

test('Администратор: только остаток к оплате, нет плана, нет чужого филиала; 390 без прокрутки страницы', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, 'admin@yu.test');
  await open(page, '/events');
  const list = page.getByTestId('event-list');
  await expect(list.getByRole('columnheader', { name: 'Остаток к оплате' })).toBeVisible();
  await expect(list.getByRole('columnheader', { name: 'Плановая стоимость' })).toHaveCount(0);
  await expect(list.getByRole('columnheader', { name: 'Поступило' })).toHaveCount(0);
  await expect(list.getByRole('columnheader', { name: 'Факт. расходы' })).toHaveCount(0);
  await expect(list).not.toContainText('Турнир в Томске');
  await expect(page.getByTestId('event-EV-000124').getByTestId('event-due')).toHaveText('8 800,00 ₽');
  expect(await noHorizontalScroll(page)).toBe(true);
  expect(await tapTargetsOk(page)).toEqual([]);
  await page.screenshot({ path: `${SHOTS}/events-list-390.png`, fullPage: true });
});

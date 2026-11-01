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

// Проверка S1-25 (план 6.2), клиенты в CRM: телефон в списке маскирован; поиск по ФИО, телефону и ID;
// Администратор чужого клиента по прямой ссылке получает 404; без client.view.full полных ПДн нет в разметке;
// экспорта у Администратора нет; пустое и ошибочное состояния; 1440 и 390 px без горизонтальной прокрутки.
import { expect, test, type Page } from '../../../tests/support/e2e.ts';
import { MOCK_PASSWORD } from './mock-api.ts';

const MOCK = process.env.MOCK_URL ?? 'http://127.0.0.1:4012';
const SHOTS = process.env.SCREENSHOT_DIR ?? 'test-results/screens';
const OLGA = 'c0000000-0000-4000-8000-000000000001'; // филиал Администратора (Красный)
const MARIA = 'c0000000-0000-4000-8000-000000000003'; // только Томск – вне зоны Администратора
const OLGA_PD = ['+79131234567', '9131234567', 'olga@yu.test', '1995-04-12', '12.04.1995'];

test.describe.configure({ mode: 'serial' });
test.beforeAll(async ({ request }) => {
  expect((await request.post(`${MOCK}/__test/reset`)).ok()).toBe(true);
});

async function login(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Почта').fill(email);
  await page.getByLabel('Пароль', { exact: true }).fill(MOCK_PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

const rows = (page: Page) => page.getByTestId('clients').locator('tbody tr');
const search = (page: Page) => page.getByLabel('Телефон, ФИО, email или ID');

test('Владелец: меню, маска телефона в списке, поиск, порции, карточка с полными данными и историей', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await page.getByRole('navigation', { name: 'Разделы' }).getByRole('link', { name: 'Клиенты' }).click();
  await expect(page).toHaveURL(/\/clients$/);

  // Три действующих клиента (обезличенный – только по фильтру), порция по 2.
  await expect(rows(page)).toHaveCount(2);
  await page.getByRole('button', { name: 'Показать ещё' }).click();
  await expect(rows(page)).toHaveCount(3);
  const list = page.getByTestId('clients');
  await expect(list).toContainText('+7 ••• ••• ••-67');
  for (const pd of OLGA_PD) expect(await list.innerHTML()).not.toContain(pd);

  await search(page).fill('Смирн');
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText('Ольга');
  await search(page).fill('8 913 123-45-67');
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText('+7 ••• ••• ••-67');
  await search(page).fill(OLGA);
  await expect(rows(page)).toHaveCount(1);

  await rows(page).first().getByRole('link').click();
  await expect(page).toHaveURL(new RegExp(`/clients/${OLGA}$`));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Смирнова Ольга');
  await expect(page.getByTestId('client-status')).toHaveText('Активен');
  const full = page.getByTestId('client-full');
  await expect(full).toContainText('+79131234567');
  await expect(full).toContainText('olga@yu.test');
  await expect(full).toContainText('12.04.1995');
  const history = page.getByTestId('history');
  await expect(history.locator('.yc-history__item')).toHaveCount(2);
  await expect(history.locator('.yc-history__item').first()).toContainText('Статус: Гость → Активен');
  await expect(history).toContainText('Система');
  // Записей, посещений и согласий API пока не отдаёт – и экран не рисует заглушек.
  await expect(page.getByText(/скоро/i)).toHaveCount(0);
});

test('Администратор: только своя зона, чужой клиент по ссылке – 404, без полных ПДн в разметке, без экспорта', async ({ page }) => {
  await login(page, 'admin@yu.test');
  await expect(page.getByRole('navigation', { name: 'Разделы' }).getByRole('link', { name: 'Клиенты' })).toBeVisible();
  await page.goto('/clients');
  await expect(rows(page)).toHaveCount(2);
  await expect(page.getByTestId('clients')).not.toContainText('Кузнецова');
  await expect(page.getByRole('button', { name: /экспорт|выгруз/i })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /экспорт|выгруз/i })).toHaveCount(0);

  const res = await page.goto(`/clients/${MARIA}`);
  expect(res?.status()).toBe(404);
  await expect(page.getByTestId('not-found')).toBeVisible();
  expect(await page.content()).not.toContain('Кузнецова');

  await page.goto(`/clients/${OLGA}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Смирнова Ольга');
  await expect(page.getByTestId('client-main')).toContainText('+7 ••• ••• ••-67');
  await expect(page.getByTestId('client-full')).toHaveCount(0);
  await expect(page.getByTestId('history')).toBeVisible();
  const html = await page.content();
  for (const pd of OLGA_PD) expect(html).not.toContain(pd);
  await expect(page.getByRole('button', { name: /экспорт|выгруз/i })).toHaveCount(0);
});

test('пустое и ошибочное состояния списка', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await page.goto('/clients');
  await expect(rows(page)).toHaveCount(2);

  await search(page).fill('Несуществующая');
  await expect(page.getByTestId('list-empty')).toContainText('Ничего не найдено по этим условиям.');
  await page.getByRole('button', { name: 'Сбросить поиск и фильтры' }).click();
  await expect(rows(page)).toHaveCount(2);

  // Ошибка проверки на сервере: телефон короче 4 цифр.
  await search(page).fill('91');
  await expect(page.getByRole('alert').filter({ hasText: 'Список не загрузился' })).toContainText('Для поиска по телефону нужно от 4 цифр');

  // Сервер упал – сообщение и «Повторить».
  await page.route('**/api/crm/v1/clients?*', (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INTERNAL', message: 'Ошибка сервера' } }) }),
  );
  await search(page).fill('');
  const alert = page.getByRole('alert').filter({ hasText: 'Список не загрузился' });
  await expect(alert).toContainText('Ошибка сервера');
  await page.unroute('**/api/crm/v1/clients?*');
  await alert.getByRole('button', { name: 'Повторить' }).click();
  await expect(rows(page)).toHaveCount(2);
});

test('снимки клиентов 1440 и 390, без горизонтальной прокрутки', async ({ browser }) => {
  for (const [w, h] of [[1440, 900], [390, 844]] as const) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: w === 390 ? 2 : 1 });
    const page = await ctx.newPage();
    await login(page, 'owner@yu.test');
    const noScroll = async () => expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(w);
    await page.goto('/clients');
    await expect(rows(page)).toHaveCount(2);
    await page.screenshot({ path: `${SHOTS}/clients-list-${w}.png`, fullPage: true });
    await noScroll();
    await page.goto(`/clients/${OLGA}`);
    await expect(page.getByTestId('history').locator('.yc-history__item')).toHaveCount(2);
    await page.screenshot({ path: `${SHOTS}/client-card-${w}.png`, fullPage: true });
    await noScroll();
    await ctx.close();
  }
});

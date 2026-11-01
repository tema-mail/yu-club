// e2e «Мои записи» в ЛК (S1-17) на моке tests/mock-api.ts: ответы мока проходят схемы packages/contracts (K9),
// клиент видит только свои записи, идущий сеанс – в «будущих» без кнопки отмены, отмена через окно подтверждения
// («предоплаты нет, отмена бесплатна»), пустые состояния, история посещений, блок «Уведомления» на месте, 390 без прокрутки.
import { expect, test, type Page } from '@playwright/test';
import { MyBookingsPage, MyVisitsPage } from '../../../packages/contracts/src/booking.ts';
import { MOCK_PORT, STAGE_PORT } from '../playwright.config.ts';
import { MOCK_CODE } from './mock-api.ts';

test.use({ baseURL: `http://localhost:${STAGE_PORT}` });

async function login(page: Page, phone: string) {
  await page.goto('/login/?next=/account/');
  await page.getByLabel('Телефон').fill(phone);
  await page.getByRole('button', { name: 'Получить код' }).click();
  await page.getByLabel('Код из SMS').fill(MOCK_CODE);
  await page.getByLabel(/согласие на обработку/).check();
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(/\/account\/$/);
}

const tab = (page: Page, name: string) => page.getByRole('tab', { name, exact: true });
const cards = (page: Page) => page.getByTestId('my-booking');

test.beforeEach(async ({ request }) => {
  await request.post(`http://127.0.0.1:${MOCK_PORT}/__test/booking-reset`);
});

test('свои записи по вкладкам, идущий сеанс в будущих, ответы по контракту K9, чужих нет', async ({ page }) => {
  await login(page, '9131234567');
  await expect(page.getByRole('heading', { name: 'Мои записи' })).toBeVisible();
  await expect(tab(page, 'Будущие')).toHaveAttribute('aria-selected', 'true');
  await expect(cards(page)).toHaveCount(2);
  const going = cards(page).filter({ hasText: 'PS5 2' });
  await expect(going).toContainText('Идёт сеанс – вы в клубе');
  await expect(going.getByRole('button', { name: 'Отменить запись' })).toHaveCount(0); // сеанс начался – кнопки нет
  await expect(cards(page).filter({ hasText: 'ПК 1' }).getByRole('button', { name: 'Отменить запись' })).toBeVisible();
  await expect(page.getByTestId('book-more')).toHaveAttribute('href', '/schedule/');

  await tab(page, 'Прошлые').click();
  await expect(cards(page)).toHaveCount(3); // завершённая, неявка, закончившаяся без отметки
  await expect(page.getByTestId('my-list-past')).toContainText('Неявка');
  await tab(page, 'Отменённые').click();
  await expect(cards(page)).toHaveCount(2);
  await expect(page.getByTestId('my-list-cancelled')).toContainText('Отменена клубом');
  await tab(page, 'Посещения').click();
  await expect(page.getByTestId('my-list-visits').locator('li')).toHaveCount(2); // идущий сеанс и завершённая
  await expect(page.getByText(/Пётр|ПК 5/)).toHaveCount(0); // записи Петра не видны ни в одной вкладке

  // Контракт: каждый ответ мока проходит схему packages/contracts, в ответе только записи этого клиента.
  const data = await page.evaluate(async () => {
    const get = async (p: string) => (await fetch(`/api/public/v1${p}`)).json();
    return { up: await get('/me/bookings/?tab=upcoming'), past: await get('/me/bookings/?tab=past'), cancelled: await get('/me/bookings/?tab=cancelled'), visits: await get('/me/visits/') };
  });
  for (const k of ['up', 'past', 'cancelled'] as const) expect(MyBookingsPage.safeParse(data[k]).success, k).toBe(true);
  expect(MyVisitsPage.safeParse(data.visits).success).toBe(true);
  expect(JSON.stringify(data)).not.toContain('ПК 5');
  // Блок уведомлений не сломан.
  await expect(page.getByRole('checkbox')).toHaveCount(2);
});

test('отмена через окно подтверждения: без денег, запись уходит в отменённые; «Не отменять» ничего не меняет', async ({ page }) => {
  await login(page, '9131234567');
  const target = cards(page).filter({ hasText: 'ПК 1' });
  await target.getByRole('button', { name: 'Отменить запись' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Предоплаты нет, отмена бесплатна.');
  await dialog.getByRole('button', { name: 'Не отменять' }).click();
  await expect(dialog).toBeHidden();
  await expect(cards(page)).toHaveCount(2);

  await target.getByRole('button', { name: 'Отменить запись' }).click();
  await dialog.getByRole('button', { name: 'Да, отменить' }).click();
  await expect(page.getByRole('status').filter({ hasText: /отменена/ })).toContainText('отменена');
  await expect(cards(page)).toHaveCount(1);
  await tab(page, 'Отменённые').click();
  await expect(cards(page)).toHaveCount(3);
  await expect(cards(page).filter({ hasText: 'ПК 1' })).toContainText('Отменена вами');
  await page.reload();
  await expect(cards(page)).toHaveCount(1); // отмена на сервере, не только на экране
});

test('новый клиент: пустые состояния во всех вкладках и ссылка на запись', async ({ page }) => {
  await login(page, '9130000077');
  await expect(page.getByTestId('my-empty')).toHaveText('Будущих записей нет. Выбрать время');
  await expect(page.getByTestId('my-empty').getByRole('link')).toHaveAttribute('href', '/schedule/');
  await tab(page, 'Прошлые').click();
  await expect(page.getByTestId('my-empty')).toHaveText('Прошедших записей пока нет.');
  await tab(page, 'Отменённые').click();
  await expect(page.getByTestId('my-empty')).toHaveText('Отменённых записей нет.');
  await tab(page, 'Посещения').click();
  await expect(page.getByTestId('my-empty')).toContainText('Посещений пока нет');
});

test('390 px: ЛК с записями и окном отмены без горизонтальной прокрутки, кнопки ≥ 44 px', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, '9131234567');
  await expect(cards(page)).toHaveCount(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const small = await page.locator('.yu-mybookings .yu-btn, .yu-tabs__tab').evaluateAll((els) => els.filter((el) => el.getBoundingClientRect().height < 44).length);
  expect(small).toBe(0);
  await page.screenshot({ path: 'test-results/account-bookings-390.png', fullPage: true });
  await cards(page).filter({ hasText: 'ПК 1' }).getByRole('button', { name: 'Отменить запись' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: 'test-results/account-cancel-390.png' });
});

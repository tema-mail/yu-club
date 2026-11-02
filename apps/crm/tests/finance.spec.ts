// «Финансы» (S2-60) на моке mock-finance.ts: Владелец – сводка сети и касса филиала с остатками и журналом (06 §10),
// сторно через окно внутри записи с обязательной причиной, у сеанса/сертификата/возврата кнопок нет, закрытие месяца;
// Директор – только своя зона; Администратор – сутки без остатков и без предпросмотра; пустое состояние; 1440 и 390 px.
import { expect, test, type Page } from '@playwright/test';
import { MOCK_PASSWORD } from './mock-api.ts';

const MOCK = process.env.MOCK_URL ?? 'http://127.0.0.1:4012';
const SHOTS = process.env.SCREENSHOT_DIR ?? 'test-results/screens';
const KRASNY = '/finance/b-nsk-krasny';

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
async function open(page: Page, url: string) {
  await page.goto(url);
  await page.waitForLoadState('load');
  await expect(page.locator('astro-island[ssr]')).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'Загружаем' })).toHaveCount(0);
}
const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const journalRow = (page: Page, comment: string) => page.getByTestId('fin-journal').locator('tbody tr').filter({ hasText: comment });

test('Владелец: сводка сети по филиалам и итог, переход в кассу филиала', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, '/finance');
  await expect(page.getByTestId('fin-scope')).toHaveText('Вся сеть');
  const net = page.getByTestId('fin-network');
  await expect(net.locator('tbody tr')).toHaveCount(4);
  // Красный: доход месяца 1 500 (сеанс) + 2 000 (сертификат), расход 300, возврат 500 → результат 2 700.
  await expect(page.getByTestId('fin-net-b-nsk-krasny')).toContainText('3 500,00 ₽');
  await expect(page.getByTestId('fin-net-b-nsk-krasny')).toContainText('2 700,00 ₽');
  await expect(page.getByTestId('fin-net-b-nsk-krasny')).toContainText('14 700,00 ₽');
  await expect(page.getByTestId('fin-net-total')).toContainText('22 600,00 ₽'); // наличные: 14 700 + 7 900
  await page.getByTestId('fin-net-b-nsk-krasny').getByRole('link', { name: 'Ю Клуб на Красном' }).click();
  await expect(page).toHaveURL(/\/finance\/b-nsk-krasny$/);
});

test('Владелец: касса филиала – остатки, журнал с колонками 06 §10, период', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, KRASNY);
  await expect(page.getByTestId('fin-balance-cash')).toHaveText('14 700,00 ₽');
  await expect(page.getByTestId('fin-balance-noncash')).toHaveText('4 800,00 ₽');
  await expect(page.getByTestId('fin-income')).toHaveText('3 500,00 ₽');
  const head = page.getByTestId('fin-journal').locator('thead th');
  await expect(head).toHaveText(['Дата и время', '№', 'Тип', 'Категория / источник', 'Комментарий', 'Приход', 'Расход', 'Остаток после', 'Связь', 'Автор', 'Статус']);
  const buy = journalRow(page, 'Салфетки и моющее');
  await expect(buy).toContainText('Закупки и материалы / Хозяйственные товары');
  await expect(buy).toContainText('Анна Админова');
  await expect(journalRow(page, 'Игровой сеанс')).toContainText('Оплата брони');
  await expect(journalRow(page, 'Игровой сеанс')).toContainText('Система');

  // Прошлый месяц: начальный остаток и расход за электричество видны с остатком после.
  const prev = await page.evaluate(() => {
    const t = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Novosibirsk' }).format(new Date());
    const [y, m] = t.split('-').map(Number) as [number, number];
    return m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, '0')}-01`;
  });
  await page.getByLabel('С', { exact: true }).fill(prev);
  await page.getByRole('button', { name: 'Показать' }).click();
  await expect(journalRow(page, 'Счёт за электричество')).toContainText('Коммунальные / Электричество');
  await expect(journalRow(page, 'Остаток на счёте').getByTestId('fin-after')).toHaveText('5 000,00 ₽');
  await page.getByLabel('Тип операции').selectOption('opening_balance');
  await expect(page.getByTestId('fin-journal').locator('tbody tr')).toHaveCount(2);
  await page.getByLabel('Тип операции').selectOption('');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: `${SHOTS}/finance-1440.png`, fullPage: true });
});

test('Сторно: у сеанса, сертификата и возврата кнопки нет; обычная операция – с обязательной причиной', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, KRASNY);
  for (const [text, why] of [
    ['Игровой сеанс', 'возвратом платежа'],
    ['Продажа сертификата', 'отменой продажи'],
    ['Отмена брони клиентом', 'Возврат не сторнируется'],
  ] as const) {
    await journalRow(page, text).getByRole('button', { name: /Открыть операцию/ }).click();
    const rec = page.getByTestId('fin-record');
    await expect(rec.getByTestId('fin-no-reverse')).toContainText(why);
    await expect(rec.getByRole('button', { name: 'Сторно…' })).toHaveCount(0);
    await rec.getByRole('button', { name: 'Закрыть' }).click();
  }

  await journalRow(page, 'Салфетки и моющее').getByRole('button', { name: /Открыть операцию/ }).click();
  const rec = page.getByTestId('fin-record');
  await rec.getByRole('button', { name: 'Сторно…' }).click();
  await rec.getByRole('button', { name: 'Сторнировать' }).click();
  await expect(rec.getByRole('alert')).toHaveText('Укажите причину сторно – без неё операцию не сторнировать.');
  await rec.getByLabel('Причина сторно').fill('Внесено дважды');
  await rec.getByRole('button', { name: 'Сторнировать' }).dblclick();
  await expect(page.getByRole('status').filter({ hasText: 'сторнирована' })).toContainText(/Операция №\d+ сторнирована: сторно №\d+/);
  await expect(journalRow(page, 'Салфетки и моющее')).toContainText('Сторнирована');
  await expect(journalRow(page, 'Внесено дважды')).toHaveCount(1); // одно сторно на двойной клик
  await expect(journalRow(page, 'Внесено дважды')).toContainText('Сторно');
  await expect(page.getByTestId('fin-balance-cash')).toHaveText('15 000,00 ₽');
  await expect(page.getByTestId('fin-expense')).toHaveText('0,00 ₽');
});

test('Владелец закрывает прошлый месяц через окно; повторное закрытие – отказ', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, KRASNY);
  await page.getByRole('button', { name: 'Закрыть месяц…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Закрыть месяц' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'закрыт' })).toContainText('операции этим месяцем больше не внести');
  await page.getByRole('button', { name: 'Закрыть месяц…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Закрыть месяц' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Месяц уже закрыт' })).toBeVisible();
});

test('Директор: сводка своего города, чужой филиал – 404, закрытия месяца и сторно нет', async ({ page }) => {
  await login(page, 'director@yu.test');
  await open(page, '/finance');
  await expect(page.getByTestId('fin-scope')).toHaveText('Новосибирск – весь город');
  await expect(page.getByTestId('fin-net-b-nsk-krasny')).toBeVisible();
  await expect(page.getByTestId('fin-net-b-nsk-akadem')).toBeVisible();
  await expect(page.getByTestId('fin-net-b-tsk-lenina')).toHaveCount(0);
  const res = await page.goto('/finance/b-tsk-lenina');
  expect(res?.status()).toBe(404);
  await open(page, KRASNY);
  await expect(page.getByTestId('fin-balance-cash')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Закрыть месяц…' })).toHaveCount(0);
  await journalRow(page, 'Отмена брони клиентом').getByRole('button', { name: /Открыть операцию/ }).click();
  await expect(page.getByTestId('fin-record').getByRole('button', { name: 'Сторно…' })).toHaveCount(0);
  await expect(page.getByTestId('fin-record').getByTestId('fin-no-reverse')).toHaveCount(0);
});

test('Пустое состояние: операций за период нет', async ({ page }) => {
  await login(page, 'director@yu.test');
  await open(page, '/finance/b-nsk-akadem');
  await expect(page.getByTestId('fin-empty')).toHaveText('Операций за период нет.');
  await expect(page.getByTestId('fin-balance-cash')).toHaveText('0,00 ₽');
});

test('Администратор: сутки своего филиала без остатков, без периода и без предпросмотра', async ({ page }) => {
  const calls: string[] = [];
  page.on('request', (r) => calls.push(r.url()));
  await login(page, 'admin@yu.test');
  await open(page, '/finance');
  await expect(page.getByRole('heading', { name: 'Финансы – Ю Клуб на Красном' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Сводка за сегодня' })).toBeVisible();
  await expect(page.getByTestId('fin-balance-cash')).toHaveCount(0);
  await expect(page.getByLabel('С', { exact: true })).toHaveCount(0);
  await expect(page.getByTestId('fin-journal').locator('thead th')).not.toContainText(['Остаток после']);
  await expect(page.getByTestId('fin-after')).toHaveCount(0);
  await expect(journalRow(page, 'Салфетки и моющее')).toContainText('Вы');
  expect(calls.some((u) => u.includes('/finance/preview'))).toBe(false);
  await journalRow(page, 'Салфетки и моющее').getByRole('button', { name: /Открыть операцию/ }).click();
  await expect(page.getByTestId('fin-record')).not.toContainText('Остаток после');
  await expect(page.getByTestId('fin-record').getByRole('button', { name: 'Сторно…' })).toHaveCount(0);
  expect((await page.goto('/finance/b-tsk-lenina'))?.status()).toBe(404);
});

test('390 px: страница без горизонтальной прокрутки, журнал прокручивается внутри блока, кнопки ≥ 44 px', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, 'owner@yu.test');
  await open(page, KRASNY);
  await expect(page.getByTestId('fin-journal')).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);
  const inner = await page.locator('.yc-fin__scroll').first().evaluate((el) => el.scrollWidth > el.clientWidth);
  expect(inner).toBe(true);
  for (const name of ['Показать', 'Закрыть месяц…']) {
    const box = await page.getByRole('button', { name }).boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
  await page.screenshot({ path: `${SHOTS}/finance-390.png`, fullPage: true });
  await open(page, '/finance');
  expect(await noHorizontalScroll(page)).toBe(true);
});

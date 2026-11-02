// Формы дохода и расхода (S2-61) на моке mock-finance.ts: Владелец вносит приход и расход, видит «остаток после» до
// сохранения и в журнале; двойной клик – одна операция; расход больше остатка – понятный отказ с числами;
// Администратор вносит расход без предпросмотра (запроса нет) и не видит остатков даже в отказе; закрытый месяц
// не принимает операцию; 390 px – форма без горизонтальной прокрутки, кнопки ≥ 44 px.
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
const dlg = (page: Page) => page.getByRole('dialog');

test('Владелец вносит доход: «остаток после» до сохранения, затем в ответе, журнале и сводке', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, KRASNY);
  await page.getByRole('button', { name: 'Внести доход' }).click();
  await dlg(page).getByLabel('Источник').selectOption({ label: 'Мероприятие' });
  await dlg(page).getByLabel('Сумма, ₽').fill('1 234,56');
  await dlg(page).getByLabel('Комментарий (необязательно)').fill('Выпускной 11 «Б»');
  await expect(dlg(page).getByTestId('op-preview')).toHaveText('Остаток (наличные): 14 700,00 ₽ → 15 934,56 ₽');
  await dlg(page).getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByTestId('op-saved')).toHaveText(/Доход №\d+ внесён: 1\s234,56\s₽\. Остаток \(наличные\) после: 15\s934,56\s₽\./);
  await expect(journalRow(page, 'Выпускной 11 «Б»')).toContainText('Мероприятие');
  await expect(journalRow(page, 'Выпускной 11 «Б»').getByTestId('fin-after')).toHaveText('15 934,56 ₽');
  await expect(page.getByTestId('fin-balance-cash')).toHaveText('15 934,56 ₽');
  await expect(page.getByTestId('fin-income')).toHaveText('4 734,56 ₽');
});

test('Владелец вносит расход: обязательные поля, подкатегория, безнал, двойной клик – одна операция', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, KRASNY);
  await page.getByRole('button', { name: 'Внести расход' }).click();
  await dlg(page).getByRole('button', { name: 'Сохранить' }).click();
  await expect(dlg(page)).toContainText('Введите сумму в рублях');
  await expect(dlg(page)).toContainText('Выберите категорию.');
  await expect(dlg(page)).toContainText('Укажите комментарий: на что потрачены деньги.');
  await dlg(page).getByLabel('Категория').selectOption({ label: 'Коммунальные' });
  await dlg(page).getByRole('button', { name: 'Сохранить' }).click();
  await expect(dlg(page)).toContainText('Выберите подкатегорию.');
  await dlg(page).getByLabel('Подкатегория').selectOption({ label: 'Интернет' });
  await dlg(page).getByLabel('Сумма, ₽').fill('300,1');
  await dlg(page).getByRole('button', { name: 'Карта' }).click();
  await dlg(page).getByLabel('Комментарий (основание)').fill('Интернет за ноябрь');
  await expect(dlg(page).getByTestId('op-preview')).toHaveText('Остаток (безнал): 4 800,00 ₽ → 4 499,90 ₽');
  await dlg(page).getByRole('button', { name: 'Сохранить' }).dblclick();
  await expect(page.getByTestId('op-saved')).toContainText('Остаток (безнал) после: 4 499,90 ₽.');
  await expect(journalRow(page, 'Интернет за ноябрь')).toHaveCount(1);
  await expect(journalRow(page, 'Интернет за ноябрь')).toContainText('Коммунальные / Интернет');
  await expect(journalRow(page, 'Интернет за ноябрь')).toContainText('300,10 ₽');
  await expect(page.getByTestId('fin-balance-noncash')).toHaveText('4 499,90 ₽');
});

test('Расход больше остатка: предупреждение до сохранения и понятный отказ с числами Владельцу', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, KRASNY);
  await page.getByRole('button', { name: 'Внести расход' }).click();
  await dlg(page).getByLabel('Категория').selectOption({ label: 'Прочее' });
  await dlg(page).getByLabel('Сумма, ₽').fill('100000');
  await dlg(page).getByLabel('Комментарий (основание)').fill('Покупка консолей');
  await expect(dlg(page).getByTestId('op-preview')).toContainText('Денег не хватит');
  await dlg(page).getByRole('button', { name: 'Сохранить' }).click();
  await expect(dlg(page).getByRole('alert')).toHaveText(
    'Недостаточно денег (наличные): в кассе 15 934,56 ₽, после операции было бы −84 065,44 ₽. Внесите поступление или проверьте начальный остаток.',
  );
  await dlg(page).getByRole('button', { name: 'Отмена' }).click();
  await expect(journalRow(page, 'Покупка консолей')).toHaveCount(0);
});

test('Администратор вносит расход: предпросмотра нет, остатков нет ни в ответе, ни в отказе', async ({ page }) => {
  const calls: string[] = [];
  page.on('request', (r) => calls.push(r.url()));
  await login(page, 'admin@yu.test');
  await open(page, '/finance');
  await expect(page.getByRole('button', { name: 'Внести доход' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Внести расход' }).click();
  await dlg(page).getByLabel('Категория').selectOption({ label: 'Закупки и материалы' });
  await dlg(page).getByLabel('Подкатегория').selectOption({ label: 'Напитки' });
  await dlg(page).getByLabel('Сумма, ₽').fill('250');
  await dlg(page).getByLabel('Комментарий (основание)').fill('Вода в кулер');
  await page.waitForTimeout(600); // задержка предпросмотра прошла – запроса быть не должно
  await expect(dlg(page).getByTestId('op-preview')).toHaveCount(0);
  await dlg(page).getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByTestId('op-saved')).toHaveText(/^Расход №\d+ внесён: 250,00\s₽\.$/);
  await expect(journalRow(page, 'Вода в кулер')).toContainText('Вы');
  await expect(page.getByTestId('fin-after')).toHaveCount(0);

  await page.getByRole('button', { name: 'Внести расход' }).click();
  await dlg(page).getByLabel('Категория').selectOption({ label: 'Прочее' });
  await dlg(page).getByLabel('Сумма, ₽').fill('1000000');
  await dlg(page).getByLabel('Комментарий (основание)').fill('Слишком много');
  await dlg(page).getByRole('button', { name: 'Сохранить' }).click();
  const alert = dlg(page).getByRole('alert');
  await expect(alert).toHaveText('Недостаточно денег в кассе: внесите поступление или проверьте начальный остаток.');
  await expect(alert).not.toContainText('₽');
  expect(calls.some((u) => u.includes('/finance/preview'))).toBe(false);
});

test('Закрытый месяц: операцию прошлым месяцем не внести', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, KRASNY);
  await page.getByRole('button', { name: 'Закрыть месяц…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Закрыть месяц' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'закрыт' })).toBeVisible();
  const prevDay = await page.evaluate(() => {
    const t = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Novosibirsk' }).format(new Date());
    const [y, m] = t.split('-').map(Number) as [number, number];
    return m === 1 ? `${y - 1}-12-20` : `${y}-${String(m - 1).padStart(2, '0')}-20`;
  });
  await page.getByRole('button', { name: 'Внести расход' }).click();
  await dlg(page).getByLabel('Категория').selectOption({ label: 'Прочее' });
  await dlg(page).getByLabel('Сумма, ₽').fill('100');
  await dlg(page).getByLabel('Комментарий (основание)').fill('Забыли внести');
  await dlg(page).getByLabel('Дата').fill(prevDay);
  await dlg(page).getByRole('button', { name: 'Сохранить' }).click();
  await expect(dlg(page)).toContainText('закрыт: операцию этим месяцем не внести. Исправление – операцией текущей датой.');
});

test('Исправление через запись журнала: причина обязательна, закрытый месяц – отказ без сторно, затем сторно + новая', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, KRASNY);
  await journalRow(page, 'Игровой сеанс').getByRole('button', { name: /Открыть операцию/ }).click();
  await expect(page.getByTestId('fin-record').getByRole('button', { name: 'Исправить…' })).toHaveCount(0);
  await page.getByTestId('fin-record').getByRole('button', { name: 'Закрыть' }).click();

  await journalRow(page, 'Салфетки и моющее').getByRole('button', { name: /Открыть операцию/ }).click();
  await page.getByTestId('fin-record').getByRole('button', { name: 'Исправить…' }).click();
  await expect(dlg(page).getByRole('heading')).toHaveText(/Исправить операцию №\d+/);
  await expect(dlg(page).getByLabel('Сумма, ₽')).toHaveValue('300,00');
  await expect(dlg(page).getByLabel('Подкатегория')).toHaveValue(/.+/);
  await dlg(page).getByLabel('Сумма, ₽').fill('350');
  await dlg(page).getByRole('button', { name: 'Сохранить' }).click();
  await expect(dlg(page)).toContainText('Укажите причину исправления.');
  await dlg(page).getByLabel('Причина исправления').fill('Ошиблись в сумме чека');
  // Месяц закрыт предыдущим тестом: новая операция прошлым месяцем – отказ, исходная не сторнирована.
  const prevDay = await page.evaluate(() => {
    const t = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Novosibirsk' }).format(new Date());
    const [y, m] = t.split('-').map(Number) as [number, number];
    return m === 1 ? `${y - 1}-12-20` : `${y}-${String(m - 1).padStart(2, '0')}-20`;
  });
  const today = await dlg(page).getByLabel('Дата').inputValue();
  await dlg(page).getByLabel('Дата').fill(prevDay);
  await dlg(page).getByRole('button', { name: 'Сохранить' }).click();
  await expect(dlg(page)).toContainText('закрыт: операцию этим месяцем не внести');
  await dlg(page).getByLabel('Дата').fill(today);
  await dlg(page).getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByTestId('op-saved')).toHaveText(/Операция №\d+ исправлена: сторно №\d+, новая операция №\d+ на 350,00\s₽\./);
  await expect(journalRow(page, 'Салфетки и моющее')).toHaveCount(2);
  await expect(journalRow(page, 'Салфетки и моющее').filter({ hasText: 'Сторнирована' })).toContainText('300,00');
  await expect(journalRow(page, 'Салфетки и моющее').filter({ hasText: 'Проведена' })).toContainText('350,00');
  await expect(journalRow(page, 'Ошиблись в сумме чека')).toContainText('Сторно');
});

test('390 px: форма расхода без горизонтальной прокрутки, кнопки ≥ 44 px', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, 'owner@yu.test');
  await open(page, KRASNY);
  for (const name of ['Внести доход', 'Внести расход']) expect((await page.getByRole('button', { name }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.getByRole('button', { name: 'Внести расход' }).click();
  await dlg(page).getByLabel('Категория').selectOption({ label: 'Коммунальные' });
  await dlg(page).getByLabel('Сумма, ₽').fill('500');
  await expect(dlg(page).getByTestId('op-preview')).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);
  for (const name of ['Наличные', 'Карта', 'Перевод', 'Сохранить', 'Отмена']) {
    expect((await dlg(page).getByRole('button', { name, exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  await page.screenshot({ path: `${SHOTS}/finance-form-390.png` });
});

test('Категории: Владелец добавляет подкатегорию, переименовывает и убирает в архив окном; третьего уровня нет', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, '/finance/categories');
  const coms = page.getByTestId('cat-Коммунальные');
  await coms.getByRole('button', { name: '+ Подкатегория' }).click();
  await dlg(page).getByLabel('Название').fill('Газ');
  await dlg(page).getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByRole('status')).toHaveText('Добавлено: «Газ» в «Коммунальные».');
  const gas = page.getByTestId('cat-Газ');
  await expect(gas.getByRole('button', { name: '+ Подкатегория' })).toHaveCount(0); // подкатегория – последний уровень
  await gas.getByRole('button', { name: 'Переименовать' }).click();
  await dlg(page).getByLabel('Название').fill('Газоснабжение');
  await dlg(page).getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByTestId('cat-Газоснабжение')).toBeVisible();
  // Дубль имени на уровне – отказ сервера в окне.
  await coms.getByRole('button', { name: '+ Подкатегория' }).click();
  await dlg(page).getByLabel('Название').fill('Вода');
  await dlg(page).getByRole('button', { name: 'Сохранить' }).click();
  await expect(dlg(page).getByRole('alert')).toHaveText('Такое имя уже есть на этом уровне');
  await dlg(page).getByRole('button', { name: 'Отмена' }).click();
  await page.getByTestId('cat-Прочее').getByRole('button', { name: 'В архив…' }).click();
  await expect(dlg(page)).toContainText('уже внесённые сохранят категорию навсегда');
  await dlg(page).getByRole('button', { name: 'В архив', exact: true }).click();
  await expect(page.getByTestId('cat-Прочее')).toContainText('В архиве');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await noHorizontalScroll(page)).toBe(true);

  await open(page, KRASNY);
  await page.getByRole('button', { name: 'Внести расход' }).click();
  await dlg(page).getByLabel('Категория').selectOption({ label: 'Коммунальные' });
  await expect(dlg(page).getByLabel('Подкатегория').locator('option', { hasText: 'Газоснабжение' })).toHaveCount(1);
  await expect(dlg(page).getByLabel('Категория').locator('option', { hasText: 'Прочее' })).toHaveCount(0);
});

test('Категории: Администратор только смотрит', async ({ page }) => {
  await login(page, 'admin@yu.test');
  await open(page, '/finance/categories');
  await expect(page.getByTestId('cat-Коммунальные')).toBeVisible();
  await expect(page.getByRole('button', { name: '+ Категория' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Переименовать' })).toHaveCount(0);
});

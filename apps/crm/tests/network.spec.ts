// Проверка S0-15 (план 6.1), экраны сети: Владелец создаёт филиал и видит запись истории; список грузится порциями;
// удаление – только окном «в архив» внутри записи, архив – отдельный фильтр; пустое и ошибочное состояния;
// Директор без городов и без создания; несохранённая карточка – предупреждение. Мок: MOCK_PAGE_SIZE=2.
import { expect, test, type Page } from '@playwright/test';
import { MOCK_PASSWORD } from './mock-api.ts';

const MOCK = process.env.MOCK_URL ?? 'http://127.0.0.1:4012';
const SHOTS = process.env.SCREENSHOT_DIR ?? 'test-results/screens';

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

const rows = (page: Page, id = 'network-branches') => page.getByTestId(id).locator('tbody tr');

test('Владелец создаёт филиал, правит его и видит записи истории', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await page.goto('/network/branches');
  await page.getByRole('link', { name: 'Добавить филиал' }).click();

  // Пустые обязательные поля – ошибка у поля, запроса нет.
  await page.getByRole('button', { name: 'Создать филиал' }).click();
  await expect(page.getByText('Проверьте отмеченные поля.')).toBeVisible();
  await expect(page.getByLabel('Название *')).toHaveAttribute('aria-invalid', 'true');

  await page.getByLabel('Город *').selectOption({ label: 'Томск' });
  await page.getByLabel('Название *').fill('Ю Клуб на Фрунзе');
  await page.getByLabel('Адрес *', { exact: true }).fill('проспект Фрунзе, 11');
  await page.getByLabel('Адрес на сайте (slug) *').fill('frunze');
  await page.getByLabel('Часовой пояс *').selectOption('Asia/Tomsk');
  await page.locator('input[name="weeklyHours-7-on"]').uncheck();
  await page.getByLabel('Сб, закрытие').fill('23:00');
  await page.getByRole('button', { name: 'Создать филиал' }).click();

  await expect(page).toHaveURL(/\/network\/branches\/b-[0-9a-f]{8}$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Ю Клуб на Фрунзе');
  const history = page.getByTestId('history');
  await expect(history.locator('.yc-history__item')).toHaveCount(1);
  await expect(history).toContainText('Создание');
  await expect(history).toContainText('Ольга Владимирова (Владелец)');
  await expect(history).toContainText('Сб 10:00–23:00, Вс выходной');

  await page.getByLabel('Название *').fill('Ю Клуб на Фрунзе, 11');
  await page.getByLabel('Статус *').selectOption({ label: 'Работает' });
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByText('Сохранено.')).toBeVisible();
  await expect(history.locator('.yc-history__item')).toHaveCount(2);
  await expect(history.locator('.yc-history__item').first()).toContainText('Название: Ю Клуб на Фрунзе → Ю Клуб на Фрунзе, 11');
  await expect(history.locator('.yc-history__item').first()).toContainText('Статус: Готовится к открытию → Работает');

  // Повторное сохранение с той же версией из другой вкладки – конфликт, не тихая перезапись.
  const id = page.url().split('/').pop()!;
  const stale = await page.request.patch(`/api/crm/v1/branches/${id}`, { data: { rowVersion: 1, name: 'чужая правка' }, headers: { 'idempotency-key': crypto.randomUUID() } });
  expect(stale.status()).toBe(409);
  expect((await stale.json()).error.code).toBe('VERSION_CONFLICT');
});

test('список филиалов грузится порциями, поиск и фильтры', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await page.goto('/network/branches');
  await expect(rows(page)).toHaveCount(2);
  await page.getByRole('button', { name: 'Показать ещё' }).click();
  await expect(rows(page)).toHaveCount(4);
  await expect(page.getByRole('button', { name: 'Показать ещё' })).toBeHidden();
  await expect(page.getByText('Показано: 4')).toBeVisible();

  await page.getByLabel('Поиск по названию и адресу').fill('Ленина');
  await expect(rows(page)).toHaveCount(1);
  await expect(page).toHaveURL(/q=%D0%9B/);
  await page.getByLabel('Поиск по названию и адресу').fill('');
  await page.getByLabel('Город', { exact: true }).selectOption({ label: 'Новосибирск' });
  await expect(rows(page)).toHaveCount(2);
  await page.getByLabel('Статус', { exact: true }).selectOption({ label: 'Временно закрыт' });
  await expect(rows(page)).toHaveText([/Академгородок/]);

  await page.getByLabel('Поиск по названию и адресу').fill('нет такого');
  await expect(page.getByTestId('list-empty')).toContainText('Ничего не найдено по этим условиям.');
  await page.getByRole('button', { name: 'Сбросить поиск и фильтры' }).click();
  await expect(rows(page)).toHaveCount(2);
});

test('удаление филиала – окно «в архив», архив – отдельный фильтр, возврат', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await page.goto('/network/branches?q=Фрунзе');
  await rows(page).getByRole('link').click();
  await page.getByRole('button', { name: 'Удалить…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Удалить запись?' });
  await expect(dialog).toContainText('Можно отправить в архив');
  await dialog.getByRole('button', { name: 'Отмена' }).click();
  await expect(dialog).toBeHidden();

  await page.getByRole('button', { name: 'Удалить…' }).click();
  await dialog.getByRole('button', { name: 'В архив' }).click();
  await expect(page.getByRole('heading', { name: 'Запись в архиве' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Сохранить' })).toHaveCount(0);
  await expect(page.getByTestId('history').locator('.yc-history__item').first()).toContainText('Статус: Работает → В архиве');

  await page.goto('/network/branches?q=Фрунзе');
  await expect(page.getByTestId('list-empty')).toBeVisible();
  await page.getByRole('button', { name: 'Архив' }).click();
  await expect(rows(page)).toHaveText([/Фрунзе/]);
  await expect(page.getByRole('button', { name: 'Архив' })).toHaveAttribute('aria-pressed', 'true');

  await rows(page).getByRole('link').click();
  await page.getByRole('button', { name: 'Вернуть из архива' }).click();
  await expect(page.getByRole('button', { name: 'Сохранить' })).toBeVisible();
});

test('город с действующими филиалами не уходит в архив – причина в окне', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await page.goto('/network/cities');
  await expect(rows(page, 'network-cities')).toHaveCount(2);
  await rows(page, 'network-cities').getByRole('link', { name: 'Томск' }).click();
  await page.getByRole('button', { name: 'Удалить…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Удалить запись?' });
  await dialog.getByRole('button', { name: 'В архив' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Не получилось: В городе есть действующие филиалы – сначала отправьте их в архив.');
  await expect(page).toHaveURL(/\/network\/cities\/c-tsk$/);
});

test('пустое и ошибочное состояния списка и истории', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await page.route('**/api/crm/v1/branches?*', (r) =>
    r.fulfill({ status: 503, json: { error: { code: 'SERVICE_UNAVAILABLE', message: 'Сервер CRM не отвечает.' } } }),
  );
  await page.goto('/network/branches');
  const alert = page.getByTestId('network-branches').getByRole('alert');
  await expect(alert).toContainText('Список не загрузился: Сервер CRM не отвечает.');
  await page.unroute('**/api/crm/v1/branches?*');
  await alert.getByRole('button', { name: 'Повторить' }).click();
  await expect(rows(page)).toHaveCount(2);

  await page.route('**/api/crm/v1/branches?*', (r) => r.fulfill({ json: { items: [], nextCursor: null } }));
  await page.reload();
  await expect(page.getByTestId('list-empty')).toHaveText('Филиалов пока нет. Добавьте первый.');
  await page.getByRole('button', { name: 'Архив' }).click();
  await expect(page.getByTestId('list-empty')).toHaveText('В архиве пока ничего нет.');
  await page.unroute('**/api/crm/v1/branches?*');

  await page.goto('/network/branches/b-nsk-akadem');
  await expect(page.getByTestId('history')).toContainText('Изменений пока нет.');
  await page.route('**/api/crm/v1/audit/timeline?*', (r) => r.fulfill({ status: 500, json: { error: { code: 'INTERNAL', message: 'Внутренняя ошибка' } } }));
  await page.reload();
  await expect(page.getByTestId('history').getByRole('alert')).toContainText('История не загрузилась: Внутренняя ошибка.');
});

test('Директор: филиалы своего города без создания и городов; Администратор – без экрана сети', async ({ page, browser }) => {
  await login(page, 'director@yu.test');
  await page.goto('/network/branches');
  await expect(rows(page)).toHaveCount(2);
  await expect(page.getByRole('link', { name: 'Добавить филиал' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Города' })).toHaveCount(0);
  expect((await page.goto('/network/cities'))?.status()).toBe(404);
  expect((await page.goto('/network/branches/new'))?.status()).toBe(404);
  expect((await page.goto('/network/branches/b-tsk-lenina'))?.status()).toBe(404);
  await page.goto('/network/branches/b-nsk-krasny');
  await expect(page.getByRole('button', { name: 'Удалить…' })).toHaveCount(0);
  const create = await page.request.post('/api/crm/v1/branches', { data: { name: 'x' }, headers: { 'idempotency-key': crypto.randomUUID() } });
  expect(create.status()).toBe(403);

  const admin = await (await browser.newContext()).newPage();
  await login(admin, 'admin@yu.test');
  await expect(admin.getByRole('navigation', { name: 'Разделы' }).getByRole('link')).toHaveText(['Филиалы', 'Клиенты', 'Ресурсы']);
  const r = await admin.goto('/network/branches/b-nsk-krasny');
  expect(r?.status()).toBe(404);
  await expect(admin.getByTestId('not-found')).toBeVisible();
});

test('несохранённая карточка филиала – предупреждение при смене контекста', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await page.goto('/network/branches/b-nsk-krasny');
  await page.getByLabel('Адрес *', { exact: true }).fill('Красный проспект, 27');
  await page.getByLabel('Контекст').selectOption({ label: 'Ю Клуб на Ленина' });
  await expect(page.getByRole('dialog', { name: 'Несохранённые изменения' })).toBeVisible();
});

test('снимки сети 1440 и 390, без горизонтальной прокрутки', async ({ browser }) => {
  for (const [w, h] of [[1440, 900], [390, 844]] as const) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: w === 390 ? 2 : 1 });
    const page = await ctx.newPage();
    await login(page, 'owner@yu.test');
    const noScroll = async () => expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(w);
    await page.goto('/network/branches');
    await expect(rows(page)).toHaveCount(2);
    await page.screenshot({ path: `${SHOTS}/network-branches-${w}.png`, fullPage: true });
    await noScroll();
    await page.goto('/network/branches/new');
    await page.screenshot({ path: `${SHOTS}/branch-new-${w}.png`, fullPage: true });
    await noScroll();
    await page.goto('/network/branches/b-nsk-krasny');
    await page.getByLabel('Название *').fill(`Ю Клуб на Красном проспекте (${w})`);
    await page.getByRole('button', { name: 'Сохранить' }).click();
    await expect(page.getByText('Сохранено.')).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/branch-edit-history-${w}.png`, fullPage: true });
    await noScroll();
    await page.getByRole('button', { name: 'Удалить…' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/branch-archive-dialog-${w}.png` });
    await page.goto('/network/cities');
    await page.screenshot({ path: `${SHOTS}/network-cities-${w}.png`, fullPage: true });
    await noScroll();
    await ctx.close();
  }
});

// S3-86: справочники Э3. Приёмка: архив вместо удаления; Директору – только чтение (исполнителей правит по K1). 1440 и 390, Администратору раздела нет.
import { expect, test, type Page } from '../../../tests/support/e2e.ts';
import { key, login, noHorizontalScroll, open, resetMock, SHOTS, tapTargetsOk } from './event-helpers.ts';
import { MOCK } from './event-helpers.ts';

test.describe.configure({ mode: 'serial' });
test.beforeAll(async ({ request }) => resetMock(request));
test.afterAll(async ({ request }) => { await request.post(`${MOCK}/__test/reset`); });

const API = '/api/crm/v1';
const year = new Date().getUTCFullYear();
const list = (page: Page) => page.getByTestId('dict-list');

test('Праздничный календарь: Владелец добавляет дату, отмена – окном с причиной, отменённые отдельным разделом', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, '/dictionaries/holidays');
  await expect(page.getByTestId('holiday-year')).toHaveText(String(year));
  const form = page.getByTestId('holiday-form');
  await form.getByRole('button', { name: 'Добавить' }).click();
  await expect(page.getByTestId('holiday-calendar').getByRole('alert')).toContainText('дату');
  await form.getByLabel('Дата').fill(`${year}-12-30`);
  await form.getByLabel('Название').fill('Новогодний день');
  await form.getByRole('button', { name: 'Добавить' }).click();
  const row = page.getByTestId(`holiday-${year}-12-30`);
  await expect(row).toContainText('Новогодний день');
  await expect(row).toContainText('Вся сеть');
  await form.getByLabel('Дата').fill(`${year}-12-29`);
  await form.getByLabel('Название').fill('День города');
  await form.getByLabel('Где действует').selectOption({ label: 'Один город' });
  await form.getByLabel(/^Город/).selectOption({ label: 'Томск' });
  await form.getByRole('button', { name: 'Добавить' }).click();
  await expect(page.getByTestId(`holiday-${year}-12-29`)).toContainText('Томск');
  await page.screenshot({ path: `${SHOTS}/dict-holidays-1440.png`, fullPage: true });
  await row.getByRole('button', { name: /Отменить/ }).click();
  const c = page.getByTestId('holiday-cancel');
  await c.getByRole('button', { name: 'Отменить дату' }).click();
  await expect(c.getByRole('alert')).toContainText('причину');
  await c.getByLabel('Причина').fill('Перенесли');
  await c.getByRole('button', { name: 'Отменить дату' }).click();
  await expect(row).toHaveCount(0);
  await page.getByRole('button', { name: 'Отменённые' }).click();
  await expect(row).toContainText('Новогодний день');
});

test('Категории оборудования: добавить, переименовать, «Удалить» – окно с выбором в архив, возврат из архива', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, '/dictionaries/equipment-categories');
  await page.getByRole('button', { name: 'Добавить' }).click();
  const d = page.getByTestId('dict-dialog');
  await d.getByRole('button', { name: 'Сохранить' }).click();
  await expect(d.getByRole('alert')).toContainText('название');
  await d.getByLabel('Название').fill('Руль и педали');
  await d.getByRole('button', { name: 'Сохранить' }).click();
  await expect(list(page).getByTestId('row-Руль и педали')).toBeVisible();
  await page.getByRole('button', { name: 'Открыть: Руль и педали' }).click();
  await d.getByLabel('Название').fill('Гоночные рули');
  await d.getByRole('button', { name: 'Сохранить' }).click();
  await expect(list(page).getByTestId('row-Гоночные рули')).toBeVisible();
  await page.getByRole('button', { name: 'Открыть: Гоночные рули' }).click();
  await d.getByRole('button', { name: 'Удалить…' }).click();
  const a = page.getByTestId('dict-archive');
  await expect(a).toContainText('Совсем удалить нельзя');
  await a.getByRole('button', { name: 'В архив' }).click();
  await expect(list(page).getByTestId('row-Гоночные рули')).toHaveCount(0);
  await page.getByRole('button', { name: 'Архив', exact: true }).click();
  await expect(list(page).getByTestId('row-Гоночные рули')).toBeVisible();
  await page.getByRole('button', { name: 'Открыть: Гоночные рули' }).click();
  await d.getByRole('button', { name: 'Вернуть из архива' }).click();
  await expect(page.getByTestId('row-Гоночные рули')).toHaveCount(0);
  await page.getByRole('button', { name: 'Действующие' }).click();
  await expect(list(page).getByTestId('row-Гоночные рули')).toBeVisible();
});

test('Типы: системный не уходит в архив – окно объясняет; пакеты: строки шаблона, копейки целыми', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, '/dictionaries/event-types');
  await page.getByRole('button', { name: 'Открыть: Платный праздник' }).click();
  await page.getByTestId('dict-dialog').getByRole('button', { name: 'Удалить…' }).click();
  await expect(page.getByTestId('dict-system')).toContainText('системный');
  await expect(page.getByTestId('dict-archive').getByRole('button', { name: 'В архив' })).toHaveCount(0);
  await page.getByTestId('dict-archive').getByRole('button', { name: 'Назад' }).click();
  await page.getByTestId('dict-dialog').getByRole('button', { name: 'Назад' }).click();
  await page.getByRole('button', { name: 'Добавить' }).click();
  const d = page.getByTestId('dict-dialog');
  await d.getByLabel('Название').fill('Корпоратив');
  await d.getByLabel('Код').fill('Корп');
  await d.getByRole('button', { name: 'Сохранить' }).click();
  await expect(d.getByRole('alert')).toContainText('латиница');
  await d.getByLabel('Код').fill('corporate');
  await d.getByRole('button', { name: 'Сохранить' }).click();
  await expect(list(page).getByTestId('row-Корпоратив')).toContainText('corporate');

  await open(page, '/dictionaries/event-packages');
  await page.getByRole('button', { name: 'Добавить' }).click();
  await d.getByLabel('Название', { exact: true }).fill('Праздник «Макси»');
  await d.getByLabel('Ориентировочная цена, ₽').fill('25000');
  await d.getByLabel('Строка: название').fill('Комната');
  await d.getByLabel('Цена, ₽', { exact: true }).fill('1999,99');
  await d.getByLabel('Себестоимость, ₽').fill('500');
  await d.getByRole('button', { name: 'Ещё строка' }).click();
  await d.getByTestId('pack-line-1').getByLabel('Строка: название').fill('Стол');
  await d.getByRole('button', { name: 'Сохранить' }).click();
  await expect(list(page).getByTestId('row-Праздник «Макси»')).toContainText('Строк: 2');
  const packs = ((await (await page.request.get(`${API}/event-packages`)).json()) as { items: Array<{ name: string; lines: Array<{ priceKop: number; planCostKop?: number }> }> }).items;
  const max = packs.find((x) => x.name === 'Праздник «Макси»')!;
  expect(max.lines[0]!.priceKop).toBe(199_999);
  expect(max.lines[0]!.planCostKop).toBe(50_000);
  // S3-97: PATCH заменяет lines целиком – правка пакета не стирает поставщика строки, которого в окне нет
  await page.getByRole('button', { name: 'Открыть: Праздник «Старт»' }).click();
  await d.getByLabel('Название', { exact: true }).fill('Праздник «Старт+»');
  await d.getByRole('button', { name: 'Сохранить' }).click();
  await expect(list(page).getByTestId('row-Праздник «Старт+»')).toBeVisible();
  const after = ((await (await page.request.get(`${API}/event-packages`)).json()) as { items: Array<{ name: string; lines: Array<{ supplier?: string | null }> }> }).items;
  expect(after.find((x) => x.name === 'Праздник «Старт+»')!.lines[1]!.supplier).toBe('Праздник рядом');
  await page.screenshot({ path: `${SHOTS}/dict-packages-1440.png`, fullPage: true });
});

test('Директор: читает праздники, категории, типы и пакеты; правит только исполнителей; сервер отклоняет остальное', async ({ page }) => {
  await login(page, 'director@yu.test');
  await page.getByRole('navigation', { name: 'Разделы' }).getByRole('link', { name: 'Справочники' }).click();
  await expect(page).toHaveURL(/\/dictionaries\/holidays$/);
  await expect(page.locator('astro-island[ssr]')).toHaveCount(0);
  await expect(page.getByTestId('holiday-readonly')).toBeVisible();
  await expect(page.getByTestId('holiday-form')).toHaveCount(0);
  await expect(page.getByTestId('holiday-calendar').getByRole('button', { name: /Отменить/ })).toHaveCount(0);
  for (const kind of ['equipment-categories', 'event-types', 'event-packages']) {
    await open(page, `/dictionaries/${kind}`);
    await expect(page.getByTestId('dict-readonly')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Добавить' })).toHaveCount(0);
  }
  await page.getByRole('button', { name: /Открыть: Праздник/ }).first().click();
  const d = page.getByTestId('dict-dialog');
  await expect(d.getByRole('button', { name: 'Удалить…' })).toHaveCount(0);
  await expect(d.getByRole('button', { name: 'Сохранить' })).toHaveCount(0);
  await expect(d.getByLabel('Название', { exact: true })).toBeDisabled();
  for (const [path, data] of [['/holidays', { scope: 'network', date: '2030-01-01', name: 'x' }], ['/event-types', { code: 'x_x', name: 'x' }], ['/equipment-categories', { name: 'x' }]] as const) {
    expect((await page.request.post(`${API}${path}`, { headers: key(), data })).status()).toBe(403);
  }
  expect((await page.goto('/dictionaries/reasons'))?.status()).toBe(404);

  await open(page, '/dictionaries/repair-executors');
  await page.getByRole('button', { name: 'Добавить' }).click();
  await d.getByLabel('Название').fill('Сервис ВР');
  await d.getByLabel('Телефон').fill('+79130001234');
  await d.getByRole('button', { name: 'Сохранить' }).click();
  await expect(list(page).getByTestId('row-Сервис ВР')).toContainText('Подрядчик');

  // Архив и возврат – как у категорий; устаревшая версия – 409, как в API (K19 №349)
  const ex = ((await (await page.request.get(`${API}/repair-executors?includeArchived=true`)).json()).items as Array<{ id: string; name: string; rowVersion: number }>).find((x) => x.name === 'Сервис ВР')!;
  const stale = await page.request.patch(`${API}/repair-executors/${ex.id}`, { headers: key(), data: { rowVersion: ex.rowVersion + 5, comment: 'чужая правка' } });
  expect(stale.status()).toBe(409);
  expect((await stale.json()).error.code).toBe('VERSION_CONFLICT');
  expect((await page.request.patch(`${API}/repair-executors/${ex.id}`, { headers: key(), data: { comment: 'без версии' } })).status()).toBe(400);
  await page.getByRole('button', { name: 'Открыть: Сервис ВР' }).click();
  await d.getByRole('button', { name: 'Удалить…' }).click();
  const a = page.getByTestId('dict-archive');
  await expect(a).toContainText('Совсем удалить нельзя');
  await a.getByRole('button', { name: 'В архив' }).click();
  await expect(list(page).getByTestId('row-Сервис ВР')).toHaveCount(0);
  await page.getByRole('button', { name: 'Архив', exact: true }).click();
  await page.getByRole('button', { name: 'Открыть: Сервис ВР' }).click();
  await d.getByRole('button', { name: 'Вернуть из архива' }).click();
  await page.getByRole('button', { name: 'Действующие' }).click();
  await expect(list(page).getByTestId('row-Сервис ВР')).toBeVisible();
  const after = ((await (await page.request.get(`${API}/repair-executors`)).json()).items as Array<{ name: string; rowVersion: number; status: string }>).find((x) => x.name === 'Сервис ВР')!;
  expect(after).toMatchObject({ status: 'active', rowVersion: ex.rowVersion + 2 });
});

test('Администратор – 404; 390 без прокрутки, кнопки ≥ 44', async ({ page, browser }) => {
  await login(page, 'admin@yu.test');
  await expect(page.getByRole('navigation', { name: 'Разделы' }).getByRole('link', { name: 'Справочники' })).toHaveCount(0);
  expect((await page.goto('/dictionaries/holidays'))?.status()).toBe(404);

  const p = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await login(p, 'owner@yu.test');
  for (const kind of ['holidays', 'equipment-categories', 'event-types', 'event-packages', 'repair-executors']) {
    await open(p, `/dictionaries/${kind}`);
    expect(await noHorizontalScroll(p), kind).toBe(true);
    expect(await tapTargetsOk(p), kind).toEqual([]);
  }
  await open(p, '/dictionaries/holidays');
  await p.screenshot({ path: `${SHOTS}/dict-holidays-390.png`, fullPage: true });
});

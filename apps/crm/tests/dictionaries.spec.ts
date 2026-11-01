// Проверка S0-15 (план 6.1), справочники: системный код не удаляется и не меняется; пользовательская причина – архив;
// создание и правка с записью истории; Администратор и Директор не видят экран и получают 404 (страница) / 403 (API).
// Маршруты мока – точно по apps/api/src/modules/dictionaries/routes.ts.
import { expect, test, type Page } from '@playwright/test';
import { MOCK_PASSWORD } from './mock-api.ts';

const MOCK = process.env.MOCK_URL ?? 'http://127.0.0.1:4012';
const SHOTS = process.env.SCREENSHOT_DIR ?? 'test-results/screens';
const SYSTEM_REASON = '00000000-0000-4000-8000-000000000001'; // booking_cancel_club / other
const key = () => ({ 'idempotency-key': crypto.randomUUID() });

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

const rows = (page: Page, kind = 'reasons') => page.getByTestId(`dict-${kind}`).locator('tbody tr');

test('Владелец: меню и системный код причины – не удаляется и не меняется', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await expect(page.getByRole('navigation', { name: 'Разделы' }).getByRole('link')).toHaveText(['Расписание', 'Филиалы', 'Клиенты', 'Сотрудники', 'Ресурсы', 'Сеть', 'Справочники']);
  await page.getByRole('link', { name: 'Справочники' }).click();
  await expect(page).toHaveURL(/\/dictionaries\/reasons$/);
  await expect(rows(page)).toHaveCount(10);

  await page.getByLabel('Где применяется').selectOption({ label: 'Отмена брони клубом' });
  await expect(rows(page)).toHaveCount(2);
  await rows(page).filter({ hasText: 'Системное' }).getByRole('link').click();
  await expect(page).toHaveURL(new RegExp(`/dictionaries/reasons/${SYSTEM_REASON}$`));
  await expect(page.getByLabel('Код', { exact: true })).toHaveAttribute('readonly', '');

  await page.getByRole('button', { name: 'Удалить…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Удалить нельзя' });
  await expect(dialog).toContainText('Системное значение');
  await expect(dialog.getByRole('button', { name: 'В архив' })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Понятно' }).click();
  await expect(dialog).toBeHidden();

  // Сервер держит то же: удалить, архивировать и сменить код системного значения нельзя.
  const base = `/api/crm/v1/dictionaries/reasons/${SYSTEM_REASON}`;
  for (const r of [
    await page.request.delete(base, { headers: key() }),
    await page.request.post(`${base}/archive`, { headers: key() }),
    await page.request.patch(base, { data: { code: 'renamed' }, headers: key() }),
  ]) {
    expect(r.status()).toBe(409);
    expect((await r.json()).error.code).toBe('DICTIONARY_SYSTEM_IMMUTABLE');
  }

  // Название системного значения поменять можно – запись в истории.
  await page.getByLabel('Название *').fill('Другая причина');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByText('Сохранено.')).toBeVisible();
  await expect(page.getByTestId('history')).toContainText('Название: Другое → Другая причина');
});

test('пользовательская причина: создание, удаление – только в архив, архив – отдельный фильтр', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await page.goto('/dictionaries/reasons');
  await page.getByRole('link', { name: 'Добавить значение' }).click();
  await page.getByLabel('Где применяется *').selectOption({ label: 'Блокировка ресурса' });
  await page.getByLabel('Код *').fill('Плохой код');
  await page.getByLabel('Название *').fill('Уборка зала');
  await page.getByRole('button', { name: 'Добавить' }).click();
  await expect(page.locator('#f-code-error')).toHaveText('Латиница в нижнем регистре, цифры и _, первая – буква');
  await page.getByLabel('Код *').fill('cleaning');
  await page.getByRole('button', { name: 'Добавить' }).click();

  await expect(page).toHaveURL(/\/dictionaries\/reasons\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('history')).toContainText('Создание');
  await page.getByRole('button', { name: 'Удалить…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Удалить запись?' });
  await dialog.getByRole('button', { name: 'В архив' }).click();
  await expect(page.getByRole('heading', { name: 'Запись в архиве' })).toBeVisible();
  await expect(page.getByTestId('history').locator('.yc-history__item').first()).toContainText('В архив');

  const r = await page.request.delete(new URL(page.url()).pathname.replace('/dictionaries', '/api/crm/v1/dictionaries'), { headers: key() });
  expect(r.status()).toBe(409);
  expect((await r.json()).error.code).toBe('DICTIONARY_ARCHIVE_ONLY');

  await page.goto('/dictionaries/reasons');
  await page.getByLabel('Поиск по названию и коду').fill('уборка');
  await expect(page.getByTestId('list-empty')).toContainText('Ничего не найдено');
  await page.getByRole('button', { name: 'Архив' }).click();
  await expect(rows(page)).toHaveText([/Уборка зала/]);
});

test('типы ресурсов: без создания и архива, шаг правится', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await page.goto('/dictionaries/resource-types');
  await expect(rows(page, 'resource-types')).toHaveCount(5);
  await expect(page.getByRole('link', { name: 'Добавить значение' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Архив' })).toHaveCount(0);
  expect((await page.goto('/dictionaries/resource-types/new'))?.status()).toBe(404);
  await page.goto('/dictionaries/resource-types/vr_seat');
  await page.getByLabel('Шаг записи, минут *').fill('30');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByTestId('history')).toContainText('Шаг записи, минут: 15 → 30');
});

test('Администратор и Директор: экрана справочников нет, прямая ссылка – 404, изменение – 403', async ({ page, browser }) => {
  for (const [p, email] of [[page, 'admin@yu.test'], [await (await browser.newContext()).newPage(), 'director@yu.test']] as const) {
    await login(p, email);
    await expect(p.getByRole('navigation', { name: 'Разделы' }).getByRole('link', { name: 'Справочники' })).toHaveCount(0);
    for (const url of ['/dictionaries', '/dictionaries/reasons', `/dictionaries/reasons/${SYSTEM_REASON}`, '/dictionaries/space-types/new']) {
      const r = await p.goto(url);
      expect(r?.status(), `${email} ${url}`).toBe(404);
      await expect(p.getByTestId('not-found')).toBeVisible();
      await expect(p.locator('body')).not.toContainText('Другое');
    }
    const patch = await p.request.patch('/api/crm/v1/dictionaries/space-types/hall', { data: { name: 'x' }, headers: key() });
    expect(patch.status()).toBe(403);
    const create = await p.request.post('/api/crm/v1/dictionaries/reasons', { data: { domain: 'no_show', code: 'x', name: 'x' }, headers: key() });
    expect(create.status()).toBe(403);
  }
});

test('ошибка загрузки справочника – сообщение и повтор', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await page.route('**/api/crm/v1/dictionaries/space-types?*', (r) =>
    r.fulfill({ status: 503, json: { error: { code: 'SERVICE_UNAVAILABLE', message: 'Сервер CRM не отвечает.' } } }),
  );
  await page.goto('/dictionaries/space-types');
  await expect(page.getByTestId('dict-space-types').getByRole('alert')).toContainText('Список не загрузился');
  await page.unroute('**/api/crm/v1/dictionaries/space-types?*');
  await page.getByRole('button', { name: 'Повторить' }).click();
  await expect(rows(page, 'space-types')).toHaveCount(5);
});

test('снимки справочников 1440 и 390, без горизонтальной прокрутки', async ({ browser }) => {
  for (const [w, h] of [[1440, 900], [390, 844]] as const) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: w === 390 ? 2 : 1 });
    const page = await ctx.newPage();
    await login(page, 'owner@yu.test');
    await page.goto('/dictionaries/reasons');
    await expect(rows(page)).not.toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/dict-reasons-${w}.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(w);
    await page.goto(`/dictionaries/reasons/${SYSTEM_REASON}`);
    await page.getByRole('button', { name: 'Удалить…' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/dict-system-delete-${w}.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(w);
    await ctx.close();
  }
});

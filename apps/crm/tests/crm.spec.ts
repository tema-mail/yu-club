// Проверка S0-14 (план 6.1): вход/выход, неверный пароль без утечки, Администратор видит только свои филиалы,
// прямая ссылка на чужой филиал – отказ (404 от API), несохранённая форма при смене контекста – предупреждение.
// Работает на моке API (tests/mock-api.ts), бэкенд не нужен.
import { expect, test, type Page } from '@playwright/test';
import { MOCK_PASSWORD } from './mock-api.ts';

const SHOTS = process.env.SCREENSHOT_DIR ?? 'test-results/screens';

async function login(page: Page, email: string, password = MOCK_PASSWORD) {
  await page.goto('/login');
  await page.getByLabel('Почта').fill(email);
  await page.getByLabel('Пароль', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Войти' }).click();
}

async function contextOptions(page: Page): Promise<string[]> {
  const select = page.getByLabel('Контекст');
  await expect(select).toBeVisible();
  return select.locator('option').allTextContents();
}

test('вход и выход', async ({ page }) => {
  await page.goto('/branches/b-nsk-krasny');
  await expect(page).toHaveURL(/\/login\?next=%2Fbranches%2Fb-nsk-krasny$/);

  await login(page, 'Admin@YU.test');
  await expect(page).toHaveURL(/\/branches\/b-nsk-krasny$/);
  await expect(page.getByTestId('staff-who')).toContainText('Анна Админова');
  await expect(page.getByTestId('staff-who')).toContainText('Администратор');

  await page.getByRole('button', { name: 'Выйти' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/');
  await expect(page).toHaveURL(/\/login\?next=%2F$/);
});

test('неверный пароль и несуществующая почта – одно и то же сообщение', async ({ page }) => {
  const bodies: unknown[] = [];
  page.on('response', async (r) => {
    if (r.url().endsWith('/api/crm/v1/auth/login')) {
      const { error } = (await r.json()) as { error: { code: string; message: string } };
      bodies.push({ status: r.status(), code: error.code, message: error.message });
    }
  });

  await login(page, 'admin@yu.test', 'неверный-пароль');
  const alert = page.getByRole('alert');
  await expect(alert).toHaveText('Неверная почта или пароль.');
  const wrongPassword = await alert.textContent();

  await login(page, 'nobody@yu.test', 'неверный-пароль');
  await expect(alert).toHaveText('Неверная почта или пароль.');
  expect(await alert.textContent()).toBe(wrongPassword);
  await expect(page).toHaveURL(/\/login$/);

  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[0]).toEqual(bodies[1]);
  expect(bodies[0]).toMatchObject({ status: 401, code: 'INVALID_CREDENTIALS' });
});

test('Администратор видит только свои филиалы, Владелец – всю сеть', async ({ page, browser }) => {
  await login(page, 'admin@yu.test');
  await expect(page).toHaveURL(/\/branches\/b-nsk-krasny$/);
  expect(await contextOptions(page)).toEqual(['Ю Клуб на Красном']);
  await expect(page.getByRole('navigation', { name: 'Разделы' }).getByRole('link')).toHaveText(['Филиалы']);

  const owner = await (await browser.newContext()).newPage();
  await login(owner, 'owner@yu.test');
  await expect(owner).toHaveURL(/\/$/);
  expect(await contextOptions(owner)).toEqual([
    'Вся сеть',
    'Новосибирск – весь город', 'Ю Клуб на Красном', 'Ю Клуб Академгородок',
    'Томск – весь город', 'Ю Клуб на Ленина',
  ]);
  await expect(owner.getByTestId('branch-list').locator('tbody tr')).toHaveCount(3);
});

test('прямая ссылка на чужой филиал – отказ, как у несуществующего', async ({ page }) => {
  await login(page, 'admin@yu.test');
  await expect(page).toHaveURL(/\/branches\/b-nsk-krasny$/);

  const api = await page.request.get('/api/crm/v1/branches/b-tsk-lenina');
  expect(api.status()).toBe(404);
  expect((await api.json()).error.code).toBe('NOT_FOUND');

  const foreign = await page.goto('/branches/b-tsk-lenina');
  expect(foreign?.status()).toBe(404);
  const foreignText = await page.getByTestId('not-found').textContent();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Филиал не найден');
  await expect(page.locator('body')).not.toContainText('Ленина');

  const missing = await page.goto('/branches/net-takogo');
  expect(missing?.status()).toBe(404);
  expect(await page.getByTestId('not-found').textContent()).toBe(foreignText);
});

test('несохранённая форма при смене контекста – предупреждение', async ({ page }) => {
  await login(page, 'director@yu.test');
  await expect(page).toHaveURL(/\/$/);
  expect(await contextOptions(page)).toEqual(['Новосибирск – весь город', 'Ю Клуб на Красном', 'Ю Клуб Академгородок']);

  await page.goto('/account/password');
  const select = page.getByLabel('Контекст');
  const field = page.getByLabel('Текущий пароль');
  await field.fill('черновик');

  await select.selectOption({ label: 'Ю Клуб Академгородок' });
  const dialog = page.getByRole('dialog', { name: 'Несохранённые изменения' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Ю Клуб Академгородок');

  await dialog.getByRole('button', { name: 'Остаться' }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/\/account\/password$/);
  await expect(field).toHaveValue('черновик');
  await expect(select).toHaveValue('city:c-nsk');

  await select.selectOption({ label: 'Ю Клуб Академгородок' });
  await dialog.getByRole('button', { name: 'Сменить без сохранения' }).click();
  await expect(page).toHaveURL(/\/branches\/b-nsk-akadem$/);
  await expect(page.getByLabel('Контекст')).toHaveValue('branch:b-nsk-akadem');

  // Без ввода – смена сразу, без окна.
  await page.getByLabel('Контекст').selectOption({ label: 'Новосибирск – весь город' });
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Филиалы: Новосибирск');
});

test('снимки 1440 и 390, без горизонтальной прокрутки', async ({ browser }) => {
  for (const [w, h] of [[1440, 900], [390, 844]] as const) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: w === 390 ? 2 : 1 });
    const page = await ctx.newPage();
    await page.goto('/login');
    await page.screenshot({ path: `${SHOTS}/login-${w}.png`, fullPage: true });
    await login(page, 'owner@yu.test');
    await expect(page.getByTestId('branch-list')).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/owner-network-${w}.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(w);
    await page.goto('/branches/b-nsk-akadem');
    await page.screenshot({ path: `${SHOTS}/branch-card-${w}.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(w);
    await page.goto('/account/password');
    await page.getByLabel('Текущий пароль').fill('x');
    await page.getByLabel('Контекст').selectOption({ label: 'Ю Клуб на Ленина' });
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/dirty-dialog-${w}.png` });
    await ctx.close();
  }
});

// e2e входа клиента и ЛК (S1-17) на моке по apps/api/src/modules/clients/routes.public.ts.
// Адрес – localhost, а не 127.0.0.1: кука yu_client от API с флагом Secure, браузер принимает её по http только на localhost.
import { expect, test, type Page } from '@playwright/test';
import { MOCK_PORT, PROD_PORT, STAGE_PORT } from '../playwright.config.ts';
import { MOCK_CODE } from './mock-api.ts';

test.use({ baseURL: `http://localhost:${STAGE_PORT}` });

async function toCode(page: Page, phone: string, next?: string) {
  await page.goto(next === undefined ? '/login/' : `/login/?next=${next}`);
  await page.getByLabel('Телефон').fill(phone);
  await page.getByRole('button', { name: 'Получить код' }).click();
  await expect(page.getByLabel('Код из SMS')).toBeVisible();
}

async function login(page: Page, phone = '9131234567', next?: string) {
  await toCode(page, phone, next);
  await page.getByLabel('Код из SMS').fill(MOCK_CODE);
  await page.getByLabel(/согласие на обработку/).check();
  await page.getByRole('button', { name: 'Войти' }).click();
}

test('полный вход: маска +7, код, согласие, кабинет, выход', async ({ page, context }) => {
  await page.goto('/account/');
  await expect(page).toHaveURL(/\/login\/\?next=%2Faccount%2F$/);
  await expect(page.getByTestId('header-account')).toHaveText('Войти');

  const phone = page.getByLabel('Телефон');
  await phone.fill('8 913 123 45 67');
  await expect(phone).toHaveValue('+7 (913) 123-45-67');
  expect(await phone.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
  await page.getByRole('button', { name: 'Получить код' }).click();

  await expect(page.locator('#code-sent')).toContainText('+7 (913) 123-45-67');
  const consent = page.getByLabel(/согласие на обработку/);
  await expect(consent).not.toBeChecked();
  await expect(page.locator('#code-form a[href="/personal-data-consent/"]')).toBeVisible();
  await page.getByLabel('Код из SMS').fill(MOCK_CODE);
  await expect(page.getByRole('button', { name: 'Войти' })).toBeDisabled();
  await consent.check();
  await page.getByRole('button', { name: 'Войти' }).click();

  await expect(page).toHaveURL(/\/account\/$/);
  await expect(page.getByTestId('profile-name')).toHaveText('Алина Сафронова');
  await expect(page.getByTestId('profile-phone')).toHaveText('+7 ••• ••• ••-67');
  await expect(page.getByTestId('header-account')).toHaveText('Кабинет');
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex, nofollow');
  const session = (await context.cookies()).find((c) => c.name === 'yu_client');
  expect(session?.httpOnly).toBe(true);
  // Переключателей и «Моих записей» нет: ручек API под них ещё нет.
  await expect(page.getByRole('checkbox')).toHaveCount(0);

  await page.getByRole('button', { name: 'Выйти' }).click();
  await expect(page).toHaveURL(/localhost:\d+\/$/);
  await expect(page.getByTestId('header-account')).toHaveText('Войти');
  expect((await context.cookies()).find((c) => c.name === 'yu_client')).toBeUndefined();
  await page.goto('/account/');
  await expect(page).toHaveURL(/\/login\/\?next=/);
});

test('неверный код – понятная фраза и число попыток, ввод остаётся на месте', async ({ page }) => {
  await toCode(page, '9131234567');
  await page.getByLabel('Код из SMS').fill('000000');
  await page.getByLabel(/согласие на обработку/).check();
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.locator('#auth-error')).toHaveText('Код не подходит. Осталось попыток: 4.');
  await expect(page).toHaveURL(/\/login\/$/);
  await expect(page.getByRole('button', { name: 'Войти' })).toBeEnabled();
});

test('лимит запросов кода и недоступность SMS – фразы с ожиданием, шаг кода не открывается', async ({ page }) => {
  await page.goto('/login/');
  await page.getByLabel('Телефон').fill('9990000429');
  await page.getByRole('button', { name: 'Получить код' }).click();
  await expect(page.locator('#auth-error')).toHaveText('Слишком много запросов кода. Попробуйте через 1 мин.');
  await expect(page.getByLabel('Код из SMS')).toBeHidden();

  await page.getByLabel('Телефон').fill('9990000503');
  await page.getByRole('button', { name: 'Получить код' }).click();
  await expect(page.locator('#auth-error')).toHaveText('Не получилось отправить SMS. Попробуйте через минуту.');

  await page.getByLabel('Телефон').fill('91312');
  await page.getByRole('button', { name: 'Получить код' }).click();
  await expect(page.locator('#auth-error')).toHaveText('Введите номер полностью: 10 цифр после +7.');
});

test('заблокированный клиент – отказ без подробностей', async ({ page }) => {
  await login(page, '9990000403');
  await expect(page.locator('#auth-error')).toHaveText('Вход в кабинет сейчас недоступен. Обратитесь к администратору клуба.');
  await expect(page).toHaveURL(/\/login\/$/);
});

test('без галочки согласия войти нельзя – ни кнопкой, ни Enter', async ({ page }) => {
  await toCode(page, '9131111111');
  const verifies: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/auth/otp/verify')) verifies.push(r.url());
  });
  await page.getByLabel('Код из SMS').fill(MOCK_CODE);
  await expect(page.getByRole('button', { name: 'Войти' })).toBeDisabled();
  await page.getByLabel('Код из SMS').press('Enter');
  await page.waitForTimeout(300);
  expect(verifies).toHaveLength(0);
  await expect(page).toHaveURL(/\/login\/$/);
});

test('next не уводит на чужой домен: %09, //, https://, обратный слеш', async ({ page }) => {
  // Браузерный путь: вход с next=//evil.com – в кабинет.
  await login(page, '9131234567', encodeURIComponent('//evil.com'));
  await expect(page).toHaveURL(/localhost:\d+\/account\/$/);

  // Серверный путь: с живой сессией /login/ сразу уводит по next – только на свой адрес.
  for (const bad of ['/%09/evil.com', '//evil.com', 'https%3A%2F%2Fevil.com', '%2F%5Cevil.com', '/%0A/evil.com']) {
    await page.goto(`/login/?next=${bad}`);
    await expect(page, bad).toHaveURL(/localhost:\d+\/account\/$/);
  }
  await page.goto(`/login/?next=${encodeURIComponent('/tomsk/lenina/')}`);
  await expect(page).toHaveURL(/localhost:\d+\/tomsk\/lenina\/$/);
});

test('прокси: изменяющий запрос без X-Requested-With – 403; X-Forwarded-For – только от доверенного', async ({ request }) => {
  const plain = await request.post('/api/public/v1/auth/otp/request/', { data: { phone: '+79131234567', purpose: 'login' } });
  expect(plain.status()).toBe(403);
  const foreign = await request.post('/api/public/v1/auth/logout/', { headers: { 'x-requested-with': 'yu-site', origin: 'https://evil.com' } });
  expect(foreign.status()).toBe(403);

  const send = (base: string) =>
    request.post(`${base}/api/public/v1/auth/otp/request/`, {
      headers: { 'x-requested-with': 'yu-site', 'idempotency-key': crypto.randomUUID(), 'x-forwarded-for': '198.51.100.9' },
      data: { phone: '+79131234567', purpose: 'login' },
    });
  const lastXff = async () => ((await (await request.get(`http://127.0.0.1:${MOCK_PORT}/__test/last-xff`)).json()) as { xff: string }).xff;
  // Стенд: loopback – доверенный прокси по умолчанию, адрес из цепочки принимается.
  expect((await send(`http://127.0.0.1:${STAGE_PORT}`)).status()).toBe(202);
  expect(await lastXff()).toBe('198.51.100.9');
  // Бой: TRUSTED_PROXIES без loopback – подделка игнорируется, берётся адрес соединения.
  expect((await send(`http://127.0.0.1:${PROD_PORT}`)).status()).toBe(202);
  expect(await lastXff()).toBe('127.0.0.1');
});

test('390 px: вход и кабинет без горизонтальной прокрутки', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const check = async (label: string) => {
    const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    expect(scroll, label).toBeLessThanOrEqual(client);
  };
  await page.goto('/login/');
  await check('телефон');
  await page.screenshot({ path: 'test-results/screens/390-login-phone.png', fullPage: true });
  await toCode(page, '9131234567');
  await page.getByLabel('Код из SMS').fill('000000');
  await page.getByLabel(/согласие на обработку/).check();
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.locator('#auth-error')).not.toBeEmpty();
  await check('код с ошибкой');
  await page.screenshot({ path: 'test-results/screens/390-login-code.png', fullPage: true });
  await page.getByLabel('Код из SMS').fill(MOCK_CODE);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(/\/account\/$/);
  await check('кабинет');
  await page.screenshot({ path: 'test-results/screens/390-account.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: 'test-results/screens/1440-account.png', fullPage: true });
});

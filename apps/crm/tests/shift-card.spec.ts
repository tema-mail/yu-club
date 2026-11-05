// Карточка смены (S3-73) на моке: план/факт, ручные минуты – без комментария кнопка неактивна, сервер всё равно COMMENT_REQUIRED; невыход и отмена окном с причиной;
// история; Администратор без сумм и без исправлений (маска в истории), чужой филиал – 404; закрытый период – понятный отказ. 1440 и 390 px.
import { expect, test, type Page } from '@playwright/test';
import { MOCK_PASSWORD } from './mock-api.ts';

const MOCK = process.env.MOCK_URL ?? 'http://127.0.0.1:4012';
const SHOTS = process.env.SCREENSHOT_DIR ?? 'test-results/screens';
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
async function open(page: Page, url: string) {
  await page.goto(url);
  await page.waitForLoadState('load');
  await expect(page.locator('astro-island[ssr]')).toHaveCount(0);
}

test('Директор: ручные минуты требуют комментарий (и в кнопке, и на сервере), факт и сумма обновляются, история пополняется', async ({ page }) => {
  await login(page, 'director@yu.test');
  await open(page, '/shifts/sh-past');
  await expect(page.getByTestId('sc-plan-time')).toContainText('10:00–14:00, 4 ч');
  await expect(page.getByTestId('sc-fact')).toContainText('нет отметок');
  await expect(page.getByTestId('sc-planned-kop')).toContainText('1 200,00 ₽'); // 240 мин × 300 ₽/ч
  await expect(page.getByTestId('sc-fact-kop')).toContainText('не проведено');
  const form = page.getByTestId('sc-fact-form');
  await form.getByRole('button', { name: 'Минуты вручную' }).click();
  await form.getByLabel('Оплачиваемые минуты').fill('95');
  await expect(form.getByRole('button', { name: 'Сохранить факт' })).toBeDisabled();

  const rowVersion = ((await (await page.request.get('/api/crm/v1/shifts/sh-past')).json()) as { rowVersion: number }).rowVersion;
  const bare = await page.request.post('/api/crm/v1/shifts/sh-past/attendance', { data: { rowVersion, status: 'worked', paidMinutes: 95, reason: '  ' }, headers: key() });
  expect(bare.status()).toBe(422);
  expect(((await bare.json()) as { error: { code: string } }).error.code).toBe('COMMENT_REQUIRED');

  await form.getByLabel('Комментарий *').fill('Ушёл раньше, согласовано');
  await form.getByRole('button', { name: 'Сохранить факт' }).click();
  await expect(page.getByTestId('sc-notice')).toContainText('Факт сохранён');
  await expect(page.getByTestId('sc-status')).toContainText('Отработана');
  await expect(page.getByTestId('sc-fact')).toContainText('1 ч 35 мин (вручную)');
  await expect(page.getByTestId('sc-fact-kop')).toContainText('475,00 ₽'); // 95 мин × 300 ₽/ч, порог ставки за выход 120 мин
  await expect(page.getByTestId('sc-event').first()).toContainText('Ушёл раньше, согласовано');
});

test('Директор: невыход окном с причиной, план не становится оплатой', async ({ page }) => {
  await login(page, 'director@yu.test');
  await open(page, '/shifts/sh-review');
  await expect(page.getByTestId('sc-review')).toContainText('нет отметки ухода');
  await page.getByRole('button', { name: 'Невыход' }).click();
  const dlg = page.getByTestId('sc-dialog');
  await expect(dlg.getByRole('button', { name: 'Подтвердить' })).toBeDisabled();
  await dlg.getByLabel('Причина *').fill('Не вышел, не предупредил');
  await dlg.getByRole('button', { name: 'Подтвердить' }).click();
  await expect(dlg).toBeHidden();
  await expect(page.getByTestId('sc-status')).toContainText('Невыход');
  await expect(page.getByTestId('sc-fact-kop')).toContainText('не проведено');
});

test('Директор: перенос чужой смены требует причину, отмена остаётся записью', async ({ page }) => {
  await login(page, 'director@yu.test');
  await open(page, '/shifts/sh-fresh-next');
  await page.getByRole('button', { name: 'Перенести' }).click();
  const dlg = page.getByTestId('sc-dialog');
  await expect(dlg.getByRole('button', { name: 'Подтвердить' })).toBeDisabled(); // чужая смена: причина обязательна
  await dlg.getByLabel('Начало').fill('15:00');
  await dlg.getByLabel('Конец').fill('19:00');
  await dlg.getByLabel('Причина *').fill('Сдвиг графика');
  await dlg.getByRole('button', { name: 'Подтвердить' }).click();
  await expect(dlg).toBeHidden();
  await expect(page.getByTestId('sc-plan-time')).toContainText('15:00–19:00');
  await expect(page.getByTestId('sc-event').first()).toContainText('Сдвиг графика');

  await page.getByRole('button', { name: 'Отменить смену' }).click();
  await dlg.getByLabel('Причина *').fill('Закрыты на санобработку');
  await dlg.getByRole('button', { name: 'Подтвердить' }).click();
  await expect(page.getByTestId('sc-status')).toContainText('Отменена');
  await expect(page.getByRole('button', { name: 'Отменить смену' })).toHaveCount(0);
  await expect(page.getByTestId('sc-fact-form')).toHaveCount(0);
});

test('Закрытый период: сервер не даёт менять факт, экран объясняет', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, '/shifts/sh-closed-admin');
  const form = page.getByTestId('sc-fact-form');
  await form.getByLabel('Комментарий *').fill('Попытка задним числом');
  await form.getByRole('button', { name: 'Сохранить факт' }).click();
  await expect(page.getByTestId('sc-error')).toContainText('период закрыт');
});

test('Администратор: своя смена без сумм и исправлений; чужая в зоне – без сумм; чужой филиал – 404; в истории маска', async ({ page }) => {
  await login(page, 'admin@yu.test');
  await open(page, '/shifts/sh-worked');
  await expect(page.getByTestId('shift-card')).not.toContainText('₽');
  await expect(page.getByTestId('sc-planned-kop')).toHaveCount(0);
  await expect(page.getByTestId('sc-fact-form')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Невыход' })).toHaveCount(0);
  await open(page, '/shifts/sh-past');
  await expect(page.getByTestId('sc-history')).not.toContainText('1 200');
  await expect(page.getByTestId('sc-event').last()).toContainText('сумма скрыта');
  expect((await page.goto('/shifts/sh-tsk'))?.status()).toBe(404);
  expect((await page.request.post('/api/crm/v1/shifts/sh-past/attendance', { data: { rowVersion: 1, status: 'no_show', reason: 'x' }, headers: key() })).status()).toBe(403);
});

test('Директор: смена другого города – 404', async ({ page }) => {
  await login(page, 'director@yu.test');
  expect((await page.goto('/shifts/sh-tsk'))?.status()).toBe(404);
});

for (const [w, h] of [[1440, 900], [390, 844]] as const) {
  test(`снимок карточки смены ${w} px без горизонтальной прокрутки`, async ({ browser, request }) => {
    expect((await request.post(`${MOCK}/__test/reset`)).ok()).toBe(true);
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: w === 390 ? 2 : 1 });
    const page = await ctx.newPage();
    await login(page, 'director@yu.test');
    await open(page, '/shifts/sh-past');
    await expect(page.getByTestId('sc-fact-form')).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/s3-73-shift-card-${w}.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(w);
    await ctx.close();
  });
}

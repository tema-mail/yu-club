// S3-78: вложения оборудования (K19 №350): загрузка, версии без замены, «недействителен» с причиной; файл больше лимита – сообщение до
// отправки и отказ сервера; чужой тип – отказ по сигнатуре; скачивание через прокси – как вложение (заголовки API не теряются).
import { expect, test, type Page } from '@playwright/test';
import { MOCK_PASSWORD } from './mock-api.ts';

const QUEST = 'e0000000-0000-4000-8000-000000000001';
const WRITTEN_OFF = 'e0000000-0000-4000-8000-000000000005';
const TOMSK = 'e0000000-0000-4000-8000-000000000007';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const SHOTS = process.env.CRM_SHOTS;

test.beforeEach(async ({ request }) => {
  await request.post(`${process.env.MOCK_URL ?? 'http://127.0.0.1:4012'}/__test/reset`);
});
async function login(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Почта').fill(email);
  await page.getByLabel('Пароль', { exact: true }).fill(MOCK_PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).not.toHaveURL(/\/login/);
}
async function docs(page: Page, id: string) {
  await page.goto(`/equipment/${id}`);
  await page.waitForLoadState('load');
  await expect(page.locator('astro-island[ssr]')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Документы' }).click();
}
const file = (page: Page) => page.getByLabel('Файл (JPG, PNG, PDF, до 10 МБ)');

test('загрузка, новая версия не заменяет, «недействителен» с причиной, скачивание как вложение', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, 'admin@yu.test');
  await docs(page, QUEST);
  await file(page).setInputFiles({ name: 'чек.png', mimeType: 'image/png', buffer: PNG });
  await page.getByLabel('Тип документа').selectOption('check');
  await page.getByRole('button', { name: 'Загрузить', exact: true }).click();
  await expect(page.getByTestId('att-notice')).toContainText('загружен');
  await expect(page.getByTestId('att-row')).toHaveCount(1);
  await expect(page.getByTestId('att-row')).toContainText('чек.png');

  await page.getByRole('button', { name: 'Загрузить новую версию' }).click();
  await expect(page.getByTestId('att-version-of')).toContainText('не заменяется');
  await file(page).setInputFiles({ name: 'чек-2.png', mimeType: 'image/png', buffer: PNG });
  await page.getByRole('button', { name: 'Загрузить', exact: true }).click();
  await expect(page.getByTestId('att-row')).toHaveCount(2);
  await expect(page.getByTestId('att-list')).toContainText('есть новая версия');
  await expect(page.getByTestId('att-list')).toContainText('чек.png');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/attachments-390.png`, fullPage: true });

  const old = page.getByTestId('att-row').filter({ hasText: 'чек-2.png' });
  await old.getByRole('button', { name: 'Недействителен…' }).click();
  const dlg = page.getByRole('dialog');
  await expect(dlg).toContainText('Документы не удаляются');
  await dlg.getByRole('button', { name: 'Отметить' }).click();
  await expect(dlg.getByRole('alert')).toContainText('причину');
  await dlg.getByLabel('Причина *').fill('Не тот чек');
  await dlg.getByRole('button', { name: 'Отметить' }).click();
  await expect(old).toContainText('Недействителен: Не тот чек');
  await expect(page.getByTestId('att-row')).toHaveCount(2);

  const href = await old.getByRole('link').getAttribute('href');
  const res = await page.request.get(href!);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-disposition']).toContain('attachment');
  expect(res.headers()['x-content-type-options']).toBe('nosniff');
  expect((await res.body()).equals(PNG)).toBe(true);
});

test('файл больше лимита – сообщение до отправки и отказ сервера; чужой тип – отказ', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await docs(page, QUEST);
  const posts: string[] = [];
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/attachments')) posts.push(r.url()); });
  await file(page).setInputFiles({ name: 'большой.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(10_485_761, 0x25) });
  await expect(page.getByTestId('att-error')).toContainText('больше лимита');
  await page.getByRole('button', { name: 'Загрузить', exact: true }).click();
  await expect(page.getByTestId('att-error')).toContainText('больше лимита');
  expect(posts).toEqual([]);

  const server = await page.evaluate(async (id) => {
    const body = new Uint8Array(10_485_761);
    body.set([0x25, 0x50, 0x44, 0x46]);
    const r = await fetch(`/api/crm/v1/attachments?ownerType=equipment&ownerId=${id}&docType=act`, { method: 'POST', headers: { 'content-type': 'application/pdf', 'idempotency-key': crypto.randomUUID() }, body });
    return { status: r.status, code: (await r.json()).error.code };
  }, QUEST);
  expect(server).toEqual({ status: 413, code: 'ATTACHMENT_TOO_LARGE' });

  await file(page).setInputFiles({ name: 'письмо.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await expect(page.getByTestId('att-error')).toContainText('только JPG, PNG или PDF');
  await file(page).setInputFiles({ name: 'поддельный.png', mimeType: 'image/png', buffer: Buffer.from('not an image') });
  await page.getByRole('button', { name: 'Загрузить', exact: true }).click();
  await expect(page.getByTestId('att-error')).toContainText('Разрешены только JPG, PNG и PDF');
  await expect(page.getByTestId('att-row')).toHaveCount(0);
});

test('списанное принимает документы; чужой объект – 404', async ({ page }) => {
  await login(page, 'admin@yu.test');
  await docs(page, WRITTEN_OFF);
  await file(page).setInputFiles({ name: 'акт.png', mimeType: 'image/png', buffer: PNG });
  await page.getByRole('button', { name: 'Загрузить', exact: true }).click();
  await expect(page.getByTestId('att-row')).toContainText('акт.png');
  const status = await page.evaluate(async (id) => (await fetch(`/api/crm/v1/attachments?ownerType=equipment&ownerId=${id}`)).status, TOMSK);
  expect(status).toBe(404);
});

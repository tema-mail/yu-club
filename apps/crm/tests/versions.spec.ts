// S4-88: история версий со сравнением полей, откат с причиной (новая версия), окно предпросмотра 390/1440 из редактора (K22 §3, §11).
// Предпросмотр – страница CRM, не публичный адрес; кадры – <iframe srcdoc sandbox=""> без allow-same-origin и allow-scripts: скрипт черновика
// не выполняется, кука и API CRM ему недоступны. Фальшивый «сайт» внутренней сети – сервер в этом файле.
import { expect, test, type Page } from '../../../tests/support/e2e.ts';
import { createServer, type Server } from 'node:http';
import { PREVIEW_SECRET, SITE_PORT } from '../playwright.config.ts';
import { CONTENT_IDS } from './mock-content.ts';
import { MOCK_PASSWORD } from './mock-api.ts';

const SHOTS = process.env.CRM_SHOTS;
const PAGE = `<!doctype html><html><head><title>Черновик</title></head><body><p role="status">Черновик – не опубликовано</p><h1>Открыли сезон турниров 2026</h1>
<script>parent.document.title = 'ВЗЛОМ'; fetch('/api/crm/v1/me').then(() => parent.postMessage('api', '*')); document.body.innerHTML = 'ВЗЛОМ';</script></body></html>`;
let site: Server;
const tokens: string[] = [];

test.beforeAll(async () => {
  site = createServer((req, res) => {
    const m = /^\/preview\/([^/]+)\/$/.exec(req.url ?? '');
    if (m && req.headers['x-preview-secret'] === PREVIEW_SECRET) {
      tokens.push(m[1]!);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => site.listen(SITE_PORT, '127.0.0.1', resolve));
});
test.afterAll(async () => {
  await new Promise((resolve) => site.close(resolve));
});
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
async function open(page: Page, url: string) {
  await page.goto(url);
  await page.waitForLoadState('load');
  await expect(page.locator('astro-island[ssr]')).toHaveCount(0);
}

test('сравнение версий по полям и откат с причиной – новая версия', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, `/content/publications/${CONTENT_IDS.pubNetwork}`);
  const v = page.getByTestId('versions');
  await expect(v.getByTestId('version-list').locator('li')).toHaveCount(2);
  await expect(v.getByTestId('version-2')).toContainText('Версия 2 – на сайте');
  await expect(v.getByTestId('version-2')).toContainText('Причина: Уточнили год');
  await v.getByLabel('Сравнить версию').selectOption({ label: 'Версия 1' });
  await v.getByLabel('С версией или черновиком').selectOption({ label: 'Версия 2' });
  const diff = v.getByTestId('version-diff');
  await expect(diff.locator('tr[data-field="title"]')).toHaveAttribute('data-changed', 'true');
  await expect(diff.locator('tr[data-field="title"]')).toContainText('Открыли сезон турниров 2026');
  await expect(diff.locator('tr[data-field="slug"]')).not.toHaveAttribute('data-changed', 'true');
  await v.getByTestId('version-1').getByRole('button', { name: 'Откатить к этой версии…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Откатить к версии 1?' });
  await dlg.getByRole('button', { name: 'Откатить' }).click();
  await expect(dlg.getByText('Укажите причину отката')).toBeVisible();
  await dlg.getByLabel('Причина').fill('Год в заголовке – ошибка');
  await dlg.getByRole('button', { name: 'Откатить' }).click();
  await expect(v.getByRole('status')).toContainText('Откат выполнен: опубликована версия 3 с содержимым версии 1.');
  await page.waitForLoadState('load');
  await expect(page.getByTestId('version-3')).toContainText('откат к версии 1');
  await expect(page.getByTestId('version-3')).toContainText('Причина: Год в заголовке – ошибка');
  await expect(page.getByTestId('version-3')).toContainText('на сайте');
  await expect(page.getByLabel('Заголовок')).toHaveValue('Открыли сезон турниров');
  await expect(page.getByTestId('version-list').locator('li')).toHaveCount(3); // старые версии на месте
});

test('Администратор: история видна, отката нет', async ({ page }) => {
  await login(page, 'admin@yu.test');
  await open(page, `/content/publications/${CONTENT_IDS.pubNetwork}`);
  await expect(page.getByTestId('version-list').locator('li')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Откатить к этой версии…' })).toHaveCount(0);
});

test('предпросмотр из редактора: страница CRM, 390 и 1440, sandbox без allow-*, скрипт и API CRM недоступны', async ({ page, baseURL }) => {
  await login(page, 'owner@yu.test');
  await open(page, `/content/publications/${CONTENT_IDS.pubNetwork}`);
  const [popup] = await Promise.all([page.waitForEvent('popup'), page.getByRole('button', { name: 'Открыть предпросмотр' }).click()]);
  await popup.waitForLoadState('load');
  const url = new URL(popup.url());
  expect(url.origin).toBe(new URL(baseURL!).origin); // не публичный адрес сайта
  expect(url.pathname).toMatch(/^\/content\/preview\/[^/]+$/);
  const payload = JSON.parse(Buffer.from(url.pathname.split('/').pop()!.split('.')[0]!, 'base64url').toString()) as { entityId: string; staffId: string };
  expect(payload).toMatchObject({ entityId: CONTENT_IDS.pubNetwork, staffId: 's-owner' });
  expect(tokens.at(-1)).toBe(url.pathname.split('/').pop());
  const frames = popup.locator('iframe');
  await expect(frames).toHaveCount(2);
  for (const [i, w] of [[0, '390'], [1, '1440']] as const) {
    await expect(frames.nth(i)).toHaveAttribute('width', w);
    expect(await frames.nth(i).getAttribute('sandbox')).toBe('');
    await expect(popup.frameLocator('iframe').nth(i).getByRole('heading', { level: 1 })).toHaveText('Открыли сезон турниров 2026');
  }
  await expect(popup).toHaveTitle(/Предпросмотр черновика/);
  if (SHOTS) await popup.screenshot({ path: `${SHOTS}/content-preview-1440.png` });
});

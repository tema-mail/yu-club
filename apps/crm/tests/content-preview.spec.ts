// S4-43: предпросмотр в CRM (K22 §11). Фальшивый «сайт» внутренней сети – сервер в этом файле: отдаёт страницу со <script> (обход очистки на сайте).
// В CRM видна плашка «Черновик»; iframe sandbox без allow-scripts и allow-same-origin; скрипт не исполняется и не видит куку и API CRM;
// без входа – на логин; неверный токен – 404; X-Preview-Secret доходит до сайта, браузер его не видит.
import { expect, test, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { PREVIEW_SECRET, SITE_PORT } from '../playwright.config.ts';
import { MOCK_PASSWORD } from './mock-api.ts';

const PAGE = `<!doctype html><html><head><base href="http://127.0.0.1:${SITE_PORT}/"><title>Черновик</title></head><body>
<p role="status">Черновик – не опубликовано</p><h1>Заголовок черновика</h1>
<script>window.parent.postMessage('hacked', '*'); parent.document.title = 'ВЗЛОМ'; document.body.innerHTML = 'ВЗЛОМ';</script>
<img src="/nope.png" onerror="parent.document.title = 'ВЗЛОМ'">
</body></html>`;

/** Токен: для CRM важна только полезная нагрузка, подпись проверяет API. */
const tokenOf = (staffId: string) => `${Buffer.from(JSON.stringify({ staffId })).toString('base64url')}.signature`;
const GOOD = tokenOf('s-owner');
const FOREIGN = tokenOf('s-admin');
const BAD = tokenOf('s-owner').replace('.signature', '.forged');

let site: Server;
const seen: Array<{ url: string; secret: string | undefined }> = [];

test.beforeAll(async () => {
  site = createServer((req, res) => {
    seen.push({ url: req.url ?? '', secret: req.headers['x-preview-secret'] as string | undefined });
    if (req.headers['x-preview-secret'] === PREVIEW_SECRET && req.url === `/preview/${GOOD}/`) {
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

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Почта').fill('owner@yu.test');
  await page.getByLabel('Пароль', { exact: true }).fill(MOCK_PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();
  await page.waitForURL((u) => u.pathname !== '/login');
}

test('без входа – на страницу входа; сайт не вызывается', async ({ page }) => {
  seen.length = 0;
  await page.goto(`/content/preview/${GOOD}`);
  await expect(page).toHaveURL(/\/login/);
  expect(seen).toEqual([]);
});

test('в CRM видна плашка «Черновик» в двух ширинах; секрет ушёл на сайт и не попал в HTML; no-store', async ({ page }) => {
  await login(page);
  seen.length = 0;
  const res = await page.goto(`/content/preview/${GOOD}`);
  expect(res?.status()).toBe(200);
  expect(res?.headers()['cache-control']).toBe('no-store');
  // страницу берёт сервер CRM с секретом; прочее на этом «сайте» – запросы кадра браузера (картинка через base), секрета у них нет
  expect(seen.filter((x) => x.url.startsWith('/preview/'))).toEqual([{ url: `/preview/${GOOD}/`, secret: PREVIEW_SECRET }]);
  expect(seen.filter((x) => !x.url.startsWith('/preview/')).every((x) => x.secret === undefined)).toBe(true);
  expect(await res?.text()).not.toContain(PREVIEW_SECRET);
  const frames = page.locator('iframe');
  await expect(frames).toHaveCount(2);
  await expect(frames.nth(0)).toHaveAttribute('width', '390');
  await expect(frames.nth(1)).toHaveAttribute('width', '1440');
  for (const i of [0, 1]) {
    await expect(page.frameLocator('iframe').nth(i).getByRole('status')).toHaveText('Черновик – не опубликовано');
  }
});

test('<script> в черновике не выполняется: sandbox пустой, заголовок CRM и тело кадра целы', async ({ page }) => {
  await login(page);
  const messages: string[] = [];
  await page.exposeFunction('reportMessage', (m: string) => messages.push(m));
  await page.addInitScript(() => window.addEventListener('message', (e) => void (window as unknown as { reportMessage: (m: string) => void }).reportMessage(String(e.data))));
  await page.goto(`/content/preview/${GOOD}`);
  const frames = page.locator('iframe');
  for (const i of [0, 1]) {
    expect(await frames.nth(i).getAttribute('sandbox')).toBe('');
    await expect(page.frameLocator('iframe').nth(i).locator('h1')).toHaveText('Заголовок черновика');
  }
  await page.waitForTimeout(300);
  expect(messages).toEqual([]);
  expect(await page.title()).not.toContain('ВЗЛОМ');
  expect(await page.locator('body').innerText()).not.toContain('ВЗЛОМ');
});

test('неверный токен – 404', async ({ page }) => {
  await login(page);
  const res = await page.goto(`/content/preview/${BAD}`);
  expect(res?.status()).toBe(404);
  expect((await page.goto('/content/preview/мусор'))?.status()).toBe(404);
});

test('токен другого сотрудника – 404, сайт не вызывается', async ({ page }) => {
  await login(page);
  seen.length = 0;
  const res = await page.goto(`/content/preview/${FOREIGN}`);
  expect(res?.status()).toBe(404);
  expect(seen).toEqual([]);
});

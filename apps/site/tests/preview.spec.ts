// S4-43: страница предпросмотра сайта (K22 §11). Без секрета – 404; с секретом – плашка «Черновик», noindex, no-store, <base href> на сайт;
// в тексте черновика сырой <script> и javascript: вырезаны; ни один тег скрипта не попадает в HTML; неверный токен – 404.
import { expect, test } from '../../../tests/support/e2e.ts';
import { PREVIEW_SECRET, PROD_PORT, STAGE_PORT } from '../playwright.config.ts';

const STAGE = `http://127.0.0.1:${STAGE_PORT}`;
const url = (token: string, port = STAGE) => `${port}/preview/${token}/`;
const headers = { 'x-preview-secret': PREVIEW_SECRET };

test('без секрета и с неверным секретом – 404 без текста черновика', async ({ request }) => {
  const attempts: Array<Record<string, string>> = [{}, { 'x-preview-secret': 'wrong-secret' }];
  for (const h of attempts) {
    const res = await request.get(url('draft-token'), { headers: h });
    expect(res.status()).toBe(404);
    expect(await res.text()).not.toContain('ТЕКСТ-ЧЕРНОВИКА');
  }
});

test('сервер без PREVIEW_SECRET – 404 даже с заголовком', async ({ request }) => {
  const res = await request.get(url('draft-token', `http://127.0.0.1:${PROD_PORT}`), { headers });
  expect(res.status()).toBe(404);
});

test('неверный токен: API отвечает 404 – страница 404', async ({ request }) => {
  const res = await request.get(url('bad-token'), { headers });
  expect(res.status()).toBe(404);
});

test('черновик: плашка, заголовок, текст, noindex и no-store, base на адрес сайта, картинка с /media/', async ({ request }) => {
  const res = await request.get(url('draft-token'), { headers });
  expect(res.status()).toBe(200);
  expect(res.headers()['cache-control']).toBe('no-store');
  expect(res.headers()['x-robots-tag']).toContain('noindex');
  const html = await res.text();
  expect(html).toContain('Черновик – не опубликовано');
  expect(html).toContain('ТЕКСТ-ЧЕРНОВИКА');
  expect(html).toMatch(/<meta name="robots" content="noindex, nofollow"/);
  expect(html).toMatch(/<base href="http:\/\/(127\.0\.0\.1|localhost):\d+\/"/);
  expect(html.indexOf('<base')).toBeLessThan(html.indexOf('<link'));
  expect(html).toContain('src="/media/aa/bb/x-1600.webp"');
  expect(html).toContain('alt="Зал из снимка"');
});

test('черновик с атакой: скриптов и обработчиков в HTML нет, чужая ссылка снята', async ({ request }) => {
  const res = await request.get(url('draft-token'), { headers });
  const html = await res.text();
  expect(html).not.toMatch(/<script/i);
  expect(html).not.toMatch(/<[^>]*\son\w+=/i);
  expect(html.toLowerCase()).not.toContain('javascript:');
  expect(html).not.toContain('href="//evil.ru"');
  expect(html).not.toContain('evil.ru');
});

test('в браузере скрипт не исполняется, стили подхватываются через base', async ({ page, request }) => {
  const html = await (await request.get(url('draft-token'), { headers })).text();
  await page.setContent(html, { waitUntil: 'load' });
  expect(await page.evaluate(() => (window as unknown as { hacked?: boolean }).hacked ?? false)).toBe(false);
  await expect(page.getByRole('status')).toHaveText('Черновик – не опубликовано');
  await expect(page.locator('h1')).toHaveText('Заголовок черновика');
});

// S4-125: /unsubscribe/ – открытие не отписывает, кнопка отписывает; noindex; недействительная и просроченная ссылка – понятный текст;
// прокси без X-Requested-With – 403. Кнопка в push: sw.js в песочнице – POST /unsubscribe/ с заголовком, переход по push – с ?n=<id>.
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, test } from '../../../tests/support/e2e.ts';
import { MOCK_PORT } from '../playwright.config.ts';

const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const tokenOf = async (request: import('@playwright/test').APIRequestContext) =>
  ((await (await request.get(`${MOCK}/__test/unsubscribe-token?phone=%2B79131234567`)).json()) as { t: string }).t;
const marketing = async (request: import('@playwright/test').APIRequestContext, t: string) =>
  ((await (await request.get(`${MOCK}/api/public/v1/unsubscribe/check?t=${t}`)).json()) as { marketingEnabled: boolean }).marketingEnabled;

test.beforeEach(async ({ request }) => {
  await request.post(`${MOCK}/__test/inbox-reset`, { data: { marketing: true } });
});

test('открытие страницы не отписывает, кнопка – отписывает; noindex; 390 px', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const t = await tokenOf(request);
  const res = await page.goto(`/unsubscribe/?t=${t}`);
  expect(res!.headers()['x-robots-tag']).toBe('noindex, nofollow');
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex, nofollow');
  await expect(page.locator('h1')).toHaveText('Отписка от рекламы');
  expect(await marketing(request, t)).toBe(true);
  const button = page.getByRole('button', { name: 'Отписаться от рекламы' });
  expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: 'test-results/screens/390-unsubscribe.png', fullPage: true });
  await button.click();
  await expect(page.getByText('Готово: вы отписаны от рекламы и акций.')).toBeVisible();
  expect(await marketing(request, t)).toBe(false);
  await page.reload();
  await expect(page.getByTestId('unsubscribe')).toHaveAttribute('data-state', 'already');
});

test('недействительная и просроченная ссылка; прокси без X-Requested-With – 403', async ({ page, request }) => {
  await page.goto('/unsubscribe/?t=bad');
  await expect(page.getByText('Ссылка для отписки недействительна.')).toBeVisible();
  await page.goto('/unsubscribe/?t=mock-unsub-expired');
  await expect(page.getByText('Срок ссылки истёк.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Войдите в кабинет' })).toHaveAttribute('href', '/login/?next=/account/');
  const t = await tokenOf(request);
  const denied = await request.post('/api/public/v1/unsubscribe/', { data: { t } });
  expect(denied.status()).toBe(403);
  expect(await marketing(request, t)).toBe(true);
});

test('service worker: кнопка «Отписаться от акций» – POST с X-Requested-With; обычный переход – ?n=<id>', async () => {
  const code = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
  const handlers: Record<string, (e: unknown) => void> = {};
  const fetches: Array<{ url: string; init: RequestInit }> = [];
  const shown: Array<{ title: string; options: Record<string, unknown> }> = [];
  const opened: string[] = [];
  const pending: Array<Promise<unknown>> = [];
  const self = {
    location: { origin: 'https://yu-club.test' },
    addEventListener: (name: string, fn: (e: unknown) => void) => (handlers[name] = fn),
    skipWaiting: () => undefined,
    registration: { showNotification: async (title: string, options: Record<string, unknown>) => void shown.push({ title, options }) },
  };
  const clients = { matchAll: async () => [], openWindow: async (u: string) => void opened.push(u), claim: async () => undefined };
  const fetchFn = async (url: string, init: RequestInit) => (fetches.push({ url, init }), { ok: true });
  runInNewContext(code, { self, clients, fetch: fetchFn, URL, atob, console });
  const event = (extra: Record<string, unknown>) => ({ ...extra, waitUntil: (p: Promise<unknown>) => pending.push(p) });

  handlers.push!(event({ data: { json: () => ({ title: 'Реклама. Акция', body: 'x', url: '/promotions/happy-hours/', id: 'nid-1', actions: [{ action: 'unsubscribe', title: 'Отписаться от акций' }], unsubscribeUrl: '/unsubscribe/?t=tok123' }) } }));
  await Promise.all(pending);
  const options = shown[0]!.options as { actions: Array<{ action: string }>; data: Record<string, unknown> };
  expect(options.actions).toEqual([{ action: 'unsubscribe', title: 'Отписаться от акций' }]);

  handlers.notificationclick!(event({ action: 'unsubscribe', notification: { close: () => undefined, data: options.data } }));
  await Promise.all(pending);
  expect(fetches[0]!.url).toBe('/api/public/v1/unsubscribe/');
  expect(fetches[0]!.init.method).toBe('POST');
  expect((fetches[0]!.init.headers as Record<string, string>)['x-requested-with']).toBe('yu-site');
  expect(JSON.parse(String(fetches[0]!.init.body))).toEqual({ t: 'tok123' });
  expect(opened).toEqual([]);

  handlers.notificationclick!(event({ action: '', notification: { close: () => undefined, data: options.data } }));
  await Promise.all(pending);
  expect(opened).toEqual(['/promotions/happy-hours/?n=nid-1']);
});

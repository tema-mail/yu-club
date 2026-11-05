// Общее для e2e мероприятий и справочников Э3: вход, сброс мока, проверки правил владельца (390 без горизонтальной прокрутки, кнопки ≥ 44 px).
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { MOCK_PASSWORD } from './mock-api.ts';

export const MOCK = process.env.MOCK_URL ?? 'http://127.0.0.1:4012';
export const SHOTS = process.env.SCREENSHOT_DIR ?? 'test-results/screens';

export async function resetMock(request: APIRequestContext) {
  expect((await request.post(`${MOCK}/__test/reset`)).ok()).toBe(true);
}
export async function login(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Почта').fill(email);
  await page.getByLabel('Пароль', { exact: true }).fill(MOCK_PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).not.toHaveURL(/\/login/);
}
export async function open(page: Page, url: string) {
  await page.goto(url);
  await page.waitForLoadState('load');
  await expect(page.locator('astro-island[ssr]')).toHaveCount(0);
}
export const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
/** Видимые кнопки области меньше 44 px по высоте – пустой список, если правило соблюдено. */
export const tapTargetsOk = (page: Page, scope = '#main') =>
  page.evaluate((sel) => {
    const out: string[] = [];
    for (const b of document.querySelectorAll<HTMLElement>(`${sel} button, ${sel} a.yc-btn`)) {
      const r = b.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.height < 44) out.push(`${b.textContent?.trim() ?? ''}: ${Math.round(r.height)}`);
    }
    return out;
  }, scope);
export const key = () => ({ 'idempotency-key': crypto.randomUUID() });
/** Id мероприятия по номеру – через API страницы (та же кука). */
export async function eventIdOf(page: Page, number: string): Promise<string> {
  const r = await page.request.get('/api/crm/v1/events?limit=200');
  const body = (await r.json()) as { items: Array<{ id: string; number: string }> };
  return body.items.find((e) => e.number === number)!.id;
}
export async function openEvent(page: Page, number: string, tab?: string) {
  await open(page, `/events/${await eventIdOf(page, number)}`);
  await expect(page.getByTestId('event-number')).toHaveText(number);
  if (tab) await page.getByRole('tab', { name: tab }).click();
}

// Контракт записи через прокси сайта (S1-19a): availability – 6 состояний и шаг ресурса, удержание – общий таймер
// от серверного времени, добавление перезапускает его, чужой видит «удерживается», подтверждение без входа – AUTH_REQUIRED,
// повтор с тем же ключом – тот же ответ. Мок – tests/mock-api.ts по apps/api/src/modules/booking/routes.public.ts.
// Запросы – из браузера на localhost: куки yu_visitor / yu_client с Secure браузер принимает по http только там.
import { expect, test, type Page } from '@playwright/test';
import { MOCK_PORT, STAGE_PORT } from '../playwright.config.ts';
import { resourceId } from './mock-api.ts';

test.use({ baseURL: `http://localhost:${STAGE_PORT}` });

const KRASNY = '0b0b0000-0000-4000-8000-000000000011';
const TZ_MS = 7 * 3600_000;
const localDate = (t: number) => new Date(t + TZ_MS).toISOString().slice(0, 10);
const plusDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const at = (d: string, hhmm: string) => new Date(Date.parse(`${d}T${hhmm}:00Z`) - TZ_MS).toISOString();
const TOMORROW = plusDays(localDate(Date.now()), 1);

async function api<T = Record<string, unknown>>(page: Page, method: string, path: string, body?: unknown, key?: string) {
  return page.evaluate(
    async ({ method, path, body, key }) => {
      const headers: Record<string, string> = { accept: 'application/json' };
      if (method !== 'GET') Object.assign(headers, { 'content-type': 'application/json', 'x-requested-with': 'yu-site', 'idempotency-key': key ?? crypto.randomUUID() });
      const q = path.indexOf('?');
      const url = `/api/public/v1${q < 0 ? `${path}/` : `${path.slice(0, q)}/${path.slice(q)}`}`;
      const res = await fetch(url, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
      return { status: res.status, replay: res.headers.get('idempotent-replay'), body: (await res.json()) as unknown };
    },
    { method, path, body, key },
  ) as Promise<{ status: number; replay: string | null; body: T }>;
}

type Avail = { dayState: string; resources: Array<{ resourceId: string; slots: Array<{ start: string; end: string; state: string }> }> };
const slot = (a: Avail, code: string, hhmm: string) =>
  a.resources.find((r) => r.resourceId === resourceId(KRASNY, code))!.slots.find((s) => s.start === at(TOMORROW, hhmm));

test.beforeEach(async ({ page, request }) => {
  await request.post(`http://127.0.0.1:${MOCK_PORT}/__test/booking-reset`);
  await page.goto('/');
});

test('доступность: 6 состояний, шаг VR 15 и ПК 30, сегодня выходной, окно 30 дней', async ({ page }) => {
  const a = (await api<Avail>(page, 'GET', `/branches/${KRASNY}/availability?date=${TOMORROW}`)).body;
  expect(a.dayState).toBe('open');
  expect(slot(a, 'pc1', '10:00')?.state).toBe('booked');
  expect(slot(a, 'pc2', '10:00')?.state).toBe('held');
  expect(slot(a, 'pc3', '10:00')?.state).toBe('blocked');
  expect(slot(a, 'pc5', '20:00')?.state).toBe('closed');
  expect(slot(a, 'pc4', '10:00')?.state).toBe('free');
  const vr = slot(a, 'vr1', '10:00')!;
  expect(Date.parse(vr.end) - Date.parse(vr.start)).toBe(15 * 60_000);
  const pc = slot(a, 'pc4', '10:00')!;
  expect(Date.parse(pc.end) - Date.parse(pc.start)).toBe(30 * 60_000);

  await api(page, 'POST', '/holds', { branchId: KRASNY, items: [{ resourceId: resourceId(KRASNY, 'pc4'), start: at(TOMORROW, '12:00'), end: at(TOMORROW, '12:30') }] });
  const b = (await api<Avail>(page, 'GET', `/branches/${KRASNY}/availability?date=${TOMORROW}`)).body;
  expect(slot(b, 'pc4', '12:00')?.state).toBe('mine');

  expect((await api<Avail>(page, 'GET', `/branches/${KRASNY}/availability?date=${localDate(Date.now())}`)).body.dayState).toBe('closed');
  expect((await api<Avail>(page, 'GET', `/branches/${KRASNY}/availability?date=${plusDays(localDate(Date.now()), 30)}`)).body.dayState).toBe('outside_window');
});

test('удержание: таймер от сервера, добавление перезапускает, чужой видит «удерживается», подтверждение без входа – 401', async ({ page, browser }) => {
  const item = (code: string, hhmm: string, end: string) => ({ resourceId: resourceId(KRASNY, code), start: at(TOMORROW, hhmm), end: at(TOMORROW, end) });
  // Без куки yu_visitor (её ставит availability) удержание не создать – как в API.
  expect((await api(page, 'POST', '/holds', { branchId: KRASNY, items: [item('pc4', '13:00', '13:30')] })).body).toMatchObject({ error: { code: 'VISITOR_REQUIRED' } });
  await api(page, 'GET', `/branches/${KRASNY}/availability?date=${TOMORROW}`);
  const created = await api<{ id: string; expiresAt: string; serverNow: string; items: unknown[]; totalKop: number; owner: string }>(page, 'POST', '/holds', { branchId: KRASNY, items: [item('pc4', '13:00', '13:30')] });
  expect(created.status).toBe(201);
  const h = created.body;
  expect(Date.parse(h.expiresAt) - Date.parse(h.serverNow)).toBe(15 * 60_000);
  expect(h.owner).toBe('visitor');
  expect(h.totalKop).toBe(15_000);

  const again = await api(page, 'POST', '/holds', { branchId: KRASNY, items: [item('pc4', '15:00', '15:30')] });
  expect(again.body).toMatchObject({ error: { code: 'HOLD_ALREADY_ACTIVE', details: { holdId: h.id } } });

  await page.waitForTimeout(1100);
  const added = await api<{ expiresAt: string; items: unknown[] }>(page, 'POST', `/holds/${h.id}/items`, item('pc4', '13:30', '14:00'));
  expect(added.status).toBe(200);
  expect(Date.parse(added.body.expiresAt)).toBeGreaterThan(Date.parse(h.expiresAt));
  expect(added.body.items).toHaveLength(2);

  const taken = await api(page, 'POST', `/holds/${h.id}/items`, item('pc1', '10:00', '10:30'));
  expect(taken.body).toMatchObject({ error: { code: 'SLOT_TAKEN' } });
  expect((await api(page, 'POST', `/holds/${h.id}/items`, item('pc3', '10:00', '10:30'))).body).toMatchObject({ error: { code: 'RESOURCE_BLOCKED' } });
  expect((await api(page, 'POST', `/holds/${h.id}/items`, item('pc5', '20:00', '20:30'))).body).toMatchObject({ error: { code: 'OUTSIDE_SCHEDULE' } });

  const other = await browser.newPage({ baseURL: `http://localhost:${STAGE_PORT}` });
  await other.goto('/');
  const seen = (await api<Avail>(other, 'GET', `/branches/${KRASNY}/availability?date=${TOMORROW}`)).body;
  expect(slot(seen, 'pc4', '13:00')?.state).toBe('held');
  expect((await api(other, 'POST', '/holds', { branchId: KRASNY, items: [item('pc4', '13:00', '13:30')] })).body).toMatchObject({ error: { code: 'SLOT_HELD' } });
  await other.close();

  const key = crypto.randomUUID();
  const confirm = await api(page, 'POST', `/holds/${h.id}/confirm`, {}, key);
  expect(confirm.status).toBe(401);
  expect(confirm.body).toMatchObject({ error: { code: 'AUTH_REQUIRED' } });

  const releaseKey = crypto.randomUUID();
  const released = await api<{ status: string; items: unknown[] }>(page, 'POST', `/holds/${h.id}/release`, {}, releaseKey);
  expect(released.body).toMatchObject({ status: 'released', items: [] });
  const replay = await api(page, 'POST', `/holds/${h.id}/release`, {}, releaseKey);
  expect(replay.replay).toBe('true');
  expect(replay.body).toEqual(released.body);
});

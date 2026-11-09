// Э3 на живом стенде (S3-97): экраны CRM смен, зарплаты, оборудования, ремонта, мероприятий и справочников против настоящего API.
// До S3-97 эти экраны проверялись только на моке (apps/crm/tests/mock-*.ts) – здесь ловим расхождения мока и API на данных засева
// db/seed/club.ts (S3-96): любой ответ /api/crm/v1 с кодом ≥ 400 во время обхода экранов – провал, острова ожили, ошибок на экране нет.
//  1. Владелец и демо-Директор обходят списки и первую карточку каждого раздела;
//  2. демо-Директор создаёт мероприятие формой и видит его в API; уборка – отмена с причиной в afterAll;
//  3. открытый демо-ремонт: «Показать затронутых» отвечает без ошибок, ничего не блокирует (TC-12: предложение, не действие).
import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page, type Response } from '@playwright/test';
import { CRM_URL, DEMO_DIRECTOR, OWNER, crmApi, crmLogin, hydrated } from './stand.ts';

test.describe.configure({ mode: 'serial' });

const API = '/api/crm/v1';
const created: string[] = [];
let director: APIRequestContext;

test.beforeAll(async () => {
  director = await crmApi(DEMO_DIRECTOR.email, DEMO_DIRECTOR.password());
});
test.afterAll(async () => {
  for (const id of created) {
    const card = await director.get(`${API}/events/${id}`);
    if (!card.ok()) continue;
    const { rowVersion, status } = (await card.json()) as { rowVersion: number; status: string };
    if (['cancelled', 'completed', 'not_held'].includes(status)) continue;
    await director.post(`${API}/events/${id}/status`, { headers: { 'idempotency-key': randomUUID() }, data: { rowVersion, to: 'cancelled', reason: 'e2e: уборка' } });
  }
  await director.dispose();
});

/** Ответы API с ошибкой за время fn (кроме ожидаемых кодов). */
async function apiErrors(page: Page, fn: () => Promise<void>): Promise<string[]> {
  const bad: string[] = [];
  const onResponse = (r: Response) => {
    if (r.url().includes(API) && r.status() >= 400) bad.push(`${r.request().method()} ${new URL(r.url()).pathname} → ${r.status()}`);
  };
  page.on('response', onResponse);
  try {
    await fn();
  } finally {
    page.off('response', onResponse);
  }
  return bad;
}

async function visit(page: Page, path: string): Promise<void> {
  const res = await page.goto(`${CRM_URL}${path}`);
  expect(res?.status(), path).toBeLessThan(400);
  await hydrated(page);
  await page.waitForLoadState('networkidle');
  // считаются только видимые сообщения с текстом: пустые служебные блоки role="alert" лежат в разметке заранее
  const shown = page.locator('main [role="alert"]:visible').filter({ hasText: /\S/ });
  await expect(shown, `${path}: ${(await shown.allInnerTexts()).join(' | ')}`).toHaveCount(0);
}

/** Первые карточки разделов – по данным API этого же сотрудника. */
async function firstIds(api: APIRequestContext): Promise<Record<string, string | undefined>> {
  const first = async (url: string) => (((await (await api.get(`${API}${url}`)).json()) as { items?: Array<{ id: string }> }).items ?? [])[0]?.id;
  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  return {
    equipment: await first('/equipment?limit=20'),
    repair: await first('/repairs?limit=20'),
    event: await first('/events?limit=20'),
    shift: await first(`/shifts?from=${weekAgo}&to=${today}`),
    staff: await first('/staff?limit=20'),
  };
}

const LISTS = ['/shifts', '/equipment', '/repairs', '/events', '/staff', '/dictionaries/holidays', '/dictionaries/equipment-categories', '/dictionaries/event-types', '/dictionaries/event-packages', '/dictionaries/repair-executors'];

for (const who of ['owner', 'director'] as const) {
  test(`${who === 'owner' ? 'Владелец' : 'Директор'}: экраны Э3 на настоящем API – ни одного ответа ≥ 400`, async ({ page }) => {
    const creds = who === 'owner' ? { email: OWNER.email(), password: OWNER.password() } : { email: DEMO_DIRECTOR.email, password: DEMO_DIRECTOR.password() };
    await crmLogin(page, creds.email, creds.password);
    const api = await crmApi(creds.email, creds.password);
    const ids = await firstIds(api);
    await api.dispose();
    expect(ids.equipment, 'засев S3-96: оборудование').toBeTruthy();
    expect(ids.repair, 'засев S3-96: открытый ремонт').toBeTruthy();
    expect(ids.event, 'засев S3-96: праздник').toBeTruthy();
    const pages = [...LISTS, ...(who === 'owner' ? ['/payroll'] : []), `/equipment/${ids.equipment}`, `/repairs/${ids.repair}`, `/events/${ids.event}`, ...(ids.shift ? [`/shifts/${ids.shift}`] : []), ...(ids.staff ? [`/staff/${ids.staff}`] : [])];
    const bad = await apiErrors(page, async () => {
      for (const path of pages) await visit(page, path);
    });
    expect(bad).toEqual([]);
  });
}

test('Директор: новое мероприятие формой CRM – создано в API с заказчиком и гостями', async ({ page }) => {
  await crmLogin(page, DEMO_DIRECTOR.email, DEMO_DIRECTOR.password());
  const name = `E2E ${randomUUID().slice(0, 8)}`;
  const bad = await apiErrors(page, async () => {
    await visit(page, '/events');
    await page.getByRole('button', { name: 'Новое мероприятие' }).click();
    const form = page.getByTestId('event-form');
    await form.getByLabel('Тип').selectOption({ label: 'Платный праздник' });
    await form.getByLabel('Заказчик: имя').fill(name);
    await form.getByLabel('Заказчик: телефон').fill('+7 913 555-66-77');
    await form.getByLabel(/Гостей/).fill('6');
    await form.getByRole('button', { name: 'Создать' }).click();
    await expect(page).toHaveURL(/\/events\/[0-9a-f-]{36}$/);
    await hydrated(page);
  });
  expect(bad).toEqual([]);
  const id = page.url().split('/').at(-1)!;
  created.push(id);
  const card = (await (await director.get(`${API}/events/${id}`)).json()) as { status: string; customer: { name: string }; party: { guests: number } | null };
  expect(card).toMatchObject({ status: 'new_request', customer: { name }, party: { guests: 6 } });
});

test('TC-12 на экране: предложение блокировки открытого демо-ремонта – без ошибок API и без блокировки', async ({ page }) => {
  await crmLogin(page, DEMO_DIRECTOR.email, DEMO_DIRECTOR.password());
  const repairs = (await (await director.get(`${API}/repairs?limit=20`)).json()) as { items: Array<{ id: string; status: string }> };
  const open = repairs.items.find((r) => !['closed', 'cancelled'].includes(r.status));
  expect(open, 'засев S3-96: открытый ремонт').toBeTruthy();
  const before = ((await (await director.get(`${API}/repairs/${open!.id}`)).json()) as { blocks: unknown[] }).blocks.length;
  const bad = await apiErrors(page, async () => {
    await visit(page, `/repairs/${open!.id}`);
    const panel = page.getByTestId('rp-block-panel');
    if (await panel.count()) {
      const end = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
      await panel.getByLabel('По', { exact: true }).fill(`${end}T12:00`);
      // список «Брони – требуют решения» есть, только если брони попали в период; проверяем сам ответ API
      const proposal = page.waitForResponse((r) => r.url().includes(`/repairs/${open!.id}/block-proposal`));
      await page.getByRole('button', { name: 'Показать затронутых' }).click();
      expect((await proposal).status()).toBe(200);
    }
  });
  expect(bad).toEqual([]);
  const after = ((await (await director.get(`${API}/repairs/${open!.id}`)).json()) as { blocks: unknown[] }).blocks.length;
  expect(after).toBe(before);
});

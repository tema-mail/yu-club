// S3-85: подарок имениннику. Приёмка: условия дословно; выходные и праздники не предлагаются; подарок не в блоке сертификатов. Отмена – окном внутри записи.
import { expect, test } from '@playwright/test';
import { eventIdOf, key, login, noHorizontalScroll, open, openEvent, resetMock, SHOTS, tapTargetsOk } from './event-helpers.ts';
import { MOCK } from './event-helpers.ts';

test.describe.configure({ mode: 'serial' });
test.beforeAll(async ({ request }) => resetMock(request));
test.afterAll(async ({ request }) => { await request.post(`${MOCK}/__test/reset`); });

const API = '/api/crm/v1';
const C1 = 'c0000000-0000-4000-8000-000000000001';
const C2 = 'c0000000-0000-4000-8000-000000000002';
const TERMS = ['2 устройства Meta Quest 3S', 'По 30 минут на каждое устройство', 'Суммарная продолжительность использования комнаты – 40 минут с учётом подготовки', 'Срок действия – 60 дней', 'Посещение по предварительной записи', 'Доступность с понедельника по пятницу, кроме праздничных дней', 'PS4, PS VR и еда в подарок не входят'];

test('Без основания выдачи нет: подтверждённый день рождения – кнопки нет, сервер отклоняет', async ({ page }) => {
  await login(page, 'admin@yu.test');
  await openEvent(page, 'EV-000124', 'Подарки');
  await expect(page.getByTestId('gift-block')).toContainText('когда мероприятие идёт или завершено');
  await expect(page.getByRole('button', { name: 'Выдать подарок…' })).toHaveCount(0);
  const r = await page.request.post(`${API}/gifts`, { headers: key(), data: { clientId: C1, basisEventId: await eventIdOf(page, 'EV-000124') } });
  expect((await r.json()).error.code).toBe('GIFT_BASIS_INVALID');
});

test('Выдача из карточки, условия дословно; запись: будни без праздников; второй подарок – отказ', async ({ page }) => {
  await login(page, 'admin@yu.test');
  await openEvent(page, 'EV-000127', 'Подарки');
  await page.getByRole('button', { name: 'Выдать подарок…' }).click();
  await expect(page.getByTestId('gift-issue')).toContainText('Срок действия – 60 дней');
  await page.getByTestId('gift-issue').getByRole('button', { name: 'Выдать' }).click();
  const gift = page.getByTestId('gift-GF-000041');
  await expect(gift.getByTestId('gift-status')).toHaveText('Выдан');
  await expect(gift.getByTestId('gift-terms').locator('li')).toHaveText(TERMS);
  await expect(gift).not.toContainText('₽'); // без номинала
  await page.screenshot({ path: `${SHOTS}/event-gift-1440.png`, fullPage: true });
  await expect(page.getByRole('button', { name: 'Выдать подарок…' })).toHaveCount(0);
  await expect(gift.getByRole('button', { name: 'Отменить…' })).toHaveCount(0); // отмена – только Владелец
  const again = await page.request.post(`${API}/gifts`, { headers: key(), data: { clientId: C2, basisEventId: await eventIdOf(page, 'EV-000127') } });
  expect((await again.json()).error.code).toBe('GIFT_ALREADY_ISSUED');

  await gift.getByRole('button', { name: 'Записать…' }).click();
  const d = page.getByTestId('gift-book');
  const days = d.getByTestId('gift-days').locator('option');
  await expect(days.nth(1)).toBeAttached();
  const values = (await days.evaluateAll((o) => o.map((x) => (x as HTMLOptionElement).value))).filter(Boolean);
  const holidays = ((await (await page.request.get(`${API}/holidays?cityId=c-nsk`)).json()) as { items: Array<{ date: string; name: string }> }).items;
  expect(holidays.length).toBeGreaterThan(0);
  for (const v of values) {
    expect([0, 6]).not.toContain(new Date(`${v}T00:00:00Z`).getUTCDay());
    expect(holidays.map((h) => h.date)).not.toContain(v);
  }
  // Сервер закрывает праздник, даже если подделать день
  const giftRow = ((await (await page.request.get(`${API}/gifts?clientId=${C2}`)).json()) as { items: Array<{ id: string }> }).items[0]!;
  const holiday = holidays[0]!.date;
  const slots = await (await page.request.get(`${API}/gifts/${giftRow.id}/slots?branchId=b-nsk-krasny&date=${holiday}`)).json();
  expect(slots.closedReason).toBe('GIFT_HOLIDAY');
  const booked = await page.request.post(`${API}/gifts/${giftRow.id}/book`, { headers: key(), data: { branchId: 'b-nsk-krasny', start: `${holiday}T07:00:00.000Z` } });
  expect((await booked.json()).error.code).toBe('GIFT_HOLIDAY');

  await d.getByTestId('gift-days').selectOption(values[1]!);
  const slot = d.getByTestId('gift-slots').getByRole('button').first();
  await expect(slot).toContainText(/\d\d:\d\d–\d\d:\d\d/);
  await d.getByRole('button', { name: 'Записать', exact: true }).click();
  await expect(d.getByRole('alert')).toContainText('Выберите время');
  await slot.click();
  await d.getByRole('button', { name: 'Записать', exact: true }).click();
  await expect(page.getByTestId('gift-notice')).toContainText('бронь создана');
  await expect(gift.getByTestId('gift-status')).toHaveText('Есть запись');
  await expect(gift.getByTestId('gift-booking')).toBeVisible();
});

test('Карточка клиента: свой блок подарка, не среди сертификатов; Владелец – выдача без мероприятия и отмена окном с причиной; 390', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, `/clients/${C2}`);
  const block = page.getByTestId('client-gifts');
  await expect(block.getByRole('heading', { name: 'Подарок имениннику' })).toBeVisible();
  await expect(block.getByTestId('gift-GF-000041')).toContainText('GF-000041');
  await expect(block).toContainText('Это не сертификат');
  expect(await (await page.request.get(`${API}/certificates?limit=100`)).text()).not.toContain('GF-');

  await open(page, `/clients/${C1}`);
  await expect(block.getByTestId('gift-empty')).toBeVisible();
  await block.getByRole('button', { name: 'Выдать без мероприятия…' }).click();
  const m = page.getByTestId('gift-issue-manual');
  await m.getByRole('button', { name: 'Выдать' }).click();
  await expect(m.getByRole('alert')).toContainText('причину');
  await m.getByLabel('Причина').fill('Сбой на дне рождения, компенсация');
  await m.getByRole('button', { name: 'Выдать' }).click();
  const g = block.getByTestId('gift-GF-000042');
  await expect(g.getByTestId('gift-status')).toHaveText('Выдан');
  await g.getByRole('button', { name: 'Отменить…' }).click();
  const c = page.getByTestId('gift-cancel');
  await c.getByLabel('Причина').fill('Выдан по ошибке');
  await c.getByRole('button', { name: 'Отменить подарок' }).click();
  await expect(g.getByTestId('gift-status')).toHaveText('Отменён');
  await expect(g).toContainText('Причина отмены: Выдан по ошибке');

  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, `/clients/${C2}`);
  expect(await noHorizontalScroll(page)).toBe(true);
  expect(await tapTargetsOk(page, '[data-testid="client-gifts"]')).toEqual([]);
  await block.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/client-gift-390.png`, fullPage: true });
});

test('Администратор не выдаёт вручную; новое мероприятие из карточки клиента – с выбранным профилем', async ({ page }) => {
  await login(page, 'admin@yu.test');
  await open(page, `/clients/${C2}`);
  await expect(page.getByRole('button', { name: 'Выдать без мероприятия…' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Новое мероприятие для клиента' }).click();
  await expect(page.locator('astro-island[ssr]')).toHaveCount(0);
  const form = page.getByTestId('event-form');
  await expect(form).toBeVisible();
  await expect(form.getByTestId('pick-customer').getByRole('link')).toBeVisible();
});

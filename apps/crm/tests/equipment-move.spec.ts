// S3-77: перемещение с предупреждением о бронях и мероприятиях; без галочки «беру решение» перемещения нет. Учётки PS/VR: только
// идентификатор и где взять доступ, поля пароля нет, сервер отвергает лишнее; переназначение закрывает связь. Постановка на учёт и правка.
import { expect, test, type Page } from '../../../tests/support/e2e.ts';
import { MOCK_PASSWORD } from './mock-api.ts';

const QUEST = 'e0000000-0000-4000-8000-000000000001';
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
async function open(page: Page, url: string) {
  await page.goto(url);
  await page.waitForLoadState('load');
  await expect(page.locator('astro-island[ssr]')).toHaveCount(0);
}
const noScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test('список затронутых до подтверждения; без галочки перемещения нет; с галочкой брони целы', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, `/equipment/${QUEST}`);
  await page.getByRole('tab', { name: 'Размещение' }).click();
  await page.getByRole('button', { name: 'Переместить…' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByRole('button', { name: 'Переместить', exact: true }).click();
  await expect(dlg.getByRole('alert')).toContainText('причину');
  await dlg.getByLabel('Причина *').fill('Нужен в зале');
  await dlg.getByLabel('Комната').selectOption({ label: 'Общий зал' });
  const moves: string[] = [];
  page.on('request', (r) => { if (r.url().endsWith('/move')) moves.push(r.postData() ?? ''); });
  await dlg.getByRole('button', { name: 'Переместить', exact: true }).click();

  await expect(page.getByTestId('move-conflict')).toBeVisible();
  await expect(page.getByTestId('move-bookings')).toContainText('VR-комната целиком');
  await expect(page.getByTestId('move-events')).toContainText('мероприятий: 1');
  // K19 §8: мероприятие – ссылкой на карточку, не текстом
  await expect(page.getByTestId('move-events').getByRole('link')).toHaveAttribute('href', /^\/events\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('eq-place')).toContainText('VR1');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/equipment-move-conflict.png` });

  await dlg.getByRole('button', { name: 'Переместить с подтверждением' }).click();
  await expect(dlg.getByRole('alert')).toContainText('берёте решение');
  expect(moves).toHaveLength(1);
  await dlg.getByLabel('Видел список, беру решение на себя').check();
  await dlg.getByRole('button', { name: 'Переместить с подтверждением' }).click();
  await expect(page.getByTestId('eq-place')).toContainText('Общий зал');
  expect(moves).toHaveLength(2);
  expect(JSON.parse(moves[0]!).acknowledgeBookings).toBeUndefined();
  expect(JSON.parse(moves[1]!).acknowledgeBookings).toBe(true);
  await expect(page.getByTestId('eq-proposal')).toBeVisible();
  await expect(page.getByTestId('eq-placements')).toContainText('Нужен в зале');
  await expect(page.getByTestId('eq-placements')).toContainText('Постановка на учёт');
  const booking = await page.evaluate(async () => (await fetch('/api/crm/v1/bookings/bk-vrroom')).json());
  expect(booking.status).toBe('confirmed');
});

test('Администратор не перемещает; чужой филиал недоступен Директору (404 сервера)', async ({ page }) => {
  await login(page, 'admin@yu.test');
  await open(page, `/equipment/${QUEST}`);
  await page.getByRole('tab', { name: 'Размещение' }).click();
  await expect(page.getByRole('button', { name: 'Переместить…' })).toHaveCount(0);
  await page.goto('/login');
  await page.context().clearCookies();
  await login(page, 'director@yu.test');
  await open(page, `/equipment/${QUEST}`);
  await page.getByRole('tab', { name: 'Размещение' }).click();
  await page.getByRole('button', { name: 'Переместить…' }).click();
  await expect(page.getByRole('dialog').locator('select').first().locator('option')).toHaveCount(2);
  const res = await page.evaluate(async (id) => {
    const r = await fetch(`/api/crm/v1/equipment/${id}/move`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify({ rowVersion: 1, to: { branchId: 'b-tsk-lenina' }, at: new Date().toISOString(), reason: 'x' }) });
    return r.status;
  }, QUEST);
  expect(res).toBe(404);
});

test('учётки: только идентификатор и где взять доступ; привязка и отвязка; пароль сервер отвергает', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, 'director@yu.test');
  await open(page, `/equipment/${QUEST}`);
  await page.getByRole('tab', { name: 'Учётные записи' }).click();
  await expect(page.getByTestId('accounts-note')).toContainText('Пароли и коды в системе не хранятся');
  await expect(page.getByTestId('eq-accounts')).toContainText('Сейф директора');
  await expect(page.getByTestId('eq-accounts-ended')).toContainText('Замена учётки');
  await page.getByRole('button', { name: 'Привязать учётную запись…' }).click();
  const dlg = page.getByRole('dialog');
  await expect(dlg.locator('input[type=password]')).toHaveCount(0);
  await dlg.getByRole('button', { name: 'Сохранить' }).click();
  await expect(dlg.getByRole('alert')).toContainText('идентификатор');
  await dlg.getByLabel('Идентификатор *').fill('psn_club_2');
  await dlg.getByLabel('Где взять доступ').fill('У директора');
  await dlg.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByTestId('account-psn_club_2')).toContainText('PlayStation');
  expect(await noScroll(page)).toBe(true);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/equipment-accounts-390.png`, fullPage: true });

  await page.getByTestId('account-psn_club_2').getByRole('button', { name: 'Отвязать…' }).click();
  await dlg.getByRole('button', { name: 'Сохранить' }).click();
  await expect(dlg.getByRole('alert')).toContainText('причину');
  await dlg.getByLabel('Причина *').fill('Заблокирована');
  await dlg.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByTestId('eq-accounts-ended')).toContainText('Заблокирована');
  const status = await page.evaluate(async (id) => (await fetch('/api/crm/v1/equipment-accounts', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify({ platform: 'meta', displayName: 'x', equipmentId: id, branchId: 'b-nsk-krasny', boundFrom: '2026-01-01', password: 'secret' }) })).status, QUEST);
  expect(status).toBe(400);
});

test('постановка на учёт и правка: дубль серийного – предупреждение; Директор не меняет серийный', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, '/equipment');
  await page.getByRole('link', { name: 'Поставить на учёт' }).click();
  await expect(page.locator('astro-island[ssr]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Поставить на учёт' }).click();
  await expect(page.getByRole('main').getByRole('alert').last()).toContainText('наименование');
  await page.getByLabel('Наименование *').fill('Шлем запасной');
  await page.getByLabel('Категория *').selectOption({ label: 'VR-шлемы' });
  await page.getByLabel('Модель').fill('Quest 3');
  await page.getByLabel('Серийный номер').fill('SN-VR-1');
  await page.getByLabel('В резерве, на складе филиала').check();
  await page.getByRole('button', { name: 'Поставить на учёт' }).click();
  await expect(page.getByTestId('eq-created')).toContainText('INV-000008');
  await expect(page.getByTestId('eq-duplicate')).toBeVisible();
  await page.getByRole('link', { name: 'Открыть карточку' }).click();
  await expect(page.getByTestId('eq-status')).toHaveText('В резерве');
  await expect(page.locator('astro-island[ssr]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Изменить…' }).click();
  await page.getByLabel('Серийный номер').fill('SN-NEW');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByTestId('eq-serial')).toHaveText('SN-NEW');
  await page.context().clearCookies();

  await login(page, 'director@yu.test');
  await open(page, `/equipment/${QUEST}`);
  await page.getByRole('button', { name: 'Изменить…' }).click();
  await expect(page.getByLabel('Серийный номер')).toHaveAttribute('readonly', '');
  await expect(page.getByTestId('eq-form')).toContainText('только Владелец');
});

// S4-95: карточка операции кассы /finance/operations/{id} (13 §6.4, K17 §14) – операция, категория, автор, остаток, откуда пришла,
// сторно с обеих сторон, связь с объектом; Администратору – нет доступа (finance.view), чужой филиал – не найдено.
import { expect, test, type Page } from '../../../tests/support/e2e.ts';
import { MOCK_PASSWORD } from './mock-api.ts';

const MOCK = process.env.MOCK_URL ?? 'http://127.0.0.1:4012';
test.beforeEach(async ({ request }) => {
  await request.post(`${MOCK}/__test/reset`);
});
async function login(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Почта').fill(email);
  await page.getByLabel('Пароль', { exact: true }).fill(MOCK_PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).not.toHaveURL(/\/login/);
}
interface Op { id: string; number: number; kind: string; comment: string | null; ref: { type: string } | null }
async function todayOps(page: Page): Promise<Op[]> {
  const r = await page.request.get('/api/crm/v1/branches/b-nsk-krasny/finance/operations');
  expect(r.status()).toBe(200);
  return ((await r.json()) as { items: Op[] }).items;
}
const card = (page: Page) => page.getByTestId('fin-op');
const row = (page: Page, name: string) => card(page).locator('dt', { hasText: name }).locator('+ dd');

test('Владелец: карточка расхода – категория, автор, способ, остаток; сторно видно с обеих сторон; возврат показывает, откуда пришёл', async ({ page }) => {
  await login(page, 'owner@yu.test');
  const ops = await todayOps(page);
  const expense = ops.find((o) => o.comment === 'Салфетки и моющее')!;
  await page.goto(`/finance/operations/${expense.id}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Операция № ${expense.number}`);
  await expect(page.getByTestId('fin-op-kind')).toHaveText('Расход');
  await expect(row(page, 'Сумма')).toContainText('− 300,00 ₽');
  await expect(row(page, 'Категория')).toHaveText('Закупки и материалы / Хозяйственные товары');
  await expect(row(page, 'Автор')).toHaveText('Анна Админова');
  await expect(row(page, 'Место и способ')).toHaveText('Наличные');
  await expect(row(page, 'Остаток после')).toContainText('₽');
  await expect(row(page, 'Состояние')).toHaveText('Проведена');
  await expect(row(page, 'Откуда пришла')).toHaveText('Внесена вручную в кассе');
  await expect(row(page, 'Связь с объектом')).toHaveText('Нет');
  await expect(card(page).getByRole('link', { name: 'Ю Клуб на Красном' })).toHaveAttribute('href', '/finance/b-nsk-krasny');

  // сторно через API кассы (№44) – карточка исходной ведёт в сторно и обратно
  const rev = await page.request.post(`/api/crm/v1/finance/operations/${expense.id}/reverse`, { headers: { 'idempotency-key': crypto.randomUUID() }, data: { reason: 'Ошиблись суммой' } });
  expect(rev.status()).toBe(201);
  const reversal = (await rev.json()) as Op;
  await page.reload();
  await expect(row(page, 'Состояние').getByRole('link', { name: `сторно № ${reversal.number}` })).toHaveAttribute('href', `/finance/operations/${reversal.id}`);
  await row(page, 'Состояние').getByRole('link').click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Операция № ${reversal.number}`);
  await expect(page.getByTestId('fin-op-kind')).toHaveText('Сторно');
  await expect(row(page, 'Комментарий')).toHaveText('Ошиблись суммой');
  await expect(row(page, 'Откуда пришла').getByRole('link', { name: `Операция № ${expense.number}` })).toHaveAttribute('href', `/finance/operations/${expense.id}`);

  const refund = ops.find((o) => o.kind === 'refund')!;
  await page.goto(`/finance/operations/${refund.id}`);
  await expect(page.getByTestId('fin-op-kind')).toHaveText('Возврат');
  await expect(row(page, 'Откуда пришла')).toHaveText('Оплата брони – возврат платежа');
  await expect(row(page, 'Место и способ')).toHaveText('Безнал · Карта');
  // телефон: карточка не шире экрана
  await page.setViewportSize({ width: 390, height: 900 });
  await page.reload();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test('Администратор – нет доступа (403), Директор другого города – не найдено (404)', async ({ page }) => {
  await login(page, 'owner@yu.test');
  const ops = await todayOps(page);
  const id = ops[0]!.id;
  const tomsk = await page.request.get('/api/crm/v1/branches/b-tsk-lenina/finance/operations');
  const tomskId = ((await tomsk.json()) as { items: Op[] }).items[0]!.id;

  await page.getByRole('button', { name: 'Выйти' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await login(page, 'admin@yu.test');
  const denied = await page.goto(`/finance/operations/${id}`);
  expect(denied?.status()).toBe(403);
  await expect(page.getByTestId('no-access')).toContainText('Карточку операции видят Владелец и Директор');

  await page.getByRole('button', { name: 'Выйти' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await login(page, 'director@yu.test');
  await page.goto(`/finance/operations/${id}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^Операция № \d+$/);
  const foreign = await page.goto(`/finance/operations/${tomskId}`);
  expect(foreign?.status()).toBe(404);
  await expect(page.getByTestId('not-found')).toBeVisible();
  expect((await page.goto('/finance/operations/not-a-uuid'))?.status()).toBe(404);
});

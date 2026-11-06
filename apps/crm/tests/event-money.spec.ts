// S3-84: деньги мероприятия. Приёмка: двойной клик – одна операция; привязка показывает только непривязанные расходы; операция – одна строка журнала кассы.
import { expect, test, type Page } from '../../../tests/support/e2e.ts';
import { eventIdOf, key, login, noHorizontalScroll, openEvent, resetMock, SHOTS, tapTargetsOk } from './event-helpers.ts';
import { MOCK } from './event-helpers.ts';

test.describe.configure({ mode: 'serial' });
test.beforeAll(async ({ request }) => resetMock(request));
test.afterAll(async ({ request }) => { await request.post(`${MOCK}/__test/reset`); });

const API = '/api/crm/v1';
const K = 'b-nsk-krasny';
async function money(page: Page, number = 'EV-000124') {
  return (await (await page.request.get(`${API}/events/${await eventIdOf(page, number)}/money`)).json()) as { summary: Record<string, number>; operations: Array<{ role: string; operation: { id: string; number: number; amountKop: number } }> };
}
const todayNsk = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Novosibirsk' }).format(new Date());
const journal = async (page: Page) => ((await (await page.request.get(`${API}/branches/${K}/finance/operations?from=${todayNsk()}&to=${todayNsk()}&limit=200`)).json()) as { items: Array<{ id: string; kind: string; ref: { type: string; id: string } | null; reversedBy: string | null }> }).items;

test('Поступление: двойной клик – одна операция, она же в журнале кассы; копейки целыми', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await openEvent(page, 'EV-000124', 'Поступления');
  await expect(page.getByTestId('event-income').locator('> li')).toHaveCount(1);
  const form = page.getByTestId('income-form');
  await form.getByRole('button', { name: 'Провести поступление' }).click();
  await expect(form.getByRole('alert')).toContainText('больше нуля');
  await form.getByLabel('Сумма, ₽').fill('1000,10');
  await form.getByRole('button', { name: 'Перевод' }).click();
  const before = (await journal(page)).length;
  await form.getByRole('button', { name: 'Провести поступление' }).dblclick();
  await expect(page.getByTestId('money-saved')).toContainText('1 000,10 ₽');
  await expect(page.getByTestId('event-income').locator('> li')).toHaveCount(2);
  const m = await money(page);
  expect(m.summary.receivedKop).toBe(600_010);
  expect((await journal(page)).length).toBe(before + 1);
  await expect(page.getByTestId('sum-received')).toHaveText('6 000,10 ₽');
  await page.screenshot({ path: `${SHOTS}/event-money-1440.png`, fullPage: true });
});

test('Возврат по поступлению: предел, сторно поступления с живым возвратом запрещено, сначала сторно возврата', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await openEvent(page, 'EV-000124', 'Поступления');
  const first = (await money(page)).operations.find((o) => o.role === 'income' && o.operation.amountKop === 500_000)!.operation;
  const row = page.getByTestId(`op-${first.number}`);
  await row.getByRole('button', { name: 'Возврат…' }).click();
  const d = page.getByTestId('refund-dialog');
  await d.getByLabel('Сумма возврата, ₽').fill('5000,01');
  await d.getByRole('button', { name: 'Провести возврат' }).click();
  await expect(d.getByRole('alert')).toContainText('не больше 5 000,00 ₽');
  await d.getByLabel('Сумма возврата, ₽').fill('500');
  await d.getByRole('button', { name: 'Провести возврат' }).click();
  await expect(d.getByRole('alert')).toContainText('причину');
  await d.getByLabel('Причина').fill('Отказ от части услуг');
  await d.getByRole('button', { name: 'Провести возврат' }).click();
  await expect(page.getByTestId('sum-refunded')).toHaveText('500,00 ₽');
  await expect(row).toContainText('Возвращено: 500,00 ₽');

  const over = await page.request.post(`${API}/events/${await eventIdOf(page, 'EV-000124')}/refund`, { headers: key(), data: { incomeOperationId: first.id, amountKop: 500_000, method: 'card', reason: 'x' } });
  expect((await over.json()).error.code).toBe('EVENT_REFUND_EXCEEDS_INCOME');

  await row.getByRole('button', { name: 'Сторно…' }).click();
  const rv = page.getByTestId('reverse-dialog');
  await rv.getByLabel('Причина сторно').fill('Ошибка ввода');
  await rv.getByRole('button', { name: 'Сторнировать' }).click();
  await expect(rv.getByRole('alert')).toContainText('сначала сторно возвратов');
  await rv.getByRole('button', { name: 'Назад' }).click();
  const refund = (await money(page)).operations.find((o) => o.role === 'refund')!.operation;
  await page.getByTestId(`op-${refund.number}`).getByRole('button', { name: 'Сторно…' }).click();
  await rv.getByLabel('Причина сторно').fill('Возврат не состоялся');
  await rv.getByRole('button', { name: 'Сторнировать' }).click();
  await expect(page.getByTestId('sum-refunded')).toHaveText('0,00 ₽');
  await expect(page.getByTestId(`op-${refund.number}`)).toHaveCount(0);
  await row.getByRole('button', { name: 'Сторно…' }).click();
  await rv.getByLabel('Причина сторно').fill('Ошибка ввода');
  await rv.getByRole('button', { name: 'Сторнировать' }).click();
  await expect(page.getByTestId('sum-received')).toHaveText('1 000,10 ₽');
  await expect(row).toHaveCount(0);
});

test('Расход из карточки – в себестоимости и журнале; привязка: только непривязанные, вторая – OPERATION_ALREADY_LINKED', async ({ page, browser }) => {
  await login(page, 'owner@yu.test');
  const cats = (await (await page.request.get(`${API}/finance/categories?kind=expense`)).json()) as { items: Array<{ id: string; name: string; children: Array<{ id: string; name: string }> }> };
  const top = cats.items.find((c) => c.name === 'Подрядчики и услуги')!;
  const sub = top.children.find((c) => c.name === 'Кейтеринг')!;
  // общий расход из журнала, ещё без мероприятия
  const general = await page.request.post(`${API}/branches/${K}/finance/expense`, { headers: key(), data: { method: 'card', amountKop: 120_000, categoryId: top.id, subcategoryId: sub.id, occurredAt: new Date().toISOString(), comment: 'Кейтеринг общим счётом' } });
  expect(general.status()).toBe(201);
  const generalOp = (await general.json()) as { id: string; number: number };

  await openEvent(page, 'EV-000124', 'Расходы и себестоимость');
  const form = page.getByTestId('expense-form');
  await form.getByLabel('Сумма, ₽').fill('2000');
  await form.getByLabel('Комментарий').fill('Аниматор, счёт 15');
  await expect(form.getByLabel(/^Категория/).locator('option', { hasText: 'Подрядчики и услуги' })).toBeAttached();
  await form.getByLabel(/^Категория/).selectOption({ label: 'Подрядчики и услуги' });
  await form.getByRole('button', { name: 'Провести расход' }).click();
  await expect(form.getByRole('alert')).toContainText('подкатегорию');
  await form.getByLabel('Подкатегория').selectOption({ label: 'Аниматор' });
  await form.getByLabel('Поставщик').fill('Праздник рядом');
  await form.getByLabel('Строка состава').selectOption({ label: 'Праздничный стол' });
  await form.getByRole('button', { name: 'Провести расход' }).dblclick();
  await expect(page.getByTestId('money-saved')).toContainText('2 000,00 ₽');
  await expect(page.getByTestId('sum-fact')).toHaveText('2 000,00 ₽');
  await expect(page.getByTestId('sum-deviation')).toHaveText('−2 400,00 ₽');
  await expect(page.getByTestId('event-expenses').locator('> li')).toHaveCount(1);
  await expect(page.getByTestId('event-expenses')).toContainText('строка: Праздничный стол');
  const eventExpense = (await money(page)).operations.find((o) => o.role === 'expense')!.operation;
  const entry = (await journal(page)).filter((o) => o.id === eventExpense.id);
  expect(entry).toHaveLength(1);
  expect(entry[0]!.ref).toEqual({ type: 'event', id: await eventIdOf(page, 'EV-000124') });

  // Привязка: расход мероприятия не предлагается, общий – да
  const link = page.getByTestId('expense-link');
  await expect(link.getByTestId(`free-${generalOp.number}`)).toBeVisible();
  await expect(link.getByTestId(`free-${eventExpense.number}`)).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/event-expenses-1440.png`, fullPage: true });
  await link.getByTestId(`free-${generalOp.number}`).getByRole('button', { name: 'Привязать…' }).click();
  const d = page.getByTestId('link-dialog');
  // пока окно открыто, расход уже привязали в другой вкладке
  const id = await eventIdOf(page, 'EV-000124');
  const other = await (await browser.newContext()).newPage();
  await login(other, 'owner@yu.test');
  expect((await other.request.post(`${API}/events/${id}/expense/link`, { headers: key(), data: { operationId: generalOp.id } })).status()).toBe(201);
  await d.getByRole('button', { name: 'Привязать' }).click();
  await expect(d.getByRole('alert')).toContainText('уже учтён');
  await d.getByRole('button', { name: 'Назад' }).click();
  const m = await money(page);
  expect(m.operations.filter((o) => o.operation.id === generalOp.id)).toHaveLength(1); // новой операции нет
  expect(m.summary.factCostKop).toBe(200_000); // по умолчанию не в себестоимости
  const elsewhere = await page.request.post(`${API}/events/${await eventIdOf(page, 'EV-000126')}/expense/link`, { headers: key(), data: { operationId: generalOp.id } });
  expect((await elsewhere.json()).error.code).toBe('OPERATION_ALREADY_LINKED');
});

test('Администратор: списка и плана нет, поступление – нет права кассы, расход – есть; 390', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, 'admin@yu.test');
  await openEvent(page, 'EV-000124', 'Поступления');
  await expect(page.getByTestId('money-hidden')).toBeVisible();
  await expect(page.getByTestId('event-income')).toHaveCount(0);
  await expect(page.getByTestId('income-form')).toHaveCount(0);
  await expect(page.getByTestId('money-no-right')).toContainText('Директор и Владелец');
  await page.getByRole('tab', { name: 'Расходы и себестоимость' }).click();
  await expect(page.getByTestId('expense-form')).toBeVisible();
  await expect(page.getByTestId('expense-link')).toHaveCount(0);
  expect(await noHorizontalScroll(page)).toBe(true);
  expect(await tapTargetsOk(page)).toEqual([]);
  await page.screenshot({ path: `${SHOTS}/event-money-390.png`, fullPage: true });
});

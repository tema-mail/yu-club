// S4-98: отчёты Э3 – «Мероприятия», «Сотрудники и смены», «Оборудование и ремонты»: открываются, показатели по разделам,
// детализация = итог; деньги сотрудников без права скрыты целиком, а не нулями; разбивки сервера – таблицами.
import { expect, test, type Page } from '../../../tests/support/e2e.ts';
import { MOCK_PASSWORD } from './mock-api.ts';

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
const P = 'from=2026-11-01&to=2026-11-10';

for (const [report, metric, sections] of [
  ['events', 'received', ['Мероприятия', 'Деньги мероприятий', 'Себестоимость и результат']],
  ['staff', 'workedShifts', ['Смены', 'Пустые интервалы', 'Деньги сотрудников']],
  ['equipment', 'incidents', ['Парк оборудования', 'Поломки и ремонт', 'Расходы на ремонт']],
] as const) {
  test(`«${report}»: разделы показателей, детализация = итог`, async ({ page }) => {
    await login(page, 'owner@yu.test');
    await open(page, `/reports/${report}?${P}`);
    await expect(page.locator('[data-testid^=section-] h2')).toHaveText([...sections]);
    const value = (await page.getByTestId(`card-${metric}`).getByTestId('value').textContent())!.trim();
    await page.getByTestId(`card-${metric}`).click();
    await expect(page.getByTestId('detail').getByTestId('detail-total')).toContainText(`Итог: ${value} – совпадает с карточкой`);
  });
}

test('деньги сотрудников без права скрыты разделом, в таблице точных значений их нет', async ({ page }) => {
  await login(page, 'director@yu.test');
  await page.route('**/api/crm/v1/reports/staff?*', async (route) => {
    const r = await route.fetch();
    const body = await r.json() as { metrics: Record<string, unknown> };
    for (const k of ['accrued', 'hoursAmount', 'perShift', 'penalties', 'bonuses', 'adjustments', 'toPay', 'paid', 'payoutExpense', 'forecast']) body.metrics[k] = { state: 'unavailable', reason: 'not_permitted' };
    await route.fulfill({ response: r, json: body });
  });
  await open(page, `/reports/staff?${P}`);
  await expect(page.getByTestId('money-hidden')).toHaveText('Суммы сотрудников скрыты: нет права на зарплатные данные.');
  await expect(page.getByTestId('card-accrued')).toHaveCount(0);
  await expect(page.getByTestId('metrics-table')).not.toContainText('Начислено');
  await expect(page.getByTestId('metrics-table')).toContainText('Отработано смен');
});

test('разбивки отчёта мероприятий – таблицами со словами', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await page.route('**/api/crm/v1/reports/events?*', async (route) => {
    const r = await route.fetch();
    const body = await r.json() as Record<string, unknown>;
    body.groups = { byStatus: [{ status: 'held', count: 2 }, { status: 'cancelled', count: 1 }], costStructure: [{ kind: 'other', amountKop: 2_000_000 }] };
    await route.fulfill({ response: r, json: body });
  });
  await open(page, `/reports/events?${P}`);
  await expect(page.getByTestId('group-Мероприятия по статусам').locator('tr')).toHaveText(['Проведено2', 'Отменено1']);
  await expect(page.getByTestId('group-Структура себестоимости')).toContainText('20 000,00 ₽');
});

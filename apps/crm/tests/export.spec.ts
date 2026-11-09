// S4-93: экспорт – без права кнопки нет; окно с форматом и составом, фильтры экрана; «телефоны будут скрыты» без export.pd;
// двойной клик – одна задача; список задач со статусами, скачивание готового, у expired ссылки нет, отмена идущей.
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

test('Администратор: без права на экспорт кнопки нет', async ({ page }) => {
  await login(page, 'admin@yu.test');
  await open(page, `/reports/bookings?${P}`);
  await expect(page.getByTestId('report')).toHaveAttribute('data-state', 'ready');
  await expect(page.getByTestId('export-open')).toHaveCount(0);
});

test('Директор: телефоны будут скрыты, записи – только с выбранным показателем, двойной клик – одна задача', async ({ page }) => {
  await login(page, 'director@yu.test');
  await open(page, `/reports/bookings?${P}`);
  await page.getByTestId('export-open').click();
  const dlg = page.getByTestId('export-dialog');
  await expect(dlg.getByTestId('export-masked')).toContainText('будут скрыты');
  await expect(dlg.getByRole('radio', { name: /Записи показателя/ })).toBeDisabled();
  await dlg.getByRole('button', { name: 'Отмена' }).click();

  await page.getByTestId('card-visited').click();
  await page.getByTestId('export-open').click();
  await dlg.getByRole('radio', { name: 'Записи показателя «Состоялось»' }).check();
  await dlg.getByRole('radio', { name: /CSV/ }).check();
  const posts: string[] = [];
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/reports/exports')) posts.push(r.postData() ?? ''); });
  await dlg.getByRole('button', { name: 'Сформировать' }).dblclick();
  await expect(dlg.getByTestId('export-queued')).toBeVisible();
  expect(posts.length).toBe(1);
  expect(JSON.parse(posts[0]!)).toEqual({ report: 'bookings', format: 'csv', detail: true, params: { from: '2026-11-01', to: '2026-11-10', metric: 'visited' } });
  const list = await (await page.request.get('/api/crm/v1/reports/exports')).json() as { items: Array<{ masked: boolean; params: { branchIds: string[] } }> };
  expect(list.items).toHaveLength(1);
  expect(list.items[0]!.masked).toBe(true);
  expect(list.items[0]!.params.branchIds).toEqual(['b-nsk-akadem', 'b-nsk-krasny']); // зона заморожена при постановке
});

test('Директор: суммы зарплаты в файл не попадут; Владелец – без предупреждений', async ({ page }) => {
  await login(page, 'director@yu.test');
  await open(page, `/reports/staff?${P}`);
  await page.getByTestId('export-open').click();
  await expect(page.getByTestId('export-dialog').getByTestId('export-payroll')).toBeVisible();
  await page.context().clearCookies();
  await login(page, 'owner@yu.test');
  await open(page, `/reports/finance?${P}&metric=refunds`);
  await page.getByTestId('export-open').click();
  const dlg = page.getByTestId('export-dialog');
  await expect(dlg.getByTestId('export-masked')).toHaveCount(0);
  await expect(dlg.getByRole('radio', { name: 'Записи показателя «Возвраты»' })).toBeEnabled();
});

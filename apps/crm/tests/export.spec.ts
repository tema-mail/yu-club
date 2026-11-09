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

test('мои файлы: статусы словами, скачивание готового, у истёкшего ссылки нет, новая задача доходит до «Готов»', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, '/reports');
  await page.getByRole('link', { name: 'Мои файлы' }).click();
  await expect(page).toHaveURL(/\/reports\/exports$/);
  const ready = page.getByTestId('job-ea000000-0000-4000-8000-000000000901');
  await expect(ready.getByTestId('status')).toContainText('Готов');
  const link = ready.getByRole('link', { name: /Скачать \(310 строк\)/ });
  const file = await page.request.get((await link.getAttribute('href'))!);
  expect(file.status()).toBe(200);
  expect(file.headers()['content-disposition']).toMatch(/^attachment;/);
  expect(file.headers()['cache-control']).toBe('no-store');
  const expired = page.getByTestId('job-ea000000-0000-4000-8000-000000000902');
  await expect(expired.getByTestId('status')).toHaveText('Срок хранения истёк');
  await expect(expired.getByRole('link')).toHaveCount(0);
  await expect(expired).toContainText('Сформируйте заново');
  expect((await page.request.get('/api/crm/v1/reports/exports/ea000000-0000-4000-8000-000000000902/file')).status()).toBe(410);
  await expect(page.getByTestId('job-ea000000-0000-4000-8000-000000000903').getByTestId('status')).toHaveText('Ошибка: больше 200 000 строк – сузьте период');

  await open(page, `/reports/bookings?${P}`);
  await page.getByTestId('export-open').click();
  await page.getByTestId('export-dialog').getByRole('button', { name: 'Сформировать' }).click();
  await page.getByTestId('export-dialog').getByRole('link', { name: 'Мои файлы' }).click();
  const fresh = page.getByTestId('export-jobs').locator('tbody tr').first();
  await expect(fresh).toContainText('Бронирования и посещаемость, XLSX');
  await expect(fresh.getByTestId('status')).toContainText('Готов', { timeout: 10_000 });
  await expect(fresh.getByRole('link', { name: /Скачать/ })).toBeVisible();
});

test('отмена идущей задачи; без права – 404 на списке файлов', async ({ page }) => {
  await login(page, 'owner@yu.test');
  const job = await (await page.request.post('/api/crm/v1/reports/exports', {
    headers: { 'idempotency-key': crypto.randomUUID() }, data: { report: 'events', format: 'csv', params: { from: '2026-11-01', to: '2026-11-10' } },
  })).json() as { id: string };
  // список отдаём с задачей «в очереди», отмена уходит в настоящий маршрут
  await page.route('**/api/crm/v1/reports/exports', async (route) => {
    const r = await route.fetch();
    const body = await r.json() as { items: Array<{ id: string; status: string }> };
    for (const j of body.items) if (j.id === job.id) j.status = 'queued';
    await route.fulfill({ response: r, json: body });
  });
  await open(page, '/reports/exports');
  const row = page.getByTestId(`job-${job.id}`);
  await expect(row.getByTestId('status')).toHaveText('В очереди');
  await row.getByRole('button', { name: 'Отменить' }).click();
  await expect(page.getByTestId('export-jobs').getByRole('status')).toHaveText(/Задача отменена\.|Задача уже завершилась – отменять нечего\./);

  await page.context().clearCookies();
  await login(page, 'admin@yu.test');
  expect((await page.goto('/reports/exports'))?.status()).toBe(404);
});

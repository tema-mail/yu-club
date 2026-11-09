// S4-92: календарь загрузки единицы – брони, блокировки и свободное по времени филиала; VR1 и VR2 отдельно, аренда комнаты
// видна на обоих; единица чужого филиала – как несуществующая (K1).
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

test('VR1 и VR2 – отдельные календари, аренда комнаты видна на обоих', async ({ page }) => {
  await login(page, 'admin@yu.test');
  await open(page, '/reports/utilization?from=2026-11-01&to=2026-11-10');
  const units = page.locator('main [name=unitId]');
  await expect(units.locator('option')).toHaveText(['Выберите единицу', 'ПК 1 – Ю Клуб на Красном', 'ПК 2 – Ю Клуб на Красном', 'VR1 – Ю Клуб на Красном', 'VR2 – Ю Клуб на Красном', 'PlayStation 1 – Ю Клуб на Красном']);
  await units.selectOption({ label: 'VR1 – Ю Клуб на Красном' });
  const vr1 = page.getByTestId('calendar-VR1');
  await expect(vr1.locator('[name=calendarDate]')).toHaveValue('2026-11-10');
  await expect(vr1).toContainText('Часы работы: 10:00–22:00');
  await expect(vr1.getByTestId('cal-booked')).toContainText('14:00–16:00');
  await expect(vr1.getByTestId('cal-blocked')).toHaveText(/Заблокировано:\s*нет/);
  await expect(vr1.getByTestId('cal-free')).toContainText('16:00–22:00');

  await units.selectOption({ label: 'VR2 – Ю Клуб на Красном' });
  const vr2 = page.getByTestId('calendar-VR2');
  await expect(vr2.getByTestId('cal-booked')).toContainText('14:00–16:00');
  await expect(vr2.getByTestId('cal-blocked')).toContainText('18:00–19:00');
  await expect(vr2.getByTestId('cal-free')).toContainText('19:00–22:00');
  await expect(page.getByTestId('calendar-VR1')).toHaveCount(0);

  await vr2.locator('[name=calendarDate]').fill('2026-11-07');
  await expect(vr2.getByTestId('cal-booked')).toContainText('14:00–16:00');
  await vr2.getByRole('button', { name: 'Закрыть календарь' }).click();
  await expect(page.getByTestId('calendar-VR2')).toHaveCount(0);
});

test('единица чужого филиала – 404, как несуществующая', async ({ page }) => {
  await login(page, 'admin@yu.test');
  const r = await page.request.get('/api/crm/v1/reports/utilization/calendar?unitId=7a000000-0000-4000-8000-000000000023&date=2026-11-10');
  expect(r.status()).toBe(404);
  const own = await page.request.get('/api/crm/v1/reports/utilization/calendar?unitId=7a000000-0000-4000-8000-000000000003&date=2026-11-10');
  expect(own.status()).toBe(200);
});

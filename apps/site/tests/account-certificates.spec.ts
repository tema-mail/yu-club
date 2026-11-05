// e2e ЛК «Мои сертификаты» (S2-71) на моке tests/mock-commerce.ts (K16 §8, 08 §10): остаток и срок у действующего,
// номинал / использовано / сгорело у истёкшего, история погашений с филиалом и датой, чужой сертификат не виден
// (и его история – 404), пустое состояние, 390 px без горизонтальной прокрутки.
import { expect, test, type Page } from '../../../tests/support/e2e.ts';
import { STAGE_PORT } from '../playwright.config.ts';
import { MOCK_CODE } from './mock-api.ts';

test.use({ baseURL: `http://localhost:${STAGE_PORT}` });

async function login(page: Page, phone: string) {
  await page.goto('/login/?next=/account/');
  await page.getByLabel('Телефон').fill(phone);
  await page.getByRole('button', { name: 'Получить код' }).click();
  await page.getByLabel('Код из SMS').fill(MOCK_CODE);
  await page.getByLabel(/согласие на обработку/).check();
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(/\/account\/$/);
}

const cert = (page: Page, number: string) => page.getByTestId('certificate').filter({ hasText: `№ ${number}` });

test('остаток и срок, истёкший со сгоревшей суммой, история погашений; чужого нет', async ({ page }) => {
  await login(page, '9131234567');
  await expect(page.getByTestId('certificate')).toHaveCount(3);
  const active = cert(page, 'YU-2026-0001');
  await expect(active).toContainText('Частично использован');
  await expect(active.getByTestId('certificate-balance')).toHaveText('Остаток 1 200 ₽ из 3 000 ₽');
  await expect(active).toContainText('Действует до');
  await active.getByRole('button', { name: 'История использования' }).click();
  const rows = active.getByTestId('certificate-history').locator('li');
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText('Покупка');
  await expect(rows.nth(1)).toContainText('Оплата сертификатом · Ю-Клуб на Красном');
  await expect(rows.nth(1)).toContainText('−1 500 ₽ → 1 500 ₽');
  await expect(rows.nth(3)).toContainText('Возврат на сертификат');
  await active.getByRole('button', { name: 'Скрыть историю' }).click();
  await expect(active.getByTestId('certificate-history')).toHaveCount(0);

  const expired = cert(page, 'YU-2025-0042');
  await expect(expired).toContainText('Истёк');
  await expect(expired).toContainText('Номинал 2 000 ₽ · использовано 1 500 ₽ · сгорело 500 ₽');
  await expect(cert(page, 'YU-2026-0007')).toContainText('Использован');

  await expect(page.getByTestId('certificates')).not.toContainText('YU-2026-0099'); // сертификат Петра
  const status = await page.evaluate(async () => (await fetch('/api/public/v1/me/certificates/YU-2026-0099/history/')).status);
  expect(status).toBe(404);
  await expect(page.getByTestId('loyalty')).toBeVisible();
  await expect(page.getByTestId('my-bookings')).toBeVisible();
});

test('нет сертификатов – понятное пустое состояние', async ({ page }) => {
  await login(page, '9130000079');
  await expect(page.getByTestId('certs-empty')).toContainText('Сертификатов пока нет');
});

test('390 px: сертификаты с историей без горизонтальной прокрутки', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, '9131234567');
  await cert(page, 'YU-2026-0001').getByRole('button', { name: 'История использования' }).click();
  await expect(page.getByTestId('certificate-history')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'test-results/account-certificates-390.png', fullPage: true });
});

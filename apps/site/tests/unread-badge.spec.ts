// S4-124: значок непрочитанных. Только с сессией – без неё запроса нет ни на одной странице; ?n= из push отмечает прочтение и уходит из адреса;
// центр уведомлений обновляет число без перезагрузки; шапка на 390 px не вылезает за экран.
import { expect, test, type Page } from '../../../tests/support/e2e.ts';
import { MOCK_PORT, STAGE_PORT } from '../playwright.config.ts';
import { MOCK_CODE } from './mock-api.ts';

test.use({ baseURL: `http://localhost:${STAGE_PORT}` });
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const N1 = '0b0a0000-0000-4000-8000-000000000001';

async function login(page: Page) {
  await page.goto('/login/?next=/account/');
  await page.getByLabel('Телефон').fill('9131234567');
  await page.getByRole('button', { name: 'Получить код' }).click();
  await page.getByLabel('Код из SMS').fill(MOCK_CODE);
  await page.getByLabel(/согласие на обработку/).check();
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(/^[^?]*\/account\/$/);
}

test.beforeEach(async ({ request }) => {
  await request.post(`${MOCK}/__test/inbox-reset`);
});

test('без сессии: значка нет, запросов числа нет', async ({ page, request }) => {
  for (const path of ['/', '/news/', '/tomsk/lenina/']) {
    await page.goto(path);
    await expect(page.getByTestId('unread-badge')).toHaveCount(0);
  }
  expect(await (await request.get(`${MOCK}/__test/inbox-calls`)).json()).toEqual([]);
});

test('с сессией: число непрочитанных, ссылка в центр, 44 px; 390 px без прокрутки', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  const badge = page.getByTestId('unread-badge');
  await expect(page.getByTestId('unread-count')).toHaveText('2');
  await expect(badge).toHaveAttribute('href', '/account/notifications/');
  await expect(badge).toHaveAttribute('aria-label', 'Уведомления: 2 непрочитанных');
  expect((await badge.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(scroll).toBeLessThanOrEqual(client);
  await page.screenshot({ path: 'test-results/screens/390-header-badge.png' });
});

test('открытие из push с ?n=: сообщение прочитано, параметр убран; «Отметить все» в центре гасит значок', async ({ page }) => {
  await login(page);
  await page.goto(`/account/?n=${N1}`);
  await expect(page.getByTestId('unread-count')).toHaveText('1');
  await expect(page).toHaveURL(/\/account\/$/);
  await page.goto('/account/notifications/');
  await expect(page.getByTestId('nc-item').first()).not.toContainText('Новое');
  await page.getByRole('button', { name: 'Отметить все прочитанными' }).click();
  await expect(page.getByTestId('unread-count')).toHaveCount(0);
  await expect(page.getByTestId('unread-badge')).toHaveAttribute('aria-label', 'Уведомления');
});

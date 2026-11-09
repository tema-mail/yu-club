// S4-81: форма сообщения. Без категории кнопок проверки и отправки нет; у Администратора нет рекламы и группы клиентов;
// предпросмотр – пять чисел 09 §7.4; отправка – через второе подтверждение с числом адресатов; AUDIENCE_CHANGED показывает
// новое число; двойной клик – одна кампания; неизвестная подстановка – ошибка у поля; чужой черновик – 404.
import { expect, test, type Page } from '../../../tests/support/e2e.ts';
import { MOCK_PASSWORD } from './mock-api.ts';
import { CAMPAIGN_IDS } from './mock-notifications.ts';

const MOCK = process.env.MOCK_URL ?? 'http://127.0.0.1:4012';
const BK1 = 'b0000000-0000-4000-8000-000000000001';
const C1 = 'c0000000-0000-4000-8000-000000000001';

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
async function open(page: Page, url: string) {
  await page.goto(url);
  await page.waitForLoadState('load');
  await expect(page.locator('astro-island[ssr]')).toHaveCount(0);
}
const campaignsCount = async (page: Page) => {
  await open(page, '/notifications');
  await expect(page.getByTestId('campaigns')).toBeVisible(); // список грузит остров
  return page.getByTestId('campaigns').locator('tbody tr').count();
};

test('Администратор: без категории кнопок нет, рекламы и группы нет; сервисное по записи – предпросмотр, подтверждение, рассылка', async ({ page }) => {
  await login(page, 'admin@yu.test');
  const before = await campaignsCount(page);
  await page.getByRole('link', { name: 'Новое сообщение' }).click();
  await expect(page.getByTestId('campaign-form')).toBeVisible();
  await expect(page.locator('astro-island[ssr]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Проверить аудиторию' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Отправить' })).toHaveCount(0);
  await expect(page.getByLabel('Категория').locator('option')).toHaveText(['Выберите категорию', 'Сервисное']);
  await page.getByLabel('Категория').selectOption('service');
  await expect(page.getByRole('button', { name: 'Группа клиентов' })).toHaveCount(0);
  await page.getByLabel('Запись клиента (ID)').fill(BK1);
  await page.getByLabel('Назначение').fill('Перенос комнаты');
  await page.getByLabel('Заголовок').fill('Комната изменилась');
  await page.locator('textarea[name=body]').fill('{client.firstName}, ваш сеанс – в соседней комнате.');
  await page.getByRole('button', { name: 'Проверить аудиторию' }).dblclick();
  const ap = page.getByTestId('audience-preview');
  await expect(ap.getByTestId('ap-total')).toHaveText('1');
  await expect(ap.getByTestId('ap-push')).toHaveText('1');
  await expect(ap.getByTestId('ap-marketing-off')).toHaveText('0');
  await expect(ap.getByTestId('ap-inbox')).toHaveText('0');
  await expect(ap.getByTestId('ap-critical')).toHaveText('1');
  await expect(page).toHaveURL(/\/notifications\/campaigns\/[0-9a-f-]{36}$/);
  await ap.getByRole('button', { name: 'Отправить' }).click();
  const dlg = page.getByRole('dialog');
  await expect(dlg).toContainText('Отправить 1 адресат?');
  await expect(dlg).toContainText('Клиент записи');
  await dlg.getByRole('button', { name: 'Отправить 1 адресат' }).click();
  await expect(page.getByTestId('campaign-status')).toHaveText('Завершена');
  await expect(page.getByTestId('cc-counters')).toHaveText('1 / 0 / 0 / 0');
  expect(await campaignsCount(page)).toBe(before + 1);
});

test('Директор: реклама на группу – пять чисел, AUDIENCE_CHANGED с новым числом, двойной клик – одна рассылка', async ({ page, request }) => {
  await login(page, 'director@yu.test');
  const before = await campaignsCount(page);
  await open(page, '/notifications/new');
  await page.getByLabel('Категория').selectOption('marketing');
  await page.getByRole('button', { name: 'Группа клиентов' }).click();
  await page.getByLabel('Область').selectOption({ label: 'Филиал: Ю Клуб на Красном' });
  await page.getByLabel('Заголовок').fill('Реклама. Ночной турнир');
  await page.locator('textarea[name=body]').fill('Турнир в {branch.name} в пятницу.');
  await page.getByRole('button', { name: 'Проверить аудиторию' }).click();
  await expect(page.getByTestId('cf-error')).toContainText('Проверьте');
  await expect(page.getByLabel('erid (маркировка рекламы)')).toHaveAttribute('aria-invalid', 'true');
  await page.getByLabel('erid (маркировка рекламы)').fill('Kra24xyZ');
  await page.getByRole('button', { name: 'Проверить аудиторию' }).click();
  const ap = page.getByTestId('audience-preview');
  await expect(ap.getByTestId('ap-total')).toHaveText('3');
  await expect(ap.getByTestId('ap-push')).toHaveText('1');
  await expect(ap.getByTestId('ap-marketing-off')).toHaveText('1');
  await expect(ap.getByTestId('ap-inbox')).toHaveText('0');
  await expect(ap.getByTestId('ap-critical')).toHaveText('0');
  await expect(ap.getByTestId('ap-inactive')).toHaveText('1');
  await expect(ap).toContainText('обойти это нельзя');

  await request.post(`${MOCK}/__test/notifications/audience-grow`, { data: {} });
  await ap.getByRole('button', { name: 'Отправить' }).click();
  const dlg = page.getByRole('dialog');
  await expect(dlg.getByTestId('ap-confirm-total')).toHaveText('3');
  await dlg.getByRole('button', { name: 'Отправить 3 адресата' }).click();
  await expect(dlg.getByTestId('ap-changed')).toContainText('теперь 4 адресата');
  await expect(dlg.getByTestId('ap-confirm-total')).toHaveText('4');
  await dlg.getByRole('button', { name: 'Отправить 4 адресата' }).dblclick();
  await expect(page.getByTestId('campaign-status')).toHaveText('Завершена');
  expect(await campaignsCount(page)).toBe(before + 1);
});

test('неизвестная подстановка – ошибка у поля «Текст»; правка черновика сбрасывает предпросмотр', async ({ page }) => {
  await login(page, 'director@yu.test');
  await open(page, `/notifications/new?clientId=${C1}&bookingId=${BK1}`);
  await page.getByLabel('Категория').selectOption('service');
  await expect(page.getByLabel('Запись клиента (ID)')).toHaveValue(BK1);
  await page.getByLabel('Назначение').fill('Уточнение');
  await page.getByLabel('Заголовок').fill('Вопрос по записи');
  await page.locator('textarea[name=body]').fill('{client.name}, перезвоните нам.');
  await page.getByRole('button', { name: 'Проверить аудиторию' }).click();
  await expect(page.locator('textarea[name=body]')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByTestId('campaign-form')).toContainText('неизвестная подстановка');
  await page.locator('textarea[name=body]').fill('{client.firstName}, перезвоните нам.');
  await page.getByRole('button', { name: 'Проверить аудиторию' }).click();
  await expect(page.getByTestId('ap-total')).toHaveText('1');
  await page.getByLabel('Заголовок').fill('Вопрос по вашей записи');
  await expect(page.getByTestId('audience-preview')).toHaveCount(0);
  await page.getByRole('button', { name: 'Проверить аудиторию' }).click();
  await expect(page.getByTestId('audience-preview')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  if (process.env.CRM_SHOTS) await page.screenshot({ path: `${process.env.CRM_SHOTS}/campaign-form-390.png`, fullPage: true });
});

test('карточка рассылки: история и отмена только у неотправленной; чужой черновик – 404', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, `/notifications/campaigns/${CAMPAIGN_IDS.krasnyAd}`);
  await expect(page.getByTestId('campaign-status')).toHaveText('Завершена');
  await expect(page.getByTestId('cc-counters')).toHaveText('1 / 0 / 2 / 0');
  await expect(page.getByTestId('campaign-card')).toContainText('Отправка подтверждена');
  await expect(page.getByRole('button', { name: 'Отменить рассылку' })).toHaveCount(0);
  await open(page, `/notifications/campaigns/${CAMPAIGN_IDS.tomskDraft}`);
  await expect(page.getByTestId('campaign-form')).toBeVisible();
  await expect(page.getByLabel('Заголовок')).toHaveValue('Реклама. Турнир в Томске');
  // отложенная рассылка: подтверждена, ещё не ушла – можно отменить с причиной
  await page.getByLabel('Отправить позже (необязательно)').fill('2026-11-20T12:00');
  await page.getByRole('button', { name: 'Проверить аудиторию' }).click();
  await page.getByTestId('audience-preview').getByRole('button', { name: 'Отправить' }).click();
  await page.getByRole('dialog').getByRole('button', { name: /^Отправить \d/ }).click();
  await expect(page.getByTestId('campaign-status')).toHaveText('Подтверждена');
  await expect(page.getByTestId('campaign-card')).toContainText('20.11.2026, 12:00');
  await page.getByRole('button', { name: 'Отменить рассылку' }).click();
  await page.getByRole('dialog').getByLabel('Причина').fill('Турнир перенесли');
  await page.getByRole('dialog').getByRole('button', { name: 'Отменить рассылку' }).click();
  await expect(page.getByTestId('campaign-status')).toHaveText('Отменена');
  await expect(page.getByTestId('campaign-card')).toContainText('Турнир перенесли');

  await page.context().clearCookies();
  await login(page, 'director@yu.test');
  await open(page, `/notifications/campaigns/${CAMPAIGN_IDS.tomskDraft}`);
  await expect(page.getByTestId('not-found')).toBeVisible();
  await open(page, `/notifications/campaigns/${CAMPAIGN_IDS.network}`);
  await expect(page.getByTestId('not-found')).toBeVisible();
});

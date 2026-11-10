// S4-80: «Уведомления» – журнал рассылок и отправок с фильтрами 09 §12.2. Владелец видит сетевые и чужие города, Администратор – только
// свою зону и без повтора; пустая выдача – условия и сброс (13 §7.4); время – по зоне филиала; повтор критичного – новая строка, двойной
// клик – один повтор; 1440 и 390 px без горизонтальной прокрутки.
import { expect, test, type Page } from '../../../tests/support/e2e.ts';
import { MOCK_PASSWORD } from './mock-api.ts';
import { CAMPAIGN_IDS, ROW_IDS } from './mock-notifications.ts';

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
const campaigns = (page: Page) => page.getByTestId('campaigns').locator('tbody tr');
const rows = (page: Page) => page.getByTestId('rows').locator('tbody tr');
const noScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test('Владелец: все рассылки сети, счётчики, автор, аудитория словами', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, '/notifications');
  await expect(campaigns(page)).toHaveCount(5);
  const ad = page.getByTestId(`campaign-${CAMPAIGN_IDS.krasnyAd}`);
  await expect(ad).toContainText('Реклама. Скидка 20% в будни');
  await expect(ad).toContainText('Денис Директоров');
  await expect(ad.getByTestId('counters')).toHaveText('1 / 0 / 2 / 0');
  await expect(ad).toContainText('Клиенты: Ю Клуб на Красном; не были с 01.10.2026');
  await expect(ad).toContainText('20.10.2026, 10:00'); // 03:00 UTC – Новосибирск +7
  await expect(page.getByTestId(`campaign-${CAMPAIGN_IDS.network}`)).toContainText('вся сеть');
  await expect(page.getByTestId(`campaign-${CAMPAIGN_IDS.tomskDraft}`)).toContainText('Черновик');

  for (const name of ['from', 'to', 'branchId', 'category', 'source', 'authorId', 'status', 'clientId']) await expect(page.locator(`main [name=${name}]`)).toBeVisible();
  await page.getByLabel('Категория').selectOption({ label: 'Сервисное' });
  await page.getByRole('button', { name: 'Найти' }).click();
  await expect(page).toHaveURL(/category=service/);
  await expect(campaigns(page)).toHaveCount(1);
  await expect(page.getByTestId(`campaign-${CAMPAIGN_IDS.personal}`)).toContainText('Анна Админова');

  await open(page, `/notifications?authorId=s-director&status=done`);
  await expect(campaigns(page)).toHaveCount(1);
  await open(page, `/notifications?clientId=c0000000-0000-4000-8000-000000000002`);
  await expect(campaigns(page)).toHaveCount(1);
  await open(page, '/notifications?from=2026-11-06&to=2026-11-10');
  await expect(campaigns(page)).toHaveCount(2);
});

test('пустая выдача: условия словами и сброс, не ошибка (13 §7.4)', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, '/notifications?category=service&status=cancelled');
  const empty = page.getByTestId('journal-empty');
  await expect(empty).toContainText('Ничего не найдено');
  await expect(empty).toContainText('категория «Сервисное»');
  await expect(empty).toContainText('статус «Отменена»');
  await expect(page.getByTestId('journal-error')).toHaveCount(0);
  await empty.getByRole('link', { name: 'Сбросить фильтры' }).click();
  await expect(page).toHaveURL(/\/notifications$/);
  await expect(campaigns(page)).toHaveCount(5);
  await open(page, '/notifications?clientId=123');
  await expect(page.getByTestId('journal-error')).toContainText('ID клиента');
});

test('Администратор: только своя зона, без сетевых, без повтора; чужой филиал в фильтре – не найдено', async ({ page }) => {
  await login(page, 'admin@yu.test');
  await open(page, '/notifications');
  await expect(campaigns(page)).toHaveCount(3);
  await expect(page.getByTestId(`campaign-${CAMPAIGN_IDS.network}`)).toHaveCount(0);
  await expect(page.locator('main [name=branchId]')).toHaveCount(0);
  // имена авторов – от API (S4-80): у Администратора нет /staff, имя Директора всё равно видно
  await expect(page.getByTestId(`campaign-${CAMPAIGN_IDS.krasnyAd}`)).toContainText('Денис Директоров');
  await expect(page.getByTestId(`campaign-${CAMPAIGN_IDS.personal}`)).toContainText('Вы');
  await open(page, '/notifications?tab=rows');
  await expect(rows(page)).toHaveCount(5);
  await expect(page.getByTestId(`row-${ROW_IDS.networkAd}`)).toHaveCount(0);
  await expect(page.getByTestId(`row-${ROW_IDS.tomskError}`)).toHaveCount(0);
  await expect(page.getByTestId(`row-${ROW_IDS.noChannel}`)).toContainText('Нет доступного канала');
  await expect(page.getByRole('button', { name: 'Повторить' })).toHaveCount(0);
  await open(page, '/notifications?tab=rows&branchId=b-tsk-lenina');
  await expect(page.getByTestId('journal-error')).toContainText('вне вашей зоны');
  await open(page, '/notifications/whatever');
  await expect(page.getByTestId('not-found')).toBeVisible();
});

test('Директор: повтор критичного сервисного с причиной – новая строка, двойной клик – один повтор', async ({ page }) => {
  await login(page, 'director@yu.test');
  await open(page, '/notifications?tab=rows&category=service');
  await expect(rows(page)).toHaveCount(3);
  const row = page.getByTestId(`row-${ROW_IDS.noChannel}`);
  await row.getByRole('button', { name: 'Повторить' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByRole('button', { name: 'Повторить отправку' }).click();
  await expect(dlg.getByRole('alert')).toContainText('Укажите');
  await dlg.getByLabel('Причина').fill('Клиент подписался на push');
  await dlg.getByRole('button', { name: 'Повторить отправку' }).dblclick();
  await expect(page.getByRole('status').filter({ hasText: 'Повтор поставлен' })).toBeVisible();
  await expect(rows(page)).toHaveCount(4);
  await expect(page.getByTestId('rows')).toContainText('(повтор)');
  await expect(page.getByTestId(`row-${ROW_IDS.noChannel}`)).toContainText('Нет доступного канала');
  // реклама и отправленное повторить нельзя: кнопка только у ошибки и «нет канала»
  await open(page, '/notifications?tab=rows&category=marketing');
  await expect(page.getByRole('button', { name: 'Повторить' })).toHaveCount(0);
});

test('Отправки: время по зоне филиала, 1440 и 390 px без горизонтальной прокрутки', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '/notifications?tab=rows');
  await expect(rows(page)).toHaveCount(7);
  await expect(page.getByTestId(`row-${ROW_IDS.tomskError}`)).toContainText('08.11.2026, 12:00'); // Asia/Tomsk +7
  await expect(page.getByTestId(`row-${ROW_IDS.tomskError}`)).toContainText('push: 500');
  await expect(page.getByTestId(`row-${ROW_IDS.networkAd}`)).toContainText('Вся сеть');
  expect(await noScroll(page)).toBe(true);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/notifications-rows-1440.png`, fullPage: true });
  await open(page, '/notifications');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/notifications-1440.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, '/notifications');
  await expect(campaigns(page)).toHaveCount(5);
  expect(await noScroll(page)).toBe(true);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/notifications-390.png`, fullPage: true });
});

test('строки одной рассылки: фильтр campaignId из адреса, автор строки по имени, условие словами и сброс', async ({ page }) => {
  await login(page, 'admin@yu.test');
  await open(page, `/notifications?tab=rows&campaignId=${CAMPAIGN_IDS.krasnyAd}`);
  await expect(rows(page)).toHaveCount(1);
  await expect(page.getByTestId('rows')).toContainText('Сотрудник: Денис Директоров');
  await page.getByLabel('Категория').selectOption({ label: 'Реклама' });
  await page.getByRole('button', { name: 'Найти' }).click();
  await expect(page).toHaveURL(new RegExp(`campaignId=${CAMPAIGN_IDS.krasnyAd}`)); // условие рассылки не теряется при смене фильтров
  await expect(rows(page)).toHaveCount(1);
  await open(page, `/notifications?tab=rows&campaignId=${CAMPAIGN_IDS.krasnyAd}&status=error`);
  await expect(page.getByTestId('journal-empty')).toContainText('одна рассылка');
});

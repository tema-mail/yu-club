// S4-87: страницы, юридические документы, блоки главной, страницы комнат и филиалов (K11 №221–223, №228; K22 §5, §7; 12 §5).
// Версия документа видна и неизменна (тот же номер с новым текстом – ошибка у поля), юридические публикует только Владелец, порядок блоков –
// кнопками (доступно с клавиатуры) и перетаскиванием, страница комнаты: Директор публикует, Администратор – только черновик.
import { expect, test, type Page } from '../../../tests/support/e2e.ts';
import { MOCK_PASSWORD } from './mock-api.ts';

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
const publish = async (page: Page) => {
  await page.getByRole('button', { name: 'Опубликовать…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Опубликовать' }).click();
};
const blockTitles = (page: Page) => page.getByTestId('home-blocks').locator('.yc-ct__block-head h2');

test('юридический документ: Директор только читает, версия видна; Владелец – тот же номер с новым текстом не публикуется', async ({ page, browser }) => {
  await login(page, 'director@yu.test');
  await open(page, '/content/pages');
  await page.getByRole('link', { name: 'Политика конфиденциальности' }).click();
  await expect(page.getByTestId('doc-version')).toContainText('privacy-policy-2026-10-01');
  await expect(page.getByText('Юридические документы публикует только Владелец.')).toBeVisible();
  await expect(page.getByLabel('Текст', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: /Опубликовать/ })).toHaveCount(0);

  const owner = await (await browser.newContext()).newPage();
  await login(owner, 'owner@yu.test');
  await open(owner, '/content/pages/privacy-policy');
  await owner.getByLabel('Текст', { exact: true }).fill('Оператор персональных данных – ООО «Ю-Клуб». Новый раздел о cookie.');
  await owner.getByRole('button', { name: 'Сохранить черновик' }).click();
  await expect(owner.getByRole('status').filter({ hasText: 'Черновик сохранён' })).toBeVisible();
  await publish(owner);
  await expect(owner.locator('#page-documentVersion-error')).toHaveText('Текст изменился – укажите новую версию документа');
  await expect(owner.getByTestId('doc-version')).toContainText('privacy-policy-2026-10-01');
  await owner.getByLabel('Версия документа').fill('privacy-policy-2026-11-10');
  await owner.getByRole('button', { name: 'Сохранить черновик' }).click();
  await expect(owner.getByRole('status').filter({ hasText: 'Черновик сохранён' })).toBeVisible();
  await publish(owner);
  await expect(owner.getByRole('status').filter({ hasText: 'Опубликовано' })).toBeVisible();
  await expect(owner.getByTestId('doc-version')).toContainText('privacy-policy-2026-11-10');
  const res = await owner.goto('/content/pages/privacy-policy?cityId=c-nsk');
  expect(res?.status()).toBe(404); // юридические – только сетевые
});

test('блоки главной: порядок кнопками и перетаскиванием, после перезагрузки сохраняется', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, '/content/home');
  await expect(blockTitles(page)).toHaveText(['1. Первый экран', '2. О клубе']);
  await page.getByRole('button', { name: 'Ниже: Первый экран' }).click();
  await expect(page.getByTestId('order-msg')).toContainText('Порядок сохранён');
  await expect(blockTitles(page)).toHaveText(['1. О клубе', '2. Первый экран']);
  await page.reload();
  await expect(blockTitles(page)).toHaveText(['1. О клубе', '2. Первый экран']);
  await page.getByTestId('block-hero').dragTo(page.getByTestId('block-about'));
  await expect(blockTitles(page)).toHaveText(['1. Первый экран', '2. О клубе']);
  // новый блок: полоса акции, с ошибкой схемы – у поля и в сообщении
  await page.locator('summary', { hasText: 'Полоса акции' }).click();
  await page.locator('#blk-promo_strip-text').fill('Скидка 20% по будням');
  await page.locator('#blk-promo_strip-url').fill('https://evil.example/');
  await page.getByRole('button', { name: 'Создать блок' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'только путь этого сайта' })).toBeVisible();
  await page.locator('#blk-promo_strip-url').fill('/promo/');
  await page.getByRole('button', { name: 'Создать блок' }).click();
  await expect(blockTitles(page)).toHaveText(['1. Первый экран', '2. О клубе', '3. Полоса акции']);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/content-home-1440.png`, fullPage: true });
});

test('блоки главной: Директор – сеть только видит, свой город правит', async ({ page }) => {
  await login(page, 'director@yu.test');
  await open(page, '/content/home');
  await expect(page.getByText('Сетевые блоки правит Владелец.')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Выше|^Ниже/ })).toHaveCount(0);
  await open(page, '/content/home?cityId=c-nsk');
  await page.locator('summary', { hasText: 'Призыв к записи' }).click();
  await page.locator('#blk-cta-title').fill('Запишитесь на вечер');
  await page.locator('#blk-cta-label').fill('Записаться');
  await page.locator('#blk-cta-url').fill('/booking/');
  await page.getByRole('button', { name: 'Создать блок' }).click();
  await expect(blockTitles(page)).toHaveText(['1. Призыв к записи']);
  const res = await page.goto('/content/home?cityId=c-tsk');
  expect(res?.status()).toBe(404);
});

test('страница комнаты: Директор публикует, Администратор сохраняет черновик без публикации', async ({ page, browser }) => {
  await login(page, 'admin@yu.test');
  await open(page, '/content/pages');
  await page.getByRole('link', { name: 'Общий зал' }).click();
  await expect(page.getByText('Страницы ещё нет: она появится при первом сохранении.')).toBeVisible();
  await page.getByLabel('Описание', { exact: true }).fill('Двадцать игровых мест с мониторами 240 Гц.');
  await page.getByRole('button', { name: 'Сохранить черновик' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Черновик сохранён' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Опубликовать/ })).toHaveCount(0);

  const dir = await (await browser.newContext()).newPage();
  await login(dir, 'director@yu.test');
  await open(dir, '/content/pages/rooms/r-hall');
  await expect(dir.getByLabel('Описание', { exact: true })).toHaveValue('Двадцать игровых мест с мониторами 240 Гц.');
  await publish(dir);
  await expect(dir.getByRole('status').filter({ hasText: 'Опубликовано' })).toBeVisible();
  const foreign = await dir.goto('/content/pages/rooms/r-tsk-hall');
  expect(foreign?.status()).toBe(404);
});

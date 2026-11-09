// S4-85: медиатека и выбор файла (K22 §8; 12 §10). SVG и подмена типа – «Можно JPG, PNG, WebP до 10 МБ»; рекомендуемые пропорции у обложки;
// подпись у alt «изменение попадёт на сайт со следующей публикацией»; «где используется»; архив используемого – MEDIA_IN_USE со списком;
// у Администратора архива нет; выбор обложки в редакторе публикации с предупреждением про пустой alt.
import { expect, test, type Page } from '../../../tests/support/e2e.ts';
import { CONTENT_IDS } from './mock-content.ts';
import { MOCK_PASSWORD } from './mock-api.ts';

const SHOTS = process.env.CRM_SHOTS;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAyAAAAHCCAIAAACmnD5dAAAADElEQVR4nGNgGAWjAAAB9AABMMn6WwAAAABJRU5ErkJggg==', 'base64');
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
const tiles = (page: Page) => page.getByTestId('media-grid').locator('li');
const upMsg = (page: Page) => page.getByTestId('media-upload-msg');

test('загрузка: SVG и подмена типа – понятная ошибка; PNG с alt – в медиатеке', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, '/content/media');
  await expect(tiles(page)).toHaveCount(3);
  await expect(page.getByText('Обложка: 16:9, не меньше 1600×900 px.')).toBeVisible();
  const file = page.getByLabel('Файл', { exact: true });
  await file.setInputFiles({ name: 'logo.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') });
  await page.getByRole('button', { name: 'Загрузить' }).click();
  await expect(upMsg(page)).toContainText('Можно JPG, PNG, WebP до 10 МБ');
  await expect(upMsg(page)).toContainText('Файл «logo.svg» не загружен.');
  // подмена: расширение и тип PNG, внутри – текст; ловит сервер по сигнатуре
  await file.setInputFiles({ name: 'fake.png', mimeType: 'image/png', buffer: Buffer.from('not a picture at all') });
  await page.getByRole('button', { name: 'Загрузить' }).click();
  await expect(upMsg(page)).toContainText('Можно JPG, PNG, WebP до 10 МБ');
  await file.setInputFiles({ name: 'hall.png', mimeType: 'image/png', buffer: PNG });
  await page.getByLabel('Описание картинки (alt)').fill('Зал с компьютерами');
  await page.getByRole('button', { name: 'Загрузить' }).click();
  await expect(upMsg(page)).toHaveText('Файл загружен.');
  await expect(tiles(page)).toHaveCount(4);
  const card = page.getByTestId('media-card');
  await expect(card).toContainText('800×450');
  await expect(card.getByLabel('Описание (alt)')).toHaveValue('Зал с компьютерами');
  await expect(card).toContainText('Изменение попадёт на сайт со следующей публикацией');
});

test('где используется; архив используемого – список материалов; неиспользуемый – в архив', async ({ page }) => {
  await login(page, 'director@yu.test');
  await open(page, '/content/media');
  await tiles(page).filter({ hasText: 'cs2-turnir.jpg' }).getByRole('button').click();
  const card = page.getByTestId('media-card');
  await card.getByRole('button', { name: 'Где используется' }).click();
  await expect(card.getByTestId('media-usages')).toContainText('Публикация: Обложка – на сайте');
  await expect(card.getByTestId('media-usages')).toContainText('Игра: Обложка – на сайте');
  await card.getByRole('button', { name: 'В архив' }).click();
  await expect(card.getByRole('status')).toContainText('Нельзя в архив: файл показывается на сайте');
  await expect(card.getByRole('link', { name: 'Публикация: Обложка – на сайте' }).first()).toHaveAttribute('href', `/content/publications/${CONTENT_IDS.pubNetwork}`);
  await tiles(page).filter({ hasText: 'zal-krasny.jpg' }).getByRole('button').click();
  await expect(tiles(page).filter({ hasText: 'zal-krasny.jpg' })).toContainText('Нет alt');
  await card.getByLabel('Описание (alt)').fill('Зал на Красном');
  await card.getByRole('button', { name: 'Сохранить' }).click();
  await expect(card.getByRole('status')).toContainText('На сайте описание сменится со следующей публикацией');
  await card.getByRole('button', { name: 'В архив' }).click();
  await expect(card.getByRole('status')).toContainText('Файл в архиве');
  await expect(tiles(page)).toHaveCount(2); // в списке только PDF и используемая обложка
  await page.getByLabel('Архив').check();
  await page.getByRole('button', { name: 'Показать' }).click();
  await expect(tiles(page)).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Удалить' })).toHaveCount(0); // удаление – только Владелец
});

test('Администратор: загрузка и alt есть, архива нет', async ({ page }) => {
  await login(page, 'admin@yu.test');
  await open(page, '/content/media');
  await tiles(page).first().getByRole('button').click();
  await expect(page.getByTestId('media-card').getByRole('button', { name: 'Сохранить' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'В архив' })).toHaveCount(0);
});

test('выбор обложки в редакторе: пропорции подсказкой, без alt – предупреждение', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, `/content/publications/${CONTENT_IDS.pubCity}`);
  await expect(page.getByText('Обложка: 16:9, не меньше 1600×900 px.')).toBeVisible();
  await page.getByRole('button', { name: 'Выбрать из медиатеки…' }).click();
  const dlg = page.getByRole('dialog');
  await expect(dlg.getByRole('button', { name: /^Выбрать:/ })).toHaveCount(2); // PDF правил среди картинок не предлагается
  await dlg.getByRole('button', { name: 'Выбрать: zal-krasny.jpg' }).click();
  await expect(page.getByTestId('pub-cover-current')).toContainText('Нет описания (alt) – без него не опубликовать');
  await page.getByRole('button', { name: 'Сохранить черновик' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Черновик сохранён' })).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('pub-cover-current')).toContainText('zal-krasny.jpg');
});

test('снимки медиатеки 1440 и 390 без горизонтальной прокрутки', async ({ page }) => {
  await login(page, 'owner@yu.test');
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await open(page, '/content/media');
    await tiles(page).first().getByRole('button').click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/content-media-${width}.png`, fullPage: true });
  }
});

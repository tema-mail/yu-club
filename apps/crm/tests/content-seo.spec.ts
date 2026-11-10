// Остаток S4-84…S4-89 (K22 §8, §13; K23 §4): SEO-панель в карточке игры (адрес, title, description, H1, вид сниппета – как у публикаций),
// SEO-поля страниц и баннера главной, история версий и откат блока главной, очистка фото по требованию субъекта (№227а) – только Владелец.
import { expect, test, type Page } from '../../../tests/support/e2e.ts';
import { CONTENT_IDS } from './mock-content.ts';
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
const saved = (page: Page) => expect(page.getByRole('status').filter({ hasText: 'Черновик сохранён' })).toBeVisible();

test('игра: SEO-панель – адрес с проверкой занятости, title со счётчиком, сниппет; поля сохраняются в черновик', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, `/content/games/${CONTENT_IDS.gameCs}`);
  const seo = page.getByTestId('seo-panel');
  await expect(seo.getByLabel('Адрес страницы')).toHaveValue('counter-strike-2');
  await expect(seo.getByTestId('seo-snippet')).toContainText('yu-club.ru/games/pc/counter-strike-2/');
  await expect(seo.getByTestId('seo-snippet')).toContainText('Counter-Strike 2 – где поиграть в Ю-Клуб');
  await seo.getByLabel('Title').fill('Counter-Strike 2 в компьютерном клубе: турниры по субботам, игровые ПК 240 Гц');
  await expect(page.locator('#seo-seoTitle-count')).toContainText('длиннее 70');
  await seo.getByLabel('Description').fill('Где поиграть в CS2 с друзьями.');
  await seo.getByLabel('H1').fill('Counter-Strike 2 в Ю-Клуб');
  await seo.getByLabel('Адрес страницы').fill('cs2');
  await expect(seo.getByTestId('seo-moved')).toContainText('/counter-strike-2/');
  await page.getByRole('button', { name: 'Сохранить черновик' }).click();
  await saved(page);
  await page.reload();
  await expect(page.getByTestId('seo-panel').getByLabel('H1')).toHaveValue('Counter-Strike 2 в Ю-Клуб');
  await expect(page.getByTestId('seo-panel').getByLabel('Адрес страницы')).toHaveValue('cs2');
});

test('страница «О клубе»: SEO без поля адреса – адрес задан картой сайта; title, description, H1 сохраняются в черновик', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, '/content/pages/about');
  const seo = page.getByTestId('seo-panel');
  await expect(seo.getByLabel('Адрес страницы')).toHaveCount(0);
  await expect(seo.getByTestId('seo-snippet')).toContainText('yu-club.ru/about/');
  await page.getByLabel('Заголовок').fill('О клубе');
  await page.getByLabel('Текст', { exact: true }).fill('Сеть компьютерных клубов.');
  await seo.getByLabel('Title').fill('О сети Ю-Клуб – компьютерные клубы');
  await seo.getByLabel('Description').fill('Кто мы и как устроены клубы.');
  await seo.getByLabel('H1').fill('О нашем клубе');
  await page.getByRole('button', { name: 'Сохранить черновик' }).click();
  await saved(page);
  await page.reload();
  await expect(page.getByTestId('seo-panel').getByLabel('H1')).toHaveValue('О нашем клубе');
  await expect(page.getByTestId('seo-panel').getByLabel('Title')).toHaveValue('О сети Ю-Клуб – компьютерные клубы');
});

test('баннер главной: SEO главной в блоке hero; публикация – новая версия; история версий и откат к версии 1 с причиной', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, '/content/home');
  const hero = page.getByTestId('block-hero');
  await hero.locator('summary', { hasText: 'Изменить содержимое' }).click();
  const seo = hero.getByTestId('seo-panel');
  await expect(seo.getByTestId('seo-snippet')).toContainText('yu-club.ru/');
  await seo.getByLabel('Title').fill('Компьютерный клуб Ю-Клуб – ПК, VR, PlayStation');
  await seo.getByLabel('H1').fill('Играй с друзьями');
  await hero.getByRole('button', { name: 'Сохранить черновик' }).click();
  await expect(hero.getByRole('status').filter({ hasText: 'Черновик блока сохранён' })).toBeVisible();
  await hero.getByRole('button', { name: 'Опубликовать…' }).click();
  await hero.getByRole('dialog').getByRole('button', { name: 'Опубликовать' }).click();
  await expect(hero.getByRole('status').filter({ hasText: 'Опубликовано' })).toBeVisible();
  await hero.getByRole('button', { name: 'История версий' }).click();
  const versions = hero.getByTestId('version-list');
  await expect(versions.locator('li')).toHaveCount(2);
  await expect(hero.getByTestId('version-2')).toContainText('на сайте');
  await expect(hero.getByTestId('version-diff').locator('tr[data-field="h1"]')).toBeVisible();
  await hero.getByTestId('version-1').getByRole('button', { name: 'Откатить к этой версии…' }).click();
  const dlg = hero.getByRole('dialog', { name: 'Откатить к версии 1?' });
  await dlg.getByRole('button', { name: 'Откатить' }).click();
  await expect(dlg.getByText('Укажите причину отката')).toBeVisible();
  await dlg.getByLabel('Причина').fill('Вернули прежний баннер');
  await dlg.getByRole('button', { name: 'Откатить' }).click();
  await expect(hero.getByRole('status').filter({ hasText: 'Откат выполнен: опубликована версия 3 с содержимым версии 1' })).toBeVisible();
});

test('блоки главной: Директор видит историю версий сетевого блока, отката нет', async ({ page }) => {
  await login(page, 'director@yu.test');
  await open(page, '/content/home');
  const hero = page.getByTestId('block-hero');
  await hero.locator('summary', { hasText: 'Изменить содержимое' }).click();
  await hero.getByRole('button', { name: 'История версий' }).click();
  await expect(hero.getByTestId('version-1')).toBeVisible();
  await expect(hero.getByRole('button', { name: /Откатить/ })).toHaveCount(0);
});

test('игра: Директор видит SEO-панель только для чтения', async ({ page }) => {
  await login(page, 'director@yu.test');
  await open(page, `/content/games/${CONTENT_IDS.gameCs}`);
  await expect(page.getByTestId('seo-panel').getByLabel('Title')).toBeDisabled();
});

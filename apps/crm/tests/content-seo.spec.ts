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

test('игра: Директор видит SEO-панель только для чтения', async ({ page }) => {
  await login(page, 'director@yu.test');
  await open(page, `/content/games/${CONTENT_IDS.gameCs}`);
  await expect(page.getByTestId('seo-panel').getByLabel('Title')).toBeDisabled();
});

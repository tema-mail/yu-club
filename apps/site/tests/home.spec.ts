// S4-119: главная из блоков CMS. Порядок и тексты – из API, один H1 из баннера, пустой ответ – блоки скрыты и запасной баннер,
// технических названий нет; карусель игр листается сама, «Пауза» останавливает, prefers-reduced-motion – не листается сама.
import { expect, test, type APIRequestContext } from '../../../tests/support/e2e.ts';
import { MOCK_PORT } from '../playwright.config.ts';

const setHome = (request: APIRequestContext, home: 'full' | 'empty') => request.post(`http://127.0.0.1:${MOCK_PORT}/__mock/content`, { data: { home } });

test('блоки CMS: H1 из баннера, о клубе, направления, полоса акции, акции, новости, игры; без технических названий', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('h1')).toHaveCount(1);
  await expect(page.locator('h1')).toHaveText('Играй с друзьями в Ю-Клуб');
  // Главное действие баннера – «Выбрать время» (19 §4.2, D4-66); CTA из CMS в то же расписание второй кнопкой не дублируется.
  const hero = page.getByTestId('home-hero');
  await expect(hero.getByRole('link', { name: 'Выбрать время' })).toHaveAttribute('href', '/schedule/');
  await expect(hero.getByRole('link', { name: 'Записаться онлайн' })).toHaveCount(0);
  await expect(page.getByTestId('home-about').locator('strong')).toHaveText('каждый день');
  await expect(page.getByTestId('home-directions').getByRole('link', { name: 'VR' })).toHaveAttribute('href', '/games/vr/');
  await expect(page.getByTestId('home-strip').getByRole('link')).toHaveAttribute('href', '/promotions/happy-hours/');
  await expect(page.getByTestId('home-promos')).toContainText('Счастливые часы');
  await expect(page.getByTestId('home-news')).toContainText('Живая новость');
  await expect(page.getByTestId('home-games')).toContainText('Gran Turismo 7');
  const text = await page.locator('main').innerText();
  for (const tech of ['promo_strip', 'hero', 'blockType', 'advantages', 'undefined', 'null']) expect(text).not.toContain(tech);
  // Выбор клуба – сразу после баннера.
  await expect(page.locator('#clubs')).toBeVisible();
});

test('пустой ответ CMS: блоков и разделов нет, запасной баннер и клубы на месте', async ({ page, request }) => {
  await setHome(request, 'empty');
  try {
    await page.goto('/');
    await expect(page.locator('h1')).toHaveText('Компьютерные клубы Ю-Клуб');
    for (const id of ['home-about', 'home-directions', 'home-strip', 'home-promos', 'home-news', 'home-games']) await expect(page.getByTestId(id)).toHaveCount(0);
    await expect(page.locator('#clubs').getByRole('link', { name: 'Ю-Клуб на Ленина' })).toBeVisible();
  } finally {
    await setHome(request, 'full');
  }
});

test('карусель: листается сама, «Пауза» останавливает и переключается на «Листать»; 390 px без прокрутки страницы', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const track = page.locator('[data-carousel]');
  await expect(track).toHaveAttribute('data-state', 'playing');
  await expect.poll(() => track.evaluate((el) => el.scrollLeft), { timeout: 9000 }).toBeGreaterThan(0);
  const button = page.getByRole('button', { name: 'Пауза' });
  expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await button.click();
  await expect(track).toHaveAttribute('data-state', 'paused');
  await expect(page.getByRole('button', { name: 'Листать' })).toHaveAttribute('aria-pressed', 'true');
  const at = await track.evaluate((el) => el.scrollLeft);
  await page.waitForTimeout(5600);
  expect(await track.evaluate((el) => el.scrollLeft)).toBe(at);
  const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(scroll).toBeLessThanOrEqual(client);
  await page.screenshot({ path: 'test-results/screens/390-home-cms.png', fullPage: true });
});

test('prefers-reduced-motion: карусель сама не листается, кнопка предлагает «Листать»', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const track = page.locator('[data-carousel]');
  await expect(track).toHaveAttribute('data-state', 'paused');
  await expect(page.getByRole('button', { name: 'Листать' })).toBeVisible();
  await page.waitForTimeout(5600);
  expect(await track.evaluate((el) => el.scrollLeft)).toBe(0);
});

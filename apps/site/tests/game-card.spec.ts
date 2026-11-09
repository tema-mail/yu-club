// S4-118: карточка игры. Без полного описания – 404 (плитка остаётся), «где поиграть» – по клубам из данных, кнопка в /schedule/?game=,
// один H1, индекс на бою, в карте сайта – только игры со страницей.
import { expect, test } from '../../../tests/support/e2e.ts';
import { PROD_PORT } from '../playwright.config.ts';

const PROD = `http://127.0.0.1:${PROD_PORT}`;

test('карточка: H1, текст, где поиграть по клубам, кнопки ≥ 44 px, 390 px без прокрутки', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/games/pc/counter-strike-2/');
  await expect(page.locator('h1')).toHaveText('Counter-Strike 2');
  await expect(page.locator('.gp__text strong')).toHaveText('командный');
  const where = page.getByTestId('game-where');
  await expect(where.getByRole('link', { name: 'Ю-Клуб на Красном' })).toHaveAttribute('href', '/novosibirsk/krasny-prospekt/');
  await expect(where.getByRole('link', { name: 'Ю-Клуб на Ленина' })).toHaveAttribute('href', '/tomsk/lenina/');
  await expect(where).toContainText('Турнирные ПК');
  const book = page.getByTestId('game-book');
  await expect(book).toHaveAttribute('href', '/schedule/?game=counter-strike-2');
  for (const b of [book, ...(await where.locator('.yu-btn').all())]) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(scroll).toBeLessThanOrEqual(client);
  await page.screenshot({ path: 'test-results/screens/390-game-card.png', fullPage: true });
});

test('без full – 404, плитка в каталоге без ссылки; чужое направление – 404; на бою индекс и canonical', async ({ request }) => {
  expect((await request.get(`${PROD}/games/pc/dota-2/`)).status()).toBe(404);
  expect((await request.get(`${PROD}/games/vr/counter-strike-2/`)).status()).toBe(404);
  const html = await (await request.get(`${PROD}/games/vr/alyx/?utm_source=x`)).text();
  expect((html.match(/<h1[\s>]/g) ?? []).length).toBe(1);
  expect(html).toContain('<title>Half-Life: Alyx – где поиграть в Ю-Клуб</title>');
  expect(html).toContain('<meta name="robots" content="index, follow">');
  expect(html).toContain('<link rel="canonical" href="https://yu-club.test/games/vr/alyx/">');
});

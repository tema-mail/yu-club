// S4-117: /games/ и каталоги направлений. Без выбора – «общий каталог сети», с выбором – только доступные в клубе с его заметкой;
// ?genre= фильтрует, canonical без параметра; две карточки в ряд на 390 px без горизонтальной прокрутки; неизвестное направление – 404.
import { expect, test, type Page } from '../../../tests/support/e2e.ts';
import { PROD_PORT } from '../playwright.config.ts';

const PROD = `http://127.0.0.1:${PROD_PORT}`;
const choose = (page: Page, value: string) => page.context().addCookies([{ name: 'yu_branch', value, url: `${new URL(page.url()).origin}/` }]);

test('390 px: хаб и каталог без горизонтальной прокрутки, две карточки в ряд', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ['/games/', '/games/pc/']) {
    await page.goto(path);
    const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    expect(scroll, path).toBeLessThanOrEqual(client);
    await page.screenshot({ path: `test-results/screens/390-${path.replaceAll('/', '_').replace(/^_|_$/g, '')}.png`, fullPage: true });
  }
  const [a, b] = await page.getByTestId('games').locator('li').all();
  expect((await a!.boundingBox())!.y).toBe((await b!.boundingBox())!.y);
});

test('хаб: три направления, без выбора – общий каталог сети; выбран клуб – только его игры', async ({ page }) => {
  await page.goto('/games/');
  await expect(page.locator('h1')).toHaveCount(1);
  await expect(page.getByTestId('games-scope')).toContainText('Общий каталог сети');
  await expect(page.getByTestId('dir-vr')).toContainText('Half-Life: Alyx, Beat Saber');
  await choose(page, 'tomsk/lenina');
  await page.goto('/games/');
  await expect(page.getByTestId('games-scope')).toContainText('Ю-Клуб на Ленина');
  await expect(page.getByTestId('dir-vr')).toContainText('Beat Saber');
  await expect(page.getByTestId('dir-vr')).not.toContainText('Alyx');
});

test('каталог: ссылка только у игры с полным описанием; выбран клуб – заметка клуба и чужих игр нет', async ({ page }) => {
  await page.goto('/games/pc/');
  await expect(page.locator('h1')).toHaveText('Игры на ПК');
  const list = page.getByTestId('games');
  await expect(list.getByRole('link', { name: 'Counter-Strike 2' })).toHaveAttribute('href', '/games/pc/counter-strike-2/');
  await expect(list.getByText('Dota 2')).toBeVisible();
  await expect(list.getByRole('link', { name: 'Dota 2' })).toHaveCount(0);
  await choose(page, 'tomsk/lenina');
  await page.goto('/games/pc/');
  await expect(list.getByText('Dota 2')).toHaveCount(0);
  await expect(page.getByTestId('game-note')).toHaveText('Турнирные ПК');
  await page.goto('/games/playstation/');
  await expect(list).toContainText('PS5');
});

test('жанр: ?genre= фильтрует, canonical без параметра, ссылки жанров ≥ 44 px; неизвестное направление – 404', async ({ page, request }) => {
  await page.goto('/games/vr/?genre=%D0%A0%D0%B8%D1%82%D0%BC');
  await expect(page.getByTestId('games')).toContainText('Beat Saber');
  await expect(page.getByTestId('games')).not.toContainText('Alyx');
  for (const chip of await page.locator('.games-genres__chip').all()) expect((await chip.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  const html = await (await request.get(`${PROD}/games/vr/?genre=x`)).text();
  expect(html).toContain('<link rel="canonical" href="https://yu-club.test/games/vr/">');
  expect(html).toContain('<meta name="robots" content="index, follow">');
  expect((await request.get(`${PROD}/games/xbox/`)).status()).toBe(404);
});

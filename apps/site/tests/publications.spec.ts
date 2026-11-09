// S4-111, S4-112: список и страница публикации на /news/. 390 и 1440 без горизонтальной прокрутки, один H1, охват словами,
// чужой филиал при выбранном клубе не показывается (K22 §4), неопубликованное и будущее – 404 с кодом 404, флаг indexable – noindex.
import { expect, test, type Page } from '../../../tests/support/e2e.ts';
import { PROD_PORT } from '../playwright.config.ts';

const PROD = `http://127.0.0.1:${PROD_PORT}`;
const h1Count = (html: string) => (html.match(/<h1[\s>]/g) ?? []).length;

async function noHorizontalScroll(page: Page, label: string) {
  const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(scroll, `${label}: горизонтальная прокрутка`).toBeLessThanOrEqual(client);
}

async function choose(page: Page, value: string) {
  await page.context().addCookies([{ name: 'yu_branch', value, url: `${new URL(page.url()).origin}/` }]);
}

for (const width of [390, 1440]) {
  test(`${width} px: список и страница новости без горизонтальной прокрутки, ссылки и кнопки не меньше 44 px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    for (const path of ['/news/', '/news/live-news/']) {
      await page.goto(path);
      await noHorizontalScroll(page, path);
      await page.screenshot({ path: `test-results/screens/${width}-${path.replaceAll('/', '_').replace(/^_|_$/g, '')}.png`, fullPage: true });
    }
    await page.goto('/news/');
    for (const link of await page.locator('.pub-card__link').all()) expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  });
}

test('список: без выбора – вся сеть, будущей нет; охват словами; один H1', async ({ page }) => {
  await page.goto('/news/');
  await expect(page.locator('h1')).toHaveCount(1);
  const list = page.getByTestId('publications');
  await expect(list.getByRole('link', { name: 'Живая новость' })).toHaveAttribute('href', '/news/live-news/');
  await expect(list.getByRole('link', { name: 'Новый зал в Томске' })).toBeVisible();
  await expect(list.getByRole('link', { name: 'Часы в Новосибирске' })).toBeVisible();
  await expect(list.getByText('Будущая новость')).toHaveCount(0);
  await expect(list.locator('li', { hasText: 'Живая новость' }).getByTestId('pub-scope')).toHaveText('Во всех клубах сети');
  await expect(list.locator('li', { hasText: 'Новый зал в Томске' }).getByTestId('pub-scope')).toHaveText('Только в клубе «Ю-Клуб на Ленина»');
  await expect(list.locator('li', { hasText: 'Часы в Новосибирске' }).getByTestId('pub-scope')).toHaveText('Только в городе Новосибирск');
});

test('выбран клуб: публикации чужого филиала и чужого города не показываются', async ({ page }) => {
  await page.goto('/news/');
  await choose(page, 'novosibirsk/krasny-prospekt');
  await page.goto('/news/');
  const list = page.getByTestId('publications');
  await expect(page.getByTestId('pub-filter')).toContainText('Ю-Клуб на Красном');
  await expect(list.getByText('Новый зал в Томске')).toHaveCount(0);
  await expect(list.getByText('Часы в Новосибирске')).toBeVisible();
  await choose(page, 'tomsk/lenina');
  await page.goto('/news/');
  await expect(list.getByText('Новый зал в Томске')).toBeVisible();
  await expect(list.getByText('Часы в Новосибирске')).toHaveCount(0);
  await expect(list.getByText('Живая новость')).toBeVisible();
});

test('страница: H1, текст из CMS очищен и со ссылкой, по ссылке чужого филиала – пометка «не действует»', async ({ page }) => {
  await page.goto('/news/live-news/');
  await expect(page.locator('h1')).toHaveText('Живая новость');
  await expect(page.locator('.pub__text strong')).toHaveText('всех');
  await expect(page.locator('.pub__text a[href="/schedule/"]')).toBeVisible();
  await expect(page.getByTestId('pub-not-here')).toHaveCount(0);
  await choose(page, 'novosibirsk/krasny-prospekt');
  await page.goto('/news/tomsk-opening/');
  await expect(page.getByTestId('pub-not-here')).toContainText('Только в клубе «Ю-Клуб на Ленина»');
});

test('неопубликованное, будущее и неизвестное – 404 с кодом 404; индексация по флагу CMS', async ({ request }) => {
  for (const path of ['/news/future-news/', '/news/nope/', '/news/summer-promo/']) {
    const res = await request.get(`${PROD}${path}`);
    expect(res.status(), path).toBe(404);
    expect(await res.text(), path).toContain('content="noindex, nofollow"');
  }
  const live = await (await request.get(`${PROD}/news/live-news/?utm_source=x`)).text();
  expect(h1Count(live)).toBe(1);
  expect(live).toContain('<title>Живая новость – Ю-Клуб</title>');
  expect(live).toContain('<meta name="robots" content="index, follow">');
  expect(live).toContain('<link rel="canonical" href="https://yu-club.test/news/live-news/">');
  expect(live).toContain('<meta property="og:type" content="article">');
  expect(live).toContain('"@type":"NewsArticle"');
  expect(await (await request.get(`${PROD}/news/nsk-hours/`)).text()).toContain('<meta name="robots" content="noindex, nofollow">');
  const hub = await (await request.get(`${PROD}/news/`)).text();
  expect(h1Count(hub)).toBe(1);
  expect(hub).toContain('<meta name="robots" content="index, follow">');
});

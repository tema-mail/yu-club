// e2e каркаса сайта (S1-18) на моке публичного API: ширины 390/1440, выбор клуба в куке, 404, 301 города,
// noindex на стенде и индексация на бою. Скриншоты – test-results/screens/ (их смотрит человек, не сравнение).
import { expect, test, type Page } from '../../../tests/support/e2e.ts';
import { PROD_PORT } from '../playwright.config.ts';

const PROD = `http://127.0.0.1:${PROD_PORT}`;
const PAGES = ['/', '/novosibirsk/', '/tomsk/lenina/', '/novosibirsk/akademgorodok/', '/rules/', '/nope/missing/'];

async function noHorizontalScroll(page: Page, label: string) {
  const { scroll, client } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(scroll, `${label}: горизонтальная прокрутка`).toBeLessThanOrEqual(client);
}

for (const width of [390, 1440]) {
  test(`${width} px: без горизонтальной прокрутки, поля 16 px на телефоне`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    for (const path of PAGES) {
      await page.goto(path);
      await noHorizontalScroll(page, path);
      const name = path === '/' ? 'home' : path.replaceAll('/', '_').replace(/^_|_$/g, '');
      await page.screenshot({ path: `test-results/screens/${width}-${name}.png`, fullPage: true });
    }
    // Открытый выбор клуба тоже не вылезает за экран.
    await page.goto('/tomsk/lenina/');
    await page.getByTestId('branch-picker').getByRole('button', { expanded: false }).click();
    await noHorizontalScroll(page, 'выбор открыт');
    await page.screenshot({ path: `test-results/screens/${width}-picker-open.png` });
    if (width === 390) {
      const left = await page.locator('.yu-main .yu-page').evaluate((el) => getComputedStyle(el).paddingLeft);
      expect(left).toBe('16px');
    }
  });
}

test('выбор клуба: кука yu_branch и переход на /{city}/{branch}/', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.getByTestId('branch-current')).toHaveText('Выберите клуб');
  await page.getByTestId('branch-picker').getByRole('button', { name: 'Выберите клуб' }).click();
  await page.getByRole('button', { name: /Ю-Клуб на Ленина/ }).click();
  await expect(page).toHaveURL(/\/tomsk\/lenina\/$/);

  const cookie = (await context.cookies()).find((c) => c.name === 'yu_branch');
  expect(cookie?.value).toBe('tomsk/lenina');
  expect(cookie?.sameSite).toBe('Lax');
  expect(cookie!.expires).toBeGreaterThan(Date.now() / 1000 + 300 * 24 * 3600);

  // Выбор помнит и шапка, и главная после перезахода.
  await expect(page.getByTestId('branch-current')).toHaveText('Ю-Клуб на Ленина');
  await page.goto('/');
  await expect(page.getByTestId('my-branch')).toHaveAttribute('href', '/tomsk/lenina/');
  await expect(page.getByTestId('branch-current')).toHaveText('Ю-Клуб на Ленина');

  // Мусор в куке – выбор просто не показывается.
  await context.addCookies([{ name: 'yu_branch', value: 'tomsk/../x', url: page.url() }]);
  await page.reload();
  await expect(page.getByTestId('branch-current')).toHaveText('Выберите клуб');
});

test('страница филиала: адрес и часы из API, временно закрытый – с плашкой и без часов', async ({ page }) => {
  await page.goto('/tomsk/lenina/');
  await expect(page.getByTestId('branch-title')).toHaveText('Ю-Клуб на Ленина');
  await expect(page.getByTestId('branch-address')).toHaveText('проспект Ленина, 80');
  await expect(page.getByTestId('branch-hours')).toHaveText('10:00–22:00');
  await expect(page.getByTestId('zone-pc')).toContainText('ПК 5');
  await expect(page.getByTestId('zone-vr')).toContainText('Комната VR+PS4');
  await expect(page.getByTestId('zone-ps')).toContainText('Комната PS5 3');
  await expect(page.getByTestId('branch-closed')).toHaveCount(0);

  // Работающий филиал без часов на сегодня (hoursToday: []) – «закрыто сегодня», страница 200, не 503.
  const res = await page.goto('/novosibirsk/krasny-prospekt/');
  expect(res?.status()).toBe(200);
  await expect(page.getByTestId('branch-hours')).toHaveText('Закрыто сегодня');
  await expect(page.getByTestId('zone-pc')).toBeVisible();

  await page.goto('/novosibirsk/akademgorodok/');
  await expect(page.getByTestId('branch-closed')).toBeVisible();
  await expect(page.getByTestId('branch-hours')).toHaveText('Временно закрыт');
});

test('несуществующий и готовящийся филиал, чужой город – 404 с кодом 404', async ({ page }) => {
  for (const path of ['/tomsk/nope/', '/novosibirsk/gorskiy/', '/omsk/', '/omsk/mira/', '/nope/missing/', '/a/b/c/d/']) {
    const res = await page.goto(path);
    expect(res?.status(), path).toBe(404);
    await expect(page.getByTestId('not-found'), path).toBeVisible();
    await expect(page.locator('meta[name="robots"]'), path).toHaveAttribute('content', 'noindex, nofollow');
  }
});

test('город с одним филиалом – 301 на филиал, с двумя – хаб', async ({ request, page }) => {
  const res = await request.get('/tomsk/', { maxRedirects: 0 });
  expect(res.status()).toBe(301);
  expect(res.headers().location).toBe('/tomsk/lenina/');

  await page.goto('/novosibirsk/');
  await expect(page.getByRole('link', { name: 'Ю-Клуб на Красном' })).toHaveAttribute('href', '/novosibirsk/krasny-prospekt/');
  await expect(page.getByRole('link', { name: 'Ю-Клуб Академгородок' })).toBeVisible();
});

test('стенд: noindex везде – мета, X-Robots-Tag, robots.txt, пустой sitemap', async ({ request }) => {
  for (const path of ['/', '/tomsk/lenina/', '/novosibirsk/', '/rules/']) {
    const res = await request.get(path);
    expect(res.headers()['x-robots-tag'], path).toBe('noindex, nofollow');
    expect(await res.text(), path).toContain('<meta name="robots" content="noindex, nofollow">');
  }
  const robots = await request.get('/robots.txt');
  expect(await robots.text()).toBe('User-agent: *\nDisallow: /\n');
  expect(robots.headers()['x-robots-tag']).toBe('noindex, nofollow');
  const sitemap = await (await request.get('/sitemap.xml')).text();
  expect(sitemap).not.toContain('<url>');
});

test('бой: индексация, canonical без параметров, robots и sitemap по карте сайта', async ({ request }) => {
  const page = await request.get(`${PROD}/tomsk/lenina/?utm_source=x&branch=1`);
  const html = await page.text();
  expect(page.headers()['x-robots-tag']).toBeUndefined();
  expect(html).toContain('<meta name="robots" content="index, follow">');
  expect(html).toContain('<link rel="canonical" href="https://yu-club.test/tomsk/lenina/">');

  // 404 и юридические закрыты и на бою.
  const missing = await request.get(`${PROD}/tomsk/nope/`);
  expect(missing.status()).toBe(404);
  expect(await missing.text()).toContain('content="noindex, nofollow"');
  expect(await (await request.get(`${PROD}/privacy-policy/`)).text()).toContain('content="noindex, nofollow"');

  const robots = await (await request.get(`${PROD}/robots.txt`)).text();
  expect(robots).toContain('Disallow: /account/');
  expect(robots).toContain('Disallow: /login/');
  expect(robots).toContain('Sitemap: https://yu-club.test/sitemap.xml');

  const sitemap = await (await request.get(`${PROD}/sitemap.xml`)).text();
  for (const loc of ['/', '/novosibirsk/', '/novosibirsk/krasny-prospekt/', '/novosibirsk/akademgorodok/', '/tomsk/lenina/', '/rules/']) {
    expect(sitemap, loc).toContain(`<loc>https://yu-club.test${loc}</loc>`);
  }
  // Город с одним филиалом – 301, его в карте нет; готовящийся филиал и город без открытых – тоже.
  for (const loc of ['/tomsk/</loc>', 'gorskiy', 'test/omsk/', '/?']) expect(sitemap, loc).not.toContain(loc);
});

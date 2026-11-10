// S4-116: /tournaments/ и /tournaments/{slug}/ на моке с турнирами (mock-content.ts): хаб делит живые турниры на «Ближайшие» и «Прошедшие»
// по дате турнира, дата – из eventDate; охват город/филиал (K22 §4); завершённый – плашка, noindex и не в списке; черновик, отложенный
// и неизвестный – 404 с кодом 404. Бой: хаб с материалом в индексе, title и canonical страницы, Event JSON-LD только у турнира одного клуба с датой.
import { expect, test, type Page } from '../../../tests/support/e2e.ts';
import { PROD_PORT } from '../playwright.config.ts';

const PROD = `http://127.0.0.1:${PROD_PORT}`;
const h1Count = (html: string) => (html.match(/<h1[\s>]/g) ?? []).length;

async function choose(page: Page, value: string) {
  await page.context().addCookies([{ name: 'yu_branch', value, url: `${new URL(page.url()).origin}/` }]);
}

test('390 px: ближайшие и прошедшие отдельно, дата турнира из данных, завершённого и отложенного нет; без горизонтальной прокрутки', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/tournaments/');
  await expect(page.locator('h1')).toHaveText('Турниры');
  await expect(page.getByTestId('publications-empty')).toHaveCount(0);
  const upcoming = page.getByTestId('publications');
  await expect(upcoming.locator('.pub-card__link')).toHaveText(['FIFA на Ленина', 'Кубок сети по Counter-Strike 2']);
  await expect(upcoming.locator('li', { hasText: 'FIFA на Ленина' }).locator('.pub-card__date')).toContainText('21 ноября 2026');
  await expect(upcoming.locator('li', { hasText: 'Кубок сети' }).locator('.pub-card__date')).toContainText('11 декабря 2026');
  await expect(upcoming.locator('li', { hasText: 'FIFA на Ленина' }).getByTestId('pub-scope')).toHaveText('Только в клубе «Ю-Клуб на Ленина»');
  const past = page.getByTestId('publications-past');
  await expect(past.locator('.pub-card__link')).toHaveText(['Осенний турнир по Dota 2']);
  await expect(past.locator('.pub-card__date')).toContainText('4 ноября 2026');
  await expect(past.getByTestId('pub-scope')).toHaveText('Только в городе Новосибирск');
  for (const t of ['Весенний кубок', 'Будущий турнир', 'ЧЕРНОВИК']) await expect(page.getByText(t)).toHaveCount(0);
  for (const path of ['/tournaments/', '/tournaments/cs2-cup-december/']) {
    await page.goto(path);
    const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    expect(scroll, path).toBeLessThanOrEqual(client);
    await page.screenshot({ path: `test-results/screens/390-${path.replaceAll('/', '_').replace(/^_|_$/g, '')}.png`, fullPage: true });
  }
});

test('выбран клуб: турнир чужого филиала и чужого города скрыт, сетевой виден везде; на странице чужого – пометка', async ({ page }) => {
  await page.goto('/tournaments/');
  await choose(page, 'novosibirsk/krasny-prospekt');
  await page.goto('/tournaments/');
  await expect(page.getByTestId('pub-filter')).toContainText('Ю-Клуб на Красном');
  await expect(page.getByText('FIFA на Ленина')).toHaveCount(0);
  await expect(page.getByTestId('publications').getByText('Кубок сети по Counter-Strike 2')).toBeVisible();
  await expect(page.getByTestId('publications-past').getByText('Осенний турнир по Dota 2')).toBeVisible();
  await choose(page, 'tomsk/lenina');
  await page.goto('/tournaments/');
  await expect(page.getByTestId('publications').getByText('FIFA на Ленина')).toBeVisible();
  await expect(page.getByText('Осенний турнир по Dota 2')).toHaveCount(0);
  await expect(page.getByTestId('publications-past')).toHaveCount(0);
  await choose(page, 'novosibirsk/krasny-prospekt');
  await page.goto('/tournaments/fifa-lenina/');
  await expect(page.getByTestId('pub-not-here')).toContainText('Только в клубе «Ю-Клуб на Ленина»');
});

test('страница: дата турнира из данных, итоги прошедшего – только из текста, кнопка только у предстоящего, формы нет', async ({ page }) => {
  await page.goto('/tournaments/cs2-cup-december/');
  await expect(page.locator('h1')).toHaveText('Кубок сети по Counter-Strike 2');
  await expect(page.getByTestId('pub-facts')).toContainText('Дата турнира');
  await expect(page.getByTestId('pub-facts')).toContainText('11 декабря 2026');
  await expect(page.getByTestId('pub-scope')).toHaveText('Во всех клубах сети');
  await expect(page.getByTestId('pub-cta')).toHaveText('Подать заявку');
  await expect(page.getByTestId('pub-cta')).toHaveAttribute('href', '/schedule/');
  await expect(page.getByTestId('pub-ended')).toHaveCount(0);
  await expect(page.locator('main form, main input, main textarea')).toHaveCount(0);
  await page.goto('/tournaments/dota-autumn/');
  await expect(page.getByTestId('pub-facts')).toContainText('4 ноября 2026');
  await expect(page.locator('.pub__text strong')).toHaveText('Итоги:');
  await expect(page.locator('.pub__text')).toContainText('1 место – команда «Север»');
  await expect(page.getByTestId('pub-cta')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Все турниры' })).toHaveAttribute('href', '/tournaments/');
});

test('завершённый – плашка, noindex, без кнопки и не в списке; черновик, отложенный и неизвестный – 404 с кодом 404', async ({ request }) => {
  const ended = await request.get(`${PROD}/tournaments/spring-cup/`);
  expect(ended.status()).toBe(200);
  const html = await ended.text();
  expect(html).toContain('Турнир завершён');
  expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
  expect(html).not.toContain('data-testid="pub-cta"');
  for (const path of ['/tournaments/draft-cup/', '/tournaments/future-cup/', '/tournaments/nope/']) {
    const res = await request.get(`${PROD}${path}`);
    expect(res.status(), path).toBe(404);
    expect(await res.text(), path).toContain('content="noindex, nofollow"');
  }
  const hub = await (await request.get(`${PROD}/tournaments/`)).text();
  for (const slug of ['spring-cup', 'future-cup', 'draft-cup']) expect(hub, slug).not.toContain(`/tournaments/${slug}/`);
});

test('бой: хаб с материалом в индексе и с одним H1; страница – title, canonical, og article; Event JSON-LD только у турнира одного клуба с датой', async ({ request }) => {
  const hub = await (await request.get(`${PROD}/tournaments/`)).text();
  expect(h1Count(hub)).toBe(1);
  expect(hub).toContain('<meta name="robots" content="index, follow">');
  expect(hub).toContain('<link rel="canonical" href="https://yu-club.test/tournaments/">');
  expect(hub).toContain('"@type":"BreadcrumbList"');
  const network = await (await request.get(`${PROD}/tournaments/cs2-cup-december/?utm_source=x`)).text();
  expect(h1Count(network)).toBe(1);
  expect(network).toContain('<title>Кубок сети по Counter-Strike 2 – Ю-Клуб</title>');
  expect(network).toContain('<link rel="canonical" href="https://yu-club.test/tournaments/cs2-cup-december/">');
  expect(network).toContain('<meta name="robots" content="index, follow">');
  expect(network).toContain('<meta property="og:type" content="article">');
  expect(network).not.toContain('"@type":"Event"'); // охват – вся сеть: одного места у события нет
  const club = await (await request.get(`${PROD}/tournaments/fifa-lenina/`)).text();
  expect(club).toContain('"@type":"Event"');
  expect(club).toContain('"startDate":"');
  expect(club).toContain('"location":{"@id":"https://yu-club.test/tomsk/lenina/#branch"}');
});

// Карта сайта 3.1: хаб филиала выводит публикации по охвату K22 §4 для своего филиала – сеть + его город + он сам (№208 ?branch=, limit 6),
// новые сверху, охват словами. Охват – по филиалу страницы, а не по выбору посетителя (кука yu_branch). Публикаций нет – блока нет совсем.
import { expect, test, type APIRequestContext, type Page } from '../../../tests/support/e2e.ts';

const MOCK = process.env.MOCK_URL!;
const setPublications = (request: APIRequestContext, publications: 'full' | 'empty') => request.post(`${MOCK}/__mock/content`, { data: { publications } });
const block = (page: Page) => page.getByTestId('branch-publications');
const titles = (page: Page) => block(page).locator('.pub-card__title');

test('хаб Красного: сеть и Новосибирск, без публикаций Ленина; не больше 6, новые сверху; 390 px без прокрутки', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/novosibirsk/krasny-prospekt/');
  await expect(block(page).getByRole('heading', { level: 2 })).toHaveText('Новости и акции клуба');
  await expect(titles(page)).toHaveCount(6);
  await expect(titles(page).first()).toHaveText('Розыгрыш с правилами в PDF');
  await expect(block(page).getByRole('link', { name: 'Часы в Новосибирске' })).toHaveAttribute('href', '/news/nsk-hours/');
  await expect(block(page).locator('li', { hasText: 'Часы в Новосибирске' }).getByTestId('pub-scope')).toHaveText('Только в городе Новосибирск');
  await expect(block(page).getByRole('link', { name: 'Осенний розыгрыш' })).toHaveAttribute('href', '/giveaways/autumn-giveaway/');
  await expect(block(page).locator('li', { hasText: 'Живая новость' }).getByTestId('pub-scope')).toHaveText('Во всех клубах сети');
  await expect(block(page)).not.toContainText('Новый зал в Томске');
  await expect(block(page)).not.toContainText('FIFA на Ленина');
  await expect(page.locator('h1')).toHaveCount(1);
  const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(scroll).toBeLessThanOrEqual(client);
});

test('хаб Ленина: публикации своего клуба и сети; выбор посетителя (Ленина) не переносится на хаб Красного', async ({ page }) => {
  await page.goto('/tomsk/lenina/');
  await expect(titles(page).first()).toHaveText('Новый зал в Томске');
  await expect(block(page).locator('li', { hasText: 'FIFA на Ленина' }).getByTestId('pub-scope')).toHaveText('Только в клубе «Ю-Клуб на Ленина»');
  await expect(block(page)).not.toContainText('Часы в Новосибирске');
  await page.context().addCookies([{ name: 'yu_branch', value: 'tomsk/lenina', url: `${new URL(page.url()).origin}/` }]);
  await page.goto('/novosibirsk/krasny-prospekt/');
  await expect(block(page)).toContainText('Часы в Новосибирске');
  await expect(block(page)).not.toContainText('Новый зал в Томске');
});

test('публикаций нет – блока нет, хаб работает', async ({ page, request }) => {
  await setPublications(request, 'empty');
  try {
    await page.goto('/novosibirsk/krasny-prospekt/');
    await expect(page.getByTestId('zone-pc')).toBeVisible();
    await expect(block(page)).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Новости и акции клуба' })).toHaveCount(0);
  } finally {
    await setPublications(request, 'full');
  }
});

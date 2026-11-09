// S4-89: панель SEO в редакторе (K23 §3–§5): адрес с проверкой и подсказкой из заголовка, «старый адрес будет вести на новый» у опубликованного,
// счётчики title/description (> 70 – предупреждение, > 120 – ошибка), флаг индексации, вид сниппета, прежние адреса после публикации.
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

test('подсказка адреса из заголовка, занятый адрес – свободный вариант, сниппет', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, `/content/publications/${CONTENT_IDS.pubBranch}`);
  const seo = page.getByTestId('seo-panel');
  await seo.getByRole('button', { name: 'Подставить из заголовка' }).click();
  await expect(seo.getByLabel('Адрес страницы')).toHaveValue('novye-kresla-krasnom');
  await expect(page.getByTestId('seo-snippet')).toContainText('yu-club.ru/news/novye-kresla-krasnom/');
  await expect(page.getByTestId('seo-snippet')).toContainText('Новые кресла на Красном – Ю-Клуб');
  await seo.getByLabel('Адрес страницы').fill('tournament-season');
  await seo.getByLabel('Адрес страницы').blur();
  await expect(seo.locator('#seo-slug-error')).toHaveText('Адрес занят. Свободный: tournament-season-2');
  await seo.getByRole('button', { name: 'Взять tournament-season-2' }).click();
  await expect(seo.getByLabel('Адрес страницы')).toHaveValue('tournament-season-2');
  await expect(seo.locator('#seo-slug-error')).toHaveCount(0);
  await seo.getByLabel('Показывать в поиске (индексировать)').uncheck();
  await expect(page.getByTestId('seo-snippet')).toContainText('Не индексируется');
  await page.getByRole('button', { name: 'Сохранить черновик' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Черновик сохранён' })).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('seo-panel').getByLabel('Адрес страницы')).toHaveValue('tournament-season-2');
  await expect(page.getByTestId('seo-panel').getByLabel('Показывать в поиске (индексировать)')).not.toBeChecked();
});

test('счётчики: > 70 – предупреждение, > 120 – ошибка и черновик не сохраняется', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, `/content/publications/${CONTENT_IDS.pubCity}`);
  const title = page.getByTestId('seo-panel').getByLabel('Title');
  await title.fill('а'.repeat(75));
  await expect(page.locator('#seo-seoTitle-count')).toHaveClass(/yc-ct__count--warn/);
  await expect(page.locator('#seo-seoTitle-count')).toContainText('длиннее 70');
  await title.fill('а'.repeat(125));
  await expect(page.locator('#seo-seoTitle-count')).toHaveClass(/yc-ct__count--error/);
  await page.getByRole('button', { name: 'Сохранить черновик' }).click();
  await expect(page.locator('#seo-seoTitle-error')).toHaveText('Не длиннее 120 знаков');
  await expect(page.getByRole('status').filter({ hasText: 'сократите отмеченные поля SEO' })).toBeVisible();
  await page.getByTestId('seo-panel').getByLabel('Description').fill('б'.repeat(170));
  await expect(page.locator('#seo-seoDescription-count')).toHaveClass(/yc-ct__count--warn/);
});

test('смена адреса опубликованного: предупреждение, после публикации – прежний адрес в истории', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, `/content/publications/${CONTENT_IDS.pubNetwork}`);
  const seo = page.getByTestId('seo-panel');
  await expect(page.getByTestId('seo-moved')).toHaveCount(0);
  await seo.getByLabel('Адрес страницы').fill('tournament-season-2026');
  await expect(page.getByTestId('seo-moved')).toContainText('старый адрес /tournament-season/ будет вести на новый');
  await page.getByRole('button', { name: 'Сохранить черновик' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Черновик сохранён' })).toBeVisible();
  await page.getByRole('button', { name: 'Опубликовать…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Опубликовать' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Опубликовано' })).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('seo-panel')).toContainText('Прежние адреса (ведут сюда): tournament-season');
  await expect(page.getByTestId('seo-moved')).toHaveCount(0);
});

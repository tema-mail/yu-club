// Остаток S4-84…S4-89 на сайте (K23 §4, K22 §8): ручные SEO-поля CMS важнее шаблона – у главной (баннер hero), игры и /rules/;
// фото, очищенное по требованию субъекта (№227а), – страница 200 без картинки и без адреса файла, в тексте – «изображение удалено».
import { expect, test, type APIRequestContext } from '../../../tests/support/e2e.ts';
import { MOCK_PORT, PROD_PORT } from '../playwright.config.ts';

const PROD = `http://127.0.0.1:${PROD_PORT}`;
const html = async (request: APIRequestContext, path: string) => (await request.get(`${PROD}${path}`)).text();
// Главная – на стенде: у него кэш контента выключен (playwright.config), переключатель мока виден сразу; у боя кэш 60 с.
const stage = async (request: APIRequestContext, path: string) => (await request.get(path)).text();
const setHome = (request: APIRequestContext, home: 'full' | 'seo') => request.post(`http://127.0.0.1:${MOCK_PORT}/__mock/content`, { data: { home } });

test('главная: ручные title, description, H1 и og:image баннера hero вместо шаблона; без них – шаблон', async ({ request }) => {
  await setHome(request, 'seo');
  try {
    const s = await stage(request, '/');
    expect(s).toContain('<title>Ю-Клуб – игровые клубы рядом с домом</title>');
    expect(s).toContain('<meta name="description" content="Компьютеры, VR и PlayStation 5: запись онлайн.">');
    expect(s).toMatch(/<meta property="og:image" content="[^"]*\/media\/aa\/61\/img-1600\.jpg">/);
    expect(s).toMatch(/<h1[^>]*>Играй с друзьями – Ю-Клуб<\/h1>/);
    expect((s.match(/<h1[\s>]/g) ?? []).length).toBe(1);
  } finally {
    await setHome(request, 'full');
  }
  const t = await stage(request, '/');
  expect(t).toContain('<title>Ю-Клуб – компьютерный клуб: ПК, VR, PlayStation</title>');
  expect(t).toMatch(/<h1[^>]*>Играй с друзьями в Ю-Клуб<\/h1>/);
});

test('игра и /rules/: ручные SEO-поля из CMS; canonical – адрес страницы', async ({ request }) => {
  const g = await html(request, '/games/playstation/gran-turismo-7/');
  expect(g).toContain('<title>Gran Turismo 7 на PS5 с рулём – Ю-Клуб на Ленина</title>');
  expect(g).toContain('<meta name="description" content="Гоночный симулятор на руле Logitech.">');
  expect(g).toMatch(/<h1[^>]*>Gran Turismo 7 с рулём<\/h1>/);
  expect(g).toContain('<meta property="og:image" content="https://yu-club.test/media/aa/55/img-1600.jpg">');
  expect(g).toContain('<link rel="canonical" href="https://yu-club.test/games/playstation/gran-turismo-7/">');
  const r = await html(request, '/rules/');
  expect(r).toContain('<title>Правила посещения клуба – Ю-Клуб</title>');
  expect(r).toMatch(/<h1[^>]*>Правила посещения<\/h1>/);
  expect(r).toContain('<link rel="canonical" href="https://yu-club.test/rules/">');
});

test('очищенное фото: публикация 200 без обложки и адреса файла, в тексте – «изображение удалено»; в списке карточка без картинки', async ({ page, request }) => {
  const res = await request.get(`${PROD}/news/photo-removed/`);
  expect(res.status()).toBe(200);
  const s = await res.text();
  expect(s).not.toContain('aaaaaaaa-0000-4000-8000-000000000005');
  expect(s).not.toContain('/media/aa/05/');
  await page.goto('/news/photo-removed/');
  await expect(page.locator('h1')).toHaveText('Турнир прошёл');
  await expect(page.locator('.pub__cover')).toHaveCount(0);
  await expect(page.locator('.media-removed')).toHaveText('изображение удалено');
  await page.goto('/news/');
  const card = page.getByRole('listitem').filter({ hasText: 'Турнир прошёл' });
  await expect(card).toBeVisible();
  await expect(card.locator('img')).toHaveCount(0);
});

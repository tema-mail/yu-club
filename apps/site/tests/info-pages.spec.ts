// S4-120: /about/, /rules/ и юридические из CMS через внутреннюю подмену на /info/{key}/. Прямой /info/… – 301 на канонический;
// неопубликованная юридическая – «Документ готовится» и noindex; текст из CMS очищен; один H1; 390 px без прокрутки.
import { expect, test } from '../../../tests/support/e2e.ts';
import { PROD_PORT } from '../playwright.config.ts';

const PROD = `http://127.0.0.1:${PROD_PORT}`;

test('/about/ и /rules/: текст из CMS, один H1, индекс на бою, canonical – канонический адрес', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/about/');
  await expect(page.locator('h1')).toHaveText('О клубе');
  await expect(page.getByTestId('info-page').locator('strong')).toHaveText('ПК, VR и PlayStation');
  const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(scroll).toBeLessThanOrEqual(client);
  await page.goto('/rules/');
  await expect(page.getByTestId('info-page')).toContainText('Отмена – не позже чем за 2 часа.');
  for (const path of ['/about/', '/rules/']) {
    const html = await (await request.get(`${PROD}${path}`)).text();
    expect(html, path).toContain('<meta name="robots" content="index, follow">');
    expect(html, path).toContain(`<link rel="canonical" href="https://yu-club.test${path}">`);
    expect((html.match(/<h1[\s>]/g) ?? []).length, path).toBe(1);
  }
});

test('юридические: опубликованная – текст и редакция, неопубликованная – «Документ готовится»; все noindex на бою', async ({ page, request }) => {
  await page.goto('/privacy-policy/');
  await expect(page.getByTestId('info-page')).toContainText('Оператор – ООО «Ю-Клуб».');
  await expect(page.getByTestId('doc-version')).toContainText('privacy-policy-2026-11-01');
  await page.goto('/personal-data-consent/');
  await expect(page.getByTestId('doc-pending')).toHaveText('Документ готовится и появится здесь до открытия онлайн-записи.');
  for (const path of ['/privacy-policy/', '/personal-data-consent/', '/cookie-policy/', '/advertising-consent/']) {
    const res = await request.get(`${PROD}${path}`);
    expect(res.status(), path).toBe(200);
    expect(await res.text(), path).toContain('<meta name="robots" content="noindex, nofollow">');
  }
});

test('прямой /info/… – 301 на канонический одним переходом; неизвестный ключ – 404', async ({ request }) => {
  for (const [from, to] of [['/info/about/', '/about/'], ['/info/privacy-policy/', '/privacy-policy/'], ['/info/rules/?x=1', '/rules/?x=1']]) {
    const res = await request.get(`${PROD}${from}`, { maxRedirects: 0 });
    expect(res.status(), from).toBe(301);
    expect(res.headers().location, from).toBe(to);
  }
  expect((await request.get(`${PROD}/info/contacts_intro/`, { maxRedirects: 0 })).status()).toBe(404);
  expect((await request.get(`${PROD}/info/nope/`, { maxRedirects: 0 })).status()).toBe(404);
});

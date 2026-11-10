// Оболочка сайта (S4-133, D4-47): меню шапки и подвала ведут на живые страницы, на 390 px меню – кнопкой без горизонтальной прокрутки.
import { expect, test, type Page } from '../../../tests/support/e2e.ts';

const HEADER = ['Клубы', 'Расписание', 'Игры', 'Акции', 'Турниры', 'День рождения', 'Контакты'];
const FOOTER_PATHS = ['/', '/schedule/', '/games/', '/promotions/', '/news/', '/giveaways/', '/tournaments/', '/birthday/', '/contacts/', '/sitemap/'];

async function noHorizontalScroll(page: Page, label: string) {
  const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(scroll, `${label}: горизонтальная прокрутка`).toBeLessThanOrEqual(client);
}

test('1440 px: меню строкой в шапке, порядок по D4-47, каждая ссылка – 200', async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  const nav = page.getByTestId('site-nav');
  await expect(page.getByTestId('nav-toggle')).toBeHidden();
  const links = nav.getByRole('link');
  await expect(links).toHaveText(HEADER);
  for (const href of await links.evaluateAll((as) => as.map((a) => a.getAttribute('href')!))) {
    expect((await request.get(href, { maxRedirects: 0 })).status(), href).toBe(200);
  }
  await expect(nav.getByRole('link', { name: 'Клубы' })).toHaveAttribute('aria-current', 'page');
  await noHorizontalScroll(page, '1440');

  // Активный раздел подсвечен и на вложенной странице.
  await page.goto('/games/pc/');
  await expect(nav.getByRole('link', { name: 'Игры' })).toHaveAttribute('aria-current', 'page');
  await expect(nav.getByRole('link', { name: 'Клубы' })).not.toHaveAttribute('aria-current', 'page');
});

test('1200 px: меню строкой помещается в шапку', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto('/tomsk/lenina/');
  await expect(page.getByTestId('site-nav').getByRole('link', { name: 'Контакты' })).toBeVisible();
  await noHorizontalScroll(page, '1200');
  const row = await page.locator('.yu-header__row').evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
  expect(row.scroll, 'шапка не вылезает за свою ширину').toBeLessThanOrEqual(row.client);
});

test('390 px: меню за кнопкой, открывается и закрывается, без горизонтальной прокрутки', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const toggle = page.getByTestId('nav-toggle');
  const nav = page.getByTestId('site-nav');
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(nav.getByRole('link', { name: 'Расписание' })).toBeHidden();
  await noHorizontalScroll(page, 'меню закрыто');

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(nav.getByRole('link')).toHaveText(HEADER);
  await noHorizontalScroll(page, 'меню открыто');
  await page.screenshot({ path: 'test-results/screens/390-menu-open.png' });

  await page.keyboard.press('Escape');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await nav.getByRole('link', { name: 'Контакты' }).click();
  await expect(page).toHaveURL(/\/contacts\/$/);
});

test('390 и 320 px: раскрытый список выбора клуба целиком в экране, без горизонтальной прокрутки', async ({ page }) => {
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/');
    const picker = page.getByTestId('branch-picker');
    await picker.getByRole('button', { name: 'Выберите клуб' }).click();
    const panel = picker.locator('.yu-picker__panel');
    await expect(panel.getByRole('button', { name: /Ю-Клуб на Ленина/ })).toBeVisible();
    const box = await panel.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right };
    });
    expect(box.left, `${width}: список уходит за левый край`).toBeGreaterThanOrEqual(0);
    expect(box.right, `${width}: список уходит за правый край`).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth), `${width}: ширина страницы`).toBeLessThanOrEqual(width);
    await page.screenshot({ path: `test-results/screens/${width}-picker-open.png` });
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
  }
});

test('подвал: все разделы, карта сайта и юридические страницы – 200', async ({ page, request }) => {
  await page.goto('/');
  const footerNav = page.getByTestId('footer-nav').getByRole('link');
  expect(await footerNav.evaluateAll((as) => as.map((a) => a.getAttribute('href')))).toEqual(FOOTER_PATHS);
  const all = await page.locator('footer a').evaluateAll((as) => as.map((a) => a.getAttribute('href')!));
  for (const href of ['/rules/', '/privacy-policy/', '/personal-data-consent/', '/cookie-policy/', '/advertising-consent/']) expect(all).toContain(href);
  for (const href of all) {
    expect((await request.get(href, { maxRedirects: 0 })).status(), href).toBe(200);
  }
});

test('фавикон: ссылки в head и файлы отдаются с нужным типом', async ({ page, request }) => {
  await page.goto('/');
  const icons = await page.locator('head link[rel="icon"], head link[rel="apple-touch-icon"]').evaluateAll((ls) => ls.map((l) => l.getAttribute('href')));
  expect(icons).toEqual(['/favicon.ico', '/favicon.svg', '/apple-touch-icon.png']);
  const types: Record<string, RegExp> = { '/favicon.ico': /image\/(x-icon|vnd\.microsoft\.icon)/, '/favicon.svg': /image\/svg\+xml/, '/apple-touch-icon.png': /image\/png/ };
  for (const [href, type] of Object.entries(types)) {
    const res = await request.get(href);
    expect(res.status(), href).toBe(200);
    expect(res.headers()['content-type'], href).toMatch(type);
    expect((await res.body()).length, href).toBeGreaterThan(200);
  }
});

test('390 px: основной текст абзацев – не меньше 16 px; мелкие подписи (дата, охват) не в счёт', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ['/', '/giveaways/', '/promotions/', '/news/', '/news/tomsk-opening/', '/tournaments/']) {
    await page.goto(path);
    const small = await page.locator('main p, main li > p').evaluateAll((ps) =>
      ps
        .filter((p) => !p.matches('.pub-card__date, .pub-card__scope, .pub__meta') && (p.textContent ?? '').trim().length > 20)
        .filter((p) => parseFloat(getComputedStyle(p).fontSize) < 15.9)
        .map((p) => `${getComputedStyle(p).fontSize} ${p.className}: ${(p.textContent ?? '').trim().slice(0, 40)}`),
    );
    expect(small, path).toEqual([]);
  }
  // Карточки публикаций на главной и в списках действительно проверены, а не пропущены.
  await page.goto('/news/');
  await expect(page.locator('.pub-card__lead').first()).toHaveCSS('font-size', /^1[6-9]/);
});

test('404: код 404 и ссылка на контакты', async ({ page }) => {
  const res = await page.goto('/nope/missing/');
  expect(res?.status()).toBe(404);
  const link = page.getByTestId('not-found').getByRole('link', { name: 'Контакты' });
  await expect(link).toHaveAttribute('href', '/contacts/');
  await link.click();
  await expect(page).toHaveURL(/\/contacts\/$/);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
});

// «Выбрать время» (ТЗ 19 §4.1–4.2, D4-66): главная, хаб филиала и комната – кнопка в первом экране и на телефоне липкая панель внизу.
// Ведёт в /schedule/ с клубом (у комнаты – и зона с комнатой), ответ 200; на 390 px панель видна без прокрутки, страница без
// горизонтальной прокрутки; с 900 px панели нет, кнопка первого экрана видна без прокрутки; у временно закрытого клуба записи нет.
import { expect, test, type Page } from '../../../tests/support/e2e.ts';

const CASES = [
  { path: '/', href: '/schedule/', lands: 'schedule-branches' },
  { path: '/tomsk/lenina/', href: '/schedule/?branch=tomsk/lenina', lands: 'schedule' },
  { path: '/novosibirsk/krasny-prospekt/rooms/vr-ps4-room/', href: '/schedule/?branch=novosibirsk/krasny-prospekt&zone=vr&room=vr-ps4-room', lands: 'room-filter' },
];
const endsWith = (href: string) => new RegExp(`${href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);

async function noHorizontalScroll(page: Page, label: string) {
  const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(scroll, `${label}: горизонтальная прокрутка`).toBeLessThanOrEqual(client);
}

test('390 px: кнопка в первом экране и липкая панель видна без прокрутки; ведёт в расписание с клубом и комнатой – 200', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const c of CASES) {
    await page.goto(c.path);
    await expect(page.locator('.yu-hero').getByRole('link', { name: 'Выбрать время' }), c.path).toHaveAttribute('href', c.href);
    const cta = page.getByTestId('time-cta');
    await expect(cta).toHaveAttribute('href', c.href);
    await expect(cta).toBeVisible();
    expect(await page.evaluate(() => scrollY), `${c.path}: страница не прокручена`).toBe(0);
    const box = (await cta.boundingBox())!;
    expect(box.y, `${c.path}: панель выше верхнего края`).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height, `${c.path}: панель в экране без прокрутки`).toBeLessThanOrEqual(844);
    expect(box.height, `${c.path}: касание 44 px`).toBeGreaterThanOrEqual(44);
    await noHorizontalScroll(page, c.path);
    if (c.path === '/tomsk/lenina/') await page.screenshot({ path: 'test-results/screens/390-time-cta.png' });
    expect((await request.get(c.href)).status(), c.href).toBe(200);
    await cta.click();
    await expect(page).toHaveURL(endsWith(c.href));
    await expect(page.getByTestId(c.lands)).toBeVisible();
  }
  await expect(page.getByTestId('room-filter')).toHaveText('Комната VR+PS4');
});

test('главная с выбранным клубом (кука yu_branch): кнопка и панель ведут в расписание этого клуба', async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: 'yu_branch', value: 'tomsk/lenina', url: baseURL! }]);
  await page.goto('/');
  await expect(page.getByTestId('home-book')).toHaveAttribute('href', '/schedule/?branch=tomsk/lenina');
  await expect(page.getByTestId('time-cta')).toHaveAttribute('href', '/schedule/?branch=tomsk/lenina');
});

test('1440 px: панели нет, кнопка первого экрана видна без прокрутки', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const c of CASES) {
    await page.goto(c.path);
    await expect(page.getByTestId('time-cta'), c.path).toBeHidden();
    const button = page.locator('.yu-hero').getByRole('link', { name: 'Выбрать время' });
    await expect(button).toBeVisible();
    const box = (await button.boundingBox())!;
    expect(box.y + box.height, `${c.path}: кнопка в первом экране`).toBeLessThanOrEqual(900);
  }
});

test('временно закрытый клуб: ни кнопки, ни панели – на хабе и в комнате', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ['/novosibirsk/akademgorodok/', '/novosibirsk/akademgorodok/rooms/pc-zone/']) {
    await page.goto(path);
    await expect(page.getByRole('status'), path).toContainText('Клуб временно закрыт');
    await expect(page.getByTestId('time-cta'), path).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Выбрать время' }), path).toHaveCount(0);
  }
});

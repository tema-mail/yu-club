// e2e карточек комнат (S1-21) на моке tests/mock-resources.ts: страница комнаты из ресурсов филиала, крошки и canonical,
// без вместимости (12 §7.1), 404 на архивную и несуществующую комнату, 301 с /rooms/, переход в расписание с предвыбором
// зоны и комнаты, пустое состояние филиала без комнат, закрытый клуб без записи, sitemap на бою, 390 без прокрутки.
import { expect, test } from '@playwright/test';
import { MOCK_PORT, PROD_PORT, STAGE_PORT } from '../playwright.config.ts';

test.use({ baseURL: `http://localhost:${STAGE_PORT}` });

const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const KRASNY = '0b0b0000-0000-4000-8000-000000000011';
const VR_ROOM = '/novosibirsk/krasny-prospekt/rooms/vr-ps4-room/';

test.beforeEach(async ({ request }) => {
  await request.post(`${MOCK}/__test/booking-reset`);
  await request.post(`${MOCK}/__test/resources-empty`, { data: { branchId: null } });
});

test('карточка комнаты: заголовок, крошки, canonical, места по отдельности, без вместимости', async ({ page }) => {
  const res = await page.goto(VR_ROOM);
  expect(res?.status()).toBe(200);
  await expect(page).toHaveTitle('Комната VR+PS4 – Ю-Клуб на Красном');
  await expect(page.getByTestId('room-title')).toHaveText('Комната VR+PS4');
  const crumbs = page.getByRole('list', { name: 'Навигация' });
  await expect(crumbs.getByRole('listitem')).toHaveText(['Главная', 'Новосибирск', 'Ю-Клуб на Красном', 'Комнаты', 'Комната VR+PS4']);
  await expect(crumbs.getByRole('link', { name: 'Комнаты' })).toHaveAttribute('href', '/novosibirsk/krasny-prospekt/#rooms');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', new RegExp(`${VR_ROOM}$`));
  await expect(page.getByTestId('room-zones')).toHaveText('VR и PS4');
  const formats = page.getByTestId('room-formats');
  await expect(formats).toContainText('VR 1');
  await expect(formats).toContainText('каждое бронируется независимо');
  await expect(formats).toContainText('вся комната целиком');
  await expect(page.locator('main')).not.toContainText(/вместим|человек|гост[ея]й до/i);
  await expect(page.getByRole('link', { name: 'Комната PS5 1' })).toHaveAttribute('href', '/novosibirsk/krasny-prospekt/rooms/ps5-room-1/');
});

test('404 на архивную и несуществующую комнату, 301 с /rooms/', async ({ page, request }) => {
  for (const path of ['/novosibirsk/krasny-prospekt/rooms/kosmos/', '/novosibirsk/krasny-prospekt/rooms/net-takoy/', '/novosibirsk/gorskiy/rooms/pc-zone/']) {
    const res = await page.goto(path);
    expect(res?.status(), path).toBe(404);
    await expect(page.getByTestId('not-found')).toBeVisible();
  }
  const r = await request.get('/novosibirsk/krasny-prospekt/rooms/', { maxRedirects: 0 });
  expect(r.status()).toBe(301);
  expect(r.headers().location).toBe('/novosibirsk/krasny-prospekt/#rooms');
});

test('филиал → комната → «Записаться»: расписание с предвыбором комнаты, места по отдельности', async ({ page }) => {
  await page.goto('/novosibirsk/krasny-prospekt/');
  await expect(page.getByTestId('zone-vr').getByRole('link', { name: 'Записаться' })).toHaveAttribute('href', '/schedule/?branch=novosibirsk/krasny-prospekt&zone=vr');
  await page.getByRole('link', { name: 'Комната VR+PS4' }).click();
  await expect(page).toHaveURL(new RegExp(`${VR_ROOM}$`));
  await page.getByTestId('room-book').click();
  await expect(page).toHaveURL(/\/schedule\/\?branch=novosibirsk\/krasny-prospekt&zone=vr&room=vr-ps4-room$/);
  await expect(page.getByTestId('room-filter')).toHaveText('Комната VR+PS4');
  await page.getByRole('button', { name: /^Завтра/ }).click();
  await expect(page.getByRole('button', { name: 'VR 1, 10:00–10:15, свободно', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Вся комната, 10:00–10:30, свободно', exact: true })).toBeVisible();
  await expect(page.locator('.yu-sched__res')).toHaveText(['VR 1', 'VR 2', 'Вся комната']);
  await page.getByRole('button', { name: 'Все зоны' }).click();
  await expect(page.locator('.yu-sched__res').first()).toHaveText('ПК 1');
});

test('пустое состояние: у филиала нет опубликованных комнат; закрытый клуб – карточка без записи', async ({ page, request }) => {
  await request.post(`${MOCK}/__test/resources-empty`, { data: { branchId: KRASNY } });
  await page.goto('/novosibirsk/krasny-prospekt/');
  await expect(page.getByTestId('zones-empty')).toContainText('Комнаты клуба пока не опубликованы');
  expect((await page.goto('/novosibirsk/krasny-prospekt/rooms/pc-zone/'))?.status()).toBe(404);
  await request.post(`${MOCK}/__test/resources-empty`, { data: { branchId: null } });

  await page.goto('/novosibirsk/akademgorodok/rooms/pc-zone/');
  await expect(page.getByTestId('room-closed')).toBeVisible();
  await expect(page.getByTestId('room-book')).toHaveCount(0);
});

test('бой: карточки комнат в sitemap.xml, архивной нет', async ({ request }) => {
  const sitemap = await (await request.get(`http://127.0.0.1:${PROD_PORT}/sitemap.xml`)).text();
  expect(sitemap).toContain(`<loc>https://yu-club.test${VR_ROOM}</loc>`);
  expect(sitemap).toContain('<loc>https://yu-club.test/tomsk/lenina/rooms/pc-zone/</loc>');
  expect(sitemap).not.toContain('kosmos');
});

test('390 px: карточка комнаты без горизонтальной прокрутки, кнопки ≥ 44 px', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(VR_ROOM);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const small = await page.locator('main .yu-btn').evaluateAll((els) => els.filter((el) => el.getBoundingClientRect().height < 44).length);
  expect(small).toBe(0);
  await page.screenshot({ path: 'test-results/room-390.png', fullPage: true });
});

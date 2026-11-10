// S4-121: хаб филиала и карточка комнаты с контентом CMS. Часы – из network (TC-17), кнопка записи та же; без страницы CMS – только факты;
// адрес, координаты и фото из CMS – в разметке; 390 px без горизонтальной прокрутки.
import { expect, test, type Page } from '../../../tests/support/e2e.ts';
import { PROD_PORT } from '../playwright.config.ts';

const PROD = `http://127.0.0.1:${PROD_PORT}`;
const noScroll = async (page: Page) => {
  const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(scroll).toBeLessThanOrEqual(client);
};

test('TC-17: часы филиала на сайте – из графика network, запись той же кнопкой; хаб с контентом: описание, особенности, как добраться, галерея', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/tomsk/lenina/');
  const box = page.getByTestId('branch-content');
  await expect(box.locator('strong')).toHaveText('второй этаж');
  await expect(page.getByTestId('branch-features')).toContainText('Парковка у входа');
  await expect(page.getByTestId('branch-how')).toContainText('домофон 12');
  await expect(page.getByTestId('branch-gallery').locator('img')).toHaveCount(2);
  await expect(page.getByTestId('branch-hours')).toHaveText('10:00–22:00');
  await expect(page.getByTestId('branch-book')).toHaveAttribute('href', '/schedule/?branch=tomsk/lenina');
  await expect(page.locator('h1')).toHaveCount(1);
  await noScroll(page);
  await page.screenshot({ path: 'test-results/screens/390-branch-content.png', fullPage: true });
});

test('без страницы CMS – факты без пустых блоков', async ({ page }) => {
  await page.goto('/novosibirsk/krasny-prospekt/');
  await expect(page.getByTestId('branch-content')).toHaveCount(0);
  await expect(page.getByTestId('zone-pc')).toBeVisible();
  await expect(page.getByTestId('branch-hours')).toHaveText('Закрыто сегодня');
});

test('разметка филиала: адрес и координаты из CMS, фото; часы – из графика', async ({ request }) => {
  const html = await (await request.get(`${PROD}/tomsk/lenina/`)).text();
  expect(html).toContain('"postalCode":"634050"');
  expect(html).toContain('"latitude":56.4847');
  expect(html).toContain('"openingHoursSpecification"');
  expect(html).toMatch(/"image":\["https:\/\/yu-club\.test\/media\//);
});

test('комната с контентом: описание, особенности, форматы текстом; запись та же; разметка с описанием', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/novosibirsk/krasny-prospekt/rooms/vr-ps4-room/');
  await expect(page.getByTestId('room-content').locator('strong')).toHaveText('два VR-шлема');
  await expect(page.getByTestId('room-features')).toContainText('Два шлема Quest 3');
  await expect(page.getByTestId('room-rent-text')).toContainText('всю комнату');
  await expect(page.getByTestId('room-book')).toHaveAttribute('href', '/schedule/?branch=novosibirsk/krasny-prospekt&zone=vr&room=vr-ps4-room');
  await noScroll(page);
  const html = await (await request.get(`${PROD}/novosibirsk/krasny-prospekt/rooms/vr-ps4-room/`)).text();
  expect(html).toContain('<meta name="description" content="Комната на 10 гостей: два VR-шлема и PS4.">');
  await page.goto('/novosibirsk/krasny-prospekt/rooms/pc-zone/');
  await expect(page.getByTestId('room-content')).toHaveCount(0);
});

// S4-87: страницы, юридические документы, блоки главной, страницы комнат и филиалов (K11 №221–223, №228; K22 §5, §7; 12 §5).
// Версия документа видна и неизменна (тот же номер с новым текстом – ошибка у поля), юридические публикует только Владелец, порядок блоков –
// кнопками (доступно с клавиатуры) и перетаскиванием, страница комнаты: Директор публикует, Администратор – только черновик.
import { expect, test, type Page } from '../../../tests/support/e2e.ts';
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
const publish = async (page: Page) => {
  await page.getByRole('button', { name: 'Опубликовать…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Опубликовать' }).click();
};


test('юридический документ: Директор только читает, версия видна; Владелец – тот же номер с новым текстом не публикуется', async ({ page, browser }) => {
  await login(page, 'director@yu.test');
  await open(page, '/content/pages');
  await page.getByRole('link', { name: 'Политика конфиденциальности' }).click();
  await expect(page.getByTestId('doc-version')).toContainText('privacy-policy-2026-10-01');
  await expect(page.getByText('Юридические документы публикует только Владелец.')).toBeVisible();
  await expect(page.getByLabel('Текст', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: /Опубликовать/ })).toHaveCount(0);

  const owner = await (await browser.newContext()).newPage();
  await login(owner, 'owner@yu.test');
  await open(owner, '/content/pages/privacy-policy');
  await owner.getByLabel('Текст', { exact: true }).fill('Оператор персональных данных – ООО «Ю-Клуб». Новый раздел о cookie.');
  await owner.getByRole('button', { name: 'Сохранить черновик' }).click();
  await expect(owner.getByRole('status').filter({ hasText: 'Черновик сохранён' })).toBeVisible();
  await publish(owner);
  await expect(owner.locator('#page-documentVersion-error')).toHaveText('Текст изменился – укажите новую версию документа');
  await expect(owner.getByTestId('doc-version')).toContainText('privacy-policy-2026-10-01');
  await owner.getByLabel('Версия документа').fill('privacy-policy-2026-11-10');
  await owner.getByRole('button', { name: 'Сохранить черновик' }).click();
  await expect(owner.getByRole('status').filter({ hasText: 'Черновик сохранён' })).toBeVisible();
  await publish(owner);
  await expect(owner.getByRole('status').filter({ hasText: 'Опубликовано' })).toBeVisible();
  await expect(owner.getByTestId('doc-version')).toContainText('privacy-policy-2026-11-10');
  const res = await owner.goto('/content/pages/privacy-policy?cityId=c-nsk');
  expect(res?.status()).toBe(404); // юридические – только сетевые
});

test('страница комнаты: Директор публикует, Администратор сохраняет черновик без публикации', async ({ page, browser }) => {
  await login(page, 'admin@yu.test');
  await open(page, '/content/pages');
  await page.getByRole('link', { name: 'Общий зал' }).click();
  await expect(page.getByText('Страницы ещё нет: она появится при первом сохранении.')).toBeVisible();
  await page.getByLabel('Описание', { exact: true }).fill('Двадцать игровых мест с мониторами 240 Гц.');
  await page.getByRole('button', { name: 'Сохранить черновик' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Черновик сохранён' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Опубликовать/ })).toHaveCount(0);

  const dir = await (await browser.newContext()).newPage();
  await login(dir, 'director@yu.test');
  await open(dir, '/content/pages/rooms/r-hall');
  await expect(dir.getByLabel('Описание', { exact: true })).toHaveValue('Двадцать игровых мест с мониторами 240 Гц.');
  await publish(dir);
  await expect(dir.getByRole('status').filter({ hasText: 'Опубликовано' })).toBeVisible();
  const foreign = await dir.goto('/content/pages/rooms/r-tsk-hall');
  expect(foreign?.status()).toBe(404);
});

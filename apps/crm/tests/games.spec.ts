// S4-86: каталог игр и доступность по филиалам (K11 №219–220; 12 §6). Директор меняет доступность своего филиала, карточку – нет;
// Владелец создаёт игру PlayStation – без платформ публикация не проходит (ошибка у поля); Администратор только видит.
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

test('Директор: доступность своего филиала меняет, карточку игры – нет', async ({ page }) => {
  await login(page, 'director@yu.test');
  await open(page, '/content/games');
  await expect(page.getByTestId('games-list').locator('tbody tr')).toHaveCount(2);
  await expect(page.getByRole('link', { name: /\+ Игра/ })).toHaveCount(0);
  await page.getByRole('link', { name: 'Counter-Strike 2' }).click();
  await expect(page.getByLabel('Название')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Сохранить черновик' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Опубликовать/ })).toHaveCount(0);
  const avail = page.getByTestId('game-avail');
  await expect(avail.locator('li')).toHaveCount(2); // зона Директора – филиалы Новосибирска; Томска нет
  const krasny = page.getByTestId('avail-b-nsk-krasny');
  await expect(krasny.getByLabel('Доступна')).toBeChecked();
  await krasny.getByLabel('Доступна').uncheck();
  await krasny.getByRole('textbox').fill('ремонт VR-зоны до пятницы');
  await krasny.getByRole('button', { name: 'Сохранить' }).click();
  await expect(krasny.getByRole('status')).toHaveText('Сохранено: игра недоступна в этом филиале.');
  await page.reload();
  await expect(page.getByTestId('avail-b-nsk-krasny').getByLabel('Доступна')).not.toBeChecked();
  await expect(page.getByTestId('avail-b-nsk-krasny').getByRole('textbox')).toHaveValue('ремонт VR-зоны до пятницы');
});

test('Администратор: доступность и карточка только для чтения', async ({ page }) => {
  await login(page, 'admin@yu.test');
  await open(page, `/content/games/${CONTENT_IDS.gameCs}`);
  await expect(page.getByTestId('avail-b-nsk-krasny').getByLabel('Доступна')).toBeDisabled();
  await expect(page.getByTestId('game-avail').getByRole('button', { name: 'Сохранить' })).toHaveCount(0);
});

test('Владелец: новая игра PlayStation – без платформ не публикуется, ошибка у поля', async ({ page }) => {
  await login(page, 'owner@yu.test');
  await open(page, '/content/games');
  await page.getByRole('link', { name: '+ Игра PlayStation' }).click();
  await page.getByLabel('Название').fill('Gran Turismo 7');
  await page.getByLabel('Коротко').fill('Автосимулятор.');
  await page.getByRole('button', { name: 'Сохранить черновик' }).click();
  await expect(page).toHaveURL(/\/content\/games\/[0-9a-f-]{36}\?created=1/);
  await page.getByRole('button', { name: 'Выбрать из медиатеки…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Выбрать: cs2-turnir.jpg' }).click();
  await page.getByRole('button', { name: 'Сохранить черновик' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Черновик сохранён' })).toBeVisible();
  await page.getByRole('button', { name: 'Опубликовать…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Опубликовать' }).click();
  await expect(page.locator('#game-platforms')).toHaveAttribute('aria-invalid', 'true');
  await page.getByLabel('Платформы').fill('PS5');
  await page.getByRole('button', { name: 'Сохранить черновик' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Черновик сохранён' })).toBeVisible();
  await page.getByRole('button', { name: 'Опубликовать…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Опубликовать' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Опубликовано' })).toBeVisible();
  await expect(page.getByText('Опубликовано', { exact: true })).toBeVisible();
});

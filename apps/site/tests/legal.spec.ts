// Юридическая проверка сайта (скилл юр-проверка-сайта, Россия, 152-ФЗ ст. 9, КоАП 13.11): документы в подвале и по адресу,
// галочка согласия везде пустая, со ссылкой на /personal-data-consent/, кнопка без неё неактивна; возраст (Q-34, умолчание):
// кабинет – от 14 лет, текст в той же галочке при входе и при входе в потоке записи; заявку на праздник оставляет взрослый (18 лет, Q-75:
// данные гостей не собираем). Серверные отказы без согласия – auth.spec, birthday.spec.
import { expect, test, type Page } from '../../../tests/support/e2e.ts';
import { MOCK_PORT, STAGE_PORT } from '../playwright.config.ts';
import { MOCK_CODE } from './mock-api.ts';

test.use({ baseURL: `http://localhost:${STAGE_PORT}` });
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;

const CONSENT_LINK = 'a[href="/personal-data-consent/"]';

/** Ни одной заранее отмеченной галочки на странице (КоАП 13.11 – первое, что смотрит проверка). */
async function noPrechecked(page: Page) {
  expect(await page.locator('input[type=checkbox]:checked').count()).toBe(0);
}

test('подвал: правила, политика и согласие ссылками; документы открываются по своим адресам', async ({ page, request }) => {
  await page.goto('/');
  const footer = page.locator('footer');
  for (const href of ['/rules/', '/privacy-policy/', '/personal-data-consent/']) await expect(footer.locator(`a[href="${href}"]`)).toBeVisible();
  for (const path of ['/rules/', '/privacy-policy/', '/personal-data-consent/', '/cookie-policy/', '/advertising-consent/']) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(200);
    const html = await res.text();
    // опубликованный документ – с текстом и редакцией, неопубликованный – честная заглушка, а не пустая страница
    expect(/data-testid="doc-version"|data-testid="doc-pending"|data-testid="info-page"/.test(html), path).toBe(true);
  }
});

test('вход: галочка пустая, с возрастом 14 лет и ссылкой на согласие; кнопка неактивна; подсказка про родителя', async ({ page }) => {
  await page.goto('/login/');
  await expect(page.getByTestId('age-note')).toContainText('от 14 лет');
  await expect(page.getByTestId('age-note')).toContainText('родитель');
  await page.getByLabel('Телефон').fill('9131234567');
  await page.getByRole('button', { name: 'Получить код' }).click();
  await page.getByLabel('Код из SMS').fill(MOCK_CODE);
  const consent = page.getByLabel(/согласие на обработку/);
  await expect(consent).toHaveCount(1);
  await expect(consent).not.toBeChecked();
  await expect(page.locator('#code-form label', { has: consent })).toContainText('Мне есть 14 лет');
  await expect(page.locator(`#code-form ${CONSENT_LINK}`)).toHaveAttribute('target', '_blank');
  await expect(page.getByRole('button', { name: 'Войти' })).toBeDisabled();
  await noPrechecked(page);
  await consent.check();
  await expect(page.getByRole('button', { name: 'Войти' })).toBeEnabled();
});

test('вход в потоке записи: та же галочка с возрастом и ссылкой, пустая, кнопка неактивна', async ({ page, request }) => {
  await request.post(`${MOCK}/__test/booking-reset`);
  await page.goto('/schedule/?branch=novosibirsk/krasny-prospekt');
  await page.getByRole('button', { name: /^Завтра/ }).click();
  await page.getByRole('button', { name: 'ПК 4, 10:00–10:30, свободно', exact: true }).click();
  await page.getByRole('button', { name: 'Оформить запись' }).click();
  await page.getByLabel('Телефон').fill('9131234567');
  await page.getByRole('button', { name: 'Получить код' }).click();
  await page.getByLabel('Код из SMS').fill(MOCK_CODE);
  const consent = page.getByLabel(/согласие на обработку/);
  await expect(consent).not.toBeChecked();
  await expect(page.locator('label', { has: consent })).toContainText('Мне есть 14 лет');
  await expect(page.locator('label', { has: consent }).locator(CONSENT_LINK)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Войти и продолжить' })).toBeDisabled();
  await noPrechecked(page);
});

test('заявка на праздник: оставляет взрослый, гостей не собираем; галочка пустая, с 18 годами и ссылкой; кнопка неактивна', async ({ page }) => {
  await page.goto('/birthday/');
  const note = page.getByTestId('party-adult-note');
  await expect(note).toContainText('родитель или другой законный представитель');
  await expect(note).toContainText('только контакт заказчика');
  const form = page.getByTestId('party-form');
  const label = form.locator('label', { hasText: /согласие на обработку/ });
  await expect(label).toHaveCount(1);
  await expect(label).toContainText('Мне есть 18 лет');
  await expect(label.locator('input[type=checkbox]')).not.toBeChecked();
  await expect(label.locator(CONSENT_LINK)).toHaveAttribute('target', '_blank');
  await expect(form.getByRole('button', { name: 'Отправить заявку' })).toBeDisabled();
  await noPrechecked(page);
});

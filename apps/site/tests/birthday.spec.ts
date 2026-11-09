// e2e /birthday/ (S3-90) на моке tests/mock-events.ts (П4, П5 по apps/api/src/modules/events/routes.public.ts): цифры праздника – из П5,
// не из вёрстки (меняем настройку мока – меняется страница); клубы – только с комнатой; «цена уточняется»; блок подарка с условиями 11 §9.1;
// пустая галочка согласия – кнопка неактивна, сервер без согласия – CONSENT_REQUIRED; заявка доходит как «Новое обращение» (new_request, site);
// один H1, title и description; 390 px без горизонтальной прокрутки, кнопки и поля не ниже 44 px.
import { expect, test, type Page } from '../../../tests/support/e2e.ts';
import { MOCK_PORT, STAGE_PORT } from '../playwright.config.ts';

test.use({ baseURL: `http://localhost:${STAGE_PORT}` });

const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const KRASNY = '0b0b0000-0000-4000-8000-000000000011';
const LENINA = '0b0b0000-0000-4000-8000-000000000021';
const plusDays = (n: number) => new Date(Date.now() + 7 * 3600_000 + n * 86_400_000).toISOString().slice(0, 10);

test.beforeEach(async ({ request }) => {
  await request.post(`${MOCK}/__test/events-reset`);
});

async function fill(page: Page) {
  const form = page.getByTestId('party-form');
  await form.getByLabel('Клуб').selectOption({ label: 'Ю-Клуб на Ленина' });
  await form.getByLabel('Желаемая дата').fill(plusDays(14));
  await form.getByLabel('3 часа и больше').check();
  await form.getByLabel(/Гостей/).fill('8');
  await form.getByLabel('Ваше имя').fill('Марина');
  await form.getByLabel('Телефон').fill('9137778899');
  await form.getByLabel(/Пожелания/).fill('Торт свой');
  return form;
}

test('SEO, цифры из П5, клубы с комнатой, цена уточняется, условия подарка', async ({ page }) => {
  await page.goto('/birthday/');
  await expect(page).toHaveTitle('День рождения в VR-комнате – Ю-Клуб');
  expect(await page.locator('meta[name="description"]').getAttribute('content')).toContain('до 10 гостей, от 2 часов');
  await expect(page.locator('h1')).toHaveCount(1);
  await expect(page.locator('h1')).toHaveText('День рождения в Ю-Клуб');
  await expect(page.getByTestId('party-guests')).toHaveText('до 10');
  await expect(page.getByTestId('party-price')).toHaveText('уточняется');
  await expect(page.getByTestId('party-branches').locator('li')).toHaveCount(2);
  const terms = page.getByTestId('gift-terms').locator('li');
  await expect(terms).toHaveText([
    '2 устройства Meta Quest 3S',
    'по 30 минут на каждое устройство',
    'суммарная продолжительность использования комнаты – 40 минут с учётом подготовки',
    'срок действия – 60 дней',
    'посещение по предварительной записи',
    'доступность с понедельника по пятницу, кроме праздничных дней',
    'PS4, PS VR и еда в подарок не входят',
  ]);
});

test('настройка сети меняет страницу: 8 гостей, 3 часа минимум, клуб без комнаты пропадает', async ({ page, request }) => {
  await request.post(`${MOCK}/__test/party-config`, { data: { maxGuests: 8, minMinutes: 180, noRoom: KRASNY } });
  await page.goto('/birthday/');
  await expect(page.getByTestId('party-guests')).toHaveText('до 8');
  await expect(page.locator('.yu-lead')).toContainText('от 3 часов');
  await expect(page.getByTestId('party-branches').locator('li')).toHaveCount(1);
  await expect(page.getByTestId('party-branches')).toContainText('Ю-Клуб на Ленина');
  await expect(page.getByTestId('party-form').getByLabel('Клуб').locator('option')).toHaveCount(1);
  await expect(page.getByTestId('party-form').getByLabel(/Гостей/)).toHaveAttribute('max', '8');
});

test('пустая галочка – кнопка неактивна; заявка доходит «Новым обращением»; повтор нажатия – одна заявка', async ({ page, request }) => {
  await page.goto('/birthday/');
  const form = await fill(page);
  const consent = form.getByLabel(/согласие на обработку/);
  const send = form.getByRole('button', { name: 'Отправить заявку' });
  await expect(consent).not.toBeChecked();
  await expect(send).toBeDisabled();
  await consent.check();
  await expect(send).toBeEnabled();
  await send.dblclick();
  await expect(page.getByTestId('party-done')).toContainText(/Заявка № EV-\d{6} принята/);
  const items = ((await (await request.get(`${MOCK}/__test/event-requests`)).json()) as { items: Array<Record<string, unknown>> }).items;
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ type: 'birthday_party', status: 'new_request', source: 'site', branchId: LENINA, format: 'h3plus', guests: 8, name: 'Марина', phone: '+79137778899', preferredDate: plusDays(14) });
  expect(items[0]!.wishes).toBe(`Желаемая дата: ${plusDays(14)}. Торт свой`);
});

test('сервер без согласия – CONSENT_REQUIRED; гостей больше предела – фраза у поля', async ({ page }) => {
  await page.goto('/birthday/');
  const r = await page.evaluate(async (branchId) => {
    const res = await fetch('/api/public/v1/event-requests/', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'yu-site', 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({ branchId, preferredDate: '2030-01-10', format: 'h2', guests: 5, name: 'Без галочки', phone: '9130001122' }),
    });
    return { status: res.status, body: (await res.json()) as { error: { code: string } } };
  }, KRASNY);
  expect(r.status).toBe(422);
  expect(r.body.error.code).toBe('CONSENT_REQUIRED');

  const form = await fill(page);
  await form.getByLabel(/Гостей/).fill('11');
  await form.getByLabel(/согласие на обработку/).check();
  await form.getByRole('button', { name: 'Отправить заявку' }).click();
  await expect(form.getByRole('alert')).toHaveText('Гостей на празднике – от 1 до 10.');
});

for (const width of [390, 1440]) {
  test(`${width} px: без горизонтальной прокрутки, кнопки и поля от 44 px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/birthday/');
    await fill(page);
    await page.getByTestId('party-form').getByLabel(/согласие на обработку/).check();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const small = await page.getByTestId('party-form').locator('button, input:not([type=checkbox]):not([type=radio]), select').evaluateAll((els) =>
      els.filter((e) => e.getBoundingClientRect().height < 44).map((e) => e.outerHTML.slice(0, 80)),
    );
    expect(small).toEqual([]);
    await page.screenshot({ path: `test-results/birthday-${width}.png`, fullPage: true });
  });
}

// Проверка S1-22 (план 6.2): календарь филиала по ресурсам (день/неделя, ≤ 7 дней) и рабочий стол Администратора –
// требуют решения, записи дня, блокировки. Календарь и список броней дают одну картину; время – зоны филиала;
// Администратор чужого филиала – 404; 1440 и 390 без горизонтальной прокрутки страницы (лента – внутри блока).
import { expect, test, type Page } from '../../../tests/support/e2e.ts';
import { MOCK_PASSWORD } from './mock-api.ts';

const MOCK = process.env.MOCK_URL ?? 'http://127.0.0.1:4012';
const SHOTS = process.env.SCREENSHOT_DIR ?? 'test-results/screens';
const TZ = 'Asia/Novosibirsk';
const day = (n: number) => {
  const base = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
  return new Date(Date.parse(`${base}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
};

test.describe.configure({ mode: 'serial' });
test.beforeAll(async ({ request }) => {
  expect((await request.post(`${MOCK}/__test/reset`)).ok()).toBe(true);
});
test.afterAll(async ({ request }) => {
  await request.post(`${MOCK}/__test/reset`);
});

async function login(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Почта').fill(email);
  await page.getByLabel('Пароль', { exact: true }).fill(MOCK_PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

test('рабочий стол: требуют решения, записи дня; календарь дня совпадает со списком броней', async ({ page }) => {
  await login(page, 'admin@yu.test');
  await page.getByRole('link', { name: 'Расписание', exact: true }).click();
  await expect(page).toHaveURL(/\/schedule/);
  await expect(page.getByRole('heading', { name: 'Расписание', level: 1 })).toBeVisible();

  const decide = page.getByTestId('desk-decide');
  await expect(decide).toContainText('№1005');
  await expect(decide).toContainText('Иван Петров');
  await expect(decide).not.toContainText('+79139876543'); // телефон – только маскированный

  // Данные календаря = данные списка: одни и те же брони дня (кроме отменённых – в календаре их нет).
  const list = await page.request.get(`/api/crm/v1/branches/b-nsk-krasny/bookings?date=${day(0)}&limit=100`);
  const cal = await page.request.get(`/api/crm/v1/branches/b-nsk-krasny/calendar?from=${day(0)}&to=${day(0)}`);
  const listIds = ((await list.json()) as { items: Array<{ id: string; status: string }> }).items.filter((b) => !b.status.startsWith('cancelled')).map((b) => b.id).sort();
  const calIds = ((await cal.json()) as { items: Array<{ id: string; kind: string }> }).items.filter((i) => i.kind === 'booking').map((i) => i.id).sort();
  expect(calIds).toEqual(listIds);
  await expect(page.getByTestId('desk-day').locator('.yc-desk__row')).toHaveCount(listIds.length);

  // Идущий сеанс на ПК 2 – в ленте своей строки, ссылкой на карточку.
  const lane = page.getByTestId('cal-lane-res-pc2');
  const item = lane.getByTestId('cal-item').first();
  await expect(item).toHaveAttribute('aria-label', /Бронь №1004, .*Ольга Смирнова/);
  await expect(item).toHaveAttribute('href', '/bookings/b0000000-0000-4000-8000-000000000001');
  await expect(page.getByTestId('calendar-title')).toContainText(TZ);
});

test('неделя: 7 дней, бронь VR-комнаты целиком занимает и места VR1/VR2; переход в день', async ({ page }) => {
  await login(page, 'admin@yu.test');
  await page.goto('/schedule');
  await page.getByRole('button', { name: 'Неделя' }).click();
  await expect(page).toHaveURL(/view=week/);
  await expect(page.locator('.yc-cal__week thead th')).toHaveCount(8); // «Ресурс» + 7 дней
  await expect(page.getByTestId(`week-res-pc1-${day(1)}`)).toContainText('20:00–22:00');
  for (const r of ['res-vrroom', 'res-vr1', 'res-vr2']) await expect(page.getByTestId(`week-${r}-${day(3)}`)).toContainText('Иван Петров');
  await expect(page.getByTestId(`week-res-pc2-${day(3)}`)).toHaveText('свободно');

  await page.getByRole('button', { name: 'Следующая неделя' }).click();
  await expect(page).toHaveURL(new RegExp(`date=${day(7)}`));
  await page.getByRole('button', { name: 'Предыдущая неделя' }).click();
  await page.locator('.yc-cal__daylink').nth(1).click();
  await expect(page).toHaveURL(new RegExp(`date=${day(1)}&view=day`));
  await expect(page.getByTestId('cal-lane-res-pc1').getByTestId('cal-item')).toHaveAttribute('aria-label', /20:00–22:00/);
});

test('блокировка – в календаре и на рабочем столе дня', async ({ page }) => {
  await login(page, 'admin@yu.test');
  await page.goto('/schedule');
  const reasons = (await (await page.request.get('/api/crm/v1/dictionaries/reasons?domain=resource_block')).json()) as { items: Array<{ id: string; code: string }> };
  const r = await page.request.post('/api/crm/v1/branches/b-nsk-krasny/blocks', {
    headers: { 'idempotency-key': crypto.randomUUID() },
    data: { target: { type: 'resource', ids: ['res-pc2'] }, start: `${day(2)}T14:00:00+07:00`, end: `${day(2)}T16:00:00+07:00`, reasonId: reasons.items.find((x) => x.code === 'repair')!.id },
  });
  expect(r.status()).toBe(201);
  await page.goto(`/schedule?date=${day(2)}`);
  await expect(page.getByTestId('desk-blocks')).toContainText('Ремонт');
  await expect(page.getByTestId('desk-blocks')).toContainText('ПК 2 · ');
  await expect(page.getByTestId('cal-lane-res-pc2').getByTestId('cal-item')).toHaveAttribute('aria-label', /Блокировка: Ремонт, .*14:00–16:00/);
});

test('Администратор чужого филиала – 404, Томский администратор не видит Красный', async ({ page }) => {
  await login(page, 'admin@yu.test');
  const r = await page.goto('/schedule?branch=b-tsk-lenina');
  expect(r?.status()).toBe(404);
  await expect(page.getByTestId('not-found')).toBeVisible();
  expect((await page.request.get(`/api/crm/v1/branches/b-tsk-lenina/calendar?from=${day(0)}&to=${day(0)}`)).status()).toBe(404);
  expect((await page.request.get(`/api/crm/v1/branches/b-nsk-krasny/calendar?from=${day(0)}&to=${day(7)}`)).status()).toBe(422); // > 7 дней

  await page.getByRole('button', { name: 'Выйти' }).click();
  await expect(page).toHaveURL(/\/login/);
  await login(page, 'tomsk@yu.test');
  expect((await page.goto('/schedule?branch=b-nsk-krasny'))?.status()).toBe(404);
  expect((await page.goto('/schedule'))?.status()).toBe(200);
  await expect(page.getByTestId('cal-lane-res-tsk-pc1')).toBeVisible();
});

test('лента дня на 1440 открывается с начала работы филиала (или с часа до «сейчас» в часы работы)', async ({ browser }) => {
  // «Сейчас» браузера зафиксировано (часы засева 10:00–22:00 по зоне филиала): правило проверяется в обоих случаях,
  // а не только в том, в который попал прогон. Данные календаря – с сервера мока, от выбранного времени не зависят.
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: TZ, locale: 'ru-RU' });
  const page = await ctx.newPage();
  await login(page, 'admin@yu.test');
  const cases: Array<{ date: string; now: string; expected: string; why: string }> = [
    { date: day(0), now: '15:20', expected: '14:00', why: 'сегодня, филиал открыт – час до текущего' },
    { date: day(0), now: '10:20', expected: '10:00', why: 'сегодня, первый час работы – не раньше открытия' },
    { date: day(0), now: '23:30', expected: '10:00', why: 'сегодня, филиал закрыт – с открытия' },
    { date: day(0), now: '07:00', expected: '10:00', why: 'сегодня до открытия – с открытия' },
    { date: day(1), now: '15:20', expected: '10:00', why: 'завтра – с открытия' },
  ];
  for (const c of cases) {
    await page.clock.setFixedTime(new Date(`${day(0)}T${c.now}:00+07:00`));
    await page.goto(`/schedule?date=${c.date}`);
    const scroll = page.getByTestId('calendar-scroll');
    await expect(scroll).toBeVisible();
    // первый час, чья подпись не спрятана под колонкой ресурсов; прокрутка ставится после гидратации – ждём её
    await expect.poll(() => scroll.evaluate((el) => {
      const edge = el.querySelector('.yc-cal__corner')!.getBoundingClientRect().right;
      const spans = [...el.querySelectorAll('.yc-cal__hours span')] as HTMLElement[];
      return spans.find((x) => x.getBoundingClientRect().left >= edge - 1)?.textContent ?? null;
    }), { message: `${c.why} (${c.date}, ${c.now})` }).toBe(c.expected);
  }
  await ctx.close();
});

test('снимки календаря день/неделя 1440 и 390: страница без горизонтальной прокрутки, лента – внутри блока', async ({ browser }) => {
  for (const [w, h] of [[1440, 900], [390, 844]] as const) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: w === 390 ? 2 : 1, timezoneId: TZ, locale: 'ru-RU' });
    const page = await ctx.newPage();
    await login(page, 'admin@yu.test');
    const noScroll = async () => expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(w);
    for (const view of ['day', 'week'] as const) {
      await page.goto(`/schedule?date=${day(0)}&view=${view}`);
      await expect(page.getByTestId('calendar')).toBeVisible();
      await page.screenshot({ path: `${SHOTS}/calendar-${view}-${w}.png`, fullPage: true });
      await noScroll();
      if (w === 390) {
        const s = page.getByTestId('calendar-scroll');
        expect(await s.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
      }
    }
    await ctx.close();
  }
});

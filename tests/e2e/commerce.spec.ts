// Э2 на живом стенде (S2-82, 18 §6.3; TC-07…TC-10): деньги, баллы, сертификаты. Филиал «на Красном», демо-Директор
// города (оплата, возврат, продажа сертификата, корректировка баллов – права OD), клиент – новый номер на прогон.
//  1. бронь с сайта → приход → наличные → в журнале кассы приход «Игровой сеанс», клиенту баллы = минуты ÷ 6 (вниз до 0,5);
//  2. бронь на сайте с резервом баллов → оплата баллами в CRM → резерв списан, за баллы не начисляется (R-06);
//  3. продажа сертификата (код показан один раз) → оплата сеанса номером+кодом → остаток уменьшился;
//  4. полный возврат денег по брони 1 → начисление снято, в кассе «Возврат»;
//  5. штрафы включены (loyalty.penalties_from через API настроек, после – наследование) → неявка → −5 → баланс −50 →
//     предзапись на сайте закрыта текстом 07 §9.2.
// Брони 1–3 – на завтра (окно прихода visit.arrive_early_min филиала на прогон 1440 мин, после – наследование);
// бронь неявки – сегодня на ближайший слот VR (неявку можно отметить только после начала – тест ждёт его).
// Завершённые и оплаченные брони остаются в истории (так задумано); отменяемое отменяется в afterAll.
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import {
  CRM_URL, DEMO_DIRECTOR, SITE_URL, SiteClient, at, branchBySlug, branchSetting, crmApi, crmLogin, dayIn, hydrated,
  networkSetting, newClient, resourcesOf, siteContext, type BookingDto, type StandBranch, type StandResource,
} from './stand.ts';
import { randomUUID } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

const LIMIT_TEXT = 'Предварительная запись временно недоступна: баланс бонусных баллов достиг минимального значения −50. Обратитесь к администратору клуба';

let branch: StandBranch;
let pcs: StandResource[];
let vr: StandResource[];
let client: SiteClient;
let clientId: string;
let director: APIRequestContext;
let crmCtx: BrowserContext;
let crm: Page;
let siteCtx: BrowserContext;
let site: Page;
let noShow: BookingDto;
const settingsSet: Array<() => Promise<void>> = [];
const leftovers: string[] = [];
const done: { cash?: BookingDto; cashPaymentId?: string; cashOperationId?: string } = {};

const timeIn = (iso: string, tz: string) =>
  new Intl.DateTimeFormat('ru-RU', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
const kop = (n: number) => `${new Intl.NumberFormat('ru-RU').format(Math.trunc(n / 100))},${String(n % 100).padStart(2, '0')} ₽`;
const accrualCenti = (minutes: number) => Math.floor((minutes / 6) * 2) * 50; // минуты ÷ 6, вниз до 0,5 балла

async function loyalty() {
  const r = await client.api.get('/api/public/v1/me/loyalty/');
  expect(r.ok()).toBe(true);
  return (await r.json()) as { balanceCenti: number; availableCenti: number; reservedCenti: number };
}
/** Баланс меняют обработчики событий в worker – ждём нужного значения. */
const balanceBecomes = (centi: number) =>
  expect.poll(async () => (await loyalty()).balanceCenti, { timeout: 45_000, intervals: [1000] }).toBe(centi);

async function freeSlot(rs: StandResource[], day: number, from = '11:00') {
  const date = dayIn(branch.timezone, day);
  const a = await client.availability(branch.id, date);
  const min = Math.max(Date.parse(at(date, from, branch.timezone)), Date.now() + 60_000);
  for (const r of rs) {
    const s = a.resources.find((x) => x.resourceId === r.id)?.slots.find((x) => x.state === 'free' && Date.parse(x.start) >= min);
    if (s) return { r, slot: s };
  }
  throw new Error(`на ${date} нет свободных слотов`);
}
async function bookTomorrow(): Promise<BookingDto> {
  const { r, slot } = await freeSlot(pcs, 1);
  const [b] = await client.book(branch.id, [{ resourceId: r.id, start: slot.start, end: slot.end }]);
  leftovers.push(b!.id);
  return b!;
}
const minutesOf = (b: BookingDto) => (Date.parse(b.end) - Date.parse(b.start)) / 60_000;

async function card(id: string) {
  await crm.goto(`${CRM_URL}/bookings/${id}`);
  await hydrated(crm);
  return crm.getByTestId('payment');
}
async function arrive(id: string) {
  const pay = await card(id);
  await expect(pay.getByTestId('pay-wait')).toContainText('Оплата – после прихода клиента');
  await crm.getByRole('button', { name: 'Отметить приход' }).click();
  await expect(crm.getByTestId('booking-status')).toHaveText('Пришёл');
  return pay;
}
async function paymentOf(id: string) {
  const r = await director.get(`/api/crm/v1/bookings/${id}/payment`);
  expect(r.ok()).toBe(true);
  return (await r.json()) as { payment: { id: string; status: string; lines: Array<{ method: string; amountKop: number }> } | null; amountDueKop: number };
}
async function operations() {
  const r = await director.get(`/api/crm/v1/branches/${branch.id}/finance/operations?limit=200`);
  expect(r.ok()).toBe(true);
  return ((await r.json()) as { items: Array<{ id: string; kind: string; source: string | null; direction: string; amountKop: number; ref: { type: string; id: string } | null }> }).items;
}

async function openCrm(browser: Browser) {
  crmCtx = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'ru-RU', timezoneId: branch.timezone, viewport: { width: 1440, height: 900 } });
  crm = await crmCtx.newPage();
  await crmLogin(crm, DEMO_DIRECTOR.email, DEMO_DIRECTOR.password());
}

test.beforeAll(async ({ browser }) => {
  const pub = await siteContext();
  branch = await branchBySlug(pub, 'novosibirsk', 'krasny');
  const rs = await resourcesOf(pub, branch.id);
  await pub.dispose();
  pcs = rs.filter((r) => r.type === 'pc');
  vr = rs.filter((r) => r.type === 'vr_seat');

  await branchSetting('visit.arrive_early_min', branch.id, 1440);
  settingsSet.push(() => branchSetting('visit.arrive_early_min', branch.id, null));
  await networkSetting('loyalty.penalties_from', new Date(Date.now() - 3600_000).toISOString());
  settingsSet.push(() => networkSetting('loyalty.penalties_from', null));

  client = await newClient();
  clientId = ((await (await client.api.get('/api/public/v1/me/')).json()) as { id: string }).id;
  director = await crmApi(DEMO_DIRECTOR.email, DEMO_DIRECTOR.password());
  // бронь для неявки – сразу, чтобы её начало прошло, пока идут сценарии 1–4
  const { r, slot } = await freeSlot(vr, 0, '00:00');
  [noShow] = await client.book(branch.id, [{ resourceId: r.id, start: slot.start, end: slot.end }]) as [BookingDto];
  leftovers.push(noShow.id);

  siteCtx = await browser.newContext({ baseURL: SITE_URL, ignoreHTTPSErrors: true, locale: 'ru-RU', timezoneId: branch.timezone, storageState: await client.api.storageState() });
  site = await siteCtx.newPage();
  await openCrm(browser);
});

test.afterAll(async () => {
  if (client) await client.cleanup(leftovers).catch(() => undefined);
  for (const undo of settingsSet.reverse()) await undo().catch((e: unknown) => console.error('настройка не возвращена', e));
  await director?.dispose();
  await crmCtx?.close();
  await siteCtx?.close();
  await client?.dispose();
});

test('1. наличные: приход «Игровой сеанс» в журнале кассы, баллы = минуты ÷ 6', async () => {
  expect((await loyalty()).balanceCenti).toBe(0);
  const b = await bookTomorrow();
  const pay = await arrive(b.id);
  const form = pay.getByTestId('pay-form');
  const due = (await paymentOf(b.id)).amountDueKop;
  await expect(form.getByTestId('pay-due')).toHaveText(kop(due));
  await form.getByRole('radio', { name: 'Наличные' }).check();
  await form.getByLabel('Чек пробит').check();
  await form.getByRole('button', { name: `Провести оплату · ${kop(due)}` }).click();
  await expect(pay.getByTestId('pay-status')).toHaveText('Оплачено');
  await expect(pay.getByTestId('pay-line')).toHaveText(`Наличные – ${kop(due)}`);

  const p = (await paymentOf(b.id)).payment!;
  done.cash = b;
  done.cashPaymentId = p.id;
  const op = (await operations()).filter((o) => o.ref?.type === 'payment' && o.ref.id === p.id);
  expect(op).toHaveLength(1);
  expect(op[0]).toMatchObject({ kind: 'income', source: 'session', direction: 'in', amountKop: due });
  done.cashOperationId = op[0]!.id;
  await crm.goto(`${CRM_URL}/finance/${branch.id}`);
  await hydrated(crm);
  await expect(crm.getByTestId('fin-journal').locator('tbody tr').filter({ hasText: 'Игровой сеанс' }).filter({ hasText: kop(due) }).first()).toBeVisible();

  await balanceBecomes(accrualCenti(minutesOf(b)));
});

test('2. резерв баллов на сайте → оплата баллами в CRM → резерв списан, за баллы не начисляется', async () => {
  const start = (await loyalty()).balanceCenti;
  const { r, slot } = await freeSlot(pcs, 1, '15:00');
  const need = ((Date.parse(slot.end) - Date.parse(slot.start)) / 60_000) * 100; // 1 балл = 1 минута
  const adj = await director.post(`/api/crm/v1/clients/${clientId}/loyalty/adjust`, {
    headers: { 'idempotency-key': randomUUID() }, data: { deltaCenti: need, reason: 'e2e: баллы на оплату сеанса' },
  });
  expect(adj.status()).toBe(201);
  await balanceBecomes(start + need);

  await site.goto(`/schedule/?branch=${branch.citySlug}/${branch.slug}`);
  await hydrated(site);
  await site.getByRole('button', { name: /^Завтра/ }).click();
  await expect(site.getByRole('button', { name: /^Завтра/ })).toHaveAttribute('aria-pressed', 'true');
  const label = `${r.name}, ${timeIn(slot.start, branch.timezone)}–${timeIn(slot.end, branch.timezone)}`;
  await site.getByRole('button', { name: `${label}, свободно`, exact: true }).click();
  await expect(site.getByRole('button', { name: `${label}, выбрано вами`, exact: true })).toBeVisible();
  await site.getByRole('button', { name: 'Оформить запись' }).click();
  await site.getByTestId('pay-points').check();
  await expect(site.getByTestId('points-reserved')).toContainText(`Зарезервировано ${need / 100}`);
  expect((await loyalty()).reservedCenti).toBe(need);
  await site.getByTestId('confirm').click();
  await expect(site).toHaveURL(/\/booking\/success\/$/);
  const b = (await client.my('upcoming')).items.find((x) => x.resourceId === r.id && Date.parse(x.start) === Date.parse(slot.start))!;
  expect(b).toBeTruthy();
  leftovers.push(b.id);
  expect((await loyalty()).reservedCenti).toBe(need); // резерв перешёл на бронь

  const pay = await arrive(b.id);
  const form = pay.getByTestId('pay-form');
  await form.getByRole('radio', { name: 'Баллы' }).check();
  await form.getByRole('button', { name: /^Провести оплату/ }).click();
  await expect(pay.getByTestId('pay-status')).toHaveText('Оплачено');
  await expect(pay.getByTestId('pay-line')).toContainText('Баллы');
  await expect.poll(async () => loyalty(), { timeout: 30_000 }).toMatchObject({ balanceCenti: start, reservedCenti: 0 });
  await crm.waitForTimeout(3000); // начисления за оплату баллами быть не должно – даём worker время ошибиться
  expect((await loyalty()).balanceCenti).toBe(start);
});

test('3. сертификат: продажа в CRM (код один раз) → оплата сеанса номером и кодом → остаток уменьшился', async () => {
  const start = (await loyalty()).balanceCenti;
  await crm.goto(`${CRM_URL}/certificates`);
  await hydrated(crm);
  await crm.getByRole('button', { name: 'Продать сертификат' }).click();
  const dlg = crm.getByRole('dialog');
  const branchSelect = dlg.getByLabel('Филиал продажи');
  if (await branchSelect.count()) await branchSelect.selectOption({ label: branch.name });
  await dlg.getByLabel('Номинал, ₽').fill('500');
  await dlg.getByRole('button', { name: 'Наличные' }).click();
  await dlg.getByRole('button', { name: 'Оформить и получить код' }).click();
  const number = (await dlg.getByTestId('sell-number').textContent())!.trim();
  const pin = (await dlg.getByTestId('sell-pin').textContent())!.trim();
  expect(number).toMatch(/^YC-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  expect(pin).toMatch(/^\d{4}$/);
  await expect(dlg.getByTestId('sell-once')).toContainText('Код больше не покажем');
  await dlg.getByRole('button', { name: 'Код передан клиенту – закрыть' }).click();
  await expect(crm.getByTestId('cert-number')).toHaveText(number);
  await expect(crm.getByTestId('cert-balance')).toHaveText('500,00 ₽');
  await expect(crm.getByTestId('sell-pin')).toHaveCount(0);
  const certUrl = crm.url();
  await crm.reload();
  await hydrated(crm);
  expect(await crm.content()).not.toContain(`Код: ${pin}`);

  const b = await bookTomorrow();
  const pay = await arrive(b.id);
  const due = (await paymentOf(b.id)).amountDueKop;
  expect(due).toBeLessThanOrEqual(50000);
  const form = pay.getByTestId('pay-form');
  await form.getByRole('radio', { name: 'Сертификат' }).check();
  await form.getByLabel('Номер сертификата').fill(number);
  await form.getByLabel('Код (4 цифры)').fill(pin);
  await form.getByRole('button', { name: 'Проверить сертификат' }).click();
  await expect(form.getByTestId('cert-ok')).toContainText('остаток 500,00 ₽');
  await form.getByRole('button', { name: `Провести оплату · ${kop(due)}` }).click();
  await expect(pay.getByTestId('pay-status')).toHaveText('Оплачено');
  await expect(pay.getByTestId('pay-line')).toHaveText(`Сертификат – ${kop(due)}`);

  await crm.goto(certUrl);
  await hydrated(crm);
  await expect(crm.getByTestId('cert-balance')).toHaveText(kop(50000 - due));
  await expect(crm.getByTestId('cert-redemptions')).toContainText(kop(due));
  // за сеанс, оплаченный сертификатом, баллы начисляются (loyalty.accrue_for_certificate = true)
  await balanceBecomes(start + accrualCenti(minutesOf(b)));
});

test('4. полный возврат денег по брони 1: начисление снято, в кассе «Возврат»', async () => {
  test.skip(!done.cash, 'нет оплаченной брони из сценария 1');
  const start = (await loyalty()).balanceCenti;
  const pay = await card(done.cash!.id);
  const due = (await paymentOf(done.cash!.id)).payment!.lines[0]!.amountKop;
  await pay.getByRole('button', { name: 'Вернуть оплату…' }).click();
  const dlg = crm.getByRole('dialog', { name: 'Вернуть оплату?' });
  await dlg.getByLabel('Причина *').fill('e2e: сеанс не состоялся');
  await dlg.getByRole('button', { name: `Вернуть ${kop(due)}` }).click();
  await expect(pay.getByTestId('pay-status')).toHaveText('Возвращено полностью');
  await expect(pay.getByTestId('pay-refunds')).toContainText(`Возврат ${kop(due)} · Наличные`);

  // возврат ссылается на исходное поступление кассы, не на платёж (K17 §«Возврат»: ref operation)
  const refund = (await operations()).filter((o) => o.kind === 'refund' && o.ref?.type === 'operation' && o.ref.id === done.cashOperationId);
  expect(refund).toHaveLength(1);
  expect(refund[0]).toMatchObject({ direction: 'out', amountKop: due });
  await crm.goto(`${CRM_URL}/finance/${branch.id}`);
  await hydrated(crm);
  await expect(crm.getByTestId('fin-journal').locator('tbody tr').filter({ hasText: 'Возврат' }).filter({ hasText: kop(due) }).first()).toBeVisible();
  await balanceBecomes(start - accrualCenti(minutesOf(done.cash!)));
});

test('5. штрафы включены: неявка → −5, баланс −50 → предзапись на сайте закрыта текстом 07 §9.2', async () => {
  // к −45 – корректировкой Директора (ниже −50 он не может, до −50 – да)
  const start = (await loyalty()).balanceCenti;
  const adj = await director.post(`/api/crm/v1/clients/${clientId}/loyalty/adjust`, {
    headers: { 'idempotency-key': randomUUID() }, data: { deltaCenti: -4500 - start, reason: 'e2e: подвести баланс к пределу' },
  });
  expect(adj.status()).toBe(201);
  await balanceBecomes(-4500);

  // неявку отмечают только после начала сеанса
  const wait = Date.parse(noShow.start) - Date.now() + 5000;
  test.setTimeout(Math.max(180_000, wait + 120_000));
  if (wait > 0) await crm.waitForTimeout(wait);
  await card(noShow.id);
  await crm.getByRole('button', { name: 'Неявка…' }).click();
  const dlg = crm.getByRole('dialog', { name: 'Отметить неявку?' });
  await dlg.getByRole('button', { name: 'Отметить неявку' }).click();
  await expect(crm.getByTestId('booking-status')).toHaveText('Неявка');
  await balanceBecomes(-5000);

  // сайт: удержание слота – отказ с текстом 07 §9.2, выбор не создан
  await site.goto(`/schedule/?branch=${branch.citySlug}/${branch.slug}`);
  await hydrated(site);
  await site.getByRole('button', { name: /^Завтра/ }).click();
  await expect(site.getByRole('button', { name: /^Завтра/ })).toHaveAttribute('aria-pressed', 'true');
  const { r, slot } = await freeSlot(pcs, 1, '19:00');
  // S2-72a: при −50 расписание сразу показывает баннер 07 §9.2 и выключает свободные слоты – кликом не выбрать
  await expect(site.getByTestId('loyalty-limit-banner').first()).toHaveText(LIMIT_TEXT);
  await expect(site.getByRole('button', { name: `${r.name}, ${timeIn(slot.start, branch.timezone)}–${timeIn(slot.end, branch.timezone)}, свободно`, exact: true })).toBeDisabled();
  await expect(site.getByTestId('hold-panel')).toHaveCount(0);
  await site.screenshot({ path: test.info().outputPath('site-limit-50.png'), fullPage: true });
  const api = await client.hold(branch.id, { resourceId: r.id, start: slot.start, end: slot.end }).then(() => null, (e: unknown) => e as { status: number; code: string });
  expect(api).toMatchObject({ status: 403, code: 'LOYALTY_LIMIT_REACHED' });
});

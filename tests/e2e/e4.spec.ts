// Э4 на живом стенде (правило 10 отчёта): экраны CRM и сайта S4-80…S4-98, S4-110…S4-126 против настоящего API.
// До этого они проверялись только на моках (apps/crm/tests/mock-*.ts, apps/site/tests/mock-*.ts). Сценарии:
//  1. CMS: Владелец создаёт новость с охватом «Ю Клуб Арбат» формой → черновика нет на сайте → публикует → видна на /news/
//     с выбранным Арбатом и не видна с выбранным Новосибирском → правка → версия 2 → откат к версии 1 → на сайте старый заголовок.
//  2. Уведомления: личное сервисное сообщение клиенту с предпросмотром → строка в «Отправках» → ЛК «Уведомления» показывает;
//     реклама клиенту: согласие в ЛК → предпросмотр берёт → отказ в ЛК → предпросмотр исключает; рассылка на группу с числом
//     адресатов во втором подтверждении. Реклама на стенде не подтверждается (нет UNSUBSCRIBE_SECRET) – это фиксируется, не роняет.
//  3. Отчёты: «Финансы и касса» за текущий месяц → детализация = карточка → CSV из «Моих файлов» = экран → рабочий стол те же числа.
//  4. Поиск в шапке: клиент по телефону, бронь по номеру, мероприятие по номеру.
//  5. Делегирование: «Создание филиалов» Директору на город (единственное делегируемое право, которого у Директора нет по роли)
//     → создание филиала доходит до конфликта слага (409, филиал не создаётся) → отзыв → 403.
//  6. Обезличивание: клиент сценария (брони отменены) → кнопка у Владельца → «Обезличен», поиск по старому телефону пуст.
//  7. Лента событий: ремонт, зарегистрированный Директором, – у Владельца значок в шапке и новое событие.
// Клиент – новый номер на прогон, бронь – ближайший свободный ПК «на Красном» не раньше чем через 2 часа (ночью – утро),
// все созданные данные помечены e2e и убираются в afterAll (публикация – в архив, кампании – отмена, ремонт – отмена, право – отзыв).
// Сайт кэширует контент 60 с (K22 §12) – проверки сайта после публикации ждут до 100 с.
import { randomUUID } from 'node:crypto';
import { expect, test, request as pwRequest, type APIRequestContext, type APIResponse, type BrowserContext, type Page } from '@playwright/test';
import {
  CRM_URL, DEMO_DIRECTOR, OWNER, SITE_URL, SiteClient, branchBySlug, crmApi, crmLogin, dayIn, hydrated, nearestFree, newClient, resourcesOf, siteContext,
  type BookingDto, type StandBranch,
} from './stand.ts';

// Без serial: сценарии независимы друг от друга (общие данные готовит beforeAll), падение одного не отменяет остальные.

const API = '/api/crm/v1';
const TAG = `e2e-${randomUUID().slice(0, 8)}`;
/** Одна версия с одним и тем же текстом на все прогоны: тот же номер с другим текстом CMS не публикует. */
const LEGAL_VERSION = 'advertising-consent-2026-11-11';
const idem = () => ({ 'idempotency-key': randomUUID() });
const SITE_POLL = { timeout: 100_000, intervals: [3000] };
const WORKER_POLL = { timeout: 120_000, intervals: [2000] };

let owner: APIRequestContext;
let director: APIRequestContext;
let arbat: StandBranch;
let krasny: StandBranch;
let nskCityId = '';
let client: SiteClient;
let clientId = '';
let booking: BookingDto | undefined;
let crmCtx: BrowserContext;
let crm: Page;
let siteCtx: BrowserContext;
let site: Page;
let marketingReady = false;
let anonymized = false;
const leftovers: string[] = [];
const created: { publication?: string; campaigns: string[]; repair?: string; grants: string[]; legal: boolean } = { campaigns: [], grants: [], legal: false };

async function ok<T>(r: Promise<APIResponse> | APIResponse): Promise<T> {
  const res = await r;
  expect(res.ok(), `${new URL(res.url()).pathname} → ${res.status()}`).toBe(true);
  return (await res.json()) as T;
}
async function open(page: Page, path: string): Promise<void> {
  const res = await page.goto(`${CRM_URL}${path}`);
  expect(res?.status(), path).toBeLessThan(400);
  await hydrated(page);
}
/** Сайт глазами посетителя с выбранным клубом (кука yu_branch = город/филиал) или без выбора. */
const siteAs = (branch?: string) =>
  pwRequest.newContext({ baseURL: SITE_URL, ignoreHTTPSErrors: true, ...(branch ? { extraHTTPHeaders: { cookie: `yu_branch=${branch}` } } : {}) });
const note = (text: string) => test.info().annotations.push({ type: 'расхождение', description: text });
const digits = (s: string) => s.replace(/[^\d,-]/g, '');

async function archivePublication(id: string): Promise<void> {
  const card = await owner.get(`${API}/content/publications/${id}`);
  if (!card.ok()) return;
  const { status } = (await card.json()) as { status: string };
  if (status === 'archived') return;
  if (status === 'published') await owner.post(`${API}/content/publications/${id}/unpublish`, { headers: idem(), data: { reason: 'e2e: уборка' } });
  await owner.post(`${API}/content/publications/${id}/archive`, { headers: idem(), data: { reason: 'e2e: уборка' } });
}
async function cancelCampaign(id: string): Promise<void> {
  const r = await owner.get(`${API}/notifications/campaigns/${id}`);
  if (!r.ok()) return;
  const { status } = (await r.json()) as { status: string };
  if (status === 'done' || status === 'cancelled') return;
  await owner.post(`${API}/notifications/campaigns/${id}/cancel`, { headers: idem(), data: { reason: 'e2e: уборка' } });
}
/** Согласие на рекламу: без опубликованного текста (K5 №215) в ЛК нет переключателя, а включение – 409 MARKETING_DOCUMENT_MISSING. */
async function publishAdvertisingConsent(): Promise<void> {
  const d = await ok<{ rowVersion: number; draft: Record<string, unknown> }>(owner.get(`${API}/content/pages/advertising-consent/draft`));
  const draft = { ...d.draft, title: 'Согласие на рекламу (e2e)', body: 'Текст согласия на получение рекламных сообщений. Проверка стенда e2e.', documentVersion: LEGAL_VERSION };
  const saved = await ok<{ rowVersion: number }>(owner.put(`${API}/content/pages/advertising-consent/draft`, { headers: idem(), data: { rowVersion: d.rowVersion, draft } }));
  await ok(owner.post(`${API}/content/pages/advertising-consent/publish`, { headers: idem(), data: { rowVersion: saved.rowVersion, reason: 'e2e: согласие на рекламу для проверки ЛК' } }));
  created.legal = true;
}

test.beforeAll(async ({ browser }) => {
  owner = await crmApi(OWNER.email(), OWNER.password());
  director = await crmApi(DEMO_DIRECTOR.email, DEMO_DIRECTOR.password());
  const pub = await siteContext();
  arbat = await branchBySlug(pub, 'moskva', 'arbat');
  krasny = await branchBySlug(pub, 'novosibirsk', 'krasny');
  const cities = await ok<{ items: Array<{ id: string; slug: string }> }>(pub.get('/api/public/v1/cities/'));
  nskCityId = cities.items.find((c) => c.slug === 'novosibirsk')!.id;
  const pcs = (await resourcesOf(pub, krasny.id)).filter((r) => r.type === 'pc');
  marketingReady = (await pub.get('/api/public/v1/unsubscribe/check/?t=e2e')).status() !== 503;
  const legal = await ok<{ advertisingConsent: string | null }>(pub.get('/api/public/v1/content/legal-versions/'));
  await pub.dispose();
  if (!legal.advertisingConsent) await publishAdvertisingConsent();
  // остатки упавших прогонов: публикации с меткой e2e – в архив
  const stale = await ok<{ items: Array<{ id: string; status: string }> }>(owner.get(`${API}/content/publications?q=e2e-&limit=100`));
  for (const p of stale.items) if (p.status !== 'archived') await archivePublication(p.id);

  client = await newClient();
  clientId = (await ok<{ id: string }>(client.api.get('/api/public/v1/me/'))).id;
  const slot = await nearestFree(client, krasny, pcs, Date.now() + 2 * 3600_000);
  if (slot) {
    booking = (await client.book(krasny.id, [{ resourceId: slot.r.id, start: slot.slot.start, end: slot.slot.end }]))[0];
    if (booking) leftovers.push(booking.id);
  }
  crmCtx = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'ru-RU', timezoneId: 'Europe/Moscow', viewport: { width: 1440, height: 900 } });
  crm = await crmCtx.newPage();
  await crmLogin(crm, OWNER.email(), OWNER.password());
  siteCtx = await browser.newContext({ baseURL: SITE_URL, ignoreHTTPSErrors: true, locale: 'ru-RU', timezoneId: 'Europe/Moscow', storageState: await client.api.storageState() });
  site = await siteCtx.newPage();
});

test.afterAll(async () => {
  const quiet = (p: Promise<unknown>) => p.catch((e: unknown) => console.error('уборка e2e', e));
  if (created.publication) await quiet(archivePublication(created.publication));
  for (const id of created.campaigns) await quiet(cancelCampaign(id));
  if (created.repair) {
    await quiet((async () => {
      const r = await ok<{ rowVersion: number; status: string }>(director.get(`${API}/repairs/${created.repair}`));
      if (!['closed', 'cancelled'].includes(r.status)) await director.post(`${API}/repairs/${created.repair}/status`, { headers: idem(), data: { rowVersion: r.rowVersion, to: 'cancelled', comment: 'e2e: уборка' } });
    })());
  }
  for (const id of created.grants) await quiet(owner.post(`${API}/staff/grants/${id}/revoke`, { headers: idem(), data: { reason: 'e2e: уборка' } }));
  if (created.legal) await quiet(owner.post(`${API}/content/pages/advertising-consent/unpublish`, { headers: idem(), data: { reason: 'e2e: уборка' } }));
  if (client && !anonymized) await client.cleanup(leftovers).catch(() => undefined);
  await crmCtx?.close();
  await siteCtx?.close();
  await client?.dispose();
  await owner?.dispose();
  await director?.dispose();
});

test('1. CMS: новость филиала – черновик не на сайте → публикация → /news/ и хаб → правка → версия → откат', async ({ browser }) => {
  test.setTimeout(480_000);
  const title = `Новость ${TAG}`;
  const title2 = `${title} (правка)`;
  const slug = `news-${TAG}`;
  await open(crm, '/content/publications/new?type=news');
  await crm.getByLabel('Филиалы', { exact: true }).check();
  await crm.getByLabel('Ю Клуб Арбат').check();
  await crm.getByLabel('Заголовок', { exact: true }).fill(title);
  await crm.getByLabel('Анонс', { exact: true }).fill('Проверка CMS на стенде: охват – только Арбат.');
  await crm.getByLabel('Текст', { exact: true }).fill('Текст новости для сквозной проверки. Метка e2e, материал уйдёт в архив после прогона.');
  await crm.getByLabel('Показывать с', { exact: true }).fill(`${dayIn('UTC', -2)}T12:00`);
  await crm.getByRole('button', { name: 'Выбрать из медиатеки…' }).click();
  await crm.getByRole('dialog').getByRole('button', { name: /^Выбрать: / }).first().click();
  await expect(crm.getByTestId('pub-cover-current')).toBeVisible();
  await crm.getByLabel('Адрес страницы').fill(slug);
  await expect(crm.getByLabel('Адрес страницы')).toHaveValue(slug);
  await crm.getByRole('button', { name: 'Сохранить черновик' }).click();
  await expect(crm).toHaveURL(/\/content\/publications\/[0-9a-f-]{36}\?created=1$/);
  await hydrated(crm);
  const id = new URL(crm.url()).pathname.split('/').at(-1)!;
  created.publication = id;
  const draft = await ok<{ status: string; draft: { scope: { type: string; branchIds?: string[] }; slug?: string } }>(owner.get(`${API}/content/publications/${id}`));
  expect(draft).toMatchObject({ status: 'draft', draft: { scope: { type: 'branch', branchIds: [arbat.id] }, slug } });

  // черновик на сайте не виден: ни в списке API, ни страницей
  const noChoice = await siteAs();
  const listBefore = await ok<{ items: Array<{ slug: string }> }>(noChoice.get(`/api/public/v1/content/publications/?type=news&branch=${arbat.id}`));
  expect(listBefore.items.map((i) => i.slug)).not.toContain(slug);
  expect((await noChoice.get(`/news/${slug}/`)).status()).toBe(404);
  await noChoice.dispose();

  await crm.getByRole('button', { name: 'Опубликовать…' }).click();
  await crm.getByRole('dialog').getByRole('button', { name: 'Опубликовать', exact: true }).click();
  await expect(crm.getByRole('status').filter({ hasText: 'Опубликовано: на сайте новая версия.' })).toBeVisible();
  const live = await ok<{ status: string; liveVersionId: string | null; live: { title: string } | null }>(owner.get(`${API}/content/publications/${id}`));
  expect(live.status).toBe('published');
  expect(live.live?.title).toBe(title);

  // сайт с выбранным Арбатом: в /news/ и на своей странице; с выбранным Новосибирском – нет
  const asArbat = await siteAs('moskva/arbat');
  await expect.poll(async () => (await asArbat.get('/news/')).text(), SITE_POLL).toContain(title);
  const page = await asArbat.get(`/news/${slug}/`);
  expect(page.status()).toBe(200);
  expect(await page.text()).toContain(title);
  const asKrasny = await siteAs('novosibirsk/krasny');
  expect(await (await asKrasny.get('/news/')).text()).not.toContain(title);
  const applies = await ok<{ appliesHere: boolean | null; onlyIn: Array<{ id: string }> }>(asKrasny.get(`/api/public/v1/content/publications/news/${slug}/?branch=${krasny.id}`));
  expect(applies).toMatchObject({ appliesHere: false, onlyIn: [{ id: arbat.id }] });
  await asKrasny.dispose();
  const hub = await (await asArbat.get(`/${arbat.citySlug}/${arbat.slug}/`)).text();
  if (!hub.includes(title)) note('хаб филиала /moskva/arbat/ не выводит публикации с охватом «филиал» (карта сайта 3.1 требует): apps/site/src/pages/[city]/[branch]/index.astro');
  await asArbat.dispose();
  const visitor = await browser.newContext({ baseURL: SITE_URL, ignoreHTTPSErrors: true, locale: 'ru-RU' });
  await visitor.addCookies([{ name: 'yu_branch', value: 'moskva/arbat', url: SITE_URL }]);
  const news = await visitor.newPage();
  await news.goto('/news/');
  await expect(news.getByTestId('pub-filter')).toContainText('Для клуба «Ю Клуб Арбат» и всей сети.');
  const card = news.locator('.pub-card').filter({ hasText: title });
  await expect(card.getByTestId('pub-scope')).toHaveText('Только в клубе «Ю Клуб Арбат»');
  await card.getByRole('link', { name: title }).click();
  await expect(news).toHaveURL(new RegExp(`/news/${slug}/$`));
  await expect(news.getByRole('heading', { level: 1 })).toHaveText(title);
  await news.screenshot({ path: test.info().outputPath('site-news-published.png'), fullPage: true });

  // правка → версия 2 на сайте
  await open(crm, `/content/publications/${id}`);
  await expect(crm.getByTestId('version-1')).toContainText('Версия 1 – на сайте');
  await crm.getByLabel('Заголовок', { exact: true }).fill(title2);
  await crm.getByRole('button', { name: 'Сохранить черновик' }).click();
  await expect(crm.getByRole('status').filter({ hasText: 'Черновик сохранён' })).toBeVisible();
  await crm.getByRole('button', { name: 'Опубликовать…' }).click();
  await crm.getByRole('dialog').getByRole('button', { name: 'Опубликовать', exact: true }).click();
  await expect(crm.getByRole('status').filter({ hasText: 'Опубликовано: на сайте новая версия.' })).toBeVisible();
  const asArbat2 = await siteAs('moskva/arbat');
  await expect.poll(async () => (await asArbat2.get(`/news/${slug}/`)).text(), SITE_POLL).toContain(title2);

  // откат к версии 1 → версия 3 с её содержимым, на сайте старый заголовок
  await open(crm, `/content/publications/${id}`);
  const versions = crm.getByTestId('versions');
  await expect(versions.getByTestId('version-2')).toContainText('Версия 2 – на сайте');
  await versions.getByTestId('version-1').getByRole('button', { name: 'Откатить к этой версии…' }).click();
  const dlg = crm.getByRole('dialog', { name: 'Откатить к версии 1?' });
  await dlg.getByLabel('Причина').fill('e2e: проверка отката');
  await dlg.getByRole('button', { name: 'Откатить' }).click();
  // сообщение «Откат выполнен…» живёт 600 мс до перезагрузки страницы – проверяем результат после неё
  await expect(crm.getByTestId('version-3')).toContainText('откат к версии 1', { timeout: 30_000 });
  await hydrated(crm);
  await expect(crm.getByTestId('version-3')).toContainText('на сайте');
  await expect(crm.getByLabel('Заголовок', { exact: true })).toHaveValue(title);
  const after = await ok<{ live: { title: string } | null }>(owner.get(`${API}/content/publications/${id}`));
  expect(after.live?.title).toBe(title);
  expect((await ok<{ items: unknown[] }>(owner.get(`${API}/content/publications/${id}/versions`))).items).toHaveLength(3);
  await expect.poll(async () => (await asArbat2.get(`/news/${slug}/`)).text(), SITE_POLL).toContain(title);
  expect(await (await asArbat2.get(`/news/${slug}/`)).text()).not.toContain(title2);
  await asArbat2.dispose();
  await visitor.close();
});

test('2. Уведомления: личное сообщение → журнал и ЛК; реклама: согласие и отказ в ЛК; рассылка на группу со вторым подтверждением', async () => {
  test.skip(!booking, 'нет свободного ПК на Красном на 3 дня вперёд – личное сообщение без записи не отправить');
  test.setTimeout(420_000);
  const msgTitle = `Сообщение ${TAG}`;
  await open(crm, `/clients/${clientId}`);
  await crm.getByTestId('client-notifications').getByRole('link', { name: 'Написать клиенту' }).click();
  await hydrated(crm);
  await crm.getByLabel('Категория').selectOption('service');
  await expect(crm.getByRole('button', { name: 'Один клиент' })).toHaveAttribute('aria-pressed', 'true');
  await expect(crm.getByTestId('cf-client')).toBeVisible();
  await crm.getByLabel('Запись клиента (ID)').fill(booking!.id);
  await crm.getByLabel('Назначение').fill('e2e: проверка экрана сообщения');
  await crm.getByLabel('Заголовок', { exact: true }).fill(msgTitle);
  await crm.locator('textarea[name=body]').fill('{client.firstName}, это проверочное сообщение стенда про вашу запись в {branch.name}.');
  await crm.getByRole('button', { name: 'Проверить аудиторию' }).click();
  const ap = crm.getByTestId('audience-preview');
  await expect(ap.getByTestId('ap-total')).toHaveText('1');
  await expect(ap.getByTestId('ap-push')).toHaveText('0'); // у нового клиента нет push-подписки
  await expect(ap.getByTestId('ap-inbox')).toHaveText('1');
  await expect(ap.getByTestId('ap-critical')).toHaveText('1');
  await expect(ap.getByTestId('ap-marketing-off')).toHaveText('0');
  await expect(crm).toHaveURL(/\/notifications\/campaigns\/[0-9a-f-]{36}$/);
  const personalId = new URL(crm.url()).pathname.split('/').at(-1)!;
  created.campaigns.push(personalId);
  await ap.getByRole('button', { name: 'Отправить', exact: true }).click();
  const confirm = crm.getByRole('dialog');
  await expect(confirm).toContainText('Отправить 1 адресат?');
  await expect(confirm).toContainText(msgTitle);
  await confirm.getByRole('button', { name: 'Отправить 1 адресат' }).click();
  await expect(crm.getByTestId('campaign-status')).toHaveText(/Подтверждена|Готовится к отправке|Отправляется|Завершена/);
  // строку создаёт раннер кампаний (30 с), канал проверяет диспетчер (30 с): ждём строку, видимую клиенту
  type Row = { id: string; title: string; status: string; kind: string; campaignId?: string | null };
  const rowOf = async () => (await ok<{ items: Row[] }>(owner.get(`${API}/notifications?clientId=${clientId}&kind=personal&limit=50`))).items.find((n) => n.title.includes(TAG));
  await expect.poll(async () => (await rowOf())?.status ?? 'нет строки', WORKER_POLL).toMatch(/^(no_channel|inbox_only|sent_to_provider)$/);
  await open(crm, `/notifications/campaigns/${personalId}`);
  await expect(crm.getByTestId('campaign-status')).toHaveText('Завершена');
  await open(crm, `/notifications?tab=rows&clientId=${clientId}`);
  const row = crm.getByTestId('rows').locator('tbody tr').filter({ hasText: msgTitle });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('Личное сообщение');
  await expect(row).toContainText('Сотрудник: Вы');
  await expect(row).toContainText(/Нет доступного канала|Только в центре уведомлений/);

  await site.goto('/account/notifications/');
  await hydrated(site);
  const item = site.getByTestId('nc-item').filter({ hasText: msgTitle });
  await expect(item).toHaveCount(1);
  await expect(item).toContainText('Новое');
  await expect(item).toContainText('Запись');
  await expect(site.getByTestId('unread-count')).toHaveText(/^[1-9]\d*$/);
  await item.getByRole('button').click();
  await expect(item).not.toContainText('Новое');
  const read = (await rowOf())!;
  expect(read.status).toMatch(/^(no_channel|inbox_only|sent_to_provider)$/);

  // реклама: согласие в ЛК → предпросмотр берёт клиента
  await site.goto('/account/');
  await hydrated(site);
  const ad = site.getByLabel(/Реклама и акции/);
  await expect(ad, 'переключатель рекламы в ЛК (нужен опубликованный текст согласия)').toBeVisible();
  await ad.check();
  const settings = () => ok<{ marketingEnabled: boolean }>(client.api.get('/api/public/v1/me/notification-settings/'));
  await expect.poll(async () => (await settings()).marketingEnabled, { timeout: 15_000 }).toBe(true);
  await open(crm, `/notifications/new?clientId=${clientId}`);
  await crm.getByLabel('Категория').selectOption('marketing');
  await expect(crm.getByRole('button', { name: 'Один клиент' })).toHaveAttribute('aria-pressed', 'true');
  await crm.getByLabel('Заголовок', { exact: true }).fill(`Реклама ${TAG}`);
  await crm.locator('textarea[name=body]').fill('Проверочная реклама стенда: турнир в {branch.name}.');
  await crm.getByLabel('erid (маркировка рекламы)').fill('e2eErid01');
  await crm.getByRole('button', { name: 'Проверить аудиторию' }).click();
  await expect(ap.getByTestId('ap-total')).toHaveText('1');
  await expect(ap.getByTestId('ap-marketing-off')).toHaveText('0');
  await expect(ap.getByTestId('ap-inbox')).toHaveText('1');
  const adId = new URL(crm.url()).pathname.split('/').at(-1)!;
  created.campaigns.push(adId);
  await ap.getByRole('button', { name: 'Отправить', exact: true }).click();
  await crm.getByRole('dialog').getByRole('button', { name: 'Отправить 1 адресат' }).click();
  if (marketingReady) {
    await expect(crm.getByTestId('campaign-status')).toHaveText(/Подтверждена|Готовится к отправке|Отправляется|Завершена/);
  } else {
    await expect(crm.getByRole('dialog').getByRole('alert')).toContainText('Рассылка рекламы не настроена на сервере');
    note('стенд: UNSUBSCRIBE_SECRET не задан – реклама не подтверждается (503 MARKETING_NOT_CONFIGURED), проверено до второго подтверждения');
    await crm.getByRole('dialog').getByRole('button', { name: 'Вернуться к сообщению' }).click();
  }

  // отказ в ЛК → та же кампания его уже не берёт
  await site.goto('/account/');
  await hydrated(site);
  await site.getByLabel(/Реклама и акции/).uncheck();
  await expect.poll(async () => (await settings()).marketingEnabled, { timeout: 15_000 }).toBe(false);
  const adCard = await ok<{ status: string }>(owner.get(`${API}/notifications/campaigns/${adId}`));
  if (adCard.status === 'draft') {
    await open(crm, `/notifications/campaigns/${adId}`);
    await crm.getByRole('button', { name: 'Проверить аудиторию' }).click();
    await expect(ap.getByTestId('ap-total')).toHaveText('1');
    await expect(ap.getByTestId('ap-marketing-off')).toHaveText('1');
    await expect(ap.getByTestId('ap-inbox')).toHaveText('0');
    await expect(ap).toContainText('обойти это нельзя');
  }
  await open(crm, `/clients/${clientId}`);
  await expect(crm.getByTestId('client-notifications').getByTestId('cn-marketing')).toHaveText(/^Выключена, изменено .+ в личном кабинете$/);
  const inbox = await ok<{ items: Array<{ title: string }> }>(client.api.get('/api/public/v1/me/notifications/?limit=50'));
  expect(inbox.items.map((i) => i.title)).not.toContain(`Реклама ${TAG}`);

  // рассылка на группу: пять чисел предпросмотра и число адресатов во втором подтверждении
  await open(crm, '/notifications/new');
  await crm.getByLabel('Категория').selectOption('marketing');
  await crm.getByRole('button', { name: 'Группа клиентов' }).click();
  await crm.getByLabel('Область').selectOption({ label: `Филиал: ${krasny.name}` });
  await crm.getByLabel('Будущая запись').selectOption('yes');
  await crm.getByLabel('Заголовок', { exact: true }).fill(`Рассылка ${TAG}`);
  await crm.locator('textarea[name=body]').fill('Проверочная рассылка стенда для клиентов с записью в {branch.name}.');
  await crm.getByLabel('erid (маркировка рекламы)').fill('e2eErid02');
  await crm.getByRole('button', { name: 'Проверить аудиторию' }).click();
  for (const k of ['total', 'push', 'marketing-off', 'inbox', 'critical']) await expect(ap.getByTestId(`ap-${k}`)).toHaveText(/^\d+$/);
  const total = Number(await ap.getByTestId('ap-total').innerText());
  expect(total, 'клиент сценария с будущей записью на Красном – в аудитории').toBeGreaterThanOrEqual(1);
  const segId = new URL(crm.url()).pathname.split('/').at(-1)!;
  created.campaigns.push(segId);
  await ap.getByRole('button', { name: 'Отправить', exact: true }).click();
  const dlg = crm.getByRole('dialog');
  await expect(dlg.getByTestId('ap-confirm-total')).toHaveText(String(total));
  await expect(dlg).toContainText(`Филиал: ${krasny.name}`);
  await dlg.getByRole('button', { name: new RegExp(`^Отправить ${total} адресат`) }).click();
  if (marketingReady) {
    await expect(crm.getByTestId('campaign-status')).toHaveText(/Подтверждена|Готовится к отправке|Отправляется|Завершена/);
  } else {
    await expect(dlg.getByRole('alert')).toContainText('Рассылка рекламы не настроена на сервере');
    expect((await ok<{ status: string }>(owner.get(`${API}/notifications/campaigns/${segId}`))).status).toBe('draft');
  }
});

test('3. Отчёты: финансы за месяц → детализация = карточка → CSV из «Моих файлов» = экран → рабочий стол Владельца', async () => {
  test.setTimeout(300_000);
  await open(crm, '/reports');
  await crm.getByTestId('report-list').getByRole('link', { name: /Финансы и касса/ }).click();
  await expect(crm).toHaveURL(/\/reports\/finance$/);
  await hydrated(crm);
  const report = crm.getByTestId('report');
  await expect(report).toHaveAttribute('data-state', 'ready', { timeout: 90_000 });
  expect(await report.getAttribute('data-period')).toMatch(/^\d{4}-\d{2}-01\.\.\d{4}-\d{2}-\d{2}$/);
  await expect(crm.getByTestId('report-meta')).toContainText('Область: Вся сеть');
  await expect(crm.getByTestId('computed-at')).toContainText('Рассчитано: ');
  const value = async (key: string) => (await crm.getByTestId(`card-${key}`).getByTestId('value').innerText()).trim();
  const seen = { incomeSession: await value('incomeSession'), refunds: await value('refunds'), expenses: await value('expenses') };
  expect(seen.incomeSession).toMatch(/₽$/);

  await crm.getByTestId('card-incomeSession').click();
  await expect(crm).toHaveURL(/metric=incomeSession/);
  const detail = crm.getByTestId('detail');
  await expect(detail.getByTestId('detail-total')).toContainText(`Итог: ${seen.incomeSession} – совпадает с карточкой`, { timeout: 90_000 });
  await expect(detail).toHaveAttribute('data-state', 'ready');

  await crm.getByTestId('export-open').click();
  const dlg = crm.getByTestId('export-dialog');
  await dlg.getByRole('radio', { name: /CSV/ }).check();
  await dlg.getByRole('radio', { name: /^Записи показателя «Поступления от сеансов»/ }).check();
  await dlg.getByRole('button', { name: 'Сформировать' }).click();
  await expect(dlg.getByTestId('export-queued')).toBeVisible();
  await dlg.getByRole('link', { name: 'Мои файлы' }).click();
  await expect(crm).toHaveURL(/\/reports\/exports$/);
  await hydrated(crm);
  const job = crm.getByTestId('export-jobs').locator('tbody tr').first();
  await expect(job).toContainText('Финансы и касса, CSV');
  await expect(job).toContainText('записи «Поступления от сеансов»');
  await expect(job.getByTestId('status')).toContainText('Готов', { timeout: 120_000 });
  const link = job.getByRole('link', { name: /^Скачать/ });
  const rowsSaid = Number(/\((\d+) строк\)/.exec((await link.innerText()) ?? '')?.[1] ?? '-1');
  const file = await owner.get((await link.getAttribute('href'))!);
  expect(file.status()).toBe(200);
  expect(file.headers()['content-disposition']).toMatch(/^attachment;/);
  const lines = (await file.text()).replace(/^\uFEFF/, '').split('\r\n');
  const totalLine = lines.find((l) => l.startsWith('Итого: Поступления от сеансов;'));
  expect(totalLine, 'строка «Итого» в шапке CSV').toBeTruthy();
  expect(totalLine!.split(';')[1]).toBe(digits(seen.incomeSession));
  const blank = lines.indexOf('');
  const dataRows = lines.slice(blank + 2).filter((l) => l !== '');
  expect(dataRows.length).toBe(rowsSaid);

  await open(crm, '/');
  const desk = crm.getByTestId('dashboard');
  await desk.getByRole('button', { name: 'Этот месяц' }).click();
  for (const [key, v] of Object.entries(seen)) await expect(desk.getByTestId(`desk-card-${key}`).locator('.rp-card__value')).toHaveText(v, { timeout: 90_000 });
  await expect(desk.getByTestId('desk-card-incomeSession')).toHaveAttribute('href', /\/reports\/finance\?from=\d{4}-\d{2}-01&to=\d{4}-\d{2}-\d{2}&metric=incomeSession$/);
});

test('4. Поиск в шапке: клиент по телефону, бронь по номеру, мероприятие по номеру', async () => {
  await open(crm, '/reports');
  const box = crm.getByRole('combobox', { name: 'Поиск по CRM' });
  const results = crm.getByTestId('search-results');
  await box.fill(client.phone);
  const clients = results.getByTestId('search-group-client');
  await expect(clients).toContainText(client.phone); // Владелец видит номер целиком
  await expect(clients.locator(`a[href="/clients/${clientId}"]`)).toHaveCount(1);

  if (booking) {
    await box.fill(String(booking.number));
    const bookings = results.getByTestId('search-group-booking');
    await expect(bookings).toContainText(`Бронь № ${booking.number}`);
    await expect(bookings.locator(`a[href="/bookings/${booking.id}"]`)).toHaveCount(1);
    await expect(bookings).toContainText(booking.resourceName);
  } else note('бронь по номеру не проверена: свободного ПК на 3 дня вперёд не было');

  const events = await ok<{ items: Array<{ id: string; number: string }> }>(owner.get(`${API}/events?limit=1`));
  const ev = events.items[0];
  expect(ev, 'засев S3-96: хотя бы одно мероприятие').toBeTruthy();
  await box.fill(ev!.number);
  const group = results.getByTestId('search-group-event');
  await expect(group).toContainText(`Мероприятие ${ev!.number}`);
  await expect(group.locator(`a[href="/events/${ev!.id}"]`)).toHaveCount(1);
  await box.press('Escape');
  await expect(results).toHaveCount(0);
});

test('5. Делегирование: Владелец выдаёт Директору «Создание филиалов» на город → право действует → отзыв → 403', async () => {
  const me = await ok<{ staff: { id: string }; actions: string[] }>(director.get(`${API}/me`));
  expect(me.actions).not.toContain('network.branch.create');
  // проба права без побочного эффекта: занятый слаг «krasny» – 409 NETWORK_SLUG_TAKEN после проверки права, филиал не создаётся
  const probe = () => director.post(`${API}/network/branches`, { headers: idem(), data: { cityId: nskCityId, slug: 'krasny', name: `e2e ${TAG}`, address: 'e2e: проверка права' } });
  expect((await probe()).status()).toBe(403);
  const branchesBefore = (await ok<{ items: unknown[] }>(owner.get(`${API}/network/branches`))).items.length;

  await open(crm, `/staff/${me.staff.id}`);
  const block = crm.getByTestId('staff-grants');
  await block.getByRole('button', { name: 'Выдать право' }).click();
  const form = crm.getByTestId('grant-form');
  await form.locator('#grant-action').selectOption('network.branch.create');
  await expect(crm.getByTestId('grant-action-hint')).toContainText('Выдаётся только на город');
  await form.locator('#grant-zone').selectOption({ label: 'Новосибирск – весь город' });
  await form.locator('#grant-to').fill(dayIn('UTC', 1));
  await form.locator('#grant-reason').fill('e2e: временное право на день');
  await form.getByRole('button', { name: 'Выдать' }).click();
  await expect(crm.getByTestId('grant-notice')).toContainText('Право «Создание филиалов» выдано.');
  const current = crm.getByTestId('grants-current');
  const row = current.getByTestId('grant-row').filter({ hasText: 'Создание филиалов' });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('Новосибирск (весь город)');
  await expect(row).toContainText('Действует');
  const grants = await ok<{ items: Array<{ id: string; action: string; cityId: string | null; revokedAt: string | null }> }>(owner.get(`${API}/staff/grants?staffId=${me.staff.id}`));
  const grant = grants.items.find((g) => g.action === 'network.branch.create' && g.cityId === nskCityId && !g.revokedAt);
  expect(grant).toBeTruthy();
  created.grants.push(grant!.id);

  expect((await ok<{ actions: string[] }>(director.get(`${API}/me`))).actions).toContain('network.branch.create');
  const granted = await probe();
  expect(granted.status()).toBe(409);
  expect(((await granted.json()) as { error: { code: string } }).error.code).toBe('NETWORK_SLUG_TAKEN');
  expect((await ok<{ items: unknown[] }>(owner.get(`${API}/network/branches`))).items.length).toBe(branchesBefore);

  await row.getByRole('button', { name: 'Отозвать' }).click();
  const revoke = crm.getByTestId('revoke-form');
  await expect(revoke).toContainText('Создание филиалов');
  await revoke.locator('#revoke-reason').fill('e2e: проверка отзыва');
  await revoke.getByRole('button', { name: 'Отозвать' }).click();
  await expect(crm.getByTestId('grant-notice')).toContainText('отозвано');
  await expect(crm.getByTestId('grants-past').getByTestId('grant-row').filter({ hasText: 'Создание филиалов' }).first()).toContainText('Отозвано');
  expect((await probe()).status()).toBe(403);
  expect((await ok<{ actions: string[] }>(director.get(`${API}/me`))).actions).not.toContain('network.branch.create');
});

test('6. Обезличивание: клиент сценария → кнопка у Владельца → «Обезличен» → поиск по старому телефону пуст', async () => {
  await client.cleanup(leftovers);
  const upcoming = (await client.my('upcoming')).items;
  test.skip(upcoming.length > 0, `у клиента осталась будущая бронь № ${upcoming[0]?.number} – отменить нельзя, обезличивание даст 409`);
  await open(crm, `/clients/${clientId}`);
  await crm.getByRole('button', { name: 'Обезличить', exact: true }).click();
  const dlg = crm.getByRole('dialog', { name: /Обезличить клиента/ });
  await expect(dlg).toContainText('Действие необратимо');
  await dlg.getByLabel('По просьбе клиента').check();
  await dlg.getByRole('button', { name: 'Обезличить навсегда' }).click();
  await expect(crm).toHaveURL(new RegExp(`/clients/${clientId}\\?anonymized=1$`));
  anonymized = true;
  await hydrated(crm);
  await expect(crm.getByTestId('client-anonymized')).toContainText('Клиент обезличен');
  await expect(crm.getByTestId('client-status')).toHaveText('Обезличен');
  await expect(crm.getByRole('heading', { level: 1 })).toHaveText('Без имени');
  await expect(crm.getByRole('button', { name: 'Обезличить', exact: true })).toHaveCount(0);
  expect(await crm.content()).not.toContain(client.phone.slice(2));

  const found = await ok<{ items: Array<{ id: string }> }>(owner.get(`${API}/clients?q=${encodeURIComponent(client.phone)}`));
  expect(found.items.map((c) => c.id)).not.toContain(clientId);
  const box = crm.getByRole('combobox', { name: 'Поиск по CRM' });
  await box.fill(client.phone);
  await expect(crm.getByTestId('search-results').getByTestId('search-empty')).toBeVisible();
  expect((await client.api.get('/api/public/v1/me/')).status()).toBe(401); // входы в ЛК закрыты
});

test('7. Лента событий: ремонт от Директора → у Владельца значок в шапке и новое событие', async () => {
  const before = (await ok<{ unread: number }>(owner.get(`${API}/staff-feed/unread-count`))).unread;
  const equipment = await ok<{ items: Array<{ id: string; status: string; inventoryNo?: string }> }>(director.get(`${API}/equipment?branchId=${krasny.id}&limit=20`));
  const item = equipment.items.find((e) => e.status !== 'written_off');
  expect(item, 'засев S3-96: оборудование на Красном').toBeTruthy();
  const reg = await ok<{ repair: { id: string; number: string } }>(director.post(`${API}/repairs`, {
    headers: idem(), data: { equipmentId: item!.id, detectedAt: new Date().toISOString(), brokenAtUnknown: true, symptoms: `e2e ${TAG}: проверка ленты событий`, priority: 'low', impact: 'none' },
  }));
  created.repair = reg.repair.id;
  const unreadNow = async () => (await ok<{ unread: number }>(owner.get(`${API}/staff-feed/unread-count`))).unread;
  await expect.poll(unreadNow, { timeout: 60_000, intervals: [2000] }).toBeGreaterThan(before);

  await open(crm, '/reports');
  const bell = crm.getByRole('button', { name: /^События/ });
  await expect(crm.getByTestId('feed-badge')).toHaveText(/^([1-9]\d*|99\+)$/);
  await expect(bell).toHaveAccessibleName(/^События, непрочитанных: \d+$/);
  await bell.click();
  const feed = crm.getByTestId('staff-feed');
  const event = feed.getByTestId('feed-item').filter({ hasText: `Новый ремонт № ${reg.repair.number}` });
  await expect(event).toHaveCount(1);
  await expect(event).toHaveAttribute('data-read', 'false');
  await expect(event).toContainText(`Ремонт · ${krasny.name}`);
  await expect(event).toContainText('Приоритет низкий, без простоя');
  const peak = await unreadNow();
  await event.getByRole('link').click();
  await expect(crm).toHaveURL(new RegExp(`/repairs/${reg.repair.id}$`));
  await hydrated(crm);
  // переход по событию отмечает его прочитанным: в списке read, число непрочитанных у Владельца уменьшилось
  const mine = await ok<{ items: Array<{ refId: string; read: boolean }> }>(owner.get(`${API}/staff-feed?limit=50`));
  expect(mine.items.find((x) => x.refId === reg.repair.id)?.read).toBe(true);
  await expect.poll(unreadNow, { timeout: 15_000 }).toBeLessThan(peak);
});

// S4-132 (коммуникации и контент): критерии 18 §8.4 через HTTP-маршруты API (CRM /api/crm/v1, сайт и ЛК /api/public/v1) на настоящей
// Postgres, один сервер на все сценарии: напоминание по зоне филиала, перенос брони переносит напоминание, повтор без дублей,
// кампания с предпросмотром и вторым подтверждением, отказ от рекламы не трогает сервисные, центр уведомлений ЛК, отписка по ссылке,
// CMS (черновик не виден, публикация по охвату, 301 при смене адреса), отчёт «Коммуникации» = журнал отправок (TC-20).
// Работа worker вызывается тестом: доставка outbox обработчикам K14, разворачивание кампании, отправка due-строк на приёмник push.
// Часы двигаются по сценарию; вход сотрудников повторяется после сдвига (сессия живёт 8 ч простоя).
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import { createFileStore } from '../../apps/api/src/core/files.ts';
import { clearSubscriptions, processEvent } from '../../apps/api/src/core/outbox.ts';
import { localToInstant, type Clock, type LocalDate, type LocalTime, type TimeZone } from '../../apps/api/src/core/time.ts';
import { bookingLookup } from '../../apps/api/src/modules/booking/providers.ts';
import { clientAuthConfig, createDevSmsSender, type DevSmsSender } from '../../apps/api/src/modules/clients/otp.ts';
import { expandCampaign } from '../../apps/api/src/modules/notifications/campaign-runner.ts';
import { HANDLERS, registerNotificationHandlers } from '../../apps/api/src/modules/notifications/handlers.ts';
import { runDue, type SenderDeps } from '../../apps/api/src/modules/notifications/sender.ts';
import { generateVapidKeys, vapidKeys } from '../../apps/api/src/modules/notifications/webpush.ts';
import { createReportsPool } from '../../apps/api/src/modules/reports/framework.ts';
import { staffAuthConfig } from '../../apps/api/src/modules/staff/auth.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { seedContent } from '../../db/seed/content.ts';
import { DEMO_EMAIL_DOMAIN, seedDev } from '../../db/seed/dev.ts';
import { seedResources } from '../../db/seed/resources.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';
import { decryptAes128gcm, fakeBrowser, startPushReceiver, type FakeBrowser, type PushReceiver } from '../helpers/push-receiver.ts';

const PASSWORD = 'Демо-пароль-сквозной-Э4';
const SECRET = 'u'.repeat(32);
const CRM = '/api/crm/v1';
const LK = '/api/public/v1';
const NSK = 'Asia/Novosibirsk' as TimeZone;
const MSK = 'Europe/Moscow' as TimeZone;
const now = { value: new Date('2026-11-20T06:00:00Z') }; // пятница, 13:00 Новосибирска, 09:00 Москвы
const clock: Clock = { now: () => now.value };
const local = (date: string, time: string, tz: TimeZone) => localToInstant(date as LocalDate, time as LocalTime, tz);
const pair = generateVapidKeys();
let db: TestDatabase;
let pool: pg.Pool;
let reports: pg.Pool;
let app: FastifyInstance;
let sms: DevSmsSender;
let rx: PushReceiver;
let sender: SenderDeps;
let mediaDir: string;
let exportDir: string;
const cookies: Record<string, string> = {};
const ids: Record<string, string> = {};
type Client = { id: string; cookie: string; ua: FakeBrowser; path: string };
const clients: Record<'a' | 'b', Client> = {} as Record<'a' | 'b', Client>;
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH';
type Res = Awaited<ReturnType<FastifyInstance['inject']>>;

const crm = (who: string, method: Method, url: string, payload?: object, key: string = randomUUID()) =>
  app.inject({ method, url: `${CRM}${url}`, headers: { cookie: cookies[who]!, ...(method !== 'GET' ? { 'idempotency-key': key } : {}) }, ...(payload ? { payload } : {}) });
const lk = (c: Client | null, method: Method, url: string, payload?: object, key: string = randomUUID()) =>
  app.inject({ method, url: `${LK}${url}`, headers: { ...(c ? { cookie: c.cookie } : {}), ...(method !== 'GET' ? { 'idempotency-key': key } : {}) }, ...(payload ? { payload } : {}) });
const ok = async (p: Promise<Res>, code = 200) => {
  const r = await p;
  expect(r.statusCode, r.body).toBe(code);
  return r.json();
};
const errorOf = async (p: Promise<Res>) => {
  const r = await p;
  return [r.statusCode, r.json().error?.code];
};

async function login(key: string): Promise<void> {
  const res = await app.inject({ method: 'POST', url: `${CRM}/auth/login`, payload: { email: `${key}@${DEMO_EMAIL_DOMAIN}`, password: PASSWORD } });
  expect(res.statusCode, res.body).toBe(200);
  cookies[key] = String(res.headers['set-cookie']).split(';')[0]!;
}
/** Сдвиг часов сценария; сотрудники входят заново. */
async function at(iso: string | Date): Promise<void> {
  now.value = new Date(iso);
  for (const key of ['owner', 'director']) await login(key);
}

async function clientLogin(key: 'a' | 'b', phone: string): Promise<void> {
  const r = await lk(null, 'POST', '/auth/otp/request', { phone, purpose: 'login' });
  expect(r.statusCode, r.body).toBeLessThan(300);
  const v = await app.inject({ method: 'POST', url: `${LK}/auth/otp/verify`, payload: { challengeId: r.json().challengeId, code: /\d{6}/.exec(sms.sent.at(-1)!.text)![0], consents: { pdProcessing: true } } });
  expect(v.statusCode, v.body).toBe(200);
  const id = (await db.client.query<{ id: string }>('SELECT id FROM app.clients WHERE phone_e164 = $1', [phone])).rows[0]!.id;
  clients[key] = { id, cookie: String(v.headers['set-cookie']).split(';')[0]!, ua: fakeBrowser(), path: `/push/${key}` };
  const c = clients[key];
  await ok(lk(c, 'POST', '/me/push-subscriptions', { endpoint: rx.endpoint(c.path), keys: { p256dh: c.ua.p256dh, auth: c.ua.auth } }), 201);
}

/** Доставка событий outbox обработчикам уведомлений K14 – то, что делает worker. Повтор доставки гасит processed_events. */
async function deliver(): Promise<void> {
  const map: Record<string, string> = { 'booking.confirmed': HANDLERS.confirmed, 'booking.rescheduled': HANDLERS.rescheduled, 'booking.cancelled': HANDLERS.cancelled, 'client.notification_prefs_changed': HANDLERS.prefs };
  const r = await db.client.query<{ id: string; event_type: string }>(`SELECT id, event_type FROM app.outbox_events WHERE event_type = ANY($1) ORDER BY occurred_at, id`, [Object.keys(map)]);
  for (const e of r.rows) await processEvent(pool, map[e.event_type]!, e.id, clock.now());
}
/** Отправка due-строк (диспетчер worker) и расшифрованные push этого прохода по клиентам. */
async function dispatch(): Promise<Record<'a' | 'b', Array<{ title: string; body: string; unsubscribeUrl?: string }>>> {
  rx.received.length = 0;
  await runDue(sender);
  const out = { a: [], b: [] } as Record<'a' | 'b', Array<{ title: string; body: string; unsubscribeUrl?: string }>>;
  for (const p of rx.received) {
    const key = (['a', 'b'] as const).find((k) => clients[k].path === p.path)!;
    out[key].push(JSON.parse(decryptAes128gcm(p.body, clients[key].ua).plaintext.toString()));
  }
  return out;
}
type Row = { id: string; kind: string; category: string; status: string; plannedAt: string; bookingId: string | null };
const journal = async (clientId: string, extra = ''): Promise<Row[]> => (await ok(crm('owner', 'GET', `/notifications?clientId=${clientId}${extra}`))).items;
const byKind = (rows: Row[], kind: string) => rows.filter((r) => r.kind === kind);

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 8 });
  reports = createReportsPool(db.reportsUrl);
  rx = await startPushReceiver();
  sms = createDevSmsSender('dev');
  mediaDir = await mkdtemp(join(tmpdir(), 'yu-e4-media-'));
  exportDir = await mkdtemp(join(tmpdir(), 'yu-e4-export-'));
  const env = { APP_ENV: 'test' };
  const before = { now: () => new Date('2026-11-18T05:00:00Z') };
  await seedDev(pool, { env, password: PASSWORD }, before);
  await seedResources(pool, { env }, before);
  await seedContent(pool, { env, mediaDir }, before);
  clearSubscriptions();
  registerNotificationHandlers({ bookings: bookingLookup, clock });
  sender = { pool, clock, vapid: vapidKeys(pair.publicKey, pair.privateKey, 'mailto:ops@yu-club.test'), timeoutMs: 3000, bookings: bookingLookup, unsubscribeSecret: SECRET };
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), {
    staff: { pool, auth: staffAuthConfig('k'.repeat(40)), clock },
    clients: { pool, auth: clientAuthConfig('c'.repeat(40)), sms, clock },
    network: { pool, clock },
    notifications: { vapidPublicKey: pair.publicKey, allowedPushHosts: ['127.0.0.1'], unsubscribeSecret: SECRET },
    content: { mediaStore: createFileStore({ root: mediaDir }) },
    reports: { pool: reports, exportStore: createFileStore({ root: exportDir }) },
  });
  await at(now.value);
  for (const r of (await db.client.query<{ id: string; code: string }>(`SELECT id, code FROM app.branches`)).rows) ids[r.code] = r.id;
  for (const r of (await db.client.query<{ id: string; code: string }>(`SELECT id, code FROM app.cities`)).rows) ids[r.code] = r.id;
  const pc = async (code: string) => (await db.client.query<{ id: string }>(`SELECT id FROM app.resources WHERE branch_id = $1 AND resource_type = 'pc' ORDER BY name LIMIT 2`, [ids[code]])).rows.map((r) => r.id);
  const [nsk1, nsk2] = await pc('demo-nsk-krasny');
  const [msk1] = await pc('demo-msk-arbat');
  Object.assign(ids, { pcNsk1: nsk1!, pcNsk2: nsk2!, pcMsk1: msk1! });
  ids.reason = (await db.client.query<{ id: string }>(`SELECT id FROM app.dict_reasons WHERE domain = 'booking_cancel_club' ORDER BY code LIMIT 1`)).rows[0]!.id;
  ids.media = (await db.client.query<{ id: string }>(`SELECT id FROM app.content_media ORDER BY created_at LIMIT 1`)).rows[0]!.id;
  // текст согласия на рекламу – через CMS (без живой версии реклама не включается, K22 §7)
  const draft = await ok(crm('owner', 'GET', '/content/pages/advertising-consent/draft'));
  const saved = await ok(crm('owner', 'PUT', '/content/pages/advertising-consent/draft', { rowVersion: draft.rowVersion ?? 1, draft: { title: 'Согласие на рекламу', body: 'Текст согласия', documentVersion: 'advertising-consent-2026-11-20' } }));
  await ok(crm('owner', 'POST', '/content/pages/advertising-consent/publish', { rowVersion: saved.rowVersion }));
  await clientLogin('a', '+79131110001');
  await clientLogin('b', '+79131110002');
  for (const c of [clients.a, clients.b]) await ok(lk(c, 'PUT', '/me/notification-settings', { remindersEnabled: true, marketingEnabled: true }));
}, 120_000);
afterAll(async () => {
  clearSubscriptions();
  await app.close();
  await rx.close();
  await reports.end();
  await pool.end();
  await db.drop();
  await rm(mediaDir, { recursive: true, force: true });
  await rm(exportDir, { recursive: true, force: true });
});

describe('S4-132: 18 §8.4 (уведомления и контент) по HTTP', () => {
  it('1. напоминание по зоне филиала: «накануне» – в 21:00 местного времени каждого филиала, «за 15 минут» – от начала; текст – по часам филиала', async () => {
    // сеанс 22.11 в 12:00 местного: Красный (Новосибирск) – клиент A, Арбат (Москва) – клиент B
    const make = async (branch: string, resourceId: string, c: Client, tz: TimeZone) => {
      const start = local('2026-11-22', '12:00', tz);
      const b = await ok(crm('owner', 'POST', `/branches/${ids[branch]}/bookings`, { resourceId, start: start.toISOString(), end: new Date(start.getTime() + 3_600_000).toISOString(), client: { clientId: c.id } }), 201);
      return b.id as string;
    };
    ids.bookingA = await make('demo-nsk-krasny', ids.pcNsk1!, clients.a, NSK);
    ids.bookingB = await make('demo-msk-arbat', ids.pcMsk1!, clients.b, MSK);
    await deliver();
    for (const [c, tz, booking] of [[clients.a, NSK, ids.bookingA], [clients.b, MSK, ids.bookingB]] as const) {
      const rows = await journal(c.id, `&bookingId=${booking}`);
      expect(byKind(rows, 'reminder_day_before').map((r) => r.plannedAt)).toEqual([local('2026-11-21', '21:00', tz).toISOString()]);
      expect(byKind(rows, 'reminder_before_start').map((r) => r.plannedAt)).toEqual([local('2026-11-22', '11:45', tz).toISOString()]);
      expect(byKind(rows, 'booking_confirmed').map((r) => r.category)).toEqual(['service']);
    }
    const confirmed = await dispatch();
    expect([confirmed.a.map((p) => p.title), confirmed.b.map((p) => p.title)]).toEqual([['Ю-Клуб: запись подтверждена'], ['Ю-Клуб: запись подтверждена']]);
    // 21:00 Новосибирска = 17:00 Москвы: уходит только напоминание A
    await at(local('2026-11-21', '21:00', NSK));
    const nskEvening = await dispatch();
    expect([nskEvening.a.length, nskEvening.b.length]).toEqual([1, 0]);
    expect(nskEvening.a[0]!.body).toContain('12:00');
    await at(local('2026-11-21', '21:00', MSK));
    const mskEvening = await dispatch();
    expect([mskEvening.a.length, mskEvening.b.length]).toEqual([0, 1]);
    expect(mskEvening.b[0]!.body).toContain('12:00');
  });

  it('2. перенос брони переносит напоминание: прежнее «за 15 минут» не уходит, новое – от нового начала; «было/стало» – сервисным', async () => {
    await at('2026-11-21T19:00:00Z'); // 02:00 22.11 по Новосибирску – «накануне» для нового времени уже прошло
    const card = await ok(crm('owner', 'GET', `/bookings/${ids.bookingA}`));
    const start = local('2026-11-22', '14:00', NSK);
    await ok(crm('owner', 'POST', `/bookings/${ids.bookingA}/reschedule`, { rowVersion: card.rowVersion, resourceId: ids.pcNsk2, start: start.toISOString(), end: new Date(start.getTime() + 3_600_000).toISOString(), reason: 'просьба клиента' }));
    await deliver();
    const rows = await journal(clients.a.id, `&bookingId=${ids.bookingA}`);
    const before = byKind(rows, 'reminder_before_start');
    expect(before.map((r) => [r.plannedAt, r.status]).sort()).toEqual([
      [local('2026-11-22', '11:45', NSK).toISOString(), 'skipped_booking_changed'],
      [local('2026-11-22', '13:45', NSK).toISOString(), 'planned'],
    ]);
    expect(byKind(rows, 'booking_rescheduled').map((r) => r.category)).toEqual(['service']);
    expect((await dispatch()).a.map((p) => p.title)).toEqual(['Ю-Клуб: запись перенесена']);
    await at(local('2026-11-22', '11:45', NSK)); // прежнее время напоминания – тишина
    expect((await dispatch()).a).toEqual([]);
    await at(local('2026-11-22', '13:45', NSK));
    const due = await dispatch();
    expect(due.a.map((p) => p.title)).toEqual(['Ю-Клуб: сеанс скоро начнётся']);
    expect(due.a[0]!.body).toContain('14:00');
  });

  it('3. повтор не создаёт дублей: повторная доставка событий (и после потери отметки), повтор команды с тем же ключом, второй проход отправки', async () => {
    const count = async () => Number((await db.client.query<{ n: string }>(`SELECT count(*) n FROM app.notifications`)).rows[0]!.n);
    const n = await count();
    await deliver();
    await db.client.query(`DELETE FROM app.processed_events WHERE handler = ANY($1)`, [[HANDLERS.confirmed, HANDLERS.rescheduled]]); // потерянная отметка обработки
    await deliver();
    expect(await count()).toBe(n);
    const card = await ok(crm('owner', 'GET', `/bookings/${ids.bookingB}`));
    const key = randomUUID();
    const body = { rowVersion: card.rowVersion, internalComment: 'повтор' };
    const first = await crm('owner', 'PATCH', `/bookings/${ids.bookingB}`, body, key);
    const again = await crm('owner', 'PATCH', `/bookings/${ids.bookingB}`, body, key);
    expect([first.statusCode, again.statusCode, again.headers['idempotent-replay']]).toEqual([200, 200, 'true']);
    expect(await dispatch()).toEqual({ a: [], b: [] }); // всё отправленное уже отправлено – второй push не уходит
  });

  it('4. кампания: предпросмотр с исключёнными по отказу; подтверждение без числа или с неверным – AUDIENCE_CHANGED; Директор не берёт чужой филиал', async () => {
    await at(local('2026-11-22', '15:00', NSK)); // 11:00 Москвы – окно рекламы 10–21 у обоих
    await ok(lk(clients.a, 'PUT', '/me/notification-settings', { remindersEnabled: true, marketingEnabled: false })); // A отказался от рекламы в ЛК
    const audience = { kind: 'segment', segment: { v: 1, area: { branchIds: [ids['demo-nsk-krasny'], ids['demo-msk-arbat']] } } };
    expect(await errorOf(crm('director', 'POST', '/notifications/campaigns', { category: 'marketing', title: 'Акция', body: 'Текст', erid: 'E-1', audience: { kind: 'segment', segment: { v: 1, area: { branchIds: [ids['demo-msk-arbat']] } } } }))).toEqual([404, 'NOT_FOUND']);
    const c = await ok(crm('owner', 'POST', '/notifications/campaigns', { category: 'marketing', title: 'Ночной пакет', body: 'Скидка 20%', erid: 'E-1', audience }), 201);
    const preview = await ok(crm('owner', 'POST', `/notifications/campaigns/${c.id}/preview`, {}));
    expect(preview).toMatchObject({ total: 2, excludedMarketingOff: 1, willReceivePush: 1 });
    expect(await errorOf(crm('owner', 'POST', `/notifications/campaigns/${c.id}/confirm`, { rowVersion: c.rowVersion }))).toEqual([409, 'AUDIENCE_CHANGED']);
    expect(await errorOf(crm('owner', 'POST', `/notifications/campaigns/${c.id}/confirm`, { rowVersion: c.rowVersion, expectedTotal: 3 }))).toEqual([409, 'AUDIENCE_CHANGED']);
    const key = randomUUID();
    const confirmed = await ok(crm('owner', 'POST', `/notifications/campaigns/${c.id}/confirm`, { rowVersion: c.rowVersion, expectedTotal: preview.total }, key));
    expect(confirmed).toMatchObject({ status: 'confirmed', total: 2 });
    expect((await ok(crm('owner', 'POST', `/notifications/campaigns/${c.id}/confirm`, { rowVersion: c.rowVersion, expectedTotal: preview.total }, key))).id).toBe(c.id);
    await expandCampaign(pool, clock, c.id);
    await expandCampaign(pool, clock, c.id); // повтор разворачивания – одна строка на клиента
    const rows = (await db.client.query<{ client_id: string; n: number }>(`SELECT client_id, count(*)::int n FROM app.notifications WHERE campaign_id = $1 GROUP BY 1`, [c.id])).rows;
    expect(rows.every((r) => r.n === 1)).toBe(true);
    ids.campaign = c.id;
  });

  it('5. отказ от рекламы не трогает сервисные: реклама уходит только B; отмена записи клубом приходит A; напоминания A шли и после отказа', async () => {
    const sent = await dispatch();
    expect(sent.a).toEqual([]);
    expect(sent.b.map((p) => p.title)).toEqual(['Реклама. Ночной пакет']);
    ids.unsubscribeUrl = sent.b[0]!.unsubscribeUrl!;
    expect((await journal(clients.a.id, '&category=marketing')).every((r) => r.status === 'skipped_by_prefs')).toBe(true);
    // прежний сеанс A уже идёт – новая запись на 23.11 и её отмена клубом
    const start = local('2026-11-23', '12:00', NSK);
    const b = await ok(crm('owner', 'POST', `/branches/${ids['demo-nsk-krasny']}/bookings`, { resourceId: ids.pcNsk1, start: start.toISOString(), end: new Date(start.getTime() + 1_800_000).toISOString(), client: { clientId: clients.a.id } }), 201);
    await ok(crm('owner', 'POST', `/bookings/${b.id}/cancel`, { rowVersion: 1, initiator: 'club', reasonId: ids.reason, comment: 'авария' }));
    await deliver();
    const after = await dispatch();
    expect(after.a.map((p) => p.title)).toContain('Ю-Клуб: запись отменена клубом');
    expect(after.b).toEqual([]);
    const reminders = (await journal(clients.a.id, '&category=reminder')).filter((r) => r.status === 'sent_to_provider');
    expect(reminders.length).toBeGreaterThanOrEqual(2);
  });

  it('6. центр уведомлений ЛК: свои сообщения без рекламы, от которой отказался; счётчик непрочитанных; прочтение одного и всех', async () => {
    const page = await ok(lk(clients.a, 'GET', '/me/notifications'));
    const items = page.items as Array<{ id: string; category: string; kind: string; read: boolean; booking: { state: string } | null }>;
    expect(items.length).toBeGreaterThanOrEqual(5);
    expect(items.some((i) => i.category === 'marketing')).toBe(false);
    expect(items.find((i) => i.kind === 'booking_cancelled')?.booking?.state).toBe('cancelled');
    const unread = (await ok(lk(clients.a, 'GET', '/me/notifications/unread-count'))).unread as number;
    expect(unread).toBe(items.filter((i) => !i.read).length);
    expect((await lk(clients.a, 'POST', `/me/notifications/${items[0]!.id}/read`)).statusCode).toBe(204);
    expect((await ok(lk(clients.a, 'GET', '/me/notifications/unread-count'))).unread).toBe(unread - 1);
    await ok(lk(clients.a, 'POST', '/me/notifications/read-all', { before: clock.now().toISOString() }));
    expect((await ok(lk(clients.a, 'GET', '/me/notifications/unread-count'))).unread).toBe(0);
    // чужое сообщение прочитать нельзя – и не видно
    expect(((await ok(lk(clients.b, 'GET', '/me/notifications'))).items as Array<{ id: string }>).map((i) => i.id)).not.toContain(items[0]!.id);
    expect((await ok(lk(clients.b, 'GET', '/me/notifications'))).items.some((i: { category: string }) => i.category === 'marketing')).toBe(true);
  });

  it('7. отписка по ссылке из push: проверка не отписывает, кнопка – отписывает (повтор без записей); следующая кампания B не включает', async () => {
    const t = new URL(ids.unsubscribeUrl!, 'https://yu-club.test').searchParams.get('t')!;
    expect(await ok(lk(null, 'GET', `/unsubscribe/check?t=${encodeURIComponent(t)}`))).toEqual({ valid: true, marketingEnabled: true });
    expect((await ok(lk(clients.b, 'GET', '/me/notification-settings'))).marketingEnabled).toBe(true);
    expect(await ok(lk(null, 'POST', '/unsubscribe', { t }))).toEqual({ marketingEnabled: false });
    expect(await ok(lk(null, 'POST', '/unsubscribe', { t }))).toEqual({ marketingEnabled: false });
    const consents = (await db.client.query<{ n: number }>(`SELECT count(*)::int n FROM journal.client_consents WHERE client_id = $1 AND kind = 'marketing' AND granted = false`, [clients.b.id])).rows[0]!.n;
    expect(consents).toBe(1);
    expect(await errorOf(lk(null, 'POST', '/unsubscribe', { t: `${t}x` }))).toEqual([400, 'UNSUBSCRIBE_TOKEN_INVALID']);
    expect((await ok(lk(clients.b, 'GET', '/me/notification-settings'))).marketingEnabled).toBe(false);
    const c = await ok(crm('owner', 'POST', '/notifications/campaigns', { category: 'marketing', title: 'Ещё акция', body: 'Текст', erid: 'E-2', audience: { kind: 'segment', segment: { v: 1, area: { branchIds: [ids['demo-msk-arbat']] } } } }), 201);
    expect(await ok(crm('owner', 'POST', `/notifications/campaigns/${c.id}/preview`, {}))).toMatchObject({ total: 1, excludedMarketingOff: 1, willReceivePush: 0 });
  });

  it('8. CMS: черновик публикации не виден на сайте ни списком, ни по адресу', async () => {
    const draft = { scope: { type: 'city', cityIds: [ids['demo-nsk']] }, title: 'Турнир по CS2 в Новосибирске', lead: 'Подводка', body: 'Текст', slug: 'cs2-nsk', coverMediaId: ids.media, publishFrom: '2026-11-20T00:00:00Z' };
    const row = await ok(crm('owner', 'POST', '/content/publications', { type: 'news', draft }), 201);
    ids.news = row.id;
    ids.newsVersion = String(row.rowVersion);
    const slugs = async (q: string) => ((await ok(lk(null, 'GET', `/content/publications?type=news&${q}`))).items as Array<{ slug: string }>).map((i) => i.slug);
    expect(await slugs(`city=${ids['demo-nsk']}`)).not.toContain('cs2-nsk');
    expect((await lk(null, 'GET', '/content/publications/news/cs2-nsk')).statusCode).toBe(404);
  });

  it('9. CMS: опубликованное видно только в своём охвате – Новосибирску (город и его филиал), не Москве', async () => {
    await ok(crm('owner', 'POST', `/content/publications/${ids.news}/publish`, { rowVersion: Number(ids.newsVersion) }));
    const slugs = async (q: string) => ((await ok(lk(null, 'GET', `/content/publications?type=news&${q}`))).items as Array<{ slug: string }>).map((i) => i.slug);
    expect(await slugs(`city=${ids['demo-nsk']}`)).toContain('cs2-nsk');
    expect(await slugs(`branch=${ids['demo-nsk-krasny']}`)).toContain('cs2-nsk');
    expect(await slugs(`city=${ids['demo-msk']}`)).not.toContain('cs2-nsk');
    expect(await slugs(`branch=${ids['demo-msk-arbat']}`)).not.toContain('cs2-nsk');
    const page = await ok(lk(null, 'GET', `/content/publications/news/cs2-nsk?branch=${ids['demo-msk-arbat']}`));
    expect(page.appliesHere).toBe(false);
    expect((await ok(lk(null, 'GET', `/content/publications/news/cs2-nsk?branch=${ids['demo-nsk-krasny']}`))).appliesHere).toBe(true);
  });

  it('10. CMS: смена адреса опубликованного – старый адрес ведёт на новый (301 на сайте), новый открывается, старый – нет', async () => {
    const cur = await ok(crm('owner', 'GET', `/content/publications/${ids.news}`));
    const saved = await ok(crm('owner', 'PUT', `/content/publications/${ids.news}/draft`, { rowVersion: cur.rowVersion, draft: { ...cur.draft, slug: 'cs2-turnir-nsk' } }));
    await ok(crm('owner', 'POST', `/content/publications/${ids.news}/publish`, { rowVersion: saved.rowVersion }));
    const hit = await lk(null, 'GET', `/redirects/resolve?path=${encodeURIComponent('/news/cs2-nsk/')}`);
    expect([hit.statusCode, hit.json()]).toEqual([200, { location: '/news/cs2-turnir-nsk/' }]);
    expect((await lk(null, 'GET', '/content/publications/news/cs2-turnir-nsk')).statusCode).toBe(200);
    expect((await lk(null, 'GET', '/content/publications/news/cs2-nsk')).statusCode).toBe(404);
    expect((await lk(null, 'GET', `/redirects/resolve?path=${encodeURIComponent('/news/cs2-turnir-nsk/')}`)).statusCode).toBe(404); // цель не редиректит дальше
  });

  it('11. TC-20 «Коммуникации»: показатели = журнал отправок по категориям и статусам; детализация = итог; Директор видит только свою зону', async () => {
    const q = 'from=2026-11-01&to=2026-11-30';
    const m = (await ok(crm('owner', 'GET', `/reports/comms?${q}`))).metrics as Record<string, { state: string; value?: number }>;
    const n = async (sql: string, p: unknown[] = []) => Number((await db.client.query<{ n: string }>(`SELECT count(*) n FROM app.notifications WHERE ${sql}`, p)).rows[0]!.n);
    for (const cat of ['service', 'reminder', 'marketing']) {
      expect([cat, 'created', m[`${cat}Created`]?.value ?? 0]).toEqual([cat, 'created', await n('category = $1', [cat])]);
      expect([cat, 'sent', m[`${cat}SentToProvider`]?.value ?? 0]).toEqual([cat, 'sent', await n(`category = $1 AND status = 'sent_to_provider'`, [cat])]);
    }
    expect(m.reminderSkippedBookingChanged?.value).toBe(await n(`category = 'reminder' AND status = 'skipped_booking_changed'`));
    expect(m.marketingSkippedByPrefs?.value).toBe(await n(`category = 'marketing' AND status = 'skipped_by_prefs'`));
    expect(m.optOuts?.value).toBeGreaterThanOrEqual(2); // отказ в ЛК (A) и по ссылке (B)
    for (const [key, metric] of Object.entries(m)) {
      if (metric.state === 'unavailable') continue;
      const d = await ok(crm('owner', 'GET', `/reports/comms/detail?${q}&metric=${key}&limit=500`));
      if (metric.state === 'ok' && metric.value === 0) expect([key, d.total.state]).toEqual([key, 'no_data']);
      else expect([key, d.total]).toEqual([key, metric]);
    }
    const dir = (await ok(crm('director', 'GET', `/reports/comms?${q}`))).metrics as Record<string, { value?: number }>;
    expect(dir.marketingSentToProvider?.value ?? 0).toBe(0); // единственная отправленная реклама – клиенту Арбата
    expect((await crm('director', 'GET', `/reports/comms?${q}&branchIds=${ids['demo-msk-arbat']}`)).statusCode).toBe(404);
  });
});

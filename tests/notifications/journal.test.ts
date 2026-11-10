// S4-17: журнал отправок K21 §9: фильтры и зона, счётчики кампании, сводка клиента без endpoint и ключей, ручной повтор.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { expandCampaign } from '../../apps/api/src/modules/notifications/campaign-runner.ts';
import { confirmCampaign, createCampaign, type CampaignDeps, type CampaignDto } from '../../apps/api/src/modules/notifications/campaigns.ts';
import { clientNotificationSummary, failuresSummary, getCampaignDetail, listCampaigns, listNotifications, retryNotification, type NotificationView } from '../../apps/api/src/modules/notifications/journal.ts';
import { createTestBranch } from '../helpers/network.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const clock = fixedClock('2026-11-20T06:00:00Z');
let db: TestDatabase;
let pool: pg.Pool;
let deps: CampaignDeps;
let staffId: string;
let b1: string;
let b2: string;
let pc1: string;
let owner: AccessContext;
let director: AccessContext;
let admin: AccessContext;
let phone = 79210001000;
const meta = (): AuditRequestMeta => ({ actor: { kind: 'staff', staffId, sessionId: 's' }, source: 'crm', requestId: randomUUID() });

async function client(branch = b1): Promise<string> {
  const id = (await db.client.query<{ id: string }>(`INSERT INTO app.clients (phone_e164, status, first_name, registered_at, created_by_type) VALUES ($1, 'active', 'Прокл', now(), 'system') RETURNING id`, [`+${++phone}`])).rows[0]!.id;
  await db.client.query('INSERT INTO app.client_notification_prefs (client_id, marketing_enabled) VALUES ($1, true)', [id]);
  await db.client.query(`INSERT INTO journal.client_consents (client_id, kind, granted, document_version, source, actor_type, actor_id, at) VALUES ($1, 'marketing', true, 'v7', 'account', 'client', $1, '2026-03-01T00:00:00Z')`, [id]);
  const res = branch === b1 ? pc1 : (await db.client.query<{ id: string }>(`INSERT INTO app.resources (branch_id, resource_type, name) VALUES ($1, 'pc', 'ПК') RETURNING id`, [branch])).rows[0]!.id;
  await db.client.query(
    `INSERT INTO app.bookings (checkout_id, branch_id, client_id, status, resource_id, period, price_kop, source, created_by_type)
     VALUES (gen_random_uuid(), $1, $2, 'completed', $3, tstzrange('2026-10-01 07:00+00', '2026-10-01 08:00+00', '[)'), 0, 'crm', 'system')`,
    [branch, id, res],
  );
  return id;
}

async function row(clientId: string, over: { branchId?: string | null; category?: string; kind?: string; status?: string; source?: string; bookingId?: string | null; initiatorId?: string | null; plannedAt?: Date } = {}): Promise<string> {
  const status = over.status ?? 'error';
  const r = await db.client.query<{ id: string }>(
    `INSERT INTO app.notifications (client_id, branch_id, category, kind, booking_id, booking_version, source, initiator_id, title, body, planned_at, status, sent_at, dedupe_key)
     VALUES ($1, $2, $3, $4, $5, 1, $6, $10, 'Ваша запись', 'Текст', $7, $8, CASE WHEN $8 = 'sent_to_provider' THEN $7::timestamptz END, $9) RETURNING id`,
    [clientId, over.branchId === undefined ? b1 : over.branchId, over.category ?? 'service', over.kind ?? 'booking_cancelled', over.bookingId ?? null, over.source ?? 'system', over.plannedAt ?? clock.now(), status, `t:${randomUUID()}`, over.initiatorId ?? null],
  );
  return r.rows[0]!.id;
}

describe('сбои критичных уведомлений для рабочего стола Владельца (K21 §9, K24 §4)', () => {
  it('считает сервисные error за период по зоне; реклама, no_channel, старые и уже повторённые – нет; неудачный повтор – сам', async () => {
    const c = await client();
    const now = clock.now();
    const dayAgo = new Date(now.getTime() - 86_400_000);
    const own = await row(c, { plannedAt: dayAgo }); // b1, service, error – считается
    await row(c, { branchId: b2, plannedAt: dayAgo }); // чужой филиал – только Владельцу
    await row(c, { branchId: null, plannedAt: dayAgo }); // сетевая – только зона сети
    await row(c, { category: 'marketing', kind: 'campaign', plannedAt: dayAgo }); // реклама – не критичное
    await row(c, { status: 'no_channel', plannedAt: dayAgo }); // нет канала – не ошибка
    await row(c, { plannedAt: new Date(now.getTime() - 10 * 86_400_000) }); // старше 7 дней
    const retried = await row(c, { plannedAt: dayAgo });
    await retryNotification(pool, clock, owner, meta(), retried, { reason: 'повтор' }, randomUUID()); // по ней повтор уже сделан – не считается, повтор planned – тоже
    const failedRetry = await row(c, { plannedAt: dayAgo });
    const r = (await retryNotification(pool, clock, owner, meta(), failedRetry, { reason: 'повтор' }, randomUUID())).body as NotificationView;
    await db.client.query(`UPDATE app.notifications SET status = 'error' WHERE id = $1`, [r.id]); // повтор тоже упал – считается он сам, не исходная
    const at = new Date(now.getTime() + 60_000); // «сейчас» рабочего стола – минутой позже повторов: период [from, to), строки в момент to не входят
    const before = await failuresSummary(pool, director, { days: 7, now: at });
    expect(before).toEqual({ critical: 2, period: { from: new Date(at.getTime() - 7 * 86_400_000).toISOString(), to: at.toISOString(), days: 7 } });
    expect((await failuresSummary(pool, admin, { days: 7, now: at })).critical).toBe(2);
    expect((await failuresSummary(pool, owner, { days: 7, now: at })).critical).toBe(4);
    expect((await failuresSummary(pool, owner, { days: 30, now: at })).critical).toBe(5);
    expect((await failuresSummary(pool, director, { days: 7, now: dayAgo })).critical).toBe(0);
    await retryNotification(pool, clock, owner, meta(), own, { reason: 'повтор' }, randomUUID());
    expect((await failuresSummary(pool, director, { days: 7, now: at })).critical).toBe(1);
  });
});

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 6 });
  b1 = (await createTestBranch(db.client)).id;
  b2 = (await createTestBranch(db.client)).id;
  pc1 = (await db.client.query<{ id: string }>(`INSERT INTO app.resources (branch_id, resource_type, name) VALUES ($1, 'pc', 'ПК') RETURNING id`, [b1])).rows[0]!.id;
  staffId = (await db.client.query<{ id: string }>(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('О', 'В', 'o@yu.test', 'owner', 'x') RETURNING id`)).rows[0]!.id;
  const ctx = (role: 'owner' | 'director' | 'admin', net: boolean): AccessContext => ({ actor: { kind: 'staff', staffId, sessionId: 's' }, role, network: net, cityIds: new Set(), branchIds: new Set(net ? [] : [b1]), at: clock.now() });
  owner = ctx('owner', true);
  director = ctx('director', false);
  admin = ctx('admin', false);
  deps = { pool, clock, network: { branchesOfCities: async () => [] }, bookings: { facts: async () => null }, unsubscribeSecret: 's'.repeat(32) };
});
afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('ручной повтор K21 §9', () => {
  it('новая строка с retry_of, ключ :retry:n, исходная не изменилась; повтор с тем же ключом – та же строка', async () => {
    const c = await client();
    const id = await row(c);
    const before = (await db.client.query(`SELECT * FROM app.notifications WHERE id = $1`, [id])).rows[0];
    const key = randomUUID();
    const r = await retryNotification(pool, clock, director, meta(), id, { reason: 'клиент подключил браузер' }, key);
    const n = r.body as NotificationView;
    expect([r.status, n.retryOf, n.status, n.title, n.authorName]).toEqual([201, id, 'planned', 'Ваша запись', 'О В']);
    expect((await db.client.query(`SELECT * FROM app.notifications WHERE id = $1`, [id])).rows[0]).toEqual(before);
    const again = await retryNotification(pool, clock, director, meta(), id, { reason: 'клиент подключил браузер' }, key);
    expect([again.replayed, (again.body as NotificationView).id]).toEqual([true, n.id]);
    const second = (await retryNotification(pool, clock, director, meta(), id, { reason: 'ещё раз' }, randomUUID())).body as NotificationView;
    const keys = await db.client.query<{ dedupe_key: string }>('SELECT dedupe_key FROM app.notifications WHERE id = ANY($1::uuid[]) ORDER BY dedupe_key', [[n.id, second.id]]);
    expect(keys.rows.map((x) => x.dedupe_key.split(':retry:')[1])).toEqual(['1', '2']);
    const a = await db.client.query<{ reason: string; after: object }>(`SELECT reason, after FROM journal.audit_events WHERE action = 'notification.retried' AND object_id = $1`, [n.id]);
    expect(a.rows[0]!.reason).toBe('клиент подключил браузер');
    expect(JSON.stringify(a.rows[0]!.after)).not.toContain('Ваша запись');
  });

  it('реклама и не error/no_channel → RETRY_NOT_ALLOWED; без причины – 400; Администратор – 403; чужой филиал и сетевая строка – 404/403', async () => {
    const c = await client();
    const ad = await row(c, { category: 'marketing', kind: 'campaign' });
    await expect(retryNotification(pool, clock, owner, meta(), ad, { reason: 'x' }, randomUUID())).rejects.toMatchObject({ code: 'RETRY_NOT_ALLOWED' });
    const sent = await row(c, { status: 'sent_to_provider' });
    await expect(retryNotification(pool, clock, owner, meta(), sent, { reason: 'x' }, randomUUID())).rejects.toMatchObject({ code: 'RETRY_NOT_ALLOWED' });
    const okRow = await row(c, { status: 'no_channel' });
    await expect(retryNotification(pool, clock, owner, meta(), okRow, { reason: ' ' }, randomUUID())).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(retryNotification(pool, clock, admin, meta(), okRow, { reason: 'x' }, randomUUID())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const foreign = await row(c, { branchId: b2 });
    await expect(retryNotification(pool, clock, director, meta(), foreign, { reason: 'x' }, randomUUID())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const net = await row(c, { branchId: null });
    await expect(retryNotification(pool, clock, director, meta(), net, { reason: 'x' }, randomUUID())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await retryNotification(pool, clock, owner, meta(), net, { reason: 'x' }, randomUUID())).status).toBe(201);
    await expect(retryNotification(pool, clock, owner, meta(), randomUUID(), { reason: 'x' }, randomUUID())).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('списки и зона', () => {
  it('строки: фильтры, чужой филиал и строка без филиала Директору не видны, Владельцу видны; курсор', async () => {
    const c = await client();
    const own = await row(c, { status: 'no_channel', kind: 'booking_confirmed' });
    const foreign = await row(c, { branchId: b2, status: 'no_channel' });
    const net = await row(c, { branchId: null, status: 'no_channel' });
    const d = (await listNotifications(pool, director, { clientId: c })).items.map((x) => x.id);
    expect(d).toEqual([own]);
    // имя автора – всем с notifications.view (решение S4-80): у Администратора нет staff.view, имя сотрудника он всё равно видит; у системы – null
    const manual = await row(c, { status: 'sent_to_provider', kind: 'personal', source: 'staff', initiatorId: staffId });
    const byAdmin = (await listNotifications(pool, admin, { clientId: c })).items;
    expect(byAdmin.map((x) => [x.id, x.authorName]).sort()).toEqual([[manual, 'О В'], [own, null]].sort());
    expect((await listNotifications(pool, owner, { clientId: c })).items.map((x) => x.id).sort()).toEqual([own, foreign, net, manual].sort());
    expect((await listNotifications(pool, owner, { clientId: c, branchId: b2 })).items.map((x) => x.id)).toEqual([foreign]);
    expect((await listNotifications(pool, owner, { clientId: c, kind: 'booking_confirmed' })).items.map((x) => x.id)).toEqual([own]);
    expect((await listNotifications(pool, owner, { clientId: c, category: 'marketing' })).items).toEqual([]);
    const p1 = await listNotifications(pool, owner, { clientId: c, source: 'system', limit: 2 });
    const p2 = await listNotifications(pool, owner, { clientId: c, source: 'system', limit: 2, cursor: p1.nextCursor! });
    expect([...p1.items, ...p2.items].map((x) => x.id).sort()).toEqual([own, foreign, net].sort());
    expect(p2.nextCursor).toBeNull();
    await expect(listNotifications(pool, owner, { cursor: 'мусор' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('кампании: счётчики отправлено / только центр / исключено / ошибка; фильтр клиента; сетевую Директор не видит; история в карточке', async () => {
    const clients = [await client(), await client(), await client(), await client()];
    const [a, b, c, d] = clients as [string, string, string, string];
    const created = (await createCampaign(deps, owner, meta(), { category: 'marketing', title: 'Акция', body: 'Текст', erid: 'E', audience: { kind: 'segment', segment: { v: 1, area: { branchIds: [b1] } } } }, randomUUID())).body as CampaignDto;
    const total = (await db.client.query<{ n: number }>('SELECT count(DISTINCT client_id)::int AS n FROM app.bookings WHERE branch_id = $1', [b1])).rows[0]!.n;
    await confirmCampaign(deps, owner, meta(), created.id, { rowVersion: 1, expectedTotal: total }, randomUUID());
    await expandCampaign(pool, clock, created.id);
    const set = (client: string, status: string) =>
      db.client.query(`UPDATE app.notifications SET status = $3, sent_at = CASE WHEN $3 = 'sent_to_provider' THEN now() END WHERE campaign_id = $1 AND client_id = $2`, [created.id, client, status]);
    await set(a, 'sent_to_provider');
    await set(b, 'no_channel');
    await set(c, 'error');
    await set(d, 'skipped_by_prefs');
    await db.client.query(`UPDATE app.notifications SET status = 'skipped_by_frequency' WHERE campaign_id = $1 AND client_id <> ALL($2::uuid[])`, [created.id, clients]);
    const detail = await getCampaignDetail(pool, director, created.id);
    expect(detail.counters).toEqual({ sent: 1, inboxOnly: 1, error: 1, excluded: total - 3 });
    expect(detail.timeline.map((e) => e.action).sort()).toEqual(['notification.campaign_confirmed', 'notification.campaign_created']);
    // имена автора, подтвердившего и действующих лиц истории – из модуля staff (ADR 0002), без staff.view у читающего
    expect([detail.authorName, detail.confirmedByName]).toEqual(['О В', 'О В']);
    expect(detail.timeline.map((e) => e.actorName)).toEqual(['О В', 'О В']);
    const byClient = await listCampaigns(pool, admin, { clientId: a });
    expect(byClient.items.map((x) => x.id)).toContain(created.id);
    expect(byClient.items.find((x) => x.id === created.id)).toMatchObject({ authorName: 'О В', confirmedByName: 'О В' });
    // №208 campaignId: строки одной рассылки, в своей зоне; вместе с другими фильтрами; чужой или несуществующий id – пусто
    const byCampaign = await listNotifications(pool, director, { campaignId: created.id });
    expect(byCampaign.items).toHaveLength(total);
    expect(byCampaign.items.every((x) => x.campaignId === created.id)).toBe(true);
    expect((await listNotifications(pool, director, { campaignId: created.id, status: 'error' })).items.map((x) => x.clientId)).toEqual([c]);
    expect((await listNotifications(pool, owner, { campaignId: randomUUID() })).items).toEqual([]);
    expect((await listCampaigns(pool, director, { status: 'done' })).items.map((x) => x.id)).not.toContain(created.id);
    expect((await listCampaigns(pool, director, { source: 'system' })).items).toEqual([]);

    const net = (await createCampaign(deps, owner, meta(), { category: 'marketing', title: 'Сеть', body: 'т', erid: 'E', audience: { kind: 'segment', segment: { v: 1, area: { network: true } } } }, randomUUID())).body as CampaignDto;
    expect((await listCampaigns(pool, director, {})).items.map((x) => x.id)).not.toContain(net.id);
    expect((await listCampaigns(pool, owner, {})).items.map((x) => x.id)).toContain(net.id);
    await expect(getCampaignDetail(pool, director, net.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('сводка клиента 09 §12.3', () => {
  it('настройки с датой и источником, число браузеров, последние 20 своей зоны; нет endpoint и ключей; чужой клиент → 404', async () => {
    const c = await client();
    const endpoint = `https://fcm.googleapis.com/fcm/send/${randomUUID()}`;
    await db.client.query('INSERT INTO app.push_subscriptions (client_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4)', [c, endpoint, 'B'.repeat(87), 'A'.repeat(22)]);
    for (let i = 0; i < 22; i++) await row(c, { status: 'no_channel' });
    await row(c, { branchId: b2, status: 'no_channel' });
    const s = await clientNotificationSummary(pool, director, c);
    expect(s.marketing).toEqual({ enabled: true, changedAt: '2026-03-01T00:00:00.000Z', source: 'account' });
    expect(s.reminders).toEqual({ enabled: true, changedAt: null });
    expect(s.push).toEqual({ activeDevices: 1 });
    expect(s.recent).toHaveLength(20);
    expect(s.recent.every((x) => x.branchId === b1)).toBe(true);
    const text = JSON.stringify(s);
    for (const secret of [endpoint, 'fcm.googleapis', 'B'.repeat(87), '"p256dh"', '"auth"']) expect(text).not.toContain(secret); // ключи подписки; "authorName" – не ключ
    const other = await client(b2);
    await expect(clientNotificationSummary(pool, director, other)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await clientNotificationSummary(pool, owner, other)).push.activeDevices).toBe(0);
    await expect(clientNotificationSummary(pool, owner, randomUUID())).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

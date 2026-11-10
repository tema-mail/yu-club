// S4-18: HTTP CRM K11 №201–212 через настоящий сервер и вход сотрудников: права по ролям, IDOR, Idempotency-Key, сквозной путь кампании.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { expandCampaign } from '../../apps/api/src/modules/notifications/campaign-runner.ts';
import { hashPassword, staffAuthConfig } from '../../apps/api/src/modules/staff/auth.ts';
import { buildServer, depsFromConfig } from '../../apps/api/src/server.ts';
import { createTestBranch } from '../helpers/network.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const BASE = '/api/crm/v1';
const PASSWORD = 'Пароль-для-теста-1';
const clock = fixedClock('2026-11-20T06:00:00Z');
let db: TestDatabase;
let pool: pg.Pool;
let app: FastifyInstance;
let b1: string;
let b2: string;
let res1: string;
let res2: string;
let phone = 79220001000;
const cookies: Record<string, string> = {};

type Method = 'GET' | 'POST' | 'PATCH';
function req(who: string, method: Method, url: string, payload?: object, key: string | null = randomUUID()) {
  const headers: Record<string, string> = { cookie: cookies[who]! };
  if (key && method !== 'GET') headers['idempotency-key'] = key;
  return app.inject({ method, url: `${BASE}${url}`, headers, ...(payload ? { payload } : {}) });
}
const code = (r: { statusCode: number; json(): { error?: { code: string } } }) => [r.statusCode, r.json().error?.code];

async function staff(key: string, role: string, branch?: string): Promise<void> {
  const r = await db.client.query<{ id: string }>(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', $1, $2, $3) RETURNING id`, [`${key}@yu.test`, role, await hashPassword(PASSWORD)]);
  if (branch) {
    await db.client.query(`INSERT INTO app.staff_assignments (staff_id, scope_type, branch_id, valid_from, created_by) VALUES ($1, 'branch', $2, '2026-01-01', $1)`, [r.rows[0]!.id, branch]);
  }
  const res = await app.inject({ method: 'POST', url: `${BASE}/auth/login`, payload: { email: `${key}@yu.test`, password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  cookies[key] = String(res.headers['set-cookie']).split(';')[0]!;
}

/** Клиент с согласием и настоящей бронью (с версией – её читает провайдер facts). */
async function client(branch: string): Promise<{ id: string; bookingId: string }> {
  const id = (await db.client.query<{ id: string }>(`INSERT INTO app.clients (phone_e164, status, first_name, registered_at, created_by_type) VALUES ($1, 'active', 'Савва', now(), 'system') RETURNING id`, [`+${++phone}`])).rows[0]!.id;
  await db.client.query('INSERT INTO app.client_notification_prefs (client_id, marketing_enabled) VALUES ($1, true)', [id]);
  await db.client.query(`INSERT INTO journal.client_consents (client_id, kind, granted, document_version, source, actor_type, actor_id) VALUES ($1, 'marketing', true, 'v1', 'account', 'client', $1)`, [id]);
  const resource = branch === b1 ? res1 : res2;
  const bookingId = (await db.client.query<{ id: string }>(
    `INSERT INTO app.bookings (checkout_id, branch_id, client_id, status, resource_id, period, price_kop, source, created_by_type)
     VALUES (gen_random_uuid(), $1, $2, 'confirmed', $3, tstzrange('2026-12-01 07:00+00', '2026-12-01 08:00+00', '[)'), 0, 'crm', 'system') RETURNING id`,
    [branch, id, resource],
  )).rows[0]!.id;
  await db.client.query(
    `INSERT INTO journal.booking_versions (booking_id, version, resource_id, period, branch_timezone, unit_ids, resource_snapshot, price_kop, price_snapshot, created_by_type)
     VALUES ($1, 1, $2, tstzrange('2026-12-01 07:00+00', '2026-12-01 08:00+00', '[)'), 'Asia/Novosibirsk', ARRAY[gen_random_uuid()], '{"name":"ПК"}', 0, '{}', 'system')`,
    [bookingId, resource],
  );
  return { id, bookingId };
}

const seg = (branch: string) => ({ kind: 'segment', segment: { v: 1, area: { branchIds: [branch] } } });
const marketing = (branch: string, over: object = {}) => ({ category: 'marketing', title: 'Акция', body: 'Текст', erid: 'E1', audience: seg(branch), ...over });

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 6 });
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), { staff: { pool, auth: staffAuthConfig('t'.repeat(40)), clock }, notifications: { vapidPublicKey: null, unsubscribeSecret: 'u'.repeat(32) } });
  b1 = (await createTestBranch(db.client)).id;
  b2 = (await createTestBranch(db.client)).id;
  const res = async (b: string) => (await db.client.query<{ id: string }>(`INSERT INTO app.resources (branch_id, resource_type, name) VALUES ($1, 'pc', 'ПК') RETURNING id`, [b])).rows[0]!.id;
  res1 = await res(b1);
  res2 = await res(b2);
  await staff('owner', 'owner');
  await staff('director', 'director', b1);
  await staff('admin', 'admin', b1);
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await db.drop();
});

describe('права K21 §10', () => {
  it('без входа – 401', async () => {
    const r = await app.inject({ method: 'GET', url: `${BASE}/notifications/campaigns` });
    expect(r.statusCode).toBe(401);
  });

  it('Администратор: реклама и сегмент → 403 с записью отказа; сервисное по брони своей зоны → 201, чужой → 404', async () => {
    await client(b1);
    expect(code(await req('admin', 'POST', '/notifications/campaigns', marketing(b1)))).toEqual([403, 'FORBIDDEN']);
    const denied = await db.client.query(`SELECT 1 FROM journal.audit_events WHERE action = 'notification.campaign_created' AND result = 'denied'`);
    expect(denied.rowCount).toBeGreaterThan(0);
    const mine = await client(b1);
    const foreign = await client(b2);
    const svc = (bookingId: string) => ({ category: 'service', purpose: 'Перенос сеанса', title: 'т', body: 'б', audience: { kind: 'booking', bookingId } });
    const ok = await req('admin', 'POST', '/notifications/campaigns', svc(mine.bookingId));
    expect([ok.statusCode, ok.json().status, ok.json().areaIds]).toEqual([201, 'draft', [b1]]);
    expect(code(await req('admin', 'POST', '/notifications/campaigns', svc(foreign.bookingId)))).toEqual([404, 'NOT_FOUND']);
    expect((await req('admin', 'GET', '/notifications/templates')).statusCode).toBe(200);
    expect(code(await req('admin', 'POST', '/notifications/templates', { name: 'н', category: 'service', title: 'т', body: 'б' }))).toEqual([403, 'FORBIDDEN']);
  });

  it('IDOR: Директор – чужой филиал 404 на все маршруты; сеть – только Владелец', async () => {
    const foreign = (await req('owner', 'POST', '/notifications/campaigns', marketing(b2))).json();
    expect(code(await req('director', 'POST', '/notifications/campaigns', marketing(b2)))).toEqual([404, 'NOT_FOUND']);
    for (const [m, u, p] of [
      ['GET', `/notifications/campaigns/${foreign.id}`, undefined],
      ['PATCH', `/notifications/campaigns/${foreign.id}`, { rowVersion: 1, title: 'x' }],
      ['POST', `/notifications/campaigns/${foreign.id}/preview`, {}],
      ['POST', `/notifications/campaigns/${foreign.id}/confirm`, { rowVersion: 1, expectedTotal: 1 }],
      ['POST', `/notifications/campaigns/${foreign.id}/cancel`, { reason: 'x' }],
    ] as Array<[Method, string, object | undefined]>) {
      expect([u, ...code(await req('director', m, u, p))]).toEqual([u, 404, 'NOT_FOUND']);
    }
    expect(code(await req('director', 'GET', `/notifications/campaigns?branchId=${b2}`))).toEqual([404, 'NOT_FOUND']);
    expect(code(await req('director', 'GET', `/notifications?branchId=${b2}`))).toEqual([404, 'NOT_FOUND']);
    expect(code(await req('director', 'GET', '/notifications/campaigns/не-uuid'))).toEqual([404, 'NOT_FOUND']);
    const other = await client(b2);
    expect(code(await req('director', 'GET', `/clients/${other.id}/notification-summary`))).toEqual([404, 'NOT_FOUND']);

    const net = marketing(b1, { audience: { kind: 'segment', segment: { v: 1, area: { network: true } } } });
    expect(code(await req('director', 'POST', '/notifications/campaigns', net))).toEqual([403, 'FORBIDDEN']);
    expect((await req('owner', 'POST', '/notifications/campaigns', net)).statusCode).toBe(201);
  });
});

describe('предпросмотр и ПДн (K21 §5)', () => {
  it('Директор получил имена в ответе; в кампании хранятся только счётчики – Администратор не видит имени ни в карточке, ни в списке', async () => {
    const name = 'Савва';
    await client(b1);
    const c = (await req('director', 'POST', '/notifications/campaigns', marketing(b1))).json();
    const preview = (await req('director', 'POST', `/notifications/campaigns/${c.id}/preview`, {})).json();
    expect(preview.sample[0].displayName).toBe(name); // у Директора client.view.full – полное имя в ответе
    const stored = await db.client.query<{ preview_snapshot: { sample?: unknown; total: number } }>('SELECT preview_snapshot FROM app.notification_campaigns WHERE id = $1', [c.id]);
    expect(stored.rows[0]!.preview_snapshot.total).toBe(preview.total);
    expect(stored.rows[0]!.preview_snapshot.sample).toBeUndefined();
    const card = await req('admin', 'GET', `/notifications/campaigns/${c.id}`);
    expect(card.statusCode).toBe(200);
    expect(card.json().previewSnapshot.total).toBe(preview.total);
    expect(card.body).not.toContain(name);
    const list = await req('admin', 'GET', '/notifications/campaigns?status=draft');
    expect(list.json().items.map((x: { id: string }) => x.id)).toContain(c.id);
    expect(list.body).not.toContain(name);
    expect((await req('owner', 'POST', `/notifications/campaigns/${c.id}/preview`, {})).json().sample[0].displayName).toBe(name);
  });

  it('предпросмотр только у черновика: подтверждённая → 409 CAMPAIGN_NOT_EDITABLE, снимок не меняется', async () => {
    await client(b1);
    const c = (await req('director', 'POST', '/notifications/campaigns', marketing(b1))).json();
    const p = (await req('director', 'POST', `/notifications/campaigns/${c.id}/preview`, {})).json();
    expect((await req('director', 'POST', `/notifications/campaigns/${c.id}/confirm`, { rowVersion: 1, expectedTotal: p.total })).statusCode).toBe(200);
    const before = (await db.client.query('SELECT preview_at FROM app.notification_campaigns WHERE id = $1', [c.id])).rows[0];
    expect(code(await req('director', 'POST', `/notifications/campaigns/${c.id}/preview`, {}))).toEqual([409, 'CAMPAIGN_NOT_EDITABLE']);
    expect((await db.client.query('SELECT preview_at FROM app.notification_campaigns WHERE id = $1', [c.id])).rows[0]).toEqual(before);
  });
});

describe('Idempotency-Key', () => {
  it('все изменяющие, кроме PATCH кампании, без ключа → 400; создание и подтверждение с ключом – повтор отдаёт то же', async () => {
    const id = randomUUID();
    for (const [m, u, p] of [
      ['POST', '/notifications/campaigns', marketing(b1)],
      ['POST', `/notifications/campaigns/${id}/confirm`, { rowVersion: 1 }],
      ['POST', `/notifications/campaigns/${id}/cancel`, { reason: 'x' }],
      ['POST', `/notifications/${id}/retry`, { reason: 'x' }],
      ['POST', '/notifications/templates', { name: 'н', category: 'service', title: 'т', body: 'б' }],
      ['PATCH', `/notifications/templates/${id}`, { rowVersion: 1 }],
    ] as Array<[Method, string, object]>) {
      expect([u, ...code(await req('owner', m, u, p, null))]).toEqual([u, 400, 'IDEMPOTENCY_KEY_REQUIRED']);
    }
    // PATCH кампании – без ключа: защита от повтора – row_version (K21 §6, K11)
    const draft = (await req('owner', 'POST', '/notifications/campaigns', marketing(b1))).json();
    const first = await req('owner', 'PATCH', `/notifications/campaigns/${draft.id}`, { rowVersion: 1, title: 'Новое' }, null);
    expect([first.statusCode, first.json().rowVersion]).toEqual([200, 2]);
    expect(code(await req('owner', 'PATCH', `/notifications/campaigns/${draft.id}`, { rowVersion: 1, title: 'Новое' }, null))).toEqual([409, 'VERSION_CONFLICT']);
    const key = randomUUID();
    const a = await req('owner', 'POST', '/notifications/campaigns', marketing(b1), key);
    const b = await req('owner', 'POST', '/notifications/campaigns', marketing(b1), key);
    expect([a.statusCode, b.statusCode, b.headers['idempotent-replay'], b.json().id]).toEqual([201, 201, 'true', a.json().id]);
  });
});

describe('сквозной путь кампании', () => {
  it('черновик → правка → предпросмотр → подтверждение (AUDIENCE_CHANGED, затем верно) → карточка → журнал → отмена; неверные данные – 400/422', async () => {
    const c1 = await client(b1);
    expect(code(await req('owner', 'POST', '/notifications/campaigns', marketing(b1, { title: 'x'.repeat(121) })))).toEqual([400, 'VALIDATION_FAILED']);
    expect(code(await req('owner', 'POST', '/notifications/campaigns', marketing(b1, { audience: { kind: 'segment', segment: { v: 2 } } })))).toEqual([422, 'SEGMENT_INVALID']);
    expect(code(await req('owner', 'POST', '/notifications/campaigns', marketing(b1, { audience: { kind: 'event', eventId: randomUUID() } })))).toEqual([400, 'VALIDATION_FAILED']);

    const draft = (await req('director', 'POST', '/notifications/campaigns', marketing(b1))).json();
    const patched = await req('director', 'PATCH', `/notifications/campaigns/${draft.id}`, { rowVersion: 1, title: 'Новая акция' });
    expect([patched.statusCode, patched.json().title, patched.json().rowVersion]).toEqual([200, 'Новая акция', 2]);
    const preview = (await req('director', 'POST', `/notifications/campaigns/${draft.id}/preview`, {})).json();
    expect(preview.total).toBeGreaterThan(0);
    expect(preview.willReceivePush + preview.inboxOnly + preview.excludedMarketingOff + preview.excludedFrequency + preview.excludedInactive).toBe(preview.total);
    const wrong = await req('director', 'POST', `/notifications/campaigns/${draft.id}/confirm`, { rowVersion: 2, expectedTotal: preview.total + 5 });
    expect([...code(wrong), wrong.json().error.details.total]).toEqual([409, 'AUDIENCE_CHANGED', preview.total]);
    const ok = await req('director', 'POST', `/notifications/campaigns/${draft.id}/confirm`, { rowVersion: 2, expectedTotal: preview.total });
    expect([ok.statusCode, ok.json().status, ok.json().total]).toEqual([200, 'confirmed', preview.total]);
    expect(code(await req('director', 'PATCH', `/notifications/campaigns/${draft.id}`, { rowVersion: 3, title: 'x' }))).toEqual([409, 'CAMPAIGN_NOT_EDITABLE']);

    await expandCampaign(pool, clock, draft.id);
    const card = (await req('director', 'GET', `/notifications/campaigns/${draft.id}`)).json();
    expect(card.status).toBe('sending');
    expect(card.timeline.map((e: { action: string }) => e.action)).toContain('notification.campaign_confirmed');
    const rows = (await req('director', 'GET', `/notifications?clientId=${c1.id}&category=marketing`)).json();
    expect(rows.items).toHaveLength(1);
    expect(rows.items[0]).toMatchObject({ status: 'planned', title: 'Реклама. Новая акция', campaignId: draft.id });
    const list = (await req('director', 'GET', '/notifications/campaigns?status=sending')).json();
    expect(list.items.map((x: { id: string }) => x.id)).toContain(draft.id);

    const summary = await req('admin', 'GET', `/clients/${c1.id}/notification-summary`);
    expect(summary.statusCode).toBe(200);
    expect(summary.json().marketing.enabled).toBe(true);
    expect(JSON.stringify(summary.json())).not.toContain('endpoint');

    const cancel = await req('director', 'POST', `/notifications/campaigns/${draft.id}/cancel`, { reason: 'Передумали' });
    expect([cancel.statusCode, cancel.json().status]).toEqual([200, 'cancelled']);
    expect((await req('director', 'GET', `/notifications?clientId=${c1.id}&category=marketing`)).json().items[0].status).toBe('cancelled');
    expect(code(await req('director', 'POST', `/notifications/campaigns/${draft.id}/cancel`, { reason: 'ещё' }))).toEqual([409, 'CAMPAIGN_ALREADY_FINISHED']);
  });

  it('повтор: Директор 201 и журнал показывает retry_of; реклама → 409; Администратор → 403', async () => {
    const c = await client(b1);
    const row = async (category: string, kind: string) =>
      (await db.client.query<{ id: string }>(
        `INSERT INTO app.notifications (client_id, branch_id, category, kind, source, title, body, planned_at, status, dedupe_key) VALUES ($1, $2, $3, $4, 'staff', 'т', 'б', now(), 'error', $5) RETURNING id`,
        [c.id, b1, category, kind, `t:${randomUUID()}`],
      )).rows[0]!.id;
    const svc = await row('service', 'personal');
    expect(code(await req('admin', 'POST', `/notifications/${svc}/retry`, { reason: 'x' }))).toEqual([403, 'FORBIDDEN']);
    const r = await req('director', 'POST', `/notifications/${svc}/retry`, { reason: 'Клиент включил push' });
    expect([r.statusCode, r.json().retryOf]).toEqual([201, svc]);
    expect(code(await req('director', 'POST', `/notifications/${await row('marketing', 'campaign')}/retry`, { reason: 'x' }))).toEqual([409, 'RETRY_NOT_ALLOWED']);
  });

  it('шаблоны: Владелец создаёт и правит, неизвестный плейсхолдер → 422; список виден всем ролям', async () => {
    const t = await req('owner', 'POST', '/notifications/templates', { name: 'Акция', category: 'marketing', title: 'Скидка', body: 'Для {client.firstName}' });
    expect(t.statusCode).toBe(201);
    expect(code(await req('owner', 'POST', '/notifications/templates', { name: 'x', category: 'marketing', title: 'т', body: '{phone}' }))).toEqual([422, 'TEMPLATE_PLACEHOLDER_UNKNOWN']);
    const up = await req('owner', 'PATCH', `/notifications/templates/${t.json().id}`, { rowVersion: 1, status: 'archived' });
    expect([up.statusCode, up.json().status]).toEqual([200, 'archived']);
    expect((await req('director', 'GET', '/notifications/templates?status=active')).json().items).toEqual([]);
    expect((await req('director', 'GET', '/notifications/templates')).json().items).toHaveLength(1);
  });
});

describe('пробелы API S4-80…83 (K11 №208 campaignId, №251 сбои)', () => {
  it('сбои критичных: Владелец видит оба филиала, Директор и Администратор – свой; days вне 1..90 и не-UUID campaignId – 400; no-store', async () => {
    const mine = await client(b1);
    const foreign = await client(b2);
    const err = (clientId: string, branch: string) =>
      db.client.query(
        `INSERT INTO app.notifications (client_id, branch_id, category, kind, source, title, body, planned_at, status, dedupe_key) VALUES ($1, $2, 'service', 'booking_cancelled', 'system', 'т', 'б', $3, 'error', $4)`,
        [clientId, branch, new Date(clock.now().getTime() - 3600_000), `t:${randomUUID()}`],
      );
    await err(mine.id, b1);
    await err(foreign.id, b2);
    const owner = await req('owner', 'GET', '/notifications/failures/summary');
    expect(owner.statusCode).toBe(200);
    expect(owner.headers['cache-control']).toBe('no-store');
    expect(owner.json()).toEqual({ critical: 2, period: { from: new Date(clock.now().getTime() - 7 * 86_400_000).toISOString(), to: clock.now().toISOString(), days: 7 } });
    expect((await req('director', 'GET', '/notifications/failures/summary?days=30')).json()).toMatchObject({ critical: 1, period: { days: 30 } });
    expect((await req('admin', 'GET', '/notifications/failures/summary')).json().critical).toBe(1);
    expect(code(await req('admin', 'GET', '/notifications/failures/summary?days=0'))).toEqual([400, 'VALIDATION_FAILED']);
    expect(code(await req('admin', 'GET', '/notifications/failures/summary?days=91'))).toEqual([400, 'VALIDATION_FAILED']);
    expect(code(await req('admin', 'GET', '/notifications?campaignId=123'))).toEqual([400, 'VALIDATION_FAILED']);
    expect((await req('admin', 'GET', `/notifications?campaignId=${randomUUID()}`)).json().items).toEqual([]);
  });
});

describe('подключение секрета', () => {
  it('depsFromConfig передаёт UNSUBSCRIBE_SECRET, короткий секрет не проходит конфиг', async () => {
    const { deps, close } = depsFromConfig(loadConfig({ DATABASE_URL: db.url, UNSUBSCRIBE_SECRET: 'k'.repeat(32) }));
    expect(deps.notifications?.unsubscribeSecret).toBe('k'.repeat(32));
    await close();
    expect(() => loadConfig({ UNSUBSCRIBE_SECRET: 'коротко' })).toThrow();
  });
});

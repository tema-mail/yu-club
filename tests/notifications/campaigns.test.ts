// S4-14: шаблоны и кампании K21 §6, §8 на настоящей Postgres: черновик, предпросмотр, двойное подтверждение, erid, отмена, неизменность шаблона.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import type { AccessContext, NetworkLookup } from '../../apps/api/src/core/permissions.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { cancelCampaign, confirmCampaign, createCampaign, getCampaign, previewCampaign, updateCampaign, type CampaignDeps, type CampaignDto, type CampaignInput } from '../../apps/api/src/modules/notifications/campaigns.ts';
import { assertPlaceholders, createTemplate, renderText, updateTemplate, type TemplateDto } from '../../apps/api/src/modules/notifications/templates.ts';
import { createTestBranch } from '../helpers/network.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const clock = fixedClock('2026-11-20T06:00:00Z');
let db: TestDatabase;
let pool: pg.Pool;
let deps: CampaignDeps;
let b1: string;
let b2: string;
let pc1: string;
let ownerId: string;
let owner: AccessContext;
let director: AccessContext;
let admin: AccessContext;
let phone = 79170001000;
const bookingFacts = new Map<string, { clientId: string; branchId: string; bookingVersion: number }>();
const network: NetworkLookup = { branchesOfCities: async () => [] };
const meta = (): AuditRequestMeta => ({ actor: { kind: 'staff', staffId: ownerId, sessionId: 's' }, source: 'crm', requestId: randomUUID() });

async function client(o: { marketing?: boolean; bookingIn?: string } = {}): Promise<string> {
  const id = (await db.client.query<{ id: string }>(`INSERT INTO app.clients (phone_e164, status, registered_at, created_by_type) VALUES ($1, 'active', now(), 'system') RETURNING id`, [`+${++phone}`])).rows[0]!.id;
  await db.client.query('INSERT INTO app.client_notification_prefs (client_id, marketing_enabled) VALUES ($1, $2)', [id, o.marketing ?? true]);
  if (o.marketing ?? true) {
    await db.client.query(`INSERT INTO journal.client_consents (client_id, kind, granted, document_version, source, actor_type, actor_id) VALUES ($1, 'marketing', true, 'v1', 'account', 'client', $1)`, [id]);
  }
  await db.client.query(
    `INSERT INTO app.bookings (checkout_id, branch_id, client_id, status, resource_id, period, price_kop, source, created_by_type)
     VALUES (gen_random_uuid(), $1, $2, 'completed', $3, tstzrange('2026-10-01 07:00+00', '2026-10-01 08:00+00', '[)'), 0, 'crm', 'system')`,
    [o.bookingIn ?? b1, id, pc1],
  );
  return id;
}

const segment = (branchId: string): CampaignInput['audience'] => ({ kind: 'segment', segment: { v: 1, area: { branchIds: [branchId] } } });
const marketing = (over: Partial<CampaignInput> = {}): CampaignInput => ({ category: 'marketing', title: 'Реклама. Скидка', body: 'Привет, {client.firstName}!', audience: segment(b1), erid: 'ERID1', ...over });
const create = async (input: CampaignInput, ctx = owner, d = deps) => (await createCampaign(d, ctx, meta(), input, randomUUID())).body as CampaignDto;

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 6 });
  b1 = (await createTestBranch(db.client)).id;
  b2 = (await createTestBranch(db.client)).id;
  pc1 = (await db.client.query<{ id: string }>(`INSERT INTO app.resources (branch_id, resource_type, name) VALUES ($1, 'pc', 'ПК') RETURNING id`, [b1])).rows[0]!.id;
  ownerId = (await db.client.query<{ id: string }>(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('О', 'В', 'o@yu.test', 'owner', 'x') RETURNING id`)).rows[0]!.id;
  const ctx = (role: 'owner' | 'director' | 'admin', net: boolean): AccessContext => ({ actor: { kind: 'staff', staffId: ownerId, sessionId: 's' }, role, network: net, cityIds: new Set(), branchIds: new Set(net ? [] : [b1]), at: clock.now() });
  owner = ctx('owner', true);
  director = ctx('director', false);
  admin = ctx('admin', false);
  deps = { pool, clock, network, bookings: { facts: async (_d, id) => bookingFacts.get(id) ?? null }, unsubscribeSecret: 's'.repeat(32) };
});
afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('шаблоны K21 §8', () => {
  it('неизвестный плейсхолдер и одинокая скобка → ошибка; подстановка без значения не оставляет мусора', async () => {
    expect(() => assertPlaceholders('Привет, {client.phone}')).toThrow(expect.objectContaining({ code: 'TEMPLATE_PLACEHOLDER_UNKNOWN' }));
    expect(() => assertPlaceholders('Привет, {client.firstName')).toThrow(expect.objectContaining({ code: 'TEMPLATE_PLACEHOLDER_UNKNOWN' }));
    expect(renderText('Привет, {client.firstName}! Ждём в {branch.name}', { 'client.firstName': 'Иван', 'branch.name': 'Центре' })).toBe('Привет, Иван! Ждём в Центре');
    expect(renderText('{client.firstName}, ждём', {})).toBe('ждём');
    await expect(createTemplate(pool, clock, owner, meta(), { name: 'x', category: 'marketing', title: 'т {bad}', body: 'б' }, randomUUID())).rejects.toMatchObject({ code: 'TEMPLATE_PLACEHOLDER_UNKNOWN' });
    await expect(createTemplate(pool, clock, director, meta(), { name: 'x', category: 'marketing', title: 'т', body: 'б' }, randomUUID())).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('правка шаблона не меняет созданную кампанию; архивный шаблон взять нельзя', async () => {
    const t = (await createTemplate(pool, clock, owner, meta(), { name: 'Акция', category: 'marketing', title: 'Реклама. Старый', body: 'Старый {branch.name}' }, randomUUID())).body as TemplateDto;
    const c = await create({ templateId: t.id, audience: segment(b1) });
    expect([c.category, c.title, c.templateId]).toEqual(['marketing', 'Реклама. Старый', t.id]);
    const up = (await updateTemplate(pool, clock, owner, meta(), t.id, { rowVersion: 1, title: 'Реклама. Новый' }, randomUUID())).body as TemplateDto;
    expect(up.rowVersion).toBe(2);
    await expect(updateTemplate(pool, clock, owner, meta(), t.id, { rowVersion: 1, title: 'x' }, randomUUID())).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect((await getCampaign(pool, owner, c.id)).title).toBe('Реклама. Старый');
    await updateTemplate(pool, clock, owner, meta(), t.id, { rowVersion: 2, status: 'archived' }, randomUUID());
    await expect(create({ templateId: t.id, audience: segment(b1) })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('создание кампании: правила категории и аудитории', () => {
  it('service на сегмент, service без брони, без категории, личное без purpose, плановая дата вне диапазона', async () => {
    const c = await client();
    await expect(create(marketing({ category: 'service' }))).rejects.toMatchObject({ code: 'SEGMENT_SERVICE_FORBIDDEN' });
    await expect(create({ category: 'service', purpose: 'p', title: 'т', body: 'б', audience: { kind: 'client', clientId: c } })).rejects.toMatchObject({ code: 'SERVICE_NEEDS_SUBJECT' });
    await expect(create({ title: 'т', body: 'б', audience: segment(b1) })).rejects.toMatchObject({ code: 'CATEGORY_REQUIRED' });
    await expect(create({ category: 'marketing', title: 'т', body: 'б', audience: { kind: 'client', clientId: c } })).rejects.toMatchObject({ code: 'CATEGORY_REQUIRED' });
    await expect(create(marketing({ plannedAt: '2026-11-01T00:00:00Z' }))).rejects.toMatchObject({ code: 'PLANNED_AT_OUT_OF_RANGE' });
    await expect(create(marketing({ plannedAt: '2027-02-01T00:00:00Z' }))).rejects.toMatchObject({ code: 'PLANNED_AT_OUT_OF_RANGE' });
    await expect(create(marketing({ title: 'Текст {nope}' }))).rejects.toMatchObject({ code: 'TEMPLATE_PLACEHOLDER_UNKNOWN' });
  });

  it('роли и зона: Администратор реклама → 403, сервисное по брони своей зоны – да; Директор чужой филиал → 404, бронь чужой зоны → 404', async () => {
    const c = await client();
    await expect(create(marketing(), admin)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(create(marketing({ audience: segment(b2) }), director)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const own = randomUUID();
    const foreign = randomUUID();
    bookingFacts.set(own, { clientId: c, branchId: b1, bookingVersion: 2 });
    bookingFacts.set(foreign, { clientId: c, branchId: b2, bookingVersion: 1 });
    const s = await create({ category: 'service', purpose: 'Перенос', title: 'т', body: 'б', audience: { kind: 'booking', bookingId: own } }, admin);
    expect([s.status, s.areaType, s.areaIds]).toEqual(['draft', 'branch', [b1]]);
    await expect(create({ category: 'service', purpose: 'п', title: 'т', body: 'б', audience: { kind: 'booking', bookingId: foreign } }, admin)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // чужую кампанию Директор не видит
    const net = await create(marketing({ audience: { kind: 'segment', segment: { v: 1, area: { network: true } } } }));
    await expect(getCampaign(pool, director, net.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('подтверждение K21 §6', () => {
  it('реклама без erid → MARKETING_ERID_REQUIRED; с erid или при выключенной настройке – проходит', async () => {
    await client();
    const noErid = await create(marketing({ erid: null }));
    await expect(confirmCampaign(deps, owner, meta(), noErid.id, { rowVersion: 1, expectedTotal: 0 }, randomUUID())).rejects.toMatchObject({ code: 'MARKETING_ERID_REQUIRED' });
    await db.client.query(
      `INSERT INTO app.settings_values (key, level, value, valid_from, created_by) VALUES ('notifications.marketing_require_erid', 'network', 'false', '2026-01-01', $1)`,
      [ownerId],
    );
    const preview = await previewCampaign(deps, owner, noErid.id);
    const r = await confirmCampaign(deps, owner, meta(), noErid.id, { rowVersion: 1, expectedTotal: preview.total }, randomUUID());
    expect((r.body as CampaignDto).status).toBe('confirmed');
    await db.client.query(`DELETE FROM app.settings_values WHERE key = 'notifications.marketing_require_erid'`);
  });

  it('expectedTotal не совпал → 409 AUDIENCE_CHANGED с числом; совпал → confirmed, снимок, предпросмотр сохранён; повтор с ключом – та же кампания', async () => {
    const c = await create(marketing());
    const p = await previewCampaign(deps, owner, c.id);
    expect(p.total).toBeGreaterThan(0);
    expect((await getCampaign(pool, owner, c.id)).previewSnapshot?.total).toBe(p.total);
    await expect(confirmCampaign(deps, owner, meta(), c.id, { rowVersion: 1, expectedTotal: p.total + 1 }, randomUUID())).rejects.toMatchObject({ code: 'AUDIENCE_CHANGED', details: { total: p.total } });
    const key = randomUUID();
    const first = await confirmCampaign(deps, owner, meta(), c.id, { rowVersion: 1, expectedTotal: p.total }, key);
    expect((first.body as CampaignDto).status).toBe('confirmed');
    const again = await confirmCampaign(deps, owner, meta(), c.id, { rowVersion: 1, expectedTotal: p.total }, key);
    expect([again.replayed, (again.body as CampaignDto).id]).toEqual([true, c.id]);
    const rec = await db.client.query('SELECT count(*)::int AS n FROM journal.notification_campaign_recipients WHERE campaign_id = $1', [c.id]);
    expect(rec.rows[0].n).toBe(p.total);
    await expect(confirmCampaign(deps, owner, meta(), c.id, { rowVersion: 2, expectedTotal: p.total }, randomUUID())).rejects.toMatchObject({ code: 'CAMPAIGN_NOT_EDITABLE' });
    await expect(updateCampaign(deps, owner, meta(), c.id, { rowVersion: 2, title: 'x' })).rejects.toMatchObject({ code: 'CAMPAIGN_NOT_EDITABLE' });
    // в аудите – текст шаблоном, без подстановки
    const audit = await db.client.query<{ after: { body: string } }>(`SELECT after FROM journal.audit_events WHERE action = 'notification.campaign_confirmed' AND object_id = $1`, [c.id]);
    expect(audit.rows[0]!.after.body).toBe('Привет, {client.firstName}!');
  });

  it('параллельные подтверждения разными ключами: одно проходит, снимок один', async () => {
    const c = await create(marketing());
    const p = await previewCampaign(deps, owner, c.id);
    const res = await Promise.allSettled(Array.from({ length: 5 }, () => confirmCampaign(deps, owner, meta(), c.id, { rowVersion: 1, expectedTotal: p.total }, randomUUID())));
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rec = await db.client.query('SELECT count(*)::int AS n FROM journal.notification_campaign_recipients WHERE campaign_id = $1', [c.id]);
    expect(rec.rows[0].n).toBe(p.total);
  });

  it('пустая аудитория → AUDIENCE_EMPTY; нет секрета отписки → MARKETING_NOT_CONFIGURED; версия устарела → VERSION_CONFLICT', async () => {
    const empty = await create(marketing({ audience: segment(b2) }));
    await expect(confirmCampaign(deps, owner, meta(), empty.id, { rowVersion: 1, expectedTotal: 0 }, randomUUID())).rejects.toMatchObject({ code: 'AUDIENCE_EMPTY' });
    const c = await create(marketing());
    const noSecret = { ...deps, unsubscribeSecret: null };
    await expect(confirmCampaign(noSecret, owner, meta(), c.id, { rowVersion: 1, expectedTotal: 1 }, randomUUID())).rejects.toMatchObject({ code: 'MARKETING_NOT_CONFIGURED', httpStatus: 503 });
    await expect(confirmCampaign(deps, owner, meta(), c.id, { rowVersion: 9, expectedTotal: 1 }, randomUUID())).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });

  it('адресное сообщение: expectedTotal не нужен; правка черновика повышает версию и сбрасывает предпросмотр', async () => {
    const cl = await client();
    const own = randomUUID();
    bookingFacts.set(own, { clientId: cl, branchId: b1, bookingVersion: 1 });
    const c = await create({ category: 'service', purpose: 'Изменение', title: 'т', body: 'б', audience: { kind: 'client', clientId: cl, bookingId: own } }, admin);
    await previewCampaign(deps, admin, c.id);
    const up = await updateCampaign(deps, admin, meta(), c.id, { rowVersion: 1, title: 'новый' });
    expect([up.title, up.rowVersion, up.previewSnapshot]).toEqual(['новый', 2, null]);
    const r = await confirmCampaign(deps, admin, meta(), c.id, { rowVersion: 2 }, randomUUID());
    expect(r.body as CampaignDto).toMatchObject({ status: 'confirmed', total: 1 });
  });
});

describe('отмена K21 §6', () => {
  it('причина обязательна; неотправленные строки → cancelled, ушедшая остаётся; повтор завершённой → CAMPAIGN_ALREADY_FINISHED', async () => {
    const c = await create(marketing());
    await expect(cancelCampaign(deps, owner, meta(), c.id, { reason: ' ' }, randomUUID())).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const p = await previewCampaign(deps, owner, c.id);
    await confirmCampaign(deps, owner, meta(), c.id, { rowVersion: 1, expectedTotal: p.total }, randomUUID());
    const cl = await client();
    const row = async (status: string) =>
      (await db.client.query<{ id: string }>(
        `INSERT INTO app.notifications (client_id, category, kind, source, title, body, planned_at, status, sent_at, campaign_id, dedupe_key) VALUES ($1, 'marketing', 'campaign', 'staff', 'т', 'б', now(), $2, CASE WHEN $2 = 'sent_to_provider' THEN now() END, $3, $4) RETURNING id`,
        [cl, status, c.id, `t:${randomUUID()}`],
      )).rows[0]!.id;
    const planned = await row('planned');
    const sent = await row('sent_to_provider');
    const r = await cancelCampaign(deps, owner, meta(), c.id, { reason: 'Ошибка в тексте' }, randomUUID());
    expect(r.body as CampaignDto).toMatchObject({ status: 'cancelled', cancelledReason: 'Ошибка в тексте' });
    const st = async (id: string) => (await db.client.query<{ status: string }>('SELECT status FROM app.notifications WHERE id = $1', [id])).rows[0]!.status;
    expect([await st(planned), await st(sent)]).toEqual(['cancelled', 'sent_to_provider']);
    await expect(cancelCampaign(deps, owner, meta(), c.id, { reason: 'ещё' }, randomUUID())).rejects.toMatchObject({ code: 'CAMPAIGN_ALREADY_FINISHED' });
  });
});

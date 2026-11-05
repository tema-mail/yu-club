// S4-74: отчёт «Уведомления и публикации» (K24 §3.11, 14 §14). Категории раздельно; sent_to_provider подписан «показ не подтверждён»; отказы от рекламы – из журнала согласий;
// просмотры – unavailable; Σ detail = итог; пустой период – no_data, а не 0; TC-16: директор не видит чужой филиал, чужие отказы и чужие материалы; представления читаются под yu_reports; вверх/вниз/вверх.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { commsDefs, commsDetail, commsReport } from '../../apps/api/src/modules/reports/comms.ts';
import { loadMigrations, migrateDown, migrateUp } from '../../db/migrate.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';
import { d, reportFixtures, SYS, type Fx } from '../helpers/reports.ts';

const OCT = { from: d('2026-10-01'), to: d('2026-10-31') };
let db: TestDatabase;
let fx: Fx;
let nsk: { id: string; cityId: string };
let msk: { id: string; cityId: string };
let ivan: string;
let oleg: string;
let campaign: string;
let seq = 0;
let bookingId: string;

async function notice(o: { branchId: string | null; clientId?: string; category: string; status: string; kind?: string; createdAt?: string; readAt?: string; campaignId?: string }): Promise<void> {
  seq += 1;
  const sent = o.status === 'sent_to_provider' ? (o.createdAt ?? '2026-10-10T05:00:00Z') : null;
  await db.client.query(
    `INSERT INTO app.notifications (client_id, branch_id, category, kind, source, title, body, planned_at, status, dedupe_key, booking_id, created_at, sent_at, read_at, campaign_id, push)
     VALUES ($1, $2, $3, $4, 'system', 'т', 'т', $5, $6, $7, $8, $5, $9, $10, $11, $12)`,
    [o.clientId ?? ivan, o.branchId, o.category, o.kind ?? (o.category === 'marketing' ? 'campaign' : 'booking_confirmed'), o.createdAt ?? '2026-10-10T05:00:00Z', o.status, `k${seq}`, o.category === 'reminder' ? bookingId : null, sent, o.readAt ?? null, o.campaignId ?? null, o.status !== 'inbox_only'],
  );
}
const consent = (clientId: string, granted: boolean, at: string) =>
  db.client.query(`INSERT INTO journal.client_consents (client_id, kind, granted, document_version, source, at, actor_type, actor_id) VALUES ($1, 'marketing', $2, $3, 'account', $4, 'client', $1)`, [clientId, granted, granted ? 'advertising-consent-2026-01-01' : null, at]);
async function publication(type: string, scope: { kind: 'network' | 'branch' | 'city'; id?: string }, at: string, versionNo = 1): Promise<string> {
  const id = (await db.client.query<{ id: string }>(`INSERT INTO app.content_publications (type, draft, draft_updated_at, draft_updated_by, created_by, created_at) VALUES ($1, '{}', now(), $2, $2, now()) RETURNING id`, [type, SYS])).rows[0]!.id;
  await db.client.query(`INSERT INTO app.content_publication_scopes (publication_id, scope_type, city_id, branch_id) VALUES ($1, $2, $3, $4)`, [id, scope.kind, scope.kind === 'city' ? scope.id : null, scope.kind === 'branch' ? scope.id : null]);
  for (let v = 1; v <= versionNo; v++) await db.client.query(`INSERT INTO journal.content_versions (entity_type, entity_id, version_no, snapshot, action, published_by, published_at) VALUES ('publication', $1, $2, '{}', 'publish', $3, $4)`, [id, v, SYS, at]);
  return id;
}
const value = (m: { state: string; value?: number } | undefined) => (m?.state === 'ok' ? m.value : m?.state);

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  fx = await reportFixtures(db);
  nsk = await fx.branch('Asia/Novosibirsk');
  msk = await fx.branch('Europe/Moscow');
  ivan = await fx.client({ firstName: 'Иван', lastName: 'Петров' });
  oleg = await fx.client({ firstName: 'Олег', lastName: 'Сидоров' });
  const pc = await fx.resource(nsk.id, 'pc', 'ПК', []);
  const pcM = await fx.resource(msk.id, 'pc', 'ПК-М', []);
  bookingId = await fx.booking({ branchId: nsk.id, clientId: ivan, resourceId: pc, start: '2026-09-10T05:00:00Z' });
  await fx.booking({ branchId: msk.id, clientId: oleg, resourceId: pcM, start: '2026-09-10T05:00:00Z' });
  campaign = (await db.client.query<{ id: string }>(
    `INSERT INTO app.notification_campaigns (category, title, body, audience, area_type, created_by, status, confirmed_at, confirmed_by) VALUES ('marketing', 'т', 'т', '{"kind":"client"}', 'network', $1, 'done', now(), $1) RETURNING id`,
    [fx.ownerId],
  )).rows[0]!.id;

  await notice({ branchId: nsk.id, category: 'service', status: 'sent_to_provider', readAt: '2026-10-11T05:00:00Z' });
  await notice({ branchId: nsk.id, category: 'service', status: 'no_channel' });
  await notice({ branchId: nsk.id, category: 'service', status: 'error' });
  await notice({ branchId: nsk.id, category: 'reminder', status: 'sent_to_provider' });
  await notice({ branchId: nsk.id, category: 'reminder', status: 'skipped_booking_changed' });
  await notice({ branchId: nsk.id, category: 'reminder', status: 'skipped_by_prefs' });
  await notice({ branchId: nsk.id, category: 'marketing', status: 'sent_to_provider', campaignId: campaign });
  await notice({ branchId: nsk.id, category: 'marketing', status: 'skipped_by_frequency', campaignId: campaign });
  await notice({ branchId: nsk.id, category: 'marketing', status: 'inbox_only', campaignId: campaign });
  await notice({ branchId: msk.id, category: 'service', status: 'sent_to_provider', clientId: oleg });
  await notice({ branchId: null, category: 'marketing', status: 'sent_to_provider', campaignId: campaign, clientId: oleg });
  await notice({ branchId: nsk.id, category: 'service', status: 'sent_to_provider', createdAt: '2026-09-10T05:00:00Z' }); // прошлый период

  await consent(ivan, true, '2026-09-01T05:00:00Z');
  await consent(ivan, false, '2026-10-05T05:00:00Z');
  await consent(oleg, false, '2026-10-06T05:00:00Z');

  await publication('news', { kind: 'network' }, '2026-10-02T05:00:00Z');
  await publication('promotion', { kind: 'branch', id: nsk.id }, '2026-10-03T05:00:00Z');
  await publication('promotion', { kind: 'branch', id: msk.id }, '2026-10-04T05:00:00Z');
  await publication('news', { kind: 'city', id: msk.cityId }, '2026-10-04T05:00:00Z');
  await publication('giveaway', { kind: 'network' }, '2026-09-04T05:00:00Z'); // первая публикация не в периоде
  await db.client.query(`INSERT INTO journal.content_versions (entity_type, entity_id, version_no, snapshot, action, published_by, published_at) VALUES ('publication', (SELECT id FROM app.content_publications WHERE type = 'giveaway'), 2, '{}', 'publish', $1, '2026-10-05T05:00:00Z')`, [SYS]);
}, 60_000);
afterAll(async () => {
  await fx.close();
  await db.drop();
});

describe('отчёт 3.11', () => {
  it('категории раздельно по всей сети; строка без филиала – в сети', async () => {
    const r = await fx.run(fx.owner(), (env) => commsReport(env, { period: OCT }));
    expect(value(r.metrics.serviceCreated)).toBe(4);
    expect(value(r.metrics.serviceSentToProvider)).toBe(2);
    expect(value(r.metrics.serviceInboxOnly)).toBe(1);
    expect(value(r.metrics.serviceErrors)).toBe(1);
    expect(value(r.metrics.serviceOpenedInCabinet)).toBe(1);
    expect(value(r.metrics.reminderCreated)).toBe(3);
    expect(value(r.metrics.reminderSkippedBookingChanged)).toBe(1);
    expect(value(r.metrics.reminderSkippedByPrefs)).toBe(1);
    expect(value(r.metrics.marketingCreated)).toBe(4);
    expect(value(r.metrics.marketingSkippedByFrequency)).toBe(1);
    expect(value(r.metrics.marketingInboxOnly)).toBe(1);
    expect(r.metrics.serviceCreated).toMatchObject({ prev: 1 });
  });

  it('sent_to_provider подписан «показ не подтверждён»; просмотры и переходы – source_not_ready', async () => {
    const r = await fx.run(fx.owner(), (env) => commsReport(env, { period: OCT }));
    expect(r.labels.sentToProvider).toContain('показ не подтверждён');
    expect(r.metrics.siteViews).toEqual({ state: 'unavailable', reason: 'source_not_ready' });
    expect(r.metrics.siteClicks).toEqual({ state: 'unavailable', reason: 'source_not_ready' });
  });

  it('кампании: число и охват – отклонённые по частоте в охват не входят', async () => {
    const r = await fx.run(fx.owner(), (env) => commsReport(env, { period: OCT }));
    expect(value(r.metrics.campaignsCount)).toBe(1);
    expect(value(r.metrics.campaignsReach)).toBe(3);
  });

  it('отказы от рекламы – из журнала согласий, согласие не считается', async () => {
    const r = await fx.run(fx.owner(), (env) => commsReport(env, { period: OCT }));
    expect(value(r.metrics.optOuts)).toBe(2);
  });

  it('материалы – первая публикация в периоде по типам; вторая версия старого материала – нет', async () => {
    const r = await fx.run(fx.owner(), (env) => commsReport(env, { period: OCT }));
    expect(value(r.metrics.publishedNews)).toBe(2);
    expect(value(r.metrics.publishedPromotion)).toBe(2);
    expect(value(r.metrics.publishedGiveaway)).toBe(0);
  });

  it('пустой период – no_data, не 0; база 0 – deltaPct null', async () => {
    const r = await fx.run(fx.owner(), (env) => commsReport(env, { period: { from: d('2020-01-01'), to: d('2020-01-31') } }));
    expect(r.metrics.serviceCreated).toEqual({ state: 'no_data' });
    expect(r.metrics.optOuts).toEqual({ state: 'no_data' });
    expect(r.metrics.publishedNews).toEqual({ state: 'no_data' });
  });

  it('TC-16: директор Новосибирска – свой филиал, свои отказы, свои материалы и сетевые; чужой филиал – 404; Администратор – 403', async () => {
    const dir = fx.director([nsk.id]);
    const r = await fx.run(dir, (env) => commsReport(env, { period: OCT }));
    expect(value(r.metrics.serviceCreated)).toBe(3);
    expect(value(r.metrics.marketingCreated)).toBe(3); // строка без филиала не видна
    expect(value(r.metrics.optOuts)).toBe(1); // Иван бронировал в его филиале, Олег – нет
    expect(value(r.metrics.publishedNews)).toBe(1); // сетевая; московская городская – нет
    expect(value(r.metrics.publishedPromotion)).toBe(1);
    await expect(fx.run(dir, (env) => commsReport(env, { period: OCT, branchIds: [msk.id] }))).rejects.toMatchObject({ httpStatus: 404 });
    await expect(fx.run(fx.admin([nsk.id]), (env) => commsReport(env, { period: OCT }))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(fx.run(dir, (env) => commsDetail(env, { period: OCT, branchIds: [msk.id] }, 'optOuts'))).rejects.toMatchObject({ httpStatus: 404 });
  });
});

describe('детализация', () => {
  it('Σ detail = итог по каждому показателю уведомлений, в обеих областях', async () => {
    for (const ctx of [fx.owner(), fx.director([nsk.id])]) {
      const r = await fx.run(ctx, (env) => commsReport(env, { period: OCT }));
      for (const key of Object.keys(commsDefs())) {
        const m = r.metrics[key]!;
        const page = await fx.run(ctx, (env) => commsDetail(env, { period: OCT }, key, { limit: 500 }));
        expect(page.total, key).toMatchObject(m.state === 'ok' && m.value > 0 ? { value: m.value } : { state: 'no_data' });
        if (key !== 'campaignsCount' && m.state === 'ok') expect(page.rows.length, key).toBe(m.value);
      }
    }
  });

  it('отказы: клиент маской без права, постранично; материалы – постранично; просмотры – unavailable; неизвестный показатель – ошибка фильтра', async () => {
    const one = await fx.run(fx.director([nsk.id]), (env) => commsDetail(env, { period: OCT }, 'optOuts', { limit: 1 }));
    expect(one.rows).toHaveLength(1);
    expect(one.total).toMatchObject({ value: 1 });
    expect(one.nextCursor).toBeNull();
    const first = await fx.run(fx.owner(), (env) => commsDetail(env, { period: OCT }, 'optOuts', { limit: 1 }));
    expect(first.nextCursor).not.toBeNull();
    const second = await fx.run(fx.owner(), (env) => commsDetail(env, { period: OCT }, 'optOuts', { limit: 1, cursor: first.nextCursor! }));
    expect(second.rows).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    const pub = await fx.run(fx.owner(), (env) => commsDetail(env, { period: OCT }, 'publishedPromotion', { limit: 1 }));
    expect(pub.total).toMatchObject({ value: 2 });
    expect(pub.rows[0]).toMatchObject({ type: 'promotion', scopeType: 'branch' });
    const pub2 = await fx.run(fx.owner(), (env) => commsDetail(env, { period: OCT }, 'publishedPromotion', { limit: 5, cursor: pub.nextCursor! }));
    expect(pub2.rows).toHaveLength(1);
    expect((await fx.run(fx.owner(), (env) => commsDetail(env, { period: OCT }, 'siteViews'))).total).toEqual({ state: 'unavailable', reason: 'source_not_ready' });
    await expect(fx.run(fx.owner(), (env) => commsDetail(env, { period: OCT }, 'нет'))).rejects.toMatchObject({ code: 'REPORT_FILTER_INVALID' });
    await expect(fx.run(fx.owner(), (env) => commsDetail(env, { period: OCT }, 'optOuts', { cursor: 'x' }))).rejects.toMatchObject({ code: 'REPORT_FILTER_INVALID' });
  });
});

describe('представления', () => {
  it('под yu_app только чтение; под yu_reports читаются; нет колонок текста и контактов', async () => {
    const cols = await db.client.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'app' AND table_name = 'rpt_notifications'`);
    const names = cols.rows.map((r) => r.column_name);
    expect(names).toEqual(expect.arrayContaining(['notification_id', 'branch_id', 'category', 'kind', 'source', 'campaign_id', 'status', 'created_at', 'sent_at', 'read_at']));
    for (const banned of ['title', 'body', 'client_id']) expect(names).not.toContain(banned);
    const p = await db.client.query<{ ins: boolean }>(`SELECT has_table_privilege('yu_app', 'app.rpt_notifications', 'INSERT') AS ins`);
    expect(p.rows[0]!.ins).toBe(false);
    const r = await fx.reports.query(`SELECT count(*) AS n FROM app.rpt_content_versions`);
    expect(Number(r.rows[0].n)).toBeGreaterThan(0);
  });

  it('вниз и снова вверх', async () => {
    const fresh = await createTestDatabase({ migrate: true });
    const all = await loadMigrations();
    const after = all.filter((m) => m.name >= '0409').length;
    await migrateDown(fresh.client, after);
    expect((await fresh.client.query(`SELECT to_regclass('app.rpt_notifications') AS t`)).rows[0].t).toBeNull();
    await migrateUp(fresh.client);
    expect((await fresh.client.query(`SELECT to_regclass('app.rpt_notifications') AS t`)).rows[0].t).not.toBeNull();
    await fresh.drop();
  }, 60_000);
});

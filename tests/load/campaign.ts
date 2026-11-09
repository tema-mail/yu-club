// S4-135. Нагрузка рассылки (K21 §6): LOAD_RECIPIENTS (10 000) клиентов с согласием на рекламу и бронью в филиале, одна рекламная кампания на сегмент.
// Только локально: embedded-postgres во временной папке, команды модуля notifications на настоящем пуле (как в API). На стенд нагрузку НЕ давать.
//   1) двойное создание: два параллельных POST с одним ключом идемпотентности – одна кампания;
//   2) двойное подтверждение: два параллельных confirm с разными ключами – ровно один 200, второй CAMPAIGN_NOT_EDITABLE, снимок получателей один;
//   3) двойное разворачивание: два expandCampaign параллельно (два воркера) – по одной строке app.notifications на получателя;
//   4) напоминания во время рассылки: LOAD_REMINDERS (50) напоминаний с наступившим моментом поверх 10 000 рекламных строк –
//      все забирает первый же проход диспетчера (claimDue), реклама – не больше своей пачки.
// Длительность подтверждения и разворачивания печатается и сравнивается с порогом плана (рассылка ≤ 2 ч; отправку push здесь не меряем – нет VAPID).
//
//   npm run load:campaign
//   LOAD_RECIPIENTS=50000 LOAD_POOL=20 npm run load:campaign
// Код выхода 1 – дубль кампании, строки или подтверждения, неверное число получателей, напоминание не забрано первым проходом, ответ 5xx.
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { AppError } from '../../apps/api/src/core/errors.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import type { Clock, TimeZone } from '../../apps/api/src/core/time.ts';
import { bookingLookup } from '../../apps/api/src/modules/booking/providers.ts';
import { branchIdsOfCities, timezonesOf } from '../../apps/api/src/modules/network/index.ts';
import { expandCampaign } from '../../apps/api/src/modules/notifications/campaign-runner.ts';
import { confirmCampaign, createCampaign, type CampaignDeps, type CampaignDto } from '../../apps/api/src/modules/notifications/campaigns.ts';
import { insertDrafts } from '../../apps/api/src/modules/notifications/reminders.ts';
import { claimDue, MARKETING_DISPATCH_LIMIT } from '../../apps/api/src/modules/notifications/sender.ts';
import { migrateUp } from '../../db/migrate.ts';
import { createTestBranch } from '../helpers/network.ts';

const RECIPIENTS = Number(process.env.LOAD_RECIPIENTS ?? 10_000);
const REMINDERS = Number(process.env.LOAD_REMINDERS ?? 50);
const POOL = Number(process.env.LOAD_POOL ?? 10);
const LIMIT_MS = 2 * 3_600_000; // план S4-135: длительность рассылки ≤ 2 ч
const NOW = new Date('2026-11-16T07:00:00Z'); // 14:00 Новосибирска – внутри окна рекламы 10–21
const clock: Clock = { now: () => NOW };

type Outcome = { status: number; code: string; ms: number; body?: unknown };
const attempt = async (fn: () => Promise<{ status: number; body: unknown }>): Promise<Outcome> => {
  const t0 = performance.now();
  try {
    const r = await fn();
    return { status: r.status, code: 'ok', ms: performance.now() - t0, body: r.body };
  } catch (err) {
    if (err instanceof AppError) return { status: err.httpStatus, code: err.code, ms: performance.now() - t0 };
    console.error(err);
    return { status: 500, code: 'INTERNAL', ms: performance.now() - t0 };
  }
};
const tally = (xs: Outcome[]) => Object.fromEntries([...new Set(xs.map((x) => `${x.status} ${x.code}`))].sort().map((k) => [k, xs.filter((x) => `${x.status} ${x.code}` === k).length]));
const sec = (ms: number) => `${(ms / 1000).toFixed(1)} с`;

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'yu-load-campaign-'));
  const password = randomBytes(12).toString('hex');
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const pgServer = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password, port, persistent: false, postgresFlags: ['-c', 'max_connections=300'], onLog: () => undefined, onError: () => undefined });
  await pgServer.initialise();
  await pgServer.start();
  const adminUrl = `postgres://postgres:${password}@127.0.0.1:${port}/postgres`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  let pool: pg.Pool | undefined;
  let sql: pg.Client | undefined;
  let failed = false;
  try {
    await admin.query(`CREATE ROLE yu_app NOLOGIN`);
    await admin.query(`CREATE ROLE yu_reports NOLOGIN`);
    await admin.query(`CREATE DATABASE yu_load`);
    await admin.end();
    const dbUrl = adminUrl.replace(/\/postgres$/, '/yu_load');
    sql = new pg.Client({ connectionString: dbUrl });
    await sql.connect();
    await migrateUp(sql);
    pool = new pg.Pool({ connectionString: dbUrl, options: '-c role=yu_app -c search_path=app,journal', max: POOL });
    pool.on('error', (err) => console.error('пул: ', err.message));
    const n = async (text: string, params: unknown[] = []) => Number((await sql!.query<{ n: string }>(text, params)).rows[0]!.n);

    // ---- подготовка (не в замере): филиал, ресурс, получатели с согласием и бронью в филиале
    const tz = 'Asia/Novosibirsk' as TimeZone;
    const branch = (await createTestBranch(sql, { timezone: tz })).id;
    const resource = (await sql.query<{ id: string }>(`INSERT INTO app.resources (branch_id, resource_type, name) VALUES ($1, 'pc', 'ПК 1') RETURNING id`, [branch])).rows[0]!.id;
    const ownerId = (await sql.query<{ id: string }>(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('О', 'В', 'owner@load.test', 'owner', 'x') RETURNING id`)).rows[0]!.id;
    const t0 = performance.now();
    await sql.query(
      `WITH c AS (INSERT INTO app.clients (phone_e164, first_name, status, registered_at, created_by_type)
                  SELECT '+7955' || (1000000 + g)::text, 'Клиент' || g, 'active', $1, 'system' FROM generate_series(1, $2) g RETURNING id),
            p AS (INSERT INTO app.client_notification_prefs (client_id, marketing_enabled) SELECT id, true FROM c),
            k AS (INSERT INTO journal.client_consents (client_id, kind, granted, document_version, source, actor_type, actor_id) SELECT id, 'marketing', true, 'v1', 'account', 'client', id FROM c)
       INSERT INTO app.bookings (checkout_id, branch_id, client_id, status, resource_id, period, price_kop, source, created_by_type)
       SELECT gen_random_uuid(), $3, id, 'completed', $4, tstzrange('2026-10-01 07:00+00'::timestamptz + (row_number() OVER ()) * interval '1 hour', '2026-10-01 08:00+00'::timestamptz + (row_number() OVER ()) * interval '1 hour', '[)'), 0, 'crm', 'system' FROM c`,
      [new Date('2026-09-01T00:00:00Z'), RECIPIENTS, branch, resource],
    );
    await sql.query('ANALYZE');
    console.log(`Подготовка: ${RECIPIENTS} получателей с согласием и бронью за ${sec(performance.now() - t0)}; пул ${POOL}`);

    const owner: AccessContext = { actor: { kind: 'staff', staffId: ownerId, sessionId: randomUUID() }, role: 'owner', network: true, cityIds: new Set(), branchIds: new Set(), at: NOW };
    const meta = (): AuditRequestMeta => ({ actor: owner.actor, access: owner, source: 'crm', requestId: randomUUID() });
    const deps: CampaignDeps = { pool, clock, network: { branchesOfCities: branchIdsOfCities, timezonesOf }, bookings: bookingLookup, unsubscribeSecret: 's'.repeat(32) };
    const input = { category: 'marketing' as const, title: 'Скидка на ночь', body: '{client.firstName}, ночной пакет дешевле', erid: 'LOAD-ERID', audience: { kind: 'segment' as const, segment: { v: 1, area: { branchIds: [branch] } } } };

    // 1) двойное создание с одним ключом
    const createKey = randomUUID();
    const created = await Promise.all([0, 1].map(() => attempt(() => createCampaign(deps, owner, meta(), input, createKey))));
    const campaigns = await n(`SELECT count(*) n FROM app.notification_campaigns`);
    const ids = new Set(created.map((c) => (c.body as CampaignDto | undefined)?.id));
    const campaign = created.find((c) => c.code === 'ok')?.body as CampaignDto;
    console.log(`1) создание ×2 одним ключом: ${JSON.stringify(tally(created))}, кампаний в базе ${campaigns}, разных id в ответах ${ids.size}`);

    // 2) двойное подтверждение разными ключами
    const tc = performance.now();
    const confirmed = await Promise.all([0, 1].map(() => attempt(() => confirmCampaign(deps, owner, meta(), campaign.id, { rowVersion: campaign.rowVersion, expectedTotal: RECIPIENTS }, randomUUID()))));
    const confirmMs = performance.now() - tc;
    const snapshot = await n(`SELECT count(*) n FROM journal.notification_campaign_recipients WHERE campaign_id = $1`, [campaign.id]);
    const snapshotDup = await n(`SELECT count(*) n FROM (SELECT client_id FROM journal.notification_campaign_recipients GROUP BY client_id HAVING count(*) > 1) x`);
    console.log(`2) подтверждение ×2: ${JSON.stringify(tally(confirmed))} за ${sec(confirmMs)}; снимок ${snapshot} строк, клиентов с двумя строками ${snapshotDup}`);

    // 3) двойное разворачивание – два воркера сразу
    const te = performance.now();
    const expanded = await Promise.all([0, 1].map(() => expandCampaign(pool!, clock, campaign.id).then((seen) => ({ seen }), (err: unknown) => ({ err: String(err) }))));
    const expandMs = performance.now() - te;
    const rows = await n(`SELECT count(*) n FROM app.notifications WHERE campaign_id = $1`, [campaign.id]);
    const rowsDistinct = await n(`SELECT count(DISTINCT client_id) n FROM app.notifications WHERE campaign_id = $1`, [campaign.id]);
    const status = (await sql.query<{ status: string }>(`SELECT status FROM app.notification_campaigns WHERE id = $1`, [campaign.id])).rows[0]!.status;
    console.log(`3) разворачивание ×2: ${JSON.stringify(expanded)} за ${sec(expandMs)}; строк ${rows}, разных клиентов ${rowsDistinct}, статус кампании ${status}`);

    // 4) напоминания с наступившим моментом поверх рекламной очереди
    const bookings = (await sql.query<{ id: string; client_id: string; period: string }>(`SELECT id, client_id FROM app.bookings ORDER BY id LIMIT $1`, [REMINDERS])).rows;
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      for (const b of bookings) {
        const start = new Date(NOW.getTime() + 15 * 60_000);
        await insertDrafts(
          c,
          { bookingId: b.id, bookingVersion: 1, clientId: b.client_id, branchId: branch, branchTimezone: tz, resourceName: 'ПК 1', start, end: new Date(start.getTime() + 3_600_000) },
          [{ kind: 'reminder_before_start', category: 'reminder', plannedAt: NOW, notAfter: start, title: 'Скоро начало', body: 'Через 15 минут', url: '/account/bookings/' }],
          NOW,
        );
      }
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    const dueMarketing = await n(`SELECT count(*) n FROM app.notifications WHERE category = 'marketing' AND status = 'planned' AND planned_at <= $1`, [NOW]);
    const tq = performance.now();
    const claimed = await claimDue(pool, NOW);
    const claimMs = performance.now() - tq;
    const claimedKinds = (await sql.query<{ category: string; n: number }>(`SELECT category, count(*)::int n FROM app.notifications WHERE id = ANY($1::uuid[]) GROUP BY 1 ORDER BY 1`, [claimed])).rows;
    const reminderClaimed = claimedKinds.find((k) => k.category === 'reminder')?.n ?? 0;
    const marketingClaimed = claimedKinds.find((k) => k.category === 'marketing')?.n ?? 0;
    console.log(`4) напоминаний ${REMINDERS} поверх ${dueMarketing} рекламных строк к отправке: первый проход диспетчера за ${claimMs.toFixed(0)} мс забрал ${JSON.stringify(claimedKinds)}`);

    const total = confirmMs + expandMs;
    const errors5xx = [...created, ...confirmed].filter((x) => x.status >= 500).length + expanded.filter((x) => 'err' in x).length;
    const checks: Record<string, boolean> = {
      'одна кампания': campaigns === 1 && ids.size === 1 && created.every((x) => x.code === 'ok'),
      'одно подтверждение': confirmed.filter((x) => x.code === 'ok').length === 1 && confirmed.filter((x) => x.code === 'CAMPAIGN_NOT_EDITABLE').length === 1,
      'снимок = получатели': snapshot === RECIPIENTS && snapshotDup === 0,
      'строка на получателя': rows === RECIPIENTS && rowsDistinct === RECIPIENTS,
      'кампания развёрнута': status === 'sending',
      'напоминания первым проходом': reminderClaimed === REMINDERS && marketingClaimed <= MARKETING_DISPATCH_LIMIT,
      [`длительность ≤ ${sec(LIMIT_MS)}`]: total <= LIMIT_MS,
      'без 5xx': errors5xx === 0,
    };
    const bad = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
    if (bad.length) {
      failed = true;
      console.error(`ПРОВАЛ: ${bad.join('; ')}`);
    } else {
      console.log(`ОК: одна кампания, одно подтверждение, ${rows} строк на ${RECIPIENTS} получателей без дублей; подтверждение + разворачивание ${sec(total)} ≤ 2 ч; напоминания не ждут рекламу`);
    }
  } finally {
    await pool?.end();
    await sql?.end();
    await pgServer.stop();
    await rm(dir, { recursive: true, force: true });
  }
  if (failed) process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

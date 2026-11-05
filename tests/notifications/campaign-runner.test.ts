// S4-15: разворачивание кампании и закрытие K21 §6 на настоящей Postgres: параллельные задачи, тихие часы по домашнему филиалу,
// отмена посреди разворачивания, подстановка имени и её удаление при обезличивании (K9, K21 §15).
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import { fixedClock, type TimeZone } from '../../apps/api/src/core/time.ts';
import { anonymizeClientNotifications, closeCampaigns, expandCampaign, runCampaignTick, windowStart } from '../../apps/api/src/modules/notifications/campaign-runner.ts';
import { cancelCampaign, confirmCampaign, createCampaign, type CampaignDeps, type CampaignDto } from '../../apps/api/src/modules/notifications/campaigns.ts';
import { withTx } from '../../apps/api/src/modules/clients/index.ts';
import { createTestBranch } from '../helpers/network.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const clock = fixedClock('2026-11-20T06:00:00Z'); // 13:00 Новосибирска – внутри окна
let db: TestDatabase;
let pool: pg.Pool;
let deps: CampaignDeps;
let staffId: string;
let owner: AccessContext;
let phone = 79180001000;
const WINDOW = { from: '10:00', to: '21:00' };
const NSK = 'Asia/Novosibirsk' as TimeZone;

const meta = (): AuditRequestMeta => ({ actor: { kind: 'staff', staffId, sessionId: 's' }, source: 'crm', requestId: randomUUID() });

/** Филиал с ресурсом; n клиентов с согласием и бронью в нём. */
async function branchWithClients(n: number, o: { timezone?: string; name?: string } = {}): Promise<{ branchId: string; clients: string[] }> {
  const branchId = (await createTestBranch(db.client, o.timezone ? { timezone: o.timezone } : {})).id;
  const res = (await db.client.query<{ id: string }>(`INSERT INTO app.resources (branch_id, resource_type, name) VALUES ($1, 'pc', 'ПК') RETURNING id`, [branchId])).rows[0]!.id;
  const clients: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = (
      await db.client.query<{ id: string }>(`INSERT INTO app.clients (phone_e164, status, first_name, registered_at, created_by_type) VALUES ($1, 'active', $2, now(), 'system') RETURNING id`, [
        `+${++phone}`,
        o.name ?? 'Ермолай',
      ])
    ).rows[0]!.id;
    await db.client.query('INSERT INTO app.client_notification_prefs (client_id, marketing_enabled) VALUES ($1, true)', [id]);
    await db.client.query(`INSERT INTO journal.client_consents (client_id, kind, granted, document_version, source, actor_type, actor_id) VALUES ($1, 'marketing', true, 'v1', 'account', 'client', $1)`, [id]);
    await db.client.query(
      `INSERT INTO app.bookings (checkout_id, branch_id, client_id, status, resource_id, period, price_kop, source, created_by_type)
       VALUES (gen_random_uuid(), $1, $2, 'completed', $3, tstzrange('2026-10-01 07:00+00', '2026-10-01 08:00+00', '[)'), 0, 'crm', 'system')`,
      [branchId, id, res],
    );
    clients.push(id);
  }
  return { branchId, clients };
}

async function confirmed(branchId: string, total: number, over: Record<string, unknown> = {}): Promise<CampaignDto> {
  const c = (await createCampaign(deps, owner, meta(), { category: 'marketing', title: 'Скидка, {client.firstName}', body: 'Ждём, {client.firstName}, в {branch.name}!', erid: 'E1', audience: { kind: 'segment', segment: { v: 1, area: { branchIds: [branchId] } } }, ...over }, randomUUID())).body as CampaignDto;
  return (await confirmCampaign(deps, owner, meta(), c.id, { rowVersion: 1, expectedTotal: total }, randomUUID())).body as CampaignDto;
}

const rows = async (campaignId: string) =>
  (await db.client.query<{ client_id: string; status: string; title: string; body: string; planned_at: Date; dedupe_key: string; kind: string; category: string }>(
    'SELECT client_id, status, title, body, planned_at, dedupe_key, kind, category FROM app.notifications WHERE campaign_id = $1 ORDER BY client_id',
    [campaignId],
  )).rows;
const statusOf = async (id: string) => (await db.client.query<{ status: string }>('SELECT status FROM app.notification_campaigns WHERE id = $1', [id])).rows[0]!.status;

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 8 });
  staffId = (await db.client.query<{ id: string }>(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('О', 'В', 'o@yu.test', 'owner', 'x') RETURNING id`)).rows[0]!.id;
  owner = { actor: { kind: 'staff', staffId, sessionId: 's' }, role: 'owner', network: true, cityIds: new Set(), branchIds: new Set(), at: clock.now() };
  deps = { pool, clock, network: { branchesOfCities: async () => [] }, bookings: { facts: async () => null }, unsubscribeSecret: 's'.repeat(32) };
});
afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('окно тихих часов', () => {
  it('в окне – сам момент; 23:00 НСК → 10:00 следующего дня; 08:00 НСК → 10:00 того же; граница to исключена', () => {
    expect(windowStart(new Date('2026-11-20T06:00:00Z'), NSK, WINDOW).toISOString()).toBe('2026-11-20T06:00:00.000Z');
    expect(windowStart(new Date('2026-11-20T16:00:00Z'), NSK, WINDOW).toISOString()).toBe('2026-11-21T03:00:00.000Z');
    expect(windowStart(new Date('2026-11-20T01:00:00Z'), NSK, WINDOW).toISOString()).toBe('2026-11-20T03:00:00.000Z');
    expect(windowStart(new Date('2026-11-20T14:00:00Z'), NSK, WINDOW).toISOString()).toBe('2026-11-21T03:00:00.000Z');
    expect(windowStart(new Date('2026-11-20T03:00:00Z'), NSK, WINDOW).toISOString()).toBe('2026-11-20T03:00:00.000Z');
  });
});

describe('разворачивание', () => {
  it('две параллельные задачи → по одной строке на клиента; пачки; статус → sending; подстановка и пометка', async () => {
    const { branchId, clients } = await branchWithClients(7);
    const c = await confirmed(branchId, 7);
    await Promise.all([expandCampaign(pool, clock, c.id, 3), expandCampaign(pool, clock, c.id, 3), expandCampaign(pool, clock, c.id, 2)]);
    const list = await rows(c.id);
    expect(list.map((r) => r.client_id).sort()).toEqual([...clients].sort());
    expect(new Set(list.map((r) => r.dedupe_key)).size).toBe(7);
    expect(list[0]).toMatchObject({ status: 'planned', kind: 'campaign', category: 'marketing', title: 'Реклама. Скидка, Ермолай' });
    expect(list[0]!.body).toMatch(/^Ждём, Ермолай, в t-[0-9a-f]+!$/);
    expect(await statusOf(c.id)).toBe('sending');
    await expandCampaign(pool, clock, c.id); // повтор после завершения – ничего
    expect(await rows(c.id)).toHaveLength(7);
  });

  it('planned_at – в окне домашнего филиала; у разных зон разный момент; будущий plannedAt кампании учитывается', async () => {
    const late = fixedClock('2026-11-20T16:00:00Z'); // 23:00 НСК, 20:00 Москвы
    const nsk = await branchWithClients(1);
    const msk = await branchWithClients(1, { timezone: 'Europe/Moscow' });
    const a = await confirmed(nsk.branchId, 1);
    const b = await confirmed(msk.branchId, 1);
    await expandCampaign(pool, late, a.id);
    await expandCampaign(pool, late, b.id);
    expect((await rows(a.id))[0]!.planned_at.toISOString()).toBe('2026-11-21T03:00:00.000Z');
    expect((await rows(b.id))[0]!.planned_at.toISOString()).toBe('2026-11-20T16:00:00.000Z'); // 19:00 Москвы – в окне
    const c = await confirmed(nsk.branchId, 1, { plannedAt: '2026-11-22T16:00:00Z' });
    await expandCampaign(pool, clock, c.id);
    expect((await rows(c.id))[0]!.planned_at.toISOString()).toBe('2026-11-23T03:00:00.000Z');
  });

  it('отказ после подтверждения – строка не создаётся; push=false → inbox_only', async () => {
    const { branchId, clients } = await branchWithClients(2);
    const c = await confirmed(branchId, 2);
    await db.client.query('UPDATE app.client_notification_prefs SET marketing_enabled = false WHERE client_id = $1', [clients[0]]);
    await expandCampaign(pool, clock, c.id);
    expect((await rows(c.id)).map((r) => r.client_id)).toEqual([clients[1]]);
    const other = await branchWithClients(1);
    const inbox = await confirmed(other.branchId, 1, { push: false });
    await expandCampaign(pool, clock, inbox.id);
    expect((await rows(inbox.id))[0]!.status).toBe('inbox_only');
  });

  it('отмена посреди разворачивания: готовые planned → cancelled, остаток не создаётся, гонка не оставляет planned', async () => {
    const { branchId } = await branchWithClients(30);
    const c = await confirmed(branchId, 30);
    await expandCampaign(pool, clock, c.id, 5).then(() => undefined); // полностью, затем отмена гасит все planned
    await cancelCampaign(deps, owner, meta(), c.id, { reason: 'ошибка' }, randomUUID());
    expect((await rows(c.id)).every((r) => r.status === 'cancelled')).toBe(true);

    const race = await confirmed(branchId, 30);
    await Promise.all([expandCampaign(pool, clock, race.id, 5), cancelCampaign(deps, owner, meta(), race.id, { reason: 'гонка' }, randomUUID())]);
    expect(await statusOf(race.id)).toBe('cancelled');
    expect((await rows(race.id)).filter((r) => r.status !== 'cancelled')).toEqual([]);
    expect(await expandCampaign(pool, clock, race.id)).toBe(0);
  });

  it('закрытие: нет строк planned/queued/sending → done; проход таймера разворачивает и закрывает', async () => {
    const { branchId } = await branchWithClients(2);
    const c = await confirmed(branchId, 2);
    await runCampaignTick(pool, clock);
    expect(await statusOf(c.id)).toBe('sending');
    await closeCampaigns(pool, clock);
    expect(await statusOf(c.id)).toBe('sending'); // строки ещё planned
    await db.client.query(`UPDATE app.notifications SET status = 'no_channel' WHERE campaign_id = $1`, [c.id]);
    await runCampaignTick(pool, clock);
    expect(await statusOf(c.id)).toBe('done');
  });
});

describe('обезличивание K21 §15', () => {
  it('в строках клиента и в аудите нет имени; чужие строки не тронуты; филиал в тексте остаётся', async () => {
    const name = 'Евлампий';
    const { branchId, clients } = await branchWithClients(2, { name });
    const c = await confirmed(branchId, 2);
    await expandCampaign(pool, clock, c.id);
    const [a, b] = clients as [string, string];
    expect(await withTx(pool, (tx) => anonymizeClientNotifications(tx, a, clock.now()))).toBe(1);
    const list = await rows(c.id);
    const mine = list.find((r) => r.client_id === a)!;
    expect(mine.title).toBe('Реклама. Скидка');
    expect(mine.body).toMatch(/^Ждём, в t-[0-9a-f]+!$/);
    expect(list.find((r) => r.client_id === b)!.title).toContain(name); // другой клиент не затронут
    const audit = await db.client.query<{ t: string }>(`SELECT coalesce(string_agg(row_to_json(e)::text, ' '), '') AS t FROM journal.audit_events e`);
    expect(audit.rows[0]!.t).not.toContain(name);
    expect(audit.rows[0]!.t).toContain('{client.firstName}'); // аудит хранит шаблон
  });
});

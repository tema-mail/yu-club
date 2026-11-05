// S4-13: сегменты segment.v1 → SQL в зоне отправителя, домашний филиал, предпросмотр аудитории K21 §5 на настоящей Postgres.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccessContext, NetworkLookup } from '../../apps/api/src/core/permissions.ts';
import { displayName, parseSegment, previewSegment, resolveArea, segmentRecipients, type SegmentV1 } from '../../apps/api/src/modules/notifications/segments.ts';
import { createTestBranch } from '../helpers/network.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

let db: TestDatabase;
let pool: pg.Pool;
const b: Record<string, { id: string; cityId: string; pc: string; vr: string }> = {};
let phone = 79160001000;
const now = new Date('2026-11-20T06:00:00Z'); // 13:00 Новосибирска
const day = 86_400_000;
const SYS = randomUUID();
const network: NetworkLookup = {
  branchesOfCities: async (d, cityIds) => (await d.query<{ id: string }>('SELECT id FROM app.branches WHERE city_id = ANY($1::uuid[])', [cityIds])).rows.map((r) => r.id),
};
const owner: AccessContext = { actor: { kind: 'staff', staffId: SYS, sessionId: 's' }, role: 'owner', network: true, cityIds: new Set(), branchIds: new Set(), at: now };
let director: AccessContext;

async function client(o: { marketing?: boolean; consent?: boolean; status?: string; sub?: boolean; name?: string } = {}): Promise<string> {
  const id = (
    await db.client.query<{ id: string }>(
      `INSERT INTO app.clients (phone_e164, status, first_name, registered_at, created_by_type) VALUES ($1, $2, $3, now(), 'system') RETURNING id`,
      [`+${++phone}`, o.status ?? 'active', o.name ?? 'Иван'],
    )
  ).rows[0]!.id;
  await db.client.query('INSERT INTO app.client_notification_prefs (client_id, marketing_enabled) VALUES ($1, $2)', [id, o.marketing ?? true]);
  if (o.consent ?? true) {
    await db.client.query(
      `INSERT INTO journal.client_consents (client_id, kind, granted, document_version, source, actor_type, actor_id) VALUES ($1, 'marketing', true, 'v1', 'account', 'client', $1)`,
      [id],
    );
  }
  if (o.sub ?? true) {
    await db.client.query(`INSERT INTO app.push_subscriptions (client_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4)`, [
      id,
      `https://fcm.googleapis.com/fcm/send/${randomUUID()}`,
      'B'.repeat(87),
      'A'.repeat(22),
    ]);
  }
  return id;
}

/** Бронь (и посещение при visited) в филиале key; start – момент начала. */
async function booking(clientId: string, key: string, start: Date, o: { visited?: boolean; type?: 'pc' | 'vr'; status?: string } = {}): Promise<void> {
  const br = b[key]!;
  const r = await db.client.query<{ id: string }>(
    `INSERT INTO app.bookings (checkout_id, branch_id, client_id, status, resource_id, period, price_kop, source, created_by_type, cancelled_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, tstzrange($5, $6, '[)'), 0, 'crm', 'system', CASE WHEN $3 LIKE 'cancelled%' THEN $5::timestamptz END) RETURNING id`,
    [br.id, clientId, o.status ?? (o.visited ? 'completed' : 'confirmed'), o.type === 'vr' ? br.vr : br.pc, start, new Date(start.getTime() + 3600_000)],
  );
  if (o.visited) {
    await db.client.query(`INSERT INTO app.visits (booking_id, branch_id, client_id, arrived_at, marked_by) VALUES ($1, $2, $3, $4, $5)`, [r.rows[0]!.id, br.id, clientId, start, SYS]);
  }
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
  for (const key of ['b1', 'b2', 'other']) {
    const br = await createTestBranch(db.client, key === 'b2' ? { cityId: b.b1!.cityId } : {});
    const res = async (type: string) =>
      (await db.client.query<{ id: string }>(`INSERT INTO app.resources (branch_id, resource_type, name) VALUES ($1, $2, $2) RETURNING id`, [br.id, type])).rows[0]!.id;
    b[key] = { ...br, pc: await res('pc'), vr: await res('vr_seat') };
  }
  await db.client.query('UPDATE app.branches SET sort_order = 1 WHERE id = $1', [b.b1!.id]);
  await db.client.query('UPDATE app.branches SET sort_order = 2 WHERE id = $1', [b.b2!.id]);
  director = { actor: { kind: 'staff', staffId: SYS, sessionId: 's' }, role: 'director', network: false, cityIds: new Set(), branchIds: new Set([b.b1!.id]), at: now };
});
afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('segment.v1', () => {
  it('неверный сегмент → SEGMENT_INVALID с issues; без области – тоже', () => {
    expect(() => parseSegment({ v: 1 })).toThrow(expect.objectContaining({ code: 'SEGMENT_INVALID' }));
    expect(() => parseSegment({ v: 1, area: { branchIds: [] } })).toThrow(expect.objectContaining({ code: 'SEGMENT_INVALID' }));
    expect(() => parseSegment({ v: 1, area: { network: true }, minVisits: 0 })).toThrow(expect.objectContaining({ code: 'SEGMENT_INVALID' }));
    expect(() => parseSegment({ v: 1, area: { network: true }, birthday: true })).toThrow(expect.objectContaining({ code: 'SEGMENT_INVALID' }));
    expect(parseSegment({ v: 1, area: { network: true }, minVisits: 2 })).toEqual({ v: 1, area: { network: true }, minVisits: 2 });
  });

  it('Директор: филиал вне зоны → NOT_FOUND, сеть → FORBIDDEN, город без назначения → NOT_FOUND; свой филиал – да', async () => {
    await expect(resolveArea(pool, director, { branchIds: [b.other!.id] }, network)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(resolveArea(pool, director, { branchIds: [b.b1!.id, b.other!.id] }, network)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(resolveArea(pool, director, { network: true }, network)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(resolveArea(pool, director, { cityIds: [b.b1!.cityId] }, network)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await resolveArea(pool, director, { branchIds: [b.b1!.id] }, network)).toEqual({ type: 'branch', ids: [b.b1!.id], branchIds: [b.b1!.id] });
    const city = await resolveArea(pool, owner, { cityIds: [b.b1!.cityId] }, network);
    expect(city.branchIds).toEqual([b.b1!.id, b.b2!.id].sort());
  });
});

describe('предпросмотр аудитории K21 §5', () => {
  it('6 клиентов с разными причинами → счётчики 1/1/…, сумма = total; клиент филиала = бронь в филиале', async () => {
    const seg: SegmentV1 = { v: 1, area: { branchIds: [b.b1!.id] } };
    const area = await resolveArea(pool, director, seg.area, network);
    const ok = await client({ name: 'Анна' });
    const off = await client({ marketing: false });
    const noConsent = await client({ consent: false });
    const noSub = await client({ sub: false });
    const blocked = await client({ status: 'blocked' });
    const freq = await client();
    const outsider = await client(); // бронь только в другом филиале
    for (const c of [ok, off, noConsent, noSub, blocked, freq]) await booking(c, 'b1', new Date(now.getTime() - 10 * day), { status: 'cancelled_by_client' });
    await booking(outsider, 'other', new Date(now.getTime() - 10 * day));
    await db.client.query(
      `INSERT INTO app.notifications (client_id, category, kind, source, title, body, planned_at, status, sent_at, dedupe_key)
       VALUES ($1, 'marketing', 'campaign', 'staff', 'Реклама.', 'т', $2, 'sent_to_provider', $2, $3)`,
      [freq, new Date(now.getTime() - 2 * day), `t:${randomUUID()}`],
    );
    const p = await previewSegment(pool, director, seg, area, true, now);
    expect({ ...p, sample: p.sample.length, computedAt: undefined }).toEqual({
      total: 6,
      willReceivePush: 1,
      inboxOnly: 1,
      excludedMarketingOff: 2,
      excludedFrequency: 1,
      excludedInactive: 1,
      criticalService: 0,
      sample: 2,
      computedAt: undefined,
    });
    expect(p.willReceivePush + p.inboxOnly + p.excludedMarketingOff + p.excludedFrequency + p.excludedInactive).toBe(p.total);
    expect(p.sample.find((s) => s.clientId === ok)?.displayName).toBe('Анна'); // у Директора есть client.view.full
    expect(displayName('Анна', 'Петрова', false)).toBe('А***'); // без права – маска (K24 §6)
  });
});

describe('условия сегмента и домашний филиал', () => {
  it('посещения по датам зоны, «давно не были», minVisits, будущая бронь, направление; домашний – последнее посещение', async () => {
    const area = await resolveArea(pool, owner, { cityIds: [b.b1!.cityId] }, network);
    const regular = await client();
    const old = await client();
    const vrOnly = await client();
    const future = await client();
    // 2026-11-01 00:30 по НСК = 2026-10-31 17:30Z – дата сеанса по зоне филиала – 1 ноября
    await booking(regular, 'b1', new Date('2026-10-31T17:30:00Z'), { visited: true });
    await booking(regular, 'b2', new Date('2026-11-10T07:00:00Z'), { visited: true });
    await booking(old, 'b1', new Date('2026-06-01T07:00:00Z'), { visited: true });
    await booking(vrOnly, 'b2', new Date('2026-11-05T07:00:00Z'), { visited: true, type: 'vr' });
    await booking(future, 'b2', new Date(now.getTime() + 2 * day));
    const ids = async (s: Omit<SegmentV1, 'v' | 'area'>) =>
      (await segmentRecipients(pool, { v: 1, area: { cityIds: [b.b1!.cityId] }, ...s }, area, true, now)).map((r) => r.clientId).filter((x) => [regular, old, vrOnly, future].includes(x)).sort();
    expect(await ids({ visitedBetween: { from: '2026-11-01', to: '2026-11-01' } })).toEqual([regular]);
    expect(await ids({ notVisitedSince: '2026-10-01' })).toEqual([old]);
    expect(await ids({ minVisits: 2 })).toEqual([regular]);
    expect(await ids({ hasUpcomingBooking: true })).toEqual([future]);
    expect(await ids({ resourceTypes: ['vr'] })).toEqual([vrOnly]);
    const rec = await segmentRecipients(pool, { v: 1, area: { cityIds: [b.b1!.cityId] } }, area, true, now);
    const home = (id: string) => rec.find((r) => r.clientId === id)?.homeBranchId;
    expect(home(regular)).toBe(b.b2!.id); // последнее посещение – b2
    expect(home(future)).toBe(b.b2!.id); // посещений нет – последняя бронь
    expect(rec.find((r) => r.clientId === regular)?.decision).toBe('ok');
  });
});

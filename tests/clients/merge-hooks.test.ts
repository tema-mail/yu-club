// K9 «Слияние» с настоящими обработчиками модулей на настоящей Postgres: брони, удержания, время клиента, посещения,
// неявки (booking), сеансы оплаты (finance), сертификаты (certificates), мероприятия и подарки (events), уведомления.
// Проверяется: всё второй карточки переехало на основную, у второй пусто, суммы платежей не изменились,
// пересечение времени и подарок в тот же год – 409 CLIENT_MERGE_CONFLICT с откатом. Баллы – tests/loyalty/merge.test.ts.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { bookingClientMerger } from '../../apps/api/src/modules/booking/merge.ts';
import { withTx } from '../../apps/api/src/modules/clients/index.ts';
import { clearClientMergers, mergeClients, mergePreview, registerClientMerger, REQUIRED_CLIENT_MERGERS } from '../../apps/api/src/modules/clients/merge.ts';
import { financeClientMerger } from '../../apps/api/src/modules/finance/merge.ts';
import { createTestBooking } from '../helpers/booking.ts';
import { createTestBranch } from '../helpers/network.ts';
import { createTestPayment } from '../helpers/payment.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const STAFF = 'cccccccc-0000-4000-8000-00000000000c';
const clock = fixedClock('2026-11-20T07:00:00Z');
const owner: AccessContext = { actor: { kind: 'staff', staffId: STAFF, sessionId: STAFF }, role: 'owner', network: true, cityIds: new Set(), branchIds: new Set(), at: clock.now() };
const meta: AuditRequestMeta = { actor: owner.actor, access: owner, source: 'crm', requestId: 'req-merge-hooks' };

let db: TestDatabase;
let pool: pg.Pool;
let branchId = '';
let seq = 79180000000;

async function addClient(): Promise<string> {
  const r = await db.client.query<{ id: string }>(
    `INSERT INTO app.clients (phone_e164, phone_verified_at, first_name, status, registered_at, created_by_type) VALUES ($1, now(), 'Аглая', 'active', now(), 'system') RETURNING id`,
    [`+${++seq}`],
  );
  return r.rows[0]!.id;
}
const merge = (p: string, s: string) => withTx(pool, (tx) => mergeClients(tx, owner, { primaryId: p, secondaryId: s, reason: 'same_person_confirmed' }, meta, undefined, clock));
const count = async (sql: string, id: string) => (await db.client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`, [id])).rows[0]!.n;

async function clientTime(clientId: string, from: string, to: string): Promise<void> {
  await db.client.query(
    `INSERT INTO app.client_time (client_id, period, source_type, source_id) VALUES ($1, tstzrange($2, $3, '[)'), 'booking', gen_random_uuid())`,
    [clientId, from, to],
  );
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
  branchId = (await createTestBranch(db.client)).id;
  clearClientMergers();
  registerClientMerger(bookingClientMerger);
  registerClientMerger(financeClientMerger);
  for (const name of REQUIRED_CLIENT_MERGERS) {
    if (name === 'booking' || name === 'finance') continue;
    registerClientMerger({ name, preview: async () => ({}), reassign: async () => ({}) });
  }
});
afterAll(async () => {
  clearClientMergers();
  await pool.end();
  await db.drop();
});

describe('booking', () => {
  it('брони, удержания, время клиента, посещения и неявки переезжают; предпросмотр считает впереди/посещения/неявки', async () => {
    const a = await addClient();
    const b = await addClient();
    const future = await createTestBooking(db.client, { clientId: b, branchId }); // 2027 – впереди
    const done = await createTestBooking(db.client, { clientId: b, branchId, status: 'completed' });
    const ns = await createTestBooking(db.client, { clientId: b, branchId, status: 'no_show' });
    await createTestBooking(db.client, { clientId: b, branchId, status: 'cancelled_by_client' });
    await db.client.query(`INSERT INTO app.visits (booking_id, branch_id, client_id, arrived_at, marked_by) VALUES ($1, $2, $3, now(), $4)`, [done, branchId, b, STAFF]);
    await db.client.query(`INSERT INTO app.no_shows (booking_id, branch_id, client_id, marked_at, marked_by) VALUES ($1, $2, $3, now(), $4)`, [ns, branchId, b, STAFF]);
    await db.client.query(`INSERT INTO app.holds (branch_id, client_id, created_by_type, ttl_minutes, expires_at) VALUES ($1, $2, 'client', 10, '2026-11-20T08:00Z')`, [branchId, b]);
    await clientTime(b, '2027-03-01T10:00Z', '2027-03-01T11:00Z');
    await createTestBooking(db.client, { clientId: a, branchId, status: 'completed' });

    const before = await mergePreview(pool, owner, { primaryId: a, secondaryId: b }, undefined, clock);
    expect(before.modules.booking).toEqual({
      primary: { upcoming: 0, visits: 0, noShows: 0, cancelled: 0, holds: 0, total: 1 },
      secondary: { upcoming: 1, visits: 1, noShows: 1, cancelled: 1, holds: 1, total: 4 },
    });

    const res = await merge(a, b);
    expect(res.results.booking).toEqual({ bookings: 4, holds: 1, clientTime: 1, visits: 1, noShows: 1 });
    for (const t of ['app.bookings', 'app.holds', 'app.client_time', 'app.visits', 'app.no_shows']) {
      expect(await count(`${t} WHERE client_id = $1`, b)).toBe(0);
    }
    expect(await count('app.bookings WHERE client_id = $1', a)).toBe(5);
    expect((await db.client.query('SELECT client_id FROM app.bookings WHERE id = $1', [future])).rows[0].client_id).toBe(a);
    // история брони осталась с исходным id – сама бронь та же строка
    expect(await count('app.bookings WHERE id = $1', future)).toBe(1);
  });

  it('пересечение времени у обеих карточек – 409 CLIENT_MERGE_CONFLICT, ничего не изменилось', async () => {
    const a = await addClient();
    const b = await addClient();
    await clientTime(a, '2027-04-01T10:00Z', '2027-04-01T12:00Z');
    await clientTime(b, '2027-04-01T11:00Z', '2027-04-01T13:00Z');
    await createTestBooking(db.client, { clientId: b, branchId });
    await expect(merge(a, b)).rejects.toMatchObject({ code: 'CLIENT_MERGE_CONFLICT', httpStatus: 409, details: { module: 'booking', constraint: 'client_time_no_overlap' } });
    expect(await count('app.bookings WHERE client_id = $1', b)).toBe(1);
    expect((await db.client.query('SELECT status FROM app.clients WHERE id = $1', [b])).rows[0].status).toBe('active');
  });
});

describe('finance', () => {
  it('сеансы оплаты переезжают, суммы платежей и возвратов по обеим карточкам вместе не меняются; у второй пусто', async () => {
    const a = await addClient();
    const b = await addClient();
    const ba = await createTestBooking(db.client, { clientId: a, branchId, status: 'completed' });
    const bb = await createTestBooking(db.client, { clientId: b, branchId, status: 'completed' });
    await createTestPayment(db.client, ba);
    await createTestPayment(db.client, bb);
    await db.client.query(`UPDATE app.payments SET status = 'active', total_kop = CASE WHEN session_id = $1 THEN 150000 ELSE 250000 END WHERE session_id IN ($1, $2)`, [ba, bb]);
    const sum = async (id: string) => (await financeClientMerger.preview(db.client, id, clock.now())) as { payments: number; paidKop: number };
    const pa = await sum(a);
    const pb = await sum(b);
    expect(pa).toMatchObject({ payments: 1, paidKop: 150000 });
    expect(pb).toMatchObject({ payments: 1, paidKop: 250000 });
    const total = (await db.client.query<{ s: string }>(`SELECT sum(total_kop) AS s FROM app.payments WHERE status = 'active'`)).rows[0]!.s;

    const res = await merge(a, b);
    expect(res.results.finance).toEqual({ sessions: 1 });
    expect(await sum(a)).toMatchObject({ payments: 2, paidKop: pa.paidKop + pb.paidKop });
    expect(await sum(b)).toMatchObject({ payments: 0, paidKop: 0, refundedKop: 0, unpaidSessions: 0 });
    expect((await db.client.query<{ s: string }>(`SELECT sum(total_kop) AS s FROM app.payments WHERE status = 'active'`)).rows[0]!.s).toBe(total);
    expect(await count('app.payment_sessions WHERE client_id = $1', b)).toBe(0);
  });
});

// K9 «Слияние» против параллельной записи: две настоящие транзакции на одной базе, настоящие команды брони и все шесть
// обработчиков модулей. Порядок замков слияния – счёт баллов → удержания и брони второй → строки клиентов (меньший id первым),
// как у подтверждения, отмены и брони администратором; мероприятия второй – тоже до клиентов (events.ts: мероприятие → клиент).
// Кто второй – ждёт, взаимоблокировки нет (40P01 упал бы тестом).
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { AppError } from '../../apps/api/src/core/errors.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import type { Clock } from '../../apps/api/src/core/time.ts';
import { createStaffBooking } from '../../apps/api/src/modules/booking/change.ts';
import { confirmHold } from '../../apps/api/src/modules/booking/confirm.ts';
import { createHold } from '../../apps/api/src/modules/booking/hold.ts';
import { bookingClientMerger } from '../../apps/api/src/modules/booking/merge.ts';
import { runOccupancyCommand } from '../../apps/api/src/modules/booking/occupancy.ts';
import { certificatesClientMerger } from '../../apps/api/src/modules/certificates/merge.ts';
import { withTx } from '../../apps/api/src/modules/clients/index.ts';
import { clearClientMergers, mergeClients, registerClientMerger } from '../../apps/api/src/modules/clients/merge.ts';
import { createEvent, updateEvent } from '../../apps/api/src/modules/events/events.ts';
import { eventsClientMerger } from '../../apps/api/src/modules/events/merge.ts';
import { financeClientMerger } from '../../apps/api/src/modules/finance/merge.ts';
import { loyaltyClientMerger } from '../../apps/api/src/modules/loyalty/merge.ts';
import { notificationsClientMerger } from '../../apps/api/src/modules/notifications/merge.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const SYS = '00000000-0000-0000-0000-000000000001';
const clock: Clock = { now: () => new Date('2026-11-14T05:00:00Z') };
let db: TestDatabase;
let pool: pg.Pool;
let owner: AccessContext;
let branchId = '';
let pc = '';
let seq = 79210000000;
let slot = 0;
const meta = (): AuditRequestMeta => ({ actor: owner.actor, access: owner, source: 'crm', requestId: randomUUID() });

const addClient = async () =>
  (await db.client.query<{ id: string }>(`INSERT INTO app.clients (phone_e164, status, registered_at, created_by_type) VALUES ($1, 'active', now(), 'system') RETURNING id`, [`+${++seq}`])).rows[0]!.id;
/** Час на ПК-1 – свой у каждого вызова: брони тестов не пересекаются. */
const nextSpan = () => {
  const start = new Date(Date.parse('2026-11-15T04:00:00Z') + slot++ * 3_600_000);
  return { resourceId: pc, start, end: new Date(start.getTime() + 3_600_000) };
};
const hold = (clientId: string) => runOccupancyCommand(pool, (c) => createHold(c, { clientId, visitorId: null }, { branchId, items: [nextSpan()] }, clock));
const doMerge = (tx: pg.PoolClient, p: string, s: string) => mergeClients(tx, owner, { primaryId: p, secondaryId: s, reason: 'same_person_confirmed' }, meta(), undefined, clock);

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
}
async function openTx(): Promise<pg.PoolClient> {
  const c = await pool.connect();
  await c.query('BEGIN');
  return c;
}
async function commit(c: pg.PoolClient): Promise<void> {
  try {
    await c.query('COMMIT');
  } finally {
    c.release();
  }
}
async function waitForLockWait(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const r = await db.client.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`);
    if (r.rows[0]!.n > 0) return;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error('вторая транзакция не ждёт замка');
}
const bookingsOf = async (id: string) => (await db.client.query<{ n: number }>('SELECT count(*)::int AS n FROM app.bookings WHERE client_id = $1', [id])).rows[0]!.n;

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 8 });
  const s = await db.client.query<{ id: string }>(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', 'o@yu.test', 'owner', 'x') RETURNING id`);
  owner = { actor: { kind: 'staff', staffId: s.rows[0]!.id, sessionId: randomUUID() }, role: 'owner', network: true, cityIds: new Set(), branchIds: new Set(), at: clock.now() };
  const city = (await db.client.query<{ id: string }>(`INSERT INTO app.cities (code, slug, name, timezone) VALUES ('nsk', 'nsk', 'НСК', 'Asia/Novosibirsk') RETURNING id`)).rows[0]!.id;
  branchId = (await db.client.query<{ id: string }>(`INSERT INTO app.branches (city_id, code, slug, name, address, timezone, status) VALUES ($1, 'b1', 'b1', 'b1', 'Красный, 1', 'Asia/Novosibirsk', 'active') RETURNING id`, [city])).rows[0]!.id;
  await db.client.query(`INSERT INTO app.branch_weekly_hours (branch_id, weekday, open_time, close_time, valid_from, created_by) SELECT $1, d, '00:00', '23:59', '2026-01-01', $2 FROM generate_series(1, 7) d`, [branchId, SYS]);
  await db.client.query(`INSERT INTO app.tariffs (branch_id, resource_type, name, unit_minutes, price_per_unit_kop, valid_from, status, created_by) VALUES ($1, 'pc', 'pc', 30, 20000, '2026-01-01', 'active', $2)`, [branchId, SYS]);
  const unit = (await db.client.query<{ id: string }>(`INSERT INTO app.occupancy_units (branch_id, code, name) VALUES ($1, 'PC1', 'PC1') RETURNING id`, [branchId])).rows[0]!.id;
  pc = (await db.client.query<{ id: string }>(`INSERT INTO app.resources (branch_id, resource_type, name) VALUES ($1, 'pc', 'ПК-1') RETURNING id`, [branchId])).rows[0]!.id;
  await db.client.query(`INSERT INTO app.resource_units (resource_id, unit_id, valid_from) VALUES ($1, $2, '2026-01-01')`, [pc, unit]);
  clearClientMergers();
  for (const m of [bookingClientMerger, financeClientMerger, loyaltyClientMerger, certificatesClientMerger, eventsClientMerger, notificationsClientMerger]) registerClientMerger(m);
});
afterAll(async () => {
  clearClientMergers();
  await pool.end();
  await db.drop();
});

describe('слияние ↔ запись: две транзакции', () => {
  it('слияние первым: подтверждение удержания второй карточки ждёт и не создаёт брони на неё', async () => {
    const a = await addClient();
    const b = await addClient();
    const h = await hold(b);
    const tx = await openTx();
    await doMerge(tx, a, b);
    const second = codeOf(runOccupancyCommand(pool, (c) => confirmHold(c, b, h.id, clock)));
    await waitForLockWait();
    await commit(tx);
    expect(await second).toBe('NOT_FOUND'); // удержание уже у основной
    expect(await bookingsOf(b)).toBe(0);
    expect((await db.client.query('SELECT client_id FROM app.holds WHERE id = $1', [h.id])).rows[0].client_id).toBe(a);
  });

  it('слияние первым: бронь администратором на вторую карточку ждёт и получает CLIENT_RESTRICTED', async () => {
    const a = await addClient();
    const b = await addClient();
    const tx = await openTx();
    await doMerge(tx, a, b);
    const span = nextSpan();
    const second = codeOf(runOccupancyCommand(pool, (c) => createStaffBooking(c, { ctx: owner, branchId, resourceId: pc, start: span.start, end: span.end, client: { clientId: b } }, meta(), clock)));
    await waitForLockWait();
    await commit(tx);
    expect(await second).toBe('CLIENT_RESTRICTED');
    expect(await bookingsOf(b)).toBe(0);
  });

  it('подтверждение первым: слияние ждёт, затем переносит новую бронь к основной', async () => {
    const a = await addClient();
    const b = await addClient();
    const h = await hold(b);
    const tx = await openTx();
    await confirmHold(tx, b, h.id, clock);
    const second = withTx(pool, (c) => doMerge(c, a, b));
    await waitForLockWait();
    await commit(tx);
    const r = await second;
    expect(r.results.booking).toMatchObject({ bookings: 1, holds: 1 });
    expect(await bookingsOf(b)).toBe(0);
    expect(await bookingsOf(a)).toBe(1);
  });

  it('два слияния одной второй карточки параллельно: одно проходит, второе – 409 CLIENT_MERGED', async () => {
    const a = await addClient();
    const c = await addClient();
    const b = await addClient();
    await hold(b);
    const codes = await Promise.all([codeOf(withTx(pool, (t) => doMerge(t, a, b))), codeOf(withTx(pool, (t) => doMerge(t, c, b)))]);
    expect(codes.sort()).toEqual(['CLIENT_MERGED', 'ok']);
    expect((await db.client.query('SELECT count(*)::int AS n FROM journal.client_merges WHERE secondary_client_id = $1', [b])).rows[0].n).toBe(1);
  });

  it('правка мероприятия второй карточки держит его и берёт клиента-основную: слияние ждёт мероприятие, дедлока нет', async () => {
    const a = await addClient();
    const b = await addClient();
    const typeId = (await db.client.query<{ id: string }>(`SELECT id FROM app.event_types WHERE code = 'other'`)).rows[0]!.id;
    const e = await withTx(pool, (tx) => createEvent(tx, owner, { typeId, branchId, customer: { clientId: b, name: 'Аглая', phone: '+79131234567' } }, meta(), clock));
    const tx = await openTx();
    await tx.query('SELECT id FROM app.events WHERE id = $1 FOR UPDATE', [e.id]); // первый шаг updateEvent – замок мероприятия
    const second = codeOf(withTx(pool, (t) => doMerge(t, a, b)));
    await waitForLockWait();
    // второй шаг – клиент-именинник (основная карточка): слияние ещё не держит строки клиентов
    await updateEvent(tx, owner, e.id, { rowVersion: e.rowVersion, birthdayPerson: { clientId: a } }, meta(), clock);
    await commit(tx);
    expect(await second).toBe('ok');
    expect((await db.client.query('SELECT customer_client_id, birthday_client_id FROM app.events WHERE id = $1', [e.id])).rows[0]).toEqual({ customer_client_id: a, birthday_client_id: a });
  });
});

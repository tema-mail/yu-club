// K9 «Обезличивание» против параллельной записи (D4-63): две настоящие транзакции на одной базе. Строка клиента –
// общая точка: обезличивание берёт её FOR UPDATE, создание и правка мероприятия – FOR NO KEY UPDATE (как бронь, lockClients).
// Кто второй – ждёт; итог согласован: мероприятие после обезличивания – CLIENT_RESTRICTED, обезличивание после
// мероприятия – 409 CLIENT_HAS_ACTIVE_RECORDS.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { AppError } from '../../apps/api/src/core/errors.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { bookingClientAnonymizer } from '../../apps/api/src/modules/booking/anonymize.ts';
import { anonymizeClient, clearClientAnonymizers, registerClientAnonymizer } from '../../apps/api/src/modules/clients/anonymize.ts';
import { withTx } from '../../apps/api/src/modules/clients/index.ts';
import { eventsClientAnonymizer } from '../../apps/api/src/modules/events/anonymize.ts';
import { createEvent, updateEvent } from '../../apps/api/src/modules/events/events.ts';
import { anonymizeClientNotifications } from '../../apps/api/src/modules/notifications/campaign-runner.ts';
import { createTestBranch } from '../helpers/network.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const clock = fixedClock('2026-11-20T07:00:00Z');
let db: TestDatabase;
let pool: pg.Pool;
let owner: AccessContext;
let branchId = '';
let typeId = '';
let seq = 79150000000;

const meta = (): AuditRequestMeta => ({ actor: owner.actor, access: owner, source: 'crm', requestId: randomUUID() });

async function addClient(): Promise<string> {
  const r = await db.client.query<{ id: string }>(
    `INSERT INTO app.clients (phone_e164, first_name, status, registered_at, created_by_type) VALUES ($1, 'Аглая', 'active', now(), 'system') RETURNING id`,
    [`+${++seq}`],
  );
  return r.rows[0]!.id;
}

const eventInput = (over: Record<string, unknown> = {}) => ({ typeId, branchId, customer: { name: 'Анна', phone: '+79131234567' }, ...over });
const anonymize = (tx: pg.PoolClient, clientId: string) => anonymizeClient(tx, clientId, { reason: 'client_request' }, meta(), clock);

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
}

/** Открытая транзакция: первая сторона гонки держит замки до commit. */
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

/** Ждём, пока другая транзакция встанет на замок строки; не встала за 3 с – гонка не сериализуется. */
async function waitForLockWait(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const r = await db.client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    if (r.rows[0]!.n > 0) return;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error('вторая транзакция не ждёт замка');
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 6 });
  const s = await db.client.query<{ id: string }>(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', 'o@yu.test', 'owner', 'x') RETURNING id`);
  owner = { actor: { kind: 'staff', staffId: s.rows[0]!.id, sessionId: randomUUID() }, role: 'owner', network: true, cityIds: new Set(), branchIds: new Set(), at: clock.now() };
  branchId = (await createTestBranch(db.client)).id;
  typeId = (await db.client.query<{ id: string }>(`SELECT id FROM app.event_types WHERE code = 'other'`)).rows[0]!.id;
  clearClientAnonymizers();
  registerClientAnonymizer(bookingClientAnonymizer);
  registerClientAnonymizer(eventsClientAnonymizer);
  registerClientAnonymizer({ name: 'notifications', run: anonymizeClientNotifications });
});
afterAll(async () => {
  clearClientAnonymizers();
  await pool.end();
  await db.drop();
});

describe('обезличивание ↔ мероприятие: две транзакции', () => {
  it('обезличивание первым: создание мероприятия ждёт и получает CLIENT_RESTRICTED', async () => {
    const client = await addClient();
    const a = await openTx();
    await anonymize(a, client);
    const second = codeOf(withTx(pool, (tx) => createEvent(tx, owner, eventInput({ customer: { clientId: client, name: 'Аглая', phone: '+79131234567' } }), meta(), clock)));
    await waitForLockWait();
    await commit(a);
    expect(await second).toBe('CLIENT_RESTRICTED');
    expect((await db.client.query('SELECT count(*)::int AS n FROM app.events WHERE customer_client_id = $1', [client])).rows[0].n).toBe(0);
  });

  it('мероприятие первым: обезличивание ждёт и получает 409 CLIENT_HAS_ACTIVE_RECORDS', async () => {
    const client = await addClient();
    const a = await openTx();
    await createEvent(a, owner, eventInput({ customer: { clientId: client, name: 'Аглая', phone: '+79131234567' } }), meta(), clock);
    const second = codeOf(withTx(pool, (tx) => anonymize(tx, client)));
    await waitForLockWait();
    await commit(a);
    expect(await second).toBe('CLIENT_HAS_ACTIVE_RECORDS');
    expect((await db.client.query('SELECT status FROM app.clients WHERE id = $1', [client])).rows[0].status).toBe('active');
  });

  it('правка: заказчик меняется на клиента под обезличиванием – ждёт и получает CLIENT_RESTRICTED', async () => {
    const client = await addClient();
    const e = await withTx(pool, (tx) => createEvent(tx, owner, eventInput(), meta(), clock));
    const a = await openTx();
    await anonymize(a, client);
    const second = codeOf(
      withTx(pool, (tx) => updateEvent(tx, owner, e.id, { rowVersion: e.rowVersion, customer: { clientId: client, name: 'Аглая' } }, meta(), clock)),
    );
    await waitForLockWait();
    await commit(a);
    expect(await second).toBe('CLIENT_RESTRICTED');
  });

  it('именинник – обезличенный клиент: создание и правка – CLIENT_RESTRICTED; правка без смены людей проходит', async () => {
    const client = await addClient();
    await withTx(pool, (tx) => anonymize(tx, client));
    expect(await codeOf(withTx(pool, (tx) => createEvent(tx, owner, eventInput({ birthdayPerson: { clientId: client } }), meta(), clock)))).toBe('CLIENT_RESTRICTED');
    const e = await withTx(pool, (tx) => createEvent(tx, owner, eventInput(), meta(), clock));
    expect(await codeOf(withTx(pool, (tx) => updateEvent(tx, owner, e.id, { rowVersion: e.rowVersion, birthdayPerson: { clientId: client } }, meta(), clock)))).toBe('CLIENT_RESTRICTED');
    expect(await codeOf(withTx(pool, (tx) => updateEvent(tx, owner, e.id, { rowVersion: e.rowVersion, title: 'Новое' }, meta(), clock)))).toBe('ok');
  });
});

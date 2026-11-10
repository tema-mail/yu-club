// K9: обезличивание × слияние × запись (ревизия 10.11, сценарий R6). Порядок замков у обоих – мероприятия клиента до строки
// клиента (D5-08; events.ts: мероприятие → клиент). Раньше обезличивание брало клиента, затем обновляло мероприятия, а слияние –
// мероприятия, затем клиента: взаимоблокировка 40P01. Третья транзакция держит строку клиента (как бронь – lockClients),
// чтобы обе стороны встали в очередь в нужном порядке.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { AppError } from '../../apps/api/src/core/errors.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { bookingClientAnonymizer } from '../../apps/api/src/modules/booking/anonymize.ts';
import { bookingClientMerger } from '../../apps/api/src/modules/booking/merge.ts';
import { certificatesClientMerger } from '../../apps/api/src/modules/certificates/merge.ts';
import { anonymizeClient, clearClientAnonymizers, registerClientAnonymizer } from '../../apps/api/src/modules/clients/anonymize.ts';
import { lockClients, withTx } from '../../apps/api/src/modules/clients/index.ts';
import { clearClientMergers, mergeClients, registerClientMerger } from '../../apps/api/src/modules/clients/merge.ts';
import { eventsClientAnonymizer } from '../../apps/api/src/modules/events/anonymize.ts';
import { eventsClientMerger } from '../../apps/api/src/modules/events/merge.ts';
import { financeClientMerger } from '../../apps/api/src/modules/finance/merge.ts';
import { loyaltyClientMerger } from '../../apps/api/src/modules/loyalty/merge.ts';
import { anonymizeClientNotifications } from '../../apps/api/src/modules/notifications/campaign-runner.ts';
import { notificationsClientMerger } from '../../apps/api/src/modules/notifications/merge.ts';
import { createTestBranch } from '../helpers/network.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const clock = fixedClock('2026-11-20T07:00:00Z');
let db: TestDatabase;
let pool: pg.Pool;
let owner: AccessContext;
let branchId = '';
let typeId = '';
let seq = 79250000000;
const meta = (): AuditRequestMeta => ({ actor: owner.actor, access: owner, source: 'crm', requestId: randomUUID() });
const addClient = async () =>
  (await db.client.query<{ id: string }>(`INSERT INTO app.clients (phone_e164, first_name, status, registered_at, created_by_type) VALUES ($1, 'Аглая', 'active', now(), 'system') RETURNING id`, [`+${++seq}`])).rows[0]!.id;

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    if (e instanceof AppError) return e.code;
    if ((e as { code?: string }).code === '40P01') return 'DEADLOCK';
    throw e;
  }
}
async function waitForLockWaits(n: number): Promise<void> {
  for (let i = 0; i < 80; i++) {
    const r = await db.client.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`);
    if (r.rows[0]!.n >= n) return;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error(`не дождались ${n} ожидающих замка`);
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 8 });
  const s = await db.client.query<{ id: string }>(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', 'o@yu.test', 'owner', 'x') RETURNING id`);
  owner = { actor: { kind: 'staff', staffId: s.rows[0]!.id, sessionId: randomUUID() }, role: 'owner', network: true, cityIds: new Set(), branchIds: new Set(), at: clock.now() };
  branchId = (await createTestBranch(db.client)).id;
  typeId = (await db.client.query<{ id: string }>(`SELECT id FROM app.event_types WHERE code = 'birthday'`)).rows[0]!.id;
  clearClientAnonymizers();
  registerClientAnonymizer(bookingClientAnonymizer);
  registerClientAnonymizer(eventsClientAnonymizer);
  registerClientAnonymizer({ name: 'notifications', run: anonymizeClientNotifications });
  clearClientMergers();
  for (const m of [bookingClientMerger, financeClientMerger, loyaltyClientMerger, certificatesClientMerger, eventsClientMerger, notificationsClientMerger]) registerClientMerger(m);
});
afterAll(async () => {
  clearClientAnonymizers();
  clearClientMergers();
  await pool.end();
  await db.drop();
});

describe('обезличивание второй карточки во время её слияния', () => {
  it('R6: обезличивание первым в очереди – проходит; слияние ждёт его и получает CLIENT_NOT_MERGEABLE; дедлока нет', async () => {
    const p = await addClient();
    const m = await addClient();
    await db.client.query(
      `INSERT INTO app.events (number, type_id, branch_id, title, planned_start, planned_end, status, customer_client_id, customer_name, customer_phone_e164, source, created_by_type)
       VALUES ('EV-R6', $1, $2, 'Праздник', '2026-10-01T10:00Z', '2026-10-01T13:00Z', 'completed', $3, 'Анна', '+79990001122', 'crm', 'system')`,
      [typeId, branchId, m],
    );
    const holder = await pool.connect(); // команда записи держит строку клиента
    try {
      await holder.query('BEGIN');
      await lockClients(holder, [m]);
      const anon = codeOf(withTx(pool, (tx) => anonymizeClient(tx, m, { reason: 'client_request' }, meta(), clock)));
      await waitForLockWaits(1);
      const merged = codeOf(withTx(pool, (tx) => mergeClients(tx, owner, { primaryId: p, secondaryId: m, reason: 'same_person_confirmed' }, meta(), undefined, clock)));
      await waitForLockWaits(2);
      await holder.query('COMMIT');
      expect(await anon).toBe('ok');
      expect(await merged).toBe('CLIENT_NOT_MERGEABLE');
    } finally {
      holder.release();
    }
    expect((await db.client.query('SELECT status FROM app.clients WHERE id = $1', [m])).rows[0].status).toBe('anonymized');
    expect((await db.client.query(`SELECT customer_name FROM app.events WHERE number = 'EV-R6'`)).rows[0].customer_name).toBe('Обезличено');
  });
});

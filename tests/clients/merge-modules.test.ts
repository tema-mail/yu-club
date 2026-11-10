// K9 «Слияние»: обработчики certificates и events на настоящих командах модулей (продажа сертификата, выдача подарка).
// Сертификаты: держатель → основная со строкой истории, остаток на счёте сертификата не меняется; у второй в ЛК пусто.
// Мероприятия: заказчик и именинник → основная; подарок – тоже; два подарка одного года – 409 CLIENT_MERGE_CONFLICT.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { certificatesClientMerger } from '../../apps/api/src/modules/certificates/merge.ts';
import { sellCertificate } from '../../apps/api/src/modules/certificates/sale.ts';
import { withTx } from '../../apps/api/src/modules/clients/index.ts';
import { clearClientMergers, mergeClients, registerClientMerger, REQUIRED_CLIENT_MERGERS } from '../../apps/api/src/modules/clients/merge.ts';
import { issueGift } from '../../apps/api/src/modules/events/gifts.ts';
import { eventsClientMerger } from '../../apps/api/src/modules/events/merge.ts';
import { createTestBranch } from '../helpers/network.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const PEPPER = 'cert-pepper-'.padEnd(40, 'z');
const clock = fixedClock('2026-11-20T07:00:00Z');
let db: TestDatabase;
let pool: pg.Pool;
let owner: AccessContext;
let branchId = '';
let typeId = '';
let seq = 79200000000;
const meta = (): AuditRequestMeta => ({ actor: owner.actor, access: owner, source: 'crm', requestId: randomUUID() });

const addClient = async () =>
  (await db.client.query<{ id: string }>(`INSERT INTO app.clients (phone_e164, first_name, status, registered_at, created_by_type) VALUES ($1, 'Т', 'active', now(), 'system') RETURNING id`, [`+${++seq}`])).rows[0]!.id;
const merge = (p: string, s: string) => withTx(pool, (tx) => mergeClients(tx, owner, { primaryId: p, secondaryId: s, reason: 'same_person_confirmed' }, meta(), undefined, clock));
const sell = (o: { buyerClientId?: string; recipientClientId?: string }) =>
  withTx(pool, (tx) => sellCertificate(tx, owner, { branchId, nominalKop: 300_000, method: 'cash', ...o }, meta(), { pepper: PEPPER, clock }));
const certBalance = async (id: string) =>
  Number((await db.client.query<{ b: string }>(`SELECT a.balance AS b FROM app.certificates c JOIN app.ledger_accounts a ON a.id = c.ledger_account_id WHERE c.id = $1`, [id])).rows[0]!.b);

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
  const s = await db.client.query<{ id: string }>(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', 'o@yu.test', 'owner', 'x') RETURNING id`);
  owner = { actor: { kind: 'staff', staffId: s.rows[0]!.id, sessionId: randomUUID() }, role: 'owner', network: true, cityIds: new Set(), branchIds: new Set(), at: clock.now() };
  branchId = (await createTestBranch(db.client)).id;
  typeId = (await db.client.query<{ id: string }>(`SELECT id FROM app.event_types WHERE code = 'birthday'`)).rows[0]!.id;
  clearClientMergers();
  registerClientMerger(certificatesClientMerger);
  registerClientMerger(eventsClientMerger);
  for (const name of REQUIRED_CLIENT_MERGERS) {
    if (name !== 'certificates' && name !== 'events') registerClientMerger({ name, preview: async () => ({}), reassign: async () => ({}) });
  }
});
afterAll(async () => {
  clearClientMergers();
  await pool.end();
  await db.drop();
});

describe('certificates', () => {
  it('получатель и купленный без получателя → основная, история держателя, остаток не меняется; у второй пусто', async () => {
    const a = await addClient();
    const b = await addClient();
    const c1 = await sell({ recipientClientId: b });
    const c2 = await sell({ buyerClientId: b });
    const c3 = await sell({ buyerClientId: b, recipientClientId: a }); // уже у основной – не трогается
    const before = await certificatesClientMerger.preview(pool, b, clock.now());
    expect(before).toEqual({ total: 2, active: 2, balanceKop: 600_000 });
    const balances = await Promise.all([c1, c2, c3].map((c) => certBalance(c.certificate.id)));

    const r = await merge(a, b);
    expect(r.results.certificates).toEqual({ certificates: 2 });
    expect(await certificatesClientMerger.preview(pool, b, clock.now())).toEqual({ total: 0, active: 0, balanceKop: 0 });
    expect(await certificatesClientMerger.preview(pool, a, clock.now())).toEqual({ total: 3, active: 3, balanceKop: 900_000 });
    expect(await Promise.all([c1, c2, c3].map((c) => certBalance(c.certificate.id)))).toEqual(balances);
    const hist = (await db.client.query(`SELECT certificate_id, old_client_id, new_client_id, changed_by FROM journal.certificate_holder_history WHERE new_client_id = $1 ORDER BY id`, [a])).rows;
    expect(hist).toEqual(expect.arrayContaining([
      { certificate_id: c1.certificate.id, old_client_id: b, new_client_id: a, changed_by: owner.actor.staffId },
      { certificate_id: c2.certificate.id, old_client_id: null, new_client_id: a, changed_by: owner.actor.staffId },
    ]));
    // покупатель – история продажи, остаётся
    expect((await db.client.query('SELECT buyer_client_id FROM app.certificates WHERE id = $1', [c2.certificate.id])).rows[0].buyer_client_id).toBe(b);
  });
});

describe('events', () => {
  async function addEvent(o: { customer?: string; birthday?: string }): Promise<string> {
    const r = await db.client.query<{ id: string }>(
      `INSERT INTO app.events (number, type_id, branch_id, title, planned_start, planned_end, status, customer_client_id, customer_name, customer_phone_e164, birthday_client_id, source, created_by_type)
       VALUES ($1, $2, $3, 'Праздник', '2026-12-01T10:00Z', '2026-12-01T13:00Z', 'confirmed', $4, 'Анна', '+79990001122', $5, 'crm', 'system') RETURNING id`,
      [`EV-M-${++seq}`, typeId, branchId, o.customer ?? null, o.birthday ?? null],
    );
    return r.rows[0]!.id;
  }
  const gift = (clientId: string) => withTx(pool, (tx) => issueGift(tx, owner, { clientId, branchId, reason: 'акция' }, meta(), clock));

  it('заказчик, именинник и подарок → основная; у второй пусто', async () => {
    const a = await addClient();
    const b = await addClient();
    const e1 = await addEvent({ customer: b });
    const e2 = await addEvent({ birthday: b });
    await gift(b);
    const r = await merge(a, b);
    expect(r.results.events).toEqual({ customer: 1, birthday: 1, gifts: 1 });
    expect(await eventsClientMerger.preview(pool, b, clock.now())).toEqual({ events: 0, live: 0, gifts: 0 });
    expect(await eventsClientMerger.preview(pool, a, clock.now())).toEqual({ events: 2, live: 2, gifts: 1 });
    const ev = (await db.client.query(`SELECT id, customer_client_id, birthday_client_id FROM app.events WHERE id = ANY($1::uuid[]) ORDER BY number`, [[e1, e2]])).rows;
    expect(ev.map((x) => [x.customer_client_id, x.birthday_client_id])).toEqual([[a, null], [null, a]]);
  });

  it('подарок у обеих в одном году – 409 CLIENT_MERGE_CONFLICT, ничего не изменилось', async () => {
    const a = await addClient();
    const b = await addClient();
    await gift(a);
    await gift(b);
    await expect(merge(a, b)).rejects.toMatchObject({ code: 'CLIENT_MERGE_CONFLICT', details: { module: 'events', constraint: 'birthday_gifts_one_per_year' } });
    expect((await db.client.query('SELECT status FROM app.clients WHERE id = $1', [b])).rows[0].status).toBe('active');
    expect((await db.client.query('SELECT count(*)::int AS n FROM app.birthday_gifts WHERE client_id = $1', [b])).rows[0].n).toBe(1);
  });
});

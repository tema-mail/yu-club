// K9 «Слияние» (03 §11.2, техдолг 5.15): процедура модуля clients на настоящей Postgres под yu_app.
// Обработчики других модулей здесь – заглушки с журналом вызовов; настоящие – tests/clients/merge-hooks.test.ts,
// баллы по правилу K15 – tests/loyalty/merge.test.ts. Проверяется своё: замки, статусы, поля основной, вторая карточка
// как при обезличивании (телефон свободен, сессии отозваны), журнал client_merges, аудит без ПДн, порядок вызовов.
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { errorStatus } from '../../apps/api/src/core/registry.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { getClientCard, withTx } from '../../apps/api/src/modules/clients/index.ts';
import {
  MERGE_REASONS,
  REQUIRED_CLIENT_MERGERS,
  clearClientMergers,
  mergeClients,
  mergePreview,
  registerClientMerger,
  type MergeReason,
} from '../../apps/api/src/modules/clients/merge.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const STAFF = 'cccccccc-0000-4000-8000-00000000000c';
const P256 = 'A'.repeat(87);
const AUTH = 'B'.repeat(22);
const clock = fixedClock('2026-11-20T07:00:00Z');
const owner: AccessContext = { actor: { kind: 'staff', staffId: STAFF, sessionId: STAFF }, role: 'owner', network: true, cityIds: new Set(), branchIds: new Set(), at: clock.now() };
const meta: AuditRequestMeta = { actor: owner.actor, access: owner, source: 'crm', requestId: 'req-merge' };

let db: TestDatabase;
let pool: pg.Pool;
let seq = 79170000000;
const calls: Array<{ name: string; kind: 'preview' | 'reassign'; from?: string; to?: string; clientId?: string }> = [];

function registerStubs(): void {
  clearClientMergers();
  for (const name of REQUIRED_CLIENT_MERGERS) {
    registerClientMerger({
      name,
      preview: async (_db, clientId) => {
        calls.push({ name, kind: 'preview', clientId });
        return { items: 1 };
      },
      reassign: async (_tx, from, to) => {
        calls.push({ name, kind: 'reassign', from, to });
        return { rows: 1 };
      },
    });
  }
}

interface Opts { status?: string; firstName?: string | null; lastName?: string | null; email?: string | null; birthDate?: string | null; registered?: boolean; statusReason?: string | null }
async function addClient(o: Opts = {}): Promise<{ id: string; phone: string }> {
  const phone = `+${++seq}`;
  const registered = o.registered ?? true;
  const r = await db.client.query<{ id: string }>(
    `INSERT INTO app.clients (phone_e164, phone_verified_at, first_name, last_name, email, birth_date, status, status_reason, registered_at, created_by_type)
     VALUES ($1, CASE WHEN $7 THEN now() END, $2, $3, $4, $5, $6, $8, CASE WHEN $7 THEN now() END, 'system') RETURNING id`,
    [phone, o.firstName === undefined ? 'Ольга' : o.firstName, o.lastName === undefined ? 'Смирнова' : o.lastName, o.email === undefined ? `o${seq}@yu.test` : o.email,
      o.birthDate ?? null, o.status ?? (registered ? 'active' : 'guest'), registered, o.statusReason ?? null],
  );
  const id = r.rows[0]!.id;
  const s = await db.client.query<{ id: string }>(`INSERT INTO app.client_sessions (client_id, token_hash, expires_at, user_agent) VALUES ($1, $2, '2027-01-01', 'Firefox/120') RETURNING id`, [id, `h${seq}`]);
  await db.client.query(`INSERT INTO app.push_subscriptions (client_id, session_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4, $5)`, [id, s.rows[0]!.id, `https://push.example/${seq}`, P256, AUTH]);
  await db.client.query(`INSERT INTO app.client_otp_challenges (phone_e164, code_hash, expires_at, max_attempts, ip) VALUES ($1, $2, now() + interval '5 min', 5, '10.0.0.1')`, [phone, 'a'.repeat(64)]);
  return { id, phone };
}

const merge = (primaryId: string, secondaryId: string, reason: string = 'same_person_confirmed') =>
  withTx(pool, (tx) => mergeClients(tx, owner, { primaryId, secondaryId, reason: reason as MergeReason }, meta, undefined, clock));
const preview = (primaryId: string, secondaryId: string) => mergePreview(pool, owner, { primaryId, secondaryId }, undefined, clock);

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
});
afterAll(async () => {
  clearClientMergers();
  await pool.end();
  await db.drop();
});
beforeEach(() => {
  calls.length = 0;
  registerStubs();
});

describe('mergePreview', () => {
  it('обе карточки, данные модулей и конфликтующие поля (03 §11.2)', async () => {
    const a = await addClient({ firstName: 'Ольга', email: 'olga@yu.test', birthDate: null });
    const b = await addClient({ firstName: 'Оля', email: 'olya@yu.test', birthDate: '1990-05-17' });
    const p = await preview(a.id, b.id);
    expect(p.primary).toMatchObject({ id: a.id, status: 'active' });
    expect(p.secondary).toMatchObject({ id: b.id, status: 'active' });
    expect(Object.keys(p.modules).sort()).toEqual([...REQUIRED_CLIENT_MERGERS].sort());
    expect(p.modules.booking).toEqual({ primary: { items: 1 }, secondary: { items: 1 } });
    // конфликт – оба значения есть и различаются; пустое у основной – не конфликт, а заполнение
    expect(p.conflicts).toEqual(
      expect.arrayContaining([
        { field: 'firstName', primary: 'Ольга', secondary: 'Оля' },
        { field: 'email', primary: 'olga@yu.test', secondary: 'olya@yu.test' },
        { field: 'phone', primary: '+7 ••• ••• ••-' + a.phone.slice(-2), secondary: '+7 ••• ••• ••-' + b.phone.slice(-2) },
      ]),
    );
    expect(p.conflicts.find((c) => c.field === 'birthDate')).toBeUndefined();
    expect(p.fills).toEqual([{ field: 'birthDate', value: '1990-05-17' }]);
    expect(p.canMerge).toBe(true);
    expect(calls.filter((c) => c.kind === 'preview')).toHaveLength(REQUIRED_CLIENT_MERGERS.length * 2);
  });

  it('те же карточки, merged, обезличенная – 409; чужой id – 404', async () => {
    const a = await addClient();
    const b = await addClient();
    await expect(preview(a.id, a.id)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(preview(a.id, '00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await merge(a.id, b.id);
    const c = await addClient();
    await expect(preview(c.id, b.id)).rejects.toMatchObject({ code: 'CLIENT_MERGED', details: { clientId: b.id, mergedIntoId: a.id } });
    await expect(preview(b.id, c.id)).rejects.toMatchObject({ code: 'CLIENT_MERGED' });
    const an = await addClient({ status: 'anonymized' });
    await db.client.query(`UPDATE app.clients SET phone_e164 = NULL WHERE id = $1`, [an.id]);
    await expect(preview(a.id, an.id)).rejects.toMatchObject({ code: 'CLIENT_NOT_MERGEABLE', details: { clientId: an.id, status: 'anonymized' } });
    expect(errorStatus.CLIENT_MERGED).toBe(409);
    expect(errorStatus.CLIENT_NOT_MERGEABLE).toBe(409);
    expect(errorStatus.CLIENT_MERGE_CONFLICT).toBe(409);
  });
});

describe('mergeClients', () => {
  it('основная заполняется из пустого, вторая – merged без ПДн, телефон свободен, сессии и подписки отозваны; журнал и аудит', async () => {
    const a = await addClient({ lastName: null, email: null, birthDate: null });
    const b = await addClient({ lastName: 'Петрова', email: 'b@yu.test', birthDate: '1991-01-02' });
    const res = await merge(a.id, b.id, 'duplicate_registration');
    expect(res).toMatchObject({ primaryId: a.id, secondaryId: b.id, status: 'merged', results: Object.fromEntries(REQUIRED_CLIENT_MERGERS.map((n) => [n, { rows: 1 }])) });
    expect(res.mergeId).toMatch(/^[0-9a-f-]{36}$/);

    const prim = (await db.client.query(`SELECT *, to_char(birth_date, 'YYYY-MM-DD') AS bd FROM app.clients WHERE id = $1`, [a.id])).rows[0];
    expect(prim).toMatchObject({ status: 'active', phone_e164: a.phone, first_name: 'Ольга', last_name: 'Петрова', email: 'b@yu.test', merged_into_id: null, row_version: 2, bd: '1991-01-02' });
    const sec = (await db.client.query('SELECT * FROM app.clients WHERE id = $1', [b.id])).rows[0];
    expect(sec).toMatchObject({ status: 'merged', merged_into_id: a.id, phone_e164: null, phone_verified_at: null, first_name: null, last_name: null, email: null, birth_date: null, row_version: 2 });
    // телефон второй свободен
    await db.client.query(`INSERT INTO app.clients (phone_e164, status, created_by_type) VALUES ($1, 'guest', 'system')`, [b.phone]);
    expect((await db.client.query('SELECT revoked_at, revoke_reason, user_agent FROM app.client_sessions WHERE client_id = $1', [b.id])).rows).toEqual([{ revoked_at: clock.now(), revoke_reason: 'blocked', user_agent: null }]);
    expect((await db.client.query('SELECT revoke_reason FROM app.push_subscriptions WHERE client_id = $1', [b.id])).rows).toEqual([{ revoke_reason: 'unsubscribed' }]);
    expect((await db.client.query('SELECT count(*)::int AS n FROM app.client_otp_challenges WHERE phone_e164 = $1', [b.phone])).rows[0].n).toBe(0);
    // сессии основной живы
    expect((await db.client.query('SELECT revoked_at FROM app.client_sessions WHERE client_id = $1', [a.id])).rows).toEqual([{ revoked_at: null }]);

    const j = (await db.client.query('SELECT * FROM journal.client_merges WHERE secondary_client_id = $1', [b.id])).rows;
    expect(j).toHaveLength(1);
    expect(j[0]).toMatchObject({ id: res.mergeId, primary_client_id: a.id, reason: 'duplicate_registration', staff_id: STAFF, merged_at: clock.now(), results: res.results });

    const audit = (await db.client.query(`SELECT action, object_id, before, after, reason FROM journal.audit_events WHERE object_type = 'client' AND object_id = ANY($1::text[]) ORDER BY id`, [[a.id, b.id]])).rows;
    expect(audit.map((x) => [x.action, x.object_id])).toEqual([['client.merged', a.id], ['client.status_changed', b.id]]);
    expect(audit[0]).toMatchObject({ after: { secondaryId: b.id, mergeId: res.mergeId, results: res.results, filled: ['lastName', 'email', 'birthDate'] }, reason: 'duplicate_registration' });
    expect(audit[1]).toMatchObject({ before: { status: 'active' }, after: { status: 'merged', mergedIntoId: a.id }, reason: 'duplicate_registration' });
    const text = JSON.stringify(audit);
    for (const pd of [a.phone, b.phone, 'Ольга', 'Петрова', 'b@yu.test', '1991']) expect(text).not.toContain(pd);

    // обработчики: в порядке обязательного списка, от второй к основной
    expect(calls.filter((c) => c.kind === 'reassign')).toEqual(REQUIRED_CLIENT_MERGERS.map((name) => ({ name, kind: 'reassign', from: b.id, to: a.id })));
    expect((await getClientCard(pool, owner, b.id)).mergedIntoId).toBe(a.id);
  });

  it('блокировка и ограничение второй карточки переходят на основную; причина статуса сохраняется', async () => {
    const a = await addClient();
    const b = await addClient({ status: 'blocked', statusReason: 'Нарушение правил' });
    await merge(a.id, b.id);
    expect((await db.client.query('SELECT status, status_reason FROM app.clients WHERE id = $1', [a.id])).rows[0]).toEqual({ status: 'blocked', status_reason: 'Нарушение правил' });
  });

  it('гость основной и зарегистрированная вторая – 409 (основной должна быть зарегистрированная); запрошено удаление – 409', async () => {
    const guest = await addClient({ registered: false });
    const reg = await addClient();
    await expect(merge(guest.id, reg.id)).rejects.toMatchObject({ code: 'CLIENT_NOT_MERGEABLE', details: { reason: 'primary_must_be_registered' } });
    expect((await preview(guest.id, reg.id)).canMerge).toBe(false);
    const del = await addClient({ status: 'deletion_requested' });
    await expect(merge(reg.id, del.id)).rejects.toMatchObject({ code: 'CLIENT_NOT_MERGEABLE', details: { status: 'deletion_requested' } });
    expect(calls.some((c) => c.kind === 'reassign')).toBe(false);
    expect((await db.client.query('SELECT status FROM app.clients WHERE id = $1', [reg.id])).rows[0].status).toBe('active');
  });

  it('гость во вторую – можно: основная остаётся зарегистрированной', async () => {
    const reg = await addClient();
    const guest = await addClient({ registered: false });
    await merge(reg.id, guest.id);
    expect((await db.client.query('SELECT status, phone_verified_at IS NOT NULL AS v FROM app.clients WHERE id = $1', [reg.id])).rows[0]).toEqual({ status: 'active', v: true });
  });

  it('merged второй раз – 409 CLIENT_MERGED; неверное основание – VALIDATION_FAILED; без обработчика – не запускается', async () => {
    const a = await addClient();
    const b = await addClient();
    await merge(a.id, b.id);
    const c = await addClient();
    await expect(merge(c.id, b.id)).rejects.toMatchObject({ code: 'CLIENT_MERGED' });
    await expect(merge(b.id, c.id)).rejects.toMatchObject({ code: 'CLIENT_MERGED' });
    await expect(merge(a.id, c.id, 'потому что')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(MERGE_REASONS).toEqual(['same_person_confirmed', 'duplicate_registration', 'phone_changed']);
    clearClientMergers();
    await expect(merge(a.id, c.id)).rejects.toThrow(/обработчик/);
    expect((await db.client.query('SELECT status FROM app.clients WHERE id = $1', [c.id])).rows[0].status).toBe('active');
  });

  it('ошибка обработчика откатывает всё: карточки целы', async () => {
    const a = await addClient();
    const b = await addClient();
    registerClientMerger({ name: 'events', preview: async () => ({}), reassign: async () => { throw new Error('events: не смог'); } });
    await expect(merge(a.id, b.id)).rejects.toThrow(/не смог/);
    expect((await db.client.query('SELECT status, phone_e164 FROM app.clients WHERE id = $1', [b.id])).rows[0]).toEqual({ status: 'active', phone_e164: b.phone });
    expect((await db.client.query('SELECT count(*)::int AS n FROM journal.client_merges WHERE secondary_client_id = $1', [b.id])).rows[0].n).toBe(0);
  });
});

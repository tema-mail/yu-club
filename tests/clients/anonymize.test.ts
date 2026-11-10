// K9 «Обезличивание» (152-ФЗ, 03 §13, техдолг 4.6): процедура модуля clients на настоящей Postgres под yu_app.
// Обработчики других модулей здесь – заглушки с журналом вызовов; настоящие (booking, events, notifications) –
// tests/clients/anonymize-hooks.test.ts.
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { errorStatus } from '../../apps/api/src/core/registry.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import {
  ANONYMIZE_REASONS,
  REQUIRED_CLIENT_ANONYMIZERS,
  anonymizeClient,
  clearClientAnonymizers,
  registerClientAnonymizer,
} from '../../apps/api/src/modules/clients/anonymize.ts';
import { withTx } from '../../apps/api/src/modules/clients/index.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const STAFF = 'cccccccc-0000-4000-8000-00000000000c';
const P256 = 'A'.repeat(87);
const AUTH = 'B'.repeat(22);

let db: TestDatabase;
let pool: pg.Pool;
const clock = fixedClock('2026-11-20T07:00:00Z');
const meta: AuditRequestMeta = {
  actor: { kind: 'staff', staffId: STAFF, sessionId: STAFF },
  access: { role: 'owner', network: true, cityIds: new Set(), branchIds: new Set() },
  source: 'crm',
  requestId: 'req-anonymize',
};

const calls: Array<{ name: string; kind: 'blockers' | 'run'; clientId: string }> = [];
let blockersOf: Record<string, number> = {};

function registerStubs(): void {
  clearClientAnonymizers();
  for (const name of REQUIRED_CLIENT_ANONYMIZERS) {
    registerClientAnonymizer({
      name,
      blockers: async (_tx, clientId) => {
        calls.push({ name, kind: 'blockers', clientId });
        return blockersOf[name] ?? 0;
      },
      run: async (_tx, clientId) => {
        calls.push({ name, kind: 'run', clientId });
        return 1;
      },
    });
  }
}

let phoneSeq = 79130000000;
async function addClient(): Promise<{ id: string; phone: string }> {
  const phone = `+${++phoneSeq}`;
  const r = await db.client.query<{ id: string }>(
    `INSERT INTO app.clients (phone_e164, phone_verified_at, first_name, last_name, email, birth_date, status, registered_at, created_by_type)
     VALUES ($1, now(), 'Ольга', 'Смирнова', $2, '1990-05-17', 'active', now(), 'system') RETURNING id`,
    [phone, `olga${phoneSeq}@yu.test`],
  );
  const id = r.rows[0]!.id;
  const s = await db.client.query<{ id: string }>(
    `INSERT INTO app.client_sessions (client_id, token_hash, expires_at, user_agent) VALUES ($1, $2, '2027-01-01', 'Firefox/120') RETURNING id`,
    [id, `h${phoneSeq}`],
  );
  await db.client.query(
    `INSERT INTO app.push_subscriptions (client_id, session_id, endpoint, p256dh, auth, user_agent) VALUES ($1, $2, $3, $4, $5, 'Firefox/120')`,
    [id, s.rows[0]!.id, `https://push.example/${phoneSeq}`, P256, AUTH],
  );
  await db.client.query(
    `INSERT INTO app.client_otp_challenges (phone_e164, code_hash, expires_at, max_attempts, ip) VALUES ($1, $2, now() + interval '5 min', 5, '10.0.0.1')`,
    [phone, 'a'.repeat(64)],
  );
  await db.client.query('INSERT INTO app.client_notification_prefs (client_id, reminders_enabled, marketing_enabled) VALUES ($1, true, true)', [id]);
  await db.client.query(
    `INSERT INTO journal.client_consents (client_id, kind, granted, document_version, source, actor_type, actor_id) VALUES ($1, 'marketing', true, 'v1', 'account', 'client', $1)`,
    [id],
  );
  return { id, phone };
}

const run = (clientId: string, reason: string = 'client_request') =>
  withTx(pool, (tx) => anonymizeClient(tx, clientId, { reason: reason as (typeof ANONYMIZE_REASONS)[number] }, meta, clock));

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
});
afterAll(async () => {
  clearClientAnonymizers();
  await pool.end();
  await db.drop();
});
beforeEach(() => {
  calls.length = 0;
  blockersOf = {};
  registerStubs();
});

describe('anonymizeClient', () => {
  it('затирает ПДн карточки, ставит anonymized, гасит сессии, подписки, коды входа, рекламу; связь по id остаётся', async () => {
    const c = await addClient();
    const res = await run(c.id);
    expect(res).toEqual({
      clientId: c.id,
      status: 'anonymized',
      alreadyAnonymized: false,
      affected: Object.fromEntries(REQUIRED_CLIENT_ANONYMIZERS.map((n) => [n, 1])),
    });

    const row = (await db.client.query('SELECT * FROM app.clients WHERE id = $1', [c.id])).rows[0];
    expect(row).toMatchObject({
      status: 'anonymized',
      phone_e164: null,
      phone_verified_at: null,
      first_name: null,
      last_name: null,
      email: null,
      birth_date: null,
      status_reason: null,
      status_until: null,
      row_version: 2,
    });

    const sessions = (await db.client.query('SELECT revoked_at, revoke_reason, user_agent FROM app.client_sessions WHERE client_id = $1', [c.id])).rows;
    expect(sessions).toEqual([{ revoked_at: clock.now(), revoke_reason: 'blocked', user_agent: null }]);

    const subs = (await db.client.query('SELECT id, endpoint, revoked_at, revoke_reason, user_agent FROM app.push_subscriptions WHERE client_id = $1', [c.id])).rows;
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ endpoint: `https://anonymized.invalid/${subs[0].id}`, revoked_at: clock.now(), revoke_reason: 'unsubscribed', user_agent: null });

    expect((await db.client.query('SELECT count(*)::int AS n FROM app.client_otp_challenges WHERE phone_e164 = $1', [c.phone])).rows[0].n).toBe(0);

    expect((await db.client.query('SELECT reminders_enabled, marketing_enabled FROM app.client_notification_prefs WHERE client_id = $1', [c.id])).rows).toEqual([
      { reminders_enabled: false, marketing_enabled: false },
    ]);
    const consents = (await db.client.query(`SELECT kind, granted, source FROM journal.client_consents WHERE client_id = $1 AND NOT granted ORDER BY kind`, [c.id])).rows;
    expect(consents).toEqual([
      { kind: 'marketing', granted: false, source: 'crm' },
      { kind: 'pd_processing', granted: false, source: 'crm' },
      { kind: 'reminders', granted: false, source: 'crm' },
    ]);

    // обработчики модулей вызваны в той же транзакции: сначала проверки, затем затирание
    expect(calls.filter((x) => x.kind === 'run').map((x) => x.name).sort()).toEqual([...REQUIRED_CLIENT_ANONYMIZERS].sort());
  });

  it('аудит: client.status_changed без ПДн (ни телефона, ни имени, ни почты), причина – код', async () => {
    const c = await addClient();
    await run(c.id, 'retention_expired');
    const a = (
      await db.client.query(
        `SELECT action, before, after, reason FROM journal.audit_events WHERE object_type = 'client' AND object_id = $1 AND action = 'client.status_changed'`,
        [c.id],
      )
    ).rows;
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ before: { status: 'active' }, after: { status: 'anonymized' }, reason: 'retention_expired' });
    const text = JSON.stringify(a[0]);
    for (const pd of [c.phone, c.phone.slice(-4), 'Ольга', 'Смирнова', 'olga', '1990']) expect(text).not.toContain(pd);
  });

  it('повторный вызов идемпотентен: 200 alreadyAnonymized, без второй записи аудита и без вызова обработчиков', async () => {
    const c = await addClient();
    await run(c.id);
    calls.length = 0;
    const again = await run(c.id);
    expect(again).toEqual({ clientId: c.id, status: 'anonymized', alreadyAnonymized: true, affected: {} });
    expect(calls).toEqual([]);
    const n = (await db.client.query(`SELECT count(*)::int AS n FROM journal.audit_events WHERE object_id = $1 AND action = 'client.status_changed'`, [c.id])).rows[0].n;
    expect(n).toBe(1);
    expect((await db.client.query('SELECT row_version FROM app.clients WHERE id = $1', [c.id])).rows[0].row_version).toBe(2);
  });

  it('живые записи мешают: 409 CLIENT_HAS_ACTIVE_RECORDS, ничего не изменено', async () => {
    const c = await addClient();
    blockersOf = { booking: 2 };
    await expect(run(c.id)).rejects.toMatchObject({ code: 'CLIENT_HAS_ACTIVE_RECORDS', httpStatus: 409, details: { blockers: { booking: 2 } } });
    expect(errorStatus.CLIENT_HAS_ACTIVE_RECORDS).toBe(409);
    const row = (await db.client.query('SELECT status, first_name FROM app.clients WHERE id = $1', [c.id])).rows[0];
    expect(row).toEqual({ status: 'active', first_name: 'Ольга' });
    expect(calls.some((x) => x.kind === 'run')).toBe(false);
  });

  it('неизвестный клиент и мусорный id – NOT_FOUND; неверная причина – VALIDATION_FAILED', async () => {
    await expect(run('00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(run('не-uuid')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const c = await addClient();
    await expect(run(c.id, 'потому что')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('без обязательного обработчика модуля процедура не запускается (лучше 500, чем ПДн, оставшиеся в чужих таблицах)', async () => {
    const c = await addClient();
    clearClientAnonymizers();
    await expect(run(c.id)).rejects.toThrow(/обработчик/);
    expect((await db.client.query('SELECT status FROM app.clients WHERE id = $1', [c.id])).rows[0].status).toBe('active');
  });

  it('гостевая карточка тоже обезличивается; телефон снова свободен для новой карточки', async () => {
    const phone = `+${++phoneSeq}`;
    const id = (
      await db.client.query<{ id: string }>(`INSERT INTO app.clients (phone_e164, first_name, status, created_by_type) VALUES ($1, 'Гость', 'guest', 'system') RETURNING id`, [phone])
    ).rows[0]!.id;
    await run(id);
    await db.client.query(`INSERT INTO app.clients (phone_e164, status, created_by_type) VALUES ($1, 'guest', 'system')`, [phone]);
    expect((await db.client.query('SELECT count(*)::int AS n FROM app.clients WHERE phone_e164 = $1', [phone])).rows[0].n).toBe(1);
  });

  it('объединённая карточка (merged) – 409 CLIENT_MERGED, а не нарушение CHECK; ничего не изменено', async () => {
    const primary = await addClient();
    const c = await addClient();
    await db.client.query(
      `UPDATE app.clients SET phone_e164 = NULL, first_name = NULL, last_name = NULL, email = NULL, status = 'merged', merged_into_id = $2 WHERE id = $1`,
      [c.id, primary.id],
    );
    await expect(run(c.id)).rejects.toMatchObject({ code: 'CLIENT_MERGED', httpStatus: 409, details: { clientId: c.id, mergedIntoId: primary.id } });
    expect((await db.client.query('SELECT status, merged_into_id FROM app.clients WHERE id = $1', [c.id])).rows[0]).toEqual({ status: 'merged', merged_into_id: primary.id });
    expect(calls).toEqual([]);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateDown, migrateUp } from '../../db/migrate.ts';
import {
  diffFields,
  redact,
  writeAudit,
  writeDenied,
  type AuditRequestMeta,
  type Db,
} from '../../apps/api/src/core/audit.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const STAFF_ID = '11111111-1111-4111-8111-111111111111';
const BRANCH_ID = '22222222-2222-4222-8222-222222222222';
const clock = fixedClock('2026-11-15T07:00:00Z');

const staffMeta: AuditRequestMeta = {
  actor: { kind: 'staff', staffId: STAFF_ID, sessionId: 's1' },
  access: { role: 'director', network: false, cityIds: new Set(), branchIds: new Set([BRANCH_ID]) },
  source: 'crm',
  requestId: 'req-1',
  ip: '10.0.0.1',
};

describe('redact (K2 правило 2)', () => {
  it('секреты на любой глубине → ***, code не трогается', () => {
    expect(redact({ password: 'x', otpCode: '1234', nested: { token: 't' } })).toEqual({
      password: '***',
      otpCode: '***',
      nested: { token: '***' },
    });
    expect(redact({ code: 'NSK-1' })).toEqual({ code: 'NSK-1' });
  });

  it('регистр и snake_case не обходят список', () => {
    expect(redact({ PASSWORD: 'x', password_hash: 'h', TotpSecret: 's', list: [{ api_key: 'k' }] })).toEqual({
      PASSWORD: '***',
      password_hash: '***',
      TotpSecret: '***',
      list: [{ api_key: '***' }],
    });
  });

  it('ПДн: имя поля остаётся, значение – маска по типу', () => {
    expect(
      redact({
        phoneE164: '+79991234567',
        phone_e164: '+79991234567',
        email: 'ivan@mail.ru',
        firstName: 'Иван',
        last_name: 'Петров',
        birthDate: '2001-02-03',
        guestPhone: null,
        name: 'Филиал на Ленина',
      }),
    ).toEqual({
      phoneE164: '+7******4567',
      phone_e164: '+7******4567',
      email: 'i***@mail.ru',
      firstName: 'И***',
      last_name: 'П***',
      birthDate: '****-**-**',
      guestPhone: null,
      name: 'Филиал на Ленина',
    });
  });

  it('нестроковое значение ПДн и короткий телефон – полная маска', () => {
    expect(redact({ phone: 79991234567, guestPhone: '+7123', email: 'bad' })).toEqual({
      phone: '***',
      guestPhone: '***',
      email: '***',
    });
  });

  it('diffFields оставляет только изменённое', () => {
    expect(diffFields({ a: 1, b: 2, c: null }, { a: 1, b: 3, d: 'x' })).toEqual({
      before: { b: 2, d: null },
      after: { b: 3, d: 'x' },
    });
  });
});

describe('journal.audit_events', () => {
  let db: TestDatabase;

  async function asApp<T>(fn: () => Promise<T>): Promise<T> {
    await db.client.query('SET ROLE yu_app');
    try {
      return await fn();
    } finally {
      await db.client.query('RESET ROLE');
    }
  }

  beforeAll(async () => {
    db = await createTestDatabase({ migrate: true });
  });
  afterAll(async () => {
    await db.drop();
  });

  it('миграции вниз до нуля и снова вверх', async () => {
    const applied = await db.client.query<{ version: string }>('SELECT version FROM public.schema_migrations');
    await migrateDown(db.client, applied.rowCount!);
    expect(await db.client.query("SELECT to_regclass('journal.audit_events') AS t")).toMatchObject({
      rows: [{ t: null }],
    });
    await migrateUp(db.client);
    const again = await db.client.query("SELECT to_regclass('journal.audit_events')::text AS t");
    expect(again.rows[0].t).toBe('journal.audit_events');
  });

  it('у yu_app нет UPDATE/DELETE/TRUNCATE', async () => {
    const v = await db.client.query('SELECT * FROM journal.append_only_violations()');
    expect(v.rows).toEqual([]);
  });

  it('yu_app пишет аудит, но UPDATE и DELETE падают с 42501', async () => {
    await asApp(() =>
      writeAudit(
        db.client,
        staffMeta,
        { action: 'branch.updated', object: { type: 'branch', id: BRANCH_ID }, branchId: BRANCH_ID, after: { name: 'Б' } },
        clock,
      ),
    );
    await expect(asApp(() => db.client.query("UPDATE journal.audit_events SET reason = 'x'"))).rejects.toMatchObject({
      code: '42501',
    });
    await expect(asApp(() => db.client.query('DELETE FROM journal.audit_events'))).rejects.toMatchObject({
      code: '42501',
    });
    await expect(asApp(() => db.client.query('TRUNCATE journal.audit_events'))).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('пишет актора, роль, снимок зоны и маскированные before/after', async () => {
    await writeAudit(
      db.client,
      staffMeta,
      {
        action: 'staff.contacts_changed',
        object: { type: 'staff', id: STAFF_ID },
        branchId: BRANCH_ID,
        before: { phoneE164: '+79991234567', password: 'Секрет-123456' },
        after: { phoneE164: '+79990000001', passwordHash: '$argon2id$...' },
        reason: 'смена номера',
      },
      clock,
    );
    const r = await db.client.query(
      `SELECT occurred_at, actor_type, actor_id, actor_role, actor_scope, before, after, result, source, request_id, host(ip) AS ip,
              before::text || after::text AS raw
       FROM journal.audit_events WHERE action = 'staff.contacts_changed'`,
    );
    const row = r.rows[0];
    expect(row).toMatchObject({
      actor_type: 'staff',
      actor_id: STAFF_ID,
      actor_role: 'director',
      actor_scope: { cityIds: [], branchIds: [BRANCH_ID] },
      before: { phoneE164: '+7******4567', password: '***' },
      after: { phoneE164: '+7******0001', passwordHash: '***' },
      result: 'success',
      source: 'crm',
      request_id: 'req-1',
      ip: '10.0.0.1',
    });
    expect(row.occurred_at.toISOString()).toBe('2026-11-15T07:00:00.000Z');
    expect(row.raw).not.toContain('Секрет');
    expect(row.raw).not.toContain('argon2');
  });

  it('аудит – часть транзакции: откат команды убирает запись', async () => {
    await db.client.query('BEGIN');
    await writeAudit(db.client, staffMeta, { action: 'city.created', object: { type: 'city', id: 'c-rollback' } }, clock);
    await db.client.query('ROLLBACK');
    const r = await db.client.query("SELECT count(*)::int AS n FROM journal.audit_events WHERE object_id = 'c-rollback'");
    expect(r.rows[0].n).toBe(0);
  });

  it('посетитель → anonymous, система → system, роль пустая', async () => {
    await writeAudit(
      db.client,
      { actor: { kind: 'visitor', visitorId: 'v1' }, source: 'site', requestId: 'r2' },
      { action: 'hold.expired', object: { type: 'hold', id: 'h1' } },
      clock,
    );
    await writeAudit(
      db.client,
      { actor: { kind: 'system', process: 'hold-expiry' }, source: 'system', requestId: 'r3' },
      { action: 'hold.expired', object: { type: 'hold', id: 'h2' } },
      clock,
    );
    const r = await db.client.query(
      "SELECT object_id, actor_type, actor_id, actor_role FROM journal.audit_events WHERE action = 'hold.expired' ORDER BY id",
    );
    expect(r.rows).toEqual([
      { object_id: 'h1', actor_type: 'anonymous', actor_id: null, actor_role: null },
      { object_id: 'h2', actor_type: 'system', actor_id: null, actor_role: null },
    ]);
  });

  it('код действия не по реестру и неизвестный тип объекта – ошибка', async () => {
    await expect(
      writeAudit(db.client, staffMeta, { action: 'Bad Code.x' as 'a.b', object: { type: 'branch', id: null } }),
    ).rejects.toThrow(/формату/);
    await expect(
      writeAudit(db.client, staffMeta, { action: 'x.y', object: { type: 'nope' as 'branch', id: null } }),
    ).rejects.toThrow(/тип объекта/);
  });

  it('writeDenied пишет отказ без before/after и не бросает при сбое', async () => {
    await writeDenied(
      db.client,
      staffMeta,
      { action: 'branch.updated', object: { type: 'branch', id: 'denied-1' }, result: 'denied' },
      clock,
    );
    const r = await db.client.query(
      "SELECT result, before, after FROM journal.audit_events WHERE object_id = 'denied-1'",
    );
    expect(r.rows).toEqual([{ result: 'denied', before: null, after: null }]);

    const broken: Db = { query: () => Promise.reject(new Error('нет связи')) };
    const logged: unknown[] = [];
    await expect(
      writeDenied(
        broken,
        staffMeta,
        { action: 'branch.updated', object: { type: 'branch', id: 'x' }, result: 'denied' },
        clock,
        (e) => logged.push(e),
      ),
    ).resolves.toBeUndefined();
    expect(logged).toHaveLength(1);
  });
});

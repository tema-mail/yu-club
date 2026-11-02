// S2-50: миграция 0204, номер и код, expiryOf, продажа одной проводкой с поступлением в кассу (K16 §1–§4, TC-08 продажа).
// Продажа – одна операция кассы K17 в филиале продажи; код не попадает в аудит, операции кассы и idempotency_keys;
// повтор продажи по ключу – тот же сертификат без кода; у yu_app нет UPDATE номинала (42501); вверх/вниз/вверх.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { AppError } from '../../apps/api/src/core/errors.ts';
import { runIdempotent } from '../../apps/api/src/core/idempotency.ts';
import { verifyBalance } from '../../apps/api/src/core/ledger.ts';
import type { AccessContext, StaffRole } from '../../apps/api/src/core/permissions.ts';
import { fixedClock, type TimeZone } from '../../apps/api/src/core/time.ts';
import {
  expiryOf,
  generateNumber,
  getCertificate,
  normalizeNumber,
  pinDigest,
  pinHashOf,
  redactSaleResponse,
  sellCertificate,
  type CertificateDto,
} from '../../apps/api/src/modules/certificates/sale.ts';
import { migrateDown, migrateUp } from '../../db/migrate.ts';
import { createTestBranch } from '../helpers/network.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

process.env.TZ = 'America/New_York'; // чужая зона машины: срок считается по зоне филиала продажи

const PEPPER = 'cert-pepper-'.padEnd(40, 'x');
const NSK = 'Asia/Novosibirsk' as TimeZone;
const clock = fixedClock('2026-11-14T05:00:00Z');
let db: TestDatabase;
let pool: pg.Pool;
let ownerId: string;

async function staff(role: StaffRole): Promise<string> {
  const r = await db.client.query<{ id: string }>(
    `INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', $1, $2, 'x') RETURNING id`,
    [`${randomUUID()}@club.ru`, role],
  );
  return r.rows[0]!.id;
}
function ctx(role: StaffRole, staffId: string, branchIds: string[] = []): AccessContext {
  return {
    actor: { kind: 'staff', staffId, sessionId: randomUUID() },
    role,
    network: role === 'owner',
    cityIds: new Set(),
    branchIds: new Set(branchIds),
    at: clock.now(),
  };
}
const meta = (c: AccessContext): AuditRequestMeta => ({ actor: c.actor, access: c, source: 'crm', requestId: randomUUID() });

async function tx<T>(fn: (t: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}
async function fails(p: Promise<unknown>, code: string): Promise<AppError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
  return err as AppError;
}
const pgCode = (p: Promise<unknown>) => p.then(() => 'ok', (err: { code?: string }) => err.code ?? String(err));
const sell = (who: AccessContext, input: Record<string, unknown>) =>
  tx((t) => sellCertificate(t, who, { method: 'cash', nominalKop: 500_000, ...input } as Parameters<typeof sellCertificate>[2], meta(who), { pepper: PEPPER, clock }));

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
  ownerId = await staff('owner');
});
afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('expiryOf (K16 §4, Q-27)', () => {
  const at = (local: string) => new Date(`${local}+07:00`); // Новосибирск, UTC+7
  it('6 календарных месяцев; дня нет – последний день месяца', () => {
    expect(expiryOf(at('2026-08-31T12:00:00'), NSK).expiresOn).toBe('2027-02-28');
    expect(expiryOf(at('2027-08-31T12:00:00'), NSK).expiresOn).toBe('2028-02-29');
    expect(expiryOf(at('2026-03-31T12:00:00'), NSK).expiresOn).toBe('2026-09-30');
    expect(expiryOf(at('2026-01-15T12:00:00'), NSK).expiresOn).toBe('2026-07-15');
    expect(expiryOf(at('2026-09-30T12:00:00'), NSK).expiresOn).toBe('2027-03-30');
  });
  it('дата продажи и граница – по зоне филиала: 23:30 31.08 и 00:30 01.09 по Новосибирску', () => {
    const late = expiryOf(at('2026-08-31T23:30:00'), NSK);
    expect(late.expiresOn).toBe('2027-02-28');
    expect(late.expiresAt.toISOString()).toBe('2027-02-28T17:00:00.000Z'); // 00:00 01.03 по Новосибирску
    expect(expiryOf(at('2026-09-01T00:30:00'), NSK).expiresOn).toBe('2027-03-01');
    expect(expiryOf(new Date('2026-08-31T16:30:00Z'), 'Europe/Moscow' as TimeZone).expiresOn).toBe('2027-02-28');
  });
});

describe('номер и код (K16 §3)', () => {
  it('номер – YC- и 8 символов Crockford; нормализация ввода', () => {
    for (let i = 0; i < 200; i++) expect(generateNumber()).toMatch(/^YC-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(normalizeNumber('yc 7k2m 9qxd')).toBe('YC-7K2M-9QXD');
    expect(normalizeNumber('7K2M-9QXO')).toBe('YC-7K2M-9QX0');
  });
});

describe('продажа (K16 §2, TC-08)', () => {
  it('одна операция кассы +номинал в филиале продажи, тот же posting – certificate.issue; остаток = номинал', async () => {
    const b = await createTestBranch(db.client);
    const owner = ctx('owner', ownerId);
    const { certificate, pin } = await sell(owner, { branchId: b.id, nominalKop: 500_000, method: 'card', comment: 'подарок' });
    expect(pin).toMatch(/^\d{4}$/);
    expect(certificate).toMatchObject({
      nominalKop: 500_000,
      balanceKop: 500_000,
      saleBranchId: b.id,
      saleMethod: 'card',
      soldBy: ownerId,
      status: 'active',
      comment: 'подарок',
      expiresOn: '2027-05-14',
      expiresAt: '2027-05-14T17:00:00.000Z',
    });
    const ops = await db.client.query(`SELECT kind, place, method, direction, amount_kop, source, ref_type, ref_id, posting_id FROM journal.finance_operations WHERE branch_id = $1`, [b.id]);
    expect(ops.rows).toHaveLength(1);
    expect(ops.rows[0]).toMatchObject({ kind: 'income', place: 'noncash', method: 'card', direction: 'in', amount_kop: '500000', source: 'certificate_sale', ref_type: 'certificate', ref_id: certificate.id });
    const entries = await db.client.query<{ kind: string; entry_type: string; amount: string }>(
      `SELECT la.kind, le.entry_type, le.amount FROM journal.ledger_entries le JOIN app.ledger_accounts la ON la.id = le.account_id WHERE le.posting_id = $1 ORDER BY le.id`,
      [ops.rows[0].posting_id],
    );
    expect(entries.rows).toEqual([
      { kind: 'cash_branch_noncash', entry_type: 'cash.income', amount: '500000' },
      { kind: 'certificate', entry_type: 'certificate.issue', amount: '500000' },
    ]);
    const acc = await db.client.query<{ id: string; min_balance: string; branch_id: string }>(
      `SELECT la.id, la.min_balance, la.branch_id FROM app.certificates c JOIN app.ledger_accounts la ON la.id = c.ledger_account_id WHERE c.id = $1`,
      [certificate.id],
    );
    expect(acc.rows[0]).toMatchObject({ min_balance: '0', branch_id: b.id });
    expect((await verifyBalance(db.client, acc.rows[0]!.id)).ok).toBe(true);
    const stored = await db.client.query(`SELECT pin_hash FROM app.certificates WHERE id = $1`, [certificate.id]);
    expect(stored.rows[0].pin_hash).toBe(pinHashOf(PEPPER, certificate.id, pin));
    expect(stored.rows[0].pin_hash).not.toBe(pinDigest(PEPPER, pin)); // хэш привязан к сертификату
    expect(pinHashOf(PEPPER, randomUUID(), pin)).not.toBe(stored.rows[0].pin_hash);
  });

  it('наличные – место cash; Директор своей зоны продаёт; покупатель и получатель', async () => {
    const b = await createTestBranch(db.client);
    const client = await db.client.query<{ id: string }>(`INSERT INTO app.clients (phone_e164, status, created_by_type) VALUES ('+7999' || lpad((random()*1e7)::int::text, 7, '0'), 'active', 'system') RETURNING id`);
    const director = ctx('director', await staff('director'), [b.id]);
    const { certificate } = await sell(director, { branchId: b.id, nominalKop: 100_000, recipientClientId: client.rows[0]!.id });
    expect(certificate.recipientClientId).toBe(client.rows[0]!.id);
    const bal = await db.client.query(`SELECT balance FROM app.ledger_accounts WHERE owner_id = $1 AND kind = 'cash_branch'`, [b.id]);
    expect(bal.rows[0].balance).toBe('100000');
    await fails(sell(director, { branchId: b.id, buyerClientId: randomUUID() }), 'VALIDATION_FAILED');
  });

  it('права: Администратор – FORBIDDEN (08 §4.1), Директор чужого филиала – NOT_FOUND; номинал и способ по настройкам', async () => {
    const b = await createTestBranch(db.client);
    const other = await createTestBranch(db.client);
    await fails(sell(ctx('admin', await staff('admin'), [b.id]), { branchId: b.id }), 'FORBIDDEN');
    await fails(sell(ctx('director', await staff('director'), [other.id]), { branchId: b.id }), 'NOT_FOUND');
    const owner = ctx('owner', ownerId);
    await fails(sell(owner, { branchId: b.id, nominalKop: 0 }), 'NOMINAL_OUT_OF_RANGE');
    await fails(sell(owner, { branchId: b.id, nominalKop: 10.5 }), 'NOMINAL_OUT_OF_RANGE');
    await db.client.query(
      `INSERT INTO app.settings_values (key, level, value, valid_from, created_by) VALUES ('certificate.nominal_max_kop', 'network', '300000', '2026-01-01', $1),
         ('certificate.sale_methods', 'network', '["cash","card"]', '2026-01-01', $1)`,
      [ownerId],
    );
    try {
      await fails(sell(owner, { branchId: b.id, nominalKop: 300_001 }), 'NOMINAL_OUT_OF_RANGE');
      await fails(sell(owner, { branchId: b.id, nominalKop: 300_000, method: 'transfer' }), 'VALIDATION_FAILED');
      await sell(owner, { branchId: b.id, nominalKop: 300_000 });
    } finally {
      await db.client.query(`DELETE FROM app.settings_values WHERE key IN ('certificate.nominal_max_kop', 'certificate.sale_methods')`);
    }
    const n = await db.client.query(`SELECT count(*)::int AS n FROM app.certificates WHERE sale_branch_id = $1`, [b.id]);
    expect(n.rows[0].n).toBe(1); // отказы ничего не оставили
  });

  it('код не попал в аудит, операции кассы и idempotency_keys; повтор по ключу – тот же сертификат без кода', async () => {
    const b = await createTestBranch(db.client);
    const owner = ctx('owner', ownerId);
    const key = randomUUID();
    const body = { nominalKop: 250_000, method: 'cash' as const };
    const run = () =>
      tx((t) =>
        runIdempotent(
          t,
          { scope: `staff:${ownerId}:certificate.sell`, key, request: { route: 'POST /branches/:branchId/certificates', params: { branchId: b.id }, body }, clock, redact: redactSaleResponse },
          async () => ({ status: 201, body: await sellCertificate(t, owner, { branchId: b.id, ...body }, meta(owner), { pepper: PEPPER, clock }) }),
        ),
      );
    const first = await run();
    const again = await run();
    const firstBody = first.body as { certificate: CertificateDto; pin: string };
    expect(firstBody.pin).toMatch(/^\d{4}$/);
    expect(again.replayed).toBe(true);
    expect(again.body).toEqual({ certificate: firstBody.certificate, pin: null, pinShownOnce: true });
    const count = await db.client.query(`SELECT count(*)::int AS n FROM app.certificates WHERE sale_branch_id = $1`, [b.id]);
    expect(count.rows[0].n).toBe(1);

    const hash = pinHashOf(PEPPER, firstBody.certificate.id, firstBody.pin); // как в базе
    const reqHash = pinDigest(PEPPER, firstBody.pin); // как в request_hash
    const pinRe = new RegExp(`"pin(_?hash)?"\\s*:\\s*"(${firstBody.pin}|${hash}|${reqHash})"`, 'i');
    const audit = await db.client.query<{ action: string; t: string }>(`SELECT action, row_to_json(a)::text AS t FROM journal.audit_events a WHERE branch_id = $1`, [b.id]);
    expect(audit.rows.map((r) => r.action).sort()).toEqual(['certificate.sold', 'finance.operation.created']);
    for (const r of audit.rows) {
      expect(r.t).not.toContain(hash);
      expect(r.t).not.toContain(reqHash);
      expect(r.t).not.toMatch(pinRe);
    }
    const keys = await db.client.query<{ t: string }>(`SELECT row_to_json(k)::text AS t FROM app.idempotency_keys k WHERE key = $1`, [key]);
    expect(keys.rows).toHaveLength(1);
    expect(keys.rows[0]!.t).not.toContain(hash);
    expect(keys.rows[0]!.t).not.toContain(reqHash);
    expect(keys.rows[0]!.t).not.toMatch(pinRe);
    const ops = await db.client.query<{ t: string }>(`SELECT row_to_json(o)::text AS t FROM journal.finance_operations o WHERE branch_id = $1`, [b.id]);
    expect(ops.rows[0]!.t).not.toContain(hash);
  });

  it('статус вычисляется: после expiresAt – expired, без прохода задачи', async () => {
    const b = await createTestBranch(db.client);
    const { certificate } = await sell(ctx('owner', ownerId), { branchId: b.id });
    expect((await getCertificate(db.client, certificate.id, fixedClock(new Date(new Date(certificate.expiresAt).getTime() - 1))))!.status).toBe('active');
    expect((await getCertificate(db.client, certificate.id, fixedClock(certificate.expiresAt)))!.status).toBe('expired');
  });
});

describe('0204: права yu_app и вверх/вниз/вверх', () => {
  it('UPDATE nominal_kop, number, expires_at → 42501; DELETE → 42501; comment и recipient – можно', async () => {
    const b = await createTestBranch(db.client);
    const { certificate } = await sell(ctx('owner', ownerId), { branchId: b.id });
    const asApp = (sql: string) => tx((t) => t.query(sql, [certificate.id]));
    expect(await pgCode(asApp(`UPDATE app.certificates SET nominal_kop = 1 WHERE id = $1`))).toBe('42501');
    expect(await pgCode(asApp(`UPDATE app.certificates SET number = 'YC-0000-0000' WHERE id = $1`))).toBe('42501');
    expect(await pgCode(asApp(`UPDATE app.certificates SET expires_at = now() WHERE id = $1`))).toBe('42501');
    expect(await pgCode(asApp(`DELETE FROM app.certificates WHERE id = $1`))).toBe('42501');
    expect(await pgCode(asApp(`UPDATE app.certificates SET comment = 'x', row_version = row_version + 1 WHERE id = $1`))).toBe('ok');
    expect(await pgCode(asApp(`DELETE FROM app.certificate_redemptions WHERE certificate_id = $1`))).toBe('42501');
    const v = await db.client.query(`SELECT * FROM journal.append_only_violations()`);
    expect(v.rows).toEqual([]);
  });

  it('на чистой базе: вниз убирает таблицы 0204, вверх возвращает', async () => {
    const clean = await createTestDatabase({ migrate: true });
    try {
      const later = await clean.client.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.schema_migrations WHERE version >= '0204'`);
      const down = await migrateDown(clean.client, later.rows[0]!.n);
      expect(down.at(-1)).toBe('0204');
      const t = await clean.client.query(
        `SELECT to_regclass('app.certificates') AS c, to_regclass('app.certificate_redemptions') AS r, to_regclass('journal.certificate_holder_history') AS h`,
      );
      expect(t.rows).toEqual([{ c: null, r: null, h: null }]);
      expect(await migrateUp(clean.client)).toEqual([...down].reverse());
      expect((await clean.client.query(`SELECT to_regclass('app.certificates')::text AS c`)).rows[0].c).toBe('app.certificates');
    } finally {
      await clean.drop();
    }
  });
});

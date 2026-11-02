// S2-16a: миграция 0206 и правило смены в кассе (K17 §7 п.1–2): флаг false – смены нет, операции идут;
// true – операции, задевающие наличные, без открытой смены → CASH_SHIFT_REQUIRED, со сменой – пишут shift_id;
// вторая открытая смена филиала невозможна (cash_shifts_one_open); вверх/вниз/вверх.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { recordExpense, recordIncome, transferBetweenPlaces } from '../../apps/api/src/modules/finance/cashbox.ts';
import { reverseOperation } from '../../apps/api/src/modules/finance/corrections.ts';
import { migrateDown, migrateUp } from '../../db/migrate.ts';
import { createTestBranch } from '../helpers/network.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

let db: TestDatabase;
let pool: pg.Pool;
const clock = fixedClock('2026-11-14T05:00:00Z');
const AT = '2026-11-14T04:00:00Z';
let staffId: string;
const owner: AccessContext = { actor: { kind: 'staff', staffId: randomUUID(), sessionId: randomUUID() }, role: 'owner', network: true, cityIds: new Set(), branchIds: new Set(), at: clock.now() };
const meta: AuditRequestMeta = { actor: owner.actor, access: owner, source: 'crm', requestId: 'r' };

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
const codeOf = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code ?? String(e));
type Cmd = typeof recordIncome;
const run = (cmd: Cmd, body: object) => tx((t) => cmd(t, owner, body, meta, { idempotencyKey: randomUUID(), clock }));
const enable = (branchId: string) =>
  db.client.query(`INSERT INTO app.settings_values (key, level, branch_id, value, valid_from, created_by) VALUES ('finance.cash_shift_enabled', 'branch', $1, 'true', '2026-01-01', $2)`, [branchId, staffId]);
const openShift = (branchId: string) =>
  db.client.query<{ id: string }>(`INSERT INTO app.cash_shifts (branch_id, opened_by, opened_at, opening_counted_kop, opening_expected_kop) VALUES ($1, $2, now(), 0, 0) RETURNING id`, [branchId, staffId]);

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 3 });
  staffId = (await db.client.query<{ id: string }>(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('А', 'А', 'a@yu.test', 'admin', 'x') RETURNING id`)).rows[0]!.id;
});
afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('смена в кассе', () => {
  it('флаг false (по умолчанию): смены нет, операции идут, shift_id пуст', async () => {
    const b = (await createTestBranch(db.client)).id;
    const op = await run(recordIncome, { branchId: b, method: 'cash', amountKop: 1_000, source: 'other', occurredAt: AT });
    expect(op.shiftId).toBeNull();
  });

  it('флаг true: наличные и перевод без смены – CASH_SHIFT_REQUIRED, безнал идёт; со сменой – shift_id; сторно – тоже в смене', async () => {
    const b = (await createTestBranch(db.client)).id;
    await enable(b);
    expect(await codeOf(run(recordIncome, { branchId: b, method: 'cash', amountKop: 1_000, source: 'other', occurredAt: AT }))).toBe('CASH_SHIFT_REQUIRED');
    const card = await run(recordIncome, { branchId: b, method: 'card', amountKop: 2_000, source: 'other', occurredAt: AT });
    expect(card.shiftId).toBeNull();
    expect(await codeOf(run(transferBetweenPlaces, { branchId: b, from: 'noncash', amountKop: 500, occurredAt: AT, comment: 'размен' }))).toBe('CASH_SHIFT_REQUIRED');
    const shift = (await openShift(b)).rows[0]!.id;
    const cash = await run(recordIncome, { branchId: b, method: 'cash', amountKop: 1_000, source: 'other', occurredAt: AT });
    expect(cash.shiftId).toBe(shift);
    const other = (await db.client.query<{ id: string }>(`SELECT id FROM app.finance_categories WHERE name = 'Прочее'`)).rows[0]!.id;
    const exp = await run(recordExpense, { branchId: b, method: 'cash', amountKop: 300, categoryId: other, occurredAt: AT, comment: 'мелочи' });
    const rev = await tx((t) => reverseOperation(t, owner, { operationId: exp.id, reason: 'ошибка' }, meta, { idempotencyKey: randomUUID(), clock }));
    expect(rev.shiftId).toBe(shift);
    await db.client.query(`UPDATE app.cash_shifts SET status = 'closed', closed_at = now(), closed_by = $2, closing_counted_kop = 0, closing_expected_kop = 0 WHERE id = $1`, [shift, staffId]);
    expect(await codeOf(run(recordIncome, { branchId: b, method: 'cash', amountKop: 1, source: 'other', occurredAt: AT }))).toBe('CASH_SHIFT_REQUIRED');
  });

  it('вторая открытая смена филиала – UNIQUE; у yu_app нет DELETE', async () => {
    const b = (await createTestBranch(db.client)).id;
    const s = (await openShift(b)).rows[0]!.id;
    expect(await codeOf(openShift(b))).toBe('23505');
    const c = await pool.connect();
    try {
      expect(await codeOf(c.query(`DELETE FROM app.cash_shifts WHERE id = $1`, [s]))).toBe('42501');
    } finally {
      c.release();
    }
  });

  it('вверх/вниз/вверх на чистой базе', async () => {
    const clean = await createTestDatabase({ migrate: true });
    try {
      const later = await clean.client.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.schema_migrations WHERE version >= '0206'`);
      const down = await migrateDown(clean.client, later.rows[0]!.n);
      expect(down.at(-1)).toBe('0206');
      expect((await clean.client.query(`SELECT to_regclass('app.cash_shifts') AS t`)).rows).toEqual([{ t: null }]);
      expect(await migrateUp(clean.client)).toEqual([...down].reverse());
    } finally {
      await clean.drop();
    }
  });
});

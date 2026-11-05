// S3-10: миграция 0303 и ставки K18 §3: null ≠ 0, поздняя запись при равной дате, журнал только на вставку, событие и затронутые смены.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateDown, migrateUp } from '../../db/migrate.ts';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { AppError } from '../../apps/api/src/core/errors.ts';
import type { AccessContext, StaffRole } from '../../apps/api/src/core/permissions.ts';
import { fixedClock, type LocalDate } from '../../apps/api/src/core/time.ts';
import { accrualParts, listRates, rateAt, setRate } from '../../apps/api/src/modules/shifts/rates.ts';
import { createTestBranch } from '../helpers/network.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

let db: TestDatabase;
let pool: pg.Pool;
const clock = fixedClock('2026-11-14T05:00:00Z');
const d = (s: string) => s as LocalDate;

function ctx(role: StaffRole): AccessContext {
  return { actor: { kind: 'staff', staffId: randomUUID(), sessionId: randomUUID() }, role, network: role === 'owner', cityIds: new Set(), branchIds: new Set(), at: clock.now() };
}
const owner = ctx('owner');
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
const set = (staffId: string, validFrom: string, hourlyKop: number, attendanceFeeKop: number, extra: Record<string, unknown> = {}, who = owner) =>
  tx((t) => setRate(t, who, { staffId, validFrom, hourlyKop, attendanceFeeKop, reason: 'повышение', ...extra }, meta(who), clock));
async function newStaff(): Promise<string> {
  const r = await db.client.query<{ id: string }>(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', $1, 'admin', 'x') RETURNING id`, [`${randomUUID()}@yu.test`]);
  return r.rows[0]!.id;
}
async function workedShift(staffId: string, branchId: string, date: string): Promise<string> {
  const r = await db.client.query<{ id: string }>(
    `INSERT INTO app.staff_shifts (staff_id, branch_id, local_date, period, status, paid_minutes, created_by)
     VALUES ($1, $2, $3::date, tstzrange(($3::date + time '03:00') AT TIME ZONE 'UTC', ($3::date + time '09:00') AT TIME ZONE 'UTC', '[)'), 'worked', 360, $1) RETURNING id`,
    [staffId, branchId, date],
  );
  return r.rows[0]!.id;
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 6 });
});
afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('0303', () => {
  it('вверх/вниз/вверх на чистой базе', async () => {
    const clean = await createTestDatabase({ migrate: true });
    try {
      const later = await clean.client.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.schema_migrations WHERE version >= '0303'`);
      const down = await migrateDown(clean.client, later.rows[0]!.n);
      expect(down.at(-1)).toBe('0303');
      expect((await clean.client.query(`SELECT to_regclass('app.staff_shifts') AS t`)).rows).toEqual([{ t: null }]);
      expect((await clean.client.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = 'app' AND table_name = 'staff' AND column_name = 'planning_status'`)).rows).toEqual([{ n: 0 }]);
      expect(await migrateUp(clean.client)).toEqual([...down].reverse());
      expect((await clean.client.query(`SELECT to_regclass('app.staff_shifts')::text AS t`)).rows).toEqual([{ t: 'app.staff_shifts' }]);
    } finally {
      await clean.drop();
    }
  });

  it('журнал ставок и смен – без UPDATE и DELETE у yu_app (42501); DELETE смены и периода тоже', async () => {
    const staffId = await newStaff();
    await set(staffId, '2026-01-01', 30_000, 10_000);
    const c = await pool.connect();
    try {
      await expect(c.query(`UPDATE journal.staff_rates SET hourly_kop = 1 WHERE staff_id = $1`, [staffId])).rejects.toMatchObject({ code: '42501' });
      await expect(c.query(`DELETE FROM journal.staff_rates WHERE staff_id = $1`, [staffId])).rejects.toMatchObject({ code: '42501' });
      await expect(c.query(`DELETE FROM app.staff_shifts`)).rejects.toMatchObject({ code: '42501' });
      await expect(c.query(`DELETE FROM app.payroll_periods`)).rejects.toMatchObject({ code: '42501' });
      await expect(c.query(`DELETE FROM journal.staff_shift_changes`)).rejects.toMatchObject({ code: '42501' });
      expect((await c.query(`SELECT * FROM journal.append_only_violations()`)).rows).toEqual([]);
    } finally {
      c.release();
    }
  });
});

describe('rateAt', () => {
  it('до первой ставки – null, не 0 (05 §4.4); действует наибольшая дата ≤ запрошенной', async () => {
    const staffId = await newStaff();
    expect(await rateAt(pool, staffId, d('2026-06-01'))).toBeNull();
    await set(staffId, '2026-03-01', 25_000, 5_000);
    await set(staffId, '2026-05-01', 30_000, 7_000);
    expect(await rateAt(pool, staffId, d('2026-02-28'))).toBeNull();
    expect((await rateAt(pool, staffId, d('2026-03-01')))?.hourlyKop).toBe(25_000);
    expect((await rateAt(pool, staffId, d('2026-04-30')))?.hourlyKop).toBe(25_000);
    expect((await rateAt(pool, staffId, d('2026-05-01')))?.hourlyKop).toBe(30_000);
    expect((await listRates(pool, staffId)).map((r) => r.validFrom)).toEqual(['2026-05-01', '2026-03-01']);
  });

  it('две ставки одной даты – действует поздняя, в том числе при совпадении часов; исправление – ссылка corrects', async () => {
    const staffId = await newStaff();
    const first = await set(staffId, '2026-03-01', 25_000, 5_000);
    const second = await set(staffId, '2026-03-01', 26_000, 5_500, { corrects: first.rate.id, reason: 'опечатка' });
    expect((await rateAt(pool, staffId, d('2026-03-10')))?.id).toBe(second.rate.id);
    expect(second.rate.corrects).toBe(first.rate.id);
    expect(await listRates(pool, staffId)).toHaveLength(2); // первая осталась в истории
  });

  it('стоимость часа и ставка за выход – разные поля (приёмка 12)', async () => {
    const staffId = await newStaff();
    await set(staffId, '2026-03-01', 25_000, 5_000);
    const r = await rateAt(pool, staffId, d('2026-03-01'));
    expect([r?.hourlyKop, r?.attendanceFeeKop]).toEqual([25_000, 5_000]);
    expect(accrualParts(120, r!, 120)).toEqual({ hourlyPartKop: 50_000, feePartKop: 5_000, totalKop: 55_000 });
    expect(accrualParts(119, r!, 120)).toEqual({ hourlyPartKop: 49_583, feePartKop: 0, totalKop: 49_583 });
    expect(accrualParts(1, { hourlyKop: 30, attendanceFeeKop: 0 }, 0).hourlyPartKop).toBe(1); // половина – вверх
    expect(accrualParts(1, { hourlyKop: 29, attendanceFeeKop: 0 }, 0).hourlyPartKop).toBe(0);
  });
});

describe('setRate', () => {
  it('Директор и Администратор – FORBIDDEN, причина обязательна, сумма < 0 – INVALID_AMOUNT, чужая corrects – отказ', async () => {
    const staffId = await newStaff();
    await expect(set(staffId, '2026-03-01', 1, 1, {}, ctx('director'))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(set(staffId, '2026-03-01', 1, 1, {}, ctx('admin'))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(set(staffId, '2026-03-01', 1, 1, { reason: ' ' })).rejects.toMatchObject({ code: 'COMMENT_REQUIRED' });
    await expect(set(staffId, '2026-03-01', -1, 1)).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
    await expect(set(staffId, '2026-03-01', 1.5, 1)).rejects.toBeInstanceOf(AppError);
    await expect(set(randomUUID(), '2026-03-01', 1, 1)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const other = await set(await newStaff(), '2026-03-01', 1, 1);
    await expect(set(staffId, '2026-03-01', 1, 1, { corrects: other.rate.id })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('событие staff.rate_set и аудит содержат затронутые смены: только открытые периоды и только до следующей ставки', async () => {
    const staffId = await newStaff();
    const { id: branchId } = await createTestBranch(db.client);
    await db.client.query(`INSERT INTO app.payroll_periods (date_from, date_to, status, closed_at) VALUES ('2026-02-01', '2026-02-28', 'closed', now())`);
    await set(staffId, '2026-06-01', 40_000, 0);
    const inClosed = await workedShift(staffId, branchId, '2026-02-10');
    const inOpen = await workedShift(staffId, branchId, '2026-03-10');
    await workedShift(staffId, branchId, '2026-06-10'); // под более поздней ставкой – новая не действует
    const { rate, affectedShiftIds } = await set(staffId, '2026-02-01', 30_000, 1_000);
    expect(affectedShiftIds).toEqual([inOpen]);
    expect(affectedShiftIds).not.toContain(inClosed);
    const ev = await db.client.query(`SELECT event_type, aggregate_type, aggregate_id, payload FROM app.outbox_events WHERE dedupe_key = $1`, [`staff.rate_set:${rate.id}:${rate.id}`]);
    expect(ev.rows).toEqual([{ event_type: 'staff.rate_set', aggregate_type: 'staff_rate', aggregate_id: rate.id, payload: { rateId: rate.id, staffId, validFrom: '2026-02-01', affectedShiftIds: [inOpen] } }]);
    const audit = await db.client.query<{ reason: string; after: { affectedShiftIds: string[] } }>(`SELECT reason, after FROM journal.audit_events WHERE action = 'staff.rate_set' AND object_id = $1`, [rate.id]);
    expect(audit.rows[0]?.reason).toBe('повышение');
    expect(audit.rows[0]?.after.affectedShiftIds).toEqual([inOpen]);
  });
});

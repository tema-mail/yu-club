// S3-12: покрытие K18 §4: дыры при частичном покрытии (приёмка 10), активный сотрудник без смены не закрывает интервал,
// сутки по зоне филиала при чужом TZ машины, исключения графика, ≤ 31 дня за ≤ 1 с на 20 филиалов (17 §4.1).
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccessContext, StaffRole } from '../../apps/api/src/core/permissions.ts';
import { fixedClock, localToInstant, type LocalDate, type LocalTime, type TimeZone } from '../../apps/api/src/core/time.ts';
import { coverage, coverDay } from '../../apps/api/src/modules/shifts/coverage.ts';
import { createTestBranch } from '../helpers/network.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

let db: TestDatabase;
let pool: pg.Pool;
const clock = fixedClock('2026-11-14T05:00:00Z');
const NSK = 'Asia/Novosibirsk' as TimeZone;
const DAY = '2026-11-20' as LocalDate;
const at = (time: string, tz: TimeZone = NSK, date: LocalDate = DAY) => localToInstant(date, time as LocalTime, tz);
const iso = (time: string, tz: TimeZone = NSK, date: LocalDate = DAY) => at(time, tz, date).toISOString();

function ctx(role: StaffRole, branchIds: string[] = []): AccessContext {
  return { actor: { kind: 'staff', staffId: randomUUID(), sessionId: randomUUID() }, role, network: role === 'owner', cityIds: new Set(), branchIds: new Set(branchIds), at: clock.now() };
}
const owner = ctx('owner');

async function newBranch(timezone: string = NSK): Promise<string> {
  const b = await createTestBranch(db.client, { timezone });
  await db.client.query(`INSERT INTO app.branch_weekly_hours (branch_id, weekday, open_time, close_time, valid_from, created_by) SELECT $1, d, '10:00', '22:00', '2026-01-01', $2 FROM generate_series(1, 7) d`, [b.id, randomUUID()]);
  return b.id;
}
async function newStaff(): Promise<string> {
  const r = await db.client.query<{ id: string }>(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', $1, 'admin', 'x') RETURNING id`, [`${randomUUID()}@yu.test`]);
  return r.rows[0]!.id;
}
async function shift(staffId: string, branchId: string, start: string, end: string, status = 'planned', date: LocalDate = DAY): Promise<void> {
  await db.client.query(
    `INSERT INTO app.staff_shifts (staff_id, branch_id, local_date, period, status, paid_minutes, created_by) VALUES ($1, $2, $3, tstzrange($4::timestamptz, $5::timestamptz, '[)'), $6, $7, $1)`,
    [staffId, branchId, date, start, end, status, status === 'worked' ? 60 : null],
  );
}
const one = async (branchId: string, c = owner) => (await coverage(pool, c, { branchIds: [branchId], from: DAY, to: DAY }))[0]!;
const asIso = (list: Array<{ start: Date; end: Date }>) => list.map((i) => [i.start.toISOString(), i.end.toISOString()]);

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 8 });
});
afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('coverDay', () => {
  it('сводит смежные и пересекающиеся смены, смены вне часов не считает', () => {
    const open = [{ start: at('10:00'), end: at('22:00') }];
    const r = coverDay(open, [
      { start: at('08:00'), end: at('09:00') },
      { start: at('12:00'), end: at('14:00') },
      { start: at('14:00'), end: at('15:00') },
      { start: at('13:00'), end: at('14:30') },
    ]);
    expect(r.state).toBe('partial');
    expect(asIso(r.covered)).toEqual([[iso('12:00'), iso('15:00')]]);
    expect(asIso(r.gaps)).toEqual([[iso('10:00'), iso('12:00')], [iso('15:00'), iso('22:00')]]);
    expect(coverDay([], []).state).toBe('closed');
    expect(coverDay(open, []).state).toBe('empty');
    expect(coverDay(open, [{ start: at('09:00'), end: at('23:00') }]).state).toBe('full');
  });
});

describe('coverage', () => {
  it('частичное покрытие показывает дыры (приёмка 10); активный сотрудник без смены не закрывает интервал (05 §6.2)', async () => {
    const b = await newBranch();
    const free = await newStaff();
    await db.client.query(`INSERT INTO app.staff_assignments (staff_id, scope_type, branch_id, valid_from, created_by) VALUES ($1, 'branch', $2, '2026-01-01', $1)`, [free, b]);
    expect((await one(b)).state).toBe('empty');
    await shift(await newStaff(), b, iso('10:00'), iso('16:00'));
    const c = await one(b);
    expect(c).toMatchObject({ state: 'partial', timezone: NSK, date: DAY });
    expect(asIso(c.gaps)).toEqual([[iso('16:00'), iso('22:00')]]);
  });

  it('отменённая смена и невыход не покрывают; worked и needs_review – покрывают; два Администратора одновременно допустимы', async () => {
    const b = await newBranch();
    await shift(await newStaff(), b, iso('10:00'), iso('22:00'), 'cancelled');
    await shift(await newStaff(), b, iso('10:00'), iso('22:00'), 'no_show');
    expect((await one(b)).state).toBe('empty');
    await shift(await newStaff(), b, iso('10:00'), iso('16:00'), 'worked');
    await shift(await newStaff(), b, iso('16:00'), iso('22:00'), 'needs_review');
    await shift(await newStaff(), b, iso('12:00'), iso('14:00'));
    const c = await one(b);
    expect(c.state).toBe('full');
    expect(c.gaps).toEqual([]);
  });

  it('исключение графика: закрытый день – closed, короткий день – по своим часам', async () => {
    const b = await newBranch();
    await db.client.query(
      `INSERT INTO app.calendar_exceptions (branch_id, scope_type, local_date, kind, open_time, close_time, reason, created_by) VALUES ($1, 'branch', $2, 'closed', NULL, NULL, 'ремонт', $3), ($1, 'branch', $4, 'short_day', '10:00', '12:00', 'праздник', $3)`,
      [b, DAY, randomUUID(), '2026-11-21'],
    );
    const items = await coverage(pool, owner, { branchIds: [b], from: DAY, to: '2026-11-21' });
    expect(items.map((i) => i.state)).toEqual(['closed', 'empty']);
    expect(asIso(items[1]!.open)).toEqual([[iso('10:00', NSK, '2026-11-21' as LocalDate), iso('12:00', NSK, '2026-11-21' as LocalDate)]]);
  });

  it('сутки – по зоне филиала при чужом TZ машины и сессии', async () => {
    const vvo = 'Asia/Vladivostok' as TimeZone;
    const b = await newBranch(vvo);
    await shift(await newStaff(), b, iso('10:00', vvo), iso('22:00', vvo));
    const saved = process.env.TZ;
    process.env.TZ = 'Pacific/Honolulu';
    const c = await pool.connect();
    try {
      await c.query(`SET TIME ZONE 'Pacific/Honolulu'`);
      const r = (await coverage(c, owner, { branchIds: [b], from: DAY, to: DAY }))[0]!;
      expect(r.state).toBe('full');
      expect(asIso(r.open)).toEqual([[iso('10:00', vvo), iso('22:00', vvo)]]);
    } finally {
      process.env.TZ = saved;
      await c.query('RESET TIME ZONE');
      c.release();
    }
  });

  it('Директор зоны {А}: филиал Б – 404; без зоны – 404; неверный период – 400', async () => {
    const a = await newBranch();
    const b = await newBranch();
    const director = ctx('director', [a]);
    expect((await one(a, director)).branchId).toBe(a);
    await expect(one(b, director)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(coverage(pool, owner, { branchIds: [randomUUID()], from: DAY, to: DAY })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(coverage(pool, owner, { branchIds: [a], from: '2026-01-01', to: '2026-02-05' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(coverage(pool, owner, { branchIds: [a], from: '2026-02-05', to: '2026-02-01' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('31 день на 20 филиалов – не дольше секунды (17 §4.1)', async () => {
    const branches: string[] = [];
    for (let i = 0; i < 20; i++) branches.push(await newBranch());
    const s = await newStaff();
    await shift(s, branches[0]!, iso('10:00'), iso('12:00'));
    const started = performance.now();
    const items = await coverage(pool, owner, { branchIds: branches, from: '2026-11-01', to: '2026-12-01' });
    const ms = performance.now() - started;
    expect(items).toHaveLength(20 * 31);
    expect(ms).toBeLessThan(1000);
  });
});

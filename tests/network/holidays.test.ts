// S3-56: праздничный календарь на настоящей Postgres – праздник города не действует в другом городе, дата – по зоне филиала,
// повтор даты – одна активная строка (20 параллельных), график филиала не меняется, ведёт только Владелец.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { AppError } from '../../apps/api/src/core/errors.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import { fixedClock, type LocalDate } from '../../apps/api/src/core/time.ts';
import { withTx } from '../../apps/api/src/modules/clients/index.ts';
import { cancelHoliday, holidaysOfBranch, isHoliday, isHolidayAt, listHolidays, setHoliday } from '../../apps/api/src/modules/network/holidays.ts';
import { openIntervals } from '../../apps/api/src/modules/network/index.ts';
import { createTestBranch, createTestCity } from '../helpers/network.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const clock = fixedClock('2026-05-01T05:00:00Z');
const d = (s: string) => s as LocalDate;
let db: TestDatabase;
let pool: pg.Pool;
let owner: AccessContext;
let director: AccessContext;
let nsk = '';
let vladivostok = '';
let branchNsk = '';
let branchVvo = '';

const meta = (ctx: AccessContext = owner): AuditRequestMeta => ({ actor: ctx.actor, access: ctx, source: 'crm', requestId: randomUUID() });
const tx = <T>(fn: (c: pg.PoolClient) => Promise<T>) => withTx(pool, fn);
const set = (input: Record<string, unknown>, ctx = owner) => tx((c) => setHoliday(c, ctx, input, meta(ctx), clock));

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 25 });
  const s = await db.client.query<{ id: string }>(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', 'o@yu.test', 'owner', 'x') RETURNING id`);
  owner = { actor: { kind: 'staff', staffId: s.rows[0]!.id, sessionId: randomUUID() }, role: 'owner', network: true, cityIds: new Set(), branchIds: new Set(), at: clock.now() };
  nsk = await createTestCity(db.client, { timezone: 'Asia/Novosibirsk' });
  vladivostok = await createTestCity(db.client, { timezone: 'Asia/Vladivostok' });
  branchNsk = (await createTestBranch(db.client, { cityId: nsk })).id;
  branchVvo = (await createTestBranch(db.client, { cityId: vladivostok, timezone: 'Asia/Vladivostok' })).id;
  director = { ...owner, role: 'director', network: false, branchIds: new Set([branchNsk]) };
});
afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('S3-56: праздники', () => {
  it('праздник сети действует везде; праздник города – только в своём', async () => {
    await set({ scope: 'network', date: '2026-06-12', name: 'День России' });
    await set({ scope: 'city', cityId: nsk, date: '2026-06-15', name: 'День города' });
    expect(await isHoliday(pool, { branchId: branchNsk, date: d('2026-06-12') })).toBe(true);
    expect(await isHoliday(pool, { branchId: branchVvo, date: d('2026-06-12') })).toBe(true);
    expect(await isHoliday(pool, { branchId: branchNsk, date: d('2026-06-15') })).toBe(true);
    expect(await isHoliday(pool, { branchId: branchVvo, date: d('2026-06-15') })).toBe(false);
    expect(await isHoliday(pool, { branchId: branchNsk, date: d('2026-06-16') })).toBe(false);
    expect([...(await holidaysOfBranch(pool, { branchId: branchVvo, from: d('2026-06-01'), to: d('2026-06-30') }))]).toEqual(['2026-06-12']);
  });
  it('дата – по зоне филиала: момент 11.06 16:00 UTC – уже 12.06 во Владивостоке и ещё 11.06 в Новосибирске (23:00)', async () => {
    const at = new Date('2026-06-11T16:00:00Z');
    expect(await isHolidayAt(pool, { branchId: branchVvo, at })).toBe(true);
    expect(await isHolidayAt(pool, { branchId: branchNsk, at })).toBe(false);
  });
  it('повтор даты – одна активная строка, в том числе при 20 параллельных', async () => {
    const all = await Promise.all(Array.from({ length: 20 }, () => set({ scope: 'network', date: '2026-07-01', name: 'Гонка' })));
    expect(new Set(all.map((x) => x.id)).size).toBe(1);
    const n = await db.client.query(`SELECT count(*)::int n FROM app.holiday_dates WHERE local_date = '2026-07-01' AND status = 'active'`);
    expect(n.rows[0].n).toBe(1);
    const log = await db.client.query(`SELECT count(*)::int n FROM journal.audit_events WHERE action = 'holiday.set' AND object_id = $1`, [all[0]!.id]);
    expect(log.rows[0].n).toBe(1);
  });
  it('отмена с причиной: дата перестаёт быть праздником; можно завести заново; не удаляется', async () => {
    const h = await set({ scope: 'city', cityId: nsk, date: '2026-08-01', name: 'Х' });
    await expect(tx((c) => cancelHoliday(c, owner, h.id, {}, meta(), clock))).rejects.toMatchObject({ code: 'COMMENT_REQUIRED' });
    const c1 = await tx((c) => cancelHoliday(c, owner, h.id, { reason: 'ошибка' }, meta(), clock));
    expect(c1.status).toBe('cancelled');
    expect(await isHoliday(pool, { branchId: branchNsk, date: d('2026-08-01') })).toBe(false);
    const again = await set({ scope: 'city', cityId: nsk, date: '2026-08-01', name: 'Х' });
    expect(again.id).not.toBe(h.id);
    await expect(pool.query('DELETE FROM app.holiday_dates WHERE id = $1', [h.id])).rejects.toMatchObject({ code: '42501' });
    expect((await listHolidays(pool, { from: '2026-08-01', to: '2026-08-01', includeCancelled: 'true' })).map((x) => x.status).sort()).toEqual(['active', 'cancelled']);
    expect(await listHolidays(pool, { from: '2026-08-01', to: '2026-08-01' })).toHaveLength(1);
  });
  it('право – только Владелец; город обязателен для праздника города', async () => {
    await expect(set({ scope: 'network', date: '2026-09-01', name: 'Х' }, director)).rejects.toBeInstanceOf(AppError);
    await expect(set({ scope: 'network', date: '2026-09-01', name: 'Х' }, director)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(set({ scope: 'city', date: '2026-09-01', name: 'Х' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(set({ scope: 'network', cityId: nsk, date: '2026-09-01', name: 'Х' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
  it('график филиала не меняется', async () => {
    const owner2 = owner.actor.staffId;
    await db.client.query(`INSERT INTO app.branch_weekly_hours (branch_id, weekday, open_time, close_time, valid_from, created_by) SELECT $1, d, '10:00', '22:00', '2026-01-01', $2 FROM generate_series(1, 7) d`, [branchNsk, owner2]);
    const before = await openIntervals(pool, { branchId: branchNsk, date: d('2026-10-05') });
    await set({ scope: 'network', date: '2026-10-05', name: 'Праздник' });
    expect(await openIntervals(pool, { branchId: branchNsk, date: d('2026-10-05') })).toEqual(before);
    expect(before).toHaveLength(1);
  });
});

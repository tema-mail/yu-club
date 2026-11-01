// S1-05: доступность (K6 availability, K5 №5): сетка по шагу ресурса, 6 состояний, окно из настроек K7,
// граница суток по зоне филиала, исключения графика; производительность на засеянных данных (17 §4.1).
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixedClock, interval, type LocalDate } from '../../apps/api/src/core/time.ts';
import { availability, availabilityRange, type AvailabilityDto } from '../../apps/api/src/modules/booking/availability.ts';
import { occupy, runOccupancyCommand } from '../../apps/api/src/modules/booking/occupancy.ts';
import { expandToUnits } from '../../apps/api/src/modules/resources/index.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const NOW = '2026-11-14T05:00:00Z'; // 12:00 в Новосибирске (UTC+7)
const clock = fixedClock(NOW);
const SYS = '00000000-0000-0000-0000-000000000001';
let db: TestDatabase;
let pool: pg.Pool;
const ids: Record<string, string> = {};
const units: Record<string, string> = {};
const u = (k: string): string => units[k]!;

async function one<T = { id: string }>(sql: string, params: unknown[]): Promise<T> {
  return (await db.client.query(sql, params)).rows[0] as T;
}
async function branch(code: string, cityId: string, tz: string): Promise<string> {
  const b = await one(`INSERT INTO app.branches (city_id, code, slug, name, address, timezone, status) VALUES ($1, $2, $2, $2, 'адрес', $3, 'active') RETURNING id`, [cityId, code, tz]);
  await db.client.query(
    `INSERT INTO app.branch_weekly_hours (branch_id, weekday, open_time, close_time, valid_from, created_by)
     SELECT $1, d, '10:00', '22:00', '2026-01-01', $2 FROM generate_series(1, 7) d`,
    [b.id, SYS],
  );
  return b.id;
}
async function unit(branchId: string, roomId: string | null, code: string): Promise<string> {
  return (await one(`INSERT INTO app.occupancy_units (branch_id, room_id, code, name) VALUES ($1, $2, $3, $3) RETURNING id`, [branchId, roomId, code])).id;
}
async function resource(branchId: string, roomId: string | null, type: string, name: string, unitIds: string[]): Promise<string> {
  const r = await one(`INSERT INTO app.resources (branch_id, room_id, resource_type, name) VALUES ($1, $2, $3, $4) RETURNING id`, [branchId, roomId, type, name]);
  await db.client.query(`INSERT INTO app.resource_units (resource_id, unit_id, valid_from) SELECT $1, u, '2026-01-01' FROM unnest($2::uuid[]) u`, [r.id, unitIds]);
  return r.id;
}
const slot = (iso: string, minutes: number) => interval(new Date(iso), new Date(new Date(iso).getTime() + minutes * 60_000));
async function put(resourceId: string, iso: string, minutes: number, source: Parameters<typeof occupy>[1]['source']): Promise<void> {
  const u = await expandToUnits(pool, resourceId, new Date(iso));
  const b = (await one<{ branch_id: string }>('SELECT branch_id FROM app.resources WHERE id = $1', [resourceId])).branch_id;
  await runOccupancyCommand(pool, (c) => occupy(c, { branchId: b, units: u, period: slot(iso, minutes), source, clientId: null }));
}
const booking = () => ({ type: 'booking' as const, id: randomUUID(), version: 1 });
const stateAt = (a: AvailabilityDto, resourceId: string, startIso: string) =>
  a.resources.find((r) => r.resourceId === resourceId)!.slots.find((s) => s.start === new Date(startIso).toISOString())?.state;

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 8 });
  const nsk = await one(`INSERT INTO app.cities (code, slug, name, timezone) VALUES ('nsk', 'nsk', 'НСК', 'Asia/Novosibirsk') RETURNING id`, []);
  const msk = await one(`INSERT INTO app.cities (code, slug, name, timezone) VALUES ('msk', 'msk', 'МСК', 'Europe/Moscow') RETURNING id`, []);
  ids.nsk = await branch('nsk1', nsk.id, 'Asia/Novosibirsk');
  ids.msk = await branch('msk1', msk.id, 'Europe/Moscow');
  ids.room = (await one(`INSERT INTO app.rooms (branch_id, slug, name, is_published) VALUES ($1, 'vr', 'VR', true) RETURNING id`, [ids.nsk])).id;
  for (const c of ['VR1', 'VR2', 'PS4']) units[c] = await unit(ids.nsk, ids.room, c);
  units.PC1 = await unit(ids.nsk, null, 'PC1');
  ids.vr1 = await resource(ids.nsk, ids.room, 'vr_seat', 'VR-место 1', [u('VR1')]);
  ids.vr2 = await resource(ids.nsk, ids.room, 'vr_seat', 'VR-место 2', [u('VR2')]);
  ids.whole = await resource(ids.nsk, ids.room, 'room_whole', 'Комната', [u('VR1'), u('VR2'), u('PS4')]);
  ids.pc1 = await resource(ids.nsk, null, 'pc', 'ПК-1', [u('PC1')]);
  ids.mskPc = await resource(ids.msk, null, 'pc', 'ПК', [await unit(ids.msk, null, 'PC1')]);
});
afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('сетка и граница суток по зоне филиала', () => {
  it('VR – слоты по 15 мин, ПК – по 30; 10:00 Новосибирска = 03:00Z, 10:00 Москвы = 07:00Z', async () => {
    const a = await availability(pool, { branchId: ids.nsk!, date: '2026-11-15' as LocalDate, viewer: {} }, { clock });
    expect(a).toMatchObject({ dayState: 'open', timezone: 'Asia/Novosibirsk', openIntervals: [{ start: '2026-11-15T03:00:00.000Z', end: '2026-11-15T15:00:00.000Z' }] });
    const vr = a.resources.find((r) => r.resourceId === ids.vr1)!.slots;
    const pc = a.resources.find((r) => r.resourceId === ids.pc1)!.slots;
    expect(vr).toHaveLength(48);
    expect(pc).toHaveLength(24);
    expect(vr[0]).toEqual({ start: '2026-11-15T03:00:00.000Z', end: '2026-11-15T03:15:00.000Z', state: 'free' });
    const m = await availability(pool, { branchId: ids.msk!, date: '2026-11-15' as LocalDate, viewer: {} }, { clock });
    expect(m.resources[0]!.slots[0]!.start).toBe('2026-11-15T07:00:00.000Z');
  });

  it('сегодня: слоты с началом ≤ сейчас – closed (прошлое), дальше free', async () => {
    const a = await availability(pool, { branchId: ids.nsk!, date: '2026-11-14' as LocalDate, viewer: {} }, { clock });
    expect(stateAt(a, ids.pc1!, '2026-11-14T04:30:00Z')).toBe('closed');
    expect(stateAt(a, ids.pc1!, '2026-11-14T05:00:00Z')).toBe('closed'); // start = now
    expect(stateAt(a, ids.pc1!, '2026-11-14T05:30:00Z')).toBe('free');
  });

  it('фильтр resourceIds и PS4 не отдаётся отдельным ресурсом', async () => {
    const a = await availability(pool, { branchId: ids.nsk!, date: '2026-11-15' as LocalDate, resourceIds: [ids.vr2!], viewer: {} }, { clock });
    expect(a.resources.map((r) => r.resourceId)).toEqual([ids.vr2]);
    const all = await availability(pool, { branchId: ids.nsk!, date: '2026-11-15' as LocalDate, viewer: {} }, { clock });
    expect(all.resources.map((r) => r.resourceId).sort()).toEqual([ids.vr1, ids.vr2, ids.whole, ids.pc1].sort());
  });
});

describe('6 состояний слота (01 §6.3)', () => {
  it('занят / удерживается другим / мой / заблокирован / свободен; истёкшее удержание не держит', async () => {
    await put(ids.whole!, '2026-11-16T04:00:00Z', 60, booking()); // комната 11:00–12:00
    const other = { type: 'hold_item' as const, id: randomUUID(), holdExpiresAt: new Date('2026-11-14T05:10:00Z') };
    await put(ids.vr2!, '2026-11-16T06:00:00Z', 30, other); // VR2 13:00–13:30, чужое
    const mine = { type: 'hold_item' as const, id: randomUUID(), holdExpiresAt: new Date('2026-11-14T05:10:00Z') };
    await put(ids.vr1!, '2026-11-16T06:00:00Z', 30, mine); // VR1 13:00–13:30, моё
    const stale = { type: 'hold_item' as const, id: randomUUID(), holdExpiresAt: new Date('2026-11-14T04:59:00Z') };
    await put(ids.pc1!, '2026-11-16T06:00:00Z', 30, stale); // истекло до now
    const reason = (await one(`SELECT id FROM app.dict_reasons WHERE domain = 'resource_block' AND code = 'repair'`, [])).id;
    const blk = await one(`INSERT INTO app.resource_blocks (branch_id, target_type, target_ids, period, reason_id, created_by) VALUES ($1, 'unit', $2, '[2026-11-16 08:00:00+00,2026-11-16 09:00:00+00)', $3, $4) RETURNING id`, [ids.nsk, [units.PS4], reason, SYS]);
    await db.client.query(`INSERT INTO app.resource_block_units (block_id, unit_id, period) VALUES ($1, $2, '[2026-11-16 08:00:00+00,2026-11-16 09:00:00+00)')`, [blk.id, units.PS4]);
    const a = await availability(pool, { branchId: ids.nsk!, date: '2026-11-16' as LocalDate, viewer: { visitorId: randomUUID() } }, {
      clock,
      ownHoldItems: async () => new Set([mine.id]),
    });
    expect(stateAt(a, ids.vr1!, '2026-11-16T04:15:00Z')).toBe('booked'); // место под бронью комнаты
    expect(stateAt(a, ids.whole!, '2026-11-16T04:00:00Z')).toBe('booked');
    expect(stateAt(a, ids.vr2!, '2026-11-16T06:00:00Z')).toBe('held');
    expect(stateAt(a, ids.vr1!, '2026-11-16T06:00:00Z')).toBe('mine');
    expect(stateAt(a, ids.whole!, '2026-11-16T06:00:00Z')).toBe('held'); // моё + чужое → не «мой»
    expect(stateAt(a, ids.pc1!, '2026-11-16T06:00:00Z')).toBe('free'); // истёкшее удержание
    expect(stateAt(a, ids.whole!, '2026-11-16T08:00:00Z')).toBe('blocked'); // PS4 в ремонте – комната заблокирована
    expect(stateAt(a, ids.vr1!, '2026-11-16T08:00:00Z')).toBe('free'); // места – нет
    const anon = await availability(pool, { branchId: ids.nsk!, date: '2026-11-16' as LocalDate, viewer: {} }, { clock });
    expect(stateAt(anon, ids.vr1!, '2026-11-16T06:00:00Z')).toBe('held'); // без владельца – чужое
  });

  it('вне графика: закрытый день филиала – dayState closed; спецчасы ресурса – слоты вне часов closed', async () => {
    await db.client.query(`INSERT INTO app.calendar_exceptions (branch_id, scope_type, local_date, kind, reason, created_by) VALUES ($1, 'branch', '2026-11-17', 'closed', 'праздник', $2)`, [ids.nsk, SYS]);
    const closed = await availability(pool, { branchId: ids.nsk!, date: '2026-11-17' as LocalDate, viewer: {} }, { clock });
    expect(closed.dayState).toBe('closed');
    expect(closed.resources.every((r) => r.slots.length === 0)).toBe(true);
    await db.client.query(
      `INSERT INTO app.calendar_exceptions (branch_id, scope_type, resource_id, local_date, kind, open_time, close_time, reason, created_by) VALUES ($1, 'resource', $2, '2026-11-18', 'special_hours', '14:00', '16:00', 'ТО', $3)`,
      [ids.nsk, ids.pc1, SYS],
    );
    const a = await availability(pool, { branchId: ids.nsk!, date: '2026-11-18' as LocalDate, viewer: {} }, { clock });
    expect(stateAt(a, ids.pc1!, '2026-11-18T03:00:00Z')).toBe('closed'); // 10:00 – вне спецчасов ресурса
    expect(stateAt(a, ids.pc1!, '2026-11-18T07:00:00Z')).toBe('free'); // 14:00
    expect(stateAt(a, ids.vr1!, '2026-11-18T03:00:00Z')).toBe('free'); // остальные – по графику филиала
  });

  it('временно закрытый филиал – слоты периода закрытия closed', async () => {
    await db.client.query(
      `UPDATE app.branches SET status = 'temporarily_closed', temp_closed_from = '2026-11-19T00:00:00Z', temp_closed_to = '2026-11-21T00:00:00Z', temp_close_reason = 'ремонт' WHERE id = $1`,
      [ids.msk],
    );
    const a = await availability(pool, { branchId: ids.msk!, date: '2026-11-20' as LocalDate, viewer: {} }, { clock });
    expect(a.dayState).toBe('closed');
    await db.client.query(`UPDATE app.branches SET status = 'active', temp_closed_from = NULL, temp_closed_to = NULL, temp_close_reason = NULL WHERE id = $1`, [ids.msk]);
  });
});

describe('окно записи из настроек (K7)', () => {
  it('по умолчанию 30 дней: сегодня + 29 – в окне, +30 и вчера – outside_window; настройка филиала 10 дней', async () => {
    const day = (d: string) => availability(pool, { branchId: ids.nsk!, date: d as LocalDate, viewer: {} }, { clock });
    expect((await day('2026-12-13')).dayState).toBe('open');
    expect((await day('2026-12-14')).dayState).toBe('outside_window');
    expect((await day('2026-11-13')).dayState).toBe('outside_window');
    await db.client.query(
      `INSERT INTO app.settings_values (key, level, branch_id, value, valid_from, created_by) VALUES ('booking.window_max_days', 'branch', $1, '10', '2026-01-01', $2)`,
      [ids.nsk, SYS],
    );
    expect((await day('2026-11-23')).dayState).toBe('open');
    expect((await day('2026-11-24')).dayState).toBe('outside_window');
  });

  it('неактивный филиал (готовится) – NOT_FOUND', async () => {
    const c = await one(`SELECT city_id AS id FROM app.branches WHERE id = $1`, [ids.nsk]);
    const prep = await one(`INSERT INTO app.branches (city_id, code, slug, name, address, timezone) VALUES ($1, 'prep', 'prep', 'p', 'a', 'Asia/Novosibirsk') RETURNING id`, [c.id]);
    await expect(availability(pool, { branchId: prep.id, date: '2026-11-15' as LocalDate, viewer: {} }, { clock })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('производительность (17 §4.1) на засеянных данных', () => {
  it('филиал 40 ПК + VR-комната + 5 PS, ~3 000 строк занятости: день ≤ 2 с, неделя ≤ 3 с', async () => {
    const b = await branch('perf', (await one(`SELECT city_id AS id FROM app.branches WHERE id = $1`, [ids.nsk])).id, 'Asia/Novosibirsk');
    const res: string[] = [];
    for (let i = 1; i <= 40; i++) res.push(await resource(b, null, 'pc', `ПК-${i}`, [await unit(b, null, `PC${i}`)]));
    for (let i = 1; i <= 5; i++) {
      const room = (await one(`INSERT INTO app.rooms (branch_id, slug, name, is_published) VALUES ($1, $2, $2, true) RETURNING id`, [b, `ps${i}`])).id;
      res.push(await resource(b, room, 'ps_room', `PS5-${i}`, [await unit(b, room, `PS5-${i}`)]));
    }
    // занятость: каждый ресурс – 9 броней по 30 мин в день на 7 дней (каждый второй слот из первых 18)
    await db.client.query(
      `INSERT INTO app.occupancy (unit_id, branch_id, period, source_type, source_id, booking_version)
       SELECT ru.unit_id, $1, tstzrange(t, t + interval '30 min', '[)'), 'booking', gen_random_uuid(), 1
       FROM app.resource_units ru
       JOIN app.resources r ON r.id = ru.resource_id AND r.branch_id = $1
       CROSS JOIN generate_series(0, 6) d
       CROSS JOIN generate_series(0, 8) k
       CROSS JOIN LATERAL (SELECT timestamptz '2026-11-15 03:00:00+00' + d * interval '1 day' + k * interval '1 hour' AS t) x`,
      [b],
    );
    const n = (await one<{ n: number }>(`SELECT count(*)::int n FROM app.occupancy WHERE branch_id = $1`, [b])).n;
    expect(n).toBe(45 * 7 * 9);
    let t = performance.now();
    const day = await availability(pool, { branchId: b, date: '2026-11-15' as LocalDate, viewer: { visitorId: randomUUID() } }, { clock });
    const dayMs = performance.now() - t;
    expect(day.resources).toHaveLength(45);
    expect(day.resources[0]!.slots.filter((s) => s.state === 'booked')).toHaveLength(9);
    t = performance.now();
    const week = await availabilityRange(pool, { branchId: b, from: '2026-11-15' as LocalDate, days: 7, viewer: {} }, { clock });
    const weekMs = performance.now() - t;
    expect(week).toHaveLength(7);
    console.info(`availability: день ${dayMs.toFixed(0)} мс, неделя ${weekMs.toFixed(0)} мс, строк занятости ${n}`);
    expect(dayMs).toBeLessThan(2000);
    expect(weekMs).toBeLessThan(3000);
    await expect(availabilityRange(pool, { branchId: b, from: '2026-11-15' as LocalDate, days: 8, viewer: {} }, { clock })).rejects.toMatchObject({ code: 'RANGE_TOO_LONG' });
  }, 60_000);
});

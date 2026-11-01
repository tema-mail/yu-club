import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LocalDate } from '../../apps/api/src/core/time.ts';
import {
  branchIdsOfCities,
  getBranch,
  getBranches,
  isAcceptingBookings,
  openIntervals,
  openIntervalsBulk,
  timezonesOf,
} from '../../apps/api/src/modules/network/index.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

let db: TestDatabase;
const ids: Record<string, string> = {};
const SYS = '00000000-0000-4000-8000-000000000000';

async function asApp<T>(fn: () => Promise<T>): Promise<T> {
  await db.client.query('SET ROLE yu_app');
  try {
    return await fn();
  } finally {
    await db.client.query('RESET ROLE');
  }
}

async function city(key: string, tz: string): Promise<void> {
  const r = await db.client.query<{ id: string }>(
    `INSERT INTO app.cities (code, slug, name, timezone) VALUES ($1, $1, $1, $2) RETURNING id`,
    [key, tz],
  );
  ids[key] = r.rows[0]!.id;
}

async function branch(key: string, cityKey: string, tz: string, status = 'active'): Promise<void> {
  const r = await db.client.query<{ id: string }>(
    `INSERT INTO app.branches (city_id, code, slug, name, address, timezone, status) VALUES ($1, $2, $2, $2, 'адрес', $3, $4) RETURNING id`,
    [ids[cityKey], key, tz, status],
  );
  ids[key] = r.rows[0]!.id;
  for (let wd = 1; wd <= 7; wd++) {
    await db.client.query(
      `INSERT INTO app.branch_weekly_hours (branch_id, weekday, open_time, close_time, valid_from, created_by)
       VALUES ($1, $2, '10:00', '22:00', '2026-01-01', $3)`,
      [ids[key], wd, SYS],
    );
  }
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  await city('msk', 'Europe/Moscow');
  await city('nsk', 'Asia/Novosibirsk');
  await branch('msk-1', 'msk', 'Europe/Moscow');
  await branch('nsk-1', 'nsk', 'Asia/Novosibirsk');
  await branch('nsk-2', 'nsk', 'Asia/Novosibirsk', 'preparing');
});
afterAll(async () => {
  await db.drop();
});

describe('0008: схема сети', () => {
  it('yu_app не удаляет города, филиалы и график – только архив', async () => {
    for (const t of ['app.cities', 'app.branches', 'app.branch_weekly_hours']) {
      await expect(asApp(() => db.client.query(`DELETE FROM ${t}`))).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('график: пересечение дат одного дня недели – EXCLUDE; close ≤ open – CHECK', async () => {
    await expect(
      db.client.query(
        `INSERT INTO app.branch_weekly_hours (branch_id, weekday, open_time, close_time, valid_from, created_by) VALUES ($1, 1, '09:00', '20:00', '2026-06-01', $2)`,
        [ids['msk-1'], SYS],
      ),
    ).rejects.toMatchObject({ code: '23P01' });
    await expect(
      db.client.query(
        `INSERT INTO app.branch_weekly_hours (branch_id, weekday, open_time, close_time, valid_from, created_by) VALUES ($1, 1, '22:00', '10:00', '2020-01-01', $2)`,
        [ids['msk-1'], SYS],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('slug уникален в городе, «временно закрыт» без причины и архив без даты – отказ базы', async () => {
    await expect(
      db.client.query(`INSERT INTO app.branches (city_id, code, slug, name, address, timezone) VALUES ($1, 'x1', 'nsk-1', 'x', 'a', 'Asia/Novosibirsk')`, [ids.nsk]),
    ).rejects.toMatchObject({ code: '23505' });
    await expect(db.client.query(`UPDATE app.branches SET status = 'temporarily_closed' WHERE id = $1`, [ids['nsk-1']])).rejects.toMatchObject({
      code: '23514',
    });
    await expect(db.client.query(`UPDATE app.cities SET status = 'archived' WHERE id = $1`, [ids.msk])).rejects.toMatchObject({ code: '23514' });
  });
});

describe('0011: связи с сетью', () => {
  it('назначение, счёт и проводка на несуществующий город/филиал – 23503', async () => {
    const ghost = '11111111-1111-4111-8111-111111111111';
    const st = await db.client.query<{ id: string }>(
      `INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('А', 'Б', 'fk@yu.test', 'admin', 'x') RETURNING id`,
    );
    const sid = st.rows[0]!.id;
    for (const [col, kind] of [['branch_id', 'branch'], ['city_id', 'city']]) {
      await expect(
        db.client.query(`INSERT INTO app.staff_assignments (staff_id, scope_type, ${col}, valid_from, created_by) VALUES ($1, $2, $3, '2026-01-01', $1)`, [sid, kind, ghost]),
      ).rejects.toMatchObject({ code: '23503' });
    }
    await expect(
      db.client.query(`INSERT INTO app.ledger_accounts (kind, unit, branch_id, owner_type, owner_id) VALUES ('cash_branch', 'RUB_KOP', $1, 'branch', $1)`, [ghost]),
    ).rejects.toMatchObject({ code: '23503' });
    await db.client.query(`INSERT INTO app.staff_assignments (staff_id, scope_type, branch_id, valid_from, created_by) VALUES ($1, 'branch', $2, '2026-01-01', $1)`, [sid, ids['nsk-1']]);
  });
});

describe('K13: чтение', () => {
  it('getBranch: поля BranchInfo; нет или не uuid → null', async () => {
    const b = await getBranch(db.client, ids['nsk-1']!);
    expect(b).toEqual({
      id: ids['nsk-1'], cityId: ids.nsk, citySlug: 'nsk', cityName: 'nsk', slug: 'nsk-1', name: 'nsk-1', address: 'адрес',
      timezone: 'Asia/Novosibirsk', status: 'active', tempClosed: null,
    });
    expect(await getBranch(db.client, '11111111-1111-4111-8111-111111111111')).toBeNull();
    expect(await getBranch(db.client, 'b-nsk-krasny')).toBeNull();
  });

  it('getBranches – карта по id, мусорные id пропускаются', async () => {
    const m = await getBranches(db.client, [ids['msk-1']!, ids['nsk-2']!, 'x']);
    expect([...m.keys()].sort()).toEqual([ids['msk-1'], ids['nsk-2']].sort());
  });

  it('isAcceptingBookings: только active и вне временного закрытия', async () => {
    const b = (await getBranch(db.client, ids['nsk-1']!))!;
    const at = new Date('2026-11-15T05:00:00Z');
    expect(isAcceptingBookings(b, at)).toBe(true);
    expect(isAcceptingBookings({ ...b, status: 'preparing' }, at)).toBe(false);
    const closed = { ...b, tempClosed: { from: new Date('2026-11-15T00:00:00Z'), to: new Date('2026-11-16T00:00:00Z'), reason: 'ремонт' } };
    expect(isAcceptingBookings(closed, at)).toBe(false);
    expect(isAcceptingBookings(closed, new Date('2026-11-16T00:00:00Z'))).toBe(true);
    expect(isAcceptingBookings({ ...closed, tempClosed: { ...closed.tempClosed, to: null } }, new Date('2027-01-01T00:00:00Z'))).toBe(false);
  });

  it('branchIdsOfCities и timezonesOf', async () => {
    expect(await branchIdsOfCities(db.client, [ids.nsk!])).toEqual([ids['nsk-1'], ids['nsk-2']].sort());
    expect(await branchIdsOfCities(db.client, [])).toEqual([]);
    const z = await timezonesOf(db.client, { cityIds: [ids.msk!], branchIds: [ids['nsk-1']!] });
    expect(z.get(ids.msk!)).toBe('Europe/Moscow');
    expect(z.get(ids['nsk-1']!)).toBe('Asia/Novosibirsk');
  });

  it('openIntervals: одни «10:00–22:00» дают разные UTC в Москве и Новосибирске', async () => {
    const date = '2026-11-15' as LocalDate;
    expect(await openIntervals(db.client, { branchId: ids['msk-1']!, date })).toEqual([
      { start: new Date('2026-11-15T07:00:00Z'), end: new Date('2026-11-15T19:00:00Z') },
    ]);
    expect(await openIntervals(db.client, { branchId: ids['nsk-1']!, date })).toEqual([
      { start: new Date('2026-11-15T03:00:00Z'), end: new Date('2026-11-15T15:00:00Z') },
    ]);
    expect(await openIntervals(db.client, { branchId: ids['nsk-1']!, date: '2025-12-31' as LocalDate })).toEqual([]);
  });

  it('openIntervals: выходной и смена графика с даты (valid_to включительно)', async () => {
    await db.client.query(`UPDATE app.branch_weekly_hours SET valid_to = '2026-11-30' WHERE branch_id = $1 AND weekday = 2`, [ids['msk-1']]);
    await db.client.query(
      `INSERT INTO app.branch_weekly_hours (branch_id, weekday, is_closed, valid_from, created_by) VALUES ($1, 2, true, '2026-12-01', $2)`,
      [ids['msk-1'], SYS],
    );
    expect(await openIntervals(db.client, { branchId: ids['msk-1']!, date: '2026-11-24' as LocalDate })).toHaveLength(1);
    expect(await openIntervals(db.client, { branchId: ids['msk-1']!, date: '2026-12-01' as LocalDate })).toEqual([]);
  });

  it('openIntervalsBulk – одинаковые интервалы на каждый ресурс', async () => {
    const m = await openIntervalsBulk(db.client, {
      branchId: ids['nsk-1']!,
      date: '2026-11-15' as LocalDate,
      resources: [{ resourceId: 'r1', roomId: null }, { resourceId: 'r2', roomId: 'room' }],
    });
    expect(m.get('r1')).toEqual(m.get('r2'));
    expect(m.get('r1')).toHaveLength(1);
  });
});

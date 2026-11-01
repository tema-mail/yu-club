// S1-03: календарь филиала – схема 0103 и открытые интервалы по приоритету ресурс → комната → филиал → неделя (K13 §Проверка).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LocalDate, TimeZone } from '../../apps/api/src/core/time.ts';
import { openIntervals, openIntervalsBulk, resolveDay } from '../../apps/api/src/modules/network/calendar.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

let db: TestDatabase;
const ids: Record<string, string> = {};
const SYS = '00000000-0000-4000-8000-000000000000';
const ROOM = randomUUID();
const RES = randomUUID();
const D = '2026-11-15' as LocalDate;

const iso = (xs: Array<{ start: Date; end: Date }>) => xs.map((i) => [i.start.toISOString(), i.end.toISOString()]);

async function asApp<T>(fn: () => Promise<T>): Promise<T> {
  await db.client.query('SET ROLE yu_app');
  try {
    return await fn();
  } finally {
    await db.client.query('RESET ROLE');
  }
}

async function branch(key: string, tz: string): Promise<void> {
  const c = await db.client.query<{ id: string }>(
    `INSERT INTO app.cities (code, slug, name, timezone) VALUES ($1, $1, $1, $2) RETURNING id`,
    [`c-${key}`, tz],
  );
  const r = await db.client.query<{ id: string }>(
    `INSERT INTO app.branches (city_id, code, slug, name, address, timezone, status) VALUES ($1, $2, $2, $2, 'адрес', $3, 'active') RETURNING id`,
    [c.rows[0]!.id, key, tz],
  );
  ids[key] = r.rows[0]!.id;
  await db.client.query(
    `INSERT INTO app.branch_weekly_hours (branch_id, weekday, open_time, close_time, valid_from, created_by)
     SELECT $1, wd, '10:00', '22:00', '2026-01-01', $2 FROM generate_series(1, 7) wd`,
    [ids[key], SYS],
  );
}

function exception(
  branchKey: string,
  scope: 'branch' | 'room' | 'resource',
  date: string,
  kind: string,
  open: string | null = null,
  close: string | null = null,
) {
  return db.client.query<{ id: string }>(
    `INSERT INTO app.calendar_exceptions (branch_id, scope_type, room_id, resource_id, local_date, kind, open_time, close_time, reason, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'проверка', $9) RETURNING id`,
    [ids[branchKey], scope, scope === 'room' ? ROOM : null, scope === 'resource' ? RES : null, date, kind, open, close, SYS],
  );
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  await branch('msk', 'Europe/Moscow');
  await branch('nsk', 'Asia/Novosibirsk');
  await branch('ber', 'Europe/Berlin');
});
afterAll(async () => {
  await db.drop();
});

describe('0103: схема исключений', () => {
  it('одно активное исключение на объект и дату – EXCLUDE; разные объекты одной даты – можно', async () => {
    await exception('msk', 'branch', '2026-12-01', 'closed');
    await expect(exception('msk', 'branch', '2026-12-01', 'short_day', '10:00', '18:00')).rejects.toMatchObject({ code: '23P01' });
    await exception('msk', 'room', '2026-12-01', 'closed');
    await exception('msk', 'resource', '2026-12-01', 'closed');
    await exception('nsk', 'branch', '2026-12-01', 'closed');
  });

  it('отменённое не мешает новому; удаление у yu_app отозвано', async () => {
    const a = await exception('msk', 'branch', '2026-12-02', 'closed');
    await db.client.query(`UPDATE app.calendar_exceptions SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2 WHERE id = $1`, [a.rows[0]!.id, SYS]);
    await exception('msk', 'branch', '2026-12-02', 'holiday');
    await expect(asApp(() => db.client.query('DELETE FROM app.calendar_exceptions'))).rejects.toMatchObject({ code: '42501' });
  });

  it('CHECK: закрытие без часов, сокращённый – с часами и close > open, объект по типу', async () => {
    await expect(exception('msk', 'branch', '2026-12-03', 'closed', '10:00', '12:00')).rejects.toMatchObject({ code: '23514' });
    await expect(exception('msk', 'branch', '2026-12-03', 'short_day')).rejects.toMatchObject({ code: '23514' });
    await expect(exception('msk', 'branch', '2026-12-03', 'special_hours', '18:00', '10:00')).rejects.toMatchObject({ code: '23514' });
    await expect(
      db.client.query(
        `INSERT INTO app.calendar_exceptions (branch_id, scope_type, room_id, local_date, kind, reason, created_by) VALUES ($1, 'branch', $2, '2026-12-03', 'closed', 'x', $3)`,
        [ids.msk, ROOM, SYS],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(exception('msk', 'branch', '2026-12-03', 'vacation')).rejects.toMatchObject({ code: '23514' });
  });
});

describe('openIntervals: приоритет ресурс → комната → филиал → неделя', () => {
  it('недельный 10–22 по Москве; без исключений комната и ресурс те же', async () => {
    const w = await openIntervals(db.client, { branchId: ids.msk!, date: D });
    expect(iso(w)).toEqual([['2026-11-15T07:00:00.000Z', '2026-11-15T19:00:00.000Z']]);
    expect(await openIntervals(db.client, { branchId: ids.msk!, date: D, roomId: ROOM, resourceId: RES })).toEqual(w);
  });

  it('сокращённый день филиала 10–18 → закрытие комнаты перекрывает → спецчасы ресурса перекрывают комнату', async () => {
    await exception('msk', 'branch', D, 'short_day', '10:00', '18:00');
    expect(iso(await openIntervals(db.client, { branchId: ids.msk!, date: D }))).toEqual([['2026-11-15T07:00:00.000Z', '2026-11-15T15:00:00.000Z']]);
    await exception('msk', 'room', D, 'closed');
    expect(await openIntervals(db.client, { branchId: ids.msk!, date: D, roomId: ROOM })).toEqual([]);
    expect(await openIntervals(db.client, { branchId: ids.msk!, date: D, roomId: ROOM, resourceId: randomUUID() })).toEqual([]);
    await exception('msk', 'resource', D, 'special_hours', '12:00', '16:00');
    expect(iso(await openIntervals(db.client, { branchId: ids.msk!, date: D, roomId: ROOM, resourceId: RES }))).toEqual([
      ['2026-11-15T09:00:00.000Z', '2026-11-15T13:00:00.000Z'],
    ]);
    // ресурс без комнаты – правило филиала
    expect(iso(await openIntervals(db.client, { branchId: ids.msk!, date: D, resourceId: randomUUID() }))).toEqual([
      ['2026-11-15T07:00:00.000Z', '2026-11-15T15:00:00.000Z'],
    ]);
    // соседняя дата не задета
    expect(iso(await openIntervals(db.client, { branchId: ids.msk!, date: '2026-11-16' as LocalDate }))).toEqual([
      ['2026-11-16T07:00:00.000Z', '2026-11-16T19:00:00.000Z'],
    ]);
  });

  it('openIntervalsBulk на тех же данных совпадает с поштучным', async () => {
    const list = [
      { resourceId: RES, roomId: ROOM },
      { resourceId: randomUUID(), roomId: ROOM },
      { resourceId: randomUUID(), roomId: null },
    ];
    const bulk = await openIntervalsBulk(db.client, { branchId: ids.msk!, date: D, resources: list });
    for (const r of list) expect(bulk.get(r.resourceId)).toEqual(await openIntervals(db.client, { branchId: ids.msk!, date: D, ...r }));
  });

  it('выходной, праздник, техдень → []; нет филиала → []', async () => {
    await exception('nsk', 'branch', '2026-11-20', 'holiday');
    expect(await openIntervals(db.client, { branchId: ids.nsk!, date: '2026-11-20' as LocalDate })).toEqual([]);
    await db.client.query(`UPDATE app.branch_weekly_hours SET is_closed = true, open_time = NULL, close_time = NULL WHERE branch_id = $1 AND weekday = 1`, [ids.nsk]);
    expect(await openIntervals(db.client, { branchId: ids.nsk!, date: '2026-11-16' as LocalDate })).toEqual([]);
    expect(await openIntervals(db.client, { branchId: randomUUID(), date: D })).toEqual([]);
    expect(await openIntervals(db.client, { branchId: 'не-uuid', date: D })).toEqual([]);
  });
});

describe('зона филиала: граница суток и переход времени', () => {
  it('одни «10:00» в Москве и Новосибирске – разные UTC', async () => {
    const msk = await openIntervals(db.client, { branchId: ids.msk!, date: '2026-11-17' as LocalDate });
    const nsk = await openIntervals(db.client, { branchId: ids.nsk!, date: '2026-11-17' as LocalDate });
    expect(msk[0]!.start.toISOString()).toBe('2026-11-17T07:00:00.000Z');
    expect(nsk[0]!.start.toISOString()).toBe('2026-11-17T03:00:00.000Z');
  });

  it('спецчасы 00:00–06:00 в Новосибирске начинаются накануне по UTC', async () => {
    await exception('nsk', 'branch', '2026-11-18', 'special_hours', '00:00', '06:00');
    expect(iso(await openIntervals(db.client, { branchId: ids.nsk!, date: '2026-11-18' as LocalDate }))).toEqual([
      ['2026-11-17T17:00:00.000Z', '2026-11-17T23:00:00.000Z'],
    ]);
  });

  it('день перехода на летнее время (Берлин, 29.03.2026): 01:00–04:00 длится 2 часа', async () => {
    await exception('ber', 'branch', '2026-03-29', 'special_hours', '01:00', '04:00');
    expect(iso(await openIntervals(db.client, { branchId: ids.ber!, date: '2026-03-29' as LocalDate }))).toEqual([
      ['2026-03-29T00:00:00.000Z', '2026-03-29T02:00:00.000Z'],
    ]);
    // обычный день до перехода: 10:00 Берлина = 09:00 UTC
    expect((await openIntervals(db.client, { branchId: ids.ber!, date: '2026-03-28' as LocalDate }))[0]!.start.toISOString()).toBe(
      '2026-03-28T09:00:00.000Z',
    );
  });
});

describe('resolveDay – чистое правило', () => {
  const tz = 'Europe/Moscow' as TimeZone;
  const ex = (scope: 'branch' | 'room' | 'resource', kind: 'closed' | 'short_day', id = 'x') => ({
    id: randomUUID(),
    branchId: 'b',
    scope: scope === 'branch' ? ({ type: 'branch' } as const) : ({ type: scope, id } as const),
    date: D,
    kind,
    open: kind === 'closed' ? null : ('10:00' as never),
    close: kind === 'closed' ? null : ('12:00' as never),
    reason: 'r',
    status: 'active' as const,
    createdBy: SYS,
    createdAt: new Date(),
  });

  it('нет строки графика → закрыто; исключение другой даты и отменённое не действуют', () => {
    expect(resolveDay({ date: D, tz, weekly: null, exceptions: [], target: {} })).toEqual([]);
    const other = { ...ex('branch', 'closed'), date: '2026-11-16' as LocalDate };
    const cancelled = { ...ex('branch', 'closed'), status: 'cancelled' as const };
    const weekly = { closed: false as const, open: '10:00' as never, close: '22:00' as never };
    expect(resolveDay({ date: D, tz, weekly, exceptions: [other, cancelled], target: {} })).toHaveLength(1);
  });

  it('исключение ресурса чужого id не применяется', () => {
    const weekly = { closed: false as const, open: '10:00' as never, close: '22:00' as never };
    expect(resolveDay({ date: D, tz, weekly, exceptions: [ex('resource', 'closed', 'r1')], target: { resourceId: 'r2' } })).toHaveLength(1);
    expect(resolveDay({ date: D, tz, weekly, exceptions: [ex('resource', 'closed', 'r1')], target: { resourceId: 'r1' } })).toEqual([]);
  });
});

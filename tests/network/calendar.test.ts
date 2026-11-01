// S1-03: календарь филиала – схема 0103 и открытые интервалы по приоритету ресурс → комната → филиал → неделя (K13 §Проверка);
// изменение графика и исключений: брони не трогаются, до сохранения – список затронутых (TC-17 частично).
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { AppError } from '../../apps/api/src/core/errors.ts';
import type { AccessContext, StaffRole } from '../../apps/api/src/core/permissions.ts';
import { fixedClock, type LocalDate, type TimeZone } from '../../apps/api/src/core/time.ts';
import {
  applyHoursChange,
  calendarDenialOf,
  getWeeklyHours,
  listExceptions,
  openIntervals,
  openIntervalsBulk,
  previewHoursChange,
  resolveDay,
  type AffectedBookingsProvider,
  type CalendarDeps,
  type FutureBooking,
} from '../../apps/api/src/modules/network/calendar.ts';
import * as network from '../../apps/api/src/modules/network/index.ts';
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
  await branch('chg', 'Europe/Moscow');
  await branch('other', 'Asia/Novosibirsk');
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
});
afterAll(async () => {
  await pool.end();
  await db.drop();
});

let pool: pg.Pool;

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

// ---- изменения графика (previewHoursChange / applyHoursChange)

const clock = fixedClock('2026-11-14T05:00:00Z'); // суббота 08:00 по Москве
function ctx(role: StaffRole, scope: { cityIds?: string[]; branchIds?: string[] } = {}): AccessContext {
  return {
    actor: { kind: 'staff', staffId: randomUUID(), sessionId: randomUUID() },
    role,
    network: role === 'owner',
    cityIds: new Set(scope.cityIds ?? []),
    branchIds: new Set(scope.branchIds ?? []),
    at: clock.now(),
  };
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

async function fails(p: Promise<unknown>, code: string): Promise<AppError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
  return err as AppError;
}

/** Брони «в памяти» вместо модуля booking: фиксируем вызовы и проверяем, что брони не меняются. */
function bookingsStub(list: FutureBooking[]): AffectedBookingsProvider & { calls: Array<{ from: Date; to: Date | null }> } {
  const calls: Array<{ from: Date; to: Date | null }> = [];
  return {
    calls,
    futureBookings: async (_db, input) => {
      calls.push({ from: input.from, to: input.to });
      return list.filter((b) => b.end > input.from && (input.to === null || b.start < input.to));
    },
  };
}
const booking = (id: string, start: string, end: string, roomId: string | null = null, resourceId = randomUUID()): FutureBooking => ({
  id,
  resourceId,
  roomId,
  start: new Date(start),
  end: new Date(end),
});

describe('исключение: сокращение часов со списком затронутых (TC-17 частично)', () => {
  const late = booking(randomUUID(), '2026-11-20T17:00:00Z', '2026-11-20T18:00:00Z'); // 20:00–21:00 Москвы
  const early = booking(randomUUID(), '2026-11-20T09:00:00Z', '2026-11-20T10:00:00Z'); // 12:00–13:00
  const other = booking(randomUUID(), '2026-11-21T17:00:00Z', '2026-11-21T18:00:00Z'); // другой день
  const short = { kind: 'exception', branchId: '', scope: { type: 'branch' }, date: '2026-11-20', exceptionKind: 'short_day', open: '10:00', close: '18:00', reason: 'санитарный день' };

  it('предпросмотр: затронута только бронь 20:00–21:00; провайдер спрошен за сутки филиала', async () => {
    const stub = bookingsStub([late, early, other]);
    const deps: CalendarDeps = { clock, bookings: stub };
    const p = await previewHoursChange(pool, owner, { ...short, branchId: ids.chg }, deps);
    expect(p.affectedBookingIds).toEqual([late.id]);
    expect(stub.calls).toEqual([{ from: new Date('2026-11-19T21:00:00Z'), to: new Date('2026-11-20T21:00:00Z') }]);
    expect((await db.client.query('SELECT count(*)::int n FROM app.calendar_exceptions WHERE branch_id = $1', [ids.chg])).rows[0].n).toBe(0);
  });

  it('применение с устаревшим списком → AFFECTED_CHANGED с текущим; с верным – сохранено, бронь не тронута', async () => {
    const deps: CalendarDeps = { clock, bookings: bookingsStub([late, early]) };
    const stale = await fails(tx((t) => applyHoursChange(t, owner, { ...short, branchId: ids.chg, confirmedAffected: [] }, meta(owner), deps)), 'AFFECTED_CHANGED');
    expect(stale.details).toEqual({ affectedBookingIds: [late.id] });
    await fails(tx((t) => applyHoursChange(t, owner, { ...short, branchId: ids.chg }, meta(owner), deps)), 'VALIDATION_FAILED');
    const before = JSON.stringify([late, early]);
    const r = await tx((t) => applyHoursChange(t, owner, { ...short, branchId: ids.chg, confirmedAffected: [late.id] }, meta(owner), deps));
    expect(r).toMatchObject({ kind: 'exception', affectedBookingIds: [late.id], exception: { kind: 'short_day', open: '10:00', close: '18:00', date: '2026-11-20' } });
    expect(JSON.stringify([late, early])).toBe(before);
    expect(iso(await openIntervals(pool, { branchId: ids.chg!, date: '2026-11-20' as LocalDate }))).toEqual([['2026-11-20T07:00:00.000Z', '2026-11-20T15:00:00.000Z']]);
    const a = await db.client.query(`SELECT action, object_type, reason, after FROM journal.audit_events WHERE object_id = $1`, [
      r.kind === 'exception' ? r.exception.id : '',
    ]);
    expect(a.rows).toEqual([expect.objectContaining({ action: 'calendar.exception_created', object_type: 'calendar_exception', reason: 'санитарный день' })]);
    expect(a.rows[0].after.affectedBookingIds).toEqual([late.id]);
  });

  it('второе исключение на ту же дату и объект – SCHEDULE_CONFLICT до сохранения', async () => {
    const e = await fails(previewHoursChange(pool, owner, { ...short, branchId: ids.chg, exceptionKind: 'closed', open: undefined, close: undefined }, { clock }), 'SCHEDULE_CONFLICT');
    expect(e.details?.exceptionId).toEqual(expect.any(String));
  });

  it('отмена исключения: часы вернулись к неделе, запись аудита; повторная отмена – 404', async () => {
    const list = await listExceptions(pool, owner, ids.chg!, { from: '2026-11-20', to: '2026-11-20' });
    const id = list.items[0]!.id;
    const cancel = { kind: 'cancel_exception', branchId: ids.chg, exceptionId: id, reason: 'передумали' };
    await tx((t) => applyHoursChange(t, owner, { ...cancel, confirmedAffected: [] }, meta(owner), { clock }));
    expect(iso(await openIntervals(pool, { branchId: ids.chg!, date: '2026-11-20' as LocalDate }))).toEqual([['2026-11-20T07:00:00.000Z', '2026-11-20T19:00:00.000Z']]);
    const a = await db.client.query(`SELECT action FROM journal.audit_events WHERE object_id = $1 ORDER BY occurred_at`, [id]);
    expect(a.rows.map((x) => x.action)).toEqual(['calendar.exception_created', 'calendar.exception_cancelled']);
    await fails(tx((t) => applyHoursChange(t, owner, { ...cancel, confirmedAffected: [] }, meta(owner), { clock })), 'NOT_FOUND');
    // отменённое видно в истории
    const after = await listExceptions(pool, owner, ids.chg!, { from: '2026-11-20', to: '2026-11-20' });
    expect(after.items.map((x) => x.status)).toEqual(['cancelled']);
  });

  it('исключение комнаты: без модуля ресурсов – 404; с ним – затронута только бронь этой комнаты', async () => {
    const room = { kind: 'exception', branchId: ids.chg, scope: { type: 'room', id: ROOM }, date: '2026-11-21', exceptionKind: 'technical', reason: 'ремонт' };
    await fails(previewHoursChange(pool, owner, room, { clock }), 'NOT_FOUND');
    const inRoom = booking(randomUUID(), '2026-11-21T09:00:00Z', '2026-11-21T10:00:00Z', ROOM);
    const elsewhere = booking(randomUUID(), '2026-11-21T09:00:00Z', '2026-11-21T10:00:00Z', randomUUID());
    const targets = { belongsToBranch: async (_db: unknown, t: { id: string }, b: string) => t.id === ROOM && b === ids.chg };
    const deps: CalendarDeps = { clock, bookings: bookingsStub([inRoom, elsewhere]), targets };
    expect((await previewHoursChange(pool, owner, room, deps)).affectedBookingIds).toEqual([inRoom.id]);
    await tx((t) => applyHoursChange(t, owner, { ...room, confirmedAffected: [inRoom.id] }, meta(owner), deps));
    expect(await openIntervals(pool, { branchId: ids.chg!, date: '2026-11-21' as LocalDate, roomId: ROOM })).toEqual([]);
    expect(await openIntervals(pool, { branchId: ids.chg!, date: '2026-11-21' as LocalDate })).toHaveLength(1);
  });

  it('проверки: прошлое, часы, права', async () => {
    const base = { ...short, branchId: ids.chg, date: '2026-11-25' };
    await fails(previewHoursChange(pool, owner, { ...base, date: '2026-11-13' }, { clock }), 'VALIDATION_FAILED');
    await fails(previewHoursChange(pool, owner, { ...base, open: '18:00', close: '10:00' }, { clock }), 'INVALID_HOURS');
    await fails(previewHoursChange(pool, owner, { ...base, close: undefined }, { clock }), 'INVALID_HOURS');
    await fails(previewHoursChange(pool, owner, { ...base, exceptionKind: 'closed' }, { clock }), 'INVALID_HOURS');
    await fails(previewHoursChange(pool, owner, { ...base, open: '25:00' }, { clock }), 'VALIDATION_FAILED');
    const stranger = ctx('director', { branchIds: [ids.other!] });
    const nf = await fails(previewHoursChange(pool, stranger, base, { clock }), 'NOT_FOUND');
    expect(calendarDenialOf(nf)).toMatchObject({ action: 'calendar.exception_created', branchId: ids.chg });
    const missing = await fails(previewHoursChange(pool, stranger, { ...base, branchId: randomUUID() }, { clock }), 'NOT_FOUND');
    expect(nf.message).toBe(missing.message);
    const admin = ctx('admin', { branchIds: [ids.chg!] });
    const fb = await fails(previewHoursChange(pool, admin, base, { clock }), 'FORBIDDEN');
    expect(calendarDenialOf(fb)?.reason).toBe('FORBIDDEN: network.hours.manage');
    const director = ctx('director', { branchIds: [ids.chg!] });
    expect(await previewHoursChange(pool, director, base, { clock })).toEqual({ affectedBookingIds: [] });
  });
});

describe('недельный график: новая строка с даты, прошлое не переписывается', () => {
  const mondays = { kind: 'weekly', branchId: '', validFrom: '2026-11-16', days: [{ weekday: 1, open: '12:00', close: '20:00' }] };

  it('с сегодняшней даты нельзя (только исключением); день недели дважды – ошибка', async () => {
    await fails(previewHoursChange(pool, owner, { ...mondays, branchId: ids.chg, validFrom: '2026-11-14' }, { clock }), 'VALIDATION_FAILED');
    await fails(
      previewHoursChange(pool, owner, { ...mondays, branchId: ids.chg, days: [mondays.days[0], mondays.days[0]] }, { clock }),
      'VALIDATION_FAILED',
    );
    await fails(previewHoursChange(pool, owner, { ...mondays, branchId: ids.chg, days: [{ weekday: 1, open: '12:00', close: null }] }, { clock }), 'INVALID_HOURS');
  });

  it('понедельники 12–20 с 16.11: затронута бронь пн 23.11 в 20:00, не воскресная; прошлый понедельник прежний', async () => {
    const mon = booking(randomUUID(), '2026-11-23T17:00:00Z', '2026-11-23T18:00:00Z'); // пн 20:00 Москвы
    const sun = booking(randomUUID(), '2026-11-22T17:00:00Z', '2026-11-22T18:00:00Z'); // вс 20:00
    const stub = bookingsStub([mon, sun]);
    const deps: CalendarDeps = { clock, bookings: stub };
    const change = { ...mondays, branchId: ids.chg };
    expect(await previewHoursChange(pool, owner, change, deps)).toEqual({ affectedBookingIds: [mon.id] });
    expect(stub.calls[0]).toEqual({ from: new Date('2026-11-15T21:00:00Z'), to: null });
    await tx((t) => applyHoursChange(t, owner, { ...change, confirmedAffected: [mon.id] }, meta(owner), deps));
    expect(iso(await openIntervals(pool, { branchId: ids.chg!, date: '2026-11-16' as LocalDate }))).toEqual([['2026-11-16T09:00:00.000Z', '2026-11-16T17:00:00.000Z']]);
    expect(iso(await openIntervals(pool, { branchId: ids.chg!, date: '2026-11-09' as LocalDate }))).toEqual([['2026-11-09T07:00:00.000Z', '2026-11-09T19:00:00.000Z']]);
    expect(iso(await openIntervals(pool, { branchId: ids.chg!, date: '2026-11-15' as LocalDate }))).toEqual([['2026-11-15T07:00:00.000Z', '2026-11-15T19:00:00.000Z']]);
    const rows = await db.client.query(
      `SELECT to_char(valid_from, 'YYYY-MM-DD') f, to_char(valid_to, 'YYYY-MM-DD') t FROM app.branch_weekly_hours WHERE branch_id = $1 AND weekday = 1 ORDER BY valid_from`,
      [ids.chg],
    );
    expect(rows.rows).toEqual([
      { f: '2026-01-01', t: '2026-11-15' },
      { f: '2026-11-16', t: null },
    ]);
    const a = await db.client.query(`SELECT before, after FROM journal.audit_events WHERE action = 'branch.hours_changed' AND object_id = $1`, [ids.chg]);
    expect(a.rows[0].before.days).toEqual([{ weekday: 1, open: '10:00', close: '22:00' }]);
  });

  it('повтор с той же даты правит запланированную строку; выходной – is_closed; более ранняя дата при плане – SCHEDULE_CONFLICT', async () => {
    const change = { ...mondays, branchId: ids.chg, days: [{ weekday: 1, open: null, close: null }] };
    await tx((t) => applyHoursChange(t, owner, { ...change, confirmedAffected: [] }, meta(owner), { clock }));
    expect(await openIntervals(pool, { branchId: ids.chg!, date: '2026-11-23' as LocalDate })).toEqual([]);
    const n = await db.client.query(`SELECT count(*)::int n FROM app.branch_weekly_hours WHERE branch_id = $1 AND weekday = 1`, [ids.chg]);
    expect(n.rows[0].n).toBe(2);
    await fails(previewHoursChange(pool, owner, { ...change, validFrom: '2026-11-15' }, { clock }), 'SCHEDULE_CONFLICT');
  });

  it('чтение для CRM: график с будущими строками, зона филиала', async () => {
    const w = await getWeeklyHours(pool, owner, ids.chg!, clock);
    expect(w.timezone).toBe('Europe/Moscow');
    expect(w.items.filter((x) => x.weekday === 1)).toEqual([
      { weekday: 1, open: '10:00', close: '22:00', closed: false, validFrom: '2026-01-01', validTo: '2026-11-15' },
      { weekday: 1, open: null, close: null, closed: true, validFrom: '2026-11-16', validTo: null },
    ]);
    await fails(getWeeklyHours(pool, ctx('admin', { branchIds: [ids.other!] }), ids.chg!, clock), 'NOT_FOUND');
    await fails(listExceptions(pool, owner, ids.chg!, { from: '2026-01-01', to: '2027-06-01' }), 'VALIDATION_FAILED');
  });

  it('index.ts отдаёт те же openIntervals (K13 – один вход модуля)', async () => {
    expect(network.openIntervals).toBe(openIntervals);
    expect(network.previewHoursChange).toBe(previewHoursChange);
  });
});

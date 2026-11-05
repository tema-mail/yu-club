// S4-59: openIntervalsRange (K13, K24 §3.3) – пакетный расчёт расписания для отчётов. Свойство: для каждого дня
// диапазона результат = openIntervalsBulk того же дня (случайные графики и исключения ресурса, комнаты, филиала);
// 31 день × 20 ресурсов – число запросов к базе не зависит от числа дней; переход на летнее время; исключение одной даты.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../../apps/api/src/core/audit.ts';
import { addDays, type LocalDate } from '../../apps/api/src/core/time.ts';
import { openIntervalsBulk, openIntervalsRange } from '../../apps/api/src/modules/network/calendar.ts';
import { createTestBranch } from '../helpers/network.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

let db: TestDatabase;
const SYS = '00000000-0000-4000-8000-000000000000';
const iso = (xs: Array<{ start: Date; end: Date }>) => xs.map((i) => [i.start.toISOString(), i.end.toISOString()]);

function counting(inner: Db): Db & { count: number } {
  const c = {
    count: 0,
    query: ((text: string, values?: unknown[]) => {
      c.count++;
      return inner.query(text, values);
    }) as Db['query'],
  };
  return c;
}

/** Детерминированный ГПСЧ (mulberry32): свойство воспроизводимо по seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function weekly(branchId: string, rows: Array<{ wd: number; open: string | null; close: string | null; from: string; to: string | null }>) {
  for (const r of rows) {
    await db.client.query(
      `INSERT INTO app.branch_weekly_hours (branch_id, weekday, open_time, close_time, is_closed, valid_from, valid_to, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [branchId, r.wd, r.open, r.close, r.open === null, r.from, r.to, SYS],
    );
  }
}

async function exception(branchId: string, e: { scope: 'branch' | 'room' | 'resource'; id?: string; date: string; kind: string; open?: string; close?: string }) {
  await db.client.query(
    `INSERT INTO app.calendar_exceptions (branch_id, scope_type, room_id, resource_id, local_date, kind, open_time, close_time, reason, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'тест', $9) ON CONFLICT DO NOTHING`,
    [branchId, e.scope, e.scope === 'room' ? e.id : null, e.scope === 'resource' ? e.id : null, e.date, e.kind, e.open ?? null, e.close ?? null, SYS],
  );
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
});
afterAll(async () => {
  await db.drop();
});

describe('openIntervalsRange (S4-59)', () => {
  it('свойство: каждый день диапазона = openIntervalsBulk того же дня', async () => {
    for (const seed of [1, 7, 42]) {
      const r = rng(seed);
      const b = await createTestBranch(db.client, { timezone: seed === 7 ? 'Europe/Kaliningrad' : 'Asia/Novosibirsk' });
      const rooms = [randomUUID(), randomUUID()];
      const resources = Array.from({ length: 6 }, (_, i) => ({ resourceId: randomUUID(), roomId: i < 4 ? rooms[i % 2]! : null }));
      // два периода недельного графика: смена с 15-го числа
      const rows = [];
      for (let wd = 1; wd <= 7; wd++) {
        const closed = r() < 0.15;
        rows.push({ wd, open: closed ? null : `${String(8 + Math.floor(r() * 4)).padStart(2, '0')}:00`, close: closed ? null : '22:00', from: '2026-01-01', to: '2026-11-14' });
        rows.push({ wd, open: '11:00', close: `${String(20 + Math.floor(r() * 3))}:30`, from: '2026-11-15', to: null });
      }
      await weekly(b.id, rows);
      const from = '2026-11-01' as LocalDate;
      const to = '2026-11-30' as LocalDate;
      for (let k = 0; k < 25; k++) {
        const date = addDays(from, Math.floor(r() * 30));
        const scope = (['branch', 'room', 'resource'] as const)[Math.floor(r() * 3)]!;
        const id = scope === 'room' ? rooms[Math.floor(r() * 2)] : scope === 'resource' ? resources[Math.floor(r() * resources.length)]!.resourceId : undefined;
        const kind = (['closed', 'short_day', 'special_hours', 'holiday', 'technical'] as const)[Math.floor(r() * 5)]!;
        const hours = kind === 'short_day' || kind === 'special_hours' ? { open: '12:00', close: `${14 + Math.floor(r() * 6)}:00` } : {};
        await exception(b.id, { scope, ...(id ? { id } : {}), date, kind, ...hours });
      }
      const range = await openIntervalsRange(db.client, { branchId: b.id, from, to, resources });
      expect(range.size).toBe(30);
      for (let d = from; d <= to; d = addDays(d, 1)) {
        const bulk = await openIntervalsBulk(db.client, { branchId: b.id, date: d, resources });
        for (const res of resources) expect(iso(range.get(d)!.get(res.resourceId)!), `${seed} ${d} ${res.resourceId}`).toEqual(iso(bulk.get(res.resourceId)!));
      }
    }
  });

  it('31 день × 20 ресурсов: запросов к базе столько же, сколько за 1 день', async () => {
    const b = await createTestBranch(db.client, { timezone: 'Europe/Moscow' });
    await weekly(b.id, Array.from({ length: 7 }, (_, i) => ({ wd: i + 1, open: '10:00', close: '22:00', from: '2026-01-01', to: null })));
    const resources = Array.from({ length: 20 }, () => ({ resourceId: randomUUID(), roomId: null }));
    const one = counting(db.client);
    await openIntervalsRange(one, { branchId: b.id, from: '2026-12-01' as LocalDate, to: '2026-12-01' as LocalDate, resources });
    const month = counting(db.client);
    const res = await openIntervalsRange(month, { branchId: b.id, from: '2026-12-01' as LocalDate, to: '2026-12-31' as LocalDate, resources });
    expect(month.count).toBe(one.count);
    expect(month.count).toBeLessThanOrEqual(2);
    expect(res.size).toBe(31);
    expect([...res.values()].every((m) => m.size === 20)).toBe(true);
  });

  it('переход на летнее время: сутки 23 ч и 25 ч – часы по местному времени, как у openIntervalsBulk', async () => {
    const b = await createTestBranch(db.client, { timezone: 'Europe/Berlin' });
    await weekly(b.id, Array.from({ length: 7 }, (_, i) => ({ wd: i + 1, open: '00:00', close: '23:59', from: '2026-01-01', to: null })));
    const resources = [{ resourceId: randomUUID(), roomId: null }];
    const range = await openIntervalsRange(db.client, { branchId: b.id, from: '2026-03-28' as LocalDate, to: '2026-03-30' as LocalDate, resources });
    const spring = range.get('2026-03-29' as LocalDate)!.get(resources[0]!.resourceId)!;
    expect(spring[0]!.end.getTime() - spring[0]!.start.getTime()).toBe((24 * 60 - 1 - 60) * 60_000);
    for (const d of ['2026-03-28', '2026-03-29', '2026-03-30'] as LocalDate[]) {
      const bulk = await openIntervalsBulk(db.client, { branchId: b.id, date: d, resources });
      expect(iso(range.get(d)!.get(resources[0]!.resourceId)!)).toEqual(iso(bulk.get(resources[0]!.resourceId)!));
    }
    const autumn = await openIntervalsRange(db.client, { branchId: b.id, from: '2026-10-25' as LocalDate, to: '2026-10-25' as LocalDate, resources });
    const a = autumn.get('2026-10-25' as LocalDate)!.get(resources[0]!.resourceId)!;
    expect(a[0]!.end.getTime() - a[0]!.start.getTime()).toBe((24 * 60 - 1 + 60) * 60_000);
  });

  it('исключение на одну дату действует только в эту дату; нет филиала и пустой диапазон – пусто', async () => {
    const b = await createTestBranch(db.client, { timezone: 'Asia/Novosibirsk' });
    await weekly(b.id, Array.from({ length: 7 }, (_, i) => ({ wd: i + 1, open: '10:00', close: '22:00', from: '2026-01-01', to: null })));
    const resources = [{ resourceId: randomUUID(), roomId: null }];
    await exception(b.id, { scope: 'branch', date: '2026-12-10', kind: 'closed' });
    const range = await openIntervalsRange(db.client, { branchId: b.id, from: '2026-12-09' as LocalDate, to: '2026-12-11' as LocalDate, resources });
    const id = resources[0]!.resourceId;
    expect(range.get('2026-12-09' as LocalDate)!.get(id)).toHaveLength(1);
    expect(range.get('2026-12-10' as LocalDate)!.get(id)).toEqual([]);
    expect(range.get('2026-12-11' as LocalDate)!.get(id)).toHaveLength(1);
    expect((await openIntervalsRange(db.client, { branchId: randomUUID(), from: '2026-12-09' as LocalDate, to: '2026-12-11' as LocalDate, resources })).size).toBe(0);
    expect((await openIntervalsRange(db.client, { branchId: b.id, from: '2026-12-11' as LocalDate, to: '2026-12-09' as LocalDate, resources })).size).toBe(0);
  });
});

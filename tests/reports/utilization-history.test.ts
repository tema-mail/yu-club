// Ревизия K24 §3.3: загрузка считается по единицам и составам, действовавшим в периоде. Архивация и смена состава не переписывают
// историю; A – только в границах действия состава; фактическая загрузка текущего периода – A по прошедшему времени, коммерческая – по всему (D4-20).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { utilizationCalendar, utilizationReport } from '../../apps/api/src/modules/reports/utilization.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';
import { d, reportFixtures, type Fx } from '../helpers/reports.ts';

let db: TestDatabase;
let fx: Fx;
let client: string;
const utc = (h: string, day: string) => `${day}T${h}:00Z`;
const val = (m: { state: string; value?: number } | undefined) => (m?.state === 'ok' ? m.value : m?.state);
const period = (from: string, to: string) => ({ from: d(from), to: d(to) });

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  fx = await reportFixtures(db);
  client = await fx.client();
}, 60_000);
afterAll(async () => {
  await fx.close();
  await db.drop();
});

describe('загрузка: единицы и составы периода', () => {
  it('единица, созданная 05.11: A только с даты состава, дни до неё не считаются', async () => {
    const { id: branch } = await fx.branch('Asia/Novosibirsk');
    const unit = await fx.unit(branch, 'new-pc');
    const res = await fx.resource(branch, 'pc', 'ПК-новый', [unit]);
    await db.client.query(`UPDATE app.resource_units SET valid_from = '2026-11-05T00:00:00+07' WHERE resource_id = $1`, [res]);
    const before = await fx.run(fx.owner(), (env) => utilizationReport(env, { period: period('2026-11-01', '2026-11-04'), branchIds: [branch] }));
    expect(before.rows).toHaveLength(0);
    const r = await fx.run(fx.owner(), (env) => utilizationReport(env, { period: period('2026-11-03', '2026-11-06'), branchIds: [branch] }));
    expect(r.rows.map((x) => x.availableMin)).toEqual([2 * 720]);
  });

  it('ресурс ушёл в архив 03.11: 60 минут факта за 02.11 остаются, A обрезан датой архивации, позже строк нет', async () => {
    const { id: branch } = await fx.branch('Asia/Novosibirsk');
    const unit = await fx.unit(branch, 'old-pc');
    const res = await fx.resource(branch, 'pc', 'ПК-старый', [unit]);
    const b = await fx.booking({ branchId: branch, clientId: client, resourceId: res, units: [unit], start: utc('04:00', '2026-11-02') });
    await fx.visit(b);
    await db.client.query(`UPDATE app.resources SET status = 'archived', archived_at = '2026-11-03T00:00:00+07' WHERE id = $1`, [res]);
    await db.client.query(`UPDATE app.occupancy_units SET status = 'archived' WHERE id = $1`, [unit]);
    const past = await fx.run(fx.owner(), (env) => utilizationReport(env, { period: period('2026-11-02', '2026-11-04'), branchIds: [branch] }));
    expect(past.rows).toHaveLength(1);
    expect(past.rows[0]).toMatchObject({ unitId: unit, availableMin: 720, usedMin: 60, bookedMin: 60 });
    expect(val(past.metrics.used)).toBe(60);
    const after = await fx.run(fx.owner(), (env) => utilizationReport(env, { period: period('2026-11-05', '2026-11-06'), branchIds: [branch] }));
    expect(after.rows).toHaveLength(0);
  });

  it('смена состава: единица в ресурсе A до 03.11 и в ресурсе B после – одна строка, A по обоим отрезкам; связка с другой единицей – не «своя»', async () => {
    const { id: branch } = await fx.branch('Asia/Novosibirsk');
    const unit = await fx.unit(branch, 'moved');
    const other = await fx.unit(branch, 'other');
    const first = await fx.resource(branch, 'pc', 'Старый', [unit]);
    const next = await fx.resource(branch, 'pc', 'Новый', []);
    await db.client.query(`UPDATE app.resource_units SET valid_to = '2026-11-03T00:00:00+07' WHERE resource_id = $1`, [first]);
    await db.client.query(`INSERT INTO app.resource_units (resource_id, unit_id, valid_from) VALUES ($1, $2, '2026-11-03T00:00:00+07')`, [next, unit]);
    // с 04.11 у ресурса B две единицы: «своим» для единицы он быть перестаёт
    await db.client.query(`INSERT INTO app.resource_units (resource_id, unit_id, valid_from) VALUES ($1, $2, '2026-11-04T00:00:00+07')`, [next, other]);
    const r = await fx.run(fx.owner(), (env) => utilizationReport(env, { period: period('2026-11-02', '2026-11-05'), branchIds: [branch] }));
    const rows = r.rows.filter((x) => x.unitId === unit);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.availableMin).toBe(2 * 720); // 02.11 в A и 03.11 в B
    expect(rows[0]!.resourceId).toBe(next); // в строке – последний состав периода
  });

  it('прошлый период считается по его составам: единицы прошлого периода не пропадают из сравнения', async () => {
    const { id: branch } = await fx.branch('Asia/Novosibirsk');
    const unit = await fx.unit(branch, 'gone');
    const res = await fx.resource(branch, 'pc', 'Был', [unit]);
    const b = await fx.booking({ branchId: branch, clientId: client, resourceId: res, units: [unit], start: utc('04:00', '2026-11-02') });
    await fx.visit(b);
    await db.client.query(`UPDATE app.resource_units SET valid_to = '2026-11-03T00:00:00+07' WHERE resource_id = $1`, [res]);
    const fresh = await fx.unit(branch, 'fresh');
    const res2 = await fx.resource(branch, 'pc', 'Стал', [fresh]);
    await db.client.query(`UPDATE app.resource_units SET valid_from = '2026-11-03T00:00:00+07' WHERE resource_id = $1`, [res2]);
    const r = await fx.run(fx.owner(), (env) => utilizationReport(env, { period: period('2026-11-03', '2026-11-03'), branchIds: [branch] }));
    expect(r.rows.map((x) => x.unitId)).toEqual([fresh]);
    expect(r.metrics.available).toMatchObject({ value: 720, prev: 720 });
    expect(r.metrics.used).toMatchObject({ value: 0, prev: 60 });
  });

  it('текущий период: фактическая – от прошедшего времени, коммерческая – от всего периода; будущий период – недоступно', async () => {
    const { id: branch } = await fx.branch('Asia/Novosibirsk');
    const unit = await fx.unit(branch, 'now-pc');
    const res = await fx.resource(branch, 'pc', 'ПК', [unit]);
    const past = await fx.booking({ branchId: branch, clientId: client, resourceId: res, units: [unit], start: utc('04:00', '2026-11-10') });
    await fx.visit(past);
    await fx.booking({ branchId: branch, clientId: client, resourceId: res, units: [unit], start: utc('04:00', '2026-11-11'), status: 'confirmed' });
    // 10.11 06:00 UTC: открыто с 03:00 UTC – прошло 180 минут из 720 + 720
    const now = '2026-11-10T06:00:00Z';
    const r = await fx.run(fx.owner(), (env) => utilizationReport(env, { period: period('2026-11-10', '2026-11-11'), branchIds: [branch] }), now);
    expect(r.rows[0]).toMatchObject({ availableMin: 1440, availableElapsedMin: 180, usedMin: 60, bookedMin: 120 });
    expect(val(r.metrics.availableElapsed)).toBe(180);
    expect(val(r.metrics.actualLoad)).toBeCloseTo((60 / 180) * 100, 5);
    expect(val(r.metrics.commercialLoad)).toBeCloseTo((120 / 1440) * 100, 5);
    const future = await fx.run(fx.owner(), (env) => utilizationReport(env, { period: period('2026-11-12', '2026-11-13'), branchIds: [branch] }), now);
    expect(future.metrics.actualLoad).toEqual({ state: 'unavailable', reason: 'missing_input' });
    expect(val(future.metrics.commercialLoad)).toBe(0);
  });

  it('идущее посещение: факт обрезан текущим моментом, загрузка не больше 100%', async () => {
    const { id: branch } = await fx.branch('Asia/Novosibirsk');
    const unit = await fx.unit(branch, 'live');
    const res = await fx.resource(branch, 'pc', 'ПК', [unit]);
    const b = await fx.booking({ branchId: branch, clientId: client, resourceId: res, units: [unit], start: utc('03:00', '2026-11-10'), end: utc('15:00', '2026-11-10') });
    await fx.visit(b);
    const r = await fx.run(fx.owner(), (env) => utilizationReport(env, { period: period('2026-11-10', '2026-11-10'), branchIds: [branch] }), '2026-11-10T04:00:00Z');
    expect(r.rows[0]).toMatchObject({ availableElapsedMin: 60, usedMin: 60, bookedMin: 720 });
    expect(val(r.metrics.actualLoad)).toBe(100);
  });

  it('календарь единицы: по составу этой даты – до создания пусто, после – открытые интервалы', async () => {
    const { id: branch } = await fx.branch('Asia/Novosibirsk');
    const unit = await fx.unit(branch, 'cal');
    const res = await fx.resource(branch, 'pc', 'ПК', [unit]);
    await db.client.query(`UPDATE app.resource_units SET valid_from = '2026-11-05T00:00:00+07' WHERE resource_id = $1`, [res]);
    const early = await fx.run(fx.owner(), (env) => utilizationCalendar(env, { unitId: unit, date: '2026-11-04' }));
    expect(early.open).toEqual([]);
    const later = await fx.run(fx.owner(), (env) => utilizationCalendar(env, { unitId: unit, date: '2026-11-05' }));
    expect(later.open).toHaveLength(1);
  });
});

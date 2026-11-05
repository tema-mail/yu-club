// S4-64: отчёт «Загрузка ресурсов» (K24 §3.3, 14 §6). VR1 и VR2 отдельно, аренда комнаты – дополнительной строкой, PS4 не входит;
// пересекающиеся блокировки – один раз; блокировка вне часов работы не уменьшает свободное; A = 0 → unavailable/missing_input;
// неявка – не использование; часы – по зоне филиала; плановое время совпадает с openIntervalsRange; детализация = итог.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { utilizationCalendar, utilizationDetail, utilizationReport, utilizationSeries } from '../../apps/api/src/modules/reports/utilization.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';
import { d, reportFixtures, type Fx } from '../helpers/reports.ts';

let db: TestDatabase;
let fx: Fx;
let nsk: string;
let msk: string;
const u: Record<string, string> = {};
const r: Record<string, string> = {};
let client: string;
// НСК = UTC+7: часы 10:00–22:00 = 03:00–15:00 UTC, 720 минут в день
const DAY = { from: d('2026-11-02'), to: d('2026-11-02') };
const utc = (h: string, day = '2026-11-02') => `${day}T${h}:00Z`;

const val = (m: { state: string; value?: number } | undefined) => (m?.state === 'ok' ? m.value : m?.state);

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  fx = await reportFixtures(db);
  nsk = (await fx.branch('Asia/Novosibirsk')).id;
  msk = (await fx.branch('Europe/Moscow')).id;
  const room = await fx.room(nsk, 'vr');
  u.vr1 = await fx.unit(nsk, 'vr1', room);
  u.vr2 = await fx.unit(nsk, 'vr2', room);
  u.ps4 = await fx.unit(nsk, 'ps4', room);
  u.pc = await fx.unit(nsk, 'pc');
  r.vr1 = await fx.resource(nsk, 'vr_seat', 'VR1', [u.vr1], { roomId: room });
  r.vr2 = await fx.resource(nsk, 'vr_seat', 'VR2', [u.vr2], { roomId: room });
  r.whole = await fx.resource(nsk, 'room_whole', 'Комната целиком', [u.vr1, u.vr2, u.ps4], { roomId: room });
  r.pc = await fx.resource(nsk, 'pc', 'ПК-1', [u.pc]);
  client = await fx.client();
  // VR1: своя бронь 60 мин (состоялась) + неявка 60 мин
  const a = await fx.booking({ branchId: nsk, clientId: client, resourceId: r.vr1, units: [u.vr1], start: utc('04:00') });
  await fx.visit(a);
  const ns = await fx.booking({ branchId: nsk, clientId: client, resourceId: r.vr1, units: [u.vr1], start: utc('05:00'), status: 'no_show' });
  await fx.noShow(ns);
  // аренда комнаты: 120 мин на всех единицах, состоялась
  const whole = await fx.booking({ branchId: nsk, clientId: client, resourceId: r.whole, units: [u.vr1, u.vr2, u.ps4], start: utc('08:00'), end: utc('10:00') });
  await fx.visit(whole);
  // ПК: пересекающиеся блокировки 04:00–06:00 и 05:00–07:00 (ремонт) = 180 мин один раз;
  // обслуживание 09:00–10:00 = технический простой; админская 11:00–12:00 – в блокировках, но не в простое;
  // блокировка ночью вне часов работы 16:00–18:00 UTC не считается
  await fx.block(nsk, [u.pc], utc('04:00'), utc('06:00'), 'repair');
  await fx.block(nsk, [u.pc], utc('05:00'), utc('07:00'), 'repair');
  await fx.block(nsk, [u.pc], utc('09:00'), utc('10:00'), 'maintenance');
  await fx.block(nsk, [u.pc], utc('11:00'), utc('12:00'), 'other');
  await fx.block(nsk, [u.pc], utc('16:00'), utc('18:00'), 'repair');
  // бронь ПК внутри блокировки: свободное не вычитает пересечение дважды
  const pcBk = await fx.booking({ branchId: nsk, clientId: client, resourceId: r.pc, units: [u.pc], start: utc('06:00'), end: utc('08:00') });
  await fx.visit(pcBk);
  // прошлый день – для сравнения
  const prev = await fx.booking({ branchId: nsk, clientId: client, resourceId: r.vr2, units: [u.vr2], start: utc('04:00', '2026-11-01') });
  await fx.visit(prev);
}, 60_000);
afterAll(async () => {
  await fx.close();
  await db.drop();
});

describe('загрузка (S4-64)', () => {
  it('VR1 и VR2 отдельно, PS4 не входит; неявка – бронь, но не использование', async () => {
    const res = await fx.run(fx.owner(), (env) => utilizationReport(env, { ...{ period: DAY }, branchIds: [nsk] }));
    expect(res.rows.map((x) => x.unitName).sort()).toEqual(['pc', 'vr1', 'vr2']);
    const vr1 = res.rows.find((x) => x.unitId === u.vr1)!;
    const vr2 = res.rows.find((x) => x.unitId === u.vr2)!;
    expect(vr1).toMatchObject({ availableMin: 720, bookedMin: 60 + 60 + 120, usedMin: 60 + 120, freeMin: 720 - 240 });
    expect(vr2).toMatchObject({ availableMin: 720, bookedMin: 120, usedMin: 120 });
    expect(res.groups.wholeRoom).toEqual([{ branchId: nsk, roomId: expect.any(String), bookings: 1, minutes: 120 }]);
    expect(val(res.metrics.available)).toBe(720 * 3);
    expect(res.labels.commercialLoad).toContain('неявкой');
  });

  it('блокировки: пересечения – один раз, вне часов не считается, простой – только ремонт и обслуживание; свободное без двойного вычета', async () => {
    const res = await fx.run(fx.owner(), (env) => utilizationReport(env, { period: DAY, branchIds: [nsk], resourceType: ['pc'] }));
    const pc = res.rows[0]!;
    expect(pc.blockedMin).toBe(180 + 60 + 60); // 04–07, 09–10, 11–12
    expect(pc.technicalMin).toBe(180 + 60);
    expect(pc.bookedMin).toBe(120); // 06–08
    // занято объединением: 04–08 и 09–10 и 11–12 = 240 + 60 + 60 = 360; 06–07 не вычтено дважды
    expect(pc.freeMin).toBe(720 - 360);
    expect(pc.usedMin).toBe(120);
    // A не уменьшена ремонтом: загрузка не поднимается
    expect(pc.availableMin).toBe(720);
    expect(val(res.metrics.actualLoad)).toBeCloseTo((120 / 720) * 100, 6);
    expect(val(res.metrics.commercialLoad)).toBeCloseTo((120 / 720) * 100, 6);
  });

  it('A = 0 → unavailable/missing_input; нет единиц – no_data; закрытие филиала уже вычтено; прошлый период', async () => {
    await fx.exception(nsk, '2026-11-03', 'closed');
    const closed = await fx.run(fx.owner(), (env) => utilizationReport(env, { period: { from: d('2026-11-03'), to: d('2026-11-03') }, branchIds: [nsk] }));
    expect(val(closed.metrics.available)).toBe(0);
    expect(closed.metrics.actualLoad).toEqual({ state: 'unavailable', reason: 'missing_input' });
    const none = await fx.run(fx.owner(), (env) => utilizationReport(env, { period: DAY, branchIds: [msk] }));
    expect(none.metrics.available).toEqual({ state: 'no_data' });
    const res = await fx.run(fx.owner(), (env) => utilizationReport(env, { period: DAY, branchIds: [nsk] }));
    // 01.11: одна бронь VR2 60 мин
    expect(res.metrics.used).toMatchObject({ prev: 60 });
  });

  it('детализация = итог: сумма по единицам совпадает с показателем, доля – отдельно по единице', async () => {
    const report = await fx.run(fx.owner(), (env) => utilizationReport(env, { period: DAY, branchIds: [nsk] }));
    for (const key of ['available', 'blocked', 'technical', 'booked', 'used', 'free'] as const) {
      const det = await fx.run(fx.owner(), (env) => utilizationDetail(env, { period: DAY, branchIds: [nsk] }, key));
      expect(det.rows.reduce((s, x) => s + x.value!, 0), key).toBe(val(report.metrics[key]));
      expect(val(det.total), key).toBe(val(report.metrics[key]));
    }
    const load = await fx.run(fx.owner(), (env) => utilizationDetail(env, { period: DAY, branchIds: [nsk] }, 'actualLoad'));
    expect(load.rows.find((x) => x.unitId === u.vr2)!.value).toBeCloseTo((120 / 720) * 100, 6);
    await expect(fx.run(fx.owner(), (env) => utilizationDetail(env, { period: DAY }, 'нет'))).rejects.toMatchObject({ code: 'REPORT_FILTER_INVALID' });
  });

  it('график: часы – по зоне филиала; сумма по часам и дням = итог', async () => {
    const hours = await fx.run(fx.owner(), (env) => utilizationSeries(env, { period: DAY, branchIds: [nsk], resourceType: ['vr_seat'] }, 'hour'));
    // бронь 04:00 UTC = 11:00 НСК
    expect(hours.points.find((x) => x.bucket === '11')).toMatchObject({ availableMin: 120, usedMin: 60, bookedMin: 60 });
    expect(hours.points.find((x) => x.bucket === '04')).toBeUndefined(); // вне часов работы
    expect(hours.zoneNote).toBeNull();
    const report = await fx.run(fx.owner(), (env) => utilizationReport(env, { period: DAY, branchIds: [nsk], resourceType: ['vr_seat'] }));
    expect(hours.points.reduce((s, x) => s + x.usedMin, 0)).toBe(val(report.metrics.used));
    const days = await fx.run(fx.owner(), (env) => utilizationSeries(env, { period: { from: d('2026-11-01'), to: d('2026-11-02') }, branchIds: [nsk], resourceType: ['vr_seat'] }, 'day'));
    expect(days.points.map((x) => x.bucket)).toEqual(['2026-11-01', '2026-11-02']);
    expect(days.points[0]).toMatchObject({ availableMin: 1440, usedMin: 60 });
    const pc2 = await fx.unit(msk, 'pc');
    await fx.resource(msk, 'pc', 'ПК', [pc2]);
    const net = await fx.run(fx.owner(), (env) => utilizationSeries(env, { period: DAY }, 'hour'));
    expect(net.zoneNote).toContain('местному');
  });

  it('календарь единицы: открыто, брони, блокировки, свободно; чужая зона – 404', async () => {
    const c = await fx.run(fx.owner(), (env) => utilizationCalendar(env, { unitId: u.pc, date: '2026-11-02' }));
    expect(c.open).toEqual([{ start: '2026-11-02T03:00:00.000Z', end: '2026-11-02T15:00:00.000Z' }]);
    expect(c.booked).toEqual([{ start: '2026-11-02T06:00:00.000Z', end: '2026-11-02T08:00:00.000Z' }]);
    expect(c.blocked.map((x) => x.start)).toEqual(['2026-11-02T04:00:00.000Z', '2026-11-02T09:00:00.000Z', '2026-11-02T11:00:00.000Z']);
    expect(c.free).toEqual([
      { start: '2026-11-02T03:00:00.000Z', end: '2026-11-02T04:00:00.000Z' },
      { start: '2026-11-02T08:00:00.000Z', end: '2026-11-02T09:00:00.000Z' },
      { start: '2026-11-02T10:00:00.000Z', end: '2026-11-02T11:00:00.000Z' },
      { start: '2026-11-02T12:00:00.000Z', end: '2026-11-02T15:00:00.000Z' },
    ]);
    await expect(fx.run(fx.director([msk]), (env) => utilizationCalendar(env, { unitId: u.pc, date: '2026-11-02' }))).rejects.toMatchObject({ httpStatus: 404 });
    await expect(fx.run(fx.director([msk]), (env) => utilizationReport(env, { period: DAY, branchIds: [nsk] }))).rejects.toMatchObject({ httpStatus: 404 });
  });
});

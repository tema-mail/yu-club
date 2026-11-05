// S4-66: отчёт «Клиенты и повторные посещения» (K24 §3.6, 14 §9). «Впервые» и «вернувшиеся» не пересекаются; гости не входят;
// итог сети ≠ сумме филиалов (подпись); новый профиль ≠ первый визит; детализация = итог; маска; область Директора.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clientsDetail, clientsReport, type ClientsMetric } from '../../apps/api/src/modules/reports/clients.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';
import { d, reportFixtures, type Fx } from '../helpers/reports.ts';

const OCT = { from: d('2026-10-01'), to: d('2026-10-31') };
let db: TestDatabase;
let fx: Fx;
let b1: string;
let b2: string;
const c: Record<string, string> = {};

const val = (m: { state: string; value?: number } | undefined) => (m?.state === 'ok' ? m.value : m?.state);

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  fx = await reportFixtures(db);
  b1 = (await fx.branch('Asia/Novosibirsk')).id;
  b2 = (await fx.branch('Europe/Moscow')).id;
  const r1 = await fx.resource(b1, 'pc', 'ПК1', []);
  const r2 = await fx.resource(b2, 'pc', 'ПК2', []);
  c.old = await fx.client({ firstName: 'Старый', lastName: 'Клиент', createdAt: '2026-01-05T00:00:00Z' });
  c.fresh = await fx.client({ firstName: 'Новый', lastName: 'Клиент', createdAt: '2026-10-02T05:00:00Z' });
  c.lost = await fx.client({ firstName: 'Ушедший', lastName: 'Клиент', createdAt: '2026-02-01T00:00:00Z' });
  c.noVisit = await fx.client({ firstName: 'Без', lastName: 'Визита', createdAt: '2026-10-03T05:00:00Z' });
  c.guest = await fx.client({ guest: true });
  const visit = async (branch: string, res: string, client: string, start: string) => fx.visit(await fx.booking({ branchId: branch, clientId: client, resourceId: res, start, createdAt: start }));
  // old: сентябрь и два раза в октябре (5 и 15) – вернувшийся, повторный; интервал 10 дней; в двух филиалах
  await visit(b1, r1, c.old, '2026-09-10T05:00:00Z');
  await visit(b1, r1, c.old, '2026-10-05T05:00:00Z');
  await visit(b2, r2, c.old, '2026-10-15T05:00:00Z');
  // fresh: первый раз в октябре, один раз
  await visit(b1, r1, c.fresh, '2026-10-06T05:00:00Z');
  // lost: только в сентябре – «не посещавшие в периоде»
  await visit(b1, r1, c.lost, '2026-09-20T05:00:00Z');
  // гость: приходил – в клиентских показателях его нет
  await visit(b1, r1, c.guest, '2026-10-07T05:00:00Z');
  // noVisit: профиль создан в октябре, бронь есть (связь с филиалом), посещения нет
  await fx.booking({ branchId: b1, clientId: c.noVisit, resourceId: r1, start: '2026-10-08T05:00:00Z', status: 'cancelled_by_client' });
}, 60_000);
afterAll(async () => {
  await fx.close();
  await db.drop();
});

describe('клиенты (S4-66)', () => {
  it('показатели: впервые и вернувшиеся не пересекаются, гости не входят, новый профиль ≠ первый визит', async () => {
    const r = await fx.run(fx.owner(), (env) => clientsReport(env, { period: OCT }));
    const m = r.metrics;
    expect(val(m.withVisit)).toBe(2); // old, fresh; гость не входит
    expect(val(m.firstTime)).toBe(1); // fresh
    expect(val(m.returning)).toBe(1); // old
    expect((val(m.firstTime) as number) + (val(m.returning) as number)).toBe(val(m.withVisit));
    expect(val(m.repeat)).toBe(1); // old: всего 3 посещения; fresh – одно
    expect(val(m.notVisited)).toBe(1); // lost
    expect(val(m.newProfiles)).toBe(2); // fresh и noVisit – без посещения тоже новый профиль
    expect(val(m.profileVisits)).toBe(3);
    expect(val(m.visitsPerClient)).toBe(1.5);
    expect(val(m.avgIntervalDays)).toBeCloseTo(10, 6);
    expect(m.withVisit).toMatchObject({ prev: 2 }); // сентябрь: old, lost
    expect(r.dateBasis.newProfiles).toBe('created_at');
  });

  it('итог сети ≠ сумме филиалов: один клиент в двух филиалах, есть подпись', async () => {
    const r = await fx.run(fx.owner(), (env) => clientsReport(env, { period: OCT }));
    const by = new Map(r.groups.byBranch.map((g) => [g.branchId, g.metrics]));
    expect(val(by.get(b1)!.withVisit)).toBe(2); // old и fresh
    expect(val(by.get(b2)!.withVisit)).toBe(1); // old
    expect(val(r.metrics.withVisit)).toBe(2);
    expect((val(by.get(b1)!.withVisit) as number) + (val(by.get(b2)!.withVisit) as number)).not.toBe(val(r.metrics.withVisit));
    expect(r.labels.byBranch).toContain('не равен сумме');
  });

  it('детализация = итог по каждому показателю; без client.view.full – маска; Директор – только зона', async () => {
    const report = await fx.run(fx.owner(), (env) => clientsReport(env, { period: OCT }));
    for (const key of ['withVisit', 'firstTime', 'returning', 'repeat', 'notVisited', 'profileVisits', 'newProfiles'] as ClientsMetric[]) {
      const page = await fx.run(fx.owner(), (env) => clientsDetail(env, { period: OCT }, key));
      expect(page.rows.reduce((s, x) => s + x.value, 0), key).toBe(val(report.metrics[key]));
    }
    const per = await fx.run(fx.owner(), (env) => clientsDetail(env, { period: OCT }, 'visitsPerClient'));
    expect(per.rows.reduce((s, x) => s + x.value, 0) / per.rows.length).toBe(val(report.metrics.visitsPerClient));
    const iv = await fx.run(fx.owner(), (env) => clientsDetail(env, { period: OCT }, 'avgIntervalDays'));
    expect(iv.rows.map((x) => x.clientId)).toEqual([c.old]);
    // Директор зоны b2: виден только old и новых нет; чужой филиал – 404; Администратору отчёт закрыт
    const dir = fx.director([b2]);
    const z = await fx.run(dir, (env) => clientsReport(env, { period: OCT }));
    expect(val(z.metrics.withVisit)).toBe(1);
    expect(val(z.metrics.newProfiles)).toBe(0);
    await expect(fx.run(dir, (env) => clientsDetail(env, { period: OCT, branchIds: [b1] }, 'withVisit'))).rejects.toMatchObject({ httpStatus: 404 });
    await expect(fx.run(fx.admin([b1]), (env) => clientsReport(env, { period: OCT }))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const dirRows = await fx.run(dir, (env) => clientsDetail(env, { period: OCT }, 'withVisit'));
    expect(dirRows.rows[0]!.client).toMatchObject({ name: 'Старый Клиент' }); // Директор: client.view.full в своей зоне
    expect(dirRows.rows[0]!.client!.phone).toMatch(/^\+7913/);
    await expect(fx.run(fx.owner(), (env) => clientsDetail(env, { period: OCT }, 'нет'))).rejects.toMatchObject({ code: 'REPORT_FILTER_INVALID' });
  });

  it('пустой период – no_data, интервал и посещений на клиента не считаются из нуля', async () => {
    const r = await fx.run(fx.owner(), (env) => clientsReport(env, { period: { from: d('2026-03-01'), to: d('2026-03-31') } }));
    expect(r.metrics.withVisit).toEqual({ state: 'no_data' });
    expect(r.metrics.visitsPerClient).toEqual({ state: 'no_data' });
    expect(r.metrics.avgIntervalDays).toEqual({ state: 'no_data' });
  });
});

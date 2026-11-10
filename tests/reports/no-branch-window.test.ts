// Ревизия 02b282c: записи без филиала (ручная корректировка баллов, уведомление без филиала) в сетевой области – сутки UTC, как
// дата записи K3 (staff.ts moneyWindows). Прежнее окно «от самого раннего начала суток филиалов до самого позднего конца» брало запись
// 31.10 18:00Z (уже 01.11 в Новосибирске) и в текущий период, и в прошлый, а запись 04.11 22:00Z (уже 05.11 в Москве) – не брало,
// хотя точка графика и детализация day:2026-11-04 её считали. Теперь карточка = Σ точек = детализация дня, прошлый период не пересекается.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openAccount, postPoints } from '../../apps/api/src/modules/loyalty/account.ts';
import type { Metric, ReportParams } from '../../apps/api/src/modules/reports/framework.ts';
import { HANDLERS, parseQuery, segmented } from '../../apps/api/src/modules/reports/report-handlers.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';
import { d, reportFixtures, type Fx } from '../helpers/reports.ts';

const PERIOD: ReportParams = { period: { from: d('2026-11-01'), to: d('2026-11-04') } };
const PREV: ReportParams = { period: { from: d('2026-10-28'), to: d('2026-10-31') } };
let db: TestDatabase;
let fx: Fx;

type Result = { metrics: Record<string, Metric & { prev?: number | null }>; series: { points: Array<Record<string, number | string>> } };
const val = (m: Metric | undefined) => (m?.state === 'ok' ? m.value : m?.state);

const card = (report: 'loyalty' | 'comms', p: ReportParams) => fx.run(fx.owner(), async (env) => (await HANDLERS[report]!.metrics(env, parseQuery({ series: 'day' }), p)) as unknown as Result);
async function dayDetail(report: 'loyalty' | 'comms', metric: string, day: string): Promise<Metric> {
  return fx.run(fx.owner(), async (env) => {
    const s = segmented(report, parseQuery({ metric, segment: `day:${day}` }), PERIOD);
    return (await HANDLERS[report]!.detail(env, s.q, s.p)).total as Metric;
  });
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  fx = await reportFixtures(db);
  await fx.branch('Asia/Novosibirsk'); // 01.11 начинается в 31.10 17:00Z
  await fx.branch('Europe/Moscow'); // 04.11 кончается в 04.11 21:00Z
  const client = await fx.client();
  const c = await fx.app.connect();
  try {
    await c.query('BEGIN');
    await openAccount(c, client, new Date('2026-10-01T06:00:00Z'));
    const manual = (amount: number, at: string) =>
      postPoints(c, client, { amount, type: 'loyalty.manual', branchId: null, basis: 'т', occurredAt: new Date(at) }, randomUUID(), { type: 'staff', id: fx.ownerId }, { reason: 'т' });
    await manual(30, '2026-10-31T18:00:00Z'); // 31.10 по UTC – прошлый период
    await manual(70, '2026-11-04T22:00:00Z'); // 04.11 по UTC – текущий
    await c.query('COMMIT');
  } finally {
    c.release();
  }
  let seq = 0;
  for (const at of ['2026-10-31T18:00:00Z', '2026-11-04T22:00:00Z', '2026-11-04T23:30:00Z']) {
    seq += 1;
    await db.client.query(
      `INSERT INTO app.notifications (client_id, branch_id, category, kind, source, title, body, planned_at, status, dedupe_key, created_at, push)
       VALUES ($1, NULL, 'service', 'booking_confirmed', 'system', 'т', 'т', $2, 'inbox_only', $3, $2, false)`,
      [client, at, `edge${seq}`],
    );
  }
}, 120_000);
afterAll(async () => {
  await fx.close();
  await db.drop();
});

describe('записи без филиала у края периода – сутки UTC', () => {
  it('баллы: карточка = Σ точек = детализация дня; прошлый период не пересекается с текущим', async () => {
    const r = await card('loyalty', PERIOD);
    const points = r.series.points.map((x) => [x.bucket, Number(x.adjusted)]);
    expect(points).toEqual([['2026-11-01', 0], ['2026-11-02', 0], ['2026-11-03', 0], ['2026-11-04', 70]]);
    expect(val(r.metrics.adjusted)).toBe(70);
    expect(r.metrics.adjusted).toMatchObject({ prev: 30 });
    expect(val(await dayDetail('loyalty', 'adjusted', '2026-11-04'))).toBe(70);
    expect(val((await card('loyalty', PREV)).metrics.adjusted)).toBe(30); // запись 31.10 – только в прошлом периоде
  });

  it('уведомления: то же для строк без филиала', async () => {
    const r = await card('comms', PERIOD);
    expect(r.series.points.map((x) => Number(x.serviceCreated))).toEqual([0, 0, 0, 2]);
    expect(val(r.metrics.serviceCreated)).toBe(2);
    expect(r.metrics.serviceCreated).toMatchObject({ prev: 1 });
    expect(val(await dayDetail('comms', 'serviceCreated', '2026-11-04'))).toBe(2);
  });
});

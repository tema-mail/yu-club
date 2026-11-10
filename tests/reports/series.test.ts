// K11 №240 `series`: точки графика по дням у отчётов на MetricDef (series.ts) – та же форма, что у загрузки: точка на каждый день
// периода, сутки филиала, Σ точек count/sum = итог карточки с теми же фильтрами; запись без филиала (баллы) – только в сетевой
// области; series=hour есть только у загрузки – у остальных REPORT_FILTER_INVALID. Без series точек нет (не чаще запроса отчёта).
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../apps/api/src/server.ts';
import { loadConfig } from '../../apps/api/src/config.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { recordExpense, recordIncome } from '../../apps/api/src/modules/finance/cashbox.ts';
import { openAccount, postPoints, SYSTEM_AUTHOR } from '../../apps/api/src/modules/loyalty/account.ts';
import { hashPassword, staffAuthConfig } from '../../apps/api/src/modules/staff/auth.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';
import { reportFixtures, type Fx } from '../helpers/reports.ts';

const PASSWORD = 'correct horse battery';
const BASE = '/api/crm/v1';
const clock = fixedClock('2026-11-20T05:00:00Z');
const QS = 'from=2026-11-01&to=2026-11-04';
let db: TestDatabase;
let fx: Fx;
let app: ReturnType<typeof buildServer>;
let cookie: string;
let nsk: string;
let msk: string;

type Metric = { state: string; value?: number; unit?: string };
type Point = { bucket: string } & Record<string, number | string>;
type Body = { metrics: Record<string, Metric>; series?: { points: Point[]; zoneNote: string | null }; error?: { code: string } };
const report = async (name: string, extra = ''): Promise<{ status: number; body: Body }> => {
  const res = await app.inject({ method: 'GET', url: `${BASE}/reports/${name}?${QS}${extra}`, headers: { cookie } });
  return { status: res.statusCode, body: res.json() };
};
const column = (points: Point[], key: string): number[] => points.map((p) => Number(p[key]));
const total = (points: Point[], key: string): number => column(points, key).reduce((s, v) => s + v, 0);

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  fx = await reportFixtures(db);
  const pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), { staff: { pool, auth: staffAuthConfig('t'.repeat(40)), clock }, reports: { pool: fx.reports } });
  app.addHook('onClose', () => pool.end());
  await db.client.query(`UPDATE app.staff SET email = 'owner@yu.test', password_hash = $1 WHERE id = $2`, [await hashPassword(PASSWORD), fx.ownerId]);
  const login = await app.inject({ method: 'POST', url: `${BASE}/auth/login`, payload: { email: 'owner@yu.test', password: PASSWORD } });
  cookie = String(login.headers['set-cookie']).split(';')[0]!;

  nsk = (await fx.branch('Asia/Novosibirsk')).id;
  msk = (await fx.branch('Europe/Moscow')).id;
  const client = await fx.client();
  const unit = await fx.unit(nsk, 'pc');
  const pc = await fx.resource(nsk, 'pc', 'ПК', [unit]);
  const mskUnit = await fx.unit(msk, 'pc');
  const mskPc = await fx.resource(msk, 'pc', 'ПК-М', [mskUnit]);
  // 02.11: два посещения в НСК (04:00 UTC = 11:00 НСК); 03.11: ПК в НСК и ПК в Москве
  await fx.visit(await fx.booking({ branchId: nsk, clientId: client, resourceId: pc, units: [unit], start: '2026-11-02T04:00:00Z' }));
  await fx.visit(await fx.booking({ branchId: nsk, clientId: client, resourceId: pc, units: [unit], start: '2026-11-02T06:00:00Z' }));
  await fx.visit(await fx.booking({ branchId: nsk, clientId: client, resourceId: pc, units: [unit], start: '2026-11-03T05:00:00Z' }));
  await fx.visit(await fx.booking({ branchId: msk, clientId: client, resourceId: mskPc, units: [mskUnit], start: '2026-11-03T09:00:00Z' }));
  const category = (await db.client.query<{ id: string }>(`SELECT id FROM app.finance_categories WHERE name = 'Прочее' LIMIT 1`)).rows[0]!.id;
  const money = async (fn: typeof recordIncome, body: object) => {
    const o = fx.owner(clock.now());
    const c = await fx.app.connect();
    try {
      await c.query('BEGIN');
      await fn(c, o, body, { actor: o.actor, access: o, source: 'crm', requestId: randomUUID() }, { idempotencyKey: randomUUID(), clock });
      await c.query('COMMIT');
    } finally {
      c.release();
    }
  };
  // граница суток: 03.11 20:30 UTC – это 04.11 03:30 в НСК, но 03.11 23:30 в Москве
  await money(recordIncome, { branchId: nsk, method: 'cash', amountKop: 1000, source: 'other', occurredAt: '2026-11-02T06:00:00Z' });
  await money(recordIncome, { branchId: nsk, method: 'card', amountKop: 2000, source: 'other', occurredAt: '2026-11-03T20:30:00Z' });
  await money(recordIncome, { branchId: msk, method: 'cash', amountKop: 4000, source: 'other', occurredAt: '2026-11-03T20:30:00Z' });
  await money(recordExpense, { branchId: nsk, method: 'cash', amountKop: 500, categoryId: category, occurredAt: '2026-11-02T06:00:00Z', comment: 'т' });
  // баллы: начисление в НСК 03.11, ручная корректировка без филиала 02.11 – сеть
  const c = await fx.app.connect();
  try {
    await c.query('BEGIN');
    await openAccount(c, client, new Date('2026-11-02T06:00:00Z'));
    await postPoints(c, client, { amount: 2_000, type: 'loyalty.accrual', branchId: nsk, basis: 'тест', occurredAt: new Date('2026-11-03T05:00:00Z') }, randomUUID(), SYSTEM_AUTHOR);
    await postPoints(c, client, { amount: 50, type: 'loyalty.manual', branchId: null, basis: 'тест', occurredAt: new Date('2026-11-02T06:00:00Z') }, randomUUID(), { type: 'staff', id: fx.ownerId }, { reason: 'тест' });
    await c.query('COMMIT');
  } finally {
    c.release();
  }
}, 90_000);
afterAll(async () => {
  await app.close();
  await fx.close();
  await db.drop();
});

describe('series=day по HTTP', () => {
  it('финансы: точка на каждый день периода по суткам филиала, Σ точек = карточка, без series точек нет', async () => {
    const plain = await report('finance');
    expect(plain.status).toBe(200);
    expect(plain.body.series).toBeUndefined();
    const r = await report('finance', '&series=day');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const points = r.body.series!.points;
    expect(points.map((p) => p.bucket)).toEqual(['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04']);
    expect(column(points, 'income')).toEqual([0, 1000, 4000, 2000]); // приход НСК 03.11 20:30 UTC – уже 04.11 по НСК, Москвы – ещё 03.11
    expect(r.body.series!.zoneNote).toBeNull();
    for (const key of Object.keys(points[0]!).filter((k) => k !== 'bucket')) {
      const m = r.body.metrics[key]!;
      expect([key, total(points, key)]).toEqual([key, m.state === 'ok' ? m.value : 0]);
    }
    expect(r.body.metrics.cashClosing).toBeDefined();
    expect(points[0]!.cashClosing).toBeUndefined(); // остаток – не поток, точек нет
    const one = await report('finance', `&series=day&branchIds=${msk}`);
    expect(column(one.body.series!.points, 'income')).toEqual([0, 0, 4000, 0]);
  });

  it('брони и клиенты: состоялось по дням, уникальные клиенты – по дню; клиенты – посещения профилей', async () => {
    const b = (await report('bookings', '&series=day')).body;
    expect(column(b.series!.points, 'visited')).toEqual([0, 2, 2, 0]);
    expect(column(b.series!.points, 'uniqueVisitors')).toEqual([0, 1, 1, 0]);
    expect(b.series!.points[0]!.awaitingDecision).toBeUndefined(); // показатель «на момент запроса» точек не даёт
    const c = (await report('clients', '&series=day')).body;
    expect(column(c.series!.points, 'profileVisits')).toEqual([0, 2, 2, 0]);
    expect(column(c.series!.points, 'withVisit')).toEqual([0, 1, 1, 0]);
    expect(total(c.series!.points, 'profileVisits')).toBe(c.metrics.profileVisits!.value);
  });

  it('баллы: запись без филиала – в сетевой области сутками UTC, по филиалу – только свои; Σ точек = карточка', async () => {
    const net = (await report('loyalty', '&series=day')).body;
    expect(column(net.series!.points, 'adjusted')).toEqual([0, 50, 0, 0]);
    expect(column(net.series!.points, 'accrued')).toEqual([0, 0, 2000, 0]);
    expect(total(net.series!.points, 'adjusted')).toBe(net.metrics.adjusted!.value);
    const own = (await report('loyalty', `&series=day&branchIds=${nsk}`)).body;
    expect(column(own.series!.points, 'adjusted')).toEqual([0, 0, 0, 0]);
    expect(column(own.series!.points, 'accrued')).toEqual([0, 0, 2000, 0]);
  });

  it('сертификаты, коммуникации, мероприятия, оборудование: точки есть и без данных – нули по дням', async () => {
    for (const [name, key] of [['certificates', 'salesAmount'], ['comms', 'serviceCreated'], ['events', 'count'], ['equipment', 'incidents']] as const) {
      const r = await report(name, '&series=day');
      expect([name, r.status]).toEqual([name, 200]);
      expect([name, column(r.body.series!.points, key)]).toEqual([name, [0, 0, 0, 0]]);
    }
    expect((await report('equipment', '&series=day')).body.series!.points[0]!.totalEquipment).toBeUndefined();
  });

  it('series=hour – только у загрузки; у остальных REPORT_FILTER_INVALID', async () => {
    expect((await report('utilization', '&series=hour')).status).toBe(200);
    const r = await report('finance', '&series=hour');
    expect(r.status).toBe(422);
    expect(r.body.error!.code).toBe('REPORT_FILTER_INVALID');
  });
});

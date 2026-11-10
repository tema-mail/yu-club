// Ревизия K24 §2, §10, §14, 14 §15: сегмент детализации применяется через where(spec), строки и итог – с сегментом, Σ detail = aggregate.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../apps/api/src/server.ts';
import { loadConfig } from '../../apps/api/src/config.ts';
import { AppError } from '../../apps/api/src/core/errors.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { recordExpense, recordIncome } from '../../apps/api/src/modules/finance/cashbox.ts';
import { applySegment } from '../../apps/api/src/modules/reports/segment.ts';
import { hashPassword, staffAuthConfig } from '../../apps/api/src/modules/staff/auth.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';
import { d, reportFixtures, SYS, type Fx } from '../helpers/reports.ts';

const PASSWORD = 'correct horse battery';
const BASE = '/api/crm/v1';
const clock = fixedClock('2026-11-20T05:00:00Z');
const QS = 'from=2026-11-02&to=2026-11-03';
let db: TestDatabase;
let fx: Fx;
let app: ReturnType<typeof buildServer>;
let cookie: string;
let nsk: string;
let msk: string;
let unit: string;
let category: string;

type Detail = { rows: Array<Record<string, unknown> & { value?: number }>; total: { state: string; value?: number }; nextCursor: string | null };
const detail = async (report: string, metric: string, segment?: string, extra = ''): Promise<{ status: number; body: Detail & { error?: { code: string } } }> => {
  const res = await app.inject({ method: 'GET', url: `${BASE}/reports/${report}/detail?${QS}&metric=${metric}${segment ? `&segment=${encodeURIComponent(segment)}` : ''}${extra}`, headers: { cookie } });
  return { status: res.statusCode, body: res.json() };
};

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
  unit = await fx.unit(nsk, 'pc');
  const pc = await fx.resource(nsk, 'pc', 'ПК', [unit]);
  const vrUnit = await fx.unit(nsk, 'vr');
  const vr = await fx.resource(nsk, 'vr_seat', 'VR', [vrUnit]);
  const mskUnit = await fx.unit(msk, 'pc');
  const mskPc = await fx.resource(msk, 'pc', 'ПК-М', [mskUnit]);
  // 02.11: ПК и VR в НСК, 03.11: ПК в НСК и ПК в Москве. 04:00 UTC = 11:00 по НСК
  await fx.visit(await fx.booking({ branchId: nsk, clientId: client, resourceId: pc, units: [unit], start: '2026-11-02T04:00:00Z' }));
  await fx.visit(await fx.booking({ branchId: nsk, clientId: client, resourceId: vr, units: [vrUnit], start: '2026-11-02T04:00:00Z' }));
  await fx.visit(await fx.booking({ branchId: nsk, clientId: client, resourceId: pc, units: [unit], start: '2026-11-03T05:00:00Z' }));
  await fx.visit(await fx.booking({ branchId: msk, clientId: client, resourceId: mskPc, units: [mskUnit], start: '2026-11-03T09:00:00Z' }));

  category = (await db.client.query<{ id: string }>(`SELECT id FROM app.finance_categories WHERE name = 'Прочее' LIMIT 1`)).rows[0]!.id;
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
  const at = '2026-11-02T06:00:00Z';
  await money(recordIncome, { branchId: nsk, method: 'cash', amountKop: 1000, source: 'event', occurredAt: at });
  await money(recordIncome, { branchId: nsk, method: 'card', amountKop: 2000, source: 'other', occurredAt: at });
  await money(recordIncome, { branchId: msk, method: 'cash', amountKop: 4000, source: 'other', occurredAt: '2026-11-03T06:00:00Z' });
  await money(recordExpense, { branchId: nsk, method: 'cash', amountKop: 500, categoryId: category, occurredAt: at, comment: 'т' });
  // Э3: поломки – две в НСК (02.11 и 03.11 по зоне филиала) и одна в Москве 03.11
  const cat = (await db.client.query<{ id: string }>(`INSERT INTO app.equipment_categories (name) VALUES ('VR') RETURNING id`)).rows[0]!.id;
  const item = async (branchId: string, inv: string) =>
    (await db.client.query<{ id: string }>(`INSERT INTO app.equipment_items (inventory_number, name, category_id, status, branch_id, created_by) VALUES ($1, 'Шлем', $2, 'in_service', $3, $4) RETURNING id`, [inv, cat, branchId, SYS])).rows[0]!.id;
  const repair = (n: string, equipmentId: string, branchId: string, detected: string) =>
    db.client.query(
      `INSERT INTO app.repairs (number, equipment_id, branch_id, broken_at_unknown, detected_at, registered_at, symptoms, priority, impact, created_by, status)
       VALUES ($1, $2, $3, true, $4, $4, 'не включается', 'high', 'partial', $5, 'new')`,
      [n, equipmentId, branchId, detected, SYS],
    );
  const nskItem = await item(nsk, 'INV-000001');
  await repair('R-000001', nskItem, nsk, '2026-11-02T04:00:00Z');
  await repair('R-000002', nskItem, nsk, '2026-11-03T05:00:00Z');
  await repair('R-000003', await item(msk, 'INV-000002'), msk, '2026-11-03T09:00:00Z');
}, 90_000);
afterAll(async () => {
  await app.close();
  await fx.close();
  await db.drop();
});

describe('сегмент детализации по HTTP', () => {
  it('брони: без сегмента 4, по филиалу, дню, типу ресурса – строки и итог сужаются одинаково', async () => {
    const all = await detail('bookings', 'visited');
    expect(all.body.total).toMatchObject({ value: 4 });
    for (const [segment, n] of [[`branch:${msk}`, 1], ['day:2026-11-02', 2], ['resourceType:vr_seat', 1], ['status:completed', 4]] as const) {
      const r = await detail('bookings', 'visited', segment);
      expect(r.status, segment).toBe(200);
      expect(r.body.rows, segment).toHaveLength(n);
      expect(r.body.total, segment).toMatchObject({ value: n });
    }
  });

  it('финансы: способ, источник, категория, место – Σ value строк = итог', async () => {
    const cases = [['income', 'method:cash', 5000], ['income', 'method:card', 2000], ['income', 'source:event', 1000], ['income', 'place:noncash', 2000], ['income', `branch:${msk}`, 4000], ['income', 'day:2026-11-02', 3000], ['expenses', `category:${category}`, 500]] as const;
    for (const [metric, segment, sum] of cases) {
      const r = await detail('finance', metric, segment);
      expect(r.status, segment).toBe(200);
      expect(r.body.total, segment).toMatchObject({ value: sum });
      expect(r.body.rows.reduce((s, x) => s + (x.value ?? 0), 0), segment).toBe(sum);
    }
    const cash = await detail('finance', 'cashClosing', 'place:noncash');
    expect(cash.body.rows.every((x) => x.place === 'noncash')).toBe(true);
    expect(cash.body.total.value).toBe(cash.body.rows.reduce((s, x) => s + (x.value ?? 0), 0));
  });

  it('загрузка: час по зоне филиала – факт только этого часа, Σ value = итог', async () => {
    const whole = await detail('utilization', 'used', `branch:${nsk}`);
    expect(whole.body.total).toMatchObject({ value: 180 });
    const hour = await detail('utilization', 'used', 'hour:11', `&branchIds=${nsk}`); // 04:00 UTC = 11:00 НСК
    expect(hour.body.total).toMatchObject({ value: 120 });
    expect(hour.body.rows.reduce((s, x) => s + (x.value ?? 0), 0)).toBe(120);
    expect((await detail('utilization', 'available', 'hour:11', `&branchIds=${nsk}`)).body.total).toMatchObject({ value: 240 }); // 2 единицы × 2 дня × 60 мин
    expect((await detail('utilization', 'used', 'day:2026-11-03', `&branchIds=${nsk}`)).body.total).toMatchObject({ value: 60 });
  });

  it('клиенты: сегмент дня и филиала применяется и к показателям на одном проходе', async () => {
    expect((await detail('clients', 'profileVisits')).body.total).toMatchObject({ value: 4 });
    expect((await detail('clients', 'profileVisits', 'day:2026-11-02')).body.total).toMatchObject({ value: 2 });
    expect((await detail('clients', 'profileVisits', `branch:${msk}`)).body.total).toMatchObject({ value: 1 });
  });

  it('Э3 (S4-76…S4-78): филиал и день у мероприятий, смен и оборудования – как у остальных отчётов, итог = карточка', async () => {
    expect((await detail('equipment', 'incidents')).body.total).toMatchObject({ value: 3 });
    for (const [segment, n] of [[`branch:${msk}`, 1], [`branch:${nsk}`, 2], ['day:2026-11-02', 1], ['day:2026-11-03', 2]] as const) {
      const r = await detail('equipment', 'incidents', segment);
      expect(r.status, segment).toBe(200);
      expect(r.body.rows, segment).toHaveLength(n);
      expect(r.body.total, segment).toMatchObject({ value: n });
    }
    // показатель «на момент запроса» день не сужает: итог детализации с сегментом дня = карточка
    expect((await detail('equipment', 'totalEquipment', 'day:2026-11-02')).body.total).toMatchObject({ value: 2 });
    for (const [report, metric] of [['events', 'count'], ['staff', 'plannedShifts'], ['staff', 'accrued']] as const) {
      for (const segment of [`branch:${nsk}`, 'day:2026-11-02']) {
        const r = await detail(report, metric, segment);
        expect([report, segment, r.status]).toEqual([report, segment, 200]);
        expect(r.body.total.state).toBe('no_data');
      }
    }
    expect((await detail('equipment', 'incidents', 'hour:11')).status).toBe(422);
    expect((await detail('events', 'count', 'resourceType:pc')).status).toBe(422);
  });

  it('несовместимый или неизвестный сегмент – 422', async () => {
    for (const [report, metric, segment, extra] of [
      ['bookings', 'visited', 'hour:11', ''], // у отчёта нет такого измерения
      ['bookings', 'visited', 'day:2026-12-01', ''], // день вне периода
      ['bookings', 'visited', 'мусор', ''],
      ['bookings', 'visited', `branch:${msk}`, `&branchIds=${nsk}`],
      ['finance', 'income', 'method:points', ''],
      ['utilization', 'used', 'hour:25', ''],
    ] as const) {
      const r = await detail(report, metric, segment, extra);
      expect(r.status, segment).toBe(422);
      expect(r.body.error!.code, segment).toBe('REPORT_FILTER_INVALID');
    }
  });

  it('сегмент филиала становится обычным фильтром области; у неизвестного отчёта сегмента нет', () => {
    const narrowed = applySegment('bookings', `branch:${msk}`, { period: { from: d('2026-11-02'), to: d('2026-11-03') } });
    expect(narrowed.branchIds).toEqual([msk]);
    expect(() => applySegment('нет-такого', 'day:2026-11-02', { period: { from: d('2026-11-02'), to: d('2026-11-03') } })).toThrow(AppError);
  });
});

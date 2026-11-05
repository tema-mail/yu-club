// Ревизия K24 §9, §10, TC-20: у всех показателей детализация – курсорная, по 100 строк; total – из агрегата, а не из строк страницы;
// при > 10 000 строк итог детализации не меньше агрегата. Проход по страницам = итог.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../../apps/api/src/core/errors.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { sellCertificate } from '../../apps/api/src/modules/certificates/sale.ts';
import { certificatesDetail, certificatesReport } from '../../apps/api/src/modules/reports/certificates.ts';
import { clientsDetail, clientsReport } from '../../apps/api/src/modules/reports/clients.ts';
import { loyaltyDetail, loyaltyReport } from '../../apps/api/src/modules/reports/loyalty.ts';
import { utilizationDetail } from '../../apps/api/src/modules/reports/utilization.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';
import { d, reportFixtures, type Fx } from '../helpers/reports.ts';

const BULK = 10_005;
const NOV = { from: d('2026-11-01'), to: d('2026-11-30') };
const OCT = { from: d('2026-10-01'), to: d('2026-10-31') };
let db: TestDatabase;
let fx: Fx;

const val = (m: { state: string; value?: number } | undefined) => (m?.state === 'ok' ? m.value : m?.state);
type Page = { rows: Array<{ value: number | null }>; total: { state: string; value?: number }; nextCursor: string | null };

/** Все страницы показателя: сумма значений и число строк. */
async function walk(load: (cursor: string | undefined) => Promise<Page>): Promise<{ sum: number; n: number; pages: number }> {
  let cursor: string | undefined;
  let sum = 0;
  let n = 0;
  let pages = 0;
  do {
    const p = await load(cursor);
    for (const r of p.rows) sum += r.value ?? 0;
    n += p.rows.length;
    pages += 1;
    cursor = p.nextCursor ?? undefined;
  } while (cursor);
  return { sum, n, pages };
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  fx = await reportFixtures(db);
  await fx.branch('Asia/Novosibirsk');
  // BULK профилей ноября со счётом баллов: положительный баланс 100 сотых
  await db.client.query(
    `WITH c AS (
       INSERT INTO app.clients (phone_e164, status, created_by_type, registered_at, created_at)
       SELECT '+7900' || lpad(g::text, 7, '0'), 'active', 'system', '2026-11-05T00:00:00Z', '2026-11-05T00:00:00Z' FROM generate_series(1, $1::int) g
       RETURNING id
     )
     INSERT INTO app.ledger_accounts (kind, unit, owner_type, owner_id, balance) SELECT 'loyalty_client', 'POINT_CENTI', 'client', id, 100 FROM c`,
    [BULK],
  );
}, 120_000);
afterAll(async () => {
  await fx.close();
  await db.drop();
});

describe('детализация больше 10 000 строк', () => {
  it('лояльность, баланс: итог равен агрегату, на странице 100 строк, есть курсор, страницы не пересекаются', async () => {
    const report = await fx.run(fx.owner(), (env) => loyaltyReport(env, { period: NOV }));
    expect(val(report.metrics.clientsPositive)).toBe(BULK);
    for (const [metric, expected] of [['clientsPositive', BULK], ['totalBalance', BULK * 100]] as const) {
      const first = await fx.run(fx.owner(), (env) => loyaltyDetail(env, { period: NOV }, metric));
      expect(first.rows).toHaveLength(100);
      expect(val(first.total)).toBe(expected);
      expect(first.nextCursor).toBe(first.rows[99]!.clientId);
      const second = await fx.run(fx.owner(), (env) => loyaltyDetail(env, { period: NOV }, metric, { cursor: first.nextCursor! }));
      expect(second.rows).toHaveLength(100);
      expect(val(second.total)).toBe(expected);
      expect(second.rows[0]!.clientId > first.rows[99]!.clientId).toBe(true);
    }
    const custom = await fx.run(fx.owner(), (env) => loyaltyDetail(env, { period: NOV }, 'clientsPositive', { limit: 7 }));
    expect(custom.rows).toHaveLength(7);
  });

  it('новые профили: итог равен агрегату, не 10 000; проход по 500 строк складывается в итог', async () => {
    const report = await fx.run(fx.owner(), (env) => clientsReport(env, { period: NOV }));
    expect(val(report.metrics.newProfiles)).toBe(BULK);
    const first = await fx.run(fx.owner(), (env) => clientsDetail(env, { period: NOV }, 'newProfiles'));
    expect(first.rows).toHaveLength(100);
    expect(val(first.total)).toBe(BULK);
    const all = await walk((cursor) => fx.run(fx.owner(), (env) => clientsDetail(env, { period: NOV }, 'newProfiles', { cursor, limit: 500 })));
    expect(all).toEqual({ sum: BULK, n: BULK, pages: Math.ceil(BULK / 500) });
  }, 60_000);

  it('чужой курсор – 422, а не 500', async () => {
    for (const load of [
      () => fx.run(fx.owner(), (env) => loyaltyDetail(env, { period: NOV }, 'clientsPositive', { cursor: 'мусор' })),
      () => fx.run(fx.owner(), (env) => clientsDetail(env, { period: NOV }, 'newProfiles', { cursor: 'мусор' })),
      () => fx.run(fx.owner(), (env) => clientsDetail(env, { period: NOV }, 'visitsPerClient', { cursor: 'мусор' })),
    ]) {
      const err = await load().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('REPORT_FILTER_INVALID');
    }
  });
});

describe('предел и курсор на малых объёмах', () => {
  let other: string;
  beforeAll(async () => {
    other = (await fx.branch('Europe/Moscow')).id;
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const unit = await fx.unit(other, `pc-${i}`);
      const res = await fx.resource(other, 'pc', `ПК-${i}`, [unit]);
      const client = await fx.client();
      ids.push(client);
      // по два посещения: у клиента есть и среднее, и интервал
      await fx.visit(await fx.booking({ branchId: other, clientId: client, resourceId: res, units: [unit], start: '2026-10-05T07:00:00Z' }));
      await fx.visit(await fx.booking({ branchId: other, clientId: client, resourceId: res, units: [unit], start: '2026-10-07T07:00:00Z' }));
    }
    expect(ids).toHaveLength(5);
  }, 60_000);

  it('посещений на клиента и средний интервал: страницы по limit, итог – по всем клиентам', async () => {
    const p = { period: OCT, branchIds: [other] };
    const visits = await fx.run(fx.owner(), (env) => clientsDetail(env, p, 'visitsPerClient', { limit: 2 }));
    expect(visits.rows).toHaveLength(2);
    expect(visits.nextCursor).toBe(visits.rows[1]!.clientId);
    expect(val(visits.total)).toBe(2);
    expect(await walk((cursor) => fx.run(fx.owner(), (env) => clientsDetail(env, p, 'visitsPerClient', { cursor, limit: 2 })))).toEqual({ sum: 10, n: 5, pages: 3 });
    const interval = await fx.run(fx.owner(), (env) => clientsDetail(env, p, 'avgIntervalDays', { limit: 2 }));
    expect(interval.rows).toHaveLength(2);
    expect(interval.nextCursor).not.toBeNull();
    expect(val(interval.total)).toBeCloseTo(2, 5);
  });

  it('загрузка: страница по единицам, итог – по всем', async () => {
    const p = { period: { from: d('2026-10-05'), to: d('2026-10-05') }, branchIds: [other] };
    const all = await walk((cursor) => fx.run(fx.owner(), (env) => utilizationDetail(env, p, 'used', { cursor, limit: 2 })));
    expect(all).toEqual({ sum: 300, n: 5, pages: 3 });
    const first = await fx.run(fx.owner(), (env) => utilizationDetail(env, p, 'used', { limit: 2 }));
    expect(first.rows).toHaveLength(2);
    expect(val(first.total)).toBe(300);
  });

  it('сертификаты на конец периода: страницы по limit, итог – по всем', async () => {
    const PEPPER = 'cert-pepper-'.padEnd(40, 'c');
    const clock = fixedClock('2026-10-05T05:00:00Z');
    for (let i = 0; i < 3; i += 1) {
      const o: AccessContext = fx.owner();
      const c: pg.PoolClient = await fx.app.connect();
      try {
        await c.query('BEGIN');
        await sellCertificate(c, o, { branchId: other, nominalKop: 1000, method: 'card' }, { actor: o.actor, access: o, source: 'crm', requestId: randomUUID() }, { pepper: PEPPER, clock });
        await c.query('COMMIT');
      } finally {
        c.release();
      }
    }
    const p = { period: OCT, branchIds: [other] };
    const report = await fx.run(fx.owner(), (env) => certificatesReport(env, p));
    expect(val(report.metrics.activeBalance)).toBe(3000);
    const first = await fx.run(fx.owner(), (env) => certificatesDetail(env, p, 'activeBalance', { limit: 2 }));
    expect(first.rows).toHaveLength(2);
    expect(val(first.total)).toBe(3000);
    expect(first.nextCursor).toBe(first.rows[1]!.certificateId);
    expect(await walk((cursor) => fx.run(fx.owner(), (env) => certificatesDetail(env, p, 'activeBalance', { cursor, limit: 2 })))).toEqual({ sum: 3000, n: 3, pages: 2 });
  });
});

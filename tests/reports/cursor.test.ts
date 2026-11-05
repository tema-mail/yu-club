// K24 §10: курсор детализации с плохой датой – REPORT_FILTER_INVALID (422), а не 500 от базы; настоящий курсор работает.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bookingsDetail } from '../../apps/api/src/modules/reports/bookings.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';
import { d, reportFixtures, type Fx } from '../helpers/reports.ts';

const NOV = { from: d('2026-11-01'), to: d('2026-11-30') };
let db: TestDatabase;
let fx: Fx;
const cursor = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  fx = await reportFixtures(db);
  const { id: branch } = await fx.branch();
  const unit = await fx.unit(branch, 'pc');
  const res = await fx.resource(branch, 'pc', 'ПК', [unit]);
  const client = await fx.client();
  await fx.booking({ branchId: branch, clientId: client, resourceId: res, units: [unit], start: '2026-11-02T04:00:00Z' });
  await fx.booking({ branchId: branch, clientId: client, resourceId: res, units: [unit], start: '2026-11-03T04:00:00Z' });
}, 60_000);
afterAll(async () => {
  await fx.close();
  await db.drop();
});

describe('курсор детализации', () => {
  it.each([
    ['не дата', cursor(['мусор', 'x'])],
    ['несуществующая дата', cursor(['2026-13-45 00:00:00+00', 'x'])],
    ['дата числом', cursor([123, 'x'])],
    ['нет даты у показателя с датой', cursor([null, 'x'])],
    ['не JSON', 'мусор'],
  ])('%s → 422', async (_name, bad) => {
    await expect(fx.run(fx.owner(), (env) => bookingsDetail(env, { period: NOV }, 'created', { cursor: bad }))).rejects.toMatchObject({ code: 'REPORT_FILTER_INVALID', httpStatus: 422 });
  });

  it('курсор из ответа ведёт на следующую страницу', async () => {
    const first = await fx.run(fx.owner(), (env) => bookingsDetail(env, { period: NOV }, 'created', { limit: 1 }));
    expect(first.nextCursor).not.toBeNull();
    const second = await fx.run(fx.owner(), (env) => bookingsDetail(env, { period: NOV }, 'created', { limit: 1, cursor: first.nextCursor! }));
    expect(second.rows).toHaveLength(1);
    expect(second.rows[0]!.bookingId).not.toBe(first.rows[0]!.bookingId);
    expect(second.nextCursor).toBeNull();
  });
});

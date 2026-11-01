// S2-34: ворота −50 модуля loyalty (K15 §8, 07 §9.2–9.4). Ворота подключает buildServer (server.ts);
// confirmHold при балансе −50 → LOYALTY_LIMIT_REACHED с текстом 07 §9.2, при −49,5 проходит (без ручной разблокировки).
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import type { Clock } from '../../apps/api/src/core/time.ts';
import { confirmHold } from '../../apps/api/src/modules/booking/confirm.ts';
import { createHold } from '../../apps/api/src/modules/booking/hold.ts';
import { runOccupancyCommand } from '../../apps/api/src/modules/booking/occupancy.ts';
import { debitBatches, openAccount, postPoints, SYSTEM_AUTHOR } from '../../apps/api/src/modules/loyalty/account.ts';
import { LIMIT_MESSAGE } from '../../apps/api/src/modules/loyalty/gate.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const SYS = '00000000-0000-0000-0000-000000000001';
const clock: Clock = { now: () => new Date('2026-11-14T05:00:00Z') };
let db: TestDatabase;
let pool: pg.Pool;
const ids: Record<string, string> = {};
let hour = 0;

async function one<T = { id: string }>(sql: string, params: unknown[] = []): Promise<T> {
  return (await db.client.query(sql, params)).rows[0] as T;
}
const newClient = async () => (await one(`INSERT INTO app.clients (phone_e164, first_name, status, created_by_type, registered_at) VALUES ($1, 'К', 'active', 'system', now()) RETURNING id`, [`+7913${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`])).id;
async function penalize(clientId: string, centi: number): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await openAccount(c, clientId, clock.now());
    for (let left = centi; left > 0; left -= 500) {
      const d = Math.min(500, left);
      const p = await postPoints(c, clientId, { amount: -d, type: 'loyalty.penalty', branchId: null, occurredAt: clock.now() }, randomUUID(), SYSTEM_AUTHOR);
      await debitBatches(c, { clientId, entryId: p.entryId, amount: d, balanceBefore: p.balanceBefore, kind: 'penalty' });
    }
    await c.query('COMMIT');
  } finally {
    c.release();
  }
}
async function holdFor(clientId: string): Promise<string> {
  const start = new Date(Date.parse('2026-11-16T04:00:00Z') + hour++ * 3_600_000);
  return (await runOccupancyCommand(pool, (c) => createHold(c, { clientId, visitorId: null }, { branchId: ids.b1!, items: [{ resourceId: ids.pc!, start, end: new Date(start.getTime() + 3_600_000) }] }, clock))).id;
}
const confirm = (clientId: string, holdId: string) =>
  runOccupancyCommand(pool, (c) => confirmHold(c, clientId, holdId, clock)).then(
    () => 'ok',
    (err: { code?: string; message?: string }) => ({ code: err.code, message: err.message }),
  );

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
  const city = await one(`INSERT INTO app.cities (code, slug, name, timezone) VALUES ('nsk', 'nsk', 'НСК', 'Asia/Novosibirsk') RETURNING id`);
  ids.b1 = (await one(`INSERT INTO app.branches (city_id, code, slug, name, address, timezone, status) VALUES ($1, 'b1', 'b1', 'b1', 'а', 'Asia/Novosibirsk', 'active') RETURNING id`, [city.id])).id;
  await db.client.query(`INSERT INTO app.branch_weekly_hours (branch_id, weekday, open_time, close_time, valid_from, created_by) SELECT $1, d, '00:00', '23:30', '2026-01-01', $2 FROM generate_series(1, 7) d`, [ids.b1, SYS]);
  await db.client.query(`INSERT INTO app.tariffs (branch_id, resource_type, name, unit_minutes, price_per_unit_kop, valid_from, status, created_by) VALUES ($1, 'pc', 'ПК', 30, 100, '2026-01-01', 'active', $2)`, [ids.b1, SYS]);
  const u = await one(`INSERT INTO app.occupancy_units (branch_id, code, name) VALUES ($1, 'PC1', 'PC1') RETURNING id`, [ids.b1]);
  ids.pc = (await one(`INSERT INTO app.resources (branch_id, resource_type, name) VALUES ($1, 'pc', 'ПК-1') RETURNING id`, [ids.b1])).id;
  await db.client.query(`INSERT INTO app.resource_units (resource_id, unit_id, valid_from) VALUES ($1, $2, '2026-01-01')`, [ids.pc, u.id]);
  // ворота подключает buildServer – повторный вызов не регистрирует второй раз
  await buildServer(loadConfig({ LOG_LEVEL: 'silent' })).close();
  await buildServer(loadConfig({ LOG_LEVEL: 'silent' })).close();
});
afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('ворота −50 (TC-10 «новая запись блокируется»)', () => {
  it('баланс −50 → confirmHold отказывает LOYALTY_LIMIT_REACHED с текстом 07 §9.2', async () => {
    const c = await newClient();
    const h = await holdFor(c);
    await penalize(c, 5000);
    expect(await confirm(c, h)).toEqual({ code: 'LOYALTY_LIMIT_REACHED', message: LIMIT_MESSAGE });
  });

  it('баланс −49,5 → бронь проходит; после штрафа до −50 – снова нет', async () => {
    const c = await newClient();
    await penalize(c, 4950);
    expect(await confirm(c, await holdFor(c))).toBe('ok');
    const h2 = await holdFor(c); // удержание до штрафа – отказ даёт именно подтверждение
    await penalize(c, 50);
    expect(await confirm(c, h2)).toMatchObject({ code: 'LOYALTY_LIMIT_REACHED' });
  });

  it('клиент без счёта баллов (баланс 0) – бронь проходит', async () => {
    const c = await newClient();
    expect(await confirm(c, await holdFor(c))).toBe('ok');
  });
});

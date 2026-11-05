// S3-58: грант бронирования на настоящей Postgres. Служебный ресурс (self_bookable=false) закрыт для обычной записи и открывается
// только валидатором типа; без гранта поведение Э1–Э2 не меняется; ошибка валидатора проходит как есть; валидатор вызывается в той
// же транзакции до occupy (его отказ не оставляет занятости; записанное им откатывается вместе с командой).
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../../apps/api/src/core/errors.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { addHoldItem, attachHold, clearServiceGrants, createHold, registerServiceGrant, releaseHold, removeHoldItem, type GrantCheck } from '../../apps/api/src/modules/booking/hold.ts';
import { runOccupancyCommand } from '../../apps/api/src/modules/booking/occupancy.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

// понедельник 2026-11-16, 12:00 по Новосибирску (05:00 UTC)
const clock = fixedClock('2026-11-14T05:00:00Z');
const START = new Date('2026-11-16T05:00:00Z');
const END = new Date('2026-11-16T05:40:00Z');
let db: TestDatabase;
let pool: pg.Pool;
const ids: Record<string, string> = {};
let clientN = 0;

const tx = <T>(fn: (c: pg.PoolClient) => Promise<T>) => runOccupancyCommand(pool, fn);
const one = async (sql: string, params: unknown[] = []) => (await db.client.query(sql, params)).rows[0];
async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
}
async function newClient(): Promise<string> {
  return (await one(`INSERT INTO app.clients (phone_e164, first_name, status, created_by_type) VALUES ($1, 'К', 'active', 'system') RETURNING id`, [`+7913000${String(++clientN).padStart(4, '0')}`])).id;
}
const giftItem = (start = START, end = END) => ({ resourceId: ids.gift!, start, end });
const GRANT = { kind: 'gift' as const, id: randomUUID() };
function record(): GrantCheck[] {
  const calls: GrantCheck[] = [];
  registerServiceGrant('gift_vr', {
    check: async (_tx, c) => {
      calls.push(c);
    },
  });
  return calls;
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 6 });
  const s = await one(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', 'o@yu.test', 'owner', 'x') RETURNING id`);
  const city = await one(`INSERT INTO app.cities (code, slug, name, timezone) VALUES ('nsk', 'nsk', 'НСК', 'Asia/Novosibirsk') RETURNING id`);
  ids.branch = (await one(`INSERT INTO app.branches (city_id, code, slug, name, address, timezone, status) VALUES ($1, 'b1', 'b1', 'b1', 'адрес', 'Asia/Novosibirsk', 'active') RETURNING id`, [city.id])).id;
  await db.client.query(`INSERT INTO app.branch_weekly_hours (branch_id, weekday, open_time, close_time, valid_from, created_by) SELECT $1, d, '10:00', '22:00', '2026-01-01', $2 FROM generate_series(1, 7) d`, [ids.branch, s.id]);
  for (const type of ['vr_seat', 'gift_vr']) {
    await db.client.query(`INSERT INTO app.tariffs (branch_id, resource_type, name, unit_minutes, price_per_unit_kop, valid_from, status, created_by) VALUES ($1, $2, $2, 5, $3, '2026-01-01', 'active', $4)`, [ids.branch, type, type === 'gift_vr' ? 0 : 10000, s.id]);
  }
  ids.room = (await one(`INSERT INTO app.rooms (branch_id, slug, name, is_published) VALUES ($1, 'vr', 'VR', true) RETURNING id`, [ids.branch])).id;
  for (const c of ['VR1', 'VR2']) ids[c] = (await one(`INSERT INTO app.occupancy_units (branch_id, room_id, code, name) VALUES ($1, $2, $3, $3) RETURNING id`, [ids.branch, ids.room, c])).id;
  ids.vr = (await one(`INSERT INTO app.resources (branch_id, room_id, resource_type, name) VALUES ($1, $2, 'vr_seat', 'VR-место') RETURNING id`, [ids.branch, ids.room])).id;
  await db.client.query(`INSERT INTO app.resource_units (resource_id, unit_id, valid_from) VALUES ($1, $2, '2026-01-01')`, [ids.vr, ids.VR1]);
  ids.gift = (await one(`INSERT INTO app.resources (branch_id, room_id, resource_type, name, self_bookable, step_minutes_override) VALUES ($1, $2, 'gift_vr', 'Подарок: 2 VR', false, 5) RETURNING id`, [ids.branch, ids.room])).id;
  await db.client.query(`INSERT INTO app.resource_units (resource_id, unit_id, valid_from) SELECT $1, u, '2026-01-01' FROM unnest($2::uuid[]) u`, [ids.gift, [ids.VR1, ids.VR2]]);
});
afterEach(async () => {
  clearServiceGrants();
  await db.client.query(`UPDATE app.occupancy SET active = false, released_at = now(), release_reason = 'released' WHERE active`);
  await db.client.query(`UPDATE app.client_time SET active = false, released_at = now() WHERE active`).catch(() => undefined);
  await db.client.query(`UPDATE app.holds SET status = 'released', closed_at = now() WHERE status = 'active'`);
});
afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('S3-58: грант в удержании', () => {
  it('без гранта – RESOURCE_UNAVAILABLE; без зарегистрированного валидатора – тоже; обычный ресурс – как раньше', async () => {
    const clientId = await newClient();
    const owner = { clientId, visitorId: null };
    expect(await codeOf(tx((c) => createHold(c, owner, { branchId: ids.branch!, items: [giftItem()] }, clock)))).toBe('RESOURCE_UNAVAILABLE');
    expect(await codeOf(tx((c) => createHold(c, owner, { branchId: ids.branch!, items: [giftItem()], serviceGrant: GRANT }, clock)))).toBe('RESOURCE_UNAVAILABLE');
    const calls = record();
    expect(await codeOf(tx((c) => createHold(c, owner, { branchId: ids.branch!, items: [giftItem()] }, clock)))).toBe('RESOURCE_UNAVAILABLE');
    expect(calls).toHaveLength(0);
    const usual = await tx((c) => createHold(c, owner, { branchId: ids.branch!, items: [{ resourceId: ids.vr!, start: new Date('2026-11-17T05:00:00Z'), end: new Date('2026-11-17T05:30:00Z') }] }, clock));
    expect(usual.status).toBe('active');
    expect(calls).toHaveLength(0);
  });
  it('с грантом: валидатор получает клиента и удержание; занимаются оба шлема; цена 0', async () => {
    const calls = record();
    const clientId = await newClient();
    const h = await tx((c) => createHold(c, { clientId, visitorId: null }, { branchId: ids.branch!, items: [giftItem()], serviceGrant: GRANT }, clock));
    expect(h.items[0]!.priceKop).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ phase: 'hold', grant: GRANT, clientId, holdId: h.id, resource: { id: ids.gift, type: 'gift_vr' } });
    const occ = await db.client.query(`SELECT unit_id FROM app.occupancy WHERE active AND source_type = 'hold_item' AND source_id = $1`, [h.items[0]!.id]);
    expect(occ.rows.map((r) => r.unit_id).sort()).toEqual([ids.VR1, ids.VR2].sort());
  });
  it('ошибка валидатора проходит как есть; занятости и удержания нет (до occupy, в той же транзакции)', async () => {
    registerServiceGrant('gift_vr', {
      check: async () => {
        throw new AppError('GIFT_WEEKDAY_ONLY', 422, 'Только будни');
      },
    });
    const clientId = await newClient();
    const owner = { clientId, visitorId: null };
    expect(await codeOf(tx((c) => createHold(c, owner, { branchId: ids.branch!, items: [giftItem()], serviceGrant: GRANT }, clock)))).toBe('GIFT_WEEKDAY_ONLY');
    expect((await db.client.query(`SELECT 1 FROM app.holds WHERE client_id = $1`, [clientId])).rowCount).toBe(0);
    expect((await db.client.query(`SELECT 1 FROM app.occupancy WHERE active AND source_type = 'hold_item'`)).rowCount).toBe(0);
  });
  it('запись валидатора в той же транзакции откатывается вместе с занятостью при SLOT_TAKEN', async () => {
    let seen = 0;
    registerServiceGrant('gift_vr', {
      check: async (t) => {
        seen++;
        await t.query(`SELECT set_config('yu.grant_test', 'written', true)`);
      },
    });
    const a = await newClient();
    const b = await newClient();
    await tx((c) => createHold(c, { clientId: a, visitorId: null }, { branchId: ids.branch!, items: [giftItem()], serviceGrant: GRANT }, clock));
    expect(await codeOf(tx((c) => createHold(c, { clientId: b, visitorId: null }, { branchId: ids.branch!, items: [giftItem()], serviceGrant: GRANT }, clock)))).toBe('SLOT_HELD');
    expect(seen).toBe(2);
    expect((await db.client.query(`SELECT 1 FROM app.holds WHERE client_id = $1`, [b])).rowCount).toBe(0);
  });
  it('в удержание со служебной позицией добавить нельзя – решает валидатор (phase add_item); снятие и отпускание – onHoldClosed', async () => {
    const closed: string[] = [];
    registerServiceGrant('gift_vr', {
      check: async (_t, c) => {
        if (c.phase === 'add_item') throw new AppError('GIFT_COMPOSITION_INVALID', 422, 'Только подарочный ресурс');
      },
      onHoldClosed: async (_t, id) => {
        closed.push(id);
      },
    });
    const clientId = await newClient();
    const owner = { clientId, visitorId: null };
    const h = await tx((c) => createHold(c, owner, { branchId: ids.branch!, items: [giftItem()], serviceGrant: GRANT }, clock));
    const other = { resourceId: ids.vr!, start: new Date('2026-11-16T07:00:00Z'), end: new Date('2026-11-16T07:30:00Z') };
    expect(await codeOf(tx((c) => addHoldItem(c, owner, h.id, other, clock)))).toBe('GIFT_COMPOSITION_INVALID');
    await tx((c) => removeHoldItem(c, owner, h.id, h.items[0]!.id, clock));
    expect(closed).toEqual([h.id]);
    const h2 = await tx((c) => createHold(c, owner, { branchId: ids.branch!, items: [giftItem()], serviceGrant: GRANT }, clock));
    await tx((c) => releaseHold(c, owner, h2.id, clock));
    expect(closed).toEqual([h.id, h2.id]);
  });
  it('обычное удержание: служебную позицию добавить без гранта нельзя; с отказом валидатора – код валидатора; снятие без onHoldClosed', async () => {
    const closed: string[] = [];
    registerServiceGrant('gift_vr', {
      check: async () => {
        throw new AppError('GIFT_COMPOSITION_INVALID', 422, 'Только подарочный ресурс');
      },
      onHoldClosed: async (_t, id) => {
        closed.push(id);
      },
    });
    const clientId = await newClient();
    const owner = { clientId, visitorId: null };
    const h = await tx((c) => createHold(c, owner, { branchId: ids.branch!, items: [{ resourceId: ids.vr!, start: new Date('2026-11-18T07:00:00Z'), end: new Date('2026-11-18T07:30:00Z') }] }, clock));
    expect(await codeOf(tx((c) => addHoldItem(c, owner, h.id, giftItem(), clock)))).toBe('RESOURCE_UNAVAILABLE');
    expect(await codeOf(tx((c) => addHoldItem(c, owner, h.id, giftItem(), clock, GRANT)))).toBe('GIFT_COMPOSITION_INVALID');
    await tx((c) => releaseHold(c, owner, h.id, clock));
    expect(closed).toEqual([]);
  });
  it('attachHold: служебная позиция переходит только с согласия валидатора (phase attach)', async () => {
    const seen: GrantCheck[] = [];
    registerServiceGrant('gift_vr', {
      check: async (_t, c) => {
        seen.push(c);
        if (c.phase === 'attach') throw new AppError('GIFT_CLIENT_MISMATCH', 422, 'Подарок другому клиенту');
      },
    });
    const visitorId = randomUUID();
    const clientId = await newClient();
    const h = await tx((c) => createHold(c, { clientId: null, visitorId }, { branchId: ids.branch!, items: [giftItem()], serviceGrant: GRANT }, clock));
    expect(await codeOf(tx((c) => attachHold(c, clientId, visitorId, h.id, clock)))).toBe('GIFT_CLIENT_MISMATCH');
    expect(seen.at(-1)).toMatchObject({ phase: 'attach', clientId, holdId: h.id });
    expect((await one('SELECT client_id FROM app.holds WHERE id = $1', [h.id])).client_id).toBeNull();
  });
  it('неактивный служебный ресурс с грантом – RESOURCE_UNAVAILABLE', async () => {
    record();
    await db.client.query(`UPDATE app.resources SET status = 'unavailable' WHERE id = $1`, [ids.gift]);
    try {
      const clientId = await newClient();
      expect(await codeOf(tx((c) => createHold(c, { clientId, visitorId: null }, { branchId: ids.branch!, items: [giftItem()], serviceGrant: GRANT }, clock)))).toBe('RESOURCE_UNAVAILABLE');
    } finally {
      await db.client.query(`UPDATE app.resources SET status = 'active' WHERE id = $1`, [ids.gift]);
    }
  });
});

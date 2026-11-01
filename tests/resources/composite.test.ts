// S1-02: единицы занятости и составные конфигурации (K6, R-01 по умолчанию) на настоящей Postgres.
// Комната целиком → {VR1, VR2, PS4}; VR-место → {VRi}; PS4 самостоятельно не бронируется; смена состава не меняет
// снимок старых броней; гонки: 50 параллельных занятий одной единицы и «комната против мест» в обратном порядке.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { AppError } from '../../apps/api/src/core/errors.ts';
import { fixedClock, interval } from '../../apps/api/src/core/time.ts';
import { occupy, occupyMany, runOccupancyCommand } from '../../apps/api/src/modules/booking/occupancy.ts';
import { changeComposition, expandToUnits, listBookableResources, type UnitSet } from '../../apps/api/src/modules/resources/index.ts';
import { hashPassword, staffAuthConfig } from '../../apps/api/src/modules/staff/auth.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const PASSWORD = 'Пароль-состава-проверка-1';
const BASE = '/api/crm/v1';
const NOW = '2026-11-14T05:00:00Z';
const clock = fixedClock(NOW);
const meta: AuditRequestMeta = { actor: { kind: 'system', process: 'test' }, source: 'system', requestId: 'composite-test' };
let db: TestDatabase;
let pool: pg.Pool;
let app: FastifyInstance;
const cookies: Record<string, string> = {};
const ids: Record<string, string> = {};
const units: Record<string, string> = {};

async function login(key: string, role: string, branchId?: string): Promise<void> {
  const r = await db.client.query<{ id: string }>(
    `INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', $1, $2, $3) RETURNING id`,
    [`${key}@yu.test`, role, await hashPassword(PASSWORD)],
  );
  if (branchId) {
    await db.client.query(
      `INSERT INTO app.staff_assignments (staff_id, scope_type, branch_id, valid_from, created_by) VALUES ($1, 'branch', $2, '2026-01-01', $1)`,
      [r.rows[0]!.id, branchId],
    );
  }
  const res = await app.inject({ method: 'POST', url: `${BASE}/auth/login`, payload: { email: `${key}@yu.test`, password: PASSWORD } });
  cookies[key] = String(res.headers['set-cookie']).split(';')[0]!;
}
function req(who: string, method: 'GET' | 'POST', url: string, payload?: object) {
  const headers: Record<string, string> = { cookie: cookies[who]! };
  if (method !== 'GET') headers['idempotency-key'] = randomUUID();
  return app.inject({ method, url: `${BASE}${url}`, headers, ...(payload ? { payload } : {}) });
}

const at = (iso: string) => new Date(iso);
const slot = (startIso: string, minutes: number) => interval(at(startIso), new Date(at(startIso).getTime() + minutes * 60_000));
const booking = () => ({ type: 'booking' as const, id: randomUUID(), version: 1 });
/** Строка брони для источника занятия: с S1-07 смена состава ищет будущие брони по таблице bookings. */
async function bookingRow(db0: { query: pg.Pool['query'] }, id: string, resourceId: string, p: { start: Date; end: Date }): Promise<void> {
  await db0.query(
    `INSERT INTO app.bookings (id, checkout_id, branch_id, client_id, resource_id, period, price_kop, source, created_by_type)
     VALUES ($1, $1, $2, $3, $4, tstzrange($5, $6, '[)'), 0, 'crm', 'system')`,
    [id, ids.branch, ids.client, resourceId, p.start, p.end],
  );
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
}

/** Нет двух активных строк одной единицы с пересечением (K6 §Проверка). */
async function overlapsInDb(): Promise<number> {
  const r = await db.client.query(
    `SELECT count(*)::int n FROM app.occupancy a JOIN app.occupancy b
       ON a.unit_id = b.unit_id AND a.id < b.id AND a.period && b.period WHERE a.active AND b.active`,
  );
  return r.rows[0].n;
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 52 });
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), { staff: { pool, auth: staffAuthConfig('c'.repeat(40)), clock } });
  const c = await db.client.query<{ id: string }>(`INSERT INTO app.cities (code, slug, name, timezone) VALUES ('nsk', 'nsk', 'НСК', 'Asia/Novosibirsk') RETURNING id`);
  const b = await db.client.query<{ id: string }>(
    `INSERT INTO app.branches (city_id, code, slug, name, address, timezone, status) VALUES ($1, 'k', 'k', 'К', 'адрес', 'Asia/Novosibirsk', 'active') RETURNING id`,
    [c.rows[0]!.id],
  );
  ids.branch = b.rows[0]!.id;
  await login('owner', 'owner');
  await login('admin', 'admin', ids.branch);
  ids.client = (await db.client.query<{ id: string }>(`INSERT INTO app.clients (phone_e164, status, created_by_type, registered_at) VALUES ('+79130000099', 'active', 'system', now()) RETURNING id`)).rows[0]!.id;
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await db.drop();
});

describe('VR-комната по умолчанию R-01: данные через CRM', () => {
  it('VR-места получают свои единицы, PS4 – единица комнаты без ресурса, комната целиком = {VR1, VR2, PS4}', async () => {
    const room = await req('owner', 'POST', `/branches/${ids.branch}/rooms`, { slug: 'vr', name: 'VR-комната', isPublished: true });
    ids.room = room.json().id;
    for (const [k, code] of [['vr1', 'VR1'], ['vr2', 'VR2']] as const) {
      const r = await req('owner', 'POST', `/branches/${ids.branch}/resources`, { type: 'vr_seat', name: `VR-место ${code}`, roomId: ids.room, unitCode: code });
      expect(r.statusCode).toBe(201);
      ids[k] = r.json().id;
      units[code] = r.json().unitIds[0];
    }
    const ps4 = await req('owner', 'POST', `/branches/${ids.branch}/units`, { roomId: ids.room, code: 'PS4', name: 'PlayStation 4' });
    expect(ps4.statusCode).toBe(201);
    units.PS4 = ps4.json().id;
    const audit = await db.client.query(`SELECT after FROM journal.audit_events WHERE action = 'room.updated' AND object_id = $1`, [ids.room]);
    expect(audit.rows[0].after.unit).toMatchObject({ code: 'PS4' });
    expect((await req('owner', 'POST', `/branches/${ids.branch}/units`, { roomId: ids.room, code: 'PS4', name: 'дубль' })).json().error.code).toBe('RESOURCE_SLUG_TAKEN');
    const whole = await req('owner', 'POST', `/branches/${ids.branch}/resources`, {
      type: 'room_whole', name: 'VR-комната целиком', roomId: ids.room, unitIds: [units.PS4, units.VR2, units.VR1],
    });
    expect(whole.statusCode).toBe(201);
    ids.whole = whole.json().id;
    const list = (await req('admin', 'GET', `/branches/${ids.branch}/units`)).json();
    expect(list.items.map((u: { code: string }) => u.code)).toEqual(['PS4', 'VR1', 'VR2']);
    const card = (await req('admin', 'GET', `/resources/${ids.whole}`)).json();
    expect(card.unitIds).toEqual([units.PS4, units.VR1, units.VR2].sort());
  });

  it('expandToUnits: комната → три единицы по id, место → своя; PS4 сам не бронируется', async () => {
    const whole = await expandToUnits(pool, ids.whole!, at('2026-11-15T10:00:00Z'));
    expect(whole).toEqual({ resourceId: ids.whole, unitIds: [units.VR1, units.VR2, units.PS4].sort() });
    expect((await expandToUnits(pool, ids.vr1!, at('2026-11-15T10:00:00Z'))).unitIds).toEqual([units.VR1]);
    expect((await expandToUnits(pool, ids.vr2!, at('2026-11-15T10:00:00Z'))).unitIds).toEqual([units.VR2]);
    // PS4 не предлагается: ни один бронируемый ресурс не состоит из одной PS4.
    const bookable = await listBookableResources(pool, ids.branch!);
    for (const r of bookable) expect((await expandToUnits(pool, r.id, at('2026-11-15T10:00:00Z'))).unitIds).not.toEqual([units.PS4]);
    // даже заведённый «служебный» ресурс из PS4 – несамостоятельный → RESOURCE_UNAVAILABLE.
    const ps = await req('owner', 'POST', `/branches/${ids.branch}/resources`, { type: 'composite', name: 'PS4', roomId: ids.room, unitIds: [units.PS4], selfBookable: false });
    expect(await codeOf(expandToUnits(pool, ps.json().id, at('2026-11-15T10:00:00Z')))).toBe('RESOURCE_UNAVAILABLE');
    // составной без состава – тоже недоступен; несуществующий – тоже.
    const empty = await req('owner', 'POST', `/branches/${ids.branch}/resources`, { type: 'composite', name: 'Пустой', roomId: ids.room });
    expect(await codeOf(expandToUnits(pool, empty.json().id, at('2026-11-15T10:00:00Z')))).toBe('RESOURCE_UNAVAILABLE');
    expect(await codeOf(expandToUnits(pool, randomUUID(), at('2026-11-15T10:00:00Z')))).toBe('RESOURCE_UNAVAILABLE');
    // у обычного ресурса unitIds не передаются; у составного – unitCode.
    expect((await req('owner', 'POST', `/branches/${ids.branch}/resources`, { type: 'pc', name: 'ПК', unitIds: [units.VR1] })).statusCode).toBe(400);
  });
});

describe('конфликты даёт база (TC-01…TC-03)', () => {
  const tx = async <T>(run: (c: pg.PoolClient) => Promise<T>) => runOccupancyCommand(pool, run);
  const unitsOf = (resourceId: string, iso: string) => expandToUnits(pool, resourceId, at(iso));

  it('комната и место на пересекающееся время – SLOT_TAKEN; два места одновременно – можно; удержание – SLOT_HELD', async () => {
    const p = slot('2026-11-15T10:00:00Z', 60);
    const room = await unitsOf(ids.whole!, '2026-11-15T10:00:00Z');
    await tx((c) => occupy(c, { branchId: ids.branch!, units: room, period: p, source: booking(), clientId: null }));
    const seat = await unitsOf(ids.vr1!, '2026-11-15T10:30:00Z');
    expect(await codeOf(tx((c) => occupy(c, { branchId: ids.branch!, units: seat, period: slot('2026-11-15T10:30:00Z', 30), source: booking(), clientId: null })))).toBe('SLOT_TAKEN');
    // встык – не пересечение ('[)').
    await tx((c) => occupy(c, { branchId: ids.branch!, units: seat, period: slot('2026-11-15T11:00:00Z', 30), source: booking(), clientId: null }));
    const seat2 = await unitsOf(ids.vr2!, '2026-11-15T11:00:00Z');
    await tx((c) => occupy(c, { branchId: ids.branch!, units: seat2, period: slot('2026-11-15T11:00:00Z', 30), source: booking(), clientId: null }));
    const hold = { type: 'hold_item' as const, id: randomUUID(), holdExpiresAt: at('2026-11-14T05:15:00Z') };
    await tx((c) => occupy(c, { branchId: ids.branch!, units: seat, period: slot('2026-11-15T12:00:00Z', 30), source: hold, clientId: null }));
    expect(await codeOf(tx((c) => occupy(c, { branchId: ids.branch!, units: room, period: slot('2026-11-15T12:00:00Z', 60), source: booking(), clientId: null })))).toBe('SLOT_HELD');
    expect(await overlapsInDb()).toBe(0);
  });

  it('ошибка одной позиции – ни одной строки команды (один INSERT)', async () => {
    const before = (await db.client.query('SELECT count(*)::int n FROM app.occupancy')).rows[0].n;
    const free = await unitsOf(ids.vr2!, '2026-11-15T12:00:00Z');
    const busy = await unitsOf(ids.vr1!, '2026-11-15T12:00:00Z');
    const code = await codeOf(
      tx((c) =>
        occupyMany(c, ids.branch!, [
          { units: free, period: slot('2026-11-15T12:00:00Z', 30), source: booking(), clientId: null },
          { units: busy, period: slot('2026-11-15T12:00:00Z', 30), source: booking(), clientId: null },
        ]),
      ),
    );
    expect(code).toBe('SLOT_HELD');
    expect((await db.client.query('SELECT count(*)::int n FROM app.occupancy')).rows[0].n).toBe(before);
  });

  it('yu_app не удаляет строки занятости и состав', async () => {
    for (const t of ['occupancy', 'resource_units', 'occupancy_units']) {
      await expect(pool.query(`DELETE FROM app.${t} WHERE false`)).rejects.toMatchObject({ code: '42501' });
    }
  });
});

describe('гонки на пуле ≥ 50 соединений', () => {
  it('50 параллельных попыток занять одну единицу на пересекающиеся интервалы → ровно одна', async () => {
    const seat = await expandToUnits(pool, ids.vr1!, at('2026-11-16T10:00:00Z'));
    const gate = { open: () => {}, ready: Promise.resolve() };
    gate.ready = new Promise<void>((r) => (gate.open = r));
    const clients = await Promise.all(Array.from({ length: 50 }, () => pool.connect()));
    expect(pool.totalCount).toBeGreaterThanOrEqual(50);
    const attempts = clients.map(async (c, i) => {
        try {
          await c.query('BEGIN');
          await gate.ready;
          await occupy(c, { branchId: ids.branch!, units: seat, period: slot(`2026-11-16T10:${String(i).padStart(2, '0')}:00Z`, 60), source: booking(), clientId: null });
          await c.query('SELECT pg_sleep(0.01)');
          await c.query('COMMIT');
          return 'ok';
        } catch (e) {
          await c.query('ROLLBACK');
          return e instanceof AppError ? e.code : String((e as { code?: string }).code);
        } finally {
          c.release();
        }
    });
    gate.open();
    const results = await Promise.all(attempts);
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r === 'SLOT_TAKEN')).toHaveLength(49);
    const rows = await db.client.query(`SELECT count(*)::int n FROM app.occupancy WHERE active AND unit_id = $1 AND period && $2::tstzrange`, [
      units.VR1,
      '[2026-11-16 10:00:00+00,2026-11-16 12:00:00+00)',
    ]);
    expect(rows.rows[0].n).toBe(1);
    expect(await overlapsInDb()).toBe(0);
  }, 60_000);

  it('аренда комнаты против двух мест VR в обратном порядке единиц: без дедлока, ровно одна сторона, 30 раз', async () => {
    const reversed = (s: UnitSet): UnitSet => ({ ...s, unitIds: [...s.unitIds].reverse() });
    let attempts = 0;
    for (let k = 0; k < 30; k++) {
      const start = new Date(at('2026-11-17T00:00:00Z').getTime() + k * 3_600_000);
      const p = interval(start, new Date(start.getTime() + 30 * 60_000));
      const room = reversed(await expandToUnits(pool, ids.whole!, start)); // по убыванию id
      const s1 = await expandToUnits(pool, ids.vr1!, start);
      const s2 = await expandToUnits(pool, ids.vr2!, start);
      const hold = (c: pg.PoolClient) => c.query('SELECT pg_sleep(0.005)');
      // комната – единицы по убыванию id, места – по возрастанию: порядок «как передали» гарантированно встречный.
      const seats = [s1, s2].sort((x, y) => (x.unitIds[0]! < y.unitIds[0]! ? -1 : 1));
      const [a, b] = await Promise.all([
        codeOf(
          runOccupancyCommand(pool, async (c) => {
            attempts++;
            await occupy(c, { branchId: ids.branch!, units: room, period: p, source: booking(), clientId: null });
            await hold(c);
          }),
        ),
        codeOf(
          runOccupancyCommand(pool, async (c) => {
            attempts++;
            await occupyMany(c, ids.branch!, seats.map((units) => ({ units, period: p, source: booking(), clientId: null })));
            await hold(c);
          }),
        ),
      ]);
      expect([a, b].sort()).toEqual(['SLOT_TAKEN', 'ok']);
    }
    expect(attempts).toBe(60); // ни одного повтора: 40P01 не было (при FOR SHARE из K6 – были, см. occupancy.ts)
    expect(await overlapsInDb()).toBe(0);
  }, 60_000);

  it('40P01/40001: повтор команды один раз, затем SLOT_HELD', async () => {
    let calls = 0;
    const once = await runOccupancyCommand(pool, async () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error('deadlock'), { code: '40P01' });
      return 'done';
    });
    expect([once, calls]).toEqual(['done', 2]);
    calls = 0;
    const twice = runOccupancyCommand(pool, async () => {
      calls++;
      throw Object.assign(new Error('serialization'), { code: '40001' });
    });
    expect(await codeOf(twice)).toBe('SLOT_HELD');
    expect(calls).toBe(2);
  });
});

describe('смена состава (K6 changeComposition, 02 §8.4)', () => {
  const validFrom = at('2026-11-20T00:00:00Z');
  const ps5 = { unit: '' };

  it('будущая бронь комнаты → отказ со списком; dryRun – только список; бронь места VR в список не попадает', async () => {
    const cur = await expandToUnits(pool, ids.whole!, at('2026-11-25T10:00:00Z'));
    const future = booking();
    await runOccupancyCommand(pool, (c) => occupy(c, { branchId: ids.branch!, units: cur, period: slot('2026-11-25T10:00:00Z', 60), source: future, clientId: null }));
    await bookingRow(db.client, future.id, ids.whole!, slot('2026-11-25T10:00:00Z', 60));
    ids.future = future.id;
    const seat = await expandToUnits(pool, ids.vr1!, at('2026-11-25T12:00:00Z'));
    const seatSrc = booking();
    await runOccupancyCommand(pool, (c) => occupy(c, { branchId: ids.branch!, units: seat, period: slot('2026-11-25T12:00:00Z', 30), source: seatSrc, clientId: null }));
    await bookingRow(db.client, seatSrc.id, ids.vr1!, slot('2026-11-25T12:00:00Z', 30));
    const u = await req('owner', 'POST', `/branches/${ids.branch}/units`, { roomId: ids.room, code: 'PS5', name: 'PlayStation 5' });
    ps5.unit = u.json().id;
    const next = [units.VR1!, units.VR2!, ps5.unit];
    const dry = await req('owner', 'POST', `/resources/${ids.whole}/composition`, { unitIds: next, validFrom: validFrom.toISOString(), dryRun: true });
    expect(dry.statusCode).toBe(200);
    expect(dry.json()).toEqual({ affectedBookingIds: [future.id], affectedHoldIds: [], affectedBlockIds: [], applied: false });
    const refused = await req('owner', 'POST', `/resources/${ids.whole}/composition`, { unitIds: next, validFrom: validFrom.toISOString() });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatchObject({ code: 'COMPOSITION_HAS_FUTURE_BOOKINGS', details: { bookingIds: [future.id], holdIds: [] } });
    expect((await expandToUnits(pool, ids.whole!, at('2026-11-25T10:00:00Z'))).unitIds).toEqual(cur.unitIds);
  });

  it('после решения по брони – состав меняется с даты; старые брони хранят свои единицы', async () => {
    const before = await db.client.query(`SELECT unit_id, period::text FROM app.occupancy WHERE active AND period && '[2026-11-15,2026-11-16)' ORDER BY 1, 2`);
    await db.client.query(`UPDATE app.occupancy SET active = false, released_at = $2, release_reason = 'cancelled' WHERE source_id = $1`, [ids.future, at(NOW)]);
    await db.client.query(`UPDATE app.bookings SET status = 'cancelled_by_client', cancelled_at = $2 WHERE id = $1`, [ids.future, at(NOW)]);
    const res = await changeComposition(pool, { resourceId: ids.whole!, unitIds: [units.VR1!, units.VR2!, ps5.unit], validFrom }, meta, clock);
    expect(res).toEqual({ affectedBookingIds: [], affectedHoldIds: [], affectedBlockIds: [], applied: true });
    expect((await expandToUnits(pool, ids.whole!, at('2026-11-15T10:00:00Z'))).unitIds).toEqual([units.VR1, units.VR2, units.PS4].sort());
    expect((await expandToUnits(pool, ids.whole!, at('2026-11-21T10:00:00Z'))).unitIds).toEqual([units.VR1, units.VR2, ps5.unit].sort());
    const after = await db.client.query(`SELECT unit_id, period::text FROM app.occupancy WHERE active AND period && '[2026-11-15,2026-11-16)' ORDER BY 1, 2`);
    expect(after.rows).toEqual(before.rows);
    expect(after.rows.some((r) => r.unit_id === units.PS4)).toBe(true);
    const a = await db.client.query(`SELECT before, after FROM journal.audit_events WHERE action = 'resource.composition_changed' AND object_id = $1`, [ids.whole]);
    expect(a.rows[0].before.unitIds).toContain(units.PS4);
    expect(a.rows[0].after.unitIds).toContain(ps5.unit);
  });

  it('прошлое не переписывается: validFrom раньше «сейчас» или последнего изменения – 400; Администратор – 403', async () => {
    const back = await req('owner', 'POST', `/resources/${ids.whole}/composition`, { unitIds: [units.VR1], validFrom: '2026-11-01T00:00:00Z' });
    expect(back.statusCode).toBe(400);
    expect(await codeOf(changeComposition(pool, { resourceId: ids.whole!, unitIds: [units.VR1!], validFrom: at('2026-11-19T00:00:00Z') }, meta, clock))).toBe('VALIDATION_FAILED');
    const other = await req('owner', 'POST', `/resources/${ids.whole}/composition`, { unitIds: [randomUUID()], validFrom: '2026-12-01T00:00:00Z' });
    expect(other.json().error.code).toBe('RESOURCE_LINK_INVALID');
    const denied = await req('admin', 'POST', `/resources/${ids.whole}/composition`, { unitIds: [units.VR1], validFrom: '2026-12-01T00:00:00Z' });
    expect(denied.statusCode).toBe(403);
  });
});

describe('гонка «занятие ↔ смена состава» (ревизия S1-02 п.1)', () => {
  it('40 пар: либо бронь записана и смена состава отказала с ней в списке, либо смена прошла и занятие – COMPOSITE_CHANGED', async () => {
    const outcomes = { booked: 0, changed: 0 };
    for (let k = 0; k < 40; k++) {
      const r = await db.client.query<{ id: string }>(
        `INSERT INTO app.resources (branch_id, room_id, resource_type, name) VALUES ($1, $2, 'composite', $3) RETURNING id`,
        [ids.branch, ids.room, `2 VR ${k}`],
      );
      const rid = r.rows[0]!.id;
      // свои две единицы на каждую пару: иначе брони прошлых пар того же состава попали бы в список (перестраховка futureUsage)
      const own = await db.client.query<{ id: string }>(
        `INSERT INTO app.occupancy_units (branch_id, room_id, code, name) VALUES ($1, $2, $3, $3), ($1, $2, $4, $4) RETURNING id`,
        [ids.branch, ids.room, `R${k}A`, `R${k}B`],
      );
      const [ua, ub] = own.rows.map((x) => x.id);
      await db.client.query(`INSERT INTO app.resource_units (resource_id, unit_id, valid_from) SELECT $1, u, $2 FROM unnest($3::uuid[]) u`, [
        rid,
        at(NOW),
        [ua, ub],
      ]);
      const start = new Date(at('2026-12-10T00:00:00Z').getTime() + k * 3_600_000);
      const p = interval(start, new Date(start.getTime() + 30 * 60_000));
      const old = await expandToUnits(pool, rid, start); // развёрнуто до транзакции – как у сайта между шагами
      const src = booking();
      const [occ, chg] = await Promise.all([
        codeOf(runOccupancyCommand(pool, async (c) => (await occupy(c, { branchId: ids.branch!, units: old, period: p, source: src, clientId: null }), await bookingRow(c, src.id, rid, p), await c.query('SELECT pg_sleep(0.005)')))),
        (async () => {
          const c = await pool.connect();
          try {
            await c.query('BEGIN');
            const res = await changeComposition(c, { resourceId: rid, unitIds: [ua!], validFrom: at('2026-12-01T00:00:00Z') }, meta, clock);
            await c.query('SELECT pg_sleep(0.005)');
            await c.query('COMMIT');
            return { applied: res.applied, bookingIds: [] as string[] };
          } catch (e) {
            await c.query('ROLLBACK');
            if (e instanceof AppError && e.code === 'COMPOSITION_HAS_FUTURE_BOOKINGS') return { applied: false, bookingIds: e.details!.bookingIds as string[] };
            throw e;
          } finally {
            c.release();
          }
        })(),
      ]);
      if (occ === 'ok') {
        expect(chg).toEqual({ applied: false, bookingIds: [src.id] });
        outcomes.booked++;
      } else {
        expect(occ).toBe('COMPOSITE_CHANGED');
        expect(chg.applied).toBe(true);
        outcomes.changed++;
      }
    }
    expect(outcomes.booked + outcomes.changed).toBe(40);
  }, 60_000);
});

// Э5: TC-01…TC-06 (tz/20 §10) целиком на настоящей Postgres. Гонки за слот – N параллельных соединений пула (план §8:
// «гарантию даёт база, тесты проверяют именно базу»), а не последовательные вызовы; после каждой гонки – SQL-проверка
// «ни одной пары пересечений по активным единицам» и по времени клиента. TC-05/06 – истечение и общий таймер через
// настоящие команды удержания (createHold / addHoldItem / confirmHold / expireDueHolds) и часы теста.
// Последовательные углы тех же сценариев (до/после подтверждения) остались в confirm.test.ts и hold.test.ts.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../../apps/api/src/core/errors.ts';
import type { Clock } from '../../apps/api/src/core/time.ts';
import { confirmHold } from '../../apps/api/src/modules/booking/confirm.ts';
import { addHoldItem, createHold, expireDueHolds, type HoldDto, type HoldItemInput } from '../../apps/api/src/modules/booking/hold.ts';
import { runOccupancyCommand } from '../../apps/api/src/modules/booking/occupancy.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const SYS = '00000000-0000-0000-0000-000000000001';
let t = Date.parse('2026-11-14T05:00:00Z'); // суббота, 12:00 Новосибирска
const clock: Clock = { now: () => new Date(t) };
const advance = (min: number) => (t += min * 60_000);
const iso = (ms: number) => new Date(ms).toISOString();
let db: TestDatabase;
let pool: pg.Pool;
const ids: Record<string, string> = {};
const units: Record<string, string> = {};
let phones = 4_000_000;

async function one<T = { id: string }>(sql: string, params: unknown[] = []): Promise<T> {
  return (await db.client.query(sql, params)).rows[0] as T;
}
async function unit(branchId: string, roomId: string | null, code: string): Promise<string> {
  return (await one(`INSERT INTO app.occupancy_units (branch_id, room_id, code, name) VALUES ($1, $2, $3, $3) RETURNING id`, [branchId, roomId, code])).id;
}
async function resource(branchId: string, roomId: string | null, type: string, name: string, unitIds: string[]): Promise<string> {
  const r = await one(`INSERT INTO app.resources (branch_id, room_id, resource_type, name) VALUES ($1, $2, $3, $4) RETURNING id`, [branchId, roomId, type, name]);
  await db.client.query(`INSERT INTO app.resource_units (resource_id, unit_id, valid_from) SELECT $1, u, '2026-01-01' FROM unnest($2::uuid[]) u`, [r.id, unitIds]);
  return r.id;
}
const newClient = async () =>
  (await one(`INSERT INTO app.clients (phone_e164, status, created_by_type, registered_at) VALUES ($1, 'active', 'system', now()) RETURNING id`, [`+7913${phones++}`])).id;
const span = (resourceId: string, isoStart: string, minutes: number): HoldItemInput => ({ resourceId, start: new Date(isoStart), end: new Date(Date.parse(isoStart) + minutes * 60_000) });
const hold = (clientId: string, branchId: string, items: HoldItemInput[]): Promise<HoldDto> =>
  runOccupancyCommand(pool, (c) => createHold(c, { clientId, visitorId: null }, { branchId, items }, clock));
const confirm = (clientId: string, holdId: string) => runOccupancyCommand(pool, (c) => confirmHold(c, clientId, holdId, clock));
const errCode = (e: unknown): string => {
  if (e instanceof AppError) return e.code;
  throw e;
};
const codeOf = (p: Promise<unknown>): Promise<string> => p.then(() => 'ok', errCode);
/** Одна попытка удержания в гонке: код и само удержание победителя. */
const attempt = (clientId: string, branchId: string, items: HoldItemInput[]) =>
  hold(clientId, branchId, items).then(
    (h) => ({ code: 'ok', clientId, hold: h as HoldDto | null }),
    (e: unknown) => ({ code: errCode(e), clientId, hold: null as HoldDto | null }),
  );
const count = (codes: string[], code: string) => codes.filter((c) => c === code).length;
const holdStatus = async (id: string) => (await one<{ status: string }>('SELECT status FROM app.holds WHERE id = $1', [id])).status;
/** План §8: после гонки – ни одной пары пересечений по активным единицам (и по времени клиента). */
async function overlapsInDb(): Promise<{ units: number; clients: number }> {
  const u = await one<{ n: number }>(`SELECT count(*)::int n FROM app.occupancy a JOIN app.occupancy b ON a.unit_id = b.unit_id AND a.id < b.id AND a.period && b.period WHERE a.active AND b.active`);
  const c = await one<{ n: number }>(`SELECT count(*)::int n FROM app.client_time a JOIN app.client_time b ON a.client_id = b.client_id AND a.id < b.id AND a.period && b.period WHERE a.active AND b.active`);
  return { units: u.n, clients: c.n };
}
const activeOn = async (unitId: string, range: string) => (await one<{ n: number }>(`SELECT count(*)::int n FROM app.occupancy WHERE active AND unit_id = $1 AND period && $2::tstzrange`, [unitId, range])).n;

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 64 });
  const city = await one(`INSERT INTO app.cities (code, slug, name, timezone) VALUES ('nsk', 'nsk', 'НСК', 'Asia/Novosibirsk') RETURNING id`);
  for (const code of ['b1', 'b2']) {
    ids[code] = (await one(`INSERT INTO app.branches (city_id, code, slug, name, address, timezone, status) VALUES ($1, $2, $2, $2, 'Красный, 1', 'Asia/Novosibirsk', 'active') RETURNING id`, [city.id, code])).id;
    await db.client.query(
      `INSERT INTO app.branch_weekly_hours (branch_id, weekday, open_time, close_time, valid_from, created_by) SELECT $1, d, '10:00', '22:00', '2026-01-01', $2 FROM generate_series(1, 7) d`,
      [ids[code], SYS],
    );
    for (const type of ['pc', 'vr_seat', 'room_whole']) {
      await db.client.query(
        `INSERT INTO app.tariffs (branch_id, resource_type, name, unit_minutes, price_per_unit_kop, valid_from, status, created_by) VALUES ($1, $2, $2, 15, 10000, '2026-01-01', 'active', $3)`,
        [ids[code], type, SYS],
      );
    }
  }
  ids.room = (await one(`INSERT INTO app.rooms (branch_id, slug, name, is_published) VALUES ($1, 'vr', 'VR-комната', true) RETURNING id`, [ids.b1])).id;
  for (const c of ['VR1', 'VR2', 'PS4']) units[c] = await unit(ids.b1!, ids.room, c);
  ids.vr1 = await resource(ids.b1!, ids.room, 'vr_seat', 'VR-место 1', [units.VR1!]);
  ids.vr2 = await resource(ids.b1!, ids.room, 'vr_seat', 'VR-место 2', [units.VR2!]);
  ids.whole = await resource(ids.b1!, ids.room, 'room_whole', 'VR-комната целиком', [units.VR1!, units.VR2!, units.PS4!]);
  units.PC1 = await unit(ids.b1!, null, 'PC1');
  ids.pc1 = await resource(ids.b1!, null, 'pc', 'ПК-1', [units.PC1]);
  units.B2PC = await unit(ids.b2!, null, 'PC1');
  ids.b2pc = await resource(ids.b2!, null, 'pc', 'ПК-1', [units.B2PC]);
});
afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('гонки за слот: N параллельных соединений (план §8)', () => {
  it('TC-01: 20 клиентов параллельно берут одно VR-место на один интервал – резерв у одного, у 19 конфликт SLOT_HELD; после подтверждения новая волна 19 – SLOT_TAKEN', async () => {
    const N = 20;
    const clients: string[] = [];
    for (let k = 0; k < N; k++) clients.push(await newClient());
    const slot = span(ids.vr1!, '2026-11-16T07:00:00Z', 30); // 14:00–14:30 местного
    const wave1 = await Promise.all(clients.map((c) => attempt(c, ids.b1!, [slot])));
    const codes1 = wave1.map((r) => r.code);
    expect(count(codes1, 'ok'), codes1.join(',')).toBe(1);
    expect(count(codes1, 'SLOT_HELD')).toBe(N - 1);
    const winner = wave1.find((r) => r.code === 'ok')!;
    expect(await activeOn(units.VR1!, '[2026-11-16 07:00:00+00,2026-11-16 07:30:00+00)')).toBe(1);
    expect(await overlapsInDb()).toEqual({ units: 0, clients: 0 });
    // победитель подтверждает – ровно одна бронь
    const r = await confirm(winner.clientId, winner.hold!.id);
    expect(r.bookings).toHaveLength(1);
    // проигравшие параллельно пробуют пересекающийся интервал – уже бронь, не удержание
    const losers = wave1.filter((x) => x.code !== 'ok').map((x) => x.clientId);
    const codes2 = (await Promise.all(losers.map((c) => attempt(c, ids.b1!, [span(ids.vr1!, '2026-11-16T07:15:00Z', 15)])))).map((x) => x.code);
    expect(count(codes2, 'SLOT_TAKEN')).toBe(N - 1);
    expect(await activeOn(units.VR1!, '[2026-11-16 07:00:00+00,2026-11-16 07:30:00+00)')).toBe(1);
    expect((await one<{ n: number }>(`SELECT count(*)::int n FROM app.bookings WHERE resource_id = $1`, [ids.vr1])).n).toBe(1);
    expect(await overlapsInDb()).toEqual({ units: 0, clients: 0 });
  }, 60_000);

  it('TC-02: два клиента параллельно берут VR1 и VR2 на один интервал – оба резерва и обе брони (10 раз); комната на это время занята целиком – оба SLOT_TAKEN', async () => {
    for (let k = 0; k < 10; k++) {
      const start = iso(Date.parse('2026-11-17T03:00:00Z') + k * 30 * 60_000);
      const [a, b] = [await newClient(), await newClient()];
      const [ha, hb] = await Promise.all([hold(a, ids.b1!, [span(ids.vr1!, start, 30)]), hold(b, ids.b1!, [span(ids.vr2!, start, 30)])]);
      expect([ha.status, hb.status]).toEqual(['active', 'active']);
      const [ra, rb] = await Promise.all([confirm(a, ha.id), confirm(b, hb.id)]);
      expect([ra.bookings.length, rb.bookings.length]).toEqual([1, 1]);
      expect([ra.bookings[0]!.resourceId, rb.bookings[0]!.resourceId]).toEqual([ids.vr1, ids.vr2]);
    }
    expect(await overlapsInDb()).toEqual({ units: 0, clients: 0 });
    // комната целиком занята – независимых мест в ней нет
    const owner = await newClient();
    await confirm(owner, (await hold(owner, ids.b1!, [span(ids.whole!, '2026-11-18T07:00:00Z', 60)])).id);
    const [a, b] = [await newClient(), await newClient()];
    const codes = (await Promise.all([attempt(a, ids.b1!, [span(ids.vr1!, '2026-11-18T07:30:00Z', 15)]), attempt(b, ids.b1!, [span(ids.vr2!, '2026-11-18T07:45:00Z', 15)])])).map((x) => x.code);
    expect(codes).toEqual(['SLOT_TAKEN', 'SLOT_TAKEN']);
    expect(await overlapsInDb()).toEqual({ units: 0, clients: 0 });
  }, 60_000);

  it('TC-03: VR-место 14:00–14:30 против аренды комнаты 14:15–15:15 параллельно в любом порядке (10 раз) – проходит ровно одна сторона; комната против двух мест – комната или места; после брони комнаты любое VR-место – SLOT_TAKEN', async () => {
    for (let k = 0; k < 10; k++) {
      const base = Date.parse('2026-11-19T03:00:00Z') + k * 60 * 60_000; // 10:00…19:00 местного, комната до 20:15
      const [a, b] = [await newClient(), await newClient()];
      const seat = attempt(a, ids.b1!, [span(ids.vr1!, iso(base), 30)]);
      const room = attempt(b, ids.b1!, [span(ids.whole!, iso(base + 15 * 60_000), 60)]);
      const codes = (await Promise.all(k % 2 ? [seat, room] : [room, seat])).map((x) => x.code).sort();
      expect(codes, `итерация ${k}`).toEqual(['SLOT_HELD', 'ok']);
    }
    expect(await overlapsInDb()).toEqual({ units: 0, clients: 0 });
    // комната против двух мест одновременно: если комната прошла – оба места нет; иначе места свободны друг от друга
    for (let k = 0; k < 5; k++) {
      const start = iso(Date.parse('2026-11-20T03:00:00Z') + k * 60 * 60_000);
      const [a, b, c] = [await newClient(), await newClient(), await newClient()];
      const res = await Promise.all([attempt(a, ids.b1!, [span(ids.vr1!, start, 30)]), attempt(b, ids.b1!, [span(ids.vr2!, start, 30)]), attempt(c, ids.b1!, [span(ids.whole!, start, 30)])]);
      const [s1, s2, room] = res.map((x) => x.code);
      if (room === 'ok') expect([s1, s2], `итерация ${k}`).toEqual(['SLOT_HELD', 'SLOT_HELD']);
      else {
        expect(room, `итерация ${k}`).toBe('SLOT_HELD');
        expect([s1, s2].filter((x) => x === 'ok').length, `итерация ${k}`).toBeGreaterThanOrEqual(1);
      }
    }
    expect(await overlapsInDb()).toEqual({ units: 0, clients: 0 });
    // подтверждённая аренда комнаты: 10 клиентов параллельно на VR1 и VR2 внутри её интервала – все SLOT_TAKEN
    const owner = await newClient();
    await confirm(owner, (await hold(owner, ids.b1!, [span(ids.whole!, '2026-11-20T10:00:00Z', 60)])).id);
    const clients: string[] = [];
    for (let k = 0; k < 10; k++) clients.push(await newClient());
    const codes = (await Promise.all(clients.map((c, k) => attempt(c, ids.b1!, [span(k % 2 ? ids.vr1! : ids.vr2!, '2026-11-20T10:30:00Z', 15)])))).map((x) => x.code);
    expect(count(codes, 'SLOT_TAKEN')).toBe(10);
    expect(await activeOn(units.VR1!, '[2026-11-20 10:00:00+00,2026-11-20 11:00:00+00)')).toBe(1);
    expect(await activeOn(units.PS4!, '[2026-11-20 10:00:00+00,2026-11-20 11:00:00+00)')).toBe(1);
    expect(await overlapsInDb()).toEqual({ units: 0, clients: 0 });
  }, 60_000);

  it('TC-04: один клиент параллельно берёт ПК 14:00–15:00 (филиал 2) и VR 14:30–15:00 (филиал 1) – проходит одно, второе CLIENT_OVERLAP (5 раз); VR 15:00–15:30 встык – можно', async () => {
    for (let k = 0; k < 5; k++) {
      const day = `2026-11-${21 + k}`;
      const c = await newClient();
      const res = await Promise.all([attempt(c, ids.b2!, [span(ids.b2pc!, `${day}T07:00:00Z`, 60)]), attempt(c, ids.b1!, [span(ids.vr1!, `${day}T07:30:00Z`, 30)])]);
      expect(res.map((x) => x.code).sort(), `день ${day}`).toEqual(['CLIENT_OVERLAP', 'ok']);
      const winner = res.find((x) => x.code === 'ok')!;
      expect((await confirm(c, winner.hold!.id)).bookings).toHaveLength(1);
      // последовательный интервал того же клиента – без конфликта
      const next = await hold(c, ids.b1!, [span(ids.vr1!, `${day}T08:00:00Z`, 30)]);
      expect((await confirm(c, next.id)).bookings).toHaveLength(1);
      const ct = await db.client.query(`SELECT source_type, count(*)::int n FROM app.client_time WHERE active AND client_id = $1 GROUP BY 1`, [c]);
      expect(ct.rows).toEqual([{ source_type: 'booking', n: 2 }]);
      expect((await one<{ n: number }>(`SELECT count(*)::int n FROM app.holds WHERE client_id = $1 AND status = 'active'`, [c])).n).toBe(0);
    }
    expect(await overlapsInDb()).toEqual({ units: 0, clients: 0 });
  }, 60_000);
});

describe('истечение резерва и общий таймер', () => {
  it('TC-05: удержание без подтверждения через 15 минут истекает – слот свободен и достаётся другому, подтверждение первого – HOLD_EXPIRED; задача истечения гасит остальные, повтор – ничего', async () => {
    const [a, b] = [await newClient(), await newClient()];
    const slot = span(ids.pc1!, '2026-11-27T07:00:00Z', 30);
    const t0 = t;
    const h = await hold(a, ids.b1!, [slot]);
    expect(h.expiresAt).toBe(iso(t0 + 15 * 60_000));
    advance(14);
    expect(await codeOf(hold(b, ids.b1!, [slot]))).toBe('SLOT_HELD'); // ещё держится
    advance(2); // 16-я минута: слот свободен, истёкшее гасится в транзакции следующего
    const hb = await hold(b, ids.b1!, [slot]);
    expect(hb.status).toBe('active');
    expect(await holdStatus(h.id)).toBe('expired');
    expect(await codeOf(confirm(a, h.id))).toBe('HOLD_EXPIRED');
    const released = await db.client.query(`SELECT active, release_reason FROM app.occupancy WHERE source_type = 'hold_item' AND source_id = $1`, [h.items[0]!.id]);
    expect(released.rows).toEqual([{ active: false, release_reason: 'expired' }]);
    expect((await one<{ n: number }>(`SELECT count(*)::int n FROM app.outbox_events WHERE event_type = 'hold.expired' AND aggregate_id = $1`, [h.id])).n).toBe(1);
    expect((await one<{ n: number }>(`SELECT count(*)::int n FROM journal.audit_events WHERE action = 'hold.expired' AND object_id = $1 AND actor_type = 'system'`, [h.id])).n).toBe(1);
    expect(await activeOn(units.PC1!, '[2026-11-27 07:00:00+00,2026-11-27 07:30:00+00)')).toBe(1); // только удержание b
    // задача истечения (раз в 15 с): гасит просроченные, повтор – 0, слот свободен для следующего
    const c = await newClient();
    const slot2 = span(ids.pc1!, '2026-11-27T09:00:00Z', 30);
    const hc = await hold(c, ids.b1!, [slot2]);
    advance(16);
    expect(await expireDueHolds(pool, clock)).toBeGreaterThanOrEqual(1);
    expect(await expireDueHolds(pool, clock)).toBe(0);
    expect([await holdStatus(hc.id), await holdStatus(hb.id)]).toEqual(['expired', 'expired']);
    expect((await hold(await newClient(), ids.b1!, [slot2])).status).toBe('active');
    expect(await overlapsInDb()).toEqual({ units: 0, clients: 0 });
  });

  it('TC-06: добавление слота через 10 минут перезапускает общий таймер всех позиций – на 16-й минуте удержание живо, на 26-й истекло; событие hold.extended', async () => {
    const [a, b] = [await newClient(), await newClient()];
    const s1 = span(ids.pc1!, '2026-11-28T07:00:00Z', 30);
    const s2 = span(ids.vr1!, '2026-11-28T07:30:00Z', 30); // встык: у клиента одно время – одно место
    const t0 = t;
    const h = await hold(a, ids.b1!, [s1]);
    expect(h.expiresAt).toBe(iso(t0 + 15 * 60_000));
    advance(10);
    const ext = await runOccupancyCommand(pool, (c) => addHoldItem(c, { clientId: a, visitorId: null }, h.id, s2, clock));
    expect(ext).toMatchObject({ status: 'active', expiresAt: iso(t0 + 25 * 60_000) });
    expect(ext.items).toHaveLength(2);
    const itemIds = ext.items.map((i) => i.id);
    const occ = await db.client.query(`SELECT DISTINCT hold_expires_at FROM app.occupancy WHERE active AND source_type = 'hold_item' AND source_id = ANY($1::uuid[])`, [itemIds]);
    expect(occ.rows.map((r) => r.hold_expires_at.toISOString())).toEqual([iso(t0 + 25 * 60_000)]);
    const ct = await db.client.query(`SELECT DISTINCT hold_expires_at FROM app.client_time WHERE active AND source_type = 'hold_item' AND source_id = ANY($1::uuid[])`, [itemIds]);
    expect(ct.rows.map((r) => r.hold_expires_at.toISOString())).toEqual([iso(t0 + 25 * 60_000)]);
    const ev = await one<{ payload: { expiresAt: string } }>(`SELECT payload FROM app.outbox_events WHERE event_type = 'hold.extended' AND aggregate_id = $1`, [h.id]);
    expect(ev.payload.expiresAt).toBe(iso(t0 + 25 * 60_000));
    advance(6); // 16-я минута от создания: старый таймер уже прошёл бы, общий – нет
    expect(await codeOf(hold(b, ids.b1!, [s1]))).toBe('SLOT_HELD');
    expect(await codeOf(hold(b, ids.b1!, [s2]))).toBe('SLOT_HELD');
    expect(await holdStatus(h.id)).toBe('active');
    advance(10); // 26-я минута: общий таймер истёк – обе позиции свободны
    expect((await hold(b, ids.b1!, [s1, s2])).status).toBe('active');
    expect(await holdStatus(h.id)).toBe('expired');
    expect(await codeOf(confirm(a, h.id))).toBe('HOLD_EXPIRED');
    expect(await overlapsInDb()).toEqual({ units: 0, clients: 0 });
  });
});

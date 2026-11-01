// S1-28: засев Э1 поверх Э0 – состав филиалов, тарифы на все типы и длительности, исключения графика, демо-клиенты,
// повторный запуск без дублей, отказ на проде; на засеянных данных проходят удержание и бронь (основа S1-26/S1-27).
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../apps/api/src/core/errors.ts';
import { addDays, fixedClock, localToInstant, todayIn, type LocalTime, type TimeZone } from '../apps/api/src/core/time.ts';
import { confirmHold } from '../apps/api/src/modules/booking/confirm.ts';
import { createHold } from '../apps/api/src/modules/booking/hold.ts';
import { runOccupancyCommand } from '../apps/api/src/modules/booking/occupancy.ts';
import { quote } from '../apps/api/src/modules/pricing/tariff.ts';
import { seedDev } from '../db/seed/dev.ts';
import { DEMO_CLIENTS, seedResources, type ResourcesSeedReport } from '../db/seed/resources.ts';
import { createTestDatabase, type TestDatabase } from './helpers/pg.ts';

const clock = fixedClock('2026-11-14T05:00:00Z');
const TZ = 'Asia/Novosibirsk' as TimeZone;
let db: TestDatabase;
let pool: pg.Pool;
let first: ResourcesSeedReport;

async function counts(): Promise<Record<string, number>> {
  const r = await db.client.query(`SELECT
    (SELECT count(*)::int FROM app.rooms) rooms, (SELECT count(*)::int FROM app.resources) resources,
    (SELECT count(*)::int FROM app.occupancy_units) units, (SELECT count(*)::int FROM app.resource_units) composition,
    (SELECT count(*)::int FROM app.tariffs) tariffs, (SELECT count(*)::int FROM app.calendar_exceptions) exceptions,
    (SELECT count(*)::int FROM app.clients) clients, (SELECT count(*)::int FROM journal.audit_events) audit`);
  return r.rows[0];
}
const codeOf = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'ok',
    (e: unknown) => {
      if (e instanceof AppError) return e.code;
      throw e;
    },
  );

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
});
afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('S1-28: засев Э1', () => {
  it('на проде – отказ до записи; без засева Э0 – понятная ошибка', async () => {
    await expect(seedResources(pool, { env: { APP_ENV: 'prod' } }, clock)).rejects.toThrow(/только для dev\/stage\/test/);
    await expect(seedResources(pool, { env: { APP_ENV: 'test' } }, clock)).rejects.toThrow(/засев Э0/);
    expect((await counts()).resources).toBe(0);
  });

  it('в каждом из трёх демо-филиалов: VR-комната (VR1, VR2, PS4, вся комната), 5 ПК, 3 комнаты PS5', async () => {
    await seedDev(pool, { env: { APP_ENV: 'test' }, password: 'Демо-пароль-засева-1' }, clock);
    first = await seedResources(pool, { env: { APP_ENV: 'test' } }, clock);
    expect(first.created).toEqual({ rooms: 12, resources: 33, units: 3, tariffs: 24, exceptions: 6, clients: 5 });
    expect(Object.keys(first.branches).sort()).toEqual(['demo-msk-arbat', 'demo-msk-dst', 'demo-nsk-krasny']);
    for (const b of Object.values(first.branches)) {
      expect(b.pcs).toHaveLength(5);
      expect(b.ps5).toHaveLength(3);
      const whole = await db.client.query<{ code: string }>(
        `SELECT u.code FROM app.resource_units ru JOIN app.occupancy_units u ON u.id = ru.unit_id WHERE ru.resource_id = $1 ORDER BY u.code`,
        [b.vrWhole],
      );
      expect(whole.rows.map((x) => x.code)).toEqual(['PS4', 'VR1', 'VR2']);
      const room = await db.client.query(`SELECT is_published, whole_rent_allowed FROM app.rooms WHERE id = $1`, [b.vrRoomId]);
      expect(room.rows[0]).toEqual({ is_published: true, whole_rent_allowed: true });
    }
  });

  it('тариф находится на любой тип и длительность; исключения – сокращённый день и закрытие; клиенты помечены', async () => {
    const b = (await db.client.query<{ id: string }>(`SELECT id FROM app.branches WHERE code = 'demo-nsk-krasny'`)).rows[0]!.id;
    for (const resourceType of ['pc', 'vr_seat', 'room_whole', 'ps_room']) {
      for (const durationMinutes of [15, 60, 179, 180, 600]) {
        const q = await quote(pool, { branchId: b, resourceType, start: new Date('2026-11-16T06:00:00Z'), durationMinutes });
        expect(q.priceKop).toBeGreaterThan(0);
      }
    }
    const exc = await db.client.query(`SELECT kind, reason FROM app.calendar_exceptions WHERE branch_id = $1 AND status = 'active' ORDER BY local_date`, [b]);
    expect(exc.rows.map((x) => x.kind)).toEqual(['short_day', 'closed']);
    expect(exc.rows.every((x) => x.reason.startsWith('DEMO:'))).toBe(true);
    const cl = await db.client.query(`SELECT last_name FROM app.clients WHERE phone_e164 = ANY($1::text[])`, [DEMO_CLIENTS.map((c) => c.phone)]);
    expect(cl.rows).toHaveLength(5);
    expect(cl.rows.every((x) => x.last_name.endsWith('(демо)'))).toBe(true);
  });

  it('повторный запуск не плодит дубли и не пишет лишний аудит; тот же состав', async () => {
    const before = await counts();
    const again = await seedResources(pool, { env: { APP_ENV: 'stage' } }, clock);
    expect(again.created).toEqual({ rooms: 0, resources: 0, units: 0, tariffs: 0, exceptions: 0, clients: 0 });
    expect(again.branches).toEqual(first.branches);
    expect(await counts()).toEqual(before);
  });

  it('на засеянных данных: «вся комната» и место VR1 на один слот – одно удержание, бронь подтверждается', async () => {
    const r = first.branches['demo-nsk-krasny']!;
    const b = (await db.client.query<{ id: string }>(`SELECT id FROM app.branches WHERE code = 'demo-nsk-krasny'`)).rows[0]!.id;
    const [c1, c2] = (await db.client.query<{ id: string }>(`SELECT id FROM app.clients WHERE phone_e164 = ANY($1::text[]) ORDER BY phone_e164 LIMIT 2`, [DEMO_CLIENTS.map((c) => c.phone)])).rows;
    const day = addDays(todayIn(clock, TZ), 2);
    const start = localToInstant(day, '12:00' as LocalTime, TZ);
    const end = localToInstant(day, '13:00' as LocalTime, TZ);
    const hold = (clientId: string, resourceId: string) =>
      runOccupancyCommand(pool, (tx) => createHold(tx, { clientId, visitorId: null }, { branchId: b, items: [{ resourceId, start, end }] }, clock));
    const [a, z] = await Promise.all([codeOf(hold(c1!.id, r.vrWhole)), codeOf(hold(c2!.id, r.vr1))]);
    expect([a, z].filter((x) => x === 'ok')).toHaveLength(1);
    const winner = a === 'ok' ? c1!.id : c2!.id;
    const h = (await db.client.query<{ id: string }>(`SELECT id FROM app.holds WHERE client_id = $1 AND status = 'active'`, [winner])).rows[0]!;
    const done = await runOccupancyCommand(pool, (tx) => confirmHold(tx, winner, h.id, clock));
    expect(done.bookings).toHaveLength(1);
  });
});

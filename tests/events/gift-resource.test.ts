// S3-62: подарочный ресурс в бою на настоящей Postgres. Повтор – без дублей (и параллельно); филиал без VR-комнаты – ресурса нет;
// создан тариф 0 ₽, состав VR1+VR2 без PS4, закрыт для обычной записи; после него TC-14 проходит в филиале.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { createHold, clearServiceGrants } from '../../apps/api/src/modules/booking/hold.ts';
import { confirmHold } from '../../apps/api/src/modules/booking/confirm.ts';
import { runOccupancyCommand } from '../../apps/api/src/modules/booking/occupancy.ts';
import { holdGift, registerGiftGrant } from '../../apps/api/src/modules/events/gift-booking.ts';
import { ensureGiftResource, GIFT_RESOURCE_NAME } from '../../apps/api/src/modules/events/gift-resource.ts';
import { issueGift } from '../../apps/api/src/modules/events/gifts.ts';
import { AppError } from '../../apps/api/src/core/errors.ts';
import { ensureAllGiftResources } from '../../db/seed/gift-resources.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const clock = fixedClock('2026-06-01T05:00:00Z');
let db: TestDatabase;
let pool: pg.Pool;
let staff: AccessContext;
let city = '';
let counter = 0;

const meta = (): AuditRequestMeta => ({ actor: staff.actor, access: staff, source: 'crm', requestId: randomUUID() });
const tx = <T>(fn: (c: pg.PoolClient) => Promise<T>) => runOccupancyCommand(pool, fn);
const one = async (sql: string, params: unknown[] = []) => (await db.client.query(sql, params)).rows[0];
const ensure = (branchId: string, ctx = staff) => tx((c) => ensureGiftResource(c, ctx, branchId, meta(), clock));

async function branch(vrSeats: number, opts: { ps4?: boolean } = {}): Promise<string> {
  const code = `b${++counter}`;
  const b = (await one(`INSERT INTO app.branches (city_id, code, slug, name, address, timezone, status) VALUES ($1, $2, $2, $2, 'адрес', 'Asia/Novosibirsk', 'active') RETURNING id`, [city, code])).id as string;
  await db.client.query(`INSERT INTO app.branch_weekly_hours (branch_id, weekday, open_time, close_time, valid_from, created_by) SELECT $1, d, '10:00', '22:00', '2026-01-01', $2 FROM generate_series(1, 7) d`, [b, staff.actor.staffId]);
  const room = (await one(`INSERT INTO app.rooms (branch_id, slug, name, is_published) VALUES ($1, 'vr', 'VR', true) RETURNING id`, [b])).id;
  for (let i = 1; i <= vrSeats; i++) {
    const u = (await one(`INSERT INTO app.occupancy_units (branch_id, room_id, code, name) VALUES ($1, $2, $3, $3) RETURNING id`, [b, room, `VR${i}`])).id;
    const r = (await one(`INSERT INTO app.resources (branch_id, room_id, resource_type, name) VALUES ($1, $2, 'vr_seat', $3) RETURNING id`, [b, room, `VR-место ${i}`])).id;
    await db.client.query(`INSERT INTO app.resource_units (resource_id, unit_id, valid_from) VALUES ($1, $2, '2026-01-01')`, [r, u]);
  }
  if (opts.ps4) await db.client.query(`INSERT INTO app.occupancy_units (branch_id, room_id, code, name) VALUES ($1, $2, 'PS4', 'PS4')`, [b, room]);
  return b;
}
const giftsIn = (b: string) => db.client.query(`SELECT id, status, self_bookable, step_minutes_override FROM app.resources WHERE branch_id = $1 AND resource_type = 'gift_vr'`, [b]);

beforeAll(async () => {
  clearServiceGrants();
  registerGiftGrant();
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 12 });
  const s = await one(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', 'o@yu.test', 'owner', 'x') RETURNING id`);
  staff = { actor: { kind: 'staff', staffId: s.id, sessionId: randomUUID() }, role: 'owner', network: true, cityIds: new Set(), branchIds: new Set(), at: clock.now() };
  city = (await one(`INSERT INTO app.cities (code, slug, name, timezone) VALUES ('nsk', 'nsk', 'НСК', 'Asia/Novosibirsk') RETURNING id`)).id;
});
afterAll(async () => {
  clearServiceGrants();
  await pool.end();
  await db.drop();
});

describe('S3-62: ensureGiftResource', () => {
  it('создаёт gift_vr: VR1+VR2 без PS4, self_bookable=false, шаг 5; тариф 0 ₽; аудит', async () => {
    const b = await branch(2, { ps4: true });
    const r = await ensure(b);
    expect(r).toMatchObject({ status: 'created', tariffCreated: true });
    const rows = (await giftsIn(b)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ self_bookable: false, step_minutes_override: 5, status: 'active' });
    const codes = await db.client.query(`SELECT u.code FROM app.resource_units ru JOIN app.occupancy_units u ON u.id = ru.unit_id WHERE ru.resource_id = $1 ORDER BY u.code`, [rows[0].id]);
    expect(codes.rows.map((x) => x.code)).toEqual(['VR1', 'VR2']);
    const t = await one(`SELECT price_per_unit_kop, status FROM app.tariffs WHERE branch_id = $1 AND resource_type = 'gift_vr'`, [b]);
    expect(t).toEqual({ price_per_unit_kop: '0', status: 'active' });
    expect((await one(`SELECT name FROM app.resources WHERE id = $1`, [rows[0].id])).name).toBe(GIFT_RESOURCE_NAME);
    expect((await db.client.query(`SELECT 1 FROM journal.audit_events WHERE action = 'resource.created' AND object_id = $1`, [rows[0].id])).rowCount).toBe(1);
  });
  it('повтор – без дублей, в том числе 10 параллельных; сотруднику без прав на тарифы не мешает', async () => {
    const b = await branch(2);
    const director: AccessContext = { ...staff, role: 'admin', network: false, branchIds: new Set([b]) };
    const results = await Promise.all(Array.from({ length: 10 }, () => ensure(b, director)));
    expect(results.filter((r) => r.status === 'created')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'exists')).toHaveLength(9);
    expect(await ensure(b)).toMatchObject({ status: 'exists', tariffCreated: false });
    expect((await giftsIn(b)).rows).toHaveLength(1);
    expect((await db.client.query(`SELECT 1 FROM app.tariffs WHERE branch_id = $1 AND resource_type = 'gift_vr'`, [b])).rowCount).toBe(1);
  });
  it('филиал без VR-комнаты и с одним шлемом – ресурса нет', async () => {
    const none = await branch(0, { ps4: true });
    expect(await ensure(none)).toEqual({ status: 'no_vr_room' });
    expect((await giftsIn(none)).rowCount).toBe(0);
    const single = await branch(1);
    expect(await ensure(single)).toEqual({ status: 'no_vr_room' });
    expect((await db.client.query(`SELECT 1 FROM app.tariffs WHERE branch_id = $1`, [single])).rowCount).toBe(0);
  });
  it('в комнате больше двух мест – первые два по коду; архивный ресурс не воскрешается, недостающий тариф дополняется', async () => {
    const b = await branch(3);
    await ensure(b);
    const row = (await giftsIn(b)).rows[0];
    const codes = await db.client.query(`SELECT u.code FROM app.resource_units ru JOIN app.occupancy_units u ON u.id = ru.unit_id WHERE ru.resource_id = $1 ORDER BY u.code`, [row.id]);
    expect(codes.rows.map((x) => x.code)).toEqual(['VR1', 'VR2']);
    await db.client.query(`UPDATE app.resources SET status = 'archived', archived_at = now() WHERE id = $1`, [row.id]);
    await db.client.query(`UPDATE app.tariffs SET status = 'archived', archived_at = now() WHERE branch_id = $1 AND resource_type = 'gift_vr'`, [b]);
    expect(await ensure(b)).toMatchObject({ status: 'exists', resourceId: row.id, tariffCreated: true });
    expect((await giftsIn(b)).rows).toHaveLength(1);
  });
  it('после неё TC-14 проходит в филиале: подарок записывается с ценой 0, обычная запись закрыта', async () => {
    const b = await branch(2, { ps4: true });
    await ensure(b);
    const clientId = (await one(`INSERT INTO app.clients (phone_e164, first_name, status, created_by_type) VALUES ('+79131112299', 'Катя', 'active', 'system') RETURNING id`)).id;
    const gift = await tx((c) => issueGift(c, staff, { clientId, branchId: b, reason: 'тест' }, meta(), clock));
    const start = new Date('2026-06-03T05:00:00Z');
    const hold = await tx((c) => holdGift(c, { clientId, visitorId: null }, gift.id, { branchId: b, start }, meta(), clock));
    expect(hold.items[0]!.priceKop).toBe(0);
    const done = await tx((c) => confirmHold(c, clientId, hold.id, clock));
    expect(done.bookings[0]).toMatchObject({ priceKop: 0, durationMinutes: 40 });
    const resourceId = (await giftsIn(b)).rows[0].id;
    await expect(tx((c) => createHold(c, { clientId, visitorId: null }, { branchId: b, items: [{ resourceId, start: new Date('2026-06-04T05:00:00Z'), end: new Date('2026-06-04T05:40:00Z') }] }, clock))).rejects.toBeInstanceOf(AppError);
  });
});

describe('S3-62: боевая процедура gift:ensure', () => {
  it('все филиалы: создаёт где есть VR-комната, повтор ничего не добавляет', async () => {
    await db.client.query(`UPDATE app.branches SET status = 'archived', archived_at = now() WHERE status <> 'archived'`);
    const withRoom = await branch(2);
    const without = await branch(0);
    const first = await ensureAllGiftResources(pool, clock);
    expect(first).toMatchObject({ created: 1, noVrRoom: 1, tariffsCreated: 1 });
    expect((await giftsIn(withRoom)).rowCount).toBe(1);
    expect((await giftsIn(without)).rowCount).toBe(0);
    const second = await ensureAllGiftResources(pool, clock);
    expect(second).toMatchObject({ created: 0, tariffsCreated: 0 });
    expect(second.existed).toBeGreaterThanOrEqual(1);
    expect((await giftsIn(withRoom)).rowCount).toBe(1);
  });
  it('запуск с APP_ENV=prod как в бою: без демо-флага; npm-скрипт указывает на эту процедуру; нет Владельца – понятная ошибка', async () => {
    const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['gift:ensure']).toBe('node db/seed/gift-resources.ts');
    const b = await branch(2);
    const run = promisify(execFile);
    const script = new URL('../../db/seed/gift-resources.ts', import.meta.url).pathname;
    const out = await run(process.execPath, [script], { env: { PATH: process.env.PATH ?? '', APP_ENV: 'prod', DATABASE_URL: db.url } });
    expect(JSON.parse(out.stdout)).toMatchObject({ created: 1 });
    expect((await giftsIn(b)).rowCount).toBe(1);
    expect(await readFile(script, 'utf8')).not.toContain('assertNotProduction');
    await db.client.query(`UPDATE app.staff SET status = 'blocked' WHERE role = 'owner'`);
    await expect(run(process.execPath, [script], { env: { PATH: process.env.PATH ?? '', DATABASE_URL: db.url } })).rejects.toThrow(/Владельца/);
  });
});

// Фикстуры отчётов (S4-63…S4-69): филиал с графиком, единицы и ресурсы, брони с версиями и занятостью, посещения, неявки,
// переносы, блокировки – прямым SQL владельцем базы: отчёты читают представления, а команды модулей проверены своими тестами.
// Контексты сотрудников – без таблицы назначений: область уже посчитана loadAccess.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import { fixedClock, type LocalDate } from '../../apps/api/src/core/time.ts';
import { createReportsPool, withReportTx, type ReportEnv } from '../../apps/api/src/modules/reports/framework.ts';
import { createTestBranch } from './network.ts';
import type { TestDatabase } from './pg.ts';

export const SYS = '00000000-0000-4000-8000-000000000000';
export const d = (s: string): LocalDate => s as LocalDate;
let seq = 0;

export interface BookingInput {
  branchId: string;
  clientId: string;
  resourceId: string;
  units?: string[];
  start: string;
  end?: string;
  status?: string;
  priceKop?: number;
  createdAt?: string;
  createdById?: string;
  cancelledAt?: string;
}

export interface Fx {
  db: TestDatabase;
  app: pg.Pool;
  reports: pg.Pool;
  ownerId: string;
  owner(at?: Date): AccessContext;
  director(branchIds: string[]): AccessContext;
  admin(branchIds: string[]): AccessContext;
  run<T>(ctx: AccessContext, fn: (env: ReportEnv) => Promise<T>, now?: string): Promise<T>;
  close(): Promise<void>;
  branch(timezone?: string, hours?: { open: string; close: string } | null): Promise<{ id: string; cityId: string }>;
  unit(branchId: string, code: string, roomId?: string | null): Promise<string>;
  resource(branchId: string, type: string, name: string, units: string[], opts?: { roomId?: string | null; selfBookable?: boolean }): Promise<string>;
  room(branchId: string, slug: string): Promise<string>;
  client(opts?: { guest?: boolean; firstName?: string; lastName?: string; createdAt?: string }): Promise<string>;
  booking(o: BookingInput): Promise<string>;
  visit(bookingId: string, at?: string): Promise<string>;
  noShow(bookingId: string, at?: string): Promise<string>;
  reschedule(bookingId: string, newStart: string, newEnd: string, at: string): Promise<void>;
  block(branchId: string, units: string[], start: string, end: string, reasonCode?: string): Promise<string>;
  exception(branchId: string, date: string, kind: string, hours?: { open: string; close: string }): Promise<void>;
}

export async function reportFixtures(db: TestDatabase): Promise<Fx> {
  const app = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 6 });
  const reports = createReportsPool(db.reportsUrl);
  const q = async <R extends pg.QueryResultRow = { id: string }>(sql: string, params: unknown[] = []) => (await db.client.query<R>(sql, params)).rows;
  const ownerId = (await q(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('В', 'В', $1, 'owner', 'x') RETURNING id`, [`${randomUUID()}@club.ru`]))[0]!.id;
  const base = (at: Date): AccessContext => ({ actor: { kind: 'staff', staffId: ownerId, sessionId: randomUUID() }, role: 'owner', network: true, cityIds: new Set(), branchIds: new Set(), at });
  const NOW = new Date('2026-11-20T05:00:00Z');
  const fx: Fx = {
    db,
    app,
    reports,
    ownerId,
    owner: (at = NOW) => base(at),
    director: (ids) => ({ ...base(NOW), role: 'director', network: false, branchIds: new Set(ids) }),
    admin: (ids) => ({ ...base(NOW), role: 'admin', network: false, branchIds: new Set(ids) }),
    run: (ctx, fn, now = NOW.toISOString()) => withReportTx(reports, (tx) => fn({ tx, main: app, ctx, clock: fixedClock(now) })),
    close: async () => {
      await reports.end();
      await app.end();
    },
    branch: async (timezone = 'Asia/Novosibirsk', hours = { open: '10:00', close: '22:00' }) => {
      const b = await createTestBranch(db.client, { timezone });
      if (hours) {
        await db.client.query(
          `INSERT INTO app.branch_weekly_hours (branch_id, weekday, open_time, close_time, valid_from, created_by)
           SELECT $1, wd, $2::time, $3::time, '2020-01-01', $4 FROM generate_series(1, 7) wd`,
          [b.id, hours.open, hours.close, SYS],
        );
      }
      return b;
    },
    unit: async (branchId, code, roomId = null) => (await q(`INSERT INTO app.occupancy_units (branch_id, room_id, code, name) VALUES ($1, $2, $3, $3) RETURNING id`, [branchId, roomId, code]))[0]!.id,
    room: async (branchId, slug) => (await q(`INSERT INTO app.rooms (branch_id, slug, name, whole_rent_allowed) VALUES ($1, $2, $2, true) RETURNING id`, [branchId, slug]))[0]!.id,
    resource: async (branchId, type, name, units, opts = {}) => {
      const id = (await q(`INSERT INTO app.resources (branch_id, room_id, resource_type, name, self_bookable) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [branchId, opts.roomId ?? null, type, name, opts.selfBookable ?? true]))[0]!.id;
      for (const u of units) await db.client.query(`INSERT INTO app.resource_units (resource_id, unit_id, valid_from) VALUES ($1, $2, '2020-01-01')`, [id, u]);
      return id;
    },
    client: async (opts = {}) => {
      const n = ++seq;
      return (
        await q(
          `INSERT INTO app.clients (phone_e164, first_name, last_name, status, created_by_type, registered_at, created_at)
           VALUES ($1, $2, $3, $4, 'system', $5::timestamptz, coalesce($6::timestamptz, now())) RETURNING id`,
          [`+7913${String(1_000_000 + n)}`, opts.firstName ?? null, opts.lastName ?? null, opts.guest ? 'guest' : 'active', opts.guest ? null : (opts.createdAt ?? '2026-01-01T00:00:00Z'), opts.createdAt ?? null],
        )
      )[0]!.id;
    },
    booking: async (o) => {
      const end = o.end ?? new Date(Date.parse(o.start) + 3_600_000).toISOString();
      const status = o.status ?? 'completed';
      const cancelled = status.startsWith('cancelled');
      const id = (
        await q(
          `INSERT INTO app.bookings (checkout_id, branch_id, client_id, resource_id, period, price_kop, source, created_by_type, created_by_id, status, created_at, cancelled_at, cancel_comment)
           VALUES (gen_random_uuid(), $1, $2, $3, tstzrange($4, $5, '[)'), $6, 'crm', 'staff', $7, $8, $9, $10, $11) RETURNING id`,
          [o.branchId, o.clientId, o.resourceId, o.start, end, o.priceKop ?? 10_000, o.createdById ?? null, status, o.createdAt ?? o.start, cancelled ? (o.cancelledAt ?? o.start) : null, cancelled ? 'т' : null],
        )
      )[0]!.id;
      const units = o.units?.length ? o.units : [randomUUID()];
      await db.client.query(
        `INSERT INTO journal.booking_versions (booking_id, version, resource_id, period, branch_timezone, unit_ids, resource_snapshot, price_kop, price_snapshot, created_by_type, created_at)
         VALUES ($1, 1, $2, tstzrange($3, $4, '[)'), 'UTC', $5::uuid[], '{"name":"Р"}', $6, '{}', 'staff', $7)`,
        [id, o.resourceId, o.start, end, units, o.priceKop ?? 10_000, o.createdAt ?? o.start],
      );
      if (o.units?.length && !cancelled) {
        for (const u of o.units) {
          await db.client.query(`INSERT INTO app.occupancy (unit_id, branch_id, period, source_type, source_id, booking_version) VALUES ($1, $2, tstzrange($3, $4, '[)'), 'booking', $5, 1)`, [u, o.branchId, o.start, end, id]);
        }
      }
      return id;
    },
    visit: async (bookingId, at) =>
      (
        await q(
          `INSERT INTO app.visits (booking_id, branch_id, client_id, arrived_at, marked_by)
           SELECT id, branch_id, client_id, coalesce($2::timestamptz, lower(period)), $3 FROM app.bookings WHERE id = $1 RETURNING id`,
          [bookingId, at ?? null, SYS],
        )
      )[0]!.id,
    noShow: async (bookingId, at) =>
      (
        await q(
          `INSERT INTO app.no_shows (booking_id, branch_id, client_id, marked_at, marked_by)
           SELECT id, branch_id, client_id, coalesce($2::timestamptz, upper(period)), $3 FROM app.bookings WHERE id = $1 RETURNING id`,
          [bookingId, at ?? null, SYS],
        )
      )[0]!.id,
    reschedule: async (bookingId, newStart, newEnd, at) => {
      await db.client.query(`UPDATE app.bookings SET period = tstzrange($2, $3, '[)'), current_version = current_version + 1 WHERE id = $1`, [bookingId, newStart, newEnd]);
      await db.client.query(
        `INSERT INTO journal.booking_versions (booking_id, version, resource_id, period, branch_timezone, unit_ids, resource_snapshot, price_kop, price_snapshot, created_by_type, created_at)
         SELECT b.id, b.current_version, b.resource_id, b.period, 'UTC', v.unit_ids, '{}', b.price_kop, '{}', 'staff', $2
         FROM app.bookings b JOIN journal.booking_versions v ON v.booking_id = b.id AND v.version = b.current_version - 1 WHERE b.id = $1`,
        [bookingId, at],
      );
      await db.client.query(`UPDATE app.occupancy SET period = tstzrange($2, $3, '[)'), booking_version = booking_version + 1 WHERE source_id = $1 AND active`, [bookingId, newStart, newEnd]);
    },
    block: async (branchId, units, start, end, reasonCode = 'repair') => {
      const reason = (await q(`SELECT id FROM app.dict_reasons WHERE domain = 'resource_block' AND code = $1`, [reasonCode]))[0]!.id;
      const id = (
        await q(
          `INSERT INTO app.resource_blocks (branch_id, target_type, target_ids, period, reason_id, created_by) VALUES ($1, 'unit', $2::uuid[], tstzrange($3, $4, '[)'), $5, $6) RETURNING id`,
          [branchId, units, start, end, reason, SYS],
        )
      )[0]!.id;
      for (const u of units) await db.client.query(`INSERT INTO app.resource_block_units (block_id, unit_id, period) VALUES ($1, $2, tstzrange($3, $4, '[)'))`, [id, u, start, end]);
      return id;
    },
    exception: async (branchId, date, kind, hours) => {
      await db.client.query(
        `INSERT INTO app.calendar_exceptions (branch_id, scope_type, local_date, kind, open_time, close_time, reason, created_by) VALUES ($1, 'branch', $2, $3, $4, $5, 'тест', $6)`,
        [branchId, date, kind, hours?.open ?? null, hours?.close ?? null, SYS],
      );
    },
  };
  return fx;
}

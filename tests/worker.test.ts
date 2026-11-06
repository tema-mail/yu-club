// Процесс worker целиком (apps/api/src/worker.ts → startWorkerTasks): подписки уведомлений регистрируются
// до outbox-воркера, событие booking.confirmed из outbox через pg-boss доходит до обработчика
// и даёт плановые строки «подтверждено» + два напоминания. Без ручного processEvent – как на стенде.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createFileStore, type FileStore } from '../apps/api/src/core/files.ts';
import { clearSubscriptions, listSubscriptions } from '../apps/api/src/core/outbox.ts';
import type { Clock } from '../apps/api/src/core/time.ts';
import { confirmHold } from '../apps/api/src/modules/booking/confirm.ts';
import { createHold } from '../apps/api/src/modules/booking/hold.ts';
import { runOccupancyCommand } from '../apps/api/src/modules/booking/occupancy.ts';
import { createReportsPool } from '../apps/api/src/modules/reports/framework.ts';
import { startWorkerTasks, type WorkerTasks } from '../apps/api/src/worker.ts';
import { createTestDatabase, type TestDatabase } from './helpers/pg.ts';

const SYS = '00000000-0000-0000-0000-000000000001';
const t = new Date('2026-11-14T05:00:00Z').getTime(); // 12:00 Новосибирска
const clock: Clock = { now: () => new Date(t) };
let db: TestDatabase;
let pool: pg.Pool;
let boss: PgBoss;
let tasks: WorkerTasks | undefined;
let reports: pg.Pool;
let exportDir: string;
let exportStore: FileStore;
const errors: unknown[] = [];

async function one<T = { id: string }>(sql: string, params: unknown[] = []): Promise<T> {
  return (await db.client.query(sql, params)).rows[0] as T;
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 6 });
  // pg-boss в тесте – от владельца базы (на стенде – роль yu_boss, схема pgboss, ADR 0001)
  boss = new PgBoss({ connectionString: db.url, schema: 'pgboss' });
  boss.on('error', (err) => errors.push(err));
  await boss.start();
  clearSubscriptions();
  reports = createReportsPool(db.reportsUrl);
  exportDir = await mkdtemp(join(tmpdir(), 'yu-worker-export-'));
  exportStore = createFileStore({ root: exportDir });
}, 60_000);

afterAll(async () => {
  await tasks?.stop();
  await boss?.stop({ graceful: false });
  clearSubscriptions();
  await reports?.end();
  await rm(exportDir, { recursive: true, force: true });
  await pool?.end();
  await db?.drop();
});

it('booking.confirmed из outbox → worker планирует подтверждение и напоминания', async () => {
  const city = await one(`INSERT INTO app.cities (code, slug, name, timezone) VALUES ('nsk', 'nsk', 'НСК', 'Asia/Novosibirsk') RETURNING id`);
  const branchId = (await one(`INSERT INTO app.branches (city_id, code, slug, name, address, timezone, status) VALUES ($1, 'b1', 'b1', 'b1', 'адрес', 'Asia/Novosibirsk', 'active') RETURNING id`, [city.id])).id;
  await db.client.query(`INSERT INTO app.branch_weekly_hours (branch_id, weekday, open_time, close_time, valid_from, created_by) SELECT $1, d, '10:00', '22:00', '2026-01-01', $2 FROM generate_series(1, 7) d`, [branchId, SYS]);
  await db.client.query(`INSERT INTO app.tariffs (branch_id, resource_type, name, unit_minutes, price_per_unit_kop, valid_from, status, created_by) VALUES ($1, 'pc', 'pc', 30, 20000, '2026-01-01', 'active', $2)`, [branchId, SYS]);
  const unit = await one(`INSERT INTO app.occupancy_units (branch_id, code, name) VALUES ($1, 'PC1', 'PC1') RETURNING id`, [branchId]);
  const pc = (await one(`INSERT INTO app.resources (branch_id, resource_type, name) VALUES ($1, 'pc', 'ПК-1') RETURNING id`, [branchId])).id;
  await db.client.query(`INSERT INTO app.resource_units (resource_id, unit_id, valid_from) VALUES ($1, $2, '2026-01-01')`, [pc, unit.id]);

  tasks = await startWorkerTasks({ pool, boss, vapid: null, clock, outboxIntervalMs: 300, pollingIntervalSeconds: 0.5, dispatcherIntervalMs: 500, logger: { error: (obj) => void errors.push(obj) }, exports: { reports, store: exportStore, intervalMs: 200 } });

  const clientId = (await one(`INSERT INTO app.clients (phone_e164, status, created_by_type) VALUES ('+79130000001', 'active', 'system') RETURNING id`)).id;
  const start = new Date('2026-11-16T07:00:00Z');
  const hold = await runOccupancyCommand(pool, (c) => createHold(c, { clientId, visitorId: null }, { branchId, items: [{ resourceId: pc, start, end: new Date(start.getTime() + 3_600_000) }] }, clock));
  const bookingId = (await runOccupancyCommand(pool, (c) => confirmHold(c, clientId, hold.id, clock))).bookings[0]!.id;

  const kinds = async () =>
    (await db.client.query<{ kind: string; status: string }>(`SELECT kind, status FROM app.notifications WHERE booking_id = $1 ORDER BY kind`, [bookingId])).rows;
  const deadline = Date.now() + 20_000;
  while ((await kinds()).length < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 300));

  // «подтверждено» наступает сразу – диспетчер (500 мс) уже мог его отработать; напоминания – в будущем
  expect((await kinds()).map((r) => r.kind)).toEqual(['booking_confirmed', 'reminder_before_start', 'reminder_day_before']);
  expect((await kinds()).filter((r) => r.kind !== 'booking_confirmed').every((r) => r.status === 'planned')).toBe(true);

  // Проверки 1–4 перед отправкой: диспетчер worker сверяется с таблицей броней (bookingLookup).
  // Версия брони ушла вперёд в обход событий – наступившее напоминание не шлём: skipped_booking_changed.
  // Без bookingLookup строка ушла бы в «нет канала» (VAPID в тесте нет).
  await db.client.query(`UPDATE app.bookings SET current_version = current_version + 1 WHERE id = $1`, [bookingId]);
  await db.client.query(`UPDATE app.notifications SET planned_at = $2 WHERE booking_id = $1 AND kind = 'reminder_day_before'`, [bookingId, new Date(t - 60_000)]);
  const dayBefore = async () => (await kinds()).find((r) => r.kind === 'reminder_day_before')!.status;
  const until = Date.now() + 10_000;
  while (['planned', 'queued', 'sending'].includes(await dayBefore()) && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
  expect(await dayBefore()).toBe('skipped_booking_changed');
  expect(errors).toEqual([]);
}, 60_000);

it('экспорт подключён: задача из очереди становится файлом (K24 §7)', async () => {
  const staff = (await one(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('В', 'В', 'owner@worker.test', 'owner', 'x') RETURNING id`)).id;
  const job = (await one(`INSERT INTO app.report_exports (staff_id, report, format, params, params_hash, detail, masked) VALUES ($1, 'bookings', 'csv', '{"from":"2026-10-01","to":"2026-10-31"}', 'worker', false, true) RETURNING id`, [staff])).id;
  const status = async () => (await db.client.query<{ status: string; file_key: string | null; error_code: string | null }>(`SELECT status, file_key, error_code FROM app.report_exports WHERE id = $1`, [job])).rows[0]!;
  const until = Date.now() + 15_000;
  while (['queued', 'running'].includes((await status()).status) && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  const done = await status();
  expect(done).toMatchObject({ status: 'ready', error_code: null });
  expect((await exportStore.read(done.file_key!)).toString()).toContain('Бронирования и посещаемость');
}, 30_000);

it('подписки уведомлений на события брони зарегистрированы worker', () => {
  expect(listSubscriptions().map((s) => s.name)).toEqual(
    expect.arrayContaining(['notifications.onBookingConfirmed', 'notifications.onBookingRescheduled', 'notifications.onBookingCancelled']),
  );
});

it('баллы подключены к оплате finance: начисление и снятие резерва paid_other по payment.recorded (K15 §3–4)', () => {
  const byType = listSubscriptions().filter((s) => s.type === 'payment.recorded').map((s) => s.name);
  expect(byType).toEqual(expect.arrayContaining(['loyalty.accrual.onPaymentRecorded', 'loyalty.reserve.onPaymentRecorded']));
});

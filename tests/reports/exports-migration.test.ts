// S4-71: миграция 0408. На чистой базе 0408 идёт после 0311: CHECK журнала сверки содержит значения обеих (K24 §12, С4.1) –
// вместо ещё не влитой 0311 здесь её подобие в отдельном каталоге; вверх/вниз/вверх; страж: всё, что пишет ночная сверка, CHECK пропускает.
import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, migrateDown, migrateUp } from '../../db/migrate.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const PROBE = `-- migrate:up
ALTER TABLE journal.reconcile_discrepancies DROP CONSTRAINT reconcile_discrepancies_check_name_check,
  ADD CONSTRAINT reconcile_discrepancies_check_name_check CHECK (check_name IN ('ledger_balance','loyalty_points','loyalty_batch','certificate_balance','cash_place','payroll_accrual'));
ALTER TABLE journal.reconcile_discrepancies DROP CONSTRAINT reconcile_discrepancies_object_type_check,
  ADD CONSTRAINT reconcile_discrepancies_object_type_check CHECK (object_type IN ('ledger_account','client','loyalty_batch','certificate','branch','staff'));
-- migrate:down
SELECT 1;
`;

const LAST = '0408_report_exports.sql';
const defOf = async (db: TestDatabase, name: string) =>
  (await db.client.query<{ d: string | null }>(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = 'journal.reconcile_discrepancies'::regclass AND conname = $1`, [name])).rows[0]?.d ?? '';

describe('миграция 0408 после 0311', () => {
  let db: TestDatabase;
  let dir: string;
  beforeAll(async () => {
    db = await createTestDatabase();
    dir = await mkdtemp(join(tmpdir(), 'yu-0408-'));
    for (const f of await readdir(MIGRATIONS_DIR)) if (f <= LAST && f.endsWith('.sql')) await copyFile(join(MIGRATIONS_DIR, f), join(dir, f));
    await writeFile(join(dir, '0399_probe_0311.sql'), PROBE);
    await migrateUp(db.client, dir);
  }, 120_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
    await db.drop();
  });
  const table = async () => (await db.client.query<{ t: string | null }>(`SELECT to_regclass('app.report_exports')::text AS t`)).rows[0]!.t;

  it('CHECK содержит значения 0211, 0311 и свои', async () => {
    const names = await defOf(db, 'reconcile_discrepancies_check_name_check');
    for (const v of ['ledger_balance', 'cash_place', 'payroll_accrual', 'utilization_over_capacity']) expect(names).toContain(`'${v}'`);
    const types = await defOf(db, 'reconcile_discrepancies_object_type_check');
    for (const v of ['ledger_account', 'branch', 'staff', 'occupancy_unit']) expect(types).toContain(`'${v}'`);
  });

  it('вниз снимает только свои значения, вверх возвращает', async () => {
    await migrateDown(db.client, 1, dir);
    expect(await table()).toBeNull();
    const down = await defOf(db, 'reconcile_discrepancies_check_name_check');
    expect(down).not.toContain('utilization_over_capacity');
    expect(down).toContain('payroll_accrual');
    await migrateUp(db.client, dir);
    expect(await table()).toBe('app.report_exports');
    expect(await defOf(db, 'reconcile_discrepancies_check_name_check')).toContain('utilization_over_capacity');
  });
});

describe('итоговый набор миграций', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase({ migrate: true });
  }, 60_000);
  afterAll(async () => {
    await db.drop();
  });

  it('страж: каждый check и objectType из reconcile.ts проходит CHECK журнала сверки (значения 0311 не потеряны)', async () => {
    const source = await readFile(join(import.meta.dirname, '../../apps/api/src/modules/reports/reconcile.ts'), 'utf8');
    const used = [...source.matchAll(/check: '([a-z_]+)', objectType: '([a-z_]+)'/g)];
    expect(used.length).toBeGreaterThanOrEqual(5);
    const names = await defOf(db, 'reconcile_discrepancies_check_name_check');
    const types = await defOf(db, 'reconcile_discrepancies_object_type_check');
    for (const m of used) {
      expect(names).toContain(`'${m[1]}'`);
      expect(types).toContain(`'${m[2]}'`);
    }
    expect(names).toContain(`'utilization_over_capacity'`);
  });

  it('повтор того же запроса упирается в частичный UNIQUE, у завершённой – нет; ready требует файла и срока; строку не удалить под yu_app', async () => {
    const staff = (await db.client.query<{ id: string }>(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', 'e@yu.test', 'owner', 'x') RETURNING id`)).rows[0]!.id;
    const add = (status = 'queued') =>
      db.client.query<{ id: string }>(`INSERT INTO app.report_exports (staff_id, report, format, params, params_hash, detail, masked, status, error_code) VALUES ($1, 'bookings', 'csv', '{}', 'h', false, true, $2, $3) RETURNING id`, [staff, status, status === 'failed' ? 'X' : null]);
    const first = (await add()).rows[0]!.id;
    await expect(add()).rejects.toMatchObject({ code: '23505' });
    await expect(add('failed')).resolves.toBeTruthy();
    await expect(db.client.query(`UPDATE app.report_exports SET status = 'ready' WHERE id = $1`, [first])).rejects.toMatchObject({ code: '23514' });
    await db.client.query('SET ROLE yu_app');
    await expect(db.client.query(`DELETE FROM app.report_exports`)).rejects.toMatchObject({ code: '42501' });
    await db.client.query('RESET ROLE');
  });
});

// 0449 (D5-13): «тот же запрос – та же задача» только пока задача queued/running; после ready повтор – новая задача (K24 §2 «Актуальность»).
describe('миграция 0449: одинаковый запрос держится только в работе', () => {
  const LAST_0449 = '0449_report_exports_same_request_active.sql';
  let db: TestDatabase;
  let dir: string;
  let staff = '';
  beforeAll(async () => {
    db = await createTestDatabase();
    dir = await mkdtemp(join(tmpdir(), 'yu-0449-'));
    for (const f of await readdir(MIGRATIONS_DIR)) if (f <= LAST_0449 && f.endsWith('.sql')) await copyFile(join(MIGRATIONS_DIR, f), join(dir, f));
    await migrateUp(db.client, dir);
    staff = (await db.client.query<{ id: string }>(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', 'e449@yu.test', 'owner', 'x') RETURNING id`)).rows[0]!.id;
  }, 120_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
    await db.drop();
  });
  const add = (status: 'queued' | 'ready', at: string) =>
    db.client.query<{ id: string }>(
      `INSERT INTO app.report_exports (staff_id, report, format, params, params_hash, detail, masked, status, file_key, expires_at, created_at)
       VALUES ($1, 'finance', 'csv', '{}', 'h449', false, true, $2, $3, $4, $5) RETURNING id`,
      [staff, status, status === 'ready' ? `f-${at}` : null, status === 'ready' ? '2099-01-01T00:00:00Z' : null, at],
    );
  const statusOf = async (id: string) => (await db.client.query<{ status: string; file_key: string | null }>(`SELECT status, file_key FROM app.report_exports WHERE id = $1`, [id])).rows[0]!;

  it('две ready одного запроса – можно, вторая в работе – нет; вниз: из ready остаётся новая, старая expired; вверх – снова можно', async () => {
    const old = (await add('ready', '2026-11-10T15:05:00Z')).rows[0]!.id;
    const fresh = (await add('ready', '2026-11-10T16:00:00Z')).rows[0]!.id;
    await add('queued', '2026-11-10T16:01:00Z');
    await expect(add('queued', '2026-11-10T16:02:00Z')).rejects.toMatchObject({ code: '23505' });
    await db.client.query(`UPDATE app.report_exports SET status = 'cancelled' WHERE status = 'queued' AND params_hash = 'h449'`);
    await migrateDown(db.client, 1, dir);
    expect(await statusOf(old)).toEqual({ status: 'expired', file_key: null });
    expect((await statusOf(fresh)).status).toBe('ready');
    await expect(add('ready', '2026-11-10T17:00:00Z')).rejects.toMatchObject({ code: '23505' });
    await migrateUp(db.client, dir);
    await expect(add('ready', '2026-11-10T17:00:00Z')).resolves.toBeTruthy();
  });
});

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixedClock } from '../apps/api/src/core/time.ts';
import { getBranches } from '../apps/api/src/modules/network/index.ts';
import { assertNotProduction, DEMO_EMAIL_DOMAIN, DEMO_MARK, seedDev } from '../db/seed/dev.ts';
import { createTestDatabase, type TestDatabase } from './helpers/pg.ts';

const PASSWORD = 'Демо-пароль-засева-1';
let db: TestDatabase;
let pool: pg.Pool;
const clock = fixedClock('2026-11-14T05:00:00Z');

async function counts(): Promise<Record<string, number>> {
  const r = await db.client.query(`SELECT
    (SELECT count(*)::int FROM app.cities) cities, (SELECT count(*)::int FROM app.branches) branches,
    (SELECT count(*)::int FROM app.branch_weekly_hours) hours, (SELECT count(*)::int FROM app.staff) staff,
    (SELECT count(*)::int FROM app.staff_assignments) assignments, (SELECT count(*)::int FROM app.dict_reasons) reasons,
    (SELECT count(*)::int FROM journal.audit_events) audit`);
  return r.rows[0];
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 2 });
});
afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('S0-18: засев Э0', () => {
  it('на проде и без окружения – отказ до записи', async () => {
    expect(() => assertNotProduction({ APP_ENV: 'production' })).toThrow(/только для dev\/stage\/test/);
    expect(() => assertNotProduction({ NODE_ENV: 'production' })).toThrow();
    expect(() => assertNotProduction({})).toThrow();
    expect(() => assertNotProduction({ APP_ENV: 'stage', NODE_ENV: 'production' })).not.toThrow();
    await expect(seedDev(pool, { env: { APP_ENV: 'prod' }, password: PASSWORD }, clock)).rejects.toThrow();
    expect((await counts()).cities).toBe(0);
  });

  it('2 города, 3 филиала в трёх зонах, справочники, сотрудники трёх ролей с назначениями', async () => {
    const r = await seedDev(pool, { env: { APP_ENV: 'test' }, password: PASSWORD }, clock);
    expect(r.created).toEqual({ cities: 2, branches: 3, reasons: 2, staff: 3, assignments: 2 });
    const branches = await getBranches(pool, Object.values(r.branchIds));
    expect(new Set([...branches.values()].map((b) => b.timezone))).toEqual(new Set(['Asia/Novosibirsk', 'Europe/Moscow', 'Europe/Berlin']));
    expect([...branches.values()].map((b) => b.status).sort()).toEqual(['active', 'active', 'preparing']);
    const c = await counts();
    expect(c).toMatchObject({ cities: 2, branches: 3, hours: 21, staff: 3, assignments: 2 });
    const roles = await db.client.query(`SELECT role FROM app.staff ORDER BY role`);
    expect(roles.rows.map((x) => x.role)).toEqual(['admin', 'director', 'owner']);
  });

  it('демо-данные помечены: коды demo-, email @demo, комментарий-метка, причины demo_*', async () => {
    const cities = await db.client.query(`SELECT code, comment FROM app.cities`);
    expect(cities.rows.every((x) => x.code.startsWith('demo-') && x.comment === DEMO_MARK)).toBe(true);
    const branches = await db.client.query(`SELECT code, internal_comment FROM app.branches`);
    expect(branches.rows.every((x) => x.code.startsWith('demo-') && x.internal_comment === DEMO_MARK)).toBe(true);
    const staff = await db.client.query(`SELECT email FROM app.staff`);
    expect(staff.rows.every((x) => x.email.endsWith(`@${DEMO_EMAIL_DOMAIN}`))).toBe(true);
    const reasons = await db.client.query(`SELECT code, is_system FROM app.dict_reasons WHERE code LIKE 'demo\\_%'`);
    expect(reasons.rows).toHaveLength(2);
    expect(reasons.rows.every((x) => x.is_system === false)).toBe(true);
  });

  it('повторный запуск не плодит дубли и не пишет лишний аудит', async () => {
    const before = await counts();
    const r = await seedDev(pool, { env: { APP_ENV: 'stage' }, password: 'Другой-пароль-засева-2' }, clock);
    expect(r.created).toEqual({ cities: 0, branches: 0, reasons: 0, staff: 0, assignments: 0 });
    expect(await counts()).toEqual(before);
  });

  it('при существующем Владельце (seed-owner) засев его не дублирует', async () => {
    const d2 = await createTestDatabase({ migrate: true });
    const p2 = new pg.Pool({ connectionString: d2.url, options: '-c role=yu_app -c search_path=app,journal', max: 2 });
    try {
      const o = await d2.client.query<{ id: string }>(
        `INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('В', 'С', 'owner@club.ru', 'owner', 'x') RETURNING id`,
      );
      const r = await seedDev(p2, { env: { APP_ENV: 'dev' }, password: PASSWORD }, clock);
      expect(r.staffIds.owner).toBe(o.rows[0]!.id);
      expect(r.created.staff).toBe(2);
    } finally {
      await p2.end();
      await d2.drop();
    }
  });
});

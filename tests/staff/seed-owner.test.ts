import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { login, staffAuthConfig } from '../../apps/api/src/modules/staff/auth.ts';
import { seedOwner } from '../../apps/api/src/modules/staff/seed-owner.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const run = promisify(execFile);
const PASSWORD = 'Пароль-владельца-2026';

describe('засев первого Владельца', () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  beforeAll(async () => {
    db = await createTestDatabase({ migrate: true });
    pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 2 });
  });
  afterAll(async () => {
    await pool.end();
    await db.drop();
  });

  it('слабый пароль и кривой email отклоняются до записи', async () => {
    await expect(seedOwner(pool, { email: 'owner@yu.test', password: 'short' })).rejects.toMatchObject({ code: 'PASSWORD_TOO_WEAK' });
    await expect(seedOwner(pool, { email: 'not-an-email', password: PASSWORD })).rejects.toThrow(/email/);
    expect((await db.client.query('SELECT count(*)::int AS n FROM app.staff')).rows[0].n).toBe(0);
  });

  it('CLI создаёт Владельца с обязательной сменой пароля; пароль не в выводе и не в аудите', async () => {
    const { stdout, stderr } = await run(
      process.execPath,
      ['apps/api/src/modules/staff/seed-owner.ts', '--email', 'Owner@YU.test', '--first-name', 'Артём'],
      { env: { ...process.env, DATABASE_URL: db.url, OWNER_PASSWORD: PASSWORD } },
    );
    expect(stdout).toMatch(/Владелец создан/);
    expect(stdout + stderr).not.toContain(PASSWORD);
    const s = await db.client.query("SELECT email, role, first_name, must_change_password, password_hash FROM app.staff");
    expect(s.rows).toEqual([
      { email: 'owner@yu.test', role: 'owner', first_name: 'Артём', must_change_password: true, password_hash: expect.stringMatching(/^\$argon2id\$/) },
    ]);
    const a = await db.client.query("SELECT actor_type, source, after::text AS after FROM journal.audit_events WHERE action = 'staff.created'");
    expect(a.rows).toEqual([{ actor_type: 'system', source: 'cli', after: expect.stringContaining('o***@yu.test') }]);
    expect(a.rows[0].after).not.toContain(PASSWORD);

    const r = await login(pool, staffAuthConfig('s'.repeat(40)), fixedClock('2026-11-21T07:00:00Z'), { email: 'owner@yu.test', password: PASSWORD }, { requestId: 'r' });
    expect(r).toMatchObject({ totpRequired: false, staff: { role: 'owner', mustChangePassword: true } });
  });

  it('повторный засев не создаёт второго и не перезаписывает', async () => {
    await expect(seedOwner(pool, { email: 'other@yu.test', password: PASSWORD })).rejects.toThrow(/уже есть/);
    const cli = run(process.execPath, ['apps/api/src/modules/staff/seed-owner.ts'], {
      env: { ...process.env, DATABASE_URL: db.url, OWNER_EMAIL: 'x@yu.test', OWNER_PASSWORD: PASSWORD },
    });
    await expect(cli).rejects.toMatchObject({ code: 1, stderr: expect.stringMatching(/уже есть/) });
    expect((await db.client.query("SELECT count(*)::int AS n FROM app.staff WHERE role = 'owner'")).rows[0].n).toBe(1);
  });

  it('без пароля в окружении CLI отказывает', async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: db.url, OWNER_EMAIL: 'y@yu.test' };
    delete env.OWNER_PASSWORD;
    await expect(run(process.execPath, ['apps/api/src/modules/staff/seed-owner.ts'], { env })).rejects.toMatchObject({
      stderr: expect.stringMatching(/OWNER_PASSWORD/),
    });
  });
});

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { assertNoDuplicates, errorStatus } from '../../apps/api/src/core/registry.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import {
  changePassword,
  endSessions,
  hashPassword,
  login,
  logout,
  resolveStaffSession,
  setBlocked,
  staffAuthConfig,
  tokenHash,
  verifyPassword,
  type LoginResult,
} from '../../apps/api/src/modules/staff/auth.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const PASSWORD = 'Верный-пароль-2026';
const cfg = staffAuthConfig('p'.repeat(40));
const req = { requestId: 'r-auth', ip: '10.1.1.1', userAgent: 'vitest' };

let db: TestDatabase;
let pool: pg.Pool;
let n = 0;

/** Пул под ролью приложения – как в рантайме (права yu_app, search_path). */
function appPool(url: string): pg.Pool {
  return new pg.Pool({ connectionString: url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
}

async function makeStaff(opts: { role?: string; totp?: string } = {}): Promise<{ id: string; email: string }> {
  n += 1;
  const email = `staff${n}@yu.test`;
  const r = await db.client.query<{ id: string }>(
    `INSERT INTO app.staff (first_name, last_name, email, role, password_hash, totp_secret_enc)
     VALUES ('Иван', 'Петров', $1, $2, $3, $4) RETURNING id`,
    [email, opts.role ?? 'admin', await hashPassword(PASSWORD), opts.totp ?? null],
  );
  return { id: r.rows[0]!.id, email };
}

function ok(r: LoginResult): Extract<LoginResult, { totpRequired: false }> {
  if (r.totpRequired) throw new Error('ожидалась сессия');
  return r;
}

const ownerMeta = (staffId: string): AuditRequestMeta => ({
  actor: { kind: 'staff', staffId, sessionId: '00000000-0000-4000-8000-000000000000' },
  source: 'crm',
  requestId: 'r-owner',
});

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = appPool(db.url);
});
afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('пароли argon2id', () => {
  it('тесты идут под ролью приложения', async () => {
    expect((await pool.query('SELECT current_user AS u')).rows[0].u).toBe('yu_app');
  });

  it('PHC-строка с параметрами OWASP, проверка верного и неверного', async () => {
    const h = await hashPassword(PASSWORD);
    expect(h).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await verifyPassword(h, PASSWORD)).toBe(true);
    expect(await verifyPassword(h, PASSWORD + 'x')).toBe(false);
    expect(await verifyPassword('мусор', PASSWORD)).toBe(false);
    expect(await hashPassword(PASSWORD)).not.toBe(h); // соль случайная
  });
});

describe('вход и выход', () => {
  it('вход создаёт сессию (в базе только HMAC), выход её отзывает; в аудите вход и выход', async () => {
    const clock = fixedClock('2026-11-15T07:00:00Z');
    const s = await makeStaff();
    const r = ok(await login(pool, cfg, clock, { email: ` ${s.email.toUpperCase()} `, password: PASSWORD }, req));
    expect(r.staff).toMatchObject({ id: s.id, firstName: 'Иван', role: 'admin', mustChangePassword: false });
    expect(r.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.expiresAt.toISOString()).toBe('2026-11-18T07:00:00.000Z'); // 72 ч

    const row = await db.client.query('SELECT token_hash FROM app.staff_sessions WHERE id = $1', [r.sessionId]);
    expect(row.rows[0].token_hash).toBe(tokenHash(r.token, cfg.sessionPepper));
    expect(row.rows[0].token_hash).not.toContain(r.token);

    const session = await resolveStaffSession(pool, cfg, r.token, clock);
    expect(session).toMatchObject({ staffId: s.id, sessionId: r.sessionId });

    await logout(pool, clock, { staffId: s.id, sessionId: r.sessionId }, req);
    expect(await resolveStaffSession(pool, cfg, r.token, clock)).toBeNull();
    const a = await db.client.query(
      "SELECT action, actor_type, actor_id FROM journal.audit_events WHERE object_id = $1 ORDER BY id",
      [s.id],
    );
    expect(a.rows).toEqual([
      { action: 'auth.staff.login', actor_type: 'staff', actor_id: s.id },
      { action: 'auth.staff.logout', actor_type: 'staff', actor_id: s.id },
    ]);
  });

  it('неверный пароль и неизвестный email – один ответ; в аудите отказ с маской email и без пароля', async () => {
    const clock = fixedClock('2026-11-15T08:00:00Z');
    const s = await makeStaff();
    const wrong = login(pool, cfg, clock, { email: s.email, password: 'Неверный-пароль-777' }, req);
    await expect(wrong).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS', httpStatus: 401 });
    const unknown = login(pool, cfg, clock, { email: 'nobody@yu.test', password: 'Неверный-пароль-777' }, req);
    await expect(unknown).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS', httpStatus: 401 });
    const e1 = await wrong.catch((e: Error) => e.message);
    const e2 = await unknown.catch((e: Error) => e.message);
    expect(e1).toBe(e2);

    const a = await db.client.query(
      "SELECT object_id, result, after, reason FROM journal.audit_events WHERE action = 'auth.staff.login_failed' ORDER BY id",
    );
    expect(a.rows).toContainEqual({ object_id: s.id, result: 'denied', after: { email: 's***@yu.test' }, reason: 'bad_password' });
    expect(a.rows).toContainEqual({ object_id: null, result: 'denied', after: { email: 'n***@yu.test' }, reason: 'unknown_email' });
  });

  it('пароль не попадает ни в одну таблицу', async () => {
    const dump = await db.client.query(`SELECT
      (SELECT coalesce(json_agg(a)::text, '') FROM journal.audit_events a) ||
      (SELECT coalesce(json_agg(s)::text, '') FROM app.staff_sessions s) ||
      (SELECT coalesce(json_agg(l)::text, '') FROM app.staff_login_attempts l) AS t`);
    expect(dump.rows[0].t).not.toContain(PASSWORD);
    expect(dump.rows[0].t).not.toContain('Неверный-пароль-777');
  });
});

describe('защита от перебора', () => {
  it('10 неверных паролей → LOGIN_LOCKED даже с верным; через lock_minutes вход открыт', async () => {
    const clock = fixedClock('2026-11-16T07:00:00Z');
    const s = await makeStaff();
    const r = { ...req, ip: '10.2.2.2' };
    for (let i = 0; i < 10; i += 1) {
      await expect(login(pool, cfg, clock, { email: s.email, password: `bad-${i}-xxxxxxxx` }, r)).rejects.toMatchObject({
        code: 'INVALID_CREDENTIALS',
      });
      clock.advance(1000);
    }
    const locked = login(pool, cfg, clock, { email: s.email, password: PASSWORD }, r);
    await expect(locked).rejects.toMatchObject({ code: 'LOGIN_LOCKED', httpStatus: 429 });
    const retry = (await locked.then(
      () => 0,
      (e: { details: { retryAfterSec: number } }) => e.details.retryAfterSec,
    )) as number;
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(15 * 60);

    clock.advance(retry * 1000);
    ok(await login(pool, cfg, clock, { email: s.email, password: PASSWORD }, r));
  });

  it('несуществующий email блокируется так же', async () => {
    const clock = fixedClock('2026-11-16T09:00:00Z');
    const r = { ...req, ip: '10.3.3.3' };
    for (let i = 0; i < 10; i += 1) {
      await expect(login(pool, cfg, clock, { email: 'ghost@yu.test', password: 'x'.repeat(12) }, r)).rejects.toMatchObject({
        code: 'INVALID_CREDENTIALS',
      });
    }
    await expect(login(pool, cfg, clock, { email: 'ghost@yu.test', password: 'x'.repeat(12) }, r)).rejects.toMatchObject({
      code: 'LOGIN_LOCKED',
    });
  });

  it('по IP: больше ipMaxFailures неудач → LOGIN_LOCKED для любого email с этого IP', async () => {
    const clock = fixedClock('2026-11-16T11:00:00Z');
    const small = staffAuthConfig('p'.repeat(40), { ipMaxFailures: 3 });
    const s = await makeStaff();
    const r = { ...req, ip: '10.4.4.4' };
    for (let i = 0; i < 4; i += 1) {
      await expect(login(pool, small, clock, { email: `x${i}@yu.test`, password: 'x'.repeat(12) }, r)).rejects.toMatchObject({
        code: 'INVALID_CREDENTIALS',
      });
    }
    await expect(login(pool, small, clock, { email: s.email, password: PASSWORD }, r)).rejects.toMatchObject({
      code: 'LOGIN_LOCKED',
    });
    ok(await login(pool, small, clock, { email: s.email, password: PASSWORD }, { ...r, ip: '10.4.4.5' }));
  });
});

describe('сроки сессии', () => {
  it('простой ≥ session_idle_minutes → сессия отозвана как idle', async () => {
    const clock = fixedClock('2026-11-17T07:00:00Z');
    const s = await makeStaff();
    const r = ok(await login(pool, cfg, clock, { email: s.email, password: PASSWORD }, req));
    clock.advance(479 * 60_000);
    expect(await resolveStaffSession(pool, cfg, r.token, clock)).not.toBeNull(); // продлила last_seen_at
    clock.advance(479 * 60_000);
    expect(await resolveStaffSession(pool, cfg, r.token, clock)).not.toBeNull();
    clock.advance(480 * 60_000);
    expect(await resolveStaffSession(pool, cfg, r.token, clock)).toBeNull();
    const row = await db.client.query('SELECT revoke_reason FROM app.staff_sessions WHERE id = $1', [r.sessionId]);
    expect(row.rows[0].revoke_reason).toBe('idle');
  });

  it('абсолютный срок не продлевается активностью', async () => {
    const clock = fixedClock('2026-11-17T07:00:00Z');
    const s = await makeStaff();
    const r = ok(await login(pool, cfg, clock, { email: s.email, password: PASSWORD }, req));
    for (let h = 0; h < 72; h += 6) {
      clock.advance(6 * 3600_000);
      await resolveStaffSession(pool, cfg, r.token, clock);
    }
    expect(await resolveStaffSession(pool, cfg, r.token, clock)).toBeNull();
  });

  it('чужой и пустой токен – null', async () => {
    const clock = fixedClock('2026-11-17T07:00:00Z');
    expect(await resolveStaffSession(pool, cfg, 'нет-такого', clock)).toBeNull();
    expect(await resolveStaffSession(pool, cfg, '', clock)).toBeNull();
  });
});

describe('блокировка и завершение сессий', () => {
  it('блокировка завершает все сессии сразу; заблокированный не входит; разблокировка по rowVersion', async () => {
    const clock = fixedClock('2026-11-18T07:00:00Z');
    const owner = await makeStaff({ role: 'owner' });
    const s = await makeStaff();
    const a = ok(await login(pool, cfg, clock, { email: s.email, password: PASSWORD }, req));
    const b = ok(await login(pool, cfg, clock, { email: s.email, password: PASSWORD }, req));

    await expect(
      setBlocked(pool, clock, ownerMeta(owner.id), { staffId: s.id, rowVersion: 7, reason: 'x', blocked: true }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT', details: { current: { rowVersion: 1 } } });

    const res = await setBlocked(pool, clock, ownerMeta(owner.id), { staffId: s.id, rowVersion: 1, reason: 'уволен', blocked: true });
    expect(res).toEqual({ status: 'blocked', rowVersion: 2, sessionsEnded: 2 });
    expect(await resolveStaffSession(pool, cfg, a.token, clock)).toBeNull();
    expect(await resolveStaffSession(pool, cfg, b.token, clock)).toBeNull();
    const reasons = await db.client.query('SELECT DISTINCT revoke_reason FROM app.staff_sessions WHERE staff_id = $1', [s.id]);
    expect(reasons.rows).toEqual([{ revoke_reason: 'blocked' }]);
    await expect(login(pool, cfg, clock, { email: s.email, password: PASSWORD }, req)).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });

    await setBlocked(pool, clock, ownerMeta(owner.id), { staffId: s.id, rowVersion: 2, reason: 'вернулся', blocked: false });
    ok(await login(pool, cfg, clock, { email: s.email, password: PASSWORD }, req));
    const audit = await db.client.query(
      "SELECT action, reason, after FROM journal.audit_events WHERE object_id = $1 AND action LIKE 'staff.%' ORDER BY id",
      [s.id],
    );
    expect(audit.rows).toEqual([
      { action: 'staff.blocked', reason: 'уволен', after: { status: 'blocked', sessionsEnded: 2 } },
      { action: 'staff.unblocked', reason: 'вернулся', after: { status: 'active', sessionsEnded: 0 } },
    ]);
  });

  it('блокировка в обход функции (статус в базе) тоже закрывает доступ на следующем запросе', async () => {
    const clock = fixedClock('2026-11-18T09:00:00Z');
    const s = await makeStaff();
    const a = ok(await login(pool, cfg, clock, { email: s.email, password: PASSWORD }, req));
    await db.client.query("UPDATE app.staff SET status = 'blocked' WHERE id = $1", [s.id]);
    expect(await resolveStaffSession(pool, cfg, a.token, clock)).toBeNull();
  });

  it('endSessions отзывает все сессии и пишет аудит', async () => {
    const clock = fixedClock('2026-11-18T10:00:00Z');
    const owner = await makeStaff({ role: 'director' });
    const s = await makeStaff();
    const a = ok(await login(pool, cfg, clock, { email: s.email, password: PASSWORD }, req));
    expect(await endSessions(pool, clock, ownerMeta(owner.id), { staffId: s.id, reason: 'потерял телефон' })).toBe(1);
    expect(await resolveStaffSession(pool, cfg, a.token, clock)).toBeNull();
  });
});

describe('смена пароля и TOTP', () => {
  it('неверный текущий пароль – в лимит неудач и в аудит, как вход', async () => {
    const clock = fixedClock('2026-11-19T12:00:00Z');
    const s = await makeStaff();
    const cur = ok(await login(pool, cfg, clock, { email: s.email, password: PASSWORD }, req));
    const m = { ...ownerMeta(s.id), ip: '10.7.7.7' };
    for (let i = 0; i < 10; i += 1) {
      clock.advance(1000); // окно неудач – строго после последнего успешного входа
      await expect(
        changePassword(pool, cfg, clock, m, { staffId: s.id, sessionId: cur.sessionId, currentPassword: `bad-${i}`, newPassword: 'x'.repeat(12) }),
      ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    }
    await expect(
      changePassword(pool, cfg, clock, m, { staffId: s.id, sessionId: cur.sessionId, currentPassword: PASSWORD, newPassword: 'x'.repeat(12) }),
    ).rejects.toMatchObject({ code: 'LOGIN_LOCKED' });
    await expect(login(pool, cfg, clock, { email: s.email, password: PASSWORD }, { ...req, ip: '10.7.7.8' })).rejects.toMatchObject({
      code: 'LOGIN_LOCKED',
    });
    const a = await db.client.query(
      "SELECT count(*)::int AS n FROM journal.audit_events WHERE action = 'auth.staff.login_failed' AND object_id = $1 AND reason = 'bad_current_password'",
      [s.id],
    );
    expect(a.rows[0].n).toBe(10);
  });

  it('слабый пароль – PASSWORD_TOO_WEAK; смена завершает другие сессии, текущая остаётся', async () => {
    const clock = fixedClock('2026-11-19T07:00:00Z');
    const s = await makeStaff();
    const cur = ok(await login(pool, cfg, clock, { email: s.email, password: PASSWORD }, req));
    const other = ok(await login(pool, cfg, clock, { email: s.email, password: PASSWORD }, req));
    const m = ownerMeta(s.id);
    await expect(
      changePassword(pool, cfg, clock, m, { staffId: s.id, sessionId: cur.sessionId, currentPassword: PASSWORD, newPassword: 'short' }),
    ).rejects.toMatchObject({ code: 'PASSWORD_TOO_WEAK', httpStatus: 422 });
    await expect(
      changePassword(pool, cfg, clock, m, { staffId: s.id, sessionId: cur.sessionId, currentPassword: 'не тот', newPassword: 'x'.repeat(12) }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    await changePassword(pool, cfg, clock, m, {
      staffId: s.id,
      sessionId: cur.sessionId,
      currentPassword: PASSWORD,
      newPassword: 'Новый-пароль-длинный',
    });
    expect(await resolveStaffSession(pool, cfg, cur.token, clock)).not.toBeNull();
    expect(await resolveStaffSession(pool, cfg, other.token, clock)).toBeNull();
    ok(await login(pool, cfg, clock, { email: s.email, password: 'Новый-пароль-длинный' }, req));
  });

  it('у сотрудника с TOTP без кода – totpRequired и без сессии; без проверяющего код не принимается', async () => {
    const clock = fixedClock('2026-11-19T09:00:00Z');
    const s = await makeStaff({ totp: 'enc' });
    expect(await login(pool, cfg, clock, { email: s.email, password: PASSWORD }, req)).toEqual({ totpRequired: true });
    const sessions = await db.client.query('SELECT count(*)::int AS n FROM app.staff_sessions WHERE staff_id = $1', [s.id]);
    expect(sessions.rows[0].n).toBe(0);
    await expect(login(pool, cfg, clock, { email: s.email, password: PASSWORD, totp: '123456' }, req)).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
    const withTotp = staffAuthConfig('p'.repeat(40), { verifyTotp: (_s, code) => code === '654321' });
    ok(await login(pool, withTotp, clock, { email: s.email, password: PASSWORD, totp: '654321' }, req));
  });
});

describe('реестры ADR 0002', () => {
  it('коды модуля staff собраны, дубль – ошибка', () => {
    expect(errorStatus.INVALID_CREDENTIALS).toBe(401);
    expect(errorStatus.LOGIN_LOCKED).toBe(429);
    expect(errorStatus.NOT_FOUND).toBe(404);
    expect(() => assertNoDuplicates('ошибок', { core: ['NOT_FOUND'], staff: ['NOT_FOUND'] })).toThrow(/core.*staff/);
  });

  it('короткий SESSION_PEPPER отклоняется', () => {
    expect(() => staffAuthConfig('short')).toThrow(/SESSION_PEPPER/);
  });
});

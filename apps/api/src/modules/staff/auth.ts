// K12. Вход сотрудника и сессии: пароль argon2id, сессия по куке yu_staff (в базе – только HMAC),
// тайм-аут простоя и абсолютный срок, защита от перебора, блокировка завершает сессии.
// Проверка прав (K1) – на стороне маршрутов; функции ниже получают уже разрешённую операцию.
import { argon2, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';
import { writeAudit, type AuditRequestMeta, type AuditSource, type Db } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import type { Clock } from '../../core/time.ts';
import type { auditActions } from './audit.ts';

export interface Pool extends Db {
  connect(): Promise<pg.PoolClient>;
}

/** Ключи K7 staff.* (значения по умолчанию K7) + секрет сессий из окружения. */
export interface StaffAuthConfig {
  sessionPepper: string;
  idleMinutes: number;
  absoluteHours: number;
  maxFailures: number;
  lockMinutes: number;
  ipMaxFailures: number; // K12: > 50 неудач за 15 мин с IP → 429 (решение)
  ipWindowMinutes: number;
  /** TOTP (N-05, по желанию). Пока не подключён: у кого задан секрет – вход только с проверкой. */
  verifyTotp?: (secretEnc: string, code: string) => boolean;
}

export function staffAuthConfig(sessionPepper: string, overrides: Partial<StaffAuthConfig> = {}): StaffAuthConfig {
  if (sessionPepper.length < 32) throw new Error('SESSION_PEPPER: нужно не короче 32 символов');
  return {
    sessionPepper,
    idleMinutes: 480,
    absoluteHours: 72,
    maxFailures: 10,
    lockMinutes: 15,
    ipMaxFailures: 50,
    ipWindowMinutes: 15,
    ...overrides,
  };
}

export interface ReqInfo {
  requestId: string;
  ip?: string;
  userAgent?: string;
  source?: AuditSource;
}

type StaffAuditAction = (typeof auditActions)[number];
const MINUTE = 60_000;
export const MIN_PASSWORD_LENGTH = 12; // K12 (решение)
const MAX_PASSWORD_LENGTH = 1024; // защита от дорогого хеширования гигантской строки

// ---- пароли (argon2id, OWASP: m=19456 KiB, t=2, p=1; встроенный node:crypto вместо @node-rs/argon2)

const ARGON = { memory: 19456, passes: 2, parallelism: 1, tagLength: 32 } as const;
const PHC_RE = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

function derive(plain: string, nonce: Buffer, p: { memory: number; passes: number; parallelism: number; tagLength: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2('argon2id', { message: plain, nonce, ...p }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

const b64 = (b: Buffer) => b.toString('base64').replace(/=+$/, '');

export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(plain, salt, ARGON);
  return `$argon2id$v=19$m=${ARGON.memory},t=${ARGON.passes},p=${ARGON.parallelism}$${b64(salt)}$${b64(key)}`;
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  const m = PHC_RE.exec(hash);
  if (!m) return false;
  const expected = Buffer.from(m[5]!, 'base64');
  const key = await derive(plain, Buffer.from(m[4]!, 'base64'), {
    memory: Number(m[1]),
    passes: Number(m[2]),
    parallelism: Number(m[3]),
    tagLength: expected.length,
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

let dummyHash: Promise<string> | undefined;
/** Хеш-пустышка: неверный email проверяется столько же, сколько неверный пароль. */
function dummy(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
  return dummyHash;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function assertPasswordStrength(plain: string): void {
  if (plain.length < MIN_PASSWORD_LENGTH || plain.length > MAX_PASSWORD_LENGTH) {
    throw new AppError('PASSWORD_TOO_WEAK', 422, `Пароль – от ${MIN_PASSWORD_LENGTH} символов`, {
      minLength: MIN_PASSWORD_LENGTH,
    });
  }
}

// ---- токены

export function tokenHash(rawToken: string, pepper: string): string {
  return createHmac('sha256', pepper).update(rawToken).digest('hex');
}

// ---- транзакции и аудит

export async function withTx<T>(pool: Pool, fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

function meta(req: ReqInfo, actor: AuditRequestMeta['actor']): AuditRequestMeta {
  const m: AuditRequestMeta = { actor, source: req.source ?? 'crm', requestId: req.requestId };
  if (req.ip !== undefined) m.ip = req.ip;
  return m;
}

const anonymous = { kind: 'visitor', visitorId: 'staff-login' } as const;

async function audit(
  db: Db,
  req: ReqInfo,
  actor: AuditRequestMeta['actor'],
  action: StaffAuditAction,
  staffId: string | null,
  extra: { before?: unknown; after?: unknown; reason?: string | null; result?: 'success' | 'denied' } = {},
  clock?: Clock,
): Promise<void> {
  await writeAudit(db, meta(req, actor), { action, object: { type: 'staff', id: staffId }, ...extra }, clock);
}

// ---- вход

export interface StaffPublic {
  id: string;
  firstName: string;
  lastName: string;
  role: 'owner' | 'director' | 'admin';
  mustChangePassword: boolean;
}

export type LoginResult =
  | { totpRequired: true }
  | { totpRequired: false; token: string; sessionId: string; expiresAt: Date; staff: StaffPublic };

interface StaffRow {
  id: string;
  first_name: string;
  last_name: string;
  role: StaffPublic['role'];
  status: string;
  password_hash: string;
  must_change_password: boolean;
  totp_secret_enc: string | null;
}

function toPublic(r: StaffRow): StaffPublic {
  return {
    id: r.id,
    firstName: r.first_name,
    lastName: r.last_name,
    role: r.role,
    mustChangePassword: r.must_change_password,
  };
}

const invalid = () => new AppError('INVALID_CREDENTIALS', 401, 'Неверная почта или пароль');

/** Момент, когда вход по email снова откроется, или null. Окно – от последней успешной попытки (K12). */
async function lockedUntil(db: Db, cfg: StaffAuthConfig, email: string, ip: string | undefined, now: Date): Promise<Date | null> {
  const since = new Date(now.getTime() - cfg.lockMinutes * MINUTE);
  const byEmail = await db.query<{ at: Date }>(
    `SELECT at FROM app.staff_login_attempts
     WHERE email_norm = $1 AND NOT success AND at > $2
       AND at > coalesce((SELECT max(at) FROM app.staff_login_attempts WHERE email_norm = $1 AND success), '-infinity')
     ORDER BY at DESC LIMIT $3`,
    [email, since, cfg.maxFailures],
  );
  let until: Date | null = null;
  if (byEmail.rows.length >= cfg.maxFailures) {
    until = new Date(byEmail.rows.at(-1)!.at.getTime() + cfg.lockMinutes * MINUTE);
  }
  if (ip !== undefined) {
    const ipSince = new Date(now.getTime() - cfg.ipWindowMinutes * MINUTE);
    const byIp = await db.query<{ at: Date }>(
      `SELECT at FROM app.staff_login_attempts WHERE ip = $1 AND NOT success AND at > $2 ORDER BY at DESC LIMIT $3`,
      [ip, ipSince, cfg.ipMaxFailures + 1],
    );
    if (byIp.rows.length > cfg.ipMaxFailures) {
      const ipUntil = new Date(byIp.rows.at(-1)!.at.getTime() + cfg.ipWindowMinutes * MINUTE);
      if (!until || ipUntil > until) until = ipUntil;
    }
  }
  return until && until > now ? until : null;
}

async function recordAttempt(db: Db, email: string, staffId: string | null, ip: string | undefined, success: boolean, now: Date) {
  await db.query('INSERT INTO app.staff_login_attempts (email_norm, staff_id, ip, success, at) VALUES ($1,$2,$3,$4,$5)', [
    email,
    staffId,
    ip ?? null,
    success,
    now,
  ]);
}

export async function login(
  pool: Pool,
  cfg: StaffAuthConfig,
  clock: Clock,
  input: { email: string; password: string; totp?: string },
  req: ReqInfo,
): Promise<LoginResult> {
  const now = clock.now();
  const email = normalizeEmail(input.email);
  const until = await lockedUntil(pool, cfg, email, req.ip, now);
  if (until) {
    await audit(pool, req, anonymous, 'auth.staff.login_failed', null, { after: { email }, reason: 'locked', result: 'denied' }, clock);
    throw new AppError('LOGIN_LOCKED', 429, 'Слишком много попыток входа, попробуйте позже', {
      retryAfterSec: Math.ceil((until.getTime() - now.getTime()) / 1000),
    });
  }

  const found = await pool.query<StaffRow>(
    `SELECT id, first_name, last_name, role, status, password_hash, must_change_password, totp_secret_enc
     FROM app.staff WHERE email = $1`,
    [email],
  );
  const staff = found.rows[0];
  const ok = await verifyPassword(staff?.password_hash ?? (await dummy()), input.password);

  const fail = async (reason: string): Promise<never> => {
    await recordAttempt(pool, email, staff?.id ?? null, req.ip, false, now);
    await audit(pool, req, anonymous, 'auth.staff.login_failed', staff?.id ?? null, { after: { email }, reason, result: 'denied' }, clock);
    throw invalid();
  };

  if (!staff || !ok) return fail(staff ? 'bad_password' : 'unknown_email');
  if (staff.status !== 'active') return fail(`status_${staff.status}`);
  if (staff.totp_secret_enc !== null) {
    if (input.totp === undefined) return { totpRequired: true };
    if (!cfg.verifyTotp || !cfg.verifyTotp(staff.totp_secret_enc, input.totp)) return fail('bad_totp');
  }

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + cfg.absoluteHours * 60 * MINUTE);
  const sessionId = await withTx(pool, async (tx) => {
    const s = await tx.query<{ id: string }>(
      `INSERT INTO app.staff_sessions (staff_id, token_hash, created_at, last_seen_at, expires_at, ip, user_agent)
       VALUES ($1,$2,$3,$3,$4,$5,$6) RETURNING id`,
      [staff.id, tokenHash(token, cfg.sessionPepper), now, expiresAt, req.ip ?? null, req.userAgent ?? null],
    );
    await tx.query('UPDATE app.staff SET last_login_at = $2 WHERE id = $1', [staff.id, now]);
    await recordAttempt(tx, email, staff.id, req.ip, true, now);
    const id = s.rows[0]!.id;
    await audit(tx, req, { kind: 'staff', staffId: staff.id, sessionId: id }, 'auth.staff.login', staff.id, {}, clock);
    return id;
  });
  return { totpRequired: false, token, sessionId, expiresAt, staff: toPublic(staff) };
}

// ---- сессия

export interface SessionInfo {
  staffId: string;
  sessionId: string;
  expiresAt: Date;
  idleExpiresAt: Date;
  /** После сброса/засева: пока не сменит – только session, password, logout (K12). */
  mustChangePassword: boolean;
}

/** Кука → сессия. null – нет, отозвана, истекла, простой (тогда отзывается 'idle') или сотрудник не active. */
export async function resolveStaffSession(db: Db, cfg: StaffAuthConfig, rawToken: string, clock: Clock): Promise<SessionInfo | null> {
  if (rawToken.length === 0 || rawToken.length > 256) return null;
  const now = clock.now();
  const r = await db.query<{
    id: string;
    staff_id: string;
    last_seen_at: Date;
    expires_at: Date;
    status: string;
    must_change_password: boolean;
  }>(
    `SELECT s.id, s.staff_id, s.last_seen_at, s.expires_at, st.status, st.must_change_password
     FROM app.staff_sessions s JOIN app.staff st ON st.id = s.staff_id
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL`,
    [tokenHash(rawToken, cfg.sessionPepper)],
  );
  const s = r.rows[0];
  if (!s || s.status !== 'active' || now >= s.expires_at) return null;
  const idleMs = cfg.idleMinutes * MINUTE;
  if (now.getTime() - s.last_seen_at.getTime() >= idleMs) {
    await db.query(
      "UPDATE app.staff_sessions SET revoked_at = $2, revoke_reason = 'idle' WHERE id = $1 AND revoked_at IS NULL",
      [s.id, now],
    );
    return null;
  }
  let lastSeen = s.last_seen_at;
  if (now.getTime() - lastSeen.getTime() >= MINUTE) {
    await db.query('UPDATE app.staff_sessions SET last_seen_at = $2 WHERE id = $1', [s.id, now]);
    lastSeen = now;
  }
  return {
    staffId: s.staff_id,
    sessionId: s.id,
    expiresAt: s.expires_at,
    idleExpiresAt: new Date(Math.min(lastSeen.getTime() + idleMs, s.expires_at.getTime())),
    mustChangePassword: s.must_change_password,
  };
}

export async function getStaffPublic(db: Db, staffId: string): Promise<StaffPublic | null> {
  const r = await db.query<StaffRow>(
    'SELECT id, first_name, last_name, role, status, password_hash, must_change_password, totp_secret_enc FROM app.staff WHERE id = $1',
    [staffId],
  );
  return r.rows[0] ? toPublic(r.rows[0]) : null;
}

export async function logout(pool: Pool, clock: Clock, session: { staffId: string; sessionId: string }, req: ReqInfo): Promise<void> {
  const now = clock.now();
  await withTx(pool, async (tx) => {
    const r = await tx.query(
      "UPDATE app.staff_sessions SET revoked_at = $2, revoke_reason = 'logout' WHERE id = $1 AND revoked_at IS NULL",
      [session.sessionId, now],
    );
    if (r.rowCount) {
      await audit(tx, req, { kind: 'staff', ...session }, 'auth.staff.logout', session.staffId, {}, clock);
    }
  });
}

type RevokeReason = 'blocked' | 'admin' | 'password_changed';

/** Отзывает активные сессии сотрудника (кроме exceptSessionId). Для вызова внутри транзакции команды. */
export async function revokeSessions(tx: Db, staffId: string, reason: RevokeReason, now: Date, exceptSessionId?: string): Promise<number> {
  const r = await tx.query(
    `UPDATE app.staff_sessions SET revoked_at = $2, revoke_reason = $3
     WHERE staff_id = $1 AND revoked_at IS NULL AND ($4::uuid IS NULL OR id <> $4::uuid)`,
    [staffId, now, reason, exceptSessionId ?? null],
  );
  return r.rowCount ?? 0;
}

/** Завершить все сессии сотрудника (K12 №5). Право проверяет маршрут (K1 staff.block + assertCanManageStaff). */
export async function endSessions(
  pool: Pool,
  clock: Clock,
  auditMeta: AuditRequestMeta,
  input: { staffId: string; reason: string },
): Promise<number> {
  const now = clock.now();
  return withTx(pool, async (tx) => {
    const n = await revokeSessions(tx, input.staffId, 'admin', now);
    await writeAudit(
      tx,
      auditMeta,
      { action: 'auth.staff.sessions_ended', object: { type: 'staff', id: input.staffId }, after: { count: n }, reason: input.reason },
      clock,
    );
    return n;
  });
}

/** Блокировка/разблокировка (K12 №6). Блокировка завершает все сессии в той же транзакции (04 §6.3). */
export async function setBlocked(
  pool: Pool,
  clock: Clock,
  auditMeta: AuditRequestMeta,
  input: { staffId: string; rowVersion: number; reason: string; blocked: boolean },
): Promise<{ status: 'active' | 'blocked'; rowVersion: number; sessionsEnded: number }> {
  const now = clock.now();
  const [from, to] = input.blocked ? ['active', 'blocked'] : ['blocked', 'active'];
  return withTx(pool, async (tx) => {
    const cur = await tx.query<{ status: string; row_version: number }>(
      'SELECT status, row_version FROM app.staff WHERE id = $1 FOR UPDATE',
      [input.staffId],
    );
    const row = cur.rows[0];
    if (!row) throw new AppError('NOT_FOUND', 404, 'Не найдено');
    if (row.row_version !== input.rowVersion) {
      throw new AppError('VERSION_CONFLICT', 409, 'Карточка изменилась, обновите форму', {
        current: { rowVersion: row.row_version, status: row.status },
      });
    }
    if (row.status !== from) {
      throw new AppError('VALIDATION_FAILED', 400, `Сотрудник не в статусе ${from}`, { status: row.status });
    }
    await tx.query('UPDATE app.staff SET status = $2, row_version = row_version + 1 WHERE id = $1', [input.staffId, to]);
    const ended = input.blocked ? await revokeSessions(tx, input.staffId, 'blocked', now) : 0;
    await writeAudit(
      tx,
      auditMeta,
      {
        action: input.blocked ? 'staff.blocked' : 'staff.unblocked',
        object: { type: 'staff', id: input.staffId },
        before: { status: from },
        after: { status: to, sessionsEnded: ended },
        reason: input.reason,
      },
      clock,
    );
    return { status: to as 'active' | 'blocked', rowVersion: row.row_version + 1, sessionsEnded: ended };
  });
}

/** Смена своего пароля (K12 №4): все ДРУГИЕ сессии → password_changed.
 *  Неверный текущий пароль считается неудачной попыткой входа: лимит K12 и аудит auth.staff.login_failed. */
export async function changePassword(
  pool: Pool,
  cfg: StaffAuthConfig,
  clock: Clock,
  auditMeta: AuditRequestMeta,
  input: { staffId: string; sessionId: string; currentPassword: string; newPassword: string },
): Promise<void> {
  const now = clock.now();
  const r = await pool.query<{ password_hash: string; email: string }>('SELECT password_hash, email FROM app.staff WHERE id = $1', [
    input.staffId,
  ]);
  const row = r.rows[0];
  if (!row) throw invalid();
  const until = await lockedUntil(pool, cfg, row.email, auditMeta.ip, now);
  if (until) {
    await writeAudit(
      pool,
      auditMeta,
      { action: 'auth.staff.login_failed', object: { type: 'staff', id: input.staffId }, after: { email: row.email }, reason: 'locked', result: 'denied' },
      clock,
    );
    throw new AppError('LOGIN_LOCKED', 429, 'Слишком много попыток входа, попробуйте позже', {
      retryAfterSec: Math.ceil((until.getTime() - now.getTime()) / 1000),
    });
  }
  if (!(await verifyPassword(row.password_hash, input.currentPassword))) {
    await recordAttempt(pool, row.email, input.staffId, auditMeta.ip, false, now);
    await writeAudit(
      pool,
      auditMeta,
      {
        action: 'auth.staff.login_failed',
        object: { type: 'staff', id: input.staffId },
        after: { email: row.email },
        reason: 'bad_current_password',
        result: 'denied',
      },
      clock,
    );
    throw invalid();
  }
  assertPasswordStrength(input.newPassword);
  const newHash = await hashPassword(input.newPassword);
  await withTx(pool, async (tx) => {
    await tx.query(
      'UPDATE app.staff SET password_hash = $2, must_change_password = false, row_version = row_version + 1 WHERE id = $1',
      [input.staffId, newHash],
    );
    const n = await revokeSessions(tx, input.staffId, 'password_changed', now, input.sessionId);
    // В реестре K2 нет отдельного кода смены пароля – фиксируем завершение других сессий.
    await writeAudit(
      tx,
      auditMeta,
      { action: 'auth.staff.sessions_ended', object: { type: 'staff', id: input.staffId }, after: { count: n }, reason: 'password_changed' },
      clock,
    );
  });
}

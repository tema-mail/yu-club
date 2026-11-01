// K12 HTTP: /api/crm/v1/auth – вход, выход, сессия, пароль, завершение сессий, блокировка.
// Тонкий слой (ADR 0002 п.7): Zod-разбор → функция модуля → AppError в ответ (обработчик в server.ts).
// authenticate() – общий вход для всех CRM-маршрутов: кука → сессия → loadAccess на каждый запрос (K1).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AUDIT_OBJECT_TYPES, objectTimeline, writeDenied, type AuditRequestMeta } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { actionsOf, assertCan, assertCanManageStaff, loadAccess, noNetwork, roleAllows, type AccessContext, type NetworkLookup, type StaffOp } from '../../core/permissions.ts';
import { systemClock, type Clock } from '../../core/time.ts';
import {
  changePassword,
  endSessions,
  getStaffPublic,
  login,
  logout,
  resolveStaffSession,
  setBlocked,
  type Pool,
  type ReqInfo,
  type SessionInfo,
  type StaffAuthConfig,
} from './auth.ts';

export const STAFF_COOKIE = 'yu_staff';

export interface StaffDeps {
  pool: Pool;
  auth: StaffAuthConfig;
  clock?: Clock;
  network?: NetworkLookup;
}

export interface StaffRequestContext {
  session: SessionInfo;
  access: AccessContext;
  meta: AuditRequestMeta;
}

// ---- кука

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

function setSessionCookie(reply: FastifyReply, token: string, maxAgeSec: number): void {
  reply.header('set-cookie', `${STAFF_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSec}`);
}

function clearSessionCookie(reply: FastifyReply): void {
  reply.header('set-cookie', `${STAFF_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
}

export function reqInfo(request: FastifyRequest): ReqInfo {
  const info: ReqInfo = { requestId: request.id, ip: request.ip, source: 'crm' };
  const ua = request.headers['user-agent'];
  if (ua) info.userAgent = ua.slice(0, 512);
  return info;
}

/** Кука → сессия → контекст доступа. Нет куки – AUTH_REQUIRED; отозвана/истекла/блок – SESSION_REVOKED.
 *  Пока must_change_password – всё, кроме маршрутов с allowPasswordChange, получает PASSWORD_CHANGE_REQUIRED. */
export async function authenticate(
  deps: StaffDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  opts: { allowPasswordChange?: boolean } = {},
): Promise<StaffRequestContext> {
  const clock = deps.clock ?? systemClock;
  const token = readCookie(request.headers.cookie, STAFF_COOKIE);
  if (!token) throw new AppError('AUTH_REQUIRED', 401, 'Нужно войти');
  const session = await resolveStaffSession(deps.pool, deps.auth, token, clock);
  if (!session) {
    clearSessionCookie(reply);
    throw new AppError('SESSION_REVOKED', 401, 'Сессия завершена, войдите снова');
  }
  if (session.mustChangePassword && !opts.allowPasswordChange) {
    throw new AppError('PASSWORD_CHANGE_REQUIRED', 403, 'Сначала смените пароль');
  }
  const actor = { kind: 'staff' as const, staffId: session.staffId, sessionId: session.sessionId };
  const access = await loadAccess(deps.pool, actor, clock.now(), deps.network ?? noNetwork);
  const meta: AuditRequestMeta = { actor, access, source: 'crm', requestId: request.id, ip: request.ip };
  return { session, access, meta };
}

// ---- схемы

const loginBody = z.object({
  email: z.string().min(3).max(254),
  password: z.string().min(1).max(1024),
  totp: z.string().regex(/^\d{6}$/).optional(),
});
const passwordBody = z.object({ currentPassword: z.string().min(1).max(1024), newPassword: z.string().max(1024) });
const reasonBody = z.object({ reason: z.string().trim().min(1).max(500) });
const blockBody = reasonBody.extend({ rowVersion: z.number().int().min(1) });
const staffParams = z.object({ staffId: z.uuid() });

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new AppError('VALIDATION_FAILED', 400, 'Неверные данные запроса', {
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}

/** Цель операции над сотрудником: роль и действующие назначения. Нет такого – NOT_FOUND. */
async function staffTarget(deps: StaffDeps, ctx: AccessContext, staffId: string, op: StaffOp, meta: AuditRequestMeta) {
  const r = await deps.pool.query<{ role: 'owner' | 'director' | 'admin' }>('SELECT role FROM app.staff WHERE id = $1', [staffId]);
  const a = await deps.pool.query<{ city_id: string | null; branch_id: string | null }>(
    'SELECT city_id, branch_id FROM app.staff_assignments WHERE staff_id = $1 AND revoked_at IS NULL',
    [staffId],
  );
  const branchIds = a.rows.flatMap((x) => (x.branch_id ? [x.branch_id] : []));
  const cityIds = a.rows.flatMap((x) => (x.city_id ? [x.city_id] : []));
  try {
    const role = r.rows[0]?.role;
    if (!role) throw new AppError('NOT_FOUND', 404, 'Не найдено');
    // Сотрудник без назначений в зоне невидим не-Владельцу (решение: иначе «пустое ⊆ зоны» открывает всех).
    if (!ctx.network && role === 'admin' && branchIds.length === 0 && cityIds.length === 0) {
      throw new AppError('NOT_FOUND', 404, 'Не найдено');
    }
    // Себя не блокируют (решение: Владелец иначе запирает сеть без входа).
    if (op === 'block' && staffId === ctx.actor.staffId) throw new AppError('FORBIDDEN', 403, 'Недостаточно прав');
    assertCanManageStaff(ctx, op, { staffId, role, branchIds, cityIds });
  } catch (err) {
    if (err instanceof AppError) {
      const action = op === 'block' ? 'staff.blocked' : op === 'unblock' ? 'staff.unblocked' : 'auth.staff.sessions_ended';
      await writeDenied(deps.pool, meta, { action, object: { type: 'staff', id: staffId }, reason: err.code, result: 'denied' });
    }
    throw err;
  }
}

// ---- маршруты

/** K11 №1 GET /me (префикс /api/crm/v1): сотрудник, раскрытая зона и действия роли для меню.
 *  Защита – на сервере (K1); меню лишь показывает. Разрешён и при must_change_password (CRM ведёт на смену). */
export async function staffMeRoutes(app: FastifyInstance, deps: StaffDeps): Promise<void> {
  app.get('/me', async (request, reply) => {
    const { session, access } = await authenticate(deps, request, reply, { allowPasswordChange: true });
    const staff = await getStaffPublic(deps.pool, session.staffId);
    if (!staff) throw new AppError('SESSION_REVOKED', 401, 'Сессия завершена, войдите снова');
    reply.header('cache-control', 'no-store');
    return {
      staff,
      access: { network: access.network, cityIds: [...access.cityIds].sort(), branchIds: [...access.branchIds].sort() },
      actions: actionsOf(access.role),
    };
  });

  // Хронология объекта (K2 objectTimeline). В K11 маршрута нет – формат взят из мока CRM (S0-15).
  app.get('/audit/timeline', async (request, reply) => {
    const { access } = await authenticate(deps, request, reply);
    const q = parse(timelineQuery, request.query);
    const full = roleAllows(access.role, 'audit.view');
    if (!full && !roleAllows(access.role, 'audit.view.own')) throw new AppError('FORBIDDEN', 403, 'Недостаточно прав');
    await assertTimelineObject(deps, access, q.objectType, q.objectId);
    const page = await objectTimeline(
      deps.pool,
      { objectType: q.objectType, objectId: q.objectId, ...(full ? {} : { onlyActorId: access.actor.staffId }) },
      { limit: q.limit, ...(q.cursor ? { cursor: q.cursor } : {}) },
    );
    const staffIds = [...new Set(page.items.flatMap((e) => (e.actorType === 'staff' && e.actorId ? [e.actorId] : [])))];
    const names = new Map<string, string>();
    if (staffIds.length) {
      const r = await deps.pool.query<{ id: string; name: string }>(
        "SELECT id, first_name || ' ' || last_name AS name FROM app.staff WHERE id = ANY($1::uuid[])",
        [staffIds],
      );
      for (const x of r.rows) names.set(x.id, x.name);
    }
    reply.header('cache-control', 'no-store');
    return {
      items: page.items.map((e) => ({
        id: e.id,
        at: e.at.toISOString(),
        objectType: e.objectType,
        objectId: e.objectId,
        action: e.action,
        result: e.result,
        actor: {
          type: e.actorType,
          id: e.actorId,
          name: e.actorType === 'staff' ? (names.get(e.actorId ?? '') ?? 'Сотрудник') : ACTOR_NAMES[e.actorType],
          role: e.actorRole,
        },
        before: e.before ?? {},
        after: e.after ?? {},
        reason: e.reason,
      })),
      nextCursor: page.nextCursor,
    };
  });
}

const ACTOR_NAMES = { client: 'Клиент', system: 'Система', anonymous: 'Посетитель', staff: 'Сотрудник' } as const;

const timelineQuery = z.object({
  objectType: z.enum(AUDIT_OBJECT_TYPES),
  objectId: z.string().min(1).max(200),
  cursor: z.string().regex(/^\d{1,18}$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** Объекты филиала, чья хронология видна по зоне (Директор – вся, Администратор – свои события). */
const BRANCH_OBJECTS: ReadonlySet<string> = new Set(['space', 'room', 'resource', 'tariff', 'resource_block', 'calendar_exception']);

/** Видит ли сотрудник объект хронологии. Вне зоны – NOT_FOUND (как несуществующий), сеть у не-Владельца – 403. */
async function assertTimelineObject(deps: StaffDeps, ctx: AccessContext, type: (typeof AUDIT_OBJECT_TYPES)[number], id: string) {
  if (ctx.network) return;
  if (type === 'branch') return assertCan(ctx, 'audit.view.own', { branchId: id });
  if (type === 'city') return assertCan(ctx, 'audit.view.own', { cityId: id });
  if (type === 'dictionary' || type === 'setting') return assertCan(ctx, 'audit.view.own', { network: true });
  if (type === 'staff') {
    if (id === ctx.actor.staffId) return;
    if (!roleAllows(ctx.role, 'staff.view') || !z.uuid().safeParse(id).success) throw new AppError('NOT_FOUND', 404, 'Не найдено');
    const a = await deps.pool.query<{ city_id: string | null; branch_id: string | null }>(
      'SELECT city_id, branch_id FROM app.staff_assignments WHERE staff_id = $1 AND revoked_at IS NULL',
      [id],
    );
    const inZone =
      a.rows.length > 0 &&
      a.rows.every((x) => (x.branch_id ? ctx.branchIds.has(x.branch_id) : x.city_id ? ctx.cityIds.has(x.city_id) : false));
    if (!inZone) throw new AppError('NOT_FOUND', 404, 'Не найдено');
    return;
  }
  if (BRANCH_OBJECTS.has(type)) {
    // Филиал объекта – из его же успешных событий аудита (K2: branch_id обязателен у объекта с филиалом).
    // Чтение таблиц чужих модулей не нужно; отказы (denied) не считаются – там филиал задаёт запрос.
    const r = await deps.pool.query<{ branch_id: string | null }>(
      `SELECT DISTINCT branch_id FROM journal.audit_events WHERE object_type = $1 AND object_id = $2 AND result = 'success'`,
      [type, id],
    );
    const branches = r.rows.map((x) => x.branch_id);
    const inZone = branches.length > 0 && branches.every((b) => b !== null && ctx.branchIds.has(b));
    if (!inZone) throw new AppError('NOT_FOUND', 404, 'Не найдено');
    return assertCan(ctx, 'audit.view.own', { branchId: branches[0]! });
  }
  // Брони, клиенты и прочее – свои проверки объекта у модулей; до тех пор – только Владельцу.
  throw new AppError('NOT_FOUND', 404, 'Не найдено');
}

export async function staffAuthRoutes(app: FastifyInstance, deps: StaffDeps): Promise<void> {
  const clock = deps.clock ?? systemClock;

  app.post('/login', async (request, reply) => {
    const body = parse(loginBody, request.body);
    const input: { email: string; password: string; totp?: string } = { email: body.email, password: body.password };
    if (body.totp !== undefined) input.totp = body.totp;
    const r = await login(deps.pool, deps.auth, clock, input, reqInfo(request));
    if (r.totpRequired) return { totpRequired: true };
    setSessionCookie(reply, r.token, Math.floor((r.expiresAt.getTime() - clock.now().getTime()) / 1000));
    const { id, firstName, lastName, role, mustChangePassword } = r.staff;
    return { staff: { id, firstName, lastName, role, mustChangePassword }, totpRequired: false };
  });

  app.post('/logout', async (request, reply) => {
    const token = readCookie(request.headers.cookie, STAFF_COOKIE);
    const session = token ? await resolveStaffSession(deps.pool, deps.auth, token, clock) : null;
    if (session) await logout(deps.pool, clock, session, reqInfo(request));
    clearSessionCookie(reply);
    return reply.code(204).send();
  });

  app.get('/session', async (request, reply) => {
    const { session } = await authenticate(deps, request, reply, { allowPasswordChange: true });
    const staff = await getStaffPublic(deps.pool, session.staffId);
    if (!staff) throw new AppError('SESSION_REVOKED', 401, 'Сессия завершена, войдите снова');
    return { staff, expiresAt: session.expiresAt.toISOString(), idleExpiresAt: session.idleExpiresAt.toISOString() };
  });

  app.post('/password', async (request, reply) => {
    const { session, meta } = await authenticate(deps, request, reply, { allowPasswordChange: true });
    const body = parse(passwordBody, request.body);
    await changePassword(deps.pool, deps.auth, clock, meta, { staffId: session.staffId, sessionId: session.sessionId, ...body });
    return reply.code(204).send();
  });

  app.post('/staff/:staffId/end-sessions', async (request, reply) => {
    const { access, meta } = await authenticate(deps, request, reply);
    const { staffId } = parse(staffParams, request.params);
    const body = parse(reasonBody, request.body);
    await staffTarget(deps, access, staffId, 'end_sessions', meta);
    await endSessions(deps.pool, clock, meta, { staffId, reason: body.reason });
    return reply.code(204).send();
  });

  for (const op of ['block', 'unblock'] as const) {
    app.post(`/staff/:staffId/${op}`, async (request, reply) => {
      const { access, meta } = await authenticate(deps, request, reply);
      const { staffId } = parse(staffParams, request.params);
      const body = parse(blockBody, request.body);
      await staffTarget(deps, access, staffId, op, meta);
      const r = await setBlocked(deps.pool, clock, meta, { staffId, rowVersion: body.rowVersion, reason: body.reason, blocked: op === 'block' });
      return { status: r.status, rowVersion: r.rowVersion };
    });
  }
}

// Экран «Сотрудники» CRM (префикс /api/crm/v1): список в зоне, создание Администратора/Директора,
// карточка (имя, телефон, роль, назначения) с rowVersion, блокировка/разблокировка.
// Права: staff.view – список; запреты поверх роли – assertCanManageStaff (K1, ADR 0005 п.9).
// Владельца здесь не создают (только seed-owner). Временный пароль генерирует сервер и отдаёт один раз.
// Чужой сотрудник и сотрудник вне зоны – NOT_FOUND, как несуществующий. Отказ – в аудит (writeDenied).
// Карточка (GET /staff/:id) добавляет поля K18 §2; список их не отдаёт. Комментарий руководителя – только тому, кто вправе править сотрудника
// (про себя его не читает никто, кроме Владельца); правка – K18 №319 в модуле shifts.
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { diffFields, writeAudit, writeDenied, type AuditAction, type AuditRequestMeta, type Db } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { assertCanManageStaff, roleAllows, type AccessContext, type StaffOp, type StaffRole } from '../../core/permissions.ts';
import { systemClock } from '../../core/time.ts';
import { hashPassword, normalizeEmail, setBlocked, withTx } from './auth.ts';
import { authenticate, type StaffDeps } from './routes.crm.ts';

// ---- схемы

const NAME = z.string().trim().min(1).max(100);
const PHONE = z.string().regex(/^\+\d{10,15}$/);
const ids = z.array(z.uuid()).max(100);
const listQuery = z.object({
  q: z.string().trim().max(100).optional(),
  role: z.enum(['owner', 'director', 'admin']).optional(),
  status: z.enum(['active', 'blocked', 'archived']).optional(),
  branchId: z.uuid().optional(),
  cursor: z.string().max(400).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const createBody = z.object({
  firstName: NAME,
  lastName: NAME,
  email: z.email().max(254),
  phone: PHONE.optional(),
  role: z.enum(['director', 'admin']),
  branchIds: ids.default([]),
  cityIds: ids.default([]),
});
const patchBody = z.object({
  rowVersion: z.number().int().min(1),
  firstName: NAME.optional(),
  lastName: NAME.optional(),
  phone: PHONE.nullable().optional(),
  role: z.enum(['owner', 'director', 'admin']).optional(),
  branchIds: ids.optional(),
  cityIds: ids.optional(),
});
const blockBody = z.object({ rowVersion: z.number().int().min(1), reason: z.string().trim().min(1).max(500) });
const params = z.object({ staffId: z.uuid() });

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value ?? {});
  if (!r.success) {
    throw new AppError('VALIDATION_FAILED', 400, 'Неверные данные запроса', {
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}

const notFound = () => new AppError('NOT_FOUND', 404, 'Не найдено');

// ---- чтение

interface Assignment {
  id: string;
  scopeType: 'city' | 'branch';
  cityId: string | null;
  branchId: string | null;
  validFrom: string;
  validTo: string | null;
}
export interface StaffItem {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  role: StaffRole;
  status: 'active' | 'blocked' | 'archived';
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  rowVersion: number;
  assignments: Assignment[];
}

const ITEM_SQL = `SELECT s.id, s.first_name, s.last_name, s.email, s.phone_e164, s.role, s.status, s.must_change_password,
    s.last_login_at, s.row_version,
    coalesce((SELECT json_agg(json_build_object('id', a.id, 'scopeType', a.scope_type, 'cityId', a.city_id,
        'branchId', a.branch_id, 'validFrom', a.valid_from, 'validTo', a.valid_to) ORDER BY a.valid_from, a.id)
      FROM app.staff_assignments a WHERE a.staff_id = s.id AND a.revoked_at IS NULL), '[]') AS assignments
  FROM app.staff s`;

interface ItemRow {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone_e164: string | null;
  role: StaffRole;
  status: StaffItem['status'];
  must_change_password: boolean;
  last_login_at: Date | null;
  row_version: number;
  assignments: Assignment[];
}

function toItem(r: ItemRow): StaffItem {
  return {
    id: r.id,
    firstName: r.first_name,
    lastName: r.last_name,
    email: r.email,
    phone: r.phone_e164,
    role: r.role,
    status: r.status,
    mustChangePassword: r.must_change_password,
    lastLoginAt: r.last_login_at ? r.last_login_at.toISOString() : null,
    rowVersion: r.row_version,
    assignments: r.assignments,
  };
}

async function loadItem(db: Db, staffId: string, lock = false): Promise<StaffItem | null> {
  const r = await db.query<ItemRow>(`${ITEM_SQL} WHERE s.id = $1${lock ? ' FOR UPDATE OF s' : ''}`, [staffId]);
  return r.rows[0] ? toItem(r.rows[0]) : null;
}

const zoneOf = (s: StaffItem) => ({
  branchIds: s.assignments.flatMap((a) => (a.branchId ? [a.branchId] : [])),
  cityIds: s.assignments.flatMap((a) => (a.cityId ? [a.cityId] : [])),
});

export interface StaffCard extends StaffItem {
  employmentStart: string | null;
  employmentEnd: string | null;
  planningStatus: 'available' | 'on_leave';
  managerComment: string | null;
}

/** Правит ли вызывающий этого сотрудника: те же запреты, что у правки (K1). Здесь отказ – не событие аудита, это чтение. */
function canManage(ctx: AccessContext, s: StaffItem): boolean {
  try {
    assertCanManageStaff(ctx, 'update_profile', { staffId: s.id, role: s.role, ...zoneOf(s) });
    return true;
  } catch (err) {
    if (err instanceof AppError) return false;
    throw err;
  }
}

async function loadCard(db: Db, ctx: AccessContext, s: StaffItem): Promise<StaffCard> {
  const r = await db.query<{ employment_start: string | null; employment_end: string | null; planning_status: StaffCard['planningStatus']; manager_comment: string | null }>(
    `SELECT to_char(employment_start, 'YYYY-MM-DD') AS employment_start, to_char(employment_end, 'YYYY-MM-DD') AS employment_end, planning_status, manager_comment
       FROM app.staff WHERE id = $1`,
    [s.id],
  );
  const x = r.rows[0];
  if (!x) throw notFound();
  return {
    ...s,
    employmentStart: x.employment_start,
    employmentEnd: x.employment_end,
    planningStatus: x.planning_status,
    managerComment: canManage(ctx, s) ? x.manager_comment : null,
  };
}

/** Курсор списка: (фамилия, имя, id) последнего элемента – base64url JSON. */
function encodeCursor(s: StaffItem): string {
  return Buffer.from(JSON.stringify([s.lastName, s.firstName, s.id])).toString('base64url');
}
function decodeCursor(raw: string): [string, string, string] {
  try {
    const v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'string') && z.uuid().safeParse(v[2]).success) {
      return v as [string, string, string];
    }
  } catch {
    // ниже
  }
  throw new AppError('VALIDATION_FAILED', 400, 'Неверный курсор');
}

// ---- маршруты

export async function staffAdminRoutes(app: FastifyInstance, deps: StaffDeps): Promise<void> {
  const clock = deps.clock ?? systemClock;

  /** Цель операции: существует, в зоне, и операция разрешена. Иначе – отказ в аудит и та же ошибка. */
  async function guard(
    ctx: AccessContext,
    meta: AuditRequestMeta,
    staffId: string,
    checks: Array<{ op: StaffOp; role: StaffRole; branchIds: string[]; cityIds: string[]; newRole?: StaffRole }>,
    auditAction: AuditAction,
  ): Promise<void> {
    try {
      for (const c of checks) assertCanManageStaff(ctx, c.op, { staffId, ...c });
    } catch (err) {
      if (err instanceof AppError) {
        await writeDenied(deps.pool, meta, { action: auditAction, object: { type: 'staff', id: staffId }, reason: err.code, result: 'denied' }, clock);
      }
      throw err;
    }
  }

  /** Существующий сотрудник, видимый вызывающему (Владелец – все; иначе – с назначениями, целиком в зоне). */
  async function visible(ctx: AccessContext, staffId: string): Promise<StaffItem> {
    const s = await loadItem(deps.pool, staffId);
    if (!s) throw notFound();
    if (ctx.network || s.id === ctx.actor.staffId) return s;
    const z0 = zoneOf(s);
    const inZone =
      z0.branchIds.length + z0.cityIds.length > 0 &&
      z0.branchIds.every((b) => ctx.branchIds.has(b)) &&
      z0.cityIds.every((c) => ctx.cityIds.has(c));
    if (!inZone) throw notFound();
    return s;
  }

  async function auth(request: FastifyRequest, reply: FastifyReply) {
    const r = await authenticate(deps, request, reply);
    if (!roleAllows(r.access.role, 'staff.view')) throw new AppError('FORBIDDEN', 403, 'Недостаточно прав');
    reply.header('cache-control', 'no-store');
    return r;
  }

  app.get('/staff', async (request, reply) => {
    const { access } = await auth(request, reply);
    const q = parse(listQuery, request.query);
    const where: string[] = [];
    const values: unknown[] = [];
    const add = (sql: (n: number) => string, v: unknown) => {
      values.push(v);
      where.push(sql(values.length));
    };
    if (!access.network) {
      // В зоне – у кого есть действующее назначение на мой филиал или город; плюс я сам.
      values.push([...access.branchIds], [...access.cityIds], access.actor.staffId);
      const [b, c, me] = [values.length - 2, values.length - 1, values.length];
      where.push(`(s.id = $${me} OR EXISTS (SELECT 1 FROM app.staff_assignments a WHERE a.staff_id = s.id AND a.revoked_at IS NULL
        AND (a.branch_id = ANY($${b}::uuid[]) OR a.city_id = ANY($${c}::uuid[]))))`);
    }
    if (q.role) add((n) => `s.role = $${n}`, q.role);
    if (q.status) add((n) => `s.status = $${n}`, q.status);
    if (q.branchId) {
      add((n) => `EXISTS (SELECT 1 FROM app.staff_assignments a WHERE a.staff_id = s.id AND a.revoked_at IS NULL AND a.branch_id = $${n})`, q.branchId);
    }
    if (q.q) {
      const like = `%${q.q.toLowerCase().replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      add((n) => `(lower(s.first_name || ' ' || s.last_name) LIKE $${n} OR s.email LIKE $${n})`, like);
    }
    if (q.cursor) {
      const [l, f, id] = decodeCursor(q.cursor);
      values.push(l, f, id);
      where.push(`(s.last_name, s.first_name, s.id) > ($${values.length - 2}, $${values.length - 1}, $${values.length}::uuid)`);
    }
    values.push(q.limit + 1);
    const r = await deps.pool.query<ItemRow>(
      `${ITEM_SQL}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY s.last_name, s.first_name, s.id LIMIT $${values.length}`,
      values,
    );
    const items = r.rows.slice(0, q.limit).map(toItem);
    return { items, nextCursor: r.rows.length > q.limit ? encodeCursor(items.at(-1)!) : null };
  });

  app.get('/staff/:staffId', async (request, reply) => {
    const { access } = await auth(request, reply);
    const { staffId } = parse(params, request.params);
    return loadCard(deps.pool, access, await visible(access, staffId));
  });

  app.post('/staff', async (request, reply) => {
    const { access, meta } = await auth(request, reply);
    const body = parse(createBody, request.body);
    const email = normalizeEmail(body.email);
    if (body.branchIds.length + body.cityIds.length === 0) {
      throw new AppError('VALIDATION_FAILED', 400, 'Нужен хотя бы один филиал или город', { issues: [{ path: 'branchIds', message: 'пусто' }] });
    }
    try {
      assertCanManageStaff(access, 'create', { role: body.role, branchIds: body.branchIds, cityIds: body.cityIds });
    } catch (err) {
      if (err instanceof AppError) {
        await writeDenied(deps.pool, meta, { action: 'staff.created', object: { type: 'staff', id: null }, reason: err.code, result: 'denied' }, clock);
      }
      throw err;
    }
    const temporaryPassword = randomBytes(12).toString('base64url'); // 16 символов, показывается один раз
    const hash = await hashPassword(temporaryPassword);
    const now = clock.now();
    const today = now.toISOString().slice(0, 10);
    const id = await withTx(deps.pool, async (tx) => {
      const taken = await tx.query('SELECT 1 FROM app.staff WHERE email = $1', [email]);
      if (taken.rowCount) {
        throw new AppError('VALIDATION_FAILED', 400, 'Сотрудник с такой почтой уже есть', { issues: [{ path: 'email', message: 'занята' }] });
      }
      const r = await tx.query<{ id: string }>(
        `INSERT INTO app.staff (first_name, last_name, email, phone_e164, role, password_hash, must_change_password, rights_changed_at, rights_changed_by)
         VALUES ($1, $2, $3, $4, $5, $6, true, $7, $8) RETURNING id`,
        [body.firstName, body.lastName, email, body.phone ?? null, body.role, hash, now, access.actor.staffId],
      );
      const newId = r.rows[0]!.id;
      await insertAssignments(tx, newId, body.branchIds, body.cityIds, today, access.actor.staffId);
      await writeAudit(
        tx,
        meta,
        {
          action: 'staff.created',
          object: { type: 'staff', id: newId },
          after: { firstName: body.firstName, lastName: body.lastName, email, role: body.role, branchIds: body.branchIds, cityIds: body.cityIds },
        },
        clock,
      );
      return newId;
    });
    return reply.code(201).send({ staff: await loadItem(deps.pool, id), temporaryPassword });
  });

  app.patch('/staff/:staffId', async (request, reply) => {
    const { access, meta } = await auth(request, reply);
    const { staffId } = parse(params, request.params);
    const body = parse(patchBody, request.body);
    const cur = await visible(access, staffId);
    const zone = zoneOf(cur);
    const profile = body.firstName !== undefined || body.lastName !== undefined || body.phone !== undefined;
    const roleChange = body.role !== undefined && body.role !== cur.role;
    const nextB = body.branchIds ?? zone.branchIds;
    const nextC = body.cityIds ?? zone.cityIds;
    const scopeChange =
      JSON.stringify([...nextB].sort()) !== JSON.stringify([...zone.branchIds].sort()) ||
      JSON.stringify([...nextC].sort()) !== JSON.stringify([...zone.cityIds].sort());
    const checks: Parameters<typeof guard>[3] = [];
    if (profile) checks.push({ op: 'update_profile', role: cur.role, ...zone });
    if (roleChange) checks.push({ op: 'change_role', role: cur.role, newRole: body.role!, ...zone });
    if (scopeChange) {
      checks.push({ op: 'change_scope', role: cur.role, ...zone });
      checks.push({ op: 'change_scope', role: body.role ?? cur.role, branchIds: nextB, cityIds: nextC });
    }
    await guard(access, meta, staffId, checks, roleChange ? 'staff.role_changed' : scopeChange ? 'staff.scope_changed' : 'staff.contacts_changed');
    if (scopeChange && cur.role !== 'owner' && nextB.length + nextC.length === 0) {
      throw new AppError('VALIDATION_FAILED', 400, 'Нужен хотя бы один филиал или город', { issues: [{ path: 'branchIds', message: 'пусто' }] });
    }
    const now = clock.now();
    await withTx(deps.pool, async (tx) => {
      const locked = await loadItem(tx, staffId, true);
      if (!locked) throw notFound();
      if (locked.rowVersion !== body.rowVersion) {
        throw new AppError('VERSION_CONFLICT', 409, 'Карточка изменилась, обновите форму', { current: locked });
      }
      const sets: string[] = [];
      const values: unknown[] = [staffId];
      const set = (col: string, v: unknown) => {
        values.push(v);
        sets.push(`${col} = $${values.length}`);
      };
      if (body.firstName !== undefined) set('first_name', body.firstName);
      if (body.lastName !== undefined) set('last_name', body.lastName);
      if (body.phone !== undefined) set('phone_e164', body.phone);
      if (roleChange) set('role', body.role);
      if (roleChange || scopeChange) {
        set('rights_changed_at', now);
        set('rights_changed_by', access.actor.staffId);
      }
      await tx.query(`UPDATE app.staff SET ${[...sets, 'row_version = row_version + 1'].join(', ')} WHERE id = $1`, values);
      if (scopeChange) {
        const keep = new Set([...nextB.map((b) => `b:${b}`), ...nextC.map((c) => `c:${c}`)]);
        const have = new Set(locked.assignments.map((a) => (a.branchId ? `b:${a.branchId}` : `c:${a.cityId}`)));
        const drop = locked.assignments.filter((a) => !keep.has(a.branchId ? `b:${a.branchId}` : `c:${a.cityId}`)).map((a) => a.id);
        if (drop.length) {
          await tx.query('UPDATE app.staff_assignments SET revoked_at = $2, revoked_by = $3 WHERE id = ANY($1::uuid[])', [
            drop,
            now,
            access.actor.staffId,
          ]);
        }
        await insertAssignments(
          tx,
          staffId,
          nextB.filter((b) => !have.has(`b:${b}`)),
          nextC.filter((c) => !have.has(`c:${c}`)),
          now.toISOString().slice(0, 10),
          access.actor.staffId,
        );
      }
      const obj = { type: 'staff' as const, id: staffId };
      if (profile) {
        const d = diffFields(
          { firstName: locked.firstName, lastName: locked.lastName, phone: locked.phone },
          { firstName: body.firstName ?? locked.firstName, lastName: body.lastName ?? locked.lastName, phone: body.phone === undefined ? locked.phone : body.phone },
        );
        if (Object.keys(d.after).length) await writeAudit(tx, meta, { action: 'staff.contacts_changed', object: obj, ...d }, clock);
      }
      if (roleChange) {
        await writeAudit(tx, meta, { action: 'staff.role_changed', object: obj, before: { role: locked.role }, after: { role: body.role } }, clock);
      }
      if (scopeChange) {
        await writeAudit(
          tx,
          meta,
          { action: 'staff.scope_changed', object: obj, before: zoneOf(locked), after: { branchIds: nextB, cityIds: nextC } },
          clock,
        );
      }
    });
    return loadItem(deps.pool, staffId);
  });

  for (const op of ['block', 'unblock'] as const) {
    app.post(`/staff/:staffId/${op}`, async (request, reply) => {
      const { access, meta } = await auth(request, reply);
      const { staffId } = parse(params, request.params);
      const body = parse(blockBody, request.body);
      const cur = await visible(access, staffId);
      await guard(access, meta, staffId, [{ op, role: cur.role, ...zoneOf(cur) }], op === 'block' ? 'staff.blocked' : 'staff.unblocked');
      if (op === 'block' && staffId === access.actor.staffId) throw new AppError('FORBIDDEN', 403, 'Недостаточно прав');
      await setBlocked(deps.pool, clock, meta, { staffId, rowVersion: body.rowVersion, reason: body.reason, blocked: op === 'block' });
      return loadItem(deps.pool, staffId);
    });
  }
}

async function insertAssignments(tx: Db, staffId: string, branchIds: string[], cityIds: string[], from: string, by: string): Promise<void> {
  for (const [kind, list] of [['branch', branchIds], ['city', cityIds]] as const) {
    for (const id of new Set(list)) {
      await tx.query(
        `INSERT INTO app.staff_assignments (staff_id, scope_type, city_id, branch_id, valid_from, created_by) VALUES ($1, $2, $3, $4, $5, $6)`,
        [staffId, kind, kind === 'city' ? id : null, kind === 'branch' ? id : null, from, by],
      );
    }
  }
}

// Мок экрана «Сотрудники» (S0-15c): точно по apps/api/src/modules/staff/routes.staff.ts и правилам
// assertCanManageStaff (core/permissions.ts). Подключается из mock-api.ts (registerStaff), состояние – общий
// массив сотрудников мока; resetStaff() возвращает засев (POST /__test/reset).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes, randomUUID } from 'node:crypto';

type Role = 'owner' | 'director' | 'admin';
export interface StaffRecord {
  id: string; email: string; password: string; firstName: string; lastName: string; role: Role;
  cityIds: string[]; branchIds: string[]; mustChangePassword?: boolean;
  phone?: string | null; status?: 'active' | 'blocked' | 'archived'; rowVersion?: number; lastLoginAt?: string | null;
}
interface Zone { network: boolean; cityIds: string[]; branchIds: string[] }
type Issue = { path: string; message: string };

export interface StaffMockDeps {
  staff: StaffRecord[];
  current: (req: FastifyRequest) => StaffRecord;
  access: (s: StaffRecord) => Zone;
  can: (s: StaffRecord, action: string) => boolean;
  fail: (reply: FastifyReply, status: number, code: string, message: string, details?: Record<string, unknown>) => unknown;
  audit: (s: StaffRecord, objectType: string, objectId: string, action: string, before: object, after: object, reason?: string | null) => void;
  endSessions: (staffId: string) => void;
}

let snapshot: StaffRecord[] = [];
let list: StaffRecord[] = [];

export function resetStaff(): void {
  list.splice(0, list.length, ...structuredClone(snapshot));
}

/** Ответ API: StaffItem (routes.staff.ts toItem). */
function item(s: StaffRecord) {
  return {
    id: s.id, firstName: s.firstName, lastName: s.lastName, email: s.email, phone: s.phone ?? null, role: s.role,
    status: s.status ?? 'active', mustChangePassword: s.mustChangePassword === true, lastLoginAt: s.lastLoginAt ?? null,
    rowVersion: s.rowVersion ?? 1,
    assignments: [
      ...s.cityIds.map((c) => ({ id: `${s.id}:c:${c}`, scopeType: 'city', cityId: c, branchId: null, validFrom: '2026-01-01', validTo: null })),
      ...s.branchIds.map((b) => ({ id: `${s.id}:b:${b}`, scopeType: 'branch', cityId: null, branchId: b, validFrom: '2026-01-01', validTo: null })),
    ],
  };
}

const PHONE = /^\+\d{10,15}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const mask = (p: string | null | undefined) => (p ? `${p.slice(0, 2)}******${p.slice(-4)}` : null); // K2 redact: телефон

export function registerStaff(app: FastifyInstance, P: string, d: StaffMockDeps): void {
  list = d.staff;
  snapshot = structuredClone(d.staff);
  const notFound = (reply: FastifyReply) => d.fail(reply, 404, 'NOT_FOUND', 'Не найдено');
  const forbidden = (reply: FastifyReply) => d.fail(reply, 403, 'FORBIDDEN', 'Недостаточно прав');
  const invalid = (reply: FastifyReply, issues: Issue[], message = 'Неверные данные запроса') =>
    d.fail(reply, 400, 'VALIDATION_FAILED', message, { issues });

  /** assertCanManageStaff: false – нет права (403), 'zone' – вне зоны (404), true – можно. */
  function allowed(me: StaffRecord, op: string, t: { id?: string; roles: Role[]; branchIds: string[]; cityIds: string[] }): boolean | 'zone' {
    const blockOp = op === 'block' || op === 'unblock';
    const action = blockOp ? 'staff.block' : t.roles.every((r) => r === 'admin') ? 'staff.admin.assign' : 'staff.director.assign';
    if (!d.can(me, action)) return false;
    if (t.id === me.id && (op === 'change_role' || op === 'change_scope')) return false;
    if (t.roles.some((r) => r !== 'admin') && me.role !== 'owner') return false;
    if (t.roles.includes('owner') && (op === 'create' || op === 'change_role')) return false;
    const z = d.access(me);
    if (!z.network && (t.branchIds.some((b) => !z.branchIds.includes(b)) || t.cityIds.some((c) => !z.cityIds.includes(c)))) return 'zone';
    return true;
  }

  /** Видимый сотрудник: Владелец – все, сам себя, иначе – с назначениями целиком в зоне. */
  function visible(me: StaffRecord, id: string): StaffRecord | null {
    const s = list.find((x) => x.id === id);
    if (!s) return null;
    const z = d.access(me);
    if (z.network || s.id === me.id) return s;
    const has = s.branchIds.length + s.cityIds.length > 0;
    return has && s.branchIds.every((b) => z.branchIds.includes(b)) && s.cityIds.every((c) => z.cityIds.includes(c)) ? s : null;
  }

  const auth = (req: FastifyRequest, reply: FastifyReply) => {
    const me = d.current(req);
    if (!d.can(me, 'staff.view')) {
      forbidden(reply);
      return null;
    }
    return me;
  };

  app.get(`${P}/staff`, async (req, reply) => {
    const me = auth(req, reply);
    if (!me) return reply;
    const q = req.query as { q?: string; role?: string; status?: string; branchId?: string; cursor?: string; limit?: string };
    const z = d.access(me);
    const needle = (q.q ?? '').trim().toLowerCase();
    const limit = Math.min(Number(q.limit ?? 50), Number(process.env.MOCK_PAGE_SIZE ?? 100));
    const all = list
      .filter((s) => z.network || s.id === me.id || s.branchIds.some((b) => z.branchIds.includes(b)) || s.cityIds.some((c) => z.cityIds.includes(c)))
      .filter((s) => (!q.role || s.role === q.role) && (!q.status || (s.status ?? 'active') === q.status) && (!q.branchId || s.branchIds.includes(q.branchId)))
      .filter((s) => !needle || `${s.firstName} ${s.lastName}`.toLowerCase().includes(needle) || s.email.includes(needle))
      .sort((a, b) => `${a.lastName} ${a.firstName} ${a.id}`.localeCompare(`${b.lastName} ${b.firstName} ${b.id}`));
    const from = q.cursor ? Number(q.cursor) : 0;
    return { items: all.slice(from, from + limit).map(item), nextCursor: from + limit < all.length ? String(from + limit) : null };
  });

  app.get(`${P}/staff/:staffId`, async (req, reply) => {
    const me = auth(req, reply);
    if (!me) return reply;
    const s = visible(me, (req.params as { staffId: string }).staffId);
    return s ? item(s) : notFound(reply);
  });

  app.post(`${P}/staff`, async (req, reply) => {
    const me = auth(req, reply);
    if (!me) return reply;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const issues: Issue[] = [];
    for (const f of ['firstName', 'lastName']) if (typeof b[f] !== 'string' || !(b[f] as string).trim()) issues.push({ path: f, message: 'Заполните поле' });
    if (typeof b.email !== 'string' || !EMAIL.test(b.email)) issues.push({ path: 'email', message: 'Неверная почта' });
    if (b.phone !== undefined && (typeof b.phone !== 'string' || !PHONE.test(b.phone))) issues.push({ path: 'phone', message: 'Формат +79131234567' });
    if (b.role !== 'director' && b.role !== 'admin') issues.push({ path: 'role', message: 'Выберите роль' });
    if (issues.length) return invalid(reply, issues);
    const branchIds = (b.branchIds as string[] | undefined) ?? [];
    const cityIds = (b.cityIds as string[] | undefined) ?? [];
    if (branchIds.length + cityIds.length === 0) return invalid(reply, [{ path: 'branchIds', message: 'пусто' }], 'Нужен хотя бы один филиал или город');
    const ok = allowed(me, 'create', { roles: [b.role as Role], branchIds, cityIds });
    if (ok === 'zone') return notFound(reply);
    if (!ok) return forbidden(reply);
    const email = (b.email as string).trim().toLowerCase();
    if (list.some((s) => s.email === email)) return invalid(reply, [{ path: 'email', message: 'занята' }], 'Сотрудник с такой почтой уже есть');
    const temporaryPassword = randomBytes(12).toString('base64url');
    const s: StaffRecord = {
      id: randomUUID(), email, password: temporaryPassword, firstName: (b.firstName as string).trim(), lastName: (b.lastName as string).trim(),
      role: b.role as Role, cityIds, branchIds, mustChangePassword: true, phone: (b.phone as string | undefined) ?? null, status: 'active', rowVersion: 1,
    };
    list.push(s);
    d.audit(me, 'staff', s.id, 'staff.created', {}, { firstName: s.firstName, lastName: s.lastName, email, role: s.role, branchIds, cityIds });
    return reply.code(201).send({ staff: item(s), temporaryPassword });
  });

  app.patch(`${P}/staff/:staffId`, async (req, reply) => {
    const me = auth(req, reply);
    if (!me) return reply;
    const s = visible(me, (req.params as { staffId: string }).staffId);
    if (!s) return notFound(reply);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const issues: Issue[] = [];
    if (typeof b.rowVersion !== 'number') issues.push({ path: 'rowVersion', message: 'Нужна версия' });
    for (const f of ['firstName', 'lastName']) if (b[f] !== undefined && (typeof b[f] !== 'string' || !(b[f] as string).trim())) issues.push({ path: f, message: 'Заполните поле' });
    if (b.phone !== undefined && b.phone !== null && (typeof b.phone !== 'string' || !PHONE.test(b.phone))) issues.push({ path: 'phone', message: 'Формат +79131234567' });
    if (issues.length) return invalid(reply, issues);
    const zone = { branchIds: s.branchIds, cityIds: s.cityIds };
    const nextB = (b.branchIds as string[] | undefined) ?? s.branchIds;
    const nextC = (b.cityIds as string[] | undefined) ?? s.cityIds;
    const sorted = (x: string[]) => JSON.stringify([...x].sort());
    const profile = b.firstName !== undefined || b.lastName !== undefined || b.phone !== undefined;
    const roleChange = b.role !== undefined && b.role !== s.role;
    const scopeChange = sorted(nextB) !== sorted(s.branchIds) || sorted(nextC) !== sorted(s.cityIds);
    const checks: Array<[string, Parameters<typeof allowed>[2]]> = [];
    if (profile) checks.push(['update_profile', { id: s.id, roles: [s.role], ...zone }]);
    if (roleChange) checks.push(['change_role', { id: s.id, roles: [s.role, b.role as Role], ...zone }]);
    if (scopeChange) {
      checks.push(['change_scope', { id: s.id, roles: [s.role], ...zone }]);
      checks.push(['change_scope', { id: s.id, roles: [(b.role as Role | undefined) ?? s.role], branchIds: nextB, cityIds: nextC }]);
    }
    for (const [op, t] of checks) {
      const ok = allowed(me, op, t);
      if (ok === 'zone') return notFound(reply);
      if (!ok) return forbidden(reply);
    }
    if (scopeChange && s.role !== 'owner' && nextB.length + nextC.length === 0) {
      return invalid(reply, [{ path: 'branchIds', message: 'пусто' }], 'Нужен хотя бы один филиал или город');
    }
    if (b.rowVersion !== (s.rowVersion ?? 1)) return d.fail(reply, 409, 'VERSION_CONFLICT', 'Карточка изменилась, обновите форму', { current: item(s) });
    const before = { firstName: s.firstName, lastName: s.lastName, phone: s.phone ?? null, role: s.role, ...zone };
    if (b.firstName !== undefined) s.firstName = (b.firstName as string).trim();
    if (b.lastName !== undefined) s.lastName = (b.lastName as string).trim();
    if (b.phone !== undefined) s.phone = b.phone as string | null;
    if (roleChange) s.role = b.role as Role;
    if (scopeChange) Object.assign(s, { branchIds: nextB, cityIds: nextC });
    s.rowVersion = (s.rowVersion ?? 1) + 1;
    if (profile) {
      const was = { firstName: before.firstName, lastName: before.lastName, phone: mask(before.phone) };
      const now = { firstName: s.firstName, lastName: s.lastName, phone: mask(s.phone) };
      d.audit(me, 'staff', s.id, 'staff.contacts_changed', was, now);
    }
    if (roleChange) d.audit(me, 'staff', s.id, 'staff.role_changed', { role: before.role }, { role: s.role });
    if (scopeChange) d.audit(me, 'staff', s.id, 'staff.scope_changed', zone, { branchIds: nextB, cityIds: nextC });
    return item(s);
  });

  for (const op of ['block', 'unblock'] as const) {
    app.post(`${P}/staff/:staffId/${op}`, async (req, reply) => {
      const me = auth(req, reply);
      if (!me) return reply;
      const s = visible(me, (req.params as { staffId: string }).staffId);
      if (!s) return notFound(reply);
      const b = (req.body ?? {}) as { rowVersion?: unknown; reason?: unknown };
      const reason = typeof b.reason === 'string' ? b.reason.trim() : '';
      if (typeof b.rowVersion !== 'number' || !reason) {
        return invalid(reply, [...(reason ? [] : [{ path: 'reason', message: 'Укажите причину' }]), ...(typeof b.rowVersion === 'number' ? [] : [{ path: 'rowVersion', message: 'Нужна версия' }])]);
      }
      const ok = allowed(me, op, { id: s.id, roles: [s.role], branchIds: s.branchIds, cityIds: s.cityIds });
      if (ok === 'zone') return notFound(reply);
      if (!ok || (op === 'block' && s.id === me.id)) return forbidden(reply);
      if (b.rowVersion !== (s.rowVersion ?? 1)) {
        return d.fail(reply, 409, 'VERSION_CONFLICT', 'Карточка изменилась, обновите форму', { current: { rowVersion: s.rowVersion ?? 1, status: s.status ?? 'active' } });
      }
      const [from, to] = op === 'block' ? (['active', 'blocked'] as const) : (['blocked', 'active'] as const);
      if ((s.status ?? 'active') !== from) return d.fail(reply, 400, 'VALIDATION_FAILED', `Сотрудник не в статусе ${from}`, { status: s.status ?? 'active' });
      s.status = to;
      s.rowVersion = (s.rowVersion ?? 1) + 1;
      if (op === 'block') d.endSessions(s.id);
      d.audit(me, 'staff', s.id, `staff.${op === 'block' ? 'blocked' : 'unblocked'}`, { status: from }, { status: to }, reason);
      return item(s);
    });
  }
}

/** Видит ли сотрудник хронологию сотрудника id (routes.crm.ts assertTimelineObject). */
export function staffTimelineVisible(d: Pick<StaffMockDeps, 'access' | 'can'>, me: StaffRecord, id: string): boolean {
  if (d.access(me).network || id === me.id) return true;
  const s = list.find((x) => x.id === id);
  if (!s || !d.can(me, 'staff.view')) return false;
  const z = d.access(me);
  const all = [...s.branchIds.map((b) => z.branchIds.includes(b)), ...s.cityIds.map((c) => z.cityIds.includes(c))];
  return all.length > 0 && all.every(Boolean);
}

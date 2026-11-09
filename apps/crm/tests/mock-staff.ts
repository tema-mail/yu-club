// Мок экрана «Сотрудники» (S0-15c): точно по apps/api/src/modules/staff/routes.staff.ts и правилам
// assertCanManageStaff (core/permissions.ts); S3-87 – делегирование по staff/grants.ts. Подключается из mock-api.ts (registerStaff), состояние – общий
// массив сотрудников мока; resetStaff() возвращает засев (POST /__test/reset).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes, randomUUID } from 'node:crypto';

type Role = 'owner' | 'director' | 'admin';
export interface StaffRecord {
  id: string; email: string; password: string; firstName: string; lastName: string; role: Role;
  cityIds: string[]; branchIds: string[]; mustChangePassword?: boolean;
  phone?: string | null; status?: 'active' | 'blocked' | 'archived'; rowVersion?: number; lastLoginAt?: string | null;
  employmentStart?: string | null; employmentEnd?: string | null; planningStatus?: 'available' | 'on_leave'; managerComment?: string | null;
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
  grants = seedGrants();
  idem.clear();
}

// ---- делегирование (S3-89, staff/grants.ts и routes.crm.ts №380–382): только Владелец, себе нельзя, закрытый список DELEGABLE.
// Отличие от API одно: id мока – не UUID, поэтому проверки формы uuid (staffId, cityId, branchId) здесь нет.
const DELEGABLE = ['block.manage', 'network.hours.manage', 'finance.income.create', 'finance.expense.create',
  'equipment.view.accounts', 'client.merge', 'shift.manage', 'payroll.view', 'network.branch.create'];
interface Grant {
  id: string; staffId: string; action: string; cityId: string | null; branchId: string | null; validFrom: string; validTo: string | null;
  grantedBy: string; createdAt: string; revokedAt: string | null; revokedBy: string | null;
}
let grants: Grant[] = [];
const idem = new Map<string, { request: string; status: number; body: unknown }>();
const dayShift = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
/** Засев от «сейчас»: истёкшее право Директора и отозванное у Администратора – задним числом через API их не создать. */
function seedGrants(): Grant[] {
  const at = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
  return [
    { id: 'g-expired', staffId: 's-director', action: 'payroll.view', cityId: 'c-nsk', branchId: null, validFrom: dayShift(-40), validTo: dayShift(-10), grantedBy: 's-owner', createdAt: at(-41), revokedAt: null, revokedBy: null },
    { id: 'g-revoked', staffId: 's-admin', action: 'finance.income.create', cityId: null, branchId: 'b-nsk-krasny', validFrom: dayShift(-20), validTo: null, grantedBy: 's-owner', createdAt: at(-21), revokedAt: at(-5), revokedBy: 's-owner' },
  ];
}
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (v: unknown): v is string => typeof v === 'string' && DATE.test(v) && !Number.isNaN(Date.parse(v));

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
  grants = seedGrants();
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
    if (!s) return notFound(reply);
    // Карточка K18 §2: комментарий – только тому, кто вправе править сотрудника (loadCard в routes.staff.ts).
    const canRead = allowed(me, 'update_profile', { id: s.id, roles: [s.role], branchIds: s.branchIds, cityIds: s.cityIds }) === true;
    return { ...item(s), employmentStart: s.employmentStart ?? null, employmentEnd: s.employmentEnd ?? null, planningStatus: s.planningStatus ?? 'available', managerComment: canRead ? (s.managerComment ?? null) : null };
  });

  // K18 №319 (shifts/plan.ts setEmployment): вне зоны – 404, нет права – 403, значения в аудите маскируются.
  app.patch(`${P}/staff/:staffId/employment`, async (req, reply) => {
    const me = d.current(req);
    if (!req.headers['idempotency-key']) return d.fail(reply, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'Нужен заголовок Idempotency-Key');
    const b = (req.body ?? {}) as { rowVersion?: unknown; employmentStart?: string | null; employmentEnd?: string | null; managerComment?: string | null };
    const isDate = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v));
    if (typeof b.rowVersion !== 'number') return invalid(reply, [{ path: 'rowVersion', message: 'Нужна версия' }]);
    if (!isDate(b.employmentStart) || !isDate(b.employmentEnd)) return invalid(reply, [{ path: 'employmentStart', message: 'Дата – ГГГГ-ММ-ДД' }]);
    if (typeof b.managerComment === 'string' && b.managerComment.length > 2000) return invalid(reply, [{ path: 'managerComment', message: 'Слишком длинно' }]);
    const s = visible(me, (req.params as { staffId: string }).staffId);
    if (!s) return notFound(reply);
    const ok = allowed(me, 'update_profile', { id: s.id, roles: [s.role], branchIds: s.branchIds, cityIds: s.cityIds });
    if (ok === 'zone') return notFound(reply);
    if (!ok) return forbidden(reply);
    if (b.rowVersion !== (s.rowVersion ?? 1)) return d.fail(reply, 409, 'VERSION_CONFLICT', 'Карточка изменилась, обновите форму', { rowVersion: s.rowVersion ?? 1 });
    const start = b.employmentStart === undefined ? (s.employmentStart ?? null) : b.employmentStart;
    const end = b.employmentEnd === undefined ? (s.employmentEnd ?? null) : b.employmentEnd;
    const comment = b.managerComment === undefined ? (s.managerComment ?? null) : b.managerComment?.trim() || null;
    if (start && end && end < start) return d.fail(reply, 400, 'VALIDATION_FAILED', 'Дата окончания работы раньше даты начала', { field: 'employmentEnd' });
    if (start !== (s.employmentStart ?? null) || end !== (s.employmentEnd ?? null) || comment !== (s.managerComment ?? null)) {
      // В журнале – только изменённые поля и маска (K2 PD_KEYS).
      const after: Record<string, string | null> = {};
      if (start !== (s.employmentStart ?? null)) after.employmentStart = start && '****-**-**';
      if (end !== (s.employmentEnd ?? null)) after.employmentEnd = end && '****-**-**';
      if (comment !== (s.managerComment ?? null)) after.managerComment = comment && '***';
      Object.assign(s, { employmentStart: start, employmentEnd: end, managerComment: comment, rowVersion: (s.rowVersion ?? 1) + 1 });
      d.audit(me, 'staff', s.id, 'staff.employment_changed', {}, after);
    }
    return { rowVersion: s.rowVersion ?? 1 };
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

  // №380–382 (staff/routes.crm.ts): порядок проверок как в API – вход, Idempotency-Key, Владелец, тело, сотрудник, право и зона, пересечение.
  const ownerOnly = (reply: FastifyReply) => d.fail(reply, 403, 'FORBIDDEN', 'Делегирование – только Владелец');
  const grantCommand = (op: string, status: number, run: (me: StaffRecord, req: FastifyRequest, reply: FastifyReply) => { status?: number; body: unknown } | null) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      const me = d.current(req);
      const key = req.headers['idempotency-key'];
      if (typeof key !== 'string' || !key) return d.fail(reply, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'Нужен заголовок Idempotency-Key');
      const scope = `${me.id}:staff.grant.${op}:${key}`;
      const request = JSON.stringify({ params: req.params, body: req.body ?? {} });
      const seen = idem.get(scope);
      if (seen) {
        if (seen.request !== request) return d.fail(reply, 409, 'IDEMPOTENCY_KEY_REUSED', 'Этот ключ уже использован для другого запроса');
        reply.header('idempotent-replay', 'true');
        return reply.code(seen.status).send(seen.body);
      }
      const r = run(me, req, reply);
      if (!r) return reply; // ошибка уже отправлена; в API откат транзакции – ключ не сохраняется
      idem.set(scope, { request, status, body: r.body });
      return reply.code(status).send(r.body);
    };

  app.get(`${P}/staff/grants`, async (req, reply) => {
    const me = d.current(req);
    reply.header('cache-control', 'no-store');
    if (me.role !== 'owner') return ownerOnly(reply);
    const q = req.query as { staffId?: string };
    const items = grants.filter((g) => !q.staffId || g.staffId === q.staffId).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
    return { items: items.slice(0, 500), delegable: DELEGABLE };
  });

  app.post(`${P}/staff/:staffId/grants`, grantCommand('create', 201, (me, req, reply) => {
    if (me.role !== 'owner') { ownerOnly(reply); return null; }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const issues: Issue[] = [];
    if (typeof b.action !== 'string' || !b.action || b.action.length > 100) issues.push({ path: 'action', message: 'Нужно действие' });
    for (const f of ['cityId', 'branchId']) if (b[f] !== undefined && typeof b[f] !== 'string') issues.push({ path: f, message: 'Неверный id' });
    if (!isDate(b.validFrom)) issues.push({ path: 'validFrom', message: 'Дата – ГГГГ-ММ-ДД' });
    if (b.validTo !== undefined && b.validTo !== null && !isDate(b.validTo)) issues.push({ path: 'validTo', message: 'Дата – ГГГГ-ММ-ДД' });
    const reason = typeof b.reason === 'string' ? b.reason.trim() : undefined;
    if (b.reason !== undefined && (reason === undefined || !reason || reason.length > 500)) issues.push({ path: 'reason', message: 'От 1 до 500 символов' });
    if ((b.cityId === undefined) === (b.branchId === undefined)) issues.push({ path: '', message: 'Нужна одна цель: cityId или branchId' });
    if (isDate(b.validFrom) && isDate(b.validTo) && b.validTo < b.validFrom) issues.push({ path: 'validTo', message: 'validTo раньше validFrom' });
    if (issues.length) { invalid(reply, issues); return null; }
    const validFrom = b.validFrom as string;
    const validTo = (b.validTo as string | null | undefined) ?? null;
    if (validFrom < dayShift(-1)) { d.fail(reply, 400, 'VALIDATION_FAILED', 'Дата начала права в прошлом', { field: 'validFrom' }); return null; }
    const staffId = (req.params as { staffId: string }).staffId;
    if (staffId === me.id) { ownerOnly(reply); return null; }
    const t = list.find((x) => x.id === staffId);
    if (!t || t.status === 'archived') { notFound(reply); return null; }
    const action = b.action as string;
    if (!DELEGABLE.includes(action)) { d.fail(reply, 422, 'GRANT_ACTION_NOT_DELEGABLE', 'Это действие не делегируется', { action }); return null; }
    const cityId = (b.cityId as string | undefined) ?? null;
    const branchId = (b.branchId as string | undefined) ?? null;
    // assertGrantable: зона права ⊆ назначений получателя (город – назначен целиком; филиал – назначен или в назначенном городе).
    const inZone = cityId ? t.cityIds.includes(cityId) : t.branchIds.includes(branchId!) || (t.cityIds.length > 0 && d.access(t).branchIds.includes(branchId!));
    if ((action === 'network.branch.create' && !cityId) || !inZone) { d.fail(reply, 422, 'GRANT_SCOPE_INVALID', 'Зона права вне назначений сотрудника'); return null; }
    const end = (x: string | null) => x ?? '9999-12-31';
    if (grants.some((g) => !g.revokedAt && g.staffId === staffId && g.action === action && (g.cityId ?? g.branchId) === (cityId ?? branchId) && g.validFrom <= end(validTo) && validFrom <= end(g.validTo))) {
      { d.fail(reply, 409, 'GRANT_ALREADY_ACTIVE', 'На эти даты такое право уже выдано'); return null; }
    }
    const g: Grant = { id: randomUUID(), staffId, action, cityId, branchId, validFrom, validTo, grantedBy: me.id, createdAt: new Date().toISOString(), revokedAt: null, revokedBy: null };
    grants.push(g);
    d.audit(me, 'staff_grant', g.id, 'staff.grant.created', {}, { staffId, action, cityId, branchId, validFrom, validTo }, reason ?? null);
    return { body: g };
  }));

  app.post(`${P}/staff/grants/:grantId/revoke`, grantCommand('revoke', 200, (me, req, reply) => {
    if (me.role !== 'owner') { ownerOnly(reply); return null; }
    const b = (req.body ?? {}) as { reason?: unknown };
    const reason = typeof b.reason === 'string' ? b.reason.trim() : undefined;
    if (b.reason !== undefined && (reason === undefined || !reason || reason.length > 500)) { invalid(reply, [{ path: 'reason', message: 'От 1 до 500 символов' }]); return null; }
    const g = grants.find((x) => x.id === (req.params as { grantId: string }).grantId);
    if (!g) { notFound(reply); return null; }
    if (g.revokedAt) return { body: g }; // повтор над отозванным – без новой записи аудита
    Object.assign(g, { revokedAt: new Date().toISOString(), revokedBy: me.id });
    d.audit(me, 'staff_grant', g.id, 'staff.grant.revoked', { staffId: g.staffId, action: g.action, validFrom: g.validFrom, validTo: g.validTo }, {}, reason ?? null);
    return { body: g };
  }));

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

// K1. Права: роль × зона × действие (ADR 0005). Набор фиксирован кодом (N-06, R-14); права с датами – staff_grants (S3-88).
// Неуказанное – запрещено: действие вне реестра даёт false для всех, включая Владельца.
// Чужой объект – NOT_FOUND (как несуществующий), FORBIDDEN – только объект в зоне без права.
import { writeDenied, type AuditAction, type AuditObjectType, type AuditRequestMeta, type Db } from './audit.ts';
import { AppError } from './errors.ts';
import { instantToLocal, isValidTimeZone } from './time.ts';
import type { Actor, StaffRole } from './audit.ts';

export type { Actor, StaffRole } from './audit.ts';

// ---- реестр действий Э0–Э3 (K1 §Реестр, «Действия Э2», «Действия Э3»). О – owner, Д – director, А – admin.

const O: readonly StaffRole[] = ['owner'];
const OD: readonly StaffRole[] = ['owner', 'director'];
const ODA: readonly StaffRole[] = ['owner', 'director', 'admin'];

const MATRIX = {
  'network.view': ODA,
  'network.city.manage': O,
  'network.branch.create': O,
  'network.branch.archive': O,
  'network.branch.update': OD,
  'network.hours.manage': OD,
  'staff.view': OD,
  'staff.director.assign': O,
  'staff.admin.assign': OD,
  'staff.block': OD,
  'resources.view': ODA,
  'resources.manage': OD,
  'schedule.view': ODA,
  'booking.create': ODA,
  'booking.cancel': ODA,
  'booking.reschedule': ODA,
  'booking.visit.mark': ODA,
  'booking.visit.correct': OD,
  'block.manage': ODA,
  'client.view.basic': ODA,
  'client.view.full': OD,
  'client.update.limited': ODA,
  'client.update': OD,
  'client.merge': O,
  'client.export': O,
  'export.pd': O,
  'tariff.manage': O,
  'settings.network.manage': O,
  'settings.branch.manage': OD,
  'dictionary.manage': O,
  'audit.view': OD,
  'audit.view.own': ODA,
  'audit.export': O,
  'notifications.view': ODA,
  // ---- Э2 (K1 «Действия Э2»; K10 §8, K15 §10, K16 §9, K17 §8). Решение S2-01: общая MATRIX, а не actions.ts модулей.
  // Умолчания Q-29 / R-14, Q-45 / R-13, Q-48 – меняются правкой этих строк.
  'finance.payment.record': ODA,
  'finance.payment.view': ODA,
  'finance.refund': OD,
  'finance.view': OD,
  'finance.view.day': ODA,
  'finance.expense.create': ODA,
  'finance.income.create': OD,
  'finance.opening_balance': O,
  'finance.withdrawal': OD,
  'finance.place_transfer': OD,
  'finance.correct': O, // N-06 «кроме финкорректировок» – до ответа заказчика
  'finance.category.manage': O,
  'finance.period.close': O,
  'finance.shift.operate': ODA,
  'finance.shift.resolve': OD,
  'loyalty.view': ODA,
  'loyalty.adjust': OD,
  'loyalty.adjust_below_limit': O,
  'loyalty.book_below_limit': OD,
  'loyalty.goods.manage': OD,
  'loyalty.goods.issue': ODA,
  'certificate.view': ODA,
  'certificate.sell': OD,
  'certificate.cancel': OD,
  'certificate.correct': O,
  'certificate.review': OD,
  'certificate.link': ODA,
  // ---- Э3 (K1 «Действия Э3»; K18 §12, K19 §12, K20 §13; решение D3-01). Умолчания Q-52, Q-54, Q-60, Q-62 / R-14,
  // Q-64 / R-15, Q-107, Q-108, Q-115, Q-151 – меняются правкой этих строк. payroll.view.own и payroll.export не вводятся.
  'shift.view.own': ODA,
  'shift.plan.own': ODA,
  'shift.attendance.self': ODA,
  'shift.view': ODA,
  'shift.manage': OD,
  'shift.outside_hours': OD,
  'shift.attendance.correct': OD,
  'staff.planning_status': OD,
  'payroll.view': OD,
  'payroll.rate.manage': O,
  'payroll.penalty.manage': OD,
  'payroll.bonus.manage': O,
  'payroll.statement.review': OD,
  'payroll.period.manage': O,
  'payroll.statement.ready': O,
  'payroll.payout.mark': O,
  'payroll.correct': O,
  'payroll.payout.expense': O,
  'equipment.view': ODA,
  'equipment.view.accounts': OD,
  'equipment.manage': OD,
  'equipment.move': OD,
  'equipment.financial.edit': O,
  'equipment.write_off': O,
  'equipment.category.manage': O,
  'repair.register': ODA,
  'repair.attach': ODA,
  'repair.manage': OD,
  'repair.approve': O,
  'repair.accept': ODA,
  'repair.close': OD,
  'repair.expense.create': OD,
  'repair.executor.manage': OD, // справочник сети: Директору – roleAllows, не assertCan({ network }) (K1 «Действия Э3»)
  'event.view': ODA,
  'event.manage': ODA,
  'event.price.manage': OD,
  'event.money.view': OD,
  'event.money.record': ODA,
  'event.package.manage': O,
  'event.type.manage': O,
  'gift.issue': ODA,
  'gift.issue.manual': O,
  'gift.cancel': O,
  'gift.book': ODA,
  'holiday.manage': O,
  // ---- Э4 (K1 «Действия Э4»; K21 §10, K22 §10, K24 §8). Умолчания Q-39, Q-80, Q-134, Q-151, Q-152 – правкой строк.
  // Цель «роль» (D4-02): content.media.upload/archive, search.global, чтение сетевого контента – только roleAllows.
  'notifications.send.service': ODA,
  'notifications.send.marketing': OD,
  'notifications.send.mass': OD,
  'notifications.retry': OD,
  'notifications.templates.manage': O,
  'content.view': ODA,
  'content.draft.edit': ODA,
  'content.publish': OD,
  'content.network.manage': O,
  'content.catalog.availability': OD,
  'content.legal.publish': O,
  'content.media.upload': ODA,
  'content.media.archive': OD,
  'content.media.purge': O,
  'content.preview': ODA,
  'reports.ops.view': ODA,
  'reports.finance.view': OD,
  'reports.clients.view': OD,
  'reports.loyalty.view': OD,
  'reports.events.view': OD,
  'reports.staff.view': OD,
  'reports.payroll.view': OD, // Директор – суммы своей зоны (решение техлида 04.11, Q-151)
  'reports.equipment.view': ODA,
  'reports.comms.view': OD,
  'reports.export': OD,
  'reports.export.detail': OD,
  'reports.export.payroll': O,
  'search.global': ODA,
} as const satisfies Record<string, readonly StaffRole[]>;

export type Action = keyof typeof MATRIX;
export const ACTIONS = Object.keys(MATRIX) as Action[];

const ROLE_SETS: Record<StaffRole, ReadonlySet<string>> = {
  owner: new Set(ACTIONS.filter((a) => (MATRIX[a] as readonly StaffRole[]).includes('owner'))),
  director: new Set(ACTIONS.filter((a) => (MATRIX[a] as readonly StaffRole[]).includes('director'))),
  admin: new Set(ACTIONS.filter((a) => (MATRIX[a] as readonly StaffRole[]).includes('admin'))),
};

/** Действия роли – для меню CRM (K11 GET /me). Защита – всё равно на сервере. */
export function actionsOf(role: StaffRole): Action[] {
  return ACTIONS.filter((a) => ROLE_SETS[role].has(a));
}

export function roleAllows(role: StaffRole, action: string): boolean {
  return ROLE_SETS[role]?.has(action) ?? false;
}

// ---- контекст

/** Закрытый список делегируемых действий (K1 «Делегирование», 04 §9). Он же – CHECK в 0310_staff_grants.sql. */
export const DELEGABLE = ['block.manage', 'network.hours.manage', 'finance.income.create', 'finance.expense.create',
  'equipment.view.accounts', 'client.merge', 'shift.manage', 'payroll.view', 'network.branch.create'] as const satisfies readonly Action[];

/** Зона действующего права; город уже раскрыт в филиалы. */
export interface GrantZone {
  cityIds: ReadonlySet<string>;
  branchIds: ReadonlySet<string>;
}

export interface AccessContext {
  actor: Extract<Actor, { kind: 'staff' }>;
  role: StaffRole;
  network: boolean;
  cityIds: ReadonlySet<string>;
  branchIds: ReadonlySet<string>;
  at: Date;
  /** Действующие на дату права сверх роли (loadAccess). Нет поля – нет прав. */
  grants?: ReadonlyMap<string, GrantZone>;
}

export type Target = { network: true } | { cityId: string } | { branchId: string } | { clientId: string };

export type BranchScope = { kind: 'all' } | { kind: 'branches'; branchIds: string[] } | { kind: 'none' };

/** Раскрытие city → филиалы и зоны целей назначений. Таблицы сети принадлежат модулю network (S0-11):
 *  реализацию передаёт server.ts (modules/network/index.ts), core модули не импортирует (ADR 0002). */
export interface NetworkLookup {
  branchesOfCities(db: Db, cityIds: string[]): Promise<string[]>;
  /** IANA-зоны городов и филиалов по id. Нет функции или id – дата назначения по UTC. */
  timezonesOf?(db: Db, input: { cityIds: string[]; branchIds: string[] }): Promise<ReadonlyMap<string, string>>;
}
/** Без модуля сети (тесты ядра): city-назначение раскрывается в пустой список, даты – по UTC. */
export const noNetwork: NetworkLookup = { branchesOfCities: async () => [] };

/** Локальная дата момента в зоне цели назначения (K1: «по зоне филиала/города»). */
function assignmentDate(at: Date, tz: string | undefined): string {
  return tz && isValidTimeZone(tz) ? instantToLocal(at, tz).date : at.toISOString().slice(0, 10);
}

/** Загружается на КАЖДЫЙ запрос (04 §12), без кэша. Сотрудник не active → SESSION_REVOKED. */
export async function loadAccess(
  db: Db,
  actor: Extract<Actor, { kind: 'staff' }>,
  at: Date,
  network: NetworkLookup = noNetwork,
): Promise<AccessContext> {
  const s = await db.query<{ role: StaffRole; status: string }>('SELECT role, status FROM app.staff WHERE id = $1', [
    actor.staffId,
  ]);
  const staff = s.rows[0];
  if (!staff || staff.status !== 'active') throw new AppError('SESSION_REVOKED', 401, 'Сессия завершена, войдите снова');
  if (staff.role === 'owner') {
    return { actor, role: 'owner', network: true, cityIds: new Set(), branchIds: new Set(), at };
  }
  // Кандидаты – с запасом ±1 сутки от даты UTC (зоны мира в пределах UTC−12…UTC+14); точная дата – по зоне цели ниже.
  const utc = at.toISOString().slice(0, 10);
  const a = await db.query<{ scope_type: string; city_id: string | null; branch_id: string | null; valid_from: string; valid_to: string | null }>(
    `SELECT scope_type, city_id, branch_id, valid_from::text AS valid_from, valid_to::text AS valid_to FROM app.staff_assignments
     WHERE staff_id = $1 AND revoked_at IS NULL AND valid_from <= $2::date + 1 AND (valid_to IS NULL OR valid_to >= $2::date - 1)`,
    [actor.staffId, utc],
  );
  const g = await db.query<GrantRow>(
    `SELECT action, city_id, branch_id, valid_from::text AS valid_from, valid_to::text AS valid_to FROM app.staff_grants
     WHERE staff_id = $1 AND revoked_at IS NULL AND valid_from <= $2::date + 1 AND (valid_to IS NULL OR valid_to >= $2::date - 1)`,
    [actor.staffId, utc],
  );
  const targets = { cityIds: [] as string[], branchIds: [] as string[] };
  for (const row of [...a.rows, ...g.rows]) {
    if (row.city_id) targets.cityIds.push(row.city_id);
    if (row.branch_id) targets.branchIds.push(row.branch_id);
  }
  const zones = network.timezonesOf && targets.cityIds.length + targets.branchIds.length > 0 ? await network.timezonesOf(db, targets) : new Map<string, string>();
  const onDate = (row: { city_id: string | null; branch_id: string | null; valid_from: string; valid_to: string | null }): boolean => {
    const date = assignmentDate(at, zones.get(row.city_id ?? row.branch_id ?? ''));
    return row.valid_from <= date && (row.valid_to === null || row.valid_to >= date);
  };
  const active = a.rows.filter(onDate);
  const cityIds = new Set<string>();
  const branchIds = new Set<string>();
  for (const row of active) {
    // Назначение network у не-Владельца не даёт сети (решение: сеть следует только из роли, ADR 0005 п.2).
    if (row.scope_type === 'city' && row.city_id) cityIds.add(row.city_id);
    if (row.scope_type === 'branch' && row.branch_id) branchIds.add(row.branch_id);
  }
  if (cityIds.size > 0) for (const b of await network.branchesOfCities(db, [...cityIds])) branchIds.add(b);
  const grants = await activeGrants(db, g.rows.filter(onDate), { cityIds, branchIds }, network);
  return { actor, role: staff.role, network: false, cityIds, branchIds, at, grants };
}

interface GrantRow {
  action: string;
  city_id: string | null;
  branch_id: string | null;
  valid_from: string;
  valid_to: string | null;
}

/** Права на дату по действиям. Зона права остаётся внутри назначений и после выдачи: снятое назначение закрывает и право (K1). */
async function activeGrants(
  db: Db,
  rows: GrantRow[],
  assigned: { cityIds: ReadonlySet<string>; branchIds: ReadonlySet<string> },
  network: NetworkLookup,
): Promise<ReadonlyMap<string, GrantZone>> {
  const out = new Map<string, { cityIds: Set<string>; branchIds: Set<string> }>();
  for (const row of rows) {
    const inside = row.city_id ? assigned.cityIds.has(row.city_id) : assigned.branchIds.has(row.branch_id ?? '');
    if (!inside) continue;
    const zone = out.get(row.action) ?? { cityIds: new Set<string>(), branchIds: new Set<string>() };
    out.set(row.action, zone);
    if (row.branch_id) zone.branchIds.add(row.branch_id);
    if (row.city_id) {
      zone.cityIds.add(row.city_id);
      for (const b of await network.branchesOfCities(db, [row.city_id])) zone.branchIds.add(b);
    }
  }
  return out;
}

export type GrantScope = { cityId: string } | { branchId: string };

/** Проверка выдачи права (S3-89 вызывает в транзакции). Зона права ⊆ действующих назначений получателя на дату начала. */
export async function assertGrantable(
  db: Db,
  input: { staffId: string; action: string; scope: GrantScope; validFrom: string },
  network: NetworkLookup = noNetwork,
): Promise<void> {
  if (!(DELEGABLE as readonly string[]).includes(input.action)) {
    throw new AppError('GRANT_ACTION_NOT_DELEGABLE', 422, 'Это действие не делегируется', { action: input.action });
  }
  const invalid = () => new AppError('GRANT_SCOPE_INVALID', 422, 'Зона права вне назначений сотрудника');
  // Цель network.branch.create – город (K1): право на филиал не значило бы ничего.
  if (input.action === 'network.branch.create' && !('cityId' in input.scope)) throw invalid();
  const a = await db.query<{ city_id: string | null; branch_id: string | null }>(
    `SELECT city_id, branch_id FROM app.staff_assignments
     WHERE staff_id = $1 AND revoked_at IS NULL AND scope_type IN ('city','branch')
       AND valid_from <= $2::date AND (valid_to IS NULL OR valid_to >= $2::date)`,
    [input.staffId, input.validFrom],
  );
  const cityIds = a.rows.flatMap((r) => (r.city_id ? [r.city_id] : []));
  if ('cityId' in input.scope) {
    if (!cityIds.includes(input.scope.cityId)) throw invalid();
    return;
  }
  const { branchId } = input.scope;
  if (a.rows.some((r) => r.branch_id === branchId)) return;
  if (cityIds.length === 0 || !(await network.branchesOfCities(db, cityIds)).includes(branchId)) throw invalid();
}

// ---- проверки

function inZone(ctx: AccessContext, target: Target): boolean {
  if (ctx.network) return true;
  if ('network' in target) return false;
  if ('cityId' in target) return ctx.cityIds.has(target.cityId);
  if ('branchId' in target) return ctx.branchIds.has(target.branchId);
  return false; // клиент – только assertCanClient (асинхронно, через брони)
}

/** Цель в зоне действующего права на это действие. Сеть и клиент правом не закрываются. */
function inGrantZone(ctx: AccessContext, action: string, target: Target): boolean {
  const zone = ctx.grants?.get(action);
  if (!zone) return false;
  if ('cityId' in target) return zone.cityIds.has(target.cityId);
  if ('branchId' in target) return zone.branchIds.has(target.branchId);
  return false;
}

/** Есть ли действие хоть в какой-то зоне: роль или право. Вход в раздел; зону дальше решают can и scopeFilter. */
export function hasAction(ctx: AccessContext, action: string): boolean {
  return roleAllows(ctx.role, action) || ctx.grants?.has(action) === true;
}

/** Действия сотрудника с учётом прав – для меню CRM (K11 GET /me). */
export function actionsOfContext(ctx: AccessContext): Action[] {
  return ACTIONS.filter((a) => hasAction(ctx, a));
}

/** Чистая функция: действие у роли и цель в зоне роли ИЛИ цель в зоне права. Клиент как цель → false (нужен assertCanClient). */
export function can(ctx: AccessContext, action: string, target: Target): boolean {
  if ('clientId' in target) return false;
  return (roleAllows(ctx.role, action) && inZone(ctx, target)) || inGrantZone(ctx, action, target);
}

const notFound = () => new AppError('NOT_FOUND', 404, 'Не найдено');
const forbidden = (action: string) => new AppError('FORBIDDEN', 403, 'Недостаточно прав', { action });

/** NOT_FOUND – цель вне зоны (не раскрываем существование); FORBIDDEN – в зоне, но роли нельзя.
 *  Для сетевой цели вне зоны – FORBIDDEN: существование сети не секрет. */
export function assertCan(ctx: AccessContext, action: string, target: Target): void {
  if ('clientId' in target) throw new Error('assertCan: для клиента – assertCanClient (K1)');
  if (inGrantZone(ctx, action, target)) return;
  if (!inZone(ctx, target)) throw 'network' in target ? forbidden(action) : notFound();
  if (!roleAllows(ctx.role, action)) throw forbidden(action);
}

/** assertCan + запись отказа в аудит отдельной транзакцией (ADR 0005 п.8, K2 writeDenied).
 *  denied – код K2 той команды, которой отказали (например 'branch.updated'), и её объект. */
export async function assertCanAudited(
  db: Db,
  meta: AuditRequestMeta,
  ctx: AccessContext,
  action: string,
  target: Target,
  denied: { action: AuditAction; object: { type: AuditObjectType; id: string | null } },
): Promise<void> {
  try {
    assertCan(ctx, action, target);
  } catch (err) {
    if (err instanceof AppError) {
      await writeDenied(db, meta, {
        action: denied.action,
        object: denied.object,
        branchId: 'branchId' in target ? target.branchId : null,
        cityId: 'cityId' in target ? target.cityId : null,
        reason: `${err.code}: ${action}`,
        result: 'denied',
      });
    }
    throw err;
  }
}

/** Условие для списков и поиска – применяется в SQL, не после выборки. */
export function scopeFilter(ctx: AccessContext, action: string): BranchScope {
  const byRole = roleAllows(ctx.role, action);
  if (byRole && ctx.network) return { kind: 'all' };
  const branches = new Set<string>([...(byRole ? ctx.branchIds : []), ...(ctx.grants?.get(action)?.branchIds ?? [])]);
  if (branches.size === 0) return { kind: 'none' };
  return { kind: 'branches', branchIds: [...branches].sort() };
}

const COLUMN_RE = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/;

/** SQL-фрагмент для WHERE (замена Kysely-помощника K1 applyBranchScope: Kysely в проекте пока нет).
 *  Добавляет параметр в params и возвращает условие с его номером. */
export function branchScopeSql(column: string, scope: BranchScope, params: unknown[]): string {
  if (!COLUMN_RE.test(column)) throw new Error(`branchScopeSql: недопустимое имя столбца ${column}`);
  if (scope.kind === 'all') return 'TRUE';
  if (scope.kind === 'none') return 'FALSE';
  params.push(scope.branchIds);
  return `${column} = ANY($${params.length}::uuid[])`;
}

export type StaffOp = 'create' | 'update_profile' | 'change_role' | 'change_scope' | 'block' | 'unblock' | 'end_sessions';

/** Запреты поверх роли при работе с сотрудниками (04 §2 п.6, §4.2–4.3; ADR 0005 п.9). */
export function assertCanManageStaff(
  ctx: AccessContext,
  op: StaffOp,
  target: { staffId?: string; role: StaffRole; branchIds: string[]; cityIds: string[]; newRole?: StaffRole },
): void {
  const blockOp = op === 'block' || op === 'unblock' || op === 'end_sessions';
  // change_role: важна и новая роль – повысить до директора/Владельца может только Владелец.
  if (op === 'change_role' && target.newRole === undefined) throw new Error('assertCanManageStaff: для change_role нужен newRole');
  const roles = op === 'change_role' ? [target.role, target.newRole!] : [target.role];
  const action = blockOp ? 'staff.block' : roles.every((r) => r === 'admin') ? 'staff.admin.assign' : 'staff.director.assign';
  if (!roleAllows(ctx.role, action)) throw forbidden(action);
  // 1. Никто не меняет себе роль и зону.
  if (target.staffId === ctx.actor.staffId && (op === 'change_role' || op === 'change_scope')) throw forbidden(action);
  // 2. Директоров и Владельца трогает только Владелец.
  if (roles.some((r) => r === 'owner' || r === 'director') && ctx.role !== 'owner') throw forbidden(action);
  // 3. Владельца создаёт только установка (CLI), не CRM: ни создать, ни назначить ролью, ни снять с роли.
  if (roles.includes('owner') && (op === 'create' || op === 'change_role')) throw forbidden(action);
  // 4. Не-Владелец – только в пределах своей зоны.
  if (!ctx.network) {
    const outside =
      target.branchIds.some((b) => !ctx.branchIds.has(b)) || target.cityIds.some((c) => !ctx.cityIds.has(c));
    if (outside) throw notFound();
  }
}

/** Клиент работает только со своим (03 §3 п.4). Чужой → NOT_FOUND. */
export function assertOwnClient(actor: Actor, clientId: string): void {
  if (actor.kind !== 'client' || actor.clientId !== clientId) throw notFound();
}

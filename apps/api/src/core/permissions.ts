// K1. Права: роль × зона × действие (ADR 0005). Набор до Э3 фиксирован кодом (N-06, R-14).
// Неуказанное – запрещено: действие вне реестра даёт false для всех, включая Владельца.
// Чужой объект – NOT_FOUND (как несуществующий), FORBIDDEN – только объект в зоне без права.
import { writeDenied, type AuditAction, type AuditObjectType, type AuditRequestMeta, type Db } from './audit.ts';
import { AppError } from './errors.ts';
import type { Actor, StaffRole } from './audit.ts';

export type { Actor, StaffRole } from './audit.ts';

// ---- реестр действий Э0–Э1 (K1 §Реестр). О – owner, Д – director, А – admin.

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
} as const satisfies Record<string, readonly StaffRole[]>;
// finance.*, loyalty.*, certificate.*, payroll.*, shift.* – не в Э1: их нет здесь, значит запрещены.
// Решение для Э2 (K1): finance.refund – Владелец и Директор; finance.correct – только Владелец.

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

export interface AccessContext {
  actor: Extract<Actor, { kind: 'staff' }>;
  role: StaffRole;
  network: boolean;
  cityIds: ReadonlySet<string>;
  branchIds: ReadonlySet<string>;
  at: Date;
}

export type Target = { network: true } | { cityId: string } | { branchId: string } | { clientId: string };

export type BranchScope = { kind: 'all' } | { kind: 'branches'; branchIds: string[] } | { kind: 'none' };

/** Раскрытие city → филиалы. Таблицы филиалов принадлежат модулю network (S0-11): он и даёт реализацию. */
export interface NetworkLookup {
  branchesOfCities(db: Db, cityIds: string[]): Promise<string[]>;
}
/** До S0-11 филиалов нет – city-назначение раскрывается в пустой список. */
export const noNetwork: NetworkLookup = { branchesOfCities: async () => [] };

/** Дата назначения. Решение K1 – «по зоне филиала/города»; до S0-11 зон нет – берём дату UTC. */
function assignmentDate(at: Date): string {
  return at.toISOString().slice(0, 10);
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
  const date = assignmentDate(at);
  const a = await db.query<{ scope_type: string; city_id: string | null; branch_id: string | null }>(
    `SELECT scope_type, city_id, branch_id FROM app.staff_assignments
     WHERE staff_id = $1 AND revoked_at IS NULL AND valid_from <= $2::date AND (valid_to IS NULL OR valid_to >= $2::date)`,
    [actor.staffId, date],
  );
  const cityIds = new Set<string>();
  const branchIds = new Set<string>();
  for (const row of a.rows) {
    // Назначение network у не-Владельца не даёт сети (решение: сеть следует только из роли, ADR 0005 п.2).
    if (row.scope_type === 'city' && row.city_id) cityIds.add(row.city_id);
    if (row.scope_type === 'branch' && row.branch_id) branchIds.add(row.branch_id);
  }
  if (cityIds.size > 0) for (const b of await network.branchesOfCities(db, [...cityIds])) branchIds.add(b);
  return { actor, role: staff.role, network: false, cityIds, branchIds, at };
}

// ---- проверки

function inZone(ctx: AccessContext, target: Target): boolean {
  if (ctx.network) return true;
  if ('network' in target) return false;
  if ('cityId' in target) return ctx.cityIds.has(target.cityId);
  if ('branchId' in target) return ctx.branchIds.has(target.branchId);
  return false; // клиент – только assertCanClient (асинхронно, через брони)
}

/** Чистая функция: действие в наборе роли И цель в зоне. Клиент как цель → false (нужен assertCanClient). */
export function can(ctx: AccessContext, action: string, target: Target): boolean {
  if ('clientId' in target) return false;
  return roleAllows(ctx.role, action) && inZone(ctx, target);
}

const notFound = () => new AppError('NOT_FOUND', 404, 'Не найдено');
const forbidden = (action: string) => new AppError('FORBIDDEN', 403, 'Недостаточно прав', { action });

/** NOT_FOUND – цель вне зоны (не раскрываем существование); FORBIDDEN – в зоне, но роли нельзя.
 *  Для сетевой цели вне зоны – FORBIDDEN: существование сети не секрет. */
export function assertCan(ctx: AccessContext, action: string, target: Target): void {
  if ('clientId' in target) throw new Error('assertCan: для клиента – assertCanClient (K1)');
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
  if (!roleAllows(ctx.role, action)) return { kind: 'none' };
  if (ctx.network) return { kind: 'all' };
  if (ctx.branchIds.size === 0) return { kind: 'none' };
  return { kind: 'branches', branchIds: [...ctx.branchIds].sort() };
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
  target: { staffId?: string; role: StaffRole; branchIds: string[]; cityIds: string[] },
): void {
  const blockOp = op === 'block' || op === 'unblock' || op === 'end_sessions';
  const action = blockOp ? 'staff.block' : target.role === 'admin' ? 'staff.admin.assign' : 'staff.director.assign';
  if (!roleAllows(ctx.role, action)) throw forbidden(action);
  // 1. Никто не меняет себе роль и зону.
  if (target.staffId === ctx.actor.staffId && (op === 'change_role' || op === 'change_scope')) throw forbidden(action);
  // 2. Директоров и Владельца трогает только Владелец.
  if ((target.role === 'owner' || target.role === 'director') && ctx.role !== 'owner') throw forbidden(action);
  // 3. Владельца создаёт только установка (CLI), не CRM.
  if (target.role === 'owner' && (op === 'create' || op === 'change_role')) throw forbidden(action);
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

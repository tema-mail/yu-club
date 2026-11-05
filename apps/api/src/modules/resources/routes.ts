// S1-01. K11 №18: помещения, комнаты, ресурсы в CRM (02 §7–8, 15 §7–8, K1 resources.view / resources.manage).
// Тонкий слой и команды модуля в одном файле: разбор → права → правило → запись → аудит (K2) в транзакции.
// Права: объект вне зоны – NOT_FOUND (как несуществующий), в зоне без resources.manage – FORBIDDEN; отказ изменяющей
// команды пишется в аудит отдельной транзакцией (ADR 0005 п.8). Удаления нет – архив (02 §12).
// Число ПК/VR – строки resources, не код (01 §5.1). Закрытие комнаты (status) закрывает её ресурсы при чтении (index.ts).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { diffFields, writeAudit, writeDenied, type AuditAction, type AuditObjectType, type AuditRequestMeta, type Db, type Tx } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { idempotencyScope, requireIdempotencyKey, runIdempotent } from '../../core/idempotency.ts';
import { can, type AccessContext } from '../../core/permissions.ts';
import { systemClock, type Clock } from '../../core/time.ts';
import { getBranch } from '../network/index.ts';
import { attachInitialUnits, changeComposition, compositionAt, insertUnit, listUnits, type ResourceUsageProvider } from './composite.ts';
import { getResource, isUuid } from './index.ts';

export interface ResourcesDeps {
  pool: Db & { connect(): Promise<pg.PoolClient> };
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<{ access: AccessContext; meta: AuditRequestMeta }>;
  clock?: Clock;
  /** Будущие брони и удержания ресурса для смены состава (booking/providers.ts, ADR 0002 п.1). */
  usage: ResourceUsageProvider;
  /** Ресурс создан с экрана ресурсов, в той же транзакции: подарочный ресурс VR-комнаты (K20 §8.2, S3-62; подключает server.ts). */
  onResourceCreated?: (tx: Tx, ctx: AccessContext, resource: { branchId: string; type: string }, meta: AuditRequestMeta, clock: Clock) => Promise<void>;
}

// ---- права и отказы

interface Denial {
  action: AuditAction;
  object: { type: AuditObjectType; id: string | null };
  branchId: string | null;
  reason: string;
}
const DENIALS = new WeakMap<AppError, Denial>();
export const denialOf = (err: unknown): Denial | undefined => (err instanceof AppError ? DENIALS.get(err) : undefined);
export const notFound = (): AppError => new AppError('NOT_FOUND', 404, 'Не найдено');

/** Видимость (resources.view) → право (perm). Для изменяющих команд отказ помечается для аудита. */
export function guard(
  ctx: AccessContext,
  perm: 'resources.view' | 'resources.manage',
  branchId: string,
  audit?: { action: AuditAction; object: { type: AuditObjectType; id: string | null } },
): void {
  const fail = (err: AppError): never => {
    if (audit) DENIALS.set(err, { ...audit, branchId, reason: `${err.code}: ${perm}` });
    throw err;
  };
  if (!can(ctx, 'resources.view', { branchId })) fail(notFound());
  if (!can(ctx, perm, { branchId })) fail(new AppError('FORBIDDEN', 403, 'Недостаточно прав', { action: perm }));
}

export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value ?? {});
  if (!r.success) {
    throw new AppError('VALIDATION_FAILED', 400, 'Неверные данные запроса', {
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}

export function checkVersion(current: number, sent: number): void {
  if (current !== sent) throw new AppError('VERSION_CONFLICT', 409, 'Запись изменилась – обновите форму', { current });
}

export const linkInvalid = (field: string): AppError =>
  new AppError('RESOURCE_LINK_INVALID', 422, 'Связанный объект не найден в этом филиале или в архиве', { field });

function dbError(err: unknown): never {
  const e = err as { code?: string; constraint?: string };
  if (e.code === '23505') throw new AppError('RESOURCE_SLUG_TAKEN', 409, 'Адрес (slug) уже занят в филиале');
  if (e.code === '23503') throw linkInvalid(e.constraint ?? 'link');
  throw err;
}

// ---- сущности: одна схема на помещение, комнату, ресурс

type Kind = 'space' | 'room' | 'resource';
interface EntityDef {
  kind: Kind;
  table: string;
  cols: Record<string, string>; // camelCase поля → столбец
  create: z.ZodType<Record<string, unknown>>;
  patch: z.ZodType<Record<string, unknown> & { rowVersion: number }>;
  createOnly: string[];
  child?: { table: string; fk: string }; // архив запрещён, пока есть неархивные дети
}

const NAME = z.string().trim().min(1).max(200);
const TEXT = z.string().max(4000).nullable();
const SORT = z.number().int().min(-1_000_000).max(1_000_000);
const ROW_VERSION = z.number().int().min(1);
const ID = z.uuid();

const spaceFields = {
  spaceType: z.string().max(64),
  name: NAME,
  description: TEXT,
  internalComment: TEXT,
  status: z.enum(['active', 'unavailable', 'repair', 'closed']),
  sortOrder: SORT,
};
const roomFields = {
  spaceId: ID.nullable(),
  slug: z.string().regex(/^[a-z0-9-]{1,64}$/),
  name: NAME,
  capacity: z.number().int().min(1).max(1000).nullable(),
  publicDescription: TEXT,
  internalDescription: TEXT,
  status: z.enum(['active', 'unavailable', 'repair', 'closed']),
  isPublished: z.boolean(),
  wholeRentAllowed: z.boolean(),
  sortOrder: SORT,
};
const resourceFields = {
  roomId: ID.nullable(),
  type: z.string().max(64),
  name: NAME,
  status: z.enum(['active', 'unavailable']),
  selfBookable: z.boolean(),
  stepMinutesOverride: z.number().int().min(1).max(1440).refine((n) => 1440 % n === 0, 'шаг делит сутки').nullable(),
  sortOrder: SORT,
  internalComment: TEXT,
};

type Shape = Record<string, z.ZodType>;
const optionalAll = (s: Shape) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v.optional()]));
const createSchema = (s: Shape, required: string[]) =>
  z.strictObject({ ...optionalAll(s), ...Object.fromEntries(required.map((k) => [k, s[k]!])) }) as unknown as z.ZodType<Record<string, unknown>>;
const patchSchema = (s: Shape, createOnly: string[]) =>
  z.strictObject({ rowVersion: ROW_VERSION, ...optionalAll(Object.fromEntries(Object.entries(s).filter(([k]) => !createOnly.includes(k)))) }) as unknown as z.ZodType<
    Record<string, unknown> & { rowVersion: number }
  >;

const DEFS: Record<Kind, EntityDef> = {
  space: {
    kind: 'space',
    table: 'app.spaces',
    cols: { spaceType: 'space_type', name: 'name', description: 'description', internalComment: 'internal_comment', status: 'status', sortOrder: 'sort_order' },
    create: createSchema(spaceFields, ['spaceType', 'name']),
    patch: patchSchema(spaceFields, []),
    createOnly: [],
    child: { table: 'app.rooms', fk: 'space_id' },
  },
  room: {
    kind: 'room',
    table: 'app.rooms',
    cols: {
      spaceId: 'space_id', slug: 'slug', name: 'name', capacity: 'capacity', publicDescription: 'public_description',
      internalDescription: 'internal_description', status: 'status', isPublished: 'is_published',
      wholeRentAllowed: 'whole_rent_allowed', sortOrder: 'sort_order',
    },
    create: createSchema(roomFields, ['slug', 'name']),
    patch: patchSchema(roomFields, []),
    createOnly: [],
    child: { table: 'app.resources', fk: 'room_id' },
  },
  resource: {
    kind: 'resource',
    table: 'app.resources',
    cols: {
      roomId: 'room_id', type: 'resource_type', name: 'name', status: 'status', selfBookable: 'self_bookable',
      stepMinutesOverride: 'step_minutes_override', sortOrder: 'sort_order', internalComment: 'internal_comment',
    },
    create: createSchema({ ...resourceFields, unitCode: z.string().trim().min(1).max(64), unitIds: z.array(ID).max(32) }, ['type', 'name']),
    patch: patchSchema(resourceFields, ['type']),
    createOnly: ['type'],
  },
};

/** Служебные типы: открываются только грантом booking (K5, K20 §8.2), самостоятельной записи у них нет ни при каких правах. */
const SERVICE_RESOURCE_TYPES: ReadonlySet<string> = new Set(['gift_vr']);
function assertNotSelfBookable(input: Record<string, unknown>): void {
  if (input.selfBookable === true) throw new AppError('VALIDATION_FAILED', 400, 'Служебный ресурс нельзя открыть для самостоятельной записи', { field: 'selfBookable' });
}

export type EntityRow = Record<string, unknown> & { id: string; branchId: string; status: string; rowVersion: number };

const selectList = (d: EntityDef) =>
  ['id', 'branch_id AS "branchId"', ...Object.entries(d.cols).map(([k, c]) => `${c} AS "${k}"`), 'archived_at AS "archivedAt"', 'row_version AS "rowVersion"'].join(', ');

async function loadRow(db: Db | Tx, d: EntityDef, id: string, lock: boolean): Promise<EntityRow | null> {
  if (!isUuid(id)) return null;
  const r = await db.query<EntityRow>(`SELECT ${selectList(d)} FROM ${d.table} WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  return r.rows[0] ?? null;
}

/** Связи – в том же филиале и не в архиве; справочные типы – существуют и не в архиве. */
async function checkLinks(tx: Tx, branchId: string, input: Record<string, unknown>): Promise<void> {
  const checks: Array<[string, string, string]> = [
    ['spaceId', `SELECT 1 FROM app.spaces WHERE id = $1 AND branch_id = $2 AND status <> 'archived'`, 'spaceId'],
    ['roomId', `SELECT 1 FROM app.rooms WHERE id = $1 AND branch_id = $2 AND status <> 'archived'`, 'roomId'],
    ['spaceType', `SELECT 1 FROM app.dict_space_types WHERE code = $1 AND archived_at IS NULL AND $2::uuid IS NOT NULL`, 'spaceType'],
    ['type', `SELECT 1 FROM app.dict_resource_types WHERE code = $1 AND archived_at IS NULL AND bookable AND $2::uuid IS NOT NULL`, 'type'],
  ];
  for (const [key, sql, field] of checks) {
    const v = input[key];
    if (v === undefined || v === null) continue;
    const r = await tx.query(sql, [v, branchId]);
    if (r.rowCount !== 1) throw linkInvalid(field);
  }
}

async function auditEntity(tx: Tx, meta: AuditRequestMeta, clock: Clock, action: AuditAction, before: EntityRow | null, after: EntityRow): Promise<void> {
  const strip = (r: EntityRow | null) => (r ? { ...r, rowVersion: 0 } : {});
  const d = diffFields(strip(before), strip(after));
  if (before && Object.keys(d.after).length === 0) return;
  await writeAudit(tx, meta, { action, object: { type: action.split('.')[0] as AuditObjectType, id: after.id }, branchId: after.branchId, ...d }, clock);
}

export async function createEntity(tx: Tx, ctx: AccessContext, kind: Kind, branchId: string, raw: unknown, meta: AuditRequestMeta, clock: Clock): Promise<EntityRow> {
  const d = DEFS[kind];
  const action = `${kind}.created` as AuditAction;
  guard(ctx, 'resources.manage', branchId, { action, object: { type: kind, id: null } });
  const branch = await getBranch(tx, branchId);
  if (!branch) throw notFound();
  if (branch.status === 'archived') throw new AppError('RESOURCE_ARCHIVED', 409, 'Филиал в архиве');
  const { unitCode, unitIds, ...input } = parse(d.create, raw) as Record<string, unknown> & { unitCode?: string; unitIds?: string[] };
  if (kind === 'resource' && SERVICE_RESOURCE_TYPES.has(input.type as string)) {
    assertNotSelfBookable(input);
    input.selfBookable = false; // в столбце по умолчанию true: служебный тип без флага – тоже закрыт
  }
  await checkLinks(tx, branchId, input);
  const keys = Object.keys(input).filter((k) => input[k] !== undefined);
  const cols = ['branch_id', ...keys.map((k) => d.cols[k]!)];
  const values = [branchId, ...keys.map((k) => input[k])];
  const r = await tx
    .query<EntityRow>(
      `INSERT INTO ${d.table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING ${selectList(d)}`,
      values,
    )
    .catch(dbError);
  let row = r.rows[0]!;
  if (kind === 'resource') {
    const res = { id: row.id, branchId, roomId: (row.roomId as string | null) ?? null, type: row.type as string, name: row.name as string };
    row = { ...row, unitIds: await attachInitialUnits(tx, res, { unitCode, unitIds }, clock.now()) };
  }
  await auditEntity(tx, meta, clock, action, null, row);
  return row;
}

async function lockForCommand(tx: Tx, ctx: AccessContext, d: EntityDef, id: string, action: AuditAction): Promise<EntityRow> {
  const cur = await loadRow(tx, d, id, true);
  if (!cur) {
    const err = notFound();
    DENIALS.set(err, { action, object: { type: d.kind, id: isUuid(id) ? id : null }, branchId: null, reason: 'NOT_FOUND: resources.manage' });
    throw err;
  }
  guard(ctx, 'resources.manage', cur.branchId, { action, object: { type: d.kind, id: cur.id } });
  return cur;
}

export async function updateEntity(tx: Tx, ctx: AccessContext, kind: Kind, id: string, raw: unknown, meta: AuditRequestMeta, clock: Clock): Promise<EntityRow> {
  const d = DEFS[kind];
  const action = `${kind}.updated` as AuditAction;
  const cur = await lockForCommand(tx, ctx, d, id, action);
  const input = parse(d.patch, raw);
  if (cur.status === 'archived') throw new AppError('RESOURCE_ARCHIVED', 409, 'Объект в архиве');
  checkVersion(cur.rowVersion, input.rowVersion);
  if (kind === 'resource' && SERVICE_RESOURCE_TYPES.has(cur.type as string)) assertNotSelfBookable(input);
  await checkLinks(tx, cur.branchId, input);
  const keys = Object.keys(input).filter((k) => k !== 'rowVersion' && input[k] !== undefined);
  const sets = keys.map((k, i) => `${d.cols[k]!} = $${i + 2}`);
  const r = await tx
    .query<EntityRow>(
      `UPDATE ${d.table} SET ${[...sets, 'row_version = row_version + 1'].join(', ')} WHERE id = $1 RETURNING ${selectList(d)}`,
      [cur.id, ...keys.map((k) => input[k])],
    )
    .catch(dbError);
  const next = r.rows[0]!;
  await auditEntity(tx, meta, clock, action, cur, next);
  return next;
}

/** Архив вместо удаления (02 §12). Пока у помещения/комнаты есть неархивные комнаты/ресурсы – OBJECT_IN_USE. */
export async function archiveEntity(tx: Tx, ctx: AccessContext, kind: Kind, id: string, raw: unknown, meta: AuditRequestMeta, clock: Clock): Promise<EntityRow> {
  const d = DEFS[kind];
  const action = `${kind}.archived` as AuditAction;
  const cur = await lockForCommand(tx, ctx, d, id, action);
  const input = parse(z.object({ rowVersion: ROW_VERSION }), raw);
  if (cur.status === 'archived') return cur;
  checkVersion(cur.rowVersion, input.rowVersion);
  if (d.child) {
    const c = await tx.query(`SELECT 1 FROM ${d.child.table} WHERE ${d.child.fk} = $1 AND status <> 'archived' LIMIT 1`, [cur.id]);
    if (c.rowCount === 1) throw new AppError('OBJECT_IN_USE', 409, 'Сначала уберите в архив вложенные объекты');
  }
  const r = await tx.query<EntityRow>(
    `UPDATE ${d.table} SET status = 'archived', archived_at = $2, row_version = row_version + 1 WHERE id = $1 RETURNING ${selectList(d)}`,
    [cur.id, clock.now()],
  );
  const next = r.rows[0]!;
  await auditEntity(tx, meta, clock, action, cur, next);
  return next;
}

// ---- чтение

const listQuery = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  includeArchived: z.enum(['true', 'false']).optional(),
  roomId: z.uuid().optional(),
});

function decodeCursor(s: string | undefined): [number, string, string] | null {
  if (s === undefined) return null;
  try {
    const v = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(v) && v.length === 3 && typeof v[0] === 'number' && typeof v[1] === 'string' && isUuid(v[2])) return v as [number, string, string];
  } catch {
    // ниже – общая ошибка
  }
  throw new AppError('VALIDATION_FAILED', 400, 'Неверный курсор', { field: 'cursor' });
}

/** Список филиала – порядок (sort_order, name, id), курсор K11. Архивные – по includeArchived=true. */
export async function listEntities(db: Db, ctx: AccessContext, kind: Kind, branchId: string, raw: unknown): Promise<{ items: EntityRow[]; nextCursor: string | null }> {
  if (!isUuid(branchId)) throw notFound();
  guard(ctx, 'resources.view', branchId);
  if (!(await getBranch(db, branchId))) throw notFound();
  const d = DEFS[kind];
  const q = parse(listQuery, raw);
  const params: unknown[] = [branchId];
  const where = ['branch_id = $1'];
  if (q.includeArchived !== 'true') where.push(`status <> 'archived'`);
  if (q.roomId !== undefined && kind === 'resource') {
    params.push(q.roomId);
    where.push(`room_id = $${params.length}`);
  }
  const c = decodeCursor(q.cursor);
  if (c) {
    params.push(...c);
    const n = params.length;
    where.push(`(sort_order, name, id) > ($${n - 2}::int, $${n - 1}::text, $${n}::uuid)`);
  }
  params.push(q.limit + 1);
  const r = await db.query<EntityRow & { sortOrder: number; name: string }>(
    `SELECT ${selectList(d)} FROM ${d.table} WHERE ${where.join(' AND ')} ORDER BY sort_order, name, id LIMIT $${params.length}`,
    params,
  );
  const rows = r.rows.slice(0, q.limit);
  const last = rows.at(-1);
  const nextCursor = r.rows.length > q.limit && last ? Buffer.from(JSON.stringify([last.sortOrder, last.name, last.id])).toString('base64url') : null;
  return { items: rows, nextCursor };
}

export async function getEntityCard(db: Db, ctx: AccessContext, kind: Kind, id: string): Promise<EntityRow> {
  const row = await loadRow(db, DEFS[kind], id, false);
  if (!row) throw notFound();
  guard(ctx, 'resources.view', row.branchId);
  if (kind !== 'resource') return row;
  const info = (await getResource(db, row.id))!;
  return { ...row, stepMinutes: info.stepMinutes, zone: info.zone, roomStatus: info.roomStatus, unitIds: await compositionAt(db, row.id, ctx.at) };
}

// ---- единицы и состав (S1-02, K6)

const unitCreate = z.strictObject({ roomId: ID, code: z.string().trim().min(1).max(64), name: NAME });
const compositionInput = z.strictObject({ unitIds: z.array(ID).min(1).max(32), validFrom: z.iso.datetime({ offset: true }), dryRun: z.boolean().optional() });

/** Единица без своего ресурса (PS4 в VR-комнате, 01 §5.2) – живёт в комнате; аудит – room.updated (своего кода в K2 нет). */
export async function createUnit(tx: Tx, ctx: AccessContext, branchId: string, raw: unknown, meta: AuditRequestMeta, clock: Clock) {
  const input = parse(unitCreate, raw);
  guard(ctx, 'resources.manage', branchId, { action: 'room.updated', object: { type: 'room', id: input.roomId } });
  const room = await tx.query(`SELECT 1 FROM app.rooms WHERE id = $1 AND branch_id = $2 AND status <> 'archived'`, [input.roomId, branchId]);
  if (room.rowCount !== 1) throw linkInvalid('roomId');
  const unit = await insertUnit(tx, { branchId, roomId: input.roomId, code: input.code, name: input.name });
  await writeAudit(tx, meta, { action: 'room.updated', object: { type: 'room', id: input.roomId }, branchId, before: { unit: null }, after: { unit } }, clock);
  return unit;
}

export async function setComposition(tx: Tx, ctx: AccessContext, resourceId: string, raw: unknown, meta: AuditRequestMeta, clock: Clock, usage: ResourceUsageProvider) {
  const action = 'resource.composition_changed' as const;
  const cur = await lockForCommand(tx, ctx, DEFS.resource, resourceId, action);
  const input = parse(compositionInput, raw);
  return changeComposition(tx, { resourceId: cur.id, unitIds: input.unitIds, validFrom: new Date(input.validFrom), ...(input.dryRun ? { dryRun: true } : {}) }, meta, clock, usage);
}

// ---- HTTP

export type Command = (tx: Tx, ctx: AccessContext, id: string, body: unknown, meta: AuditRequestMeta, clock: Clock) => Promise<unknown>;

/** Команда: ключ → транзакция → runIdempotent; отказ по правам после отката – writeDenied. */
export function commandHandler(deps: ResourcesDeps, operation: string, run: Command, status = 200) {
  const clock = deps.clock ?? systemClock;
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const { access, meta } = await deps.authenticate(request, reply);
    const key = requireIdempotencyKey(request.headers['idempotency-key']);
    const params = request.params as Record<string, string>;
    const id = Object.values(params)[0] ?? '';
    const client = await deps.pool.connect();
    let result;
    try {
      await client.query('BEGIN');
      result = await runIdempotent(
        client,
        {
          scope: idempotencyScope('staff', access.actor.staffId, `resources.${operation}`),
          key,
          request: { route: `${request.method} ${request.routeOptions.url}`, params, body: request.body ?? null },
          clock,
        },
        async () => ({ status, body: await run(client, access, id, request.body, meta, clock) }),
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      const d = denialOf(err);
      if (d) await writeDenied(deps.pool, meta, { ...d, cityId: null, result: 'denied' }, clock);
      throw err;
    } finally {
      client.release();
    }
    if (result.replayed) reply.header('idempotent-replay', 'true');
    return reply.code(result.status).send(result.body);
  };
}

const PLURAL: Record<Kind, string> = { space: 'spaces', room: 'rooms', resource: 'resources' };

export async function resourcesRoutes(app: FastifyInstance, deps: ResourcesDeps): Promise<void> {
  const viewer = async (request: FastifyRequest, reply: FastifyReply) => (await deps.authenticate(request, reply)).access;
  for (const kind of ['space', 'room', 'resource'] as const) {
    const plural = PLURAL[kind];
    const idParam = `${kind}Id`;
    app.get(`/branches/:branchId/${plural}`, async (request, reply) =>
      listEntities(deps.pool, await viewer(request, reply), kind, (request.params as { branchId: string }).branchId, request.query),
    );
    app.get(`/${plural}/:${idParam}`, async (request, reply) =>
      getEntityCard(deps.pool, await viewer(request, reply), kind, (request.params as Record<string, string>)[idParam]!),
    );
    app.post(
      `/branches/:branchId/${plural}`,
      commandHandler(
        deps,
        `${kind}.create`,
        async (tx, ctx, branchId, body, meta, c) => {
          const row = await createEntity(tx, ctx, kind, branchId, body, meta, c);
          if (kind === 'resource') await deps.onResourceCreated?.(tx, ctx, { branchId: row.branchId, type: row.type as string }, meta, c);
          return row;
        },
        201,
      ),
    );
    app.patch(`/${plural}/:${idParam}`, commandHandler(deps, `${kind}.update`, (tx, ctx, id, body, meta, c) => updateEntity(tx, ctx, kind, id, body, meta, c)));
    app.post(`/${plural}/:${idParam}/archive`, commandHandler(deps, `${kind}.archive`, (tx, ctx, id, body, meta, c) => archiveEntity(tx, ctx, kind, id, body, meta, c)));
  }
  app.get('/branches/:branchId/units', async (request, reply) => {
    const ctx = await viewer(request, reply);
    const branchId = (request.params as { branchId: string }).branchId;
    if (!isUuid(branchId)) throw notFound();
    guard(ctx, 'resources.view', branchId);
    if (!(await getBranch(deps.pool, branchId))) throw notFound();
    return { items: await listUnits(deps.pool, branchId), nextCursor: null };
  });
  app.post('/branches/:branchId/units', commandHandler(deps, 'unit.create', createUnit, 201));
  app.post('/resources/:resourceId/composition', commandHandler(deps, 'resource.composition', (tx, ctx, id, body, meta, c) => setComposition(tx, ctx, id, body, meta, c, deps.usage)));
}

// S4-38. API CRM публикаций K11 №213–218 и токен предпросмотра №233 (K22 §13). Защита – на сервере: права по охвату в publicationDef,
// allowedActions – только подсказка экрану и считается теми же проверками. Изменяющие – Idempotency-Key, черновики – row_version.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import type { AuditRequestMeta, Db } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { idempotencyScope, requireIdempotencyKey, runIdempotent } from '../../core/idempotency.ts';
import { can, type AccessContext, type Target } from '../../core/permissions.ts';
import { systemClock, type Clock } from '../../core/time.ts';
import { assertRole } from './media.ts';
import { entityTable, issuePreviewToken } from './preview.ts';
import { PUBLICATION_TYPES, publicationDef, type PublicationDraft, type Scope } from './publications.ts';
import { archive, createEntity, draftDto, listVersions, loadEntity, publish, rollback, saveDraft, unpublish, type EntityDef, type EntityRow, type EntityType, type Snapshot } from './versions.ts';

export interface ContentCrmDeps {
  pool: Db & { connect(): Promise<pg.PoolClient> };
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<{ access: AccessContext; meta: AuditRequestMeta }>;
  clock?: Clock;
  /** PREVIEW_SECRET. Нет – токен предпросмотра не выдаётся (№233 отвечает 404). */
  previewSecret?: string | undefined;
}

export function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value ?? {});
  if (!r.success) throw new AppError('VALIDATION_FAILED', 400, 'Неверные данные запроса', { issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  return r.data;
}

export const saveBody = z.strictObject({ rowVersion: z.number().int().min(1), draft: z.unknown() });
export const publishBody = z.strictObject({ rowVersion: z.number().int().min(1), reason: z.string().max(2000).optional() });
export const reasonBody = z.strictObject({ reason: z.string().max(2000) });
export const rollbackBody = z.strictObject({ versionId: z.string().regex(/^\d{1,18}$/), rowVersion: z.number().int().min(1), reason: z.string().max(2000) });

/** Команда CRM: вход → ключ идемпотентности → транзакция. Один разбор на все изменяющие маршруты контента. */
export function commandRunner(deps: ContentCrmDeps) {
  const clock = deps.clock ?? systemClock;
  async function inTx<T>(run: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await deps.pool.connect();
    try {
      await client.query('BEGIN');
      const r = await run(client);
      await client.query('COMMIT');
      return r;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
  return async function command(
    request: FastifyRequest,
    reply: FastifyReply,
    operation: string,
    body: unknown,
    run: (tx: pg.PoolClient, access: AccessContext, meta: AuditRequestMeta, clock: Clock) => Promise<{ status: number; body: unknown }>,
  ) {
    const { access, meta } = await deps.authenticate(request, reply);
    const key = requireIdempotencyKey(request.headers['idempotency-key']);
    const result = await inTx((tx) =>
      runIdempotent(
        tx,
        { scope: idempotencyScope('staff', access.actor.staffId, operation), key, request: { route: operation, params: request.params, body }, clock },
        () => run(tx, access, meta, clock),
      ),
    );
    if (result.replayed) reply.header('idempotent-replay', 'true');
    return reply.code(result.status).send(result.body);
  };
}

/** Маршруты действий сущности: черновик, publish, unpublish, rollback и (где есть) archive. Каждый def проверяет права сам. */
export function entityActionRoutes<D extends Record<string, unknown>>(
  app: FastifyInstance,
  deps: ContentCrmDeps,
  def: EntityDef<D>,
  prefix: string,
  rowId: (db: Db, params: unknown, access: AccessContext, meta: AuditRequestMeta, clock: Clock) => Promise<string>,
  opts: { archive?: boolean } = {},
): void {
  const command = commandRunner(deps);
  app.put(`${prefix}/draft`, async (request, reply) => {
    const body = parseInput(saveBody, request.body);
    return command(request, reply, `${def.type}.save_draft`, body, async (tx, access, meta, clock) => {
      const id = await rowId(tx, { ...(request.params as object), ...(request.query as object) }, access, meta, clock);
      const row = await saveDraft(tx, access, def, id, { rowVersion: body.rowVersion, draft: body.draft }, meta, clock);
      return { status: 200, body: draftDto(row) };
    });
  });
  app.post(`${prefix}/publish`, async (request, reply) => {
    const body = parseInput(publishBody, request.body);
    return command(request, reply, `${def.type}.publish`, body, async (tx, access, meta, clock) => {
      const id = await rowId(tx, { ...(request.params as object), ...(request.query as object) }, access, meta, clock);
      const { row, version } = await publish(tx, access, def, id, { rowVersion: body.rowVersion, reason: body.reason ?? null }, meta, clock);
      return { status: 200, body: { ...draftDto(row), versionNo: version.version_no, versionId: version.id } };
    });
  });
  app.post(`${prefix}/unpublish`, async (request, reply) => {
    const body = parseInput(reasonBody, request.body);
    return command(request, reply, `${def.type}.unpublish`, body, async (tx, access, meta, clock) => {
      const id = await rowId(tx, { ...(request.params as object), ...(request.query as object) }, access, meta, clock);
      return { status: 200, body: draftDto(await unpublish(tx, access, def, id, body, meta, clock)) };
    });
  });
  app.post(`${prefix}/rollback`, async (request, reply) => {
    const body = parseInput(rollbackBody, request.body);
    return command(request, reply, `${def.type}.rollback`, body, async (tx, access, meta, clock) => {
      const id = await rowId(tx, { ...(request.params as object), ...(request.query as object) }, access, meta, clock);
      const { row, version } = await rollback(tx, access, def, id, body, meta, clock);
      return { status: 200, body: { ...draftDto(row), versionNo: version.version_no, versionId: version.id } };
    });
  });
  if (opts.archive) {
    app.post(`${prefix}/archive`, async (request, reply) => {
      const body = parseInput(reasonBody, request.body);
      return command(request, reply, `${def.type}.archive`, body, async (tx, access, meta, clock) => {
        const id = await rowId(tx, { ...(request.params as object), ...(request.query as object) }, access, meta, clock);
        return { status: 200, body: draftDto(await archive(tx, access, def, id, body, meta, clock)) };
      });
    });
  }
}

// ---- чтение и права на просмотр

function scopeTargets(scope: Scope): Target[] {
  if (scope.type === 'city') return scope.cityIds.map((cityId) => ({ cityId }));
  if (scope.type === 'branch') return scope.branchIds.map((branchId) => ({ branchId }));
  return [];
}

/** Просмотр публикации: сетевую видят все роли контента (D4-02), локальную – если хоть одна цель охвата в зоне. Чужая – 404. */
function assertViewScope(ctx: AccessContext, scope: Scope): void {
  assertRole(ctx, 'content.view');
  const targets = scopeTargets(scope);
  if (targets.length > 0 && !targets.some((t) => can(ctx, 'content.view', t))) throw new AppError('NOT_FOUND', 404, 'Не найдено');
}

export type AllowedAction = 'edit' | 'publish' | 'unpublish' | 'archive' | 'rollback';

/** Те же условия, что проверяет сервер при команде: право по каждой цели охвата черновика и живого охвата + статус. */
export function allowedActions(ctx: AccessContext, status: EntityRow['status'], scopes: readonly Scope[]): AllowedAction[] {
  const allow = (local: string) => scopes.every((s) => (s.type === 'network' ? can(ctx, 'content.network.manage', { network: true }) : scopeTargets(s).every((t) => can(ctx, local, t))));
  const out: AllowedAction[] = [];
  if (status !== 'archived' && allow('content.draft.edit')) out.push('edit');
  if (allow('content.publish')) {
    if (status !== 'archived') out.push('publish');
    if (status === 'published') out.push('unpublish');
    if (status === 'draft' || status === 'unpublished') out.push('archive');
    if (status !== 'archived') out.push('rollback');
  }
  return out;
}

const SORTS = { updated: 'draft_updated_at', created: 'created_at' } as const;
const listQuery = z.object({
  type: z.enum(PUBLICATION_TYPES).optional(),
  status: z.enum(['draft', 'published', 'unpublished', 'archived']).optional(),
  cityId: z.uuid().optional(),
  branchId: z.uuid().optional(),
  q: z.string().max(200).optional(),
  sort: z.enum(['updated', 'created']).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

async function liveScopeOf(db: Db, id: string): Promise<Scope | null> {
  const r = await db.query<{ scope_type: Scope['type']; city_id: string | null; branch_id: string | null }>(`SELECT scope_type, city_id, branch_id FROM app.content_publication_scopes WHERE publication_id = $1`, [id]);
  const first = r.rows[0];
  if (!first) return null;
  if (first.scope_type === 'network') return { type: 'network' };
  if (first.scope_type === 'city') return { type: 'city', cityIds: r.rows.map((x) => x.city_id!) };
  return { type: 'branch', branchIds: r.rows.map((x) => x.branch_id!) };
}

const scopeOfRow = (row: EntityRow) => (row.draft as PublicationDraft).scope;

async function loadPublication(db: Db, ctx: AccessContext, id: string): Promise<{ row: EntityRow; live: Scope | null }> {
  const row = await loadEntity(db, publicationDef.table, id);
  assertViewScope(ctx, scopeOfRow(row));
  return { row, live: await liveScopeOf(db, id) };
}

const previewBody = z.strictObject({ branchId: z.uuid().optional() });
const ENTITY_TYPES = ['publication', 'game', 'room_page', 'branch_page', 'content_page', 'home_block'] as const;

/** Право просмотра сущности для токена предпросмотра: цель берётся из строки (K22 §10 «как content.view»). */
async function assertPreviewRight(db: Db, ctx: AccessContext, type: EntityType, row: EntityRow): Promise<void> {
  assertRole(ctx, 'content.preview');
  const inBranch = async (branchId: string) => {
    if (!can(ctx, 'content.preview', { branchId })) throw new AppError('NOT_FOUND', 404, 'Не найдено');
  };
  if (type === 'publication') {
    const targets = scopeTargets(scopeOfRow(row));
    if (targets.length > 0 && !targets.some((t) => can(ctx, 'content.preview', t))) throw new AppError('NOT_FOUND', 404, 'Не найдено');
  } else if (type === 'branch_page') {
    await inBranch(String(row.branch_id));
  } else if (type === 'room_page') {
    const r = await db.query<{ branch_id: string }>(`SELECT branch_id FROM app.rooms WHERE id = $1`, [row.room_id]);
    await inBranch(r.rows[0]!.branch_id);
  }
  // игры, страницы и блоки – сетевой контент: цель «роль» (D4-02)
}

export async function publicationCrmRoutes(app: FastifyInstance, deps: ContentCrmDeps): Promise<void> {
  const clock = deps.clock ?? systemClock;
  const command = commandRunner(deps);

  // №213 список: сетевые и те локальные, чей охват черновика пересекает зону сотрудника
  app.get('/content/publications', async (request, reply) => {
    const { access } = await deps.authenticate(request, reply);
    assertRole(access, 'content.view');
    const q = parseInput(listQuery, request.query);
    const params: unknown[] = [];
    const where: string[] = [];
    const add = (sql: (n: number) => string, value: unknown) => {
      params.push(value);
      where.push(sql(params.length));
    };
    if (q.type) add((n) => `type = $${n}`, q.type);
    if (q.status) add((n) => `status = $${n}`, q.status);
    if (q.cityId) add((n) => `draft->'scope'->'cityIds' ? $${n}`, q.cityId);
    if (q.branchId) add((n) => `draft->'scope'->'branchIds' ? $${n}`, q.branchId);
    if (q.q) add((n) => `draft->>'title' ILIKE $${n}`, `%${q.q.replace(/[%_\\]/g, '\\$&')}%`);
    if (!access.network) {
      params.push([...access.cityIds], [...access.branchIds]);
      where.push(`(draft->'scope'->>'type' = 'network' OR draft->'scope'->'cityIds' ?| $${params.length - 1}::text[] OR draft->'scope'->'branchIds' ?| $${params.length}::text[])`);
    }
    const column = SORTS[q.sort ?? 'updated'];
    if (q.cursor) {
      const [at, id] = Buffer.from(q.cursor, 'base64url').toString().split('|');
      if (!at || !id || !z.uuid().safeParse(id).success || Number.isNaN(Date.parse(at))) throw new AppError('VALIDATION_FAILED', 400, 'Неверный курсор', { issues: [{ path: 'cursor', message: 'неверный курсор' }] });
      params.push(at, id);
      where.push(`(${column}, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }
    const limit = q.limit ?? 50;
    params.push(limit + 1);
    const r = await deps.pool.query<EntityRow>(
      `SELECT * FROM ${publicationDef.table} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${column} DESC, id DESC LIMIT $${params.length}`,
      params,
    );
    const page = r.rows.slice(0, limit);
    const items = [];
    for (const row of page) {
      const live = row.live_version_id ? await liveScopeOf(deps.pool, row.id) : null;
      items.push({ ...draftDto(row), type: row.type, slug: row.slug, allowedActions: allowedActions(access, row.status, live ? [scopeOfRow(row), live] : [scopeOfRow(row)]) });
    }
    const last = page.at(-1);
    return { items, nextCursor: r.rows.length > limit && last ? Buffer.from(`${(last[column] as Date).toISOString()}|${last.id}`).toString('base64url') : null };
  });

  // №214 создать: право – на охват черновика
  app.post('/content/publications', async (request, reply) => {
    const body = parseInput(z.strictObject({ type: z.enum(PUBLICATION_TYPES), draft: z.unknown() }), request.body);
    return command(request, reply, 'publication.create', body, async (tx, access, meta, c) => {
      const parsed = publicationDef.schema.safeParse(body.draft);
      if (parsed.success) await publicationDef.assertEdit(tx, access, { id: '00000000-0000-4000-8000-000000000000', draft: parsed.data } as unknown as EntityRow, parsed.data);
      const row = await createEntity(tx, access, publicationDef, { type: body.type }, body.draft, meta, c);
      return { status: 201, body: { ...draftDto(row), type: row.type } };
    });
  });

  // №215 карточка: черновик, живая версия, разрешённые действия
  app.get('/content/publications/:id', async (request, reply) => {
    const { access } = await deps.authenticate(request, reply);
    const { row, live } = await loadPublication(deps.pool, access, (request.params as { id: string }).id);
    let snapshot: Snapshot | null = null;
    if (row.live_version_id) {
      const v = await deps.pool.query<{ snapshot: Snapshot }>(`SELECT snapshot FROM journal.content_versions WHERE id = $1`, [row.live_version_id]);
      snapshot = v.rows[0]?.snapshot ?? null;
    }
    return { ...draftDto(row), type: row.type, slug: row.slug, live: snapshot, allowedActions: allowedActions(access, row.status, live ? [scopeOfRow(row), live] : [scopeOfRow(row)]) };
  });

  // №216–217 черновик и действия: права по охвату – в publicationDef
  entityActionRoutes(app, deps, publicationDef, '/content/publications/:id', async (_db, params) => (params as { id: string }).id, { archive: true });

  // №218 версии
  app.get('/content/publications/:id/versions', async (request, reply) => {
    const { access } = await deps.authenticate(request, reply);
    const { row } = await loadPublication(deps.pool, access, (request.params as { id: string }).id);
    return { items: await listVersions(deps.pool, 'publication', row.id) };
  });

  // №233 токен предпросмотра. Без PREVIEW_SECRET предпросмотра нет – как нет страницы.
  app.post('/content/:entityType/:id/preview-token', async (request, reply) => {
    const { access } = await deps.authenticate(request, reply);
    const secret = deps.previewSecret;
    const p = request.params as { entityType: string; id: string };
    const type = ENTITY_TYPES.find((t) => t === p.entityType);
    if (!secret || !type) throw new AppError('NOT_FOUND', 404, 'Не найдено');
    const body = parseInput(previewBody, request.body);
    const row = await loadEntity(deps.pool, entityTable(type), p.id);
    await assertPreviewRight(deps.pool, access, type, row);
    if (body.branchId && !can(access, 'content.preview', { branchId: body.branchId })) throw new AppError('NOT_FOUND', 404, 'Не найдено');
    const token = issuePreviewToken(secret, { entityType: type, entityId: row.id, draftRowVersion: row.row_version, staffId: access.actor.staffId, ...(body.branchId ? { branchId: body.branchId } : {}) }, clock.now());
    return reply.code(201).send({ token, previewPath: `/content/preview/${token}` });
  });
}

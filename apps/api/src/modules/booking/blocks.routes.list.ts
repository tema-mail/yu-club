// K11 №13–14 (дополнение): список блокировок филиала для CRM – найти и снять старую блокировку.
// Только чтение; создание и снятие – blocks.ts. Права: schedule.view по зоне (вне зоны – 404 как у
// несуществующего); отказ роли без schedule.view – 403. Фильтры: статус, период (пересечение), ресурс, комната.
// Порядок фиксирован: начало блокировки, id. Курсор – base64url(JSON [start, id]) по zod-схеме, мусор – 400.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuditRequestMeta, Db } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { can, roleAllows, type AccessContext } from '../../core/permissions.ts';

export interface BlockListDeps {
  pool: Db;
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<{ access: AccessContext; meta: AuditRequestMeta }>;
}

export interface BlockListItem {
  id: string;
  branchId: string;
  targetType: 'unit' | 'resource' | 'room' | 'resources';
  targetIds: string[];
  start: string;
  end: string;
  reasonId: string;
  reasonName: string;
  comment: string | null;
  status: 'active' | 'lifted';
  createdBy: string;
  createdAt: string;
  liftedAt: string | null;
  liftedBy: string | null;
  liftComment: string | null;
  rowVersion: number;
}

const query = z.object({
  status: z.enum(['active', 'lifted', 'all']).default('active'),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  resourceId: z.uuid().optional(),
  roomId: z.uuid().optional(),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const CURSOR = z.tuple([z.iso.datetime({ offset: true }), z.uuid()]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function bad(issues: unknown): AppError {
  return new AppError('VALIDATION_FAILED', 400, 'Неверные данные запроса', { issues });
}

function decodeCursor(s: string | undefined): [string, string] | null {
  if (s === undefined) return null;
  let v: unknown;
  try {
    v = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
  } catch {
    v = undefined;
  }
  const r = CURSOR.safeParse(v);
  if (!r.success) throw bad([{ path: 'cursor', message: 'Неверный курсор' }]);
  return r.data;
}

const SELECT = `SELECT b.id, b.branch_id AS "branchId", b.target_type AS "targetType", b.target_ids AS "targetIds",
    lower(b.period) AS start, upper(b.period) AS "end", b.reason_id AS "reasonId", r.name AS "reasonName", b.comment, b.status,
    b.created_by AS "createdBy", b.created_at AS "createdAt", b.lifted_at AS "liftedAt", b.lifted_by AS "liftedBy",
    b.lift_comment AS "liftComment", b.row_version AS "rowVersion"
  FROM app.resource_blocks b JOIN app.dict_reasons r ON r.id = b.reason_id`;

type Row = Omit<BlockListItem, 'start' | 'end' | 'createdAt' | 'liftedAt'> & { start: Date; end: Date; createdAt: Date; liftedAt: Date | null };

export async function listBlocks(db: Db, ctx: AccessContext, branchId: string, raw: unknown): Promise<{ items: BlockListItem[]; nextCursor: string | null }> {
  if (!UUID_RE.test(branchId) || !can(ctx, 'schedule.view', { branchId })) {
    if (!roleAllows(ctx.role, 'schedule.view')) throw new AppError('FORBIDDEN', 403, 'Недостаточно прав', { action: 'schedule.view' });
    throw new AppError('NOT_FOUND', 404, 'Не найдено');
  }
  const exists = await db.query('SELECT 1 FROM app.branches WHERE id = $1', [branchId]);
  if (exists.rowCount !== 1) throw new AppError('NOT_FOUND', 404, 'Не найдено');
  const p = query.safeParse(raw ?? {});
  if (!p.success) throw bad(p.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  const q = p.data;
  if (q.from && q.to && new Date(q.from) >= new Date(q.to)) throw bad([{ path: 'to', message: 'to позже from' }]);

  const params: unknown[] = [branchId];
  const where = ['b.branch_id = $1'];
  const add = (v: unknown) => `$${params.push(v)}`;
  if (q.status !== 'all') where.push(`b.status = ${add(q.status)}`);
  if (q.from || q.to) where.push(`b.period && tstzrange(${add(q.from ?? null)}::timestamptz, ${add(q.to ?? null)}::timestamptz, '[)')`);
  if (q.resourceId) {
    const id = add(q.resourceId);
    // прямо по цели или по общим единицам занятости (комната целиком, составной ресурс – K6)
    where.push(`(${id}::uuid = ANY(b.target_ids) OR EXISTS (
      SELECT 1 FROM app.resource_block_units bu JOIN app.resource_units ru ON ru.unit_id = bu.unit_id
      WHERE bu.block_id = b.id AND ru.resource_id = ${id}::uuid))`);
  }
  if (q.roomId) {
    const id = add(q.roomId);
    where.push(`(${id}::uuid = ANY(b.target_ids) OR EXISTS (
      SELECT 1 FROM app.resource_block_units bu JOIN app.occupancy_units ou ON ou.id = bu.unit_id
      WHERE bu.block_id = b.id AND ou.room_id = ${id}::uuid))`);
  }
  const c = decodeCursor(q.cursor);
  if (c) where.push(`(lower(b.period), b.id) > (${add(c[0])}::timestamptz, ${add(c[1])}::uuid)`);
  const lim = add(q.limit + 1);
  const r = await db.query<Row>(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY lower(b.period), b.id LIMIT ${lim}`, params);
  const rows = r.rows.slice(0, q.limit);
  const last = rows.at(-1);
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  return {
    items: rows.map((x) => ({ ...x, start: x.start.toISOString(), end: x.end.toISOString(), createdAt: x.createdAt.toISOString(), liftedAt: iso(x.liftedAt) })),
    nextCursor: r.rows.length > q.limit && last ? Buffer.from(JSON.stringify([last.start.toISOString(), last.id])).toString('base64url') : null,
  };
}

export async function blockListRoutes(app: FastifyInstance, deps: BlockListDeps): Promise<void> {
  app.get('/branches/:branchId/blocks', async (request, reply) => {
    const { access } = await deps.authenticate(request, reply);
    reply.header('cache-control', 'no-store');
    return listBlocks(deps.pool, access, (request.params as { branchId: string }).branchId, request.query);
  });
}

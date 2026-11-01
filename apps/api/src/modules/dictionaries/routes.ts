// S0-13. Справочники: типы ресурсов и помещений, системные статусы, причины (15 §16, 02 §7.1, §8.2).
// Права: чтение – любой сотрудник (network.view), изменение – только Владелец (K1 dictionary.manage, цель – сеть).
// Системный код нельзя удалить и переименовать; пользовательское значение – только архив (15 §3.5).
// Защиту держит и база (0010: права столбцов + триггер dict_protect_system), здесь – понятные ошибки и аудит.
// Модуль staff не импортируется: вход сотрудника (authenticate) передаёт server.ts (ADR 0002 п.2).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { diffFields, writeAudit, type AuditRequestMeta, type Db } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { assertCanAudited, roleAllows, type AccessContext } from '../../core/permissions.ts';
import { systemClock, type Clock } from '../../core/time.ts';

export interface DictionaryDeps {
  pool: Db & { connect(): Promise<pg.PoolClient> };
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<{ access: AccessContext; meta: AuditRequestMeta }>;
  clock?: Clock;
}

type Kind = 'resource-types' | 'space-types' | 'statuses' | 'reasons';

interface Spec {
  table: string;
  /** api-поле → столбец; только то, что разрешено менять */
  editable: Record<string, string>;
  select: string;
  order: string;
  archivable: boolean;
}

const SPECS: Record<Kind, Spec> = {
  'resource-types': {
    table: 'app.dict_resource_types',
    editable: { name: 'name', stepMinutes: 'step_minutes', bookable: 'bookable', sortOrder: 'sort_order' },
    select: `code, name, step_minutes AS "stepMinutes", bookable, is_system AS "isSystem", archived_at AS "archivedAt", sort_order AS "sortOrder"`,
    order: 'sort_order, code',
    archivable: false,
  },
  'space-types': {
    table: 'app.dict_space_types',
    editable: { name: 'name', sortOrder: 'sort_order' },
    select: `code, name, is_system AS "isSystem", archived_at AS "archivedAt", sort_order AS "sortOrder"`,
    order: 'sort_order, code',
    archivable: true,
  },
  statuses: {
    table: 'app.dict_statuses',
    editable: { name: 'name' },
    select: `domain, code, name, true AS "isSystem"`,
    order: 'domain, code',
    archivable: false,
  },
  reasons: {
    table: 'app.dict_reasons',
    editable: { name: 'name', requiresComment: 'requires_comment', sortOrder: 'sort_order' },
    select: `id, domain, code, name, is_system AS "isSystem", requires_comment AS "requiresComment",
             archived_at AS "archivedAt", sort_order AS "sortOrder"`,
    order: 'domain, sort_order, code',
    archivable: true,
  },
};

const REASON_DOMAINS = [
  'booking_cancel_club',
  'booking_cancel_client',
  'no_show',
  'visit_correction',
  'resource_block',
  'ledger_correction',
] as const;
const CODE = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);
const NAME = z.string().trim().min(1).max(200);
const SORT = z.number().int().min(-1_000_000).max(1_000_000);

const patchSchemas: Record<Kind, z.ZodType<Record<string, unknown>>> = {
  'resource-types': z.object({
    code: z.string().optional(),
    name: NAME.optional(),
    stepMinutes: z.number().int().min(1).max(1440).refine((v) => 1440 % v === 0, 'шаг делит сутки').optional(),
    bookable: z.boolean().optional(),
    sortOrder: SORT.optional(),
  }),
  'space-types': z.object({ code: z.string().optional(), name: NAME.optional(), sortOrder: SORT.optional() }),
  statuses: z.object({ code: z.string().optional(), name: NAME.optional() }),
  reasons: z.object({
    code: z.string().optional(),
    name: NAME.optional(),
    requiresComment: z.boolean().optional(),
    sortOrder: SORT.optional(),
  }),
};
const createSpaceType = z.object({ code: CODE, name: NAME, sortOrder: SORT.optional() });
const createReason = z.object({
  domain: z.enum(REASON_DOMAINS),
  code: CODE,
  name: NAME,
  requiresComment: z.boolean().optional(),
  sortOrder: SORT.optional(),
});
const listQuery = z.object({ domain: z.string().max(64).optional(), includeArchived: z.enum(['true', 'false']).optional() });

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
const systemImmutable = () =>
  new AppError('DICTIONARY_SYSTEM_IMMUTABLE', 409, 'Системное значение: код нельзя изменить, значение нельзя удалить или архивировать');

/** Ключ строки по пути: code | domain+code | id. */
function keyOf(kind: Kind, params: Record<string, string>): { where: string; values: string[]; ref: string } {
  if (kind === 'statuses') {
    const p = parse(z.object({ domain: z.string().max(64), code: z.string().max(64) }), params);
    return { where: 'domain = $1 AND code = $2', values: [p.domain, p.code], ref: `${p.domain}:${p.code}` };
  }
  if (kind === 'reasons') {
    const p = parse(z.object({ id: z.uuid() }), params);
    return { where: 'id = $1', values: [p.id], ref: p.id };
  }
  const p = parse(z.object({ code: z.string().max(64) }), params);
  return { where: 'code = $1', values: [p.code], ref: p.code };
}

/** Ошибки базы → коды модуля (триггер dict_protect_system, уникальность кода). */
function mapDbError(err: unknown): never {
  const e = err as { code?: string; message?: string };
  if (e.code === '23505') throw new AppError('DICTIONARY_CODE_TAKEN', 409, 'Такой код уже есть');
  if (e.code === 'P0001' && e.message?.startsWith('dict_no_delete')) {
    throw new AppError('DICTIONARY_ARCHIVE_ONLY', 409, 'Значение не удаляется – только архив');
  }
  if (e.code === 'P0001' && e.message?.startsWith('dict_')) throw systemImmutable();
  throw err;
}

async function withTx<T>(deps: DictionaryDeps, fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await deps.pool.connect();
  try {
    await client.query('BEGIN');
    const r = await fn(client);
    await client.query('COMMIT');
    return r;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    return mapDbError(err);
  } finally {
    client.release();
  }
}

export async function dictionaryRoutes(app: FastifyInstance, deps: DictionaryDeps): Promise<void> {
  const clock = deps.clock ?? systemClock;

  /** Только Владелец; отказ – в аудит (ADR 0005 п.8). */
  async function owner(request: FastifyRequest, reply: FastifyReply, ref: string) {
    const { access, meta } = await deps.authenticate(request, reply);
    await assertCanAudited(deps.pool, meta, access, 'dictionary.manage', { network: true }, {
      action: 'dictionary.changed',
      object: { type: 'dictionary', id: ref },
    });
    return meta;
  }

  async function audit(tx: Db, meta: AuditRequestMeta, ref: string, before: Record<string, unknown>, after: Record<string, unknown>, reason: string) {
    const d = diffFields(before, after);
    await writeAudit(tx, meta, { action: 'dictionary.changed', object: { type: 'dictionary', id: ref }, ...d, reason }, clock);
  }

  for (const kind of Object.keys(SPECS) as Kind[]) {
    const spec = SPECS[kind];
    const path = kind === 'statuses' ? `/${kind}/:domain/:code` : kind === 'reasons' ? `/${kind}/:id` : `/${kind}/:code`;

    app.get(`/${kind}`, async (request, reply) => {
      const { access } = await deps.authenticate(request, reply);
      if (!roleAllows(access.role, 'network.view')) throw new AppError('FORBIDDEN', 403, 'Недостаточно прав');
      const q = parse(listQuery, request.query);
      const where: string[] = [];
      const values: unknown[] = [];
      if (q.domain !== undefined && (kind === 'statuses' || kind === 'reasons')) {
        values.push(q.domain);
        where.push(`domain = $${values.length}`);
      }
      if (spec.archivable && q.includeArchived !== 'true') where.push('archived_at IS NULL');
      const sql = `SELECT ${spec.select} FROM ${spec.table}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ${spec.order}`;
      const r = await deps.pool.query(sql, values);
      const items = r.rows;
      if (kind === 'statuses') {
        const t = await deps.pool.query<{ domain: string; from_code: string; to_code: string }>(
          'SELECT domain, from_code, to_code FROM app.dict_status_transitions ORDER BY 1, 2, 3',
        );
        return { items, transitions: t.rows.map((x) => ({ domain: x.domain, from: x.from_code, to: x.to_code })) };
      }
      return { items };
    });

    app.patch(path, async (request, reply) => {
      const key = keyOf(kind, request.params as Record<string, string>);
      const meta = await owner(request, reply, `${spec.table}:${key.ref}`);
      const body = parse(patchSchemas[kind], request.body);
      return withTx(deps, async (tx) => {
        const cur = await tx.query(`SELECT ${spec.select} FROM ${spec.table} WHERE ${key.where} FOR UPDATE`, key.values);
        const row = cur.rows[0] as Record<string, unknown> | undefined;
        if (!row) throw notFound();
        if (body.code !== undefined && body.code !== row.code) {
          if (row.isSystem) throw systemImmutable();
          throw new AppError('VALIDATION_FAILED', 400, 'Код значения неизменен – создайте новое, старое – в архив');
        }
        const sets: string[] = [];
        const values: unknown[] = [...key.values];
        for (const [field, column] of Object.entries(spec.editable)) {
          if (body[field] === undefined) continue;
          values.push(body[field]);
          sets.push(`${column} = $${values.length}`);
        }
        if (sets.length === 0) return row;
        const upd = await tx.query(`UPDATE ${spec.table} SET ${sets.join(', ')} WHERE ${key.where} RETURNING ${spec.select}`, values);
        const next = upd.rows[0] as Record<string, unknown>;
        await audit(tx, meta, `${spec.table}:${key.ref}`, row, next, 'update');
        return next;
      });
    });

    app.delete(path, async (request, reply) => {
      const key = keyOf(kind, request.params as Record<string, string>);
      await owner(request, reply, `${spec.table}:${key.ref}`);
      const cur = await deps.pool.query(`SELECT ${spec.select} FROM ${spec.table} WHERE ${key.where}`, key.values);
      const row = cur.rows[0] as Record<string, unknown> | undefined;
      if (!row) throw notFound();
      if (row.isSystem) throw systemImmutable();
      throw new AppError('DICTIONARY_ARCHIVE_ONLY', 409, 'Значение не удаляется – только архив');
    });

    if (!spec.archivable) continue;
    for (const op of ['archive', 'restore'] as const) {
      app.post(`${path}/${op}`, async (request, reply) => {
        const key = keyOf(kind, request.params as Record<string, string>);
        const meta = await owner(request, reply, `${spec.table}:${key.ref}`);
        return withTx(deps, async (tx) => {
          const cur = await tx.query(`SELECT ${spec.select} FROM ${spec.table} WHERE ${key.where} FOR UPDATE`, key.values);
          const row = cur.rows[0] as Record<string, unknown> | undefined;
          if (!row) throw notFound();
          if (row.isSystem) throw systemImmutable();
          const value = op === 'archive' ? (row.archivedAt ?? clock.now()) : null;
          const upd = await tx.query(
            `UPDATE ${spec.table} SET archived_at = $${key.values.length + 1} WHERE ${key.where} RETURNING ${spec.select}`,
            [...key.values, value],
          );
          const next = upd.rows[0] as Record<string, unknown>;
          if (JSON.stringify(row.archivedAt) !== JSON.stringify(next.archivedAt)) {
            await audit(tx, meta, `${spec.table}:${key.ref}`, row, next, op);
          }
          return next;
        });
      });
    }
  }

  app.post('/space-types', async (request, reply) => {
    const body = parse(createSpaceType, request.body);
    const meta = await owner(request, reply, `app.dict_space_types:${body.code}`);
    return reply.code(201).send(
      await withTx(deps, async (tx) => {
        const r = await tx.query(
          `INSERT INTO app.dict_space_types (code, name, sort_order) VALUES ($1, $2, $3) RETURNING ${SPECS['space-types'].select}`,
          [body.code, body.name, body.sortOrder ?? 0],
        );
        await audit(tx, meta, `app.dict_space_types:${body.code}`, {}, r.rows[0], 'create');
        return r.rows[0];
      }),
    );
  });

  app.post('/reasons', async (request, reply) => {
    const body = parse(createReason, request.body);
    const meta = await owner(request, reply, `app.dict_reasons:${body.domain}:${body.code}`);
    return reply.code(201).send(
      await withTx(deps, async (tx) => {
        const r = await tx.query(
          `INSERT INTO app.dict_reasons (domain, code, name, requires_comment, sort_order) VALUES ($1, $2, $3, $4, $5)
           RETURNING ${SPECS.reasons.select}`,
          [body.domain, body.code, body.name, body.requiresComment ?? false, body.sortOrder ?? 0],
        );
        const row = r.rows[0] as { id: string };
        await audit(tx, meta, `app.dict_reasons:${row.id}`, {}, row as Record<string, unknown>, 'create');
        return row;
      }),
    );
  });
}

// S4-31. API медиатеки CRM (K11 №224–227, K22 §8, §13): загрузка multipart/form-data с лимитом части 10 МБ, список, alt и подпись,
// архив, связи, физическое удаление неиспользованного (только Владелец). Цель прав – «роль» (D4-02). Ответы – без пути на диске.
import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { writeAudit, type AuditRequestMeta, type Db } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import type { FileStore } from '../../core/files.ts';
import { idempotencyScope, requireIdempotencyKey, runIdempotent } from '../../core/idempotency.ts';
import type { AccessContext } from '../../core/permissions.ts';
import { systemClock, type Clock } from '../../core/time.ts';
import { archiveMedia, assertRole, getMediaRow, listMedia, MEDIA_MAX_BYTES, mediaDto, mediaUsages, updateMedia, uploadMedia, type MediaPurpose } from './media.ts';
import { purgeMedia } from './media-purge.ts';
import { mediaInVersions } from './versions.ts';

export interface MediaRoutesDeps {
  pool: Db & { connect(): Promise<pg.PoolClient> };
  store: FileStore;
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<{ access: AccessContext; meta: AuditRequestMeta }>;
  clock?: Clock;
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value ?? {});
  if (!r.success) {
    throw new AppError('VALIDATION_FAILED', 400, 'Неверные данные запроса', { issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  }
  return r.data;
}

const listQuery = z.object({
  q: z.string().max(200).optional(),
  type: z.enum(['image', 'document']).optional(),
  archived: z.enum(['true', 'false']).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
const patchBody = z.strictObject({ alt: z.string().max(500).nullable().optional(), title: z.string().max(200).nullable().optional(), rowVersion: z.number().int().min(1) });
const purgeBody = z.strictObject({ reason: z.string().max(2000).optional(), basis: z.string().max(2000).optional() });

/** Физическое удаление (K11 №227, K22 §8): только если файл нигде не используется и не упомянут ни в одной версии. */
async function deleteUnused(tx: Db, ctx: AccessContext, id: string, meta: AuditRequestMeta, clock: Clock): Promise<string[]> {
  assertRole(ctx, 'content.media.purge');
  const row = await getMediaRow(tx, id);
  // Очищенная строка держит sha256 – запрет повторной загрузки (S4-45): обычным удалением её не снять.
  if (!row || row.status === 'purged') throw new AppError('NOT_FOUND', 404, 'Не найдено');
  await tx.query(`SELECT 1 FROM app.content_media WHERE id = $1 FOR UPDATE`, [id]);
  const usages = await mediaUsages(tx, id);
  if (usages.length > 0) throw new AppError('MEDIA_IN_USE', 409, 'Файл используется', { usages });
  if (await mediaInVersions(tx, id)) throw new AppError('MEDIA_IN_USE', 409, 'Файл есть в опубликованных версиях', { usages: [], inVersions: true });
  await tx.query(`DELETE FROM app.content_media WHERE id = $1`, [id]);
  await writeAudit(tx, meta, { action: 'media.deleted', object: { type: 'media', id }, before: { mime: row.mime, bytes: Number(row.bytes) } }, clock);
  return [row.storage_key, ...row.variants.map((v) => v.key)];
}

export async function mediaRoutes(app: FastifyInstance, deps: MediaRoutesDeps): Promise<void> {
  const clock = deps.clock ?? systemClock;
  await app.register(multipart, { limits: { fileSize: MEDIA_MAX_BYTES, files: 1, fields: 8, fieldSize: 2000, parts: 10 } });

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

  // №224 загрузка: multipart – файл и поля purpose, alt, title. Больше 10 МБ – MEDIA_TOO_LARGE, не общий отказ.
  app.post('/content/media', async (request, reply) => {
    const { access, meta } = await deps.authenticate(request, reply);
    assertRole(access, 'content.media.upload'); // право – до чтения тела
    const key = requireIdempotencyKey(request.headers['idempotency-key']);
    if (!request.isMultipart()) throw new AppError('VALIDATION_FAILED', 400, 'Нужен multipart/form-data', { issues: [{ path: 'body', message: 'нужен файл' }] });
    let content: Buffer | null = null;
    let originalName: string | null = null;
    const fields: Record<string, string> = {};
    try {
      for await (const part of request.parts()) {
        if (part.type === 'file') {
          if (content !== null) throw new AppError('VALIDATION_FAILED', 400, 'Только один файл', { issues: [{ path: 'file', message: 'только один файл' }] });
          content = await part.toBuffer();
          originalName = part.filename ?? null;
        } else if (typeof part.value === 'string') {
          fields[part.fieldname] = part.value;
        }
      }
    } catch (err) {
      if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') throw new AppError('MEDIA_TOO_LARGE', 413, 'Можно загрузить JPG, PNG или WebP до 10 МБ', { maxBytes: MEDIA_MAX_BYTES });
      throw err;
    }
    if (content === null || content.length === 0) throw new AppError('VALIDATION_FAILED', 400, 'Пустой файл', { issues: [{ path: 'file', message: 'нужен файл' }] });
    const form = parse(z.object({ purpose: z.enum(['image', 'document']).default('image'), alt: z.string().max(500).optional(), title: z.string().max(200).optional() }), fields);
    const body = content;
    const sha256 = createHash('sha256').update(body).digest('hex');
    const result = await inTx((tx) =>
      runIdempotent(
        tx,
        { scope: idempotencyScope('staff', access.actor.staffId, 'media.upload'), key, request: { route: 'POST /content/media', body: { sha256, size: body.length, ...form } }, clock },
        async () => {
          const r = await uploadMedia(tx, access, deps.store, { content: body, purpose: form.purpose as MediaPurpose, originalName, alt: form.alt ?? null, title: form.title ?? null }, meta, clock);
          return { status: r.duplicate ? 200 : 201, body: { media: r.media, duplicate: r.duplicate } };
        },
      ),
    );
    if (result.replayed) reply.header('idempotent-replay', 'true');
    return reply.code(result.status).send(result.body);
  });

  // №224 список
  app.get('/content/media', async (request, reply) => {
    const { access } = await deps.authenticate(request, reply);
    assertRole(access, 'content.view');
    const q = parse(listQuery, request.query);
    return listMedia(deps.pool, {
      ...(q.q ? { q: q.q } : {}),
      ...(q.type ? { type: q.type } : {}),
      archived: q.archived === 'true',
      ...(q.cursor ? { cursor: q.cursor } : {}),
      ...(q.limit ? { limit: q.limit } : {}),
    });
  });

  // одна запись – для карточки в CRM
  app.get('/content/media/:id', async (request, reply) => {
    const { access } = await deps.authenticate(request, reply);
    assertRole(access, 'content.view');
    const row = await getMediaRow(deps.pool, (request.params as { id: string }).id);
    if (!row || row.status === 'purged') throw new AppError('NOT_FOUND', 404, 'Не найдено');
    return mediaDto(row);
  });

  // №225 alt и подпись
  app.patch('/content/media/:id', async (request, reply) => {
    const { access, meta } = await deps.authenticate(request, reply);
    const key = requireIdempotencyKey(request.headers['idempotency-key']);
    const id = (request.params as { id: string }).id;
    const body = parse(patchBody, request.body);
    const result = await inTx((tx) =>
      runIdempotent(
        tx,
        { scope: idempotencyScope('staff', access.actor.staffId, 'media.update'), key, request: { route: 'PATCH /content/media/:id', params: { id }, body }, clock },
        async () => ({
          status: 200,
          body: await updateMedia(tx, access, id, { rowVersion: body.rowVersion, ...(body.alt !== undefined ? { alt: body.alt } : {}), ...(body.title !== undefined ? { title: body.title } : {}) }, meta, clock),
        }),
      ),
    );
    if (result.replayed) reply.header('idempotent-replay', 'true');
    return reply.code(result.status).send(result.body);
  });

  // №225 архив
  app.post('/content/media/:id/archive', async (request, reply) => {
    const { access, meta } = await deps.authenticate(request, reply);
    const key = requireIdempotencyKey(request.headers['idempotency-key']);
    const id = (request.params as { id: string }).id;
    const result = await inTx((tx) =>
      runIdempotent(tx, { scope: idempotencyScope('staff', access.actor.staffId, 'media.archive'), key, request: { route: 'POST /content/media/:id/archive', params: { id } }, clock }, async () => ({
        status: 200,
        body: await archiveMedia(tx, access, id, meta, clock),
      })),
    );
    if (result.replayed) reply.header('idempotent-replay', 'true');
    return reply.code(result.status).send(result.body);
  });

  // №226 связи
  app.get('/content/media/:id/usages', async (request, reply) => {
    const { access } = await deps.authenticate(request, reply);
    assertRole(access, 'content.view');
    const row = await getMediaRow(deps.pool, (request.params as { id: string }).id);
    if (!row) throw new AppError('NOT_FOUND', 404, 'Не найдено');
    return { usages: await mediaUsages(deps.pool, row.id), inVersions: await mediaInVersions(deps.pool, row.id) };
  });

  // №227 физическое удаление неиспользованного. Файлы – после фиксации транзакции: сбой оставит «сироту», её уберёт content:media-gc.
  app.delete('/content/media/:id', async (request, reply) => {
    const { access, meta } = await deps.authenticate(request, reply);
    const key = requireIdempotencyKey(request.headers['idempotency-key']);
    const id = (request.params as { id: string }).id;
    let files: string[] = [];
    const result = await inTx((tx) =>
      runIdempotent(tx, { scope: idempotencyScope('staff', access.actor.staffId, 'media.delete'), key, request: { route: 'DELETE /content/media/:id', params: { id } }, clock }, async () => {
        files = await deleteUnused(tx, access, id, meta, clock);
        return { status: 200, body: { deleted: true } };
      }),
    );
    for (const f of files) await deps.store.remove(f);
    if (result.replayed) reply.header('idempotent-replay', 'true');
    return reply.code(result.status).send(result.body);
  });

  // S4-45: принудительная очистка по требованию субъекта (ГК ст. 152.1). Файлы всех вариантов – даже при использовании в версиях; стираются после фиксации.
  app.post('/content/media/:id/purge', async (request, reply) => {
    const { access, meta } = await deps.authenticate(request, reply);
    const key = requireIdempotencyKey(request.headers['idempotency-key']);
    const id = (request.params as { id: string }).id;
    const body = parse(purgeBody, request.body);
    let files: string[] = [];
    const result = await inTx((tx) =>
      runIdempotent(tx, { scope: idempotencyScope('staff', access.actor.staffId, 'media.purge'), key, request: { route: 'POST /content/media/:id/purge', params: { id }, body }, clock }, async () => {
        const r = await purgeMedia(tx, access, id, { reason: body.reason ?? '', basis: body.basis ?? '' }, meta, clock);
        files = r.files;
        return { status: 200, body: { purged: true, affected: r.affected } };
      }),
    );
    for (const f of files) await deps.store.remove(f);
    if (result.replayed) reply.header('idempotent-replay', 'true');
    return reply.code(result.status).send(result.body);
  });
}

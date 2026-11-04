// S3-07. K19 №350: вложения по HTTP на /api/crm/v1 – загрузка телом запроса, список версий, выдача файла,
// «недействителен». Тонкий слой над core/files.ts (ADR 0002 п.7): право – у объекта-владельца (registerAttachmentOwner),
// чужой объект и несуществующее вложение – одинаковый 404 (IDOR). Без новой зависимости: тело файла – парсер
// application/octet-stream и типов изображений/PDF (и любого другого типа – чтобы чужой тип получил понятный 415 от
// проверки сигнатуры, а не 400 Fastify). Выдача – только как скачивание: Content-Disposition: attachment,
// X-Content-Type-Options: nosniff, Cache-Control: private, no-store. Каталог вложений Caddy не раздаёт (S3-94).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import type { AuditRequestMeta, Db } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { addAttachment, DOC_TYPES, getAttachment, invalidateAttachment, listAttachments, type FileStore } from '../../core/files.ts';
import { idempotencyScope, requireIdempotencyKey, runIdempotent } from '../../core/idempotency.ts';
import type { AccessContext } from '../../core/permissions.ts';
import { systemClock, type Clock } from '../../core/time.ts';

export interface AttachmentCrmDeps {
  pool: Db & { connect(): Promise<pg.PoolClient> };
  store: FileStore;
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<{ access: AccessContext; meta: AuditRequestMeta }>;
  clock?: Clock;
}

/** Предел тела – верхняя граница настройки attachments.max_bytes (K7) + 1 байт: настоящий лимит проверяет files.ts и
 *  отвечает ATTACHMENT_TOO_LARGE, а не общим отказом Fastify. */
export const ATTACHMENT_BODY_LIMIT = 52_428_800 + 1;
const FILE_TYPES = ['application/octet-stream', 'image/jpeg', 'image/png', 'application/pdf', 'image/webp', 'image/gif'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value ?? {});
  if (!r.success) {
    throw new AppError('VALIDATION_FAILED', 400, 'Неверные данные запроса', { issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  }
  return r.data;
}

const OWNER = { ownerType: z.string().regex(/^[a-z][a-z_]{1,30}$/), ownerId: z.string().regex(UUID_RE) };
const uploadQuery = z.object({
  ...OWNER,
  docType: z.enum(DOC_TYPES),
  name: z.string().max(1000).optional(),
  comment: z.string().max(2000).optional(),
  supersedes: z.string().regex(UUID_RE).optional(),
});
const listQuery = z.object(OWNER);
const invalidateBody = z.object({ reason: z.string().max(2000) });

/** filename* по RFC 5987 + ASCII-запасной вариант без кавычек и управляющих символов. */
function contentDisposition(name: string | null, fallback: string): string {
  const base = name ?? fallback;
  const ascii = base.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(base)}`;
}

export async function attachmentCrmRoutes(app: FastifyInstance, deps: AttachmentCrmDeps): Promise<void> {
  const clock = deps.clock ?? systemClock;

  // Тело файла – Buffer только в этом плагине (scope Fastify); JSON у «недействителен» разбирает встроенный парсер.
  app.addContentTypeParser(FILE_TYPES, { parseAs: 'buffer', bodyLimit: ATTACHMENT_BODY_LIMIT }, (_req, body, done) => done(null, body));
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: ATTACHMENT_BODY_LIMIT }, (_req, body, done) => done(null, body));

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

  // №350 загрузка: ?ownerType=&ownerId=&docType=&name=&comment=&supersedes=, тело – файл
  app.post('/attachments', async (request, reply) => {
    const { access, meta } = await deps.authenticate(request, reply);
    const key = requireIdempotencyKey(request.headers['idempotency-key']);
    const q = parse(uploadQuery, request.query);
    const body = request.body;
    if (!Buffer.isBuffer(body) || body.length === 0) throw new AppError('VALIDATION_FAILED', 400, 'Пустой файл', { issues: [{ path: 'body', message: 'нужен файл' }] });
    const sha256 = createHash('sha256').update(body).digest('hex');
    const result = await inTx((tx) =>
      runIdempotent(
        tx,
        {
          scope: idempotencyScope('staff', access.actor.staffId, 'attachment.add'),
          key,
          // хэш запроса – по содержимому файла, а не по самим байтам (тело в idempotency_keys не хранится)
          request: { route: 'POST /attachments', params: q, body: { sha256, size: body.length } },
          clock,
        },
        async () => {
          const attachment = await addAttachment(
            tx,
            access,
            deps.store,
            {
              ownerType: q.ownerType,
              ownerId: q.ownerId,
              docType: q.docType,
              content: body,
              declaredType: request.headers['content-type'] ?? null,
              originalName: q.name ?? null,
              comment: q.comment ?? null,
              supersedes: q.supersedes ?? null,
            },
            meta,
            clock,
          );
          return { status: 201, body: { attachmentId: attachment.id, attachment } };
        },
      ),
    );
    if (result.replayed) reply.header('idempotent-replay', 'true');
    return reply.code(result.status).send(result.body);
  });

  // список версий объекта
  app.get('/attachments', async (request, reply) => {
    const { access } = await deps.authenticate(request, reply);
    const q = parse(listQuery, request.query);
    return { items: await listAttachments(deps.pool, access, q.ownerType, q.ownerId) };
  });

  // №350 выдача файла – только через API и только скачиванием
  app.get('/attachments/:id', async (request, reply) => {
    const { access } = await deps.authenticate(request, reply);
    const { attachment, storageKey } = await getAttachment(deps.pool, access, (request.params as { id: string }).id);
    if (!(await deps.store.exists(storageKey))) throw new AppError('NOT_FOUND', 404, 'Не найдено');
    void reply
      .header('content-type', attachment.mimeType)
      .header('content-length', String(attachment.sizeBytes))
      .header('content-disposition', contentDisposition(attachment.originalName, `${attachment.id}`))
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, no-store')
      .header('content-security-policy', "default-src 'none'; sandbox");
    return reply.send(deps.store.openRead(storageKey));
  });

  // №350 «недействителен» с причиной (10 §11)
  app.post('/attachments/:id/invalidate', async (request, reply) => {
    const { access, meta } = await deps.authenticate(request, reply);
    const key = requireIdempotencyKey(request.headers['idempotency-key']);
    const id = (request.params as { id: string }).id;
    const body = parse(invalidateBody, request.body);
    const result = await inTx((tx) =>
      runIdempotent(
        tx,
        { scope: idempotencyScope('staff', access.actor.staffId, 'attachment.invalidate'), key, request: { route: 'POST /attachments/:id/invalidate', params: { id }, body }, clock },
        async () => ({ status: 200, body: await invalidateAttachment(tx, access, id, body, meta, clock) }),
      ),
    );
    if (result.replayed) reply.header('idempotent-replay', 'true');
    return reply.code(result.status).send(result.body);
  });
}

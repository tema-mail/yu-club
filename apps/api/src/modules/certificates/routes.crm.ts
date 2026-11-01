// S2-53. K16 §11 №29–36: CRM-маршруты сертификатов на /api/crm/v1 – список с «истекающими», карточка, продажа,
// отмена, корректировка, «требует проверки», получатель, проверка по номеру и коду.
// Тонкий слой (ADR 0002 п.7): разбор → команда sale/lifecycle/payment-method в транзакции под Idempotency-Key
// (ADR 0004) → ответ. Права K1 по филиалу продажи: вне зоны – 404 с телом несуществующего, в зоне без права – 403
// и запись отказа в аудит отдельной транзакцией (ADR 0005 п.8). Код сертификата: ответ продажи сохраняется без
// него (redactSaleResponse), в request_hash проверки вместо кода – HMAC с CERT_PEPPER (K16 §3, S2-08).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { writeDenied, type AuditAction, type AuditRequestMeta, type Db } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { idempotencyScope, requireIdempotencyKey, runIdempotent } from '../../core/idempotency.ts';
import type { Tx } from '../../core/ledger.ts';
import { assertCan, branchScopeSql, scopeFilter, type AccessContext } from '../../core/permissions.ts';
import { systemClock, type Clock } from '../../core/time.ts';
import { cancelSale, correctBalance, linkRecipient, setReview } from './lifecycle.ts';
import { verifyCertificatePin } from './payment-method.ts';
import { CERT_SELECT, getCertificateRow, pinDigest, redactSaleResponse, sellCertificate, toCertificateDto, type CertificateRow } from './sale.ts';

export interface CertificateCrmDeps {
  pool: Db & { connect(): Promise<pg.PoolClient> };
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<{ access: AccessContext; meta: AuditRequestMeta }>;
  /** CERT_PEPPER: HMAC кода сертификата (config.ts). */
  pepper: string;
  clock?: Clock;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID = z.string().regex(UUID_RE);
const notFound = () => new AppError('NOT_FOUND', 404, 'Не найдено');

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value ?? {});
  if (!r.success) {
    throw new AppError('VALIDATION_FAILED', 400, 'Неверные данные запроса', { issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  }
  return r.data;
}
const objectBody = (b: unknown): Record<string, unknown> => (b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {});

const saleSchema = z.object({
  nominalKop: z.number(), // целое > 0 и пределы – NOMINAL_OUT_OF_RANGE (K16 §12)
  method: z.enum(['cash', 'card', 'transfer']),
  buyerClientId: UUID.nullish(),
  recipientClientId: UUID.nullish(),
  comment: z.string().max(2000).nullish(),
});
const cancelSchema = z.object({ rowVersion: z.number().int(), reason: z.string().max(2000), refundMoney: z.boolean() });
const correctSchema = z.object({ rowVersion: z.number().int(), deltaKop: z.number(), reason: z.string().max(2000), ref: z.string().max(200).nullish() });
const reviewSchema = z.object({ rowVersion: z.number().int(), on: z.boolean(), reason: z.string().max(2000) });
const recipientSchema = z.object({ rowVersion: z.number().int(), clientId: UUID.nullable(), presentedBranchId: UUID.nullish() });
const checkSchema = z.object({ branchId: UUID, number: z.string().min(1).max(40), pin: z.string().max(10) });
const listSchema = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  status: z.enum(['active', 'partially_used', 'used_up', 'expired', 'cancelled', 'needs_review']).optional(),
  expiring: z.enum(['7', '30', '60']).optional(),
  branchId: UUID.optional(),
  cursor: z.string().regex(/^\d{1,16}:[0-9a-f-]{36}$/i).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** Статус в SQL – тот же порядок, что statusOf (08 §8); $now – параметр. */
const STATUS_SQL = (now: string) => `CASE WHEN c.cancelled_at IS NOT NULL THEN 'cancelled' WHEN c.review_reason IS NOT NULL THEN 'needs_review'
  WHEN c.expires_at <= ${now} THEN 'expired' WHEN la.balance <= 0 THEN 'used_up' WHEN la.balance < c.nominal_kop THEN 'partially_used' ELSE 'active' END`;

/** №29: список по зоне (филиал продажи), поиск по номеру и телефону клиента, «истекающие» (08 §11.1, §13.4). */
async function listCertificates(db: Db, ctx: AccessContext, raw: unknown, clock: Clock) {
  const q = parse(listSchema, raw);
  const now = clock.now();
  const params: unknown[] = [now];
  // $1 – «сейчас» для статуса и «истекающих»; тип задаётся явно, даже если фильтров по нему нет
  const where = ['$1::timestamptz IS NOT NULL', branchScopeSql('c.sale_branch_id', scopeFilter(ctx, 'certificate.view'), params)];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replaceAll('?', `$${params.length}`));
  };
  if (q.branchId) add('c.sale_branch_id = ?', q.branchId);
  if (q.status) add(`${STATUS_SQL('$1')} = ?`, q.status);
  if (q.expiring) {
    add(`c.expires_at > $1 AND c.expires_at <= $1 + (?::text || ' days')::interval AND c.cancelled_at IS NULL AND la.balance > 0`, q.expiring);
  }
  if (q.q) {
    const digits = q.q.replace(/\D/g, '');
    const text = `%${q.q.toUpperCase().replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    params.push(text, digits.length >= 4 ? `%${digits}` : null);
    const t = params.length - 1;
    where.push(`(c.number ILIKE $${t} OR ($${t + 1}::text IS NOT NULL AND EXISTS (SELECT 1 FROM app.clients cl
      WHERE cl.id IN (c.buyer_client_id, c.recipient_client_id) AND cl.phone_e164 LIKE $${t + 1})))`);
  }
  if (q.cursor) {
    const [ms, id] = q.cursor.split(':');
    params.push(new Date(Number(ms)), id);
    where.push(`(c.sold_at, c.id) < ($${params.length - 1}, $${params.length}::uuid)`);
  }
  params.push(q.limit + 1);
  const r = await db.query<CertificateRow>(`${CERT_SELECT} WHERE ${where.join(' AND ')} ORDER BY c.sold_at DESC, c.id DESC LIMIT $${params.length}`, params);
  const rows = r.rows.slice(0, q.limit);
  const last = rows.at(-1);
  return {
    items: rows.map((row) => toCertificateDto(row, now)),
    nextCursor: r.rows.length > q.limit && last ? `${last.sold_at.getTime()}:${last.id}` : null,
  };
}

const ENTRY_KIND: Record<string, string> = {
  'certificate.issue': 'sale',
  'certificate.redeem': 'redeem',
  'certificate.expire': 'expire',
  'certificate.correction': 'correction',
};

/** №30: карточка – сертификат, погашения, смены получателя, движение остатка (08 §11.2). */
async function certificateCard(db: Db, ctx: AccessContext, id: string, clock: Clock) {
  const row = await getCertificateRow(db, id);
  if (!row) throw notFound();
  assertCan(ctx, 'certificate.view', { branchId: row.sale_branch_id });
  const [redemptions, history, entries] = await Promise.all([
    db.query(
      `SELECT r.id, r.booking_id, r.payment_id, r.branch_id, b.name AS branch_name, r.client_id, r.amount_kop, r.status, r.created_at
       FROM app.certificate_redemptions r JOIN app.branches b ON b.id = r.branch_id WHERE r.certificate_id = $1 ORDER BY r.created_at, r.id`,
      [id],
    ),
    db.query(`SELECT old_client_id, new_client_id, changed_by, changed_at FROM journal.certificate_holder_history WHERE certificate_id = $1 ORDER BY id`, [id]),
    db.query(
      `SELECT le.entry_type, le.amount, le.balance_after, le.occurred_at, le.branch_id, le.basis, o.entry_type AS reversed_type
       FROM journal.ledger_entries le LEFT JOIN journal.ledger_entries o ON o.id = le.reversal_of
       WHERE le.account_id = $1 ORDER BY le.occurred_at, le.id`,
      [row.ledger_account_id],
    ),
  ]);
  return {
    ...toCertificateDto(row, clock.now()),
    cancelReason: row.cancel_reason,
    reviewReason: row.review_reason,
    redemptions: redemptions.rows.map((r) => ({
      id: r.id,
      bookingId: r.booking_id,
      paymentId: r.payment_id,
      branchId: r.branch_id,
      branchName: r.branch_name,
      clientId: r.client_id,
      amountKop: Number(r.amount_kop),
      status: r.status,
      at: (r.created_at as Date).toISOString(),
    })),
    history: history.rows.map((h) => ({ oldClientId: h.old_client_id, newClientId: h.new_client_id, changedBy: h.changed_by, at: (h.changed_at as Date).toISOString() })),
    timeline: entries.rows.map((e) => ({
      type: e.entry_type === 'reversal' ? (e.reversed_type === 'certificate.issue' ? 'cancel' : 'return') : ENTRY_KIND[e.entry_type as string],
      amountKop: Number(e.amount),
      balanceAfterKop: Number(e.balance_after),
      at: (e.occurred_at as Date).toISOString(),
      branchId: e.branch_id,
      basis: e.basis,
    })),
  };
}

type Command = (tx: Tx, ctx: AccessContext, params: Record<string, string>, body: Record<string, unknown>, meta: AuditRequestMeta, clock: Clock) => Promise<unknown>;

export async function certificateCrmRoutes(app: FastifyInstance, deps: CertificateCrmDeps): Promise<void> {
  const clock = deps.clock ?? systemClock;

  function command(operation: string, action: AuditAction | null, run: Command, status: number, extra: { redact?: (b: unknown) => unknown; hashBody?: (b: unknown) => unknown } = {}) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      const { access, meta } = await deps.authenticate(request, reply);
      const key = requireIdempotencyKey(request.headers['idempotency-key']);
      const params = request.params as Record<string, string>;
      const body = objectBody(request.body);
      const client = await deps.pool.connect();
      let result;
      try {
        await client.query('BEGIN');
        result = await runIdempotent(
          client,
          {
            scope: idempotencyScope('staff', access.actor.staffId, `certificate.${operation}`),
            key,
            request: { route: `${request.method} ${request.routeOptions.url}`, params, body },
            clock,
            ...extra,
          },
          async () => ({ status, body: await run(client, access, params, body, meta, clock) }),
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        if (action && err instanceof AppError && err.code === 'FORBIDDEN') {
          const id = params.id && UUID_RE.test(params.id) ? params.id : null;
          await writeDenied(deps.pool, meta, { action, object: id ? { type: 'certificate', id } : { type: 'branch', id: params.branchId ?? null }, branchId: params.branchId ?? null, result: 'denied', reason: `FORBIDDEN: ${operation}` }, clock);
        }
        throw err;
      } finally {
        client.release();
      }
      if (result.replayed) reply.header('idempotent-replay', 'true');
      return reply.code(result.status).send(result.body);
    };
  }

  // №29 список, №30 карточка
  app.get('/certificates', async (request, reply) => {
    const { access } = await deps.authenticate(request, reply);
    return listCertificates(deps.pool, access, request.query, clock);
  });
  app.get('/certificates/:id', async (request, reply) => {
    const { access } = await deps.authenticate(request, reply);
    return certificateCard(deps.pool, access, (request.params as { id: string }).id, clock);
  });

  // №31 продажа: код – только в первом ответе
  app.post(
    '/branches/:branchId/certificates',
    command(
      'sell',
      'certificate.sold',
      async (tx, ctx, p, body, meta, c) => {
        if (!UUID_RE.test(p.branchId!)) throw notFound();
        const input = parse(saleSchema, body);
        return sellCertificate(tx, ctx, { ...input, branchId: p.branchId! }, meta, { pepper: deps.pepper, clock: c });
      },
      201,
      { redact: redactSaleResponse },
    ),
  );

  // №32–35 карточка сертификата
  const byId = (p: Record<string, string>) => {
    if (!UUID_RE.test(p.id!)) throw notFound();
    return p.id!;
  };
  app.post(
    '/certificates/:id/cancel',
    command('cancel', 'certificate.cancelled', async (tx, ctx, p, body, meta, c) => cancelSale(tx, ctx, { ...parse(cancelSchema, body), certificateId: byId(p) }, meta, c), 200),
  );
  app.post(
    '/certificates/:id/correct',
    command('correct', 'certificate.corrected', async (tx, ctx, p, body, meta, c) => correctBalance(tx, ctx, { ...parse(correctSchema, body), certificateId: byId(p) }, meta, c), 201),
  );
  app.post(
    '/certificates/:id/review',
    command('review', 'certificate.review_changed', async (tx, ctx, p, body, meta, c) => setReview(tx, ctx, { ...parse(reviewSchema, body), certificateId: byId(p) }, meta, c), 200),
  );
  app.post(
    '/certificates/:id/recipient',
    command('recipient', 'certificate.recipient_changed', async (tx, ctx, p, body, meta, c) => linkRecipient(tx, ctx, { ...parse(recipientSchema, body), certificateId: byId(p) }, meta, c), 200),
  );

  // №36 проверка по номеру и коду перед оплатой: тот же лимит попыток (K16 §3)
  app.post(
    '/certificates/check',
    command(
      'check',
      null, // отказ проверки – без записи: своего действия в реестре K2 нет
      async (_tx, ctx, _p, body, meta, c) => {
        const input = parse(checkSchema, body);
        assertCan(ctx, 'finance.payment.record', { branchId: input.branchId });
        // неудача фиксируется своей транзакцией до ответа – откат этой её не съест
        const { certificateId } = await verifyCertificatePin(deps.pool, { number: input.number, pin: input.pin }, { pepper: deps.pepper, clock: c, meta });
        const row = (await getCertificateRow(deps.pool, certificateId))!;
        const dto = toCertificateDto(row, c.now());
        return { number: dto.number, status: dto.status, balanceKop: dto.balanceKop, expiresOn: dto.expiresOn };
      },
      200,
      { hashBody: (b) => ({ ...(b as Record<string, unknown>), pin: pinDigest(deps.pepper, String((b as { pin?: unknown }).pin ?? '')) }) },
    ),
  );
}

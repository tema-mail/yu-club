// K15 §11 №24–28 (дополняет K11): бонусный счёт клиента, корректировка, товары за баллы в CRM (/api/crm/v1).
// Тонкий слой: Zod-разбор → функции модуля (account, adjust, goods) в транзакции → ответ. Вход сотрудника передаёт server.ts.
// Зона клиента (K1): карточка через clients.getClientCard – клиент вне зоны отвечает 404, как несуществующий;
// зона филиала – assertCan по филиалу. Команды с Idempotency-Key: корректировка (№25) и выдача товара (№27).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import type { AuditRequestMeta, Db } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { idempotencyScope, requireIdempotencyKey, runIdempotent } from '../../core/idempotency.ts';
import { assertCan, roleAllows, type AccessContext } from '../../core/permissions.ts';
import { systemClock, type Clock } from '../../core/time.ts';
import { getClientCard, type ClientBranchLinks } from '../clients/index.ts';
import { getBalance } from './account.ts';
import { adjust } from './adjust.ts';
import { LIMIT_MESSAGE } from './gate.ts';
import { createGoods, issueGoods, listBranchGoods, returnGoods, updateGoods } from './goods.ts';

export interface LoyaltyCrmDeps {
  pool: Db & { connect(): Promise<pg.PoolClient> };
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<{ access: AccessContext; meta: AuditRequestMeta }>;
  links: ClientBranchLinks;
  clock?: Clock;
}

const Uuid = z.uuid();
const AdjustBody = z.strictObject({ deltaCenti: z.number().int().refine((n) => n !== 0), reason: z.string().max(1000), belowLimit: z.literal(true).optional(), issueId: Uuid.optional() });
const BranchStock = z.strictObject({ branchId: Uuid, stock: z.number().int().min(0).nullable().optional(), active: z.boolean().optional() });
const GoodsBody = z.strictObject({
  name: z.string().min(1).max(200), description: z.string().max(2000).nullable().optional(), imageUrl: z.string().max(1000).nullable().optional(),
  priceRubKop: z.number().int().min(0).nullable().optional(), pricePointsCenti: z.number().int().positive(), branches: z.array(BranchStock).min(1).max(100),
});
const GoodsPatch = GoodsBody.partial().extend({ rowVersion: z.number().int().positive(), status: z.enum(['active', 'archived']).optional() });
const OrderBody = z.strictObject({ goodsId: Uuid, branchId: Uuid });
const ReturnBody = z.strictObject({ reason: z.string().max(1000) });

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value ?? {});
  if (!r.success) {
    throw new AppError('VALIDATION_FAILED', 400, 'Неверные данные запроса', { issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  }
  return r.data;
}
const notFound = () => new AppError('NOT_FOUND', 404, 'Не найдено');

async function inTx<T>(pool: LoyaltyCrmDeps['pool'], fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

/** История счёта для CRM (07 §13): записи K3 с основанием – сотрудник видит внутренние комментарии. */
async function crmHistory(db: Db, clientId: string, limit = 100) {
  const r = await db.query<{ id: string; occurred_at: Date; entry_type: string; amount: string; balance_after: string; basis: string | null; branch_id: string | null; ref_type: string | null; ref_id: string | null; author_type: string; author_id: string | null }>(
    `SELECT e.id, e.occurred_at, e.entry_type, e.amount, e.balance_after, e.basis, e.branch_id, e.ref_type, e.ref_id, e.author_type, e.author_id
     FROM journal.ledger_entries e JOIN app.ledger_accounts a ON a.id = e.account_id
     WHERE a.kind = 'loyalty_client' AND a.owner_type = 'client' AND a.owner_id = $1 ORDER BY e.occurred_at DESC, e.id DESC LIMIT $2`,
    [clientId, limit],
  );
  return r.rows.map((x) => ({
    entryId: Number(x.id), at: x.occurred_at.toISOString(), type: x.entry_type, deltaCenti: Number(x.amount), balanceAfterCenti: Number(x.balance_after),
    comment: x.basis, branchId: x.branch_id, ref: x.ref_type && x.ref_id ? { type: x.ref_type, id: x.ref_id } : null, author: { type: x.author_type, id: x.author_id },
  }));
}

/** Партии клиента (K15 §2): источник, сумма, остаток, срок; entryId – запись K3 начисления (связь с историей). */
async function crmBatches(db: Db, clientId: string) {
  const r = await db.query<{ id: string; source: string; accrual_entry_id: string; branch_id: string | null; amount_centi: string; remaining_centi: string; expires_at: Date | null; status: string; accrued_at: Date }>(
    `SELECT id, source, accrual_entry_id, branch_id, amount_centi, remaining_centi, expires_at, status, accrued_at
     FROM app.loyalty_batches WHERE client_id = $1 ORDER BY accrued_at DESC, id DESC LIMIT 200`,
    [clientId],
  );
  return r.rows.map((b) => ({
    id: b.id, source: b.source, entryId: Number(b.accrual_entry_id), branchId: b.branch_id, amountCenti: Number(b.amount_centi),
    remainingCenti: Number(b.remaining_centi), expiresAt: b.expires_at?.toISOString() ?? null, status: b.status, accruedAt: b.accrued_at.toISOString(),
  }));
}

/** Выданные товары клиента (K15 №27–28): возврат – по id заказа из этого списка. */
async function crmGoodsOrders(db: Db, clientId: string) {
  const r = await db.query<{ id: string; goods_id: string; name: string; branch_id: string; price_points_centi: string; status: string; issued_at: Date; return_reason: string | null }>(
    `SELECT o.id, o.goods_id, g.name, o.branch_id, o.price_points_centi, o.status, o.issued_at, o.return_reason
     FROM app.loyalty_goods_orders o JOIN app.loyalty_goods g ON g.id = o.goods_id WHERE o.client_id = $1 ORDER BY o.issued_at DESC, o.id DESC LIMIT 100`,
    [clientId],
  );
  return r.rows.map((o) => ({
    id: o.id, goodsId: o.goods_id, goodsName: o.name, branchId: o.branch_id, priceCenti: Number(o.price_points_centi), status: o.status,
    issuedAt: o.issued_at.toISOString(), returnReason: o.return_reason,
  }));
}

export async function loyaltyCrmRoutes(app: FastifyInstance, deps: LoyaltyCrmDeps): Promise<void> {
  const clock = deps.clock ?? systemClock;
  /** Клиент в зоне сотрудника (K1 assertCanClient через брони) и право роли; иначе 404 / 403. */
  const clientInZone = async (access: AccessContext, clientId: string, action: string): Promise<string> => {
    const card = await getClientCard(deps.pool, access, clientId, deps.links); // вне зоны – NOT_FOUND
    if (!roleAllows(access.role, action)) throw new AppError('FORBIDDEN', 403, 'Недостаточно прав', { action });
    // Объединённая карточка (K9 «Слияние», D5-09): баллы живут у основной – менять счёт второй нельзя, только смотреть историю.
    if (card.status === 'merged' && action !== 'loyalty.view') {
      throw new AppError('CLIENT_MERGED', 409, 'Карточка объединена – баллы у основной карточки', { clientId: card.id, mergedIntoId: card.mergedIntoId });
    }
    return card.id;
  };
  const keyed = async <T>(request: FastifyRequest, reply: FastifyReply, access: AccessContext, operation: string, run: (tx: pg.PoolClient) => Promise<T>) => {
    const key = requireIdempotencyKey(request.headers['idempotency-key']);
    const result = await inTx(deps.pool, (tx) =>
      runIdempotent(
        tx,
        { scope: idempotencyScope('staff', access.actor.staffId, `loyalty.${operation}`), key, request: { route: `${request.method} ${request.routeOptions.url}`, params: request.params, body: request.body ?? null }, clock },
        async () => ({ status: 201, body: await run(tx) }),
      ),
    );
    if (result.replayed) reply.header('idempotent-replay', 'true');
    return reply.code(result.status).send(result.body);
  };
  const p = (request: FastifyRequest) => request.params as Record<string, string>;

  // №24 бонусный счёт: баланс, доступно, резерв, история, партии, выданные товары, «требует решения», причина блокировки
  app.get('/clients/:clientId/loyalty', async (request, reply) => {
    const { access } = await deps.authenticate(request, reply);
    const clientId = await clientInZone(access, p(request).clientId ?? '', 'loyalty.view');
    const balance = await getBalance(deps.pool as unknown as pg.Pool, clientId, clock.now()); // рантайм – pg.Pool
    const issues = await deps.pool.query<{ id: string; kind: string; ref_type: string; ref_id: string; amount_centi: string; created_at: Date }>(
      `SELECT id, kind, ref_type, ref_id, amount_centi, created_at FROM app.loyalty_issues WHERE client_id = $1 AND status = 'open' ORDER BY created_at`,
      [clientId],
    );
    return {
      ...balance,
      history: await crmHistory(deps.pool, clientId),
      batches: await crmBatches(deps.pool, clientId),
      goodsOrders: await crmGoodsOrders(deps.pool, clientId),
      issues: issues.rows.map((i) => ({ id: i.id, kind: i.kind, ref: { type: i.ref_type, id: i.ref_id }, amountCenti: Number(i.amount_centi), createdAt: i.created_at.toISOString() })),
      blockedReason: balance.preBookingBlocked ? LIMIT_MESSAGE : null,
    };
  });

  // №25 корректировка ± с причиной (Владелец, Директор; ниже −50 – Владелец с belowLimit)
  app.post('/clients/:clientId/loyalty/adjust', async (request, reply) => {
    const { access, meta } = await deps.authenticate(request, reply);
    const clientId = await clientInZone(access, p(request).clientId ?? '', 'loyalty.adjust');
    const body = parse(AdjustBody, request.body);
    const key = requireIdempotencyKey(request.headers['idempotency-key']);
    return keyed(request, reply, access, 'adjust', (tx) =>
      adjust(tx, access, { clientId, deltaCenti: body.deltaCenti, reason: body.reason, ...(body.belowLimit ? { belowLimit: true } : {}), ...(body.issueId ? { issueId: body.issueId } : {}), idempotencyKey: `${access.actor.staffId}:${key}` }, meta, clock),
    );
  });

  // №26 каталог филиала, карточка товара, архив вместо удаления
  app.get('/branches/:branchId/goods', async (request, reply) => {
    const { access } = await deps.authenticate(request, reply);
    const branchId = p(request).branchId ?? '';
    if (!Uuid.safeParse(branchId).success) throw notFound();
    assertCan(access, 'loyalty.view', { branchId });
    return { items: await listBranchGoods(deps.pool, branchId, { includeArchived: true }) };
  });
  app.post('/goods', async (request, reply) => {
    const { access, meta } = await deps.authenticate(request, reply);
    const body = parse(GoodsBody, request.body);
    return reply.code(201).send(await inTx(deps.pool, (tx) => createGoods(tx, access, body, meta, clock)));
  });
  app.patch('/goods/:goodsId', async (request, reply) => {
    const { access, meta } = await deps.authenticate(request, reply);
    const goodsId = p(request).goodsId ?? '';
    if (!Uuid.safeParse(goodsId).success) throw notFound();
    const body = parse(GoodsPatch, request.body);
    return inTx(deps.pool, (tx) => updateGoods(tx, access, goodsId, body, meta, clock));
  });

  // №27 выдача товара за баллы при клиенте
  app.post('/clients/:clientId/goods-orders', async (request, reply) => {
    const { access, meta } = await deps.authenticate(request, reply);
    const clientId = await clientInZone(access, p(request).clientId ?? '', 'loyalty.goods.issue');
    const body = parse(OrderBody, request.body);
    const key = requireIdempotencyKey(request.headers['idempotency-key']);
    return keyed(request, reply, access, 'goods_issue', (tx) => issueGoods(tx, access, { clientId, goodsId: body.goodsId, branchId: body.branchId, idempotencyKey: `${access.actor.staffId}:${key}` }, meta, clock));
  });

  // №28 возврат невыданного товара с причиной
  app.post('/goods-orders/:orderId/return', async (request, reply) => {
    const { access, meta } = await deps.authenticate(request, reply);
    const orderId = p(request).orderId ?? '';
    if (!Uuid.safeParse(orderId).success) throw notFound();
    const body = parse(ReturnBody, request.body);
    return reply.code(201).send(await inTx(deps.pool, (tx) => returnGoods(tx, access, { orderId, reason: body.reason }, meta, clock)));
  });
}

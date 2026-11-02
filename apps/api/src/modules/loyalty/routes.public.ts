// K15 §11 (сайт и ЛК, /api/public/v1): баланс, история, резерв баллов на своё удержание, каталог товаров.
// Только своя карточка (assertOwnClient – клиент из сессии, K9). Тонкий слой (ADR 0002 п.7).
// История без внутренних комментариев сотрудников (07 §12.2, 03 §8.3): основание записи K3 не отдаётся – только вид
// операции, сумма, остаток после, филиал и номер брони; «не возвращено» – отдельной строкой с deltaCenti = 0.
// ЛК и история доступны и при −50 (07 §9.3) – блокировка касается только новой записи.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import type { AuditRequestMeta } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { idempotencyScope, requireIdempotencyKey, runIdempotent } from '../../core/idempotency.ts';
import { systemClock } from '../../core/time.ts';
import { authenticateClient, type ClientPublicDeps } from '../clients/routes.public.ts';
import { getBranches } from '../network/index.ts';
import { getBalance } from './account.ts';
import { listBranchGoods } from './goods.ts';
import { releaseHoldReserve, reserveForHold } from './reserve.ts';

const Uuid = z.uuid();
const HistoryQuery = z.object({ cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(100).optional() });
const GoodsQuery = z.object({ branchId: Uuid });

const NOTES: Record<string, string> = {
  'loyalty.accrual': 'Начисление за посещение',
  'loyalty.penalty': 'Штраф за неявку',
  'loyalty.spend_time': 'Оплата сеанса баллами',
  'loyalty.spend_goods': 'Товар за баллы',
  'loyalty.return': 'Возврат баллов',
  'loyalty.expire': 'Срок баллов истёк',
  'loyalty.manual': 'Корректировка клубом',
  reversal: 'Исправление операции',
};

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value ?? {});
  if (!r.success) throw new AppError('VALIDATION_FAILED', 400, 'Неверные данные запроса', { issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  return r.data;
}

function decodeCursor(c: string | undefined): { at: Date; id: number } | null {
  if (!c) return null;
  const [at, id] = Buffer.from(c, 'base64url').toString('utf8').split('|');
  const d = new Date(at ?? '');
  if (Number.isNaN(d.getTime()) || !/^\d+$/.test(id ?? '')) throw new AppError('VALIDATION_FAILED', 400, 'Неверный курсор', { field: 'cursor' });
  return { at: d, id: Number(id) };
}

/** Номера броней для истории (booking/providers.ts paymentBookingProvider; loyalty booking не импортирует, ADR 0002). */
export interface HistoryBookings {
  bookingNumbers(db: pg.Pool | pg.PoolClient, bookingIds: string[]): Promise<Map<string, number>>;
}

/** История счёта клиента для ЛК: новые сверху, курсор (occurred_at, id). Филиал – network/index.ts, номер брони – провайдер booking. */
export async function publicHistory(db: pg.Pool | pg.PoolClient, bookings: HistoryBookings, clientId: string, cursor: string | undefined, limit = 50) {
  const after = decodeCursor(cursor);
  const r = await db.query<{ id: string; occurred_at: Date; entry_type: string; amount: string; balance_after: string; branch_id: string | null; booking_id: string | null; not_returned: string | null }>(
    `SELECT e.id, e.occurred_at, e.entry_type, e.amount, e.balance_after, e.branch_id,
            COALESCE(CASE WHEN e.ref_type = 'booking' THEN e.ref_id END, (e.refs ->> 'bookingId')::uuid) AS booking_id,
            e.refs ->> 'notReturnedCenti' AS not_returned
     FROM journal.ledger_entries e
     JOIN app.ledger_accounts a ON a.id = e.account_id
     WHERE a.kind = 'loyalty_client' AND a.owner_type = 'client' AND a.owner_id = $1
       AND ($2::timestamptz IS NULL OR (e.occurred_at, e.id) < ($2::timestamptz, $3::bigint))
     ORDER BY e.occurred_at DESC, e.id DESC LIMIT $4`,
    [clientId, after?.at ?? null, after?.id ?? null, limit + 1],
  );
  const rows = r.rows.slice(0, limit);
  const uniq = (v: Array<string | null>) => [...new Set(v.filter((x): x is string => x !== null))];
  const branches = await getBranches(db, uniq(rows.map((x) => x.branch_id)));
  const numbers = await bookings.bookingNumbers(db, uniq(rows.map((x) => x.booking_id)));
  const items = [];
  for (const x of rows) {
    const base = {
      at: x.occurred_at.toISOString(),
      branchName: x.branch_id === null ? null : (branches.get(x.branch_id)?.name ?? null),
      bookingNumber: x.booking_id === null ? null : (numbers.get(x.booking_id) ?? null),
    };
    const notReturned = Number(x.not_returned ?? 0);
    if (notReturned > 0) items.push({ ...base, type: 'not_returned', deltaCenti: 0, balanceAfterCenti: Number(x.balance_after), note: `Не возвращено ${notReturned / 100} балла: срок партии истёк` });
    items.push({ ...base, type: x.entry_type.replace(/^loyalty\./, ''), deltaCenti: Number(x.amount), balanceAfterCenti: Number(x.balance_after), note: NOTES[x.entry_type] ?? 'Операция' });
  }
  const last = rows.at(-1);
  const nextCursor = r.rows.length > limit && last ? Buffer.from(`${last.occurred_at.toISOString()}|${last.id}`, 'utf8').toString('base64url') : null;
  return { items, nextCursor };
}

export async function loyaltyPublicRoutes(app: FastifyInstance, deps: { clients: ClientPublicDeps; bookings: HistoryBookings }): Promise<void> {
  const clock = deps.clients.clock ?? systemClock;
  const pool = deps.clients.pool as unknown as pg.Pool; // рантайм – pg.Pool (server.ts)
  const me = async (request: FastifyRequest, reply: Parameters<typeof authenticateClient>[2]) => authenticateClient(deps.clients, request, reply);
  const metaOf = (s: { clientId: string; sessionId: string }, request: FastifyRequest): AuditRequestMeta => ({ actor: { kind: 'client', clientId: s.clientId, sessionId: s.sessionId }, source: 'account', requestId: request.id, ip: request.ip });
  const inTx = async <T>(fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> => {
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
  };
  const holdIdOf = (request: FastifyRequest) => {
    const id = (request.params as { holdId?: string }).holdId ?? '';
    if (!Uuid.safeParse(id).success) throw new AppError('RESERVE_HOLD_INVALID', 409, 'Удержание истекло, уже подтверждено или не ваше');
    return id;
  };

  app.get('/me/loyalty', async (request, reply) => getBalance(pool, (await me(request, reply)).clientId, clock.now()));

  app.get('/me/loyalty/history', async (request, reply) => {
    const s = await me(request, reply);
    const q = parse(HistoryQuery, request.query);
    return publicHistory(pool, deps.bookings, s.clientId, q.cursor, q.limit ?? 50);
  });

  app.post('/holds/:holdId/points-reserve', async (request, reply) => {
    const s = await me(request, reply);
    const holdId = holdIdOf(request);
    const key = requireIdempotencyKey(request.headers['idempotency-key']);
    const result = await inTx((tx) =>
      runIdempotent(
        tx,
        { scope: idempotencyScope('client', s.clientId, 'loyalty.reserve'), key, request: { route: 'POST /holds/:holdId/points-reserve', params: { holdId }, body: request.body ?? null }, clock },
        async () => ({ status: 201, body: await reserveForHold(tx, { clientId: s.clientId, holdId }, metaOf(s, request), clock) }),
      ),
    );
    if (result.replayed) reply.header('idempotent-replay', 'true');
    return reply.code(result.status).send(result.body);
  });

  app.delete('/holds/:holdId/points-reserve', async (request, reply) => {
    const s = await me(request, reply);
    const holdId = holdIdOf(request);
    return { released: await inTx((tx) => releaseHoldReserve(tx, { clientId: s.clientId, holdId }, metaOf(s, request), clock)) };
  });

  // каталог товаров за баллы (07 §12.4): только просмотр, выдача – в клубе
  app.get('/goods', async (request, reply) => {
    await me(request, reply);
    const q = parse(GoodsQuery, request.query);
    const items = await listBranchGoods(pool, q.branchId);
    return { items: items.map((g) => ({ id: g.id, name: g.name, description: g.description, imageUrl: g.imageUrl, priceRubKop: g.priceRubKop, pricePointsCenti: g.pricePointsCenti, available: g.available })) };
  });
}

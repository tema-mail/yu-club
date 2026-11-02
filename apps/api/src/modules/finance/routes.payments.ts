// S2-22. K10 №19–23: CRM-маршруты оплаты на /api/crm/v1 – карточка оплаты брони (допустимые способы считает сервер),
// проведение оплаты, возврат, «к оплате» за сутки филиала, статусы для календаря.
// Тонкий слой (ADR 0002 п.7): разбор → команда payment.ts / refund.ts в транзакции под Idempotency-Key (ADR 0004) → ответ.
// Код сертификата проверяется ДО BEGIN своей транзакцией (verifyCertificate – K16 §3, решение 02.11 в K10 §5); в
// idempotency_keys код не попадает: в request_hash вместо него HMAC с CERT_PEPPER (S2-08, D2-07).
// Права – K1 по филиалу брони: вне зоны – 404 как несуществующее, в зоне без права – 403 и запись отказа в аудит.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { writeDenied, type AuditRequestMeta, type Db } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { idempotencyScope, requireIdempotencyKey, runIdempotent, secretDigest } from '../../core/idempotency.ts';
import { can, type AccessContext } from '../../core/permissions.ts';
import { resolveSettings } from '../../core/settings.ts';
import { systemClock, type Clock } from '../../core/time.ts';
import { financeDenialOf, guardFinance } from './cashbox.ts';
import { MONEY_METHODS, paymentMethodHandler, type PaymentMethod } from './methods.ts';
import { getPayment, getPaymentStatus, getSession, listUnpaid, recordPayment, type PaymentBookings, type UnpaidBookings } from './payment.ts';
import { refundPayment } from './refund.ts';

export interface PaymentRoutesDeps {
  pool: Db & { connect(): Promise<pg.PoolClient> };
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<{ access: AccessContext; meta: AuditRequestMeta }>;
  bookings: PaymentBookings & UnpaidBookings;
  /** Сертификаты (K16): проверка кода своей транзакцией и pepper для request_hash. Нет – способ certificate недоступен. */
  certificates?: { pepper: string; verify: (input: { number: string; pin: string }, meta: AuditRequestMeta) => Promise<{ certificateId: string }> };
  /** Доступные баллы клиента (loyalty getBalance().availableCenti) – подсказка экрану; проверяет обработчик points. */
  pointsAvailable?: (db: Db, clientId: string, at: Date) => Promise<number>;
  clock?: Clock;
}

const notFound = () => new AppError('NOT_FOUND', 404, 'Не найдено');
const objectBody = (b: unknown): Record<string, unknown> => (b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {});

/** Тело для request_hash: код сертификата заменён HMAC (перебор 4 цифр по хэшу невозможен). */
function hashBodyWith(pepper: string | undefined) {
  return (body: unknown): unknown => {
    const b = objectBody(body);
    if (!Array.isArray(b.lines)) return b;
    return {
      ...b,
      lines: b.lines.map((l: unknown) => {
        const line = objectBody(l);
        const cert = objectBody(line.certificate);
        if (typeof cert.pin !== 'string') return line;
        return { ...line, certificate: { ...cert, pin: pepper ? secretDigest(pepper, cert.pin) : '***' } };
      }),
    };
  };
}

const statusSchema = z.object({ bookingIds: z.array(z.string().regex(/^[0-9a-f-]{36}$/i)).min(1).max(200) });

export async function paymentRoutes(app: FastifyInstance, deps: PaymentRoutesDeps): Promise<void> {
  const clock = deps.clock ?? systemClock;

  async function denied<T>(meta: AuditRequestMeta, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      const d = financeDenialOf(err);
      if (d) await writeDenied(deps.pool, meta, { ...d, result: 'denied' }, clock);
      throw err;
    }
  }

  /** Изменяющая команда: (до BEGIN – prepare) → транзакция под Idempotency-Key. */
  function command<P>(operation: string, prepare: (ctx: AccessContext, meta: AuditRequestMeta, body: Record<string, unknown>) => Promise<P>, run: (tx: pg.PoolClient, ctx: AccessContext, params: Record<string, string>, body: Record<string, unknown>, meta: AuditRequestMeta, prepared: P) => Promise<unknown>) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      const { access, meta } = await deps.authenticate(request, reply);
      const key = requireIdempotencyKey(request.headers['idempotency-key']);
      const params = request.params as Record<string, string>;
      const body = objectBody(request.body);
      const result = await denied(meta, async () => {
        const prepared = await prepare(access, meta, body);
        const client = await deps.pool.connect();
        try {
          await client.query('BEGIN');
          const r = await runIdempotent(
            client,
            {
              scope: idempotencyScope('staff', access.actor.staffId, `finance.${operation}`),
              key,
              request: { route: `${request.method} ${request.routeOptions.url}`, params, body },
              hashBody: hashBodyWith(deps.certificates?.pepper),
              clock,
            },
            async () => ({ status: 201, body: await run(client, access, params, body, meta, prepared) }),
          );
          await client.query('COMMIT');
          return r;
        } catch (err) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw err;
        } finally {
          client.release();
        }
      });
      if (result.replayed) reply.header('idempotent-replay', 'true');
      return reply.code(result.status).send(result.body);
    };
  }

  // №19 карточка оплаты брони
  app.get('/bookings/:bookingId/payment', async (request, reply) => {
    const { access, meta } = await deps.authenticate(request, reply);
    const bookingId = (request.params as { bookingId: string }).bookingId;
    return denied(meta, async () => {
      const facts = /^[0-9a-f-]{36}$/i.test(bookingId) ? await deps.bookings.facts(deps.pool, bookingId) : null;
      if (!facts) throw notFound();
      await guardFinance(deps.pool, access, facts.branchId, 'finance.payment.view', { action: 'payment.recorded' });
      const now = clock.now();
      const b = (await deps.bookings.payableBooking(deps.pool, bookingId))!;
      const session = await getSession(deps.pool, bookingId);
      const last = await deps.pool.query<{ id: string }>(`SELECT id FROM app.payments WHERE session_id = $1 ORDER BY attempt DESC LIMIT 1`, [bookingId]);
      const payment = last.rows[0] ? await getPayment(deps.pool, last.rows[0].id) : null;
      const refunds = payment
        ? (await deps.pool.query(`SELECT id, line_no AS "lineNo", seq, amount_kop::int AS "amountKop", points_centi::int AS "pointsCenti", reason, outcome, created_at AS "createdAt" FROM app.payment_refunds WHERE payment_id = $1 ORDER BY created_at, line_no, seq`, [payment.id])).rows
        : [];
      const s = await resolveSettings(deps.pool, ['payment.certificate_topup_enabled', 'loyalty.points_resource_types'], { branchId: b.branchId }, now);
      const pointsType = s['loyalty.points_resource_types'].value.includes(b.resourceType);
      const pointsOn = Boolean(paymentMethodHandler('points') && deps.pointsAvailable);
      const pointsAvailableCenti = pointsOn ? await deps.pointsAvailable!(deps.pool, b.clientId, now) : null;
      const pointsRequiredCenti = pointsOn && pointsType ? b.minutes * 100 : null;
      const due = session && !session.activePaymentId ? b.priceKop : (session?.amountDueKop ?? b.priceKop);
      let allowedMethods: PaymentMethod[] = [];
      if (b.payable && !session?.activePaymentId && can(access, 'finance.payment.record', { branchId: b.branchId })) {
        if (due === 0) allowedMethods = ['none'];
        else {
          allowedMethods = [...MONEY_METHODS];
          if (pointsRequiredCenti !== null && (pointsAvailableCenti ?? 0) >= pointsRequiredCenti) allowedMethods.push('points');
          if (paymentMethodHandler('certificate') && deps.certificates) allowedMethods.push('certificate');
        }
      }
      return {
        session, payment, refunds, allowedMethods, amountDueKop: due,
        topupEnabled: s['payment.certificate_topup_enabled'].value, pointsAvailableCenti, pointsRequiredCenti,
      };
    });
  });

  // №20 провести оплату: код сертификата – до BEGIN
  app.post(
    '/bookings/:bookingId/payment',
    command(
      'payment.record',
      async (_ctx, meta, body) => {
        const lines = Array.isArray(body.lines) ? body.lines.map(objectBody) : [];
        const certLine = lines.find((l) => l.method === 'certificate');
        if (!certLine) return {};
        const cert = objectBody(certLine.certificate);
        if (!deps.certificates || !paymentMethodHandler('certificate')) throw new AppError('VALIDATION_FAILED', 400, 'Способ оплаты недоступен', { method: 'certificate' });
        if (typeof cert.number !== 'string' || typeof cert.pin !== 'string') throw new AppError('VALIDATION_FAILED', 400, 'Укажите номер и код сертификата', { field: 'certificate' });
        return { verifiedCertificateId: (await deps.certificates.verify({ number: cert.number, pin: cert.pin }, meta)).certificateId };
      },
      (tx, ctx, p, body, meta, prepared) =>
        recordPayment(tx, ctx, { ...body, bookingId: p.bookingId }, meta, { bookings: deps.bookings, clock, ...prepared }),
    ),
  );

  // №21 возврат
  app.post(
    '/payments/:paymentId/refund',
    command('payment.refund', async () => ({}), (tx, ctx, p, body, meta) => refundPayment(tx, ctx, { ...body, paymentId: p.paymentId }, meta, { clock })),
  );

  // №22 к оплате
  app.get('/branches/:branchId/unpaid', async (request, reply) => {
    const { access, meta } = await deps.authenticate(request, reply);
    const q = objectBody(request.query);
    return denied(meta, () =>
      listUnpaid(
        deps.pool,
        access,
        {
          branchId: (request.params as { branchId: string }).branchId,
          date: typeof q.date === 'string' ? q.date : '',
          ...(typeof q.cursor === 'string' ? { cursor: q.cursor } : {}),
          ...(typeof q.limit === 'string' ? { limit: Number(q.limit) } : {}),
        },
        { bookings: deps.bookings },
      ),
    );
  });

  // №23 статусы для календаря: брони вне зоны в ответ не попадают (как несуществующие)
  app.post('/bookings/payment-status', async (request, reply) => {
    const { access } = await deps.authenticate(request, reply);
    const r = statusSchema.safeParse(request.body ?? {});
    if (!r.success) throw new AppError('VALIDATION_FAILED', 400, 'Неверные данные запроса', { field: 'bookingIds' });
    const ids = [...new Set(r.data.bookingIds)];
    const visible: string[] = [];
    for (const id of ids) {
      const f = await deps.bookings.facts(deps.pool, id);
      if (f && can(access, 'finance.payment.view', { branchId: f.branchId })) visible.push(id);
    }
    const st = await getPaymentStatus(deps.pool, visible);
    return { items: visible.map((bookingId) => ({ bookingId, status: st.get(bookingId)! })) };
  });
}

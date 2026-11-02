// S2-21. Возврат платежа (K10 §4 refundPayment; 06 §5.2, §17 п.14; 16 §7.5; 08 §9.2).
// Отдельная операция с решением сотрудника (finance.refund), причина обязательна. Деньги – частично или целиком
// (касса K17: операция refund со ссылкой на исходную операцию прихода); баллы и сертификат – только целиком через
// обработчики способов (сертификат после срока – outcome not_restored, денег не создаёт). Платёж и проводки не
// удаляются: возврат – новые записи. Полный возврат всех строк → платёж и сеанс refunded, сеанс можно оплатить
// заново (attempt + 1); частичный → partially_refunded, повторная оплата – ALREADY_PAID.
// Порядок (K17 «Решения 02.11»): все счета журнала одним lockAccounts → сеанс FOR UPDATE → платёж FOR UPDATE →
// перечитать возвраты → проверить → провести. Ключ K3 строки: refund:<paymentId>:<lineNo>:<n>.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { writeAudit, type AuditRequestMeta } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import type { Tx } from '../../core/ledger.ts';
import { publish } from '../../core/outbox.ts';
import type { AccessContext } from '../../core/permissions.ts';
import { systemClock, type Clock } from '../../core/time.ts';
import { guardFinance, lockPlaces, postMoneyOperation, requireComment } from './cashbox.ts';
import { MONEY_METHODS, paymentMethodHandler, type MoneyMethod, type PaymentLine, type PaymentRefundedPayload, type PaymentSession } from './methods.ts';
import { getPayment, getSession, lockSession } from './payment.ts';

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value ?? {});
  if (!r.success) {
    throw new AppError('VALIDATION_FAILED', 400, 'Неверные данные запроса', { issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  }
  return r.data;
}

const refundSchema = z.object({
  paymentId: z.string().regex(/^[0-9a-f-]{36}$/i),
  rowVersion: z.number().int().min(1),
  reason: z.string().max(2000).optional(),
  lines: z
    .array(z.object({ lineNo: z.union([z.literal(1), z.literal(2)]), amountKop: z.number().optional() }))
    .max(2)
    .refine((ls) => new Set(ls.map((l) => l.lineNo)).size === ls.length, { message: 'Строка – один раз' }),
});

const isMoney = (m: string): m is MoneyMethod => (MONEY_METHODS as readonly string[]).includes(m);

/** Возвращено по строкам платежа (сумма; not_restored закрывает строку целиком). */
async function refundedByLine(tx: Tx, paymentId: string): Promise<Map<number, { amountKop: number; count: number }>> {
  const r = await tx.query<{ line_no: number; amount: string; n: number }>(
    `SELECT line_no, sum(amount_kop)::text AS amount, count(*)::int AS n FROM app.payment_refunds WHERE payment_id = $1 GROUP BY line_no`,
    [paymentId],
  );
  return new Map(r.rows.map((x) => [x.line_no, { amountKop: Number(x.amount), count: x.n }]));
}

/** K10 §4 refundPayment. Транзакцию открывает вызывающий (HTTP-слой – под Idempotency-Key). */
export async function refundPayment(
  tx: Tx,
  ctx: AccessContext,
  raw: unknown,
  meta: AuditRequestMeta,
  opts: { clock?: Clock } = {},
): Promise<{ refundIds: string[]; session: PaymentSession }> {
  const clock = opts.clock ?? systemClock;
  const input = parse(refundSchema, raw);
  const now = clock.now();

  // 0) платёж и сеанс без блокировки → права по филиалу сеанса (чужой – 404)
  const found = await getPayment(tx, input.paymentId);
  const s0 = found ? await getSession(tx, found.sessionId) : null;
  if (!found || !s0) throw new AppError('NOT_FOUND', 404, 'Не найдено');
  const branch = await guardFinance(tx, ctx, s0.branchId, 'finance.refund', { action: 'payment.refunded' });
  const reason = requireComment(input.reason, 'reason');
  if (input.lines.length === 0 && found.lines.length > 0) throw new AppError('VALIDATION_FAILED', 400, 'Укажите строки возврата', { field: 'lines' });

  // 1) все счета журнала строк возврата одним lockAccounts
  const extra: string[] = [];
  for (const l of found.lines) {
    if (!input.lines.some((x) => x.lineNo === l.lineNo)) continue;
    if (l.method === 'points') {
      const a = await tx.query<{ id: string }>(`SELECT id FROM app.ledger_accounts WHERE kind = 'loyalty_client' AND owner_type = 'client' AND owner_id = $1`, [s0.clientId]);
      if (a.rows[0]) extra.push(a.rows[0].id);
    }
    if (l.method === 'certificate' && l.certificateId) {
      const a = await tx.query<{ id: string }>(`SELECT id FROM app.ledger_accounts WHERE kind = 'certificate' AND owner_type = 'certificate' AND owner_id = $1`, [l.certificateId]);
      if (a.rows[0]) extra.push(a.rows[0].id);
    }
  }
  await lockPlaces(tx, branch.id, extra);

  // 2) сеанс и платёж под блокировкой, перечитать
  const session = (await lockSession(tx, s0.id))!;
  if (session.rowVersion !== input.rowVersion) throw new AppError('VERSION_CONFLICT', 409, 'Оплату уже изменили', { rowVersion: session.rowVersion });
  const payment = (await getPayment(tx, found.id, true))!;
  if (payment.status === 'refunded') throw new AppError('REFUND_EXCEEDS_PAID', 422, 'Платёж уже возвращён полностью', { paymentId: payment.id });
  const done = await refundedByLine(tx, payment.id);

  // 3) строки
  const author = { type: 'staff' as const, id: ctx.actor.staffId };
  const refundIds: string[] = [];
  const out: PaymentRefundedPayload['lines'] = [];
  for (const req of input.lines) {
    const line: PaymentLine | undefined = payment.lines.find((l) => l.lineNo === req.lineNo);
    if (!line) throw new AppError('VALIDATION_FAILED', 400, 'Нет такой строки платежа', { field: 'lineNo', lineNo: req.lineNo });
    const prev = done.get(line.lineNo) ?? { amountKop: 0, count: 0 };
    const left = line.amountKop - prev.amountKop;
    const amount = req.amountKop ?? left;
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      if (left <= 0) throw new AppError('REFUND_EXCEEDS_PAID', 422, 'Строка уже возвращена', { lineNo: line.lineNo, leftKop: 0 });
      throw new AppError('INVALID_AMOUNT', 422, 'Сумма – целое положительное число копеек', { amountKop: amount });
    }
    if (amount > left) throw new AppError('REFUND_EXCEEDS_PAID', 422, 'Возврат больше непогашенной части строки', { lineNo: line.lineNo, leftKop: left });
    if (!isMoney(line.method) && amount !== line.amountKop) {
      throw new AppError('REFUND_PARTIAL_NOT_ALLOWED', 422, 'Баллы и сертификат возвращаются только целиком', { lineNo: line.lineNo, amountKop: line.amountKop });
    }
    const seq = prev.count + 1;
    const key = `refund:${payment.id}:${line.lineNo}:${seq}`;
    let postingId: string | null;
    let outcome: 'returned' | 'not_restored';
    if (isMoney(line.method)) {
      const op = await postMoneyOperation(
        tx,
        ctx,
        {
          branchId: branch.id, kind: 'refund', place: line.method === 'cash' ? 'cash' : 'noncash', method: line.method, amountKop: amount,
          comment: reason, ref: { type: 'operation', id: line.financeOperationId! }, occurredAt: now,
        },
        { idempotencyKey: key },
        meta,
        clock,
      );
      postingId = op.postingId;
      outcome = 'returned';
    } else {
      const handler = paymentMethodHandler(line.method);
      if (!handler) throw new AppError('VALIDATION_FAILED', 400, 'Способ оплаты недоступен', { method: line.method });
      const r = await handler.refund(tx, { line, amountKop: amount, idempotencyKey: key, author, occurredAt: now, reason, meta });
      postingId = r.postingId;
      outcome = r.outcome;
    }
    const id = randomUUID();
    await tx.query(
      `INSERT INTO app.payment_refunds (id, payment_id, line_no, seq, amount_kop, points_centi, reason, outcome, ledger_posting_id, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [id, payment.id, line.lineNo, seq, amount, line.method === 'points' ? (line.pointsCenti ?? null) : null, reason, outcome, postingId, ctx.actor.staffId, now],
    );
    done.set(line.lineNo, { amountKop: prev.amountKop + amount, count: seq });
    refundIds.push(id);
    out.push({ lineNo: line.lineNo, method: line.method, amountKop: amount, pointsCenti: line.method === 'points' ? (line.pointsCenti ?? null) : null, outcome });
  }

  // 4) статусы: все строки закрыты → refunded (платёж «без оплаты» – тоже), иначе partially_refunded
  const full = payment.lines.every((l) => (done.get(l.lineNo)?.amountKop ?? 0) >= l.amountKop);
  const status = full ? 'refunded' : 'partially_refunded';
  await tx.query(`UPDATE app.payments SET status = $2 WHERE id = $1`, [payment.id, status]);
  await tx.query(`UPDATE app.payment_sessions SET status = $2, row_version = row_version + 1 WHERE booking_id = $1`, [session.id, status]);
  const after = (await lockSession(tx, session.id))!;

  await writeAudit(
    tx,
    meta,
    { action: 'payment.refunded', object: { type: 'payment', id: payment.id }, branchId: branch.id, cityId: branch.cityId, after: { refundIds, lines: out, status }, reason },
    clock,
  );
  const payload: PaymentRefundedPayload = {
    refundId: refundIds[0] ?? payment.id, paymentId: payment.id, bookingId: session.bookingId, clientId: session.clientId, lines: out, reason, sessionStatus: status,
  };
  await publish(tx, { type: 'payment.refunded', aggregateType: 'payment', aggregateId: payment.id, aggregateVersion: payload.refundId, branchId: branch.id, payload, occurredAt: now });
  return { refundIds, session: after };
}

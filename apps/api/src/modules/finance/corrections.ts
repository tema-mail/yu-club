// S2-13. Сторно, исправление и закрытие месяца (K17 §4, §6; 06 §4.4, §8; 18 §6.3 п.10).
// Сторно – обратная проводка K3 (reversePosting: у перевода между местами записей две) и операция kind='reversal'
// со ссылкой на исходную; исходная не меняется. Второе сторно – ALREADY_REVERSED (ловит UNIQUE reversal_of).
// Приход по сеансу – только возвратом платежа K10 (USE_PAYMENT_REFUND), от продажи сертификата – отменой продажи K16
// (USE_CERTIFICATE_CANCEL): иначе платёж или сертификат остались бы «живыми» без денег. Возврат (refund) не
// сторнируется – USE_PAYMENT_REFUND. Сторно датируется «сейчас»:
// исправление прошлого – операцией текущей датой (16 §14); уменьшение места денег – по правилу отрицательной кассы.
// Исправление = сторно + новая операция в одной транзакции. Закрытый месяц открыть нельзя (у yu_app нет UPDATE/DELETE).
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { writeAudit, type AuditAction, type AuditRequestMeta } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { reversePosting, type Tx } from '../../core/ledger.ts';
import type { AccessContext } from '../../core/permissions.ts';
import { parseLocalDate, systemClock, type LocalDate } from '../../core/time.ts';
import {
  assertNotNegative,
  assertPeriodOpen,
  authorOf,
  financeDenialOf,
  getOperation,
  guardFinance,
  insertOperation,
  lockPlaces,
  monthOf,
  OPERATION_SELECT,
  recordExpense,
  recordIncome,
  recordOpeningBalance,
  recordWithdrawal,
  requireComment,
  toOperationDto,
  transferBetweenPlaces,
  type CommandOpts,
  type FinanceOperationDto,
  type MoneyPlace,
  type OperationRow,
} from './cashbox.ts';

export { financeDenialOf };

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value ?? {});
  if (!r.success) {
    throw new AppError('VALIDATION_FAILED', 400, 'Неверные данные запроса', {
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}

const UUID = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const reverseSchema = z.object({ operationId: UUID, reason: z.string().max(2000).optional() });
const correctSchema = z.object({
  operationId: UUID,
  reason: z.string().max(2000).optional(),
  replacement: z.object({ kind: z.enum(['opening_balance', 'income', 'expense', 'withdrawal', 'place_transfer']) }).loose(),
});
const closeSchema = z.object({ branchId: UUID, month: z.string().regex(/^\d{4}-\d{2}$/) });

const revKey = (k: string) => `finance-rev:${k}`;

/** Изменение каждого места денег при сторно операции (обратное исходной). */
function reversalDeltas(op: FinanceOperationDto): Array<{ place: MoneyPlace; delta: number }> {
  if (op.kind === 'place_transfer') {
    return [
      { place: op.place, delta: op.amountKop },
      { place: op.place === 'cash' ? 'noncash' : 'cash', delta: -op.amountKop },
    ];
  }
  return [{ place: op.place, delta: op.direction === 'in' ? -op.amountKop : op.amountKop }];
}

/** Возврат refundIncome (K20 §6, K17 §14): ссылка на поступление мероприятия, доп. услуги или прочее – не K10 и не K16. */
async function isIncomeRefund(tx: Tx, op: FinanceOperationDto): Promise<boolean> {
  if (op.ref?.type !== 'operation') return false;
  const income = await getOperation(tx, op.ref.id);
  return income?.kind === 'income' && (income.source === 'event' || income.source === 'extra_service' || income.source === 'other');
}

/** Общая часть сторно и исправления: права, запреты по источнику, блокировка, перечитывание, проводка, аудит. */
async function reverseCore(
  tx: Tx,
  ctx: AccessContext,
  input: { operationId: string; reason?: string | undefined },
  meta: AuditRequestMeta,
  opts: CommandOpts & { auditAction: AuditAction },
): Promise<{ original: FinanceOperationDto; reversal: FinanceOperationDto; replayed: boolean }> {
  const clock = opts.clock ?? systemClock;
  const found = await getOperation(tx, input.operationId);
  if (!found) {
    // несуществующая – 404 до проверки роли, как чужая
    throw new AppError('NOT_FOUND', 404, 'Не найдено');
  }
  const branch = await guardFinance(tx, ctx, found.branchId, 'finance.correct', { action: opts.auditAction, operationId: found.id });
  const reason = requireComment(input.reason, 'reason');
  if (found.kind === 'reversal') throw new AppError('CANNOT_REVERSE_REVERSAL', 409, 'Сторно нельзя сторнировать');
  if (found.kind === 'refund' && !(await isIncomeRefund(tx, found))) {
    // возврат привязан к платежу K10 или продаже K16 – исправление корректировкой, не сторно (решение 02.11 внизу K17).
    // Возврат refundIncome (K20 §6) сторнируется: иначе поступление с возвратом осталось бы без сторно навсегда.
    throw new AppError('USE_PAYMENT_REFUND', 409, 'Возврат не сторнируется: исправление – корректировкой', { operationId: found.id });
  }
  if (found.kind === 'income' && found.source === 'session') {
    throw new AppError('USE_PAYMENT_REFUND', 409, 'Приход по сеансу исправляется возвратом платежа', { operationId: found.id });
  }
  if (found.kind === 'income' && found.source === 'certificate_sale') {
    throw new AppError('USE_CERTIFICATE_CANCEL', 409, 'Приход от продажи сертификата исправляется отменой продажи', { operationId: found.id });
  }

  const places = await lockPlaces(tx, branch.id);
  // перечитать под блокировкой: повтор по ключу, уже сторнирована
  const key = revKey(opts.idempotencyKey);
  const replay = await tx.query<OperationRow>(
    `${OPERATION_SELECT} WHERE fo.posting_id = (SELECT posting_id FROM journal.ledger_entries WHERE idempotency_key = $1)`,
    [`${key}#0`],
  );
  if (replay.rows[0]) {
    const reversal = toOperationDto(replay.rows[0]);
    if (reversal.reversalOf !== found.id) throw new AppError('IDEMPOTENCY_KEY_REUSED', 409, 'Ключ уже использован для другой операции');
    return { original: (await getOperation(tx, found.id))!, reversal, replayed: true };
  }
  const original = (await getOperation(tx, found.id))!;
  if (original.reversedBy) throw new AppError('ALREADY_REVERSED', 409, 'Операция уже сторнирована', { reversalId: original.reversedBy });
  // K20 §6: возврат не повисает без основания – сначала сторно возвратов. Проверка под lockPlaces: возврат берёт те же замки.
  if (original.kind === 'income') {
    const live = await tx.query<{ id: string }>(
      `SELECT fo.id FROM journal.finance_operations fo WHERE fo.kind = 'refund' AND fo.ref_type = 'operation' AND fo.ref_id = $1
         AND NOT EXISTS (SELECT 1 FROM journal.finance_operations r WHERE r.reversal_of = fo.id) ORDER BY fo.number`,
      [original.id],
    );
    if (live.rows.length > 0) throw new AppError('INCOME_HAS_REFUNDS', 409, 'По поступлению есть возвраты: сначала сторно возвратов', { refundIds: live.rows.map((x) => x.id) });
  }

  const now = clock.now();
  await assertPeriodOpen(tx, branch, now);
  for (const d of reversalDeltas(original)) await assertNotNegative(tx, branch.id, d.place, places[d.place], d.delta, now);

  const author = authorOf(ctx);
  const posting = await reversePosting(tx, { postingId: original.postingId, reason, idempotencyKey: key, author, occurredAt: now });
  const reversal = await insertOperation(tx, {
    id: randomUUID(),
    branchId: branch.id,
    kind: 'reversal',
    place: original.place,
    method: original.method,
    direction: original.direction === 'in' ? 'out' : 'in',
    amountKop: original.amountKop,
    source: null,
    categoryId: null,
    subcategoryId: null,
    comment: reason,
    ref: { type: 'operation', id: original.id },
    receiptIssued: null,
    occurredAt: now,
    author,
    postingId: posting.postingId,
    reversalOf: original.id,
  });
  if (original.kind === 'opening_balance') {
    await tx.query(`UPDATE app.finance_opening_balances SET status = 'reversed' WHERE operation_id = $1 AND status = 'active'`, [original.id]);
  }
  if (opts.auditAction === 'finance.operation.reversed') {
    await writeAudit(
      tx,
      meta,
      {
        action: 'finance.operation.reversed',
        object: { type: 'finance_operation', id: original.id },
        branchId: branch.id,
        cityId: branch.cityId,
        after: { reversalId: reversal.id, number: reversal.number },
        reason,
      },
      clock,
    );
  }
  return { original, reversal, replayed: false };
}

/** K17 №44: сторно операции (право finance.correct). Повтор с тем же ключом – то же сторно. */
export async function reverseOperation(tx: Tx, ctx: AccessContext, raw: unknown, meta: AuditRequestMeta, opts: CommandOpts): Promise<FinanceOperationDto> {
  const input = parse(reverseSchema, raw);
  return (await reverseCore(tx, ctx, input, meta, { ...opts, auditAction: 'finance.operation.reversed' })).reversal;
}

const REPLACE = {
  opening_balance: recordOpeningBalance,
  income: recordIncome,
  expense: recordExpense,
  withdrawal: recordWithdrawal,
  place_transfer: transferBetweenPlaces,
} as const;

/** K17 №45: исправление = сторно + новая операция того же филиала в одной транзакции (06 §8: хранит старое и новое).
 *  Новая проходит все правила своей ручной формы (категория, комментарий, сеанс – только оплатой). */
export async function correctOperation(
  tx: Tx,
  ctx: AccessContext,
  raw: unknown,
  meta: AuditRequestMeta,
  opts: CommandOpts,
): Promise<{ reversal: FinanceOperationDto; replacement: FinanceOperationDto }> {
  const clock = opts.clock ?? systemClock;
  const input = parse(correctSchema, raw);
  // Ключ сторно в исправлении – свой (`finance-rev:correct:<key>`): тот же HTTP-ключ сторно №44 не выдаётся за повтор.
  const { original, reversal, replayed } = await reverseCore(tx, ctx, input, meta, {
    ...opts,
    idempotencyKey: `correct:${opts.idempotencyKey}`,
    auditAction: 'finance.operation.corrected',
  });
  const { kind, ...body } = input.replacement;
  const replacement = await REPLACE[kind](tx, ctx, { ...body, branchId: original.branchId }, meta, { idempotencyKey: `${opts.idempotencyKey}:replacement`, clock });
  if (!replayed) {
    await writeAudit(
      tx,
      meta,
      {
        action: 'finance.operation.corrected',
        object: { type: 'finance_operation', id: original.id },
        branchId: original.branchId,
        after: { reversalId: reversal.id, replacementId: replacement.id },
        reason: reversal.comment,
      },
      clock,
    );
  }
  return { reversal, replacement };
}

export interface ClosedPeriod {
  branchId: string;
  month: LocalDate;
  closedAt: string;
  closedBy: string;
}

/** K17 №47: закрыть прошедший месяц филиала (Q-28 по умолчанию – Владелец). Повторно – PERIOD_CLOSED.
 *  Блокировка мест денег – та же, что у операций: операция того месяца не проскочит между проверкой и закрытием. */
export async function closeMonth(tx: Tx, ctx: AccessContext, raw: unknown, meta: AuditRequestMeta, opts: Omit<CommandOpts, 'idempotencyKey'>): Promise<ClosedPeriod> {
  const clock = opts.clock ?? systemClock;
  const input = parse(closeSchema, raw);
  const branch = await guardFinance(tx, ctx, input.branchId, 'finance.period.close', { action: 'finance.period.closed' });
  const month = parseLocalDate(`${input.month}-01`);
  const now = clock.now();
  if (month >= monthOf(now, branch)) {
    throw new AppError('VALIDATION_FAILED', 400, 'Закрыть можно только прошедший месяц', { field: 'month' });
  }
  await lockPlaces(tx, branch.id);
  const prev = await tx.query<{ closed_at: Date }>('SELECT closed_at FROM app.finance_periods WHERE branch_id = $1 AND month = $2', [branch.id, month]);
  if (prev.rows[0]) throw new AppError('PERIOD_CLOSED', 409, 'Месяц уже закрыт', { month, closedAt: prev.rows[0].closed_at.toISOString() });
  await tx.query('INSERT INTO app.finance_periods (branch_id, month, closed_at, closed_by) VALUES ($1, $2, $3, $4)', [branch.id, month, now, ctx.actor.staffId]);
  await writeAudit(
    tx,
    meta,
    { action: 'finance.period.closed', object: { type: 'branch', id: branch.id }, branchId: branch.id, cityId: branch.cityId, after: { month } },
    clock,
  );
  return { branchId: branch.id, month, closedAt: now.toISOString(), closedBy: ctx.actor.staffId };
}

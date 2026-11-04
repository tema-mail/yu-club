// S3-05. Связи операций кассы с объектами Э3 (K17 §14): мероприятие (K20), ремонт (K19), ведомость зарплаты (K18).
// Одна операция – не больше одной живой связи: гарантия – частичный уникальный индекс finance_operation_links_one_live
// (0301), код только переводит 23505 в OPERATION_ALREADY_LINKED. Связь не меняет ни одного остатка и ни одной суммы
// сводки кассы (касса = операции, K17 §9). Сторно операции связь само не гасит: linksOf отдаёт только живые операции.
// Порядок блокировок – как во всём Э2: места денег филиала одним lockAccounts (lockPlaces) до чтения связей; сторно
// (corrections.ts) берёт те же блокировки, поэтому «привязать ↔ сторнировать» не проходят мимо друг друга.
// Межмодульный вызов – только этими функциями (ADR 0002); другие модули таблицу связей не пишут.
import { z } from 'zod';
import { writeAudit, type AuditRequestMeta, type Db } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import type { Tx } from '../../core/ledger.ts';
import { can, type AccessContext } from '../../core/permissions.ts';
import { systemClock, type Clock } from '../../core/time.ts';
import { getBranch } from '../network/index.ts';
import {
  getOperation,
  guardFinance,
  lockPlaces,
  OPERATION_SELECT,
  postMoneyOperation,
  recordExpense,
  recordIncome,
  requireComment,
  toOperationDto,
  type CommandOpts,
  type FinanceOperationDto,
  type OperationKind,
  type OperationMethod,
  type OperationRow,
} from './cashbox.ts';

export type LinkRefType = 'event' | 'repair' | 'payroll_statement';
export interface LinkRef {
  type: LinkRefType;
  id: string;
}
export type LinkRole = 'income' | 'refund' | 'expense' | 'payout_expense';
export interface LinkInput {
  operationId: string;
  ref: LinkRef;
  role: LinkRole;
  /** Только role='expense' у мероприятия: расход в себестоимость (K20 §6). */
  inCost?: boolean;
  /** Строка состава мероприятия (K20 §6); FK добавит 0305. */
  lineId?: string | null;
}
export interface OperationLink {
  operation: FinanceOperationDto;
  role: LinkRole;
  inCost: boolean;
  lineId: string | null;
  linkedAt: string;
}

const ROLE_KIND: Readonly<Record<LinkRole, OperationKind>> = { income: 'income', refund: 'refund', expense: 'expense', payout_expense: 'expense' };
/** Поступления, которые связываются и возвращаются здесь; сеанс – только K10, продажа сертификата – только K16. */
const OWN_INCOME = new Set(['event', 'extra_service', 'other']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const notFound = () => new AppError('NOT_FOUND', 404, 'Не найдено');
const invalidLink = (message: string, reason: string) => new AppError('OPERATION_LINK_INVALID', 422, message, { reason });

/** Филиал операции в зоне сотрудника; право на сам объект (event.money.record, repair.expense.create, …) проверяет
 *  вызывающий модуль. Вне зоны – 404. */
function assertZone(ctx: AccessContext, branchId: string): void {
  if (!can(ctx, 'finance.view.day', { branchId })) throw notFound();
}

interface LinkRow {
  id: string;
  ref_type: LinkRefType;
  ref_id: string;
  role: LinkRole;
}

async function liveLink(tx: Db, operationId: string): Promise<LinkRow | null> {
  const r = await tx.query<LinkRow>(
    `SELECT id, ref_type, ref_id, role FROM app.finance_operation_links WHERE operation_id = $1 AND unlinked_at IS NULL`,
    [operationId],
  );
  return r.rows[0] ?? null;
}

function alreadyLinked(row: LinkRow): AppError {
  return new AppError('OPERATION_ALREADY_LINKED', 409, 'Операция уже связана с другим объектом', { ref: { type: row.ref_type, id: row.ref_id }, role: row.role });
}

/** Связать операцию с объектом (K17 §14). Повтор той же связи (тот же объект и роль) – без изменений. */
export async function linkOperation(tx: Tx, ctx: AccessContext, input: LinkInput, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<void> {
  if (!UUID_RE.test(input.operationId) || !UUID_RE.test(input.ref.id)) throw notFound();
  const found = await getOperation(tx, input.operationId);
  if (!found) throw notFound();
  assertZone(ctx, found.branchId);
  if (input.inCost && input.role !== 'expense') throw invalidLink('В себестоимость – только расход', 'in_cost');
  if (input.lineId != null && input.ref.type !== 'event') throw invalidLink('Строка состава – только у мероприятия', 'line_id');

  await lockPlaces(tx, found.branchId);
  const op = (await getOperation(tx, found.id))!; // перечитать под блокировкой: сторно могло пройти между чтениями
  const existing = await liveLink(tx, op.id);
  if (existing) {
    if (existing.ref_type === input.ref.type && existing.ref_id === input.ref.id && existing.role === input.role) return;
    throw alreadyLinked(existing);
  }
  if (ROLE_KIND[input.role] !== op.kind) throw invalidLink(`Роль ${input.role} не подходит к операции вида ${op.kind}`, 'role');
  if (op.kind === 'income' && !OWN_INCOME.has(op.source ?? '')) throw invalidLink('Приход по сеансу и продаже сертификата не привязывается', 'source');
  if (op.reversedBy) throw invalidLink('Операция сторнирована', 'reversed');

  const now = clock.now();
  const linkedBy = ctx.actor.staffId;
  try {
    await tx.query('SAVEPOINT finance_link');
    await tx.query(
      `INSERT INTO app.finance_operation_links (operation_id, branch_id, ref_type, ref_id, role, in_cost, line_id, linked_by, linked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [op.id, op.branchId, input.ref.type, input.ref.id, input.role, input.inCost ?? false, input.lineId ?? null, linkedBy, now],
    );
    await tx.query('RELEASE SAVEPOINT finance_link');
  } catch (err) {
    await tx.query('ROLLBACK TO SAVEPOINT finance_link');
    if ((err as { code?: string }).code === '23505') {
      const row = await liveLink(tx, op.id);
      if (row) throw alreadyLinked(row);
    }
    throw err;
  }
  const branch = await getBranch(tx, op.branchId);
  await writeAudit(
    tx,
    meta,
    {
      action: 'finance.operation.linked',
      object: { type: 'finance_operation', id: op.id },
      branchId: op.branchId,
      cityId: branch?.cityId ?? null,
      after: { ref: input.ref, role: input.role, inCost: input.inCost ?? false, lineId: input.lineId ?? null },
    },
    clock,
  );
}

/** Создать операцию и связь в одной транзакции: ручные формы кассы с их правами (finance.income.create /
 *  finance.expense.create в филиале операции) и правилами; повтор с тем же ключом – та же операция и та же связь. */
export async function createLinkedOperation(
  tx: Tx,
  ctx: AccessContext,
  input: { kind: 'income' | 'expense'; operation: Record<string, unknown>; link: Omit<LinkInput, 'operationId'> },
  meta: AuditRequestMeta,
  opts: CommandOpts,
): Promise<FinanceOperationDto> {
  if (ROLE_KIND[input.link.role] !== input.kind) throw invalidLink(`Роль ${input.link.role} не подходит к операции вида ${input.kind}`, 'role');
  const op = input.kind === 'income' ? await recordIncome(tx, ctx, input.operation, meta, opts) : await recordExpense(tx, ctx, input.operation, meta, opts);
  await linkOperation(tx, ctx, { ...input.link, operationId: op.id }, meta, opts.clock);
  return op;
}

interface LinkedRow extends OperationRow {
  link_role: LinkRole;
  link_in_cost: boolean;
  link_line_id: string | null;
  link_linked_at: Date;
}

/** Живые связи объекта; сторнированные операции исключены (reversedBy != null). Порядок – по номеру операции. */
export async function linksOf(db: Db, ref: LinkRef): Promise<OperationLink[]> {
  if (!UUID_RE.test(ref.id)) return [];
  const r = await db.query<LinkedRow>(
    `SELECT l.role AS link_role, l.in_cost AS link_in_cost, l.line_id AS link_line_id, l.linked_at AS link_linked_at, x.*
       FROM app.finance_operation_links l JOIN (${OPERATION_SELECT}) x ON x.id = l.operation_id
      WHERE l.ref_type = $1 AND l.ref_id = $2 AND l.unlinked_at IS NULL AND x.reversed_by IS NULL
      ORDER BY x.number`,
    [ref.type, ref.id],
  );
  return r.rows.map((row) => ({
    operation: toOperationDto(row),
    role: row.link_role,
    inCost: row.link_in_cost,
    lineId: row.link_line_id,
    linkedAt: row.link_linked_at.toISOString(),
  }));
}

/** Отвязать ошибочную связь (право finance.correct): unlinked_at + причина; операция и её суммы не меняются. */
export async function unlink(
  tx: Tx,
  ctx: AccessContext,
  input: { operationId: string; reason: string },
  meta: AuditRequestMeta,
  clock: Clock = systemClock,
): Promise<void> {
  if (!UUID_RE.test(input.operationId)) throw notFound();
  const op = await getOperation(tx, input.operationId);
  if (!op) throw notFound();
  const branch = await guardFinance(tx, ctx, op.branchId, 'finance.correct', { action: 'finance.operation.unlinked', operationId: op.id });
  const reason = requireComment(input.reason, 'reason');
  await lockPlaces(tx, op.branchId);
  const r = await tx.query<LinkRow>(
    `UPDATE app.finance_operation_links SET unlinked_at = $2, unlinked_by = $3, unlink_reason = $4
      WHERE operation_id = $1 AND unlinked_at IS NULL RETURNING id, ref_type, ref_id, role`,
    [op.id, clock.now(), ctx.actor.staffId, reason],
  );
  const row = r.rows[0];
  if (!row) throw notFound();
  await writeAudit(
    tx,
    meta,
    {
      action: 'finance.operation.unlinked',
      object: { type: 'finance_operation', id: op.id },
      branchId: op.branchId,
      cityId: branch.cityId,
      before: { ref: { type: row.ref_type, id: row.ref_id }, role: row.role },
      reason,
    },
    clock,
  );
}

const refundSchema = z.object({
  incomeOperationId: z.string().regex(UUID_RE),
  amountKop: z.number(),
  method: z.enum(['cash', 'card', 'transfer']),
  reason: z.string().max(2000).optional(),
});

/** Возврат по поступлению мероприятия или прочему (K17 §14, K20 §6): операция refund своим способом, ссылка на
 *  поступление; Σ живых возвратов ≤ поступления – под блокировкой мест денег. Право – finance.refund (Владелец, Директор).
 *  Если у поступления есть живая связь, возврат связывается с тем же объектом (role 'refund'). */
export async function refundIncome(tx: Tx, ctx: AccessContext, raw: unknown, meta: AuditRequestMeta, opts: CommandOpts): Promise<FinanceOperationDto> {
  const clock = opts.clock ?? systemClock;
  const parsed = refundSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', 400, 'Неверные данные запроса', {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  const input = parsed.data;
  const found = await getOperation(tx, input.incomeOperationId);
  if (!found) throw notFound();
  const branch = await guardFinance(tx, ctx, found.branchId, 'finance.refund', { action: 'finance.operation.created', operationId: found.id });
  if (found.kind !== 'income') throw invalidLink('Возврат – только по поступлению', 'kind');
  if (found.source === 'session') throw new AppError('USE_PAYMENT_REFUND', 409, 'Приход по сеансу возвращается возвратом платежа', { operationId: found.id });
  if (found.source === 'certificate_sale') {
    throw new AppError('USE_CERTIFICATE_CANCEL', 409, 'Приход от продажи сертификата возвращается отменой продажи', { operationId: found.id });
  }
  const reason = requireComment(input.reason, 'reason');
  if (!Number.isSafeInteger(input.amountKop) || input.amountKop <= 0) throw new AppError('INVALID_AMOUNT', 422, 'Сумма – целое число копеек больше нуля');

  await lockPlaces(tx, branch.id);
  const key = `finance-op:${opts.idempotencyKey}`;
  const replay = await tx.query<OperationRow>(
    `${OPERATION_SELECT} WHERE fo.posting_id = (SELECT posting_id FROM journal.ledger_entries WHERE idempotency_key = $1)`,
    [`${key}#0`],
  );
  if (replay.rows[0]) {
    const prev = toOperationDto(replay.rows[0]);
    if (prev.kind !== 'refund' || prev.ref?.id !== found.id || prev.amountKop !== input.amountKop) {
      throw new AppError('IDEMPOTENCY_KEY_REUSED', 409, 'Ключ уже использован для другой операции', { idempotencyKey: opts.idempotencyKey });
    }
    return prev;
  }
  // перечитать под блокировкой: поступление могли сторнировать, возвраты – провести параллельно
  const income = (await getOperation(tx, found.id))!;
  if (income.reversedBy) throw new AppError('OPERATION_REVERSED', 409, 'Поступление сторнировано', { operationId: income.id, reversalId: income.reversedBy });
  const done = await tx.query<{ sum: string }>(
    `SELECT coalesce(sum(fo.amount_kop), 0)::text AS sum FROM journal.finance_operations fo
      WHERE fo.kind = 'refund' AND fo.ref_type = 'operation' AND fo.ref_id = $1
        AND NOT EXISTS (SELECT 1 FROM journal.finance_operations r WHERE r.reversal_of = fo.id)`,
    [income.id],
  );
  const availableKop = income.amountKop - Number(done.rows[0]!.sum);
  if (input.amountKop > availableKop) {
    throw new AppError('EVENT_REFUND_EXCEEDS_INCOME', 409, 'Возврат больше поступления', { availableKop, operationId: income.id });
  }
  const method: OperationMethod = input.method;
  const refund = await postMoneyOperation(
    tx,
    ctx,
    {
      branchId: branch.id,
      kind: 'refund',
      place: method === 'cash' ? 'cash' : 'noncash',
      method,
      amountKop: input.amountKop,
      comment: reason,
      ref: { type: 'operation', id: income.id },
      occurredAt: clock.now(),
    },
    { idempotencyKey: key },
    meta,
    clock,
  );
  const link = await liveLink(tx, income.id);
  if (link) await linkOperation(tx, ctx, { operationId: refund.id, ref: { type: link.ref_type, id: link.ref_id }, role: 'refund' }, meta, clock);
  return refund;
}

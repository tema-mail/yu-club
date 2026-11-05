// S3-38. K19 §10, K17 §14: расход на ремонт – одна операция кассы, связанная с ремонтом через finance_operation_links, без двойного учёта.
// createRepairExpense – K17 recordExpense со связью в той же транзакции (кнопка с подтверждением, 10 §9.3); linkRepairExpense – расход
// уже внесён вручную, новой операции нет. Статус оплаты вычисляется из живых связей (repairs.ts repairPayment): своих денежных полей нет.
// Плательщик – другой филиал зоны (Q-120): право repair.expense.create в филиале ремонта и finance.expense.create в филиале-плательщике.
import { z } from 'zod';
import { writeAudit, type AuditRequestMeta, type Db } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import type { Tx } from '../../core/ledger.ts';
import { can, type AccessContext } from '../../core/permissions.ts';
import { systemClock, type Clock } from '../../core/time.ts';
import type { FinanceOperationDto } from '../finance/cashbox.ts';
import { createLinkedOperation, linkOperation, linksOf } from '../finance/links.ts';
import { denyWith, forbidden, guard, notFound, parseInput, UUID_RE } from './items.ts';
import { lockRepair, type RepairRow } from './repairs.ts';

const uuid = z.string().regex(UUID_RE);
const createSchema = z.strictObject({
  branchId: uuid,
  method: z.enum(['cash', 'card', 'transfer']),
  amountKop: z.number(),
  subcategoryId: uuid.nullish(),
  occurredAt: z.iso.datetime({ offset: true }),
  comment: z.string().trim().max(2000).optional(),
});
const linkSchema = z.strictObject({ operationId: uuid });

/** Категория «Ремонт и обслуживание», подкатегория по умолчанию «Оборудование» (посев 0202, K19 §10); своя подкатегория – её родитель. */
async function expenseCategory(db: Db, subcategoryId: string | null | undefined): Promise<{ categoryId: string; subcategoryId: string | null }> {
  if (subcategoryId) {
    const r = await db.query<{ parent_id: string | null }>(`SELECT parent_id FROM app.finance_categories WHERE id = $1 AND kind = 'expense'`, [subcategoryId]);
    if (!r.rows[0]?.parent_id) throw new AppError('VALIDATION_FAILED', 400, 'Неизвестная подкатегория расхода', { field: 'subcategoryId' });
    return { categoryId: r.rows[0].parent_id, subcategoryId };
  }
  const r = await db.query<{ category_id: string; subcategory_id: string | null }>(
    `SELECT p.id AS category_id, s.id AS subcategory_id FROM app.finance_categories p
       LEFT JOIN app.finance_categories s ON s.parent_id = p.id AND s.name = 'Оборудование' AND s.status = 'active'
      WHERE p.kind = 'expense' AND p.parent_id IS NULL AND p.name = 'Ремонт и обслуживание' AND p.status = 'active'`,
  );
  const found = r.rows[0];
  if (!found) throw new AppError('VALIDATION_FAILED', 400, 'Нет категории «Ремонт и обслуживание» – выберите подкатегорию', { field: 'subcategoryId' });
  return { categoryId: found.category_id, subcategoryId: found.subcategory_id };
}

async function loadRepair(tx: Tx, ctx: AccessContext, repairId: string): Promise<RepairRow> {
  const row = await lockRepair(tx, repairId);
  if (!row) throw notFound();
  guard(ctx, row.branch_id, 'repair.expense.create', { action: 'repair.expense_linked', object: { type: 'repair', id: row.id } });
  if (row.status === 'cancelled') throw new AppError('REPAIR_TRANSITION_INVALID', 409, 'Отменённый ремонт расходов не имеет', { status: row.status });
  if (row.no_cost) throw new AppError('REPAIR_TRANSITION_INVALID', 409, 'Ремонт закрыт без затрат', { status: row.status });
  return row;
}

const isLinked = async (db: Db, repairId: string, operationId: string): Promise<boolean> => (await linksOf(db, { type: 'repair', id: repairId })).some((l) => l.operation.id === operationId);

/** Повтор с тем же ключом (двойной клик) – та же операция и та же связь: идемпотентность K17 + no-op linkOperation. */
export async function createRepairExpense(
  tx: Tx,
  ctx: AccessContext,
  repairId: string,
  raw: unknown,
  meta: AuditRequestMeta,
  opts: { idempotencyKey: string; clock?: Clock },
): Promise<FinanceOperationDto> {
  const clock = opts.clock ?? systemClock;
  const row = await loadRepair(tx, ctx, repairId);
  const input = parseInput(createSchema, raw);
  if (!can(ctx, 'finance.expense.create', { branchId: input.branchId })) {
    denyWith(forbidden('finance.expense.create'), { action: 'repair.expense_linked', object: { type: 'repair', id: row.id }, branchId: input.branchId }, 'finance.expense.create');
  }
  const category = await expenseCategory(tx, input.subcategoryId);
  const before = new Set((await linksOf(tx, { type: 'repair', id: row.id })).map((l) => l.operation.id));
  const op = await createLinkedOperation(
    tx,
    ctx,
    {
      kind: 'expense',
      operation: {
        branchId: input.branchId,
        method: input.method,
        amountKop: input.amountKop,
        categoryId: category.categoryId,
        subcategoryId: category.subcategoryId,
        occurredAt: input.occurredAt,
        comment: input.comment || `Ремонт ${row.number}`,
        ref: { type: 'repair', id: row.id },
      },
      link: { ref: { type: 'repair', id: row.id }, role: 'expense' },
    },
    meta,
    { idempotencyKey: opts.idempotencyKey, clock },
  );
  if (!before.has(op.id)) {
    await writeAudit(tx, meta, { action: 'repair.expense_linked', object: { type: 'repair', id: row.id }, branchId: row.branch_id, after: { operationId: op.id, amountKop: op.amountKop, payerBranchId: op.branchId, created: true } }, clock);
  }
  return op;
}

/** Расход уже в кассе: связь без новой операции (10 §9.1 «не дублировать»). Занятая операция – OPERATION_ALREADY_LINKED; вид и сторно проверяет K17 §14. */
export async function linkRepairExpense(tx: Tx, ctx: AccessContext, repairId: string, raw: unknown, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<void> {
  const row = await loadRepair(tx, ctx, repairId);
  const input = parseInput(linkSchema, raw);
  const already = await isLinked(tx, row.id, input.operationId);
  await linkOperation(tx, ctx, { operationId: input.operationId, ref: { type: 'repair', id: row.id }, role: 'expense' }, meta, clock);
  if (!already) await writeAudit(tx, meta, { action: 'repair.expense_linked', object: { type: 'repair', id: row.id }, branchId: row.branch_id, after: { operationId: input.operationId, created: false } }, clock);
}

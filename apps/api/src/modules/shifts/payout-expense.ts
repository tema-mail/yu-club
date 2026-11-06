// S3-19. Расход кассы при выплате (K18 §9, TC-19, R-15): автоматического расхода нет – кнопка после paid. Запись – только через K17 (recordExpense,
// finance/links.ts), двойного учёта нет: живая связь payout_expense у ведомости → PAYOUT_EXPENSE_EXISTS. Сторно расхода в кассе связь гасит (linksOf
// отдаёт только живые операции), расход можно создать заново. Порядок блокировок: строка ведомости (две разные формы одной выплаты не пройдут мимо
// друг друга) → один lockAccounts по местам денег всех филиалов разбивки, отсортированным по id (иначе две выплаты с пересекающимися филиалами
// ловят взаимную блокировку).
import { z } from 'zod';
import { writeAudit, type AuditRequestMeta, type Db } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { ensureAccount, lockAccounts, type Tx } from '../../core/ledger.ts';
import { assertCan, roleAllows, type AccessContext } from '../../core/permissions.ts';
import { systemClock, type Clock } from '../../core/time.ts';
import { PLACE_ACCOUNT, getOperation, type FinanceOperationDto } from '../finance/cashbox.ts';
import { createLinkedOperation, linkOperation, linksOf } from '../finance/links.ts';
import type { BranchLine, PayrollTotals } from './payroll.ts';
import { isUuid, notFound } from './rates.ts';

const REF = (id: string) => ({ type: 'payroll_statement' as const, id });

export interface SplitPart {
  branchId: string;
  amountKop: number;
}

/** По филиалам: пропорционально начисленному, остаток копеек – филиалу с наибольшей долей; сумма частей = toPayKop (Q-109). */
export function splitByBranch(toPayKop: number, lines: BranchLine[]): SplitPart[] {
  const base = lines.filter((l) => l.accruedKop > 0).sort((a, b) => b.accruedKop - a.accruedKop || (a.branchId < b.branchId ? -1 : 1));
  const total = base.reduce((s, l) => s + l.accruedKop, 0);
  if (total === 0) return [];
  const parts = base.map((l) => ({ branchId: l.branchId, amountKop: Math.floor((toPayKop * l.accruedKop) / total) }));
  parts[0]!.amountKop += toPayKop - parts.reduce((s, p) => s + p.amountKop, 0);
  return parts.filter((p) => p.amountKop > 0);
}

interface StatementRow {
  id: string;
  staff_id: string;
  status: string;
  totals: PayrollTotals & { byBranch?: BranchLine[] };
}

/** Строка ведомости FOR UPDATE: сначала зона (вне её – 404) и право (403), статус и сумма – только после них; расход – только после paid. */
async function lockPaidStatement(tx: Tx, ctx: AccessContext, id: string): Promise<StatementRow> {
  if (!isUuid(id)) throw notFound();
  const r = await tx.query<StatementRow>(`SELECT id, staff_id, status, totals FROM app.payroll_statements WHERE id = $1 FOR UPDATE`, [id]);
  const row = r.rows[0];
  if (!row) throw notFound();
  if (!ctx.network && !(row.totals.byBranch ?? []).some((l) => ctx.branchIds.has(l.branchId))) throw notFound();
  if (!roleAllows(ctx.role, 'payroll.payout.expense')) throw new AppError('FORBIDDEN', 403, 'Недостаточно прав', { action: 'payroll.payout.expense' });
  if (row.status !== 'paid') throw new AppError('VALIDATION_FAILED', 400, 'Расход создаётся только после отметки «Выплачен»', { reason: 'statement_not_paid', status: row.status });
  return row;
}

async function assertNoLiveExpense(db: Db, statementId: string): Promise<void> {
  const live = await linksOf(db, REF(statementId));
  const ops = live.filter((l) => l.role === 'payout_expense').map((l) => l.operation.id);
  if (ops.length > 0) throw new AppError('PAYOUT_EXPENSE_EXISTS', 409, 'Расход по этой выплате уже создан', { operationIds: ops });
}

/** Места денег всех филиалов – один вызов lockAccounts в порядке id. */
async function lockAllPlaces(tx: Tx, branchIds: string[]): Promise<void> {
  const ids: string[] = [];
  for (const branchId of [...new Set(branchIds)].sort()) {
    for (const place of ['cash', 'noncash'] as const) {
      ids.push((await ensureAccount(tx, { kind: PLACE_ACCOUNT[place], ownerType: 'branch', ownerId: branchId }, { unit: 'RUB_KOP', branchId, minBalance: null })).id);
    }
  }
  await lockAccounts(tx, ids);
}

async function salaryCategory(db: Db): Promise<{ categoryId: string; subcategoryId: string }> {
  const r = await db.query<{ id: string; parent_id: string }>(`SELECT id, parent_id FROM app.finance_categories WHERE code = 'salary'`);
  const row = r.rows[0];
  if (!row) throw new Error('payout-expense: нет категории с кодом salary (0312)');
  return { categoryId: row.parent_id, subcategoryId: row.id };
}

const schema = z.object({
  place: z.enum(['cash', 'noncash']),
  method: z.enum(['cash', 'card', 'transfer']),
  split: z.union([z.literal('by_branch'), z.object({ branchId: z.string() })]).default('by_branch'),
  occurredAt: z.string(),
  comment: z.string().max(2000).nullish(),
});

export async function createPayoutExpense(
  tx: Tx,
  ctx: AccessContext,
  statementId: string,
  raw: unknown,
  meta: AuditRequestMeta,
  opts: { idempotencyKey: string; clock?: Clock },
): Promise<{ operations: FinanceOperationDto[] }> {
  const clock = opts.clock ?? systemClock;
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', 400, 'Неверные данные запроса', { issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  const input = parsed.data;
  if ((input.method === 'cash') !== (input.place === 'cash')) throw new AppError('VALIDATION_FAILED', 400, 'Способ не подходит к месту денег', { field: 'method' });

  const row = await lockPaidStatement(tx, ctx, statementId);
  const toPay = Number(row.totals.toPayKop ?? 0);
  if (toPay <= 0) throw new AppError('VALIDATION_FAILED', 400, 'По ведомости нет выплаты: расход не нужен', { reason: 'nothing_paid', toPayKop: toPay });
  let parts: SplitPart[];
  if (input.split === 'by_branch') {
    parts = splitByBranch(toPay, row.totals.byBranch ?? []);
    if (parts.length === 0) throw new AppError('BRANCH_REQUIRED', 422, 'В ведомости нет начислений по филиалам: выберите филиал расхода');
  } else {
    if (!isUuid(input.split.branchId)) throw notFound();
    parts = [{ branchId: input.split.branchId, amountKop: toPay }];
  }
  for (const p of parts) assertCan(ctx, 'payroll.payout.expense', { branchId: p.branchId });
  await lockAllPlaces(tx, parts.map((p) => p.branchId));
  await assertNoLiveExpense(tx, row.id);

  const category = await salaryCategory(tx);
  const operations: FinanceOperationDto[] = [];
  for (const p of parts) {
    operations.push(
      await createLinkedOperation(
        tx,
        ctx,
        {
          kind: 'expense',
          operation: {
            branchId: p.branchId,
            method: input.method,
            amountKop: p.amountKop,
            ...category,
            occurredAt: input.occurredAt,
            comment: input.comment?.trim() || 'Выплата зарплаты',
            ref: { type: 'staff', id: row.staff_id },
          },
          link: { ref: REF(row.id), role: 'payout_expense' },
        },
        meta,
        { idempotencyKey: `${opts.idempotencyKey}:${p.branchId}`, clock },
      ),
    );
  }
  await writeAudit(tx, meta, { action: 'payroll.payout_expense.created', object: { type: 'payroll_statement', id: row.id }, after: { operationIds: operations.map((o) => o.id), parts } }, clock);
  return { operations };
}

const linkSchema = z.object({ operationIds: z.array(z.string()).min(1).max(50) });

/** Привязать ручной расход «Зарплата», внесённый в кассе раньше: только подкатегория с кодом salary, сумма должна совпасть, второго расхода нет (K18 §9). */
export async function linkPayoutExpense(tx: Tx, ctx: AccessContext, statementId: string, raw: unknown, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<{ operations: FinanceOperationDto[] }> {
  const parsed = linkSchema.safeParse(raw ?? {});
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', 400, 'Нужен список операций operationIds');
  const row = await lockPaidStatement(tx, ctx, statementId);
  const { subcategoryId: salaryId } = await salaryCategory(tx);
  const found: FinanceOperationDto[] = [];
  for (const id of [...new Set(parsed.data.operationIds)]) {
    const op = await getOperation(tx, id);
    if (!op) throw notFound();
    assertCan(ctx, 'payroll.payout.expense', { branchId: op.branchId });
    if (op.subcategoryId !== salaryId) throw new AppError('OPERATION_LINK_INVALID', 422, 'Привязать можно только расход категории «Персонал» – «Зарплата»', { reason: 'category', operationId: op.id });
    found.push(op);
  }
  await lockAllPlaces(tx, found.map((o) => o.branchId));
  await assertNoLiveExpense(tx, row.id);
  const toPay = Number(row.totals.toPayKop ?? 0);
  const sum = found.reduce((s, o) => s + o.amountKop, 0);
  if (sum !== toPay) throw new AppError('PAYOUT_AMOUNT_MISMATCH', 422, 'Сумма расхода не совпадает с выплатой', { toPayKop: toPay, amountKop: sum });
  for (const op of found) await linkOperation(tx, ctx, { operationId: op.id, ref: REF(row.id), role: 'payout_expense' }, meta, clock);
  await writeAudit(tx, meta, { action: 'payroll.payout_expense.linked', object: { type: 'payroll_statement', id: row.id }, after: { operationIds: found.map((o) => o.id) } }, clock);
  return { operations: found };
}

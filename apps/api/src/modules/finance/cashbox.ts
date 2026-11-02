// S2-11. Ядро кассы филиала (K17 §2–§4, §6): два места денег на счетах K3 (наличные cash_branch, безнал
// cash_branch_noncash), postMoneyOperation – единственная запись денег, в том числе для чужих модулей (K10 оплата,
// K16 продажа сертификата), и ручные команды CRM: начальный остаток, доход, расход, изъятие, перевод между местами.
// Порядок в транзакции команды: оба места денег филиала (и связанные счета) – lockAccounts в порядке id →
// перечитать (повтор по ключу, закрытый месяц, остаток, начальный остаток) → проверить → K3 post → finance_operations →
// аудит. Отрицательный остаток – в коде под блокировкой по finance.negative_balance_allowed, не min_balance счёта
// (K17 §6). Внешних вызовов в транзакции нет. Транзакцию открывает вызывающий.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { writeAudit, type AuditAction, type AuditRequestMeta, type Db } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { ensureAccount, lockAccounts, post, type Account, type AccountKind, type EntryInput, type EntryType, type RefType, type Tx } from '../../core/ledger.ts';
import { can, type AccessContext } from '../../core/permissions.ts';
import { resolveSetting } from '../../core/settings.ts';
import { instantToLocal, localToInstant, parseLocalDate, systemClock, type Clock, type LocalDate, type LocalTime } from '../../core/time.ts';
import { getBranch, type BranchInfo } from '../network/index.ts';
import { assertExpenseCategory, type Denial } from './categories.ts';

// ---- типы K17 §3

export type MoneyPlace = 'cash' | 'noncash';
export type OperationKind = 'opening_balance' | 'income' | 'expense' | 'withdrawal' | 'place_transfer' | 'refund' | 'correction' | 'reversal';
export type OperationMethod = 'cash' | 'card' | 'transfer';
export type IncomeSource = 'session' | 'certificate_sale' | 'event' | 'extra_service' | 'other';
export type OperationRefType = 'booking' | 'payment' | 'certificate' | 'event' | 'repair' | 'staff' | 'operation' | 'shift';

export interface FinanceOperationDto {
  id: string;
  number: number;
  branchId: string;
  kind: OperationKind;
  place: MoneyPlace;
  method: OperationMethod | null;
  direction: 'in' | 'out';
  amountKop: number;
  source: IncomeSource | null;
  categoryId: string | null;
  subcategoryId: string | null;
  comment: string | null;
  ref: { type: OperationRefType; id: string } | null;
  receiptIssued: boolean | null;
  occurredAt: string;
  recordedAt: string;
  authorId: string | null;
  /** Остаток места денег после операции (06 §10); у перевода – место-источник. */
  balanceAfterKop: number;
  reversedBy: string | null;
  reversalOf: string | null;
  shiftId: string | null;
  postingId: string;
}

/** Системный автор (обработчики, задачи): права проверил вызывающий модуль. */
export interface SystemCtx {
  kind: 'system';
  process: string;
}
export type FinanceCtx = AccessContext | SystemCtx;

export interface NewOperation {
  branchId: string;
  kind: Exclude<OperationKind, 'reversal'>;
  /** Для place_transfer – место-источник. */
  place: MoneyPlace;
  method?: OperationMethod | null;
  /** Только correction: знак корректировки. Остальные виды – направление из вида. */
  direction?: 'in' | 'out';
  amountKop: number;
  source?: IncomeSource | null;
  categoryId?: string | null;
  subcategoryId?: string | null;
  comment?: string | null;
  ref?: { type: OperationRefType; id: string } | null;
  receiptIssued?: boolean | null;
  occurredAt: Date;
  /** Только opening_balance: дата остатка по зоне филиала (06 §3.1). */
  balanceDate?: LocalDate;
}

export const PLACE_ACCOUNT: Readonly<Record<MoneyPlace, AccountKind>> = { cash: 'cash_branch', noncash: 'cash_branch_noncash' };
const OTHER: Readonly<Record<MoneyPlace, MoneyPlace>> = { cash: 'noncash', noncash: 'cash' };
const ENTRY_TYPE: Readonly<Record<Exclude<OperationKind, 'reversal' | 'place_transfer'>, Exclude<EntryType, 'reversal'>>> = {
  opening_balance: 'cash.opening_balance',
  income: 'cash.income',
  expense: 'cash.expense',
  withdrawal: 'cash.withdrawal',
  refund: 'cash.refund',
  correction: 'cash.correction',
};
const FIXED_DIRECTION: Readonly<Partial<Record<OperationKind, 'in' | 'out'>>> = {
  opening_balance: 'in',
  income: 'in',
  expense: 'out',
  withdrawal: 'out',
  place_transfer: 'out',
  refund: 'out',
};
const COMMENT_KINDS = new Set<OperationKind>(['expense', 'withdrawal', 'correction', 'reversal', 'refund', 'opening_balance', 'place_transfer']);
const LEDGER_REFS = new Set<string>(['booking', 'event', 'repair', 'certificate', 'shift', 'payment'] satisfies RefType[]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---- чтение операций

interface OperationRow {
  id: string;
  number: string;
  branch_id: string;
  kind: OperationKind;
  place: MoneyPlace;
  method: OperationMethod | null;
  direction: 'in' | 'out';
  amount_kop: string;
  source: IncomeSource | null;
  category_id: string | null;
  subcategory_id: string | null;
  comment: string | null;
  ref_type: OperationRefType | null;
  ref_id: string | null;
  receipt_issued: boolean | null;
  occurred_at: Date;
  recorded_at: Date;
  author_id: string | null;
  balance_after: string;
  reversed_by: string | null;
  reversal_of: string | null;
  shift_id: string | null;
  posting_id: string;
}

/** Выборка операции с остатком места после неё и ссылкой на сторно (для журнала, K17 №37). */
export const OPERATION_SELECT = `SELECT fo.id, fo.number, fo.branch_id, fo.kind, fo.place, fo.method, fo.direction, fo.amount_kop, fo.source,
    fo.category_id, fo.subcategory_id, fo.comment, fo.ref_type, fo.ref_id, fo.receipt_issued, fo.occurred_at, fo.recorded_at, fo.author_id,
    (SELECT le.balance_after FROM journal.ledger_entries le JOIN app.ledger_accounts la ON la.id = le.account_id
      WHERE le.posting_id = fo.posting_id AND la.owner_type = 'branch' AND la.owner_id = fo.branch_id
        AND la.kind = CASE fo.place WHEN 'cash' THEN 'cash_branch' ELSE 'cash_branch_noncash' END) AS balance_after,
    (SELECT r.id FROM journal.finance_operations r WHERE r.reversal_of = fo.id) AS reversed_by,
    fo.reversal_of, fo.shift_id, fo.posting_id
  FROM journal.finance_operations fo`;

export function toOperationDto(r: OperationRow): FinanceOperationDto {
  return {
    id: r.id,
    number: Number(r.number),
    branchId: r.branch_id,
    kind: r.kind,
    place: r.place,
    method: r.method,
    direction: r.direction,
    amountKop: Number(r.amount_kop),
    source: r.source,
    categoryId: r.category_id,
    subcategoryId: r.subcategory_id,
    comment: r.comment,
    ref: r.ref_type && r.ref_id ? { type: r.ref_type, id: r.ref_id } : null,
    receiptIssued: r.receipt_issued,
    occurredAt: r.occurred_at.toISOString(),
    recordedAt: r.recorded_at.toISOString(),
    authorId: r.author_id,
    balanceAfterKop: Number(r.balance_after),
    reversedBy: r.reversed_by,
    reversalOf: r.reversal_of,
    shiftId: r.shift_id,
    postingId: r.posting_id,
  };
}
export type { OperationRow };

export async function getOperation(db: Db, id: string): Promise<FinanceOperationDto | null> {
  if (!UUID_RE.test(id)) return null;
  const r = await db.query<OperationRow>(`${OPERATION_SELECT} WHERE fo.id = $1`, [id]);
  return r.rows[0] ? toOperationDto(r.rows[0]) : null;
}

// ---- права: вне зоны – 404 как несуществующий, в зоне без права – 403; отказ – для аудита (ADR 0005 п.8)

const DENIALS = new WeakMap<AppError, Denial>();
export const financeDenialOf = (err: unknown): Denial | undefined => (err instanceof AppError ? DENIALS.get(err) : undefined);
const notFound = () => new AppError('NOT_FOUND', 404, 'Не найдено');

/** Филиал в зоне (finance.view.day) и право action. auditAction и объект – для записи отказа. */
export async function guardFinance(
  db: Db,
  ctx: AccessContext,
  branchId: string,
  action: string,
  denied: { action: AuditAction; operationId?: string | null },
): Promise<BranchInfo> {
  const b = await getBranch(db, branchId);
  const deny = (code: 'NOT_FOUND' | 'FORBIDDEN'): never => {
    const err = code === 'NOT_FOUND' ? notFound() : new AppError('FORBIDDEN', 403, 'Недостаточно прав', { action });
    DENIALS.set(err, {
      action: denied.action,
      object: denied.operationId !== undefined ? { type: 'finance_operation', id: denied.operationId } : { type: 'branch', id: b?.id ?? null },
      branchId: b?.id ?? null,
      cityId: b?.cityId ?? null,
      reason: `${code}: ${action}`,
    });
    throw err;
  };
  if (!b || !can(ctx, 'finance.view.day', { branchId: b.id })) return deny('NOT_FOUND');
  if (!can(ctx, action, { branchId: b.id })) deny('FORBIDDEN');
  return b;
}

// ---- места денег, период, остаток (общие для corrections.ts и shift.ts)

/** Найти или создать оба места денег филиала и заблокировать их вместе со связанными счетами (порядок id). */
export async function lockPlaces(tx: Tx, branchId: string, extraAccountIds: string[] = []): Promise<Record<MoneyPlace, Account>> {
  const ids: Record<MoneyPlace, string> = { cash: '', noncash: '' };
  for (const place of ['cash', 'noncash'] as const) {
    const a = await ensureAccount(tx, { kind: PLACE_ACCOUNT[place], ownerType: 'branch', ownerId: branchId }, { unit: 'RUB_KOP', branchId, minBalance: null });
    ids[place] = a.id;
  }
  const locked = new Map((await lockAccounts(tx, [ids.cash, ids.noncash, ...extraAccountIds])).map((a) => [a.id, a]));
  return { cash: locked.get(ids.cash)!, noncash: locked.get(ids.noncash)! };
}

/** Первое число месяца момента по зоне филиала. */
export function monthOf(at: Date, branch: BranchInfo): LocalDate {
  return `${instantToLocal(at, branch.timezone).date.slice(0, 7)}-01` as LocalDate;
}

/** Закрытый месяц (K17 §6) – читать под блокировкой мест денег: закрытие месяца берёт те же блокировки. */
export async function assertPeriodOpen(tx: Tx, branch: BranchInfo, at: Date): Promise<void> {
  const month = monthOf(at, branch);
  const r = await tx.query('SELECT 1 FROM app.finance_periods WHERE branch_id = $1 AND month = $2', [branch.id, month]);
  if (r.rows.length > 0) throw new AppError('PERIOD_CLOSED', 409, 'Месяц закрыт: исправление – операцией текущей датой', { month });
}

/** Уменьшение места денег при запрете отрицательной кассы (06 §3.3) → CASH_INSUFFICIENT. Приход не проверяется. */
export async function assertNotNegative(tx: Tx, branchId: string, place: MoneyPlace, account: Account, deltaKop: number, at: Date): Promise<void> {
  if (deltaKop >= 0) return;
  const afterKop = account.balance + deltaKop;
  if (afterKop >= 0) return;
  const allowed = await resolveSetting(tx, 'finance.negative_balance_allowed', { branchId }, at);
  if (allowed.value) return;
  throw new AppError('CASH_INSUFFICIENT', 409, 'Недостаточно денег в кассе: внесите поступление или проверьте начальный остаток', {
    place,
    currentKop: account.balance,
    afterKop,
  });
}

export function authorOf(ctx: FinanceCtx): { type: 'staff'; id: string } | { type: 'system'; id: null } {
  return 'kind' in ctx ? { type: 'system', id: null } : { type: 'staff', id: ctx.actor.staffId };
}

export function requireComment(value: string | null | undefined, field = 'comment'): string {
  const s = value?.trim() ?? '';
  if (s === '') throw new AppError('COMMENT_REQUIRED', 422, 'Укажите комментарий', { field });
  return s;
}

/** Вставка заголовка операции (1 операция = 1 проводка K3). id задаётся заранее – его знает запись K3 (refs). */
export async function insertOperation(
  tx: Tx,
  v: {
    id: string;
    branchId: string;
    kind: OperationKind;
    place: MoneyPlace;
    method: OperationMethod | null;
    direction: 'in' | 'out';
    amountKop: number;
    source: IncomeSource | null;
    categoryId: string | null;
    subcategoryId: string | null;
    comment: string | null;
    ref: { type: OperationRefType; id: string } | null;
    receiptIssued: boolean | null;
    occurredAt: Date;
    author: ReturnType<typeof authorOf>;
    postingId: string;
    reversalOf: string | null;
    /** Смена задана явно (решение расхождения смены, K17 §7 п.4) – проверка открытой смены не делается. */
    shiftId?: string | null;
    /** Момент записи для настройки смены; по умолчанию occurredAt. */
    recordedAt?: Date;
  },
): Promise<FinanceOperationDto> {
  // K17 §7 п.2: смена включена – операции, задевающие наличные (место cash, перевод между местами), только в открытой
  // смене филиала и с её shift_id. Блокировка мест денег уже взята вызывающим – открытие и закрытие смены берут её же.
  let shiftId = v.shiftId ?? null;
  if (v.shiftId === undefined && (v.place === 'cash' || v.kind === 'place_transfer')) {
    const on = (await resolveSetting(tx, 'finance.cash_shift_enabled', { branchId: v.branchId }, v.recordedAt ?? v.occurredAt)).value;
    if (on) {
      const open = await tx.query<{ id: string }>(`SELECT id FROM app.cash_shifts WHERE branch_id = $1 AND status = 'open'`, [v.branchId]);
      if (!open.rows[0]) throw new AppError('CASH_SHIFT_REQUIRED', 409, 'Откройте кассовую смену', { branchId: v.branchId });
      shiftId = open.rows[0].id;
    }
  }
  try {
    await tx.query(
      `INSERT INTO journal.finance_operations (id, branch_id, kind, place, method, direction, amount_kop, source, category_id, subcategory_id,
         comment, ref_type, ref_id, receipt_issued, occurred_at, author_type, author_id, posting_id, reversal_of, shift_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
      [
        v.id, v.branchId, v.kind, v.place, v.method, v.direction, v.amountKop, v.source, v.categoryId, v.subcategoryId,
        v.comment, v.ref?.type ?? null, v.ref?.id ?? null, v.receiptIssued, v.occurredAt, v.author.type, v.author.id, v.postingId, v.reversalOf, shiftId,
      ],
    );
  } catch (err) {
    const e = err as { code?: string; constraint?: string };
    if (e.code === '23505' && e.constraint === 'finance_operations_reversal_of_key') {
      throw new AppError('ALREADY_REVERSED', 409, 'Операция уже сторнирована');
    }
    throw err;
  }
  return (await getOperation(tx, v.id))!;
}

/** Уже проведённая операция по ключу K3 (повтор): первая запись проводки с ключом `${key}#0`. */
async function findByKey(tx: Tx, key: string): Promise<FinanceOperationDto | null> {
  const r = await tx.query<OperationRow>(
    `${OPERATION_SELECT} WHERE fo.posting_id = (SELECT posting_id FROM journal.ledger_entries WHERE idempotency_key = $1)`,
    [`${key}#0`],
  );
  return r.rows[0] ? toOperationDto(r.rows[0]) : null;
}

// ---- ядро

function invalid(message: string, field: string): AppError {
  return new AppError('VALIDATION_FAILED', 400, message, { field });
}

/** Форма операции до блокировок (K17 §3): сумма, комментарий, способ ↔ место, источник, ссылка. */
function normalize(op: NewOperation): NewOperation & { direction: 'in' | 'out'; method: OperationMethod | null; comment: string | null } {
  if (!Number.isSafeInteger(op.amountKop) || op.amountKop <= 0) {
    throw new AppError('INVALID_AMOUNT', 422, 'Сумма – целое положительное число копеек', { amountKop: op.amountKop });
  }
  if (!(op.place in PLACE_ACCOUNT)) throw invalid('Неизвестное место денег', 'place');
  const direction = FIXED_DIRECTION[op.kind] ?? op.direction;
  if (direction === undefined) throw invalid('Укажите знак корректировки', 'direction');
  if (op.kind !== 'correction' && op.direction !== undefined && op.direction !== direction) throw invalid('Направление задаёт вид операции', 'direction');
  const method = op.kind === 'withdrawal' ? 'cash' : (op.method ?? null);
  if (method !== null && (method === 'cash') !== (op.place === 'cash')) throw invalid('Наличные – только место «наличные», карта и перевод – «безнал»', 'method');
  if ((op.kind === 'income' || op.kind === 'expense') && method === null) throw invalid('Укажите способ', 'method');
  if (op.kind === 'withdrawal' && op.place !== 'cash') throw invalid('Изъятие – только наличных', 'place');
  if ((op.kind === 'income') !== (op.source != null)) throw invalid('Источник – только у дохода и обязателен для него', 'source');
  if (op.kind === 'expense' && !op.categoryId) throw invalid('Укажите категорию', 'categoryId');
  if (op.kind !== 'expense' && (op.categoryId || op.subcategoryId)) throw invalid('Категория – только у расхода', 'categoryId');
  if (op.kind === 'refund' && !op.ref) throw invalid('Возврат – со ссылкой на исходную операцию', 'ref');
  if (op.kind === 'opening_balance' && !op.balanceDate) throw invalid('Укажите дату остатка', 'date');
  const comment = COMMENT_KINDS.has(op.kind) ? requireComment(op.comment) : op.comment?.trim() || null;
  return { ...op, direction, method, comment };
}

/** Ядро всех денежных операций (K17 §4): см. шапку файла. linkedEntries – записи того же намерения на других счетах
 *  (K16: certificate.issue), одна единица RUB_KOP (K3 правило 3); их счета должны существовать. */
export async function postMoneyOperation(
  tx: Tx,
  ctx: FinanceCtx,
  input: NewOperation,
  opts: { idempotencyKey: string; linkedEntries?: EntryInput[] },
  meta: AuditRequestMeta,
  clock: Clock = systemClock,
): Promise<FinanceOperationDto> {
  const op = normalize(input);
  const branch = await getBranch(tx, op.branchId);
  if (!branch) throw notFound();
  const category = op.kind === 'expense' ? await assertExpenseCategory(tx, op.categoryId!, op.subcategoryId ?? null) : null;

  const linked = opts.linkedEntries ?? [];
  const linkedIds: string[] = [];
  for (const e of linked) {
    const r = await tx.query<{ id: string }>('SELECT id FROM app.ledger_accounts WHERE kind = $1 AND owner_type = $2 AND owner_id = $3', [
      e.account.kind,
      e.account.ownerType,
      e.account.ownerId,
    ]);
    if (!r.rows[0]) throw new AppError('NOT_FOUND', 404, 'Счёт не найден', { account: e.account });
    linkedIds.push(r.rows[0].id);
  }
  const places = await lockPlaces(tx, branch.id, linkedIds);

  // перечитать под блокировкой
  const replay = await findByKey(tx, opts.idempotencyKey);
  if (replay) {
    if (replay.kind !== op.kind || replay.place !== op.place || replay.amountKop !== op.amountKop || replay.branchId !== op.branchId) {
      throw new AppError('IDEMPOTENCY_KEY_REUSED', 409, 'Ключ уже использован для другой операции', { idempotencyKey: opts.idempotencyKey });
    }
    return replay;
  }
  await assertPeriodOpen(tx, branch, op.occurredAt);
  const delta = op.direction === 'in' ? op.amountKop : -op.amountKop;
  await assertNotNegative(tx, branch.id, op.place, places[op.place], delta, clock.now());
  if (op.kind === 'opening_balance') {
    const prev = await tx.query<{ operation_id: string }>(
      `SELECT operation_id FROM app.finance_opening_balances WHERE branch_id = $1 AND place = $2 AND status = 'active'`,
      [branch.id, op.place],
    );
    if (prev.rows[0]) {
      throw new AppError('OPENING_BALANCE_EXISTS', 409, 'Начальный остаток уже внесён: замена – сторно прежнего', { operationId: prev.rows[0].operation_id });
    }
  }

  const id = randomUUID();
  const ledgerRef = op.ref && LEDGER_REFS.has(op.ref.type) ? { ref: { type: op.ref.type as RefType, id: op.ref.id } } : {};
  const common = { branchId: branch.id, occurredAt: op.occurredAt, refs: { financeOperationId: id }, ...ledgerRef, ...(op.comment ? { basis: op.comment } : {}) };
  const entries: EntryInput[] =
    op.kind === 'place_transfer'
      ? [
          { ...common, account: { kind: PLACE_ACCOUNT[op.place], ownerType: 'branch', ownerId: branch.id }, amount: -op.amountKop, type: 'cash.transfer_out' },
          { ...common, account: { kind: PLACE_ACCOUNT[OTHER[op.place]], ownerType: 'branch', ownerId: branch.id }, amount: op.amountKop, type: 'cash.transfer_in' },
        ]
      : [{ ...common, account: { kind: PLACE_ACCOUNT[op.place], ownerType: 'branch', ownerId: branch.id }, amount: delta, type: ENTRY_TYPE[op.kind] }];
  const author = authorOf(ctx);
  const posting = await post(tx, { entries: [...entries, ...linked], idempotencyKey: opts.idempotencyKey, author });

  const dto = await insertOperation(tx, {
    id,
    branchId: branch.id,
    kind: op.kind,
    place: op.place,
    method: op.method,
    direction: op.direction,
    amountKop: op.amountKop,
    source: op.source ?? null,
    categoryId: category?.categoryId ?? null,
    subcategoryId: category?.subcategoryId ?? null,
    comment: op.comment,
    ref: op.ref ?? null,
    receiptIssued: op.receiptIssued ?? null,
    occurredAt: op.occurredAt,
    author,
    postingId: posting.postingId,
    reversalOf: null,
    recordedAt: clock.now(),
  });
  if (op.kind === 'opening_balance') {
    await tx.query(`INSERT INTO app.finance_opening_balances (branch_id, place, operation_id, balance_date) VALUES ($1, $2, $3, $4)`, [
      branch.id,
      op.place,
      id,
      op.balanceDate,
    ]);
  }
  await writeAudit(
    tx,
    meta,
    { action: 'finance.operation.created', object: { type: 'finance_operation', id }, branchId: branch.id, cityId: branch.cityId, after: dto },
    clock,
  );
  return dto;
}

// ---- ручные команды CRM (K17 №39–43)

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value ?? {});
  if (!r.success) {
    throw new AppError('VALIDATION_FAILED', 400, 'Неверные данные запроса', {
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}

const UUID = z.string().regex(UUID_RE);
const AMOUNT = z.number(); // целое > 0 проверяет normalize → INVALID_AMOUNT (K17 §11)
const MOMENT = z.iso.datetime({ offset: true }).transform((s) => new Date(s));
const PLACE = z.enum(['cash', 'noncash']);
const METHOD = z.enum(['cash', 'card', 'transfer']);
const TEXT = z.string().max(2000);
const MANUAL_REF = z.object({ type: z.enum(['booking', 'event', 'repair', 'staff']), id: UUID });

const openingSchema = z.object({ branchId: UUID, place: PLACE, amountKop: AMOUNT, date: z.string(), comment: TEXT.optional() });
const incomeSchema = z.object({
  branchId: UUID,
  method: METHOD,
  amountKop: AMOUNT,
  source: z.enum(['session', 'certificate_sale', 'event', 'extra_service', 'other']),
  occurredAt: MOMENT,
  comment: TEXT.nullish(),
  ref: MANUAL_REF.nullish(),
  receiptIssued: z.boolean().nullish(),
});
const expenseSchema = z.object({
  branchId: UUID,
  method: METHOD,
  amountKop: AMOUNT,
  categoryId: UUID,
  subcategoryId: UUID.nullish(),
  occurredAt: MOMENT,
  comment: TEXT.optional(),
  ref: MANUAL_REF.nullish(),
});
const withdrawalSchema = z.object({ branchId: UUID, amountKop: AMOUNT, occurredAt: MOMENT, comment: TEXT.optional() });
const transferSchema = z.object({ branchId: UUID, from: PLACE, amountKop: AMOUNT, occurredAt: MOMENT, comment: TEXT.optional() });

const placeOf = (method: OperationMethod): MoneyPlace => (method === 'cash' ? 'cash' : 'noncash');

/** Момент факта – не в будущем (учёт фиксирует случившееся, 06 §9). */
function assertNotFuture(at: Date, clock: Clock): void {
  if (at.getTime() > clock.now().getTime()) throw invalid('Дата операции – не в будущем', 'occurredAt');
}

export interface CommandOpts {
  /** HTTP Idempotency-Key; ключ K3 – `finance-op:<key>` (K17 §4). */
  idempotencyKey: string;
  clock?: Clock;
}
const opKey = (k: string) => `finance-op:${k}`;

/** Начальный остаток места денег (06 §3.1): один действующий; повтор → OPENING_BALANCE_EXISTS. Право – Владелец. */
export async function recordOpeningBalance(tx: Tx, ctx: AccessContext, raw: unknown, meta: AuditRequestMeta, opts: CommandOpts): Promise<FinanceOperationDto> {
  const clock = opts.clock ?? systemClock;
  const input = parse(openingSchema, raw);
  const branch = await guardFinance(tx, ctx, input.branchId, 'finance.opening_balance', { action: 'finance.operation.created' });
  const date = parseLocalDate(input.date);
  const occurredAt = localToInstant(date, '00:00' as LocalTime, branch.timezone);
  assertNotFuture(occurredAt, clock);
  return postMoneyOperation(
    tx,
    ctx,
    { branchId: branch.id, kind: 'opening_balance', place: input.place, amountKop: input.amountKop, occurredAt, balanceDate: date, comment: input.comment ?? null },
    { idempotencyKey: opKey(opts.idempotencyKey) },
    meta,
    clock,
  );
}

/** Ручной доход без брони (06 §6, приёмка 12): мероприятие, доп. услуга, прочее. Сеанс – только оплатой K10. */
export async function recordIncome(tx: Tx, ctx: AccessContext, raw: unknown, meta: AuditRequestMeta, opts: CommandOpts): Promise<FinanceOperationDto> {
  const clock = opts.clock ?? systemClock;
  const input = parse(incomeSchema, raw);
  const branch = await guardFinance(tx, ctx, input.branchId, 'finance.income.create', { action: 'finance.operation.created' });
  if (input.source === 'session') {
    throw new AppError('SESSION_INCOME_VIA_PAYMENT', 422, 'Доход по сеансу вносится оплатой брони, не формой дохода');
  }
  if (input.source === 'certificate_sale') throw invalid('Продажа сертификата – из раздела сертификатов', 'source');
  assertNotFuture(input.occurredAt, clock);
  return postMoneyOperation(
    tx,
    ctx,
    {
      branchId: branch.id,
      kind: 'income',
      place: placeOf(input.method),
      method: input.method,
      amountKop: input.amountKop,
      source: input.source,
      occurredAt: input.occurredAt,
      comment: input.comment ?? null,
      ref: input.ref ?? null,
      receiptIssued: input.receiptIssued ?? null,
    },
    { idempotencyKey: opKey(opts.idempotencyKey) },
    meta,
    clock,
  );
}

/** Расход (06 §8): категория, подкатегория при наличии, комментарий обязателен; минус – по правилу §6. */
export async function recordExpense(tx: Tx, ctx: AccessContext, raw: unknown, meta: AuditRequestMeta, opts: CommandOpts): Promise<FinanceOperationDto> {
  const clock = opts.clock ?? systemClock;
  const input = parse(expenseSchema, raw);
  const branch = await guardFinance(tx, ctx, input.branchId, 'finance.expense.create', { action: 'finance.operation.created' });
  assertNotFuture(input.occurredAt, clock);
  return postMoneyOperation(
    tx,
    ctx,
    {
      branchId: branch.id,
      kind: 'expense',
      place: placeOf(input.method),
      method: input.method,
      amountKop: input.amountKop,
      categoryId: input.categoryId,
      subcategoryId: input.subcategoryId ?? null,
      occurredAt: input.occurredAt,
      comment: input.comment ?? null,
      ref: input.ref ?? null,
    },
    { idempotencyKey: opKey(opts.idempotencyKey) },
    meta,
    clock,
  );
}

/** Изъятие наличных владельцем – не расход (18 §6.2 п.13). */
export async function recordWithdrawal(tx: Tx, ctx: AccessContext, raw: unknown, meta: AuditRequestMeta, opts: CommandOpts): Promise<FinanceOperationDto> {
  const clock = opts.clock ?? systemClock;
  const input = parse(withdrawalSchema, raw);
  const branch = await guardFinance(tx, ctx, input.branchId, 'finance.withdrawal', { action: 'finance.operation.created' });
  assertNotFuture(input.occurredAt, clock);
  return postMoneyOperation(
    tx,
    ctx,
    { branchId: branch.id, kind: 'withdrawal', place: 'cash', amountKop: input.amountKop, occurredAt: input.occurredAt, comment: input.comment ?? null },
    { idempotencyKey: opKey(opts.idempotencyKey) },
    meta,
    clock,
  );
}

/** Перевод между местами одного филиала (сдача наличных на счёт): две записи K3 одной проводкой. */
export async function transferBetweenPlaces(tx: Tx, ctx: AccessContext, raw: unknown, meta: AuditRequestMeta, opts: CommandOpts): Promise<FinanceOperationDto> {
  const clock = opts.clock ?? systemClock;
  const input = parse(transferSchema, raw);
  const branch = await guardFinance(tx, ctx, input.branchId, 'finance.place_transfer', { action: 'finance.operation.created' });
  assertNotFuture(input.occurredAt, clock);
  return postMoneyOperation(
    tx,
    ctx,
    { branchId: branch.id, kind: 'place_transfer', place: input.from, amountKop: input.amountKop, occurredAt: input.occurredAt, comment: input.comment ?? null },
    { idempotencyKey: opKey(opts.idempotencyKey) },
    meta,
    clock,
  );
}

// ---- предпросмотр (06 §8, §13.3)

const previewSchema = z.object({ branchId: UUID, place: PLACE, deltaKop: z.number().int().safe() });

/** «Остаток после» до сохранения (право finance.view и finance.expense.create). Ничего не пишет и не блокирует –
 *  окончательная проверка в команде. */
export async function previewBalance(
  db: Db,
  ctx: AccessContext,
  raw: unknown,
  clock: Clock = systemClock,
): Promise<{ currentKop: number; afterKop: number; allowed: boolean; reason: 'negative_forbidden' | null }> {
  const input = parse(previewSchema, raw);
  // Только ролям, которые видят остаток (решение 02.11 внизу K17): иначе подбором суммы остаток восстанавливается.
  const branch = await guardFinance(db, ctx, input.branchId, 'finance.view', { action: 'finance.operation.created' });
  await guardFinance(db, ctx, branch.id, 'finance.expense.create', { action: 'finance.operation.created' });
  const r = await db.query<{ balance: string }>(`SELECT balance FROM app.ledger_accounts WHERE kind = $1 AND owner_type = 'branch' AND owner_id = $2`, [
    PLACE_ACCOUNT[input.place],
    branch.id,
  ]);
  const currentKop = Number(r.rows[0]?.balance ?? 0);
  const afterKop = currentKop + input.deltaKop;
  const allowed =
    input.deltaKop >= 0 || afterKop >= 0 || (await resolveSetting(db, 'finance.negative_balance_allowed', { branchId: branch.id }, clock.now())).value;
  return { currentKop, afterKop, allowed, reason: allowed ? null : 'negative_forbidden' };
}

// S2-16b. Кассовая смена и сверка наличных за флагом finance.cash_shift_enabled (K17 §7; Q-22 по умолчанию – выключено).
// Открыть и закрыть смену может Администратор (finance.shift.operate): пересчёт наличных вводится вслепую, ожидаемый
// остаток и расхождение он не получает (это делает HTTP-слой по finance.view). Закрытие: expected = остаток места cash,
// diff = counted − expected; diff = 0 и при открытии сошлось – closed, иначе needs_resolution: само ничего не проводится.
// Решает Директор или Владелец (finance.shift.resolve): correct – операция correction на diff со ссылкой на смену
// (в эту смену, без требования открытой), accept – признать пересчёт фактом: недостача – расход «Недостача кассы»,
// излишек – доход «Излишек кассы»; причина обязательна, аудит. Решение после открытия следующей смены сдвигает её
// opening_expected на diff – решённое расхождение повторно не всплывает.
// Порядок: оба места денег (lockPlaces) → смена FOR UPDATE → перечитать → проверить. Внешних вызовов нет.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { writeAudit, type AuditRequestMeta, type Db } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { post, type Tx } from '../../core/ledger.ts';
import { can, type AccessContext } from '../../core/permissions.ts';
import { resolveSetting } from '../../core/settings.ts';
import { systemClock, type Clock } from '../../core/time.ts';
import { assertNotNegative, assertPeriodOpen, authorOf, guardFinance, insertOperation, lockPlaces, requireComment, type FinanceOperationDto } from './cashbox.ts';

export type ShiftStatus = 'open' | 'closed' | 'needs_resolution' | 'resolved';

export interface CashShiftDto {
  id: string;
  branchId: string;
  status: ShiftStatus;
  openedBy: string;
  openedAt: string;
  openingCountedKop: number;
  openingExpectedKop: number;
  openingDiffKop: number;
  closedBy: string | null;
  closedAt: string | null;
  closingCountedKop: number | null;
  closingExpectedKop: number | null;
  closingDiffKop: number | null;
  resolution: 'correct' | 'accept' | null;
  resolutionReason: string | null;
  resolutionOperationId: string | null;
  rowVersion: number;
}

interface ShiftRow {
  id: string;
  branch_id: string;
  status: ShiftStatus;
  opened_by: string;
  opened_at: Date;
  opening_counted_kop: string;
  opening_expected_kop: string;
  closed_by: string | null;
  closed_at: Date | null;
  closing_counted_kop: string | null;
  closing_expected_kop: string | null;
  resolution: 'correct' | 'accept' | null;
  resolution_reason: string | null;
  resolution_operation_id: string | null;
  row_version: number;
}

const n = (v: string | null) => (v === null ? null : Number(v));
function toDto(r: ShiftRow): CashShiftDto {
  const closingCounted = n(r.closing_counted_kop);
  const closingExpected = n(r.closing_expected_kop);
  return {
    id: r.id,
    branchId: r.branch_id,
    status: r.status,
    openedBy: r.opened_by,
    openedAt: r.opened_at.toISOString(),
    openingCountedKop: Number(r.opening_counted_kop),
    openingExpectedKop: Number(r.opening_expected_kop),
    openingDiffKop: Number(r.opening_counted_kop) - Number(r.opening_expected_kop),
    closedBy: r.closed_by,
    closedAt: r.closed_at?.toISOString() ?? null,
    closingCountedKop: closingCounted,
    closingExpectedKop: closingExpected,
    closingDiffKop: closingCounted !== null && closingExpected !== null ? closingCounted - closingExpected : null,
    resolution: r.resolution,
    resolutionReason: r.resolution_reason,
    resolutionOperationId: r.resolution_operation_id,
    rowVersion: r.row_version,
  };
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value ?? {});
  if (!r.success) {
    throw new AppError('VALIDATION_FAILED', 400, 'Неверные данные запроса', { issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  }
  return r.data;
}

const UUID = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const COUNTED = z.number().int().safe().min(0);
const openSchema = z.object({ branchId: UUID, countedKop: COUNTED });
const closeSchema = z.object({ shiftId: UUID, countedKop: COUNTED });
const resolveSchema = z.object({ shiftId: UUID, action: z.enum(['correct', 'accept']), reason: z.string().max(2000).optional() });

export async function getShift(db: Db, id: string, forUpdate = false): Promise<CashShiftDto | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const r = await db.query<ShiftRow>(`SELECT * FROM app.cash_shifts WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`, [id]);
  return r.rows[0] ? toDto(r.rows[0]) : null;
}

/** Системная категория по неизменному коду (0210). */
async function systemCategory(tx: Tx, code: 'cash_shortage' | 'cash_surplus'): Promise<string> {
  return (await tx.query<{ id: string }>(`SELECT id FROM app.finance_categories WHERE code = $1`, [code])).rows[0]!.id;
}

async function assertEnabled(tx: Tx, branchId: string, at: Date): Promise<void> {
  if (!(await resolveSetting(tx, 'finance.cash_shift_enabled', { branchId }, at)).value) {
    throw new AppError('VALIDATION_FAILED', 400, 'Кассовая смена в филиале выключена', { setting: 'finance.cash_shift_enabled' });
  }
}

/** Смена по id → права по её филиалу (чужая и несуществующая – 404), под общими блокировками, затем FOR UPDATE. */
async function lockShift(tx: Tx, ctx: AccessContext, shiftId: string, action: string, auditAction: 'cash_shift.closed' | 'cash_shift.resolved') {
  const found = await getShift(tx, shiftId);
  if (!found) throw new AppError('NOT_FOUND', 404, 'Не найдено');
  const branch = await guardFinance(tx, ctx, found.branchId, action, { action: auditAction });
  const places = await lockPlaces(tx, branch.id);
  return { branch, places, shift: (await getShift(tx, shiftId, true))! };
}

/** K17 №49: открыть смену (одна открытая на филиал). Пересчёт – вслепую. */
export async function openShift(tx: Tx, ctx: AccessContext, raw: unknown, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<CashShiftDto> {
  const input = parse(openSchema, raw);
  const now = clock.now();
  const branch = await guardFinance(tx, ctx, input.branchId, 'finance.shift.operate', { action: 'cash_shift.opened' });
  await assertEnabled(tx, branch.id, now);
  const places = await lockPlaces(tx, branch.id);
  const open = await tx.query<{ id: string }>(`SELECT id FROM app.cash_shifts WHERE branch_id = $1 AND status = 'open'`, [branch.id]);
  if (open.rows[0]) throw new AppError('CASH_SHIFT_ALREADY_OPEN', 409, 'Смена уже открыта', { shiftId: open.rows[0].id });
  const id = randomUUID();
  try {
    await tx.query(
      `INSERT INTO app.cash_shifts (id, branch_id, opened_by, opened_at, opening_counted_kop, opening_expected_kop) VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, branch.id, ctx.actor.staffId, now, input.countedKop, places.cash.balance],
    );
  } catch (err) {
    if ((err as { constraint?: string }).constraint === 'cash_shifts_one_open') throw new AppError('CASH_SHIFT_ALREADY_OPEN', 409, 'Смена уже открыта', {});
    throw err;
  }
  const dto = (await getShift(tx, id))!;
  await writeAudit(
    tx,
    meta,
    { action: 'cash_shift.opened', object: { type: 'cash_shift', id }, branchId: branch.id, cityId: branch.cityId, after: { countedKop: dto.openingCountedKop, expectedKop: dto.openingExpectedKop } },
    clock,
  );
  return dto;
}

/** K17 №49: закрыть смену. Расхождение (при закрытии или при открытии) – needs_resolution, без проводки. */
export async function closeShift(tx: Tx, ctx: AccessContext, raw: unknown, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<CashShiftDto> {
  const input = parse(closeSchema, raw);
  const now = clock.now();
  const { branch, places, shift } = await lockShift(tx, ctx, input.shiftId, 'finance.shift.operate', 'cash_shift.closed');
  if (shift.status !== 'open') throw new AppError('VALIDATION_FAILED', 400, 'Смена уже закрыта', { status: shift.status });
  const expected = places.cash.balance;
  const status: ShiftStatus = input.countedKop === expected && shift.openingDiffKop === 0 ? 'closed' : 'needs_resolution';
  await tx.query(
    `UPDATE app.cash_shifts SET status = $2, closed_by = $3, closed_at = $4, closing_counted_kop = $5, closing_expected_kop = $6, row_version = row_version + 1 WHERE id = $1`,
    [shift.id, status, ctx.actor.staffId, now, input.countedKop, expected],
  );
  const dto = (await getShift(tx, shift.id))!;
  await writeAudit(
    tx,
    meta,
    { action: 'cash_shift.closed', object: { type: 'cash_shift', id: shift.id }, branchId: branch.id, cityId: branch.cityId, after: { status, countedKop: input.countedKop, expectedKop: expected, diffKop: dto.closingDiffKop } },
    clock,
  );
  return dto;
}

/** K17 №50: решение по расхождению (Директор, Владелец): correct – операция correction на diff, accept – расход/доход системной категории; в этой смене. */
export async function resolveShift(
  tx: Tx,
  ctx: AccessContext,
  raw: unknown,
  meta: AuditRequestMeta,
  opts: { clock?: Clock } = {},
): Promise<{ shift: CashShiftDto; operation: FinanceOperationDto | null }> {
  const clock = opts.clock ?? systemClock;
  const input = parse(resolveSchema, raw);
  const now = clock.now();
  const reason = requireComment(input.reason, 'reason');
  const { branch, places, shift } = await lockShift(tx, ctx, input.shiftId, 'finance.shift.resolve', 'cash_shift.resolved');
  if (shift.status !== 'needs_resolution') throw new AppError('VALIDATION_FAILED', 400, 'Расхождения нет или оно уже решено', { status: shift.status });
  let operation: FinanceOperationDto | null = null;
  let adjustedShiftId: string | null = null;
  const diff = shift.closingDiffKop ?? 0;
  if (input.action === 'correct' && diff === 0) {
    throw new AppError('VALIDATION_FAILED', 400, 'При закрытии сошлось – решение «принять» (без проводки)', { field: 'action' });
  }
  if (diff !== 0) {
    // correct – операция correction; accept – признать пересчёт фактом: недостача – расход «Недостача кассы»,
    // излишек – доход «Излишек кассы» (системные категории 0210). Остаток cash выравнивается с пересчётом в обоих случаях.
    const accept = input.action === 'accept';
    const kind = accept ? (diff < 0 ? 'expense' : 'income') : 'correction';
    const categoryId = accept ? await systemCategory(tx, diff < 0 ? 'cash_shortage' : 'cash_surplus') : null;
    await assertPeriodOpen(tx, branch, now);
    await assertNotNegative(tx, branch.id, 'cash', places.cash, diff, now);
    const id = randomUUID();
    const author = authorOf(ctx);
    const posting = await post(tx, {
      entries: [{ account: { kind: 'cash_branch', ownerType: 'branch', ownerId: branch.id }, amount: diff, type: `cash.${kind}`, basis: reason, branchId: branch.id, ref: { type: 'shift', id: shift.id }, refs: { financeOperationId: id }, occurredAt: now }],
      idempotencyKey: `shift-resolve:${shift.id}`,
      author,
    });
    operation = await insertOperation(tx, {
      id, branchId: branch.id, kind, place: 'cash', method: 'cash', direction: diff > 0 ? 'in' : 'out', amountKop: Math.abs(diff),
      source: kind === 'income' ? 'other' : null, categoryId, subcategoryId: null, comment: reason, ref: { type: 'shift', id: shift.id }, receiptIssued: null,
      occurredAt: now, author, postingId: posting.postingId, reversalOf: null, shiftId: shift.id,
    });
    await writeAudit(tx, meta, { action: 'finance.operation.created', object: { type: 'finance_operation', id }, branchId: branch.id, cityId: branch.cityId, after: operation }, clock);
    // Открытая сейчас смена открывалась после закрытия этой (одна открытая на филиал, всё под lockPlaces) и сняла
    // opening_expected до этой проводки: сдвигаем его на diff, иначе то же расхождение всплывёт как её openingDiff.
    const next = await tx.query<{ id: string }>(
      `UPDATE app.cash_shifts SET opening_expected_kop = opening_expected_kop + $2, row_version = row_version + 1
       WHERE branch_id = $1 AND status = 'open' AND opened_at >= $3 RETURNING id`,
      [branch.id, diff, shift.closedAt],
    );
    adjustedShiftId = next.rows[0]?.id ?? null;
  }
  await tx.query(
    `UPDATE app.cash_shifts SET status = 'resolved', resolution = $2, resolution_reason = $3, resolution_operation_id = $4, resolved_by = $5, resolved_at = $6, row_version = row_version + 1 WHERE id = $1`,
    [shift.id, input.action, reason, operation?.id ?? null, ctx.actor.staffId, now],
  );
  const dto = (await getShift(tx, shift.id))!;
  await writeAudit(
    tx,
    meta,
    { action: 'cash_shift.resolved', object: { type: 'cash_shift', id: shift.id }, branchId: branch.id, cityId: branch.cityId, after: { resolution: input.action, operationId: operation?.id ?? null, openingAdjustedShiftId: adjustedShiftId }, reason },
    clock,
  );
  return { shift: dto, operation };
}

// ---- чтение (K17 №55–56): без аудита; суммы – только с finance.view на филиал (06 §14)

/** Смена без сумм – Администратору: кто и когда открыл и закрыл, статус. */
export type CashShiftBriefDto = Pick<CashShiftDto, 'branchId' | 'status' | 'openedAt' | 'openedBy' | 'closedAt' | 'closedBy'> & { shiftId: string };
export type CashShiftReadDto = (CashShiftDto & { shiftId: string }) | CashShiftBriefDto;

function readShape(full: boolean, s: CashShiftDto): CashShiftReadDto {
  if (full) return { shiftId: s.id, ...s };
  return { shiftId: s.id, branchId: s.branchId, status: s.status, openedAt: s.openedAt, openedBy: s.openedBy, closedAt: s.closedAt, closedBy: s.closedBy };
}

/** Филиал в зоне и finance.shift.operate (чужой и несуществующий – 404, без права – 403); full – есть finance.view. */
async function guardRead(db: Db, ctx: AccessContext, branchId: string) {
  const branch = await guardFinance(db, ctx, branchId, 'finance.shift.operate', { action: 'cash_shift.opened' });
  return { branch, full: can(ctx, 'finance.view', { branchId: branch.id }) };
}

/** K17 №55: флаг смены филиала и открытая смена (или null). */
export async function currentShift(db: Db, ctx: AccessContext, branchId: string, clock: Clock = systemClock): Promise<{ enabled: boolean; openShift: CashShiftReadDto | null }> {
  const { branch, full } = await guardRead(db, ctx, branchId);
  const enabled = (await resolveSetting(db, 'finance.cash_shift_enabled', { branchId: branch.id }, clock.now())).value;
  const r = await db.query<ShiftRow>(`SELECT * FROM app.cash_shifts WHERE branch_id = $1 AND status = 'open'`, [branch.id]);
  return { enabled, openShift: r.rows[0] ? readShape(full, toDto(r.rows[0])) : null };
}

const listShiftsSchema = z.object({
  status: z.enum(['open', 'closed', 'needs_resolution', 'resolved']).optional(),
  cursor: z.string().regex(/^\d{1,16}:[0-9a-f-]{36}$/i).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** K17 №56: смены филиала, новые сверху (opened_at, id). Без finance.view – только свои (открыл или закрыл), без сумм. */
export async function listShifts(db: Db, ctx: AccessContext, branchId: string, raw: unknown): Promise<{ items: CashShiftReadDto[]; nextCursor: string | null }> {
  const { branch, full } = await guardRead(db, ctx, branchId);
  const q = parse(listShiftsSchema, raw);
  const params: unknown[] = [branch.id];
  let where = 'branch_id = $1';
  if (q.status) {
    params.push(q.status);
    where += ` AND status = $${params.length}`;
  }
  if (!full) {
    params.push(ctx.actor.staffId);
    where += ` AND (opened_by = $${params.length} OR closed_by = $${params.length})`;
  }
  if (q.cursor) {
    const [ms, id] = q.cursor.split(':');
    params.push(new Date(Number(ms)), id);
    where += ` AND (opened_at, id) < ($${params.length - 1}, $${params.length}::uuid)`;
  }
  params.push(q.limit + 1);
  const r = await db.query<ShiftRow>(`SELECT * FROM app.cash_shifts WHERE ${where} ORDER BY opened_at DESC, id DESC LIMIT $${params.length}`, params);
  const rows = r.rows.slice(0, q.limit);
  const last = rows.at(-1);
  return {
    items: rows.map((row) => readShape(full, toDto(row))),
    nextCursor: r.rows.length > q.limit && last ? `${last.opened_at.getTime()}:${last.id}` : null,
  };
}

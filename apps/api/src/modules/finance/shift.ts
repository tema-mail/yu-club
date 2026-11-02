// S2-16b. Кассовая смена и сверка наличных за флагом finance.cash_shift_enabled (K17 §7; Q-22 по умолчанию – выключено).
// Открыть и закрыть смену может Администратор (finance.shift.operate): пересчёт наличных вводится вслепую, ожидаемый
// остаток и расхождение он не получает (это делает HTTP-слой по finance.view). Закрытие: expected = остаток места cash,
// diff = counted − expected; diff = 0 и при открытии сошлось – closed, иначе needs_resolution: само ничего не проводится.
// Решает Директор или Владелец (finance.shift.resolve): correct – операция correction на diff со ссылкой на смену
// (в эту смену, без требования открытой), accept – «принято без проводки»; причина обязательна, аудит. correct после
// открытия следующей смены сдвигает её opening_expected на diff – решённое расхождение повторно не всплывает.
// Порядок: оба места денег (lockPlaces) → смена FOR UPDATE → перечитать → проверить. Внешних вызовов нет.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { writeAudit, type AuditRequestMeta, type Db } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { post, type Tx } from '../../core/ledger.ts';
import type { AccessContext } from '../../core/permissions.ts';
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

/** K17 №50: решение по расхождению (Директор, Владелец). correct – операция correction на diff в этой смене. */
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
  if (input.action === 'correct') {
    const diff = shift.closingDiffKop!;
    if (diff === 0) throw new AppError('VALIDATION_FAILED', 400, 'При закрытии сошлось – решение «принято без проводки»', { field: 'action' });
    await assertPeriodOpen(tx, branch, now);
    await assertNotNegative(tx, branch.id, 'cash', places.cash, diff, now);
    const id = randomUUID();
    const author = authorOf(ctx);
    const posting = await post(tx, {
      entries: [{ account: { kind: 'cash_branch', ownerType: 'branch', ownerId: branch.id }, amount: diff, type: 'cash.correction', basis: reason, branchId: branch.id, ref: { type: 'shift', id: shift.id }, refs: { financeOperationId: id }, occurredAt: now }],
      idempotencyKey: `shift-resolve:${shift.id}`,
      author,
    });
    operation = await insertOperation(tx, {
      id, branchId: branch.id, kind: 'correction', place: 'cash', method: 'cash', direction: diff > 0 ? 'in' : 'out', amountKop: Math.abs(diff),
      source: null, categoryId: null, subcategoryId: null, comment: reason, ref: { type: 'shift', id: shift.id }, receiptIssued: null,
      occurredAt: now, author, postingId: posting.postingId, reversalOf: null, shiftId: shift.id,
    });
    await writeAudit(tx, meta, { action: 'finance.operation.created', object: { type: 'finance_operation', id }, branchId: branch.id, cityId: branch.cityId, after: operation }, clock);
    // Открытая сейчас смена открывалась после закрытия этой (одна открытая на филиал, всё под lockPlaces) и взяла ожидаемый
    // остаток без этой корректировки: учитываем её, иначе то же расхождение всплывёт как openingDiff следующей смены.
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

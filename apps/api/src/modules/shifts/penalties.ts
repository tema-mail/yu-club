// S3-17. Штрафы и премии (K18 §8, 05 §9): управленческая запись с причиной на счёте K3 staff_payroll. За флагами:
// payroll.penalties_enabled = false до ответа юриста (Q-121; ТК ст. 192 денежных штрафов не предусматривает, замена по умолчанию –
// депремирование, Q-153), payroll.bonus_enabled = false (Q-107). Отмена – сторно с причиной, исходная запись остаётся; правка – сторно +
// новая запись со ссылкой replaced_by. Порядок блокировок (K18 §6): FOR SHARE периода → lockAccounts → строка записи.
// Сторно записи закрытого периода проводится датой открытого (K18 §7); создать или исправить запись с датой закрытого периода нельзя.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { writeAudit, type AuditAction, type AuditRequestMeta, type Db } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { lockAccounts, post, reversePosting, type Tx } from '../../core/ledger.ts';
import { assertCan, can, roleAllows, type AccessContext } from '../../core/permissions.ts';
import { resolveSetting } from '../../core/settings.ts';
import { parseLocalDate, systemClock, type Clock, type LocalDate, type TimeZone } from '../../core/time.ts';
import { getBranch } from '../network/index.ts';
import { openPayrollDate, payrollInstant, staffAccount } from './accrual.ts';
import { staffTargets } from './plan.ts';
import { isUuid, lockPeriodsShared, notFound, requireReason } from './rates.ts';

export type PenaltyKind = 'penalty' | 'bonus';

export interface PenaltyDto {
  id: string;
  kind: PenaltyKind;
  staffId: string;
  branchId: string | null;
  date: LocalDate;
  amountKop: number;
  reason: string;
  comment: string | null;
  status: 'active' | 'cancelled';
  periodId: string | null;
  authorId: string;
  postingId: string;
  cancelReason: string | null;
  replacedBy: string | null;
}

interface Row {
  id: string;
  kind: PenaltyKind;
  staff_id: string;
  branch_id: string | null;
  local_date: string;
  amount_kop: string;
  reason: string;
  comment: string | null;
  status: 'active' | 'cancelled';
  period_id: string | null;
  created_by: string;
  posting_id: string;
  cancel_reason: string | null;
  replaced_by: string | null;
}

const SELECT = `SELECT x.id, x.kind, x.staff_id, x.branch_id, to_char(x.local_date, 'YYYY-MM-DD') AS local_date, x.amount_kop, x.reason, x.comment, x.status,
    (SELECT p.id FROM app.payroll_periods p WHERE x.local_date BETWEEN p.date_from AND p.date_to) AS period_id,
    x.created_by, x.posting_id, x.cancel_reason, x.replaced_by
  FROM app.payroll_penalties x`;

const toDto = (r: Row): PenaltyDto => ({
  id: r.id,
  kind: r.kind,
  staffId: r.staff_id,
  branchId: r.branch_id,
  date: r.local_date as LocalDate,
  amountKop: Number(r.amount_kop),
  reason: r.reason,
  comment: r.comment,
  status: r.status,
  periodId: r.period_id,
  authorId: r.created_by,
  postingId: r.posting_id,
  cancelReason: r.cancel_reason,
  replacedBy: r.replaced_by,
});

const KIND = {
  penalty: { right: 'payroll.penalty.manage', flag: 'payroll.penalties_enabled', entry: 'payroll.penalty', sign: -1, ref: 'payroll_penalty', created: 'payroll.penalty.created', cancelled: 'payroll.penalty.cancelled', amended: 'payroll.penalty.amended', flagText: 'Штрафы выключены до юридической проверки' },
  bonus: { right: 'payroll.bonus.manage', flag: 'payroll.bonus_enabled', entry: 'payroll.bonus', sign: 1, ref: 'payroll_bonus', created: 'payroll.bonus.created', cancelled: 'payroll.bonus.cancelled', amended: 'payroll.bonus.amended', flagText: 'Премии выключены' },
} as const;

async function assertEnabled(db: Db, kind: PenaltyKind, clock: Clock): Promise<void> {
  const k = KIND[kind];
  if (!(await resolveSetting(db, k.flag, { network: true }, clock.now())).value) throw new AppError('FEATURE_DISABLED', 409, k.flagText, { setting: k.flag });
}

/** Сеть (branchId = null) – только с сетевым правом; филиал – в зоне и сотрудник на него назначен; вне зоны – 404. */
async function guardTarget(db: Db, ctx: AccessContext, kind: PenaltyKind, staffId: string, branchId: string | null): Promise<void> {
  const right = KIND[kind].right;
  if (!roleAllows(ctx.role, right)) {
    if (!ctx.network && branchId !== null && !ctx.branchIds.has(branchId)) throw notFound();
    throw new AppError('FORBIDDEN', 403, 'Недостаточно прав', { action: right });
  }
  const target = await staffTargets(db, staffId);
  if (!target) throw notFound();
  if (ctx.network) {
    if (branchId !== null && !(await getBranch(db, branchId))) throw notFound();
    return;
  }
  if (branchId === null) {
    // Нужно понять, в зоне ли сотрудник вообще: чужой – 404, свой без филиала – BRANCH_REQUIRED.
    if (!target.branchIds.some((b) => ctx.branchIds.has(b))) throw notFound();
    throw new AppError('BRANCH_REQUIRED', 422, 'Укажите филиал: без филиала запись ставит только Владелец');
  }
  assertCan(ctx, right, { branchId });
  if (!target.branchIds.includes(branchId)) throw notFound();
}

const createSchema = z.object({
  staffId: z.string(),
  branchId: z.string().nullish(),
  date: z.string(),
  amountKop: z.unknown(),
  reason: z.string().max(2000).nullish(),
  comment: z.string().max(2000).nullish(),
});

function parseAmount(v: unknown): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) throw new AppError('INVALID_AMOUNT', 422, 'Сумма – целое число копеек больше нуля');
  return v;
}

/** Запись K3 и строка: блокировки периода и счёта взял вызывающий. */
async function insert(
  tx: Tx,
  ctx: AccessContext,
  kind: PenaltyKind,
  v: { staffId: string; branchId: string | null; date: LocalDate; amountKop: number; reason: string; comment: string | null },
  clock: Clock,
): Promise<string> {
  const k = KIND[kind];
  const id = randomUUID();
  const posted = await post(tx, {
    entries: [
      {
        account: { kind: 'staff_payroll', ownerType: 'staff', ownerId: v.staffId },
        amount: k.sign * v.amountKop,
        type: k.entry,
        basis: v.reason,
        branchId: v.branchId,
        ref: { type: k.ref, id },
        occurredAt: payrollInstant(v.date),
      },
    ],
    idempotencyKey: `${kind === 'penalty' ? 'payroll-penalty' : 'payroll-bonus'}:${id}`,
    author: { type: 'staff', id: ctx.actor.staffId },
  });
  await tx.query(
    `INSERT INTO app.payroll_penalties (id, kind, staff_id, branch_id, local_date, amount_kop, reason, comment, posting_id, created_by, created_at)
     VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8, $9, $10, $11)`,
    [id, kind, v.staffId, v.branchId, v.date, v.amountKop, v.reason, v.comment, posted.postingId, ctx.actor.staffId, clock.now()],
  );
  return id;
}

async function assertOpenDate(tx: Tx, date: LocalDate): Promise<void> {
  const periods = await lockPeriodsShared(tx, [date]);
  const closed = periods.find((p) => p.status === 'closed');
  if (closed) throw new AppError('PAYROLL_PERIOD_CLOSED', 409, 'Расчётный период закрыт: исправление – корректировкой в открытом периоде', { periodId: closed.id });
}

async function create(tx: Tx, ctx: AccessContext, kind: PenaltyKind, raw: unknown, meta: AuditRequestMeta, clock: Clock): Promise<PenaltyDto> {
  const parsed = createSchema.safeParse(raw ?? {});
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', 400, 'Неверные данные запроса');
  const input = parsed.data;
  if (!isUuid(input.staffId) || (input.branchId != null && !isUuid(input.branchId))) throw notFound();
  const branchId = input.branchId ?? null;
  await guardTarget(tx, ctx, kind, input.staffId, branchId);
  await assertEnabled(tx, kind, clock);
  const reason = requireReason(input.reason);
  const amountKop = parseAmount(input.amountKop);
  let date: LocalDate;
  try {
    date = parseLocalDate(input.date);
  } catch {
    throw new AppError('VALIDATION_FAILED', 400, 'Дата – ГГГГ-ММ-ДД', { field: 'date' });
  }
  await assertOpenDate(tx, date);
  const account = await staffAccount(tx, input.staffId);
  await lockAccounts(tx, [account.id]);
  const comment = input.comment?.trim() || null;
  const id = await insert(tx, ctx, kind, { staffId: input.staffId, branchId, date, amountKop, reason, comment }, clock);
  await writeAudit(
    tx,
    meta,
    { action: KIND[kind].created as AuditAction, object: { type: 'payroll_penalty', id }, branchId, after: { kind, staffId: input.staffId, date, amountKop, comment }, reason },
    clock,
  );
  return (await getPenalty(tx, id))!;
}

export const createPenalty = (tx: Tx, ctx: AccessContext, raw: unknown, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<PenaltyDto> => create(tx, ctx, 'penalty', raw, meta, clock);
export const createBonus = (tx: Tx, ctx: AccessContext, raw: unknown, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<PenaltyDto> => create(tx, ctx, 'bonus', raw, meta, clock);

export async function getPenalty(db: Db, id: string): Promise<PenaltyDto | null> {
  if (!isUuid(id)) return null;
  const r = await db.query<Row>(`${SELECT} WHERE x.id = $1`, [id]);
  return r.rows[0] ? toDto(r.rows[0]) : null;
}

/** Запись под блокировками: период исходной даты, счёт, строка. Вид и зона проверены до блокировок. */
async function locked(tx: Tx, ctx: AccessContext, id: string, clock: Clock): Promise<{ row: PenaltyDto; closed: boolean; tz: TimeZone | null }> {
  const seen = await getPenalty(tx, id);
  if (!seen) throw notFound();
  if (seen.branchId === null ? !ctx.network : !can(ctx, 'payroll.view', { branchId: seen.branchId })) throw notFound();
  if (seen.branchId === null) assertCan(ctx, KIND[seen.kind].right, { network: true });
  else assertCan(ctx, KIND[seen.kind].right, { branchId: seen.branchId });
  await assertEnabled(tx, seen.kind, clock);
  const periods = await lockPeriodsShared(tx, [seen.date]);
  const branch = seen.branchId ? await getBranch(tx, seen.branchId) : null;
  return { row: seen, closed: periods.some((p) => p.status === 'closed'), tz: branch?.timezone ?? null };
}

const FALLBACK_TZ = 'Europe/Moscow' as TimeZone; // запись без филиала: дата корректировки по зоне отчётов сети

async function reverseRow(tx: Tx, ctx: AccessContext, row: PenaltyDto, reason: string, onDate: LocalDate): Promise<string> {
  const done = await reversePosting(tx, {
    postingId: row.postingId,
    reason,
    idempotencyKey: `payroll-penalty-reversal:${row.id}`,
    author: { type: 'staff', id: ctx.actor.staffId },
    occurredAt: payrollInstant(onDate),
  });
  return done.postingId;
}

/** Отмена – сторно K3 с причиной; исходная запись и её причина остаются (приёмка 16–17). */
export async function cancelPenalty(tx: Tx, ctx: AccessContext, id: string, input: { reason?: string | null }, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<PenaltyDto> {
  const reason = requireReason(input.reason);
  const { row, closed, tz } = await locked(tx, ctx, id, clock);
  const onDate = closed ? await openPayrollDate(tx, tz ?? FALLBACK_TZ, clock) : row.date;
  const account = await staffAccount(tx, row.staffId);
  await lockAccounts(tx, [account.id]);
  const fresh = (await tx.query<{ status: string }>(`SELECT status FROM app.payroll_penalties WHERE id = $1 FOR UPDATE`, [row.id])).rows[0]!;
  if (fresh.status !== 'active') throw new AppError('ALREADY_REVERSED', 409, 'Запись уже отменена');
  const cancelPosting = await reverseRow(tx, ctx, row, reason, onDate);
  await tx.query(`UPDATE app.payroll_penalties SET status = 'cancelled', cancel_posting_id = $2, cancel_reason = $3 WHERE id = $1`, [row.id, cancelPosting, reason]);
  await writeAudit(tx, meta, { action: KIND[row.kind].cancelled as AuditAction, object: { type: 'payroll_penalty', id: row.id }, branchId: row.branchId, before: { amountKop: row.amountKop, reason: row.reason }, reason }, clock);
  return (await getPenalty(tx, row.id))!;
}

/** Правка суммы или причины – сторно + новая запись со ссылкой replacedBy; история – в аудите (05 §9.2). */
export async function amendPenalty(
  tx: Tx,
  ctx: AccessContext,
  id: string,
  input: { amountKop?: unknown; reason?: string | null; comment?: string | null; why?: string | null },
  meta: AuditRequestMeta,
  clock: Clock = systemClock,
): Promise<PenaltyDto> {
  const why = requireReason(input.why, 'why');
  const { row, closed } = await locked(tx, ctx, id, clock);
  if (closed) throw new AppError('PAYROLL_PERIOD_CLOSED', 409, 'Расчётный период закрыт: исправление – корректировкой в открытом периоде');
  const amountKop = input.amountKop === undefined ? row.amountKop : parseAmount(input.amountKop);
  const reason = input.reason === undefined ? row.reason : requireReason(input.reason);
  const comment = input.comment === undefined ? row.comment : input.comment?.trim() || null;
  const account = await staffAccount(tx, row.staffId);
  await lockAccounts(tx, [account.id]);
  const fresh = (await tx.query<{ status: string }>(`SELECT status FROM app.payroll_penalties WHERE id = $1 FOR UPDATE`, [row.id])).rows[0]!;
  if (fresh.status !== 'active') throw new AppError('ALREADY_REVERSED', 409, 'Запись уже отменена');
  const cancelPosting = await reverseRow(tx, ctx, row, why, row.date);
  const newId = await insert(tx, ctx, row.kind, { staffId: row.staffId, branchId: row.branchId, date: row.date, amountKop, reason, comment }, clock);
  await tx.query(`UPDATE app.payroll_penalties SET status = 'cancelled', cancel_posting_id = $2, cancel_reason = $3, replaced_by = $4 WHERE id = $1`, [row.id, cancelPosting, why, newId]);
  await writeAudit(
    tx,
    meta,
    { action: KIND[row.kind].amended as AuditAction, object: { type: 'payroll_penalty', id: newId }, branchId: row.branchId, before: { id: row.id, amountKop: row.amountKop, reason: row.reason, comment: row.comment }, after: { amountKop, reason, comment }, reason: why },
    clock,
  );
  return (await getPenalty(tx, newId))!;
}

/** №316: записи в зоне payroll.view; без филиала – только Владельцу (K18 §10). */
export async function listPenalties(db: Db, ctx: AccessContext, q: { staffId?: string; periodId?: string }): Promise<{ items: PenaltyDto[] }> {
  if (!roleAllows(ctx.role, 'payroll.view')) throw new AppError('FORBIDDEN', 403, 'Недостаточно прав', { action: 'payroll.view' });
  if ((q.staffId !== undefined && !isUuid(q.staffId)) || (q.periodId !== undefined && !isUuid(q.periodId))) throw notFound();
  const params: unknown[] = [];
  const where: string[] = [];
  if (!ctx.network) {
    params.push([...ctx.branchIds]);
    where.push(`x.branch_id = ANY($${params.length}::uuid[])`);
  }
  if (q.staffId) {
    params.push(q.staffId);
    where.push(`x.staff_id = $${params.length}`);
  }
  if (q.periodId) {
    params.push(q.periodId);
    where.push(`EXISTS (SELECT 1 FROM app.payroll_periods p WHERE p.id = $${params.length} AND x.local_date BETWEEN p.date_from AND p.date_to)`);
  }
  const r = await db.query<Row>(`${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY x.local_date DESC, x.created_at DESC LIMIT 500`, params);
  return { items: r.rows.map(toDto) };
}

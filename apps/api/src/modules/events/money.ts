// S3-54. Деньги мероприятия (K20 §6, 11 §7–§8, §11.3). Мероприятие – не сеанс K10: предоплата и доплата – отдельные
// операции кассы K17, каждая одним денежным способом (Q-74); баллы и сертификаты не принимаются (Q-113). Запись – только
// функциями finance/links.ts (ADR 0002): операция и связь в одной транзакции, таблицу связей этот модуль не пишет. Одна
// операция видна и в карточке, и в журнале кассы – это одна строка finance_operations (приёмка 8). Порядок замков:
// мероприятие FOR UPDATE → места денег филиала. Возврат перечитывает поступление под lockPlaces (refundIncome): сторно между
// проверкой и записью → OPERATION_REVERSED; сторно поступления с живыми возвратами запрещает finance (INCOME_HAS_REFUNDS).
// Сводка – отдельными показателями (11 §11.3): result = received − refunded − factCost, deviation = factCost − planCost.
import { z } from 'zod';
import { writeAudit, type AuditRequestMeta, type Db } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import type { Tx } from '../../core/ledger.ts';
import type { AccessContext } from '../../core/permissions.ts';
import { systemClock } from '../../core/time.ts';
import { getOperation, type CommandOpts, type FinanceOperationDto } from '../finance/cashbox.ts';
import { createLinkedOperation, linkOperation, linksOf, refundIncome, type OperationLink } from '../finance/links.ts';
import { agreedOf, giftsOfEvent, lockEvent, notFound, parseBody, UUID_RE, type EventRow } from './events.ts';

export interface EventMoneySummary {
  agreedKop: number;
  receivedKop: number;
  refundedKop: number;
  dueKop: number;
  planCostKop: number;
  factCostKop: number;
  resultKop: number;
  deviationKop: number;
  discountsKop: number;
  giftsIssued: number;
}

const Uuid = z.string().regex(UUID_RE);
const Method = z.enum(['cash', 'card', 'transfer']);
const Place = z.enum(['cash', 'noncash']);
const At = z.iso.datetime({ offset: true });
const Note = z.string().trim().max(2000);

const incomeSchema = z.object({ place: Place.optional(), method: Method, amountKop: z.number(), occurredAt: At, comment: Note.nullish(), receiptIssued: z.boolean().nullish() });
const refundSchema = z.object({ incomeOperationId: Uuid, amountKop: z.number(), method: Method, place: Place.optional(), reason: z.string().max(2000).optional() });
const expenseSchema = z.object({
  place: Place.optional(),
  method: Method,
  amountKop: z.number(),
  categoryId: Uuid,
  subcategoryId: Uuid.nullish(),
  supplier: z.string().trim().max(200).nullish(),
  lineId: Uuid.nullish(),
  inCost: z.boolean().optional(),
  occurredAt: At,
  comment: z.string().max(2000).optional(),
});
const linkSchema = z.object({ operationId: Uuid, lineId: Uuid.nullish(), inCost: z.boolean().optional() });

/** K17: место денег следует из способа (K20 §6 передаёт оба – несогласованные значения – ошибка формы, а не тихий выбор). */
function assertPlace(method: 'cash' | 'card' | 'transfer', place: 'cash' | 'noncash' | undefined): void {
  if (place !== undefined && place !== (method === 'cash' ? 'cash' : 'noncash')) throw new AppError('VALIDATION_FAILED', 400, 'Место денег не соответствует способу оплаты', { field: 'place' });
}

async function assertLineOfEvent(db: Db, eventId: string, lineId: string | null | undefined): Promise<void> {
  if (lineId == null) return;
  const r = await db.query(`SELECT 1 FROM app.event_lines WHERE id = $1 AND event_id = $2`, [lineId, eventId]);
  if (r.rowCount !== 1) throw new AppError('VALIDATION_FAILED', 400, 'Строка состава не из этого мероприятия', { field: 'lineId' });
}

/** Поступление: K17 recordIncome source='event' + связь role 'income'. Филиал кассы = филиал мероприятия.
 *  Права: event.money.record и K17 finance.income.create (проверяет касса). */
export async function recordEventIncome(tx: Tx, ctx: AccessContext, eventId: string, raw: unknown, meta: AuditRequestMeta, opts: CommandOpts): Promise<FinanceOperationDto> {
  const input = parseBody(incomeSchema, raw);
  assertPlace(input.method, input.place);
  const e = await lockEvent(tx, ctx, eventId, 'event.money.record');
  const ref = { type: 'event' as const, id: e.id };
  return createLinkedOperation(
    tx,
    ctx,
    {
      kind: 'income',
      operation: { branchId: e.branch_id, method: input.method, amountKop: input.amountKop, source: 'event', occurredAt: input.occurredAt, comment: input.comment ?? null, ref, receiptIssued: input.receiptIssued ?? null },
      link: { ref, role: 'income' },
    },
    meta,
    opts,
  );
}

/** Возврат по ссылке на поступление этого мероприятия. Сумма ≤ поступление − уже возвращено (EVENT_REFUND_EXCEEDS_INCOME),
 *  причина обязательна, право finance.refund – всё проверяет finance.refundIncome под замком мест денег. */
export async function refundEventIncome(tx: Tx, ctx: AccessContext, eventId: string, raw: unknown, meta: AuditRequestMeta, opts: CommandOpts): Promise<FinanceOperationDto> {
  const input = parseBody(refundSchema, raw);
  assertPlace(input.method, input.place);
  const e = await lockEvent(tx, ctx, eventId, 'event.money.record');
  const income = await getOperation(tx, input.incomeOperationId);
  if (!income || income.kind !== 'income' || income.ref?.type !== 'event' || income.ref.id !== e.id) throw notFound();
  return refundIncome(tx, ctx, { incomeOperationId: income.id, amountKop: input.amountKop, method: input.method, reason: input.reason }, meta, opts);
}

/** Расход из карточки: операция кассы и связь role 'expense'; по умолчанию в себестоимость (K20 §6). Поставщик – в комментарии операции. */
export async function addEventExpense(tx: Tx, ctx: AccessContext, eventId: string, raw: unknown, meta: AuditRequestMeta, opts: CommandOpts): Promise<FinanceOperationDto> {
  const input = parseBody(expenseSchema, raw);
  assertPlace(input.method, input.place);
  const e = await lockEvent(tx, ctx, eventId, 'event.money.record');
  await assertLineOfEvent(tx, e.id, input.lineId);
  const ref = { type: 'event' as const, id: e.id };
  const text = (input.comment ?? '').trim();
  const comment = input.supplier && text ? `${text} (поставщик: ${input.supplier})` : text;
  return createLinkedOperation(
    tx,
    ctx,
    {
      kind: 'expense',
      operation: { branchId: e.branch_id, method: input.method, amountKop: input.amountKop, categoryId: input.categoryId, subcategoryId: input.subcategoryId ?? null, occurredAt: input.occurredAt, comment, ref },
      link: { ref, role: 'expense', inCost: input.inCost ?? true, lineId: input.lineId ?? null },
    },
    meta,
    opts,
  );
}

/** Уже внесённый расход (кейтеринг в общих расходах): связь без новой операции; по умолчанию не в себестоимости.
 *  Повторная привязка – OPERATION_ALREADY_LINKED (11 §8.4 «нельзя повторно учитывать»): её держит замок мероприятия. */
export async function linkEventExpense(tx: Tx, ctx: AccessContext, eventId: string, raw: unknown, meta: AuditRequestMeta, opts: Pick<CommandOpts, 'clock'> = {}): Promise<void> {
  const input = parseBody(linkSchema, raw);
  const clock = opts.clock ?? systemClock;
  const e = await lockEvent(tx, ctx, eventId, 'event.money.record');
  await assertLineOfEvent(tx, e.id, input.lineId);
  const op = await getOperation(tx, input.operationId);
  if (!op) throw notFound();
  if (op.branchId !== e.branch_id) throw notFound(); // чужая операция неотличима от несуществующей (K1)
  const ref = { type: 'event' as const, id: e.id };
  if ((await linksOf(tx, ref)).some((l) => l.operation.id === op.id)) throw new AppError('OPERATION_ALREADY_LINKED', 409, 'Этот расход уже учтён в мероприятии', { ref, role: 'expense' });
  await linkOperation(tx, ctx, { operationId: op.id, ref, role: 'expense', inCost: input.inCost ?? false, lineId: input.lineId ?? null }, meta, clock);
  await writeAudit(tx, meta, { action: 'event.money_linked', object: { type: 'event', id: e.id }, branchId: e.branch_id, after: { operationId: op.id, amountKop: op.amountKop, inCost: input.inCost ?? false, lineId: input.lineId ?? null } }, clock);
}

/** Сумма по формулам 11 §11.3 – чистая функция: её проверяет property-based тест. */
export function summarize(input: {
  agreedKop: number;
  planCostKop: number;
  discountsKop: number;
  giftsIssued: number;
  links: ReadonlyArray<Pick<OperationLink, 'role' | 'inCost'> & { operation: Pick<FinanceOperationDto, 'amountKop'> }>;
}): EventMoneySummary {
  let receivedKop = 0;
  let refundedKop = 0;
  let factCostKop = 0;
  for (const l of input.links) {
    if (l.role === 'income') receivedKop += l.operation.amountKop;
    else if (l.role === 'refund') refundedKop += l.operation.amountKop;
    else if (l.role === 'expense' && l.inCost) factCostKop += l.operation.amountKop;
  }
  return {
    agreedKop: input.agreedKop,
    receivedKop,
    refundedKop,
    dueKop: input.agreedKop - receivedKop + refundedKop,
    planCostKop: input.planCostKop,
    factCostKop,
    resultKop: receivedKop - refundedKop - factCostKop,
    deviationKop: factCostKop - input.planCostKop,
    discountsKop: input.discountsKop,
    giftsIssued: input.giftsIssued,
  };
}

export async function eventMoneySummary(db: Db, eventId: string): Promise<EventMoneySummary> {
  const [agreed, plan, links, gifts] = [
    await agreedOf(db, eventId),
    await db.query<{ plan: string; discounts: string }>(
      `SELECT coalesce(sum(plan_cost_kop), 0)::text AS plan, coalesce(sum(discount_kop), 0)::text AS discounts FROM app.event_lines WHERE event_id = $1 AND status = 'active'`,
      [eventId],
    ),
    await linksOf(db, { type: 'event', id: eventId }),
    await giftsOfEvent(db, eventId),
  ];
  return summarize({ agreedKop: agreed.agreedKop, planCostKop: Number(plan.rows[0]!.plan), discountsKop: Number(plan.rows[0]!.discounts), giftsIssued: gifts.length, links });
}

/** Остаток к оплате – для пункта чек-листа и колонки списка (видна и без event.money.view). */
export const dueOf = async (db: Db, eventId: string): Promise<number> => (await eventMoneySummary(db, eventId)).dueKop;

/** Операции мероприятия для карточки: живые связи, сторнированные не показываются (K17 §14). */
export const eventOperations = (db: Db, e: Pick<EventRow, 'id'>): Promise<OperationLink[]> => linksOf(db, { type: 'event', id: e.id });

// №368, №369 деньги мероприятия – мок строго по apps/api/src/modules/events/money.ts и routes.crm.ts (K20 §6): одна строка журнала
// кассы (mock-finance), связь – одна на операцию, вторая привязка – OPERATION_ALREADY_LINKED. Вынесено из mock-events.ts
// (файл упёрся в 800 строк): правила доступа, идемпотентность и хронология – его же функции, их передаёт registerEvents.
// Документ к расходу (11 §11.4) – по events/attachments.ts: владелец вложений event (чтение event.view, запись event.money.record,
// вне зоны 404), документ – вложение этого мероприятия и active (иначе 400 field attachmentId), операция – живая связь expense
// (иначе 404), одна живая на операцию, повтор – без изменений. Расход с чужим документом проверяется до проведения: операции нет.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { attachmentOf, attachmentOwners } from './mock-equipment.ts';
import { financeCommands, getFinanceOp, recordMoney } from './mock-finance.ts';
import { branchOfEvent, Fail, forbidden, invalid, isMoment, iso, notFound, opOfLink, summary, zodFail, type Ev, type EventsMockDeps, type Rec, type Staffish } from './mock-events.ts';

export interface EventMoneyHelpers {
  d: EventsMockDeps;
  eventOf: (s: Staffish, id: string, action: string) => Ev;
  command: (op: string, status: number, run: (s: Staffish, p: Record<string, string>, body: Rec) => unknown) => (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  read: (run: (s: Staffish, req: FastifyRequest) => unknown) => (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  idOf: (req: FastifyRequest) => string;
  tl: (e: Ev, s: Staffish, action: string, before: unknown, after: unknown, reason?: string | null) => unknown;
  reasonOf: (body: Rec, field?: string) => string;
  events: () => Ev[];
}

/** operationId → attachmentId живой строки (0435). Id операций случайные – сброс мока не нужен. */
const documents = new Map<string, string>();

export function registerEventMoney(app: FastifyInstance, P: string, h: EventMoneyHelpers): void {
  attachmentOwners.set('event', { read: 'event.view', write: 'event.money.record', branchOf: (id) => h.events().find((e) => e.id === id)?.branchId });
  const documentOf = (e: Ev, attachmentId: string) => {
    const a = attachmentOf(attachmentId);
    if (!a || a.ownerType !== 'event' || a.ownerId !== e.id || a.status !== 'active') throw invalid('Документ не найден у этого мероприятия', 'attachmentId');
    return a.id;
  };
  const setDocument = (e: Ev, s: Staffish, operationId: string, attachmentId: string) => {
    const before = documents.get(operationId);
    if (before === attachmentId) return;
    documents.set(operationId, attachmentId);
    h.tl(e, s, 'event.money_linked', before ? { operationId, attachmentId: before } : null, { operationId, attachmentId });
  };
  const METHODS = ['cash', 'card', 'transfer'];
  function assertPlace(body: Rec) {
    if (!METHODS.includes(String(body.method))) throw zodFail('method');
    if (typeof body.amountKop !== 'number') throw zodFail('amountKop');
    if (body.place !== undefined && body.place !== (body.method === 'cash' ? 'cash' : 'noncash')) throw invalid('Место денег не соответствует способу оплаты', 'place');
  }
  const assertLine = (e: Ev, lineId: unknown) => {
    if (lineId != null && !e.lines.some((l) => l.id === lineId)) throw invalid('Строка состава не из этого мероприятия', 'lineId');
  };

  app.get(`${P}/events/:id/money`, h.read((s, req) => {
    const e = h.eventOf(s, h.idOf(req), 'event.money.view');
    const operations = e.links.map(opOfLink).filter((x) => x !== null).map((o) => (o.role === 'expense' ? { ...o, attachmentId: documents.get(o.operation.id) ?? null } : o));
    return { summary: summary(e), operations };
  }));
  app.post(`${P}/events/:id/income`, h.command('income', 201, (s, p, body) => {
    assertPlace(body);
    if (!isMoment(body.occurredAt)) throw zodFail('occurredAt');
    const e = h.eventOf(s, p.id!, 'event.money.record');
    const op = financeCommands().income(s, e.branchId, { method: body.method, amountKop: body.amountKop, source: 'event', occurredAt: body.occurredAt, comment: body.comment ?? null, receiptIssued: body.receiptIssued ?? null, ref: { type: 'event', id: e.id } });
    e.links.push({ operationId: op.id, role: 'income', inCost: false, lineId: null, linkedAt: iso(Date.now()) });
    return op;
  }));
  app.post(`${P}/events/:id/refund`, h.command('refund', 201, (s, p, body) => {
    assertPlace(body);
    if (typeof body.incomeOperationId !== 'string') throw zodFail('incomeOperationId');
    const e = h.eventOf(s, p.id!, 'event.money.record');
    const income = getFinanceOp(body.incomeOperationId);
    if (!income || income.kind !== 'income' || income.ref?.type !== 'event' || income.ref.id !== e.id) throw notFound();
    if (!h.d.can(s, 'finance.refund')) throw forbidden('finance.refund');
    const reason = h.reasonOf(body);
    if (!Number.isSafeInteger(body.amountKop) || (body.amountKop as number) <= 0) throw new Fail(422, 'INVALID_AMOUNT', 'Сумма – целое число копеек больше нуля');
    if (income.reversedBy) throw new Fail(409, 'OPERATION_REVERSED', 'Поступление уже сторнировано', { operationId: income.id });
    const refunded = e.links.filter((l) => l.role === 'refund').map(opOfLink).filter((x) => x && x.operation.ref?.id === income.id).reduce((a, x) => a + x!.operation.amountKop, 0);
    if (refunded + (body.amountKop as number) > income.amountKop) throw new Fail(409, 'EVENT_REFUND_EXCEEDS_INCOME', 'Сумма возврата больше поступления', { availableKop: income.amountKop - refunded });
    const op = recordMoney({ branchId: e.branchId, timezone: branchOfEvent(h.d, e).timezone, kind: 'refund', method: body.method as 'cash', amountKop: body.amountKop as number, source: null, ref: { type: 'operation', id: income.id }, comment: reason, authorId: s.id });
    e.links.push({ operationId: op.id, role: 'refund', inCost: false, lineId: null, linkedAt: iso(Date.now()) });
    return getFinanceOp(op.id);
  }));
  app.post(`${P}/events/:id/expense`, h.command('expense', 201, (s, p, body) => {
    assertPlace(body);
    if (typeof body.categoryId !== 'string' || !isMoment(body.occurredAt)) throw zodFail('expense');
    if (body.attachmentId != null && typeof body.attachmentId !== 'string') throw zodFail('attachmentId');
    const e = h.eventOf(s, p.id!, 'event.money.record');
    assertLine(e, body.lineId);
    const doc = body.attachmentId ? documentOf(e, body.attachmentId as string) : null;
    const text = String(body.comment ?? '').trim();
    const comment = body.supplier && text ? `${text} (поставщик: ${body.supplier as string})` : text;
    const op = financeCommands().expense(s, e.branchId, { method: body.method, amountKop: body.amountKop, categoryId: body.categoryId, subcategoryId: body.subcategoryId ?? null, occurredAt: body.occurredAt, comment, ref: { type: 'event', id: e.id } });
    e.links.push({ operationId: op.id, role: 'expense', inCost: (body.inCost as boolean | undefined) ?? true, lineId: (body.lineId as string | null | undefined) ?? null, linkedAt: iso(Date.now()) });
    if (doc) setDocument(e, s, op.id, doc);
    return { ...op, attachmentId: doc };
  }));
  app.post(`${P}/events/:id/expense/:operationId/document`, h.command('expense.document', 200, (s, p, body) => {
    if (typeof body.attachmentId !== 'string') throw zodFail('attachmentId');
    const e = h.eventOf(s, p.id!, 'event.money.record');
    const link = e.links.find((l) => l.operationId === p.operationId && l.role === 'expense');
    if (!link || !opOfLink(link)) throw notFound();
    const attachmentId = documentOf(e, body.attachmentId);
    setDocument(e, s, link.operationId, attachmentId);
    return { operationId: link.operationId, attachmentId };
  }));
  app.post(`${P}/events/:id/expense/link`, h.command('expense.link', 201, (s, p, body) => {
    if (typeof body.operationId !== 'string') throw zodFail('operationId');
    const e = h.eventOf(s, p.id!, 'event.money.record');
    assertLine(e, body.lineId);
    const op = getFinanceOp(body.operationId);
    if (!op || op.branchId !== e.branchId) throw notFound();
    if (e.links.some((l) => l.operationId === op.id)) throw new Fail(409, 'OPERATION_ALREADY_LINKED', 'Этот расход уже учтён в мероприятии', { ref: { type: 'event', id: e.id }, role: 'expense' });
    // одна операция – не больше одной живой связи (K17 §14)
    if (h.events().some((x) => x.links.some((l) => l.operationId === op.id)) || op.ref) throw new Fail(409, 'OPERATION_ALREADY_LINKED', 'Операция уже связана', { ref: null, role: 'expense' });
    if (op.kind !== 'expense' || op.reversedBy) throw new Fail(422, 'OPERATION_LINK_INVALID', 'Эту операцию нельзя привязать');
    e.links.push({ operationId: op.id, role: 'expense', inCost: (body.inCost as boolean | undefined) ?? false, lineId: (body.lineId as string | null | undefined) ?? null, linkedAt: iso(Date.now()) });
    h.tl(e, s, 'event.money_linked', null, { operationId: op.id, amountKop: op.amountKop });
    return { linked: true };
  }));
}

// Мок мероприятий CRM строго по apps/api/src/modules/events/routes.crm.ts, routes.gifts.ts, events.ts, lines.ts, resources.ts,
// money.ts, gifts.ts, party.ts и network/holidays.ts (K20 §15 №361–370, 376–379): без event.money.view – только dueKop и ни одной
// плановой себестоимости; перенос – EVENT_MOVE_RESOURCES_INVALID (missing, duplicate, outside_planned) и откат; вторая привязка
// расхода – OPERATION_ALREADY_LINKED; один подарок в 365 дней. Деньги – настоящие операции mock-finance (одна строка в журнале).
// Категории оборудования и исполнители (equipment/routes*.ts, №337, №349) ставятся, только если их ещё не поставил другой мок.
// Подключается из mock-api.ts (registerEvents – последним, resetEvents – после resetFinance).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { addGiftBooking, bookingFacts, bookingBusy, setExternalBusy } from './mock-booking.ts';
import { financeCommands, getFinanceOp, recordMoney } from './mock-finance.ts';
import { opsHoursOn, opsState } from './mock-ops.ts';

type Rec = Record<string, unknown>;
type Role = 'owner' | 'director' | 'admin';
interface Staffish { id: string; role: string }
interface BranchLite { id: string; cityId: string; name: string; timezone: string }
interface ClientLite { id: string; status: string }
export interface EventsMockDeps {
  current: (req: FastifyRequest) => Staffish;
  zone: (s: Staffish) => { network: boolean; branchIds: string[] };
  can: (s: Staffish, action: string) => boolean;
  branches: () => BranchLite[];
  clients: () => ClientLite[];
}

/** K1 «Действия Э3» – то, что отдаёт /me этого среза. */
export const EVENT_ACTIONS: Record<Role, string[]> = {
  owner: ['event.view', 'event.manage', 'event.price.manage', 'event.money.view', 'event.money.record', 'event.package.manage', 'event.type.manage', 'gift.issue', 'gift.issue.manual', 'gift.cancel', 'gift.book', 'holiday.manage', 'equipment.view', 'equipment.category.manage', 'repair.executor.manage'],
  director: ['event.view', 'event.manage', 'event.price.manage', 'event.money.view', 'event.money.record', 'gift.issue', 'gift.book', 'equipment.view', 'repair.executor.manage'],
  admin: ['event.view', 'event.manage', 'event.money.record', 'gift.issue', 'gift.book', 'equipment.view'],
};

class Fail extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Rec;
  constructor(status: number, code: string, message: string, details?: Rec) {
    super(message);
    this.status = status;
    this.code = code;
    if (details) this.details = details;
  }
}
const notFound = () => new Fail(404, 'NOT_FOUND', 'Не найдено');
const invalid = (message: string, field: string) => new Fail(400, 'VALIDATION_FAILED', message, { field });
const zodFail = (path: string) => new Fail(400, 'VALIDATION_FAILED', 'Неверные данные запроса', { issues: [{ path, message: 'Invalid input' }] });
const forbidden = (action: string) => new Fail(403, 'FORBIDDEN', 'Недостаточно прав', { action });
const needReason = (field = 'reason') => new Fail(422, 'COMMENT_REQUIRED', 'Укажите причину', { field });

interface Line {
  id: string; eventId: string; kind: string; name: string; quantity: number; unit: string; priceKop: number; discountKop: number; discountReason: string | null;
  planCostKop: number | null; supplier: string | null; comment: string | null; status: 'active' | 'removed'; removedReason: string | null; rowVersion: number;
}
interface EvResource { id: string; eventId: string; resourceId: string; start: number; end: number; unitIds: string[]; status: 'active' | 'released'; releaseReason: string | null; reservedAt: number; reminded: boolean }
interface Check { id: string; code: string | null; title: string; status: string; responsibleStaffId: string | null; comment: string | null; updatedBy: string | null; updatedAt: string | null }
interface OpLink { operationId: string; role: 'income' | 'refund' | 'expense'; inCost: boolean; lineId: string | null; linkedAt: string }
interface Tl { id: string; at: string; action: string; actorType: string; actorId: string | null; actorRole: string | null; before: unknown; after: unknown; reason: string | null; result: string }
interface Ev {
  id: string; number: string; typeId: string; title: string; branchId: string; plannedStart: string | null; plannedEnd: string | null; status: string;
  customerClientId: string | null; customerName: string; customerPhone: string; birthdayClientId: string | null; birthdayName: string | null; participants: number | null;
  responsibleStaffId: string | null; wishes: string | null; packageId: string | null; party: { format: string; guests: number; catering: boolean } | null; source: 'crm' | 'site';
  cancel: { reason: string; by: string | null; at: string } | null; rowVersion: number; createdAt: number;
  lines: Line[]; resources: EvResource[]; checklist: Check[]; bookingIds: string[]; links: OpLink[]; timeline: Tl[];
}
interface EvType { id: string; code: string; name: string; status: 'active' | 'archived'; rowVersion: number }
interface Pack { id: string; typeId: string; name: string; lines: Array<Rec & { name: string; priceKop: number }>; approxPriceKop: number | null; status: 'active' | 'archived'; rowVersion: number }
interface GiftRec { id: string; number: string; clientId: string; basisEventId: string | null; issuedOn: string; validUntil: string; issueBranchId: string; terms: Rec; status: string; bookingId: string | null; cancelReason: string | null; rowVersion: number }
interface HolidayRec { id: string; scope: 'network' | 'city'; cityId: string | null; date: string; name: string; status: 'active' | 'cancelled' }
interface Category { id: string; name: string; sortOrder: number; status: 'active' | 'archived' }
interface Executor { id: string; kind: string; name: string; staffId: string | null; contactPerson: string | null; phone: string | null; email: string | null; address: string | null; inn: string | null; comment: string | null; status: 'active' | 'archived'; rowVersion: number }

let events: Ev[] = [];
let types: EvType[] = [];
let packs: Pack[] = [];
let gifts: GiftRec[] = [];
let holidays: HolidayRec[] = [];
let categories: Category[] = [];
let executors: Executor[] = [];
let evSeq = 123;
let giftSeq = 40;
let replays = new Map<string, { hash: string; status: number; body: unknown }>();

// ---- время зоны филиала

const localDate = (at: number, tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(at));
const localHM = (at: number, tz: string) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(at));
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
function zoned(date: string, hm: string, tz: string): number {
  const naive = Date.parse(`${date}T${hm}:00Z`);
  const shown = (at: number) => Date.parse(`${localDate(at, tz)}T${localHM(at, tz)}:00Z`);
  return naive - (shown(naive) - naive);
}
const isMoment = (v: unknown): v is string => typeof v === 'string' && /T.*(Z|[+-]\d{2}:\d{2})$/.test(v) && !Number.isNaN(Date.parse(v));
const iso = (ms: number) => new Date(ms).toISOString();
const round = (x: number) => Math.round(x);
const CLIENT = (n: number) => `c0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const mask = (p: string) => (p.length >= 4 ? `+7 *** ***-${p.slice(-4, -2)}-${p.slice(-2)}` : '***');
const normalize = (raw: unknown): string => {
  const d = String(raw ?? '').replace(/\D/g, '');
  if (d.length === 11 && (d[0] === '7' || d[0] === '8')) return `+7${d.slice(1)}`;
  if (d.length === 10) return `+7${d}`;
  throw new Fail(400, 'VALIDATION_FAILED', 'Неверный номер телефона', { field: 'customer.phone' });
};

const CHECKLIST: Array<[string, string]> = [
  ['date', 'Подтверждение даты и времени'], ['composition', 'Подтверждение состава услуг'], ['participants', 'Подтверждение количества участников'],
  ['responsible', 'Назначение ответственного сотрудника'], ['contractor', 'Подтверждение аниматора или подрядчика'], ['catering', 'Заказ кейтеринга'],
  ['room', 'Подготовка комнаты и оборудования'], ['purchase', 'Закупка расходных материалов'], ['payment', 'Проверка оплаты или предоплаты'], ['gift', 'Подготовка подарка имениннику'],
];
const TRANSITIONS: Record<string, string[]> = {
  new_request: ['negotiation', 'awaiting_confirmation', 'cancelled'], negotiation: ['awaiting_confirmation', 'cancelled'], awaiting_confirmation: ['confirmed', 'negotiation', 'cancelled'],
  confirmed: ['preparing', 'in_progress', 'cancelled', 'not_held'], preparing: ['in_progress', 'cancelled', 'not_held'], in_progress: ['completed'], completed: [], cancelled: [], not_held: [],
};
const STATUSES = Object.keys(TRANSITIONS);
const closed = (s: string) => s === 'completed' || s === 'cancelled' || s === 'not_held';
const typeOf = (e: Ev) => types.find((t) => t.id === e.typeId)!;
const branchOfEvent = (d: EventsMockDeps, e: Ev) => d.branches().find((b) => b.id === e.branchId)!;

/** round(quantity × price − discount): на сотых, как numeric сервера. */
const lineTotal = (l: Line) => round(round(l.quantity * 100) * l.priceKop / 100 - l.discountKop);
function summary(e: Ev) {
  const active = e.lines.filter((l) => l.status === 'active');
  const agreedKop = active.reduce((a, l) => a + lineTotal(l), 0);
  const planCostKop = active.reduce((a, l) => a + (l.planCostKop ?? 0), 0);
  const discountsKop = active.reduce((a, l) => a + l.discountKop, 0);
  let receivedKop = 0;
  let refundedKop = 0;
  let factCostKop = 0;
  for (const link of e.links) {
    const op = getFinanceOp(link.operationId);
    if (!op || op.reversedBy) continue; // linksOf: живые операции
    if (link.role === 'income') receivedKop += op.amountKop;
    else if (link.role === 'refund') refundedKop += op.amountKop;
    else if (link.inCost) factCostKop += op.amountKop;
  }
  return {
    agreedKop, receivedKop, refundedKop, dueKop: agreedKop - receivedKop + refundedKop, planCostKop, factCostKop, resultKop: receivedKop - refundedKop - factCostKop,
    deviationKop: factCostKop - planCostKop, discountsKop, giftsIssued: gifts.filter((g) => g.basisEventId === e.id && g.status !== 'cancelled').length,
  };
}
const dto = (d: EventsMockDeps, e: Ev) => ({
  id: e.id, number: e.number, typeId: e.typeId, typeCode: typeOf(e).code, title: e.title, branchId: e.branchId, timezone: branchOfEvent(d, e).timezone,
  plannedStart: e.plannedStart, plannedEnd: e.plannedEnd, status: e.status, customer: { clientId: e.customerClientId, name: e.customerName, phoneMasked: mask(e.customerPhone) },
  birthdayPerson: { clientId: e.birthdayClientId, name: e.birthdayName }, participantsCount: e.participants, responsibleStaffId: e.responsibleStaffId, wishes: e.wishes,
  packageId: e.packageId, party: e.party, source: e.source, cancel: e.cancel, rowVersion: e.rowVersion,
});
const resourceDto = (d: EventsMockDeps, e: Ev, r: EvResource) => {
  const info = opsState().resources.find((x) => x.id === r.resourceId);
  void d;
  return {
    id: r.id, eventId: r.eventId, resourceId: r.resourceId, resourceName: info?.name ?? '', resourceType: info?.type ?? '', start: iso(r.start), end: iso(r.end), unitIds: r.unitIds, status: r.status, releaseReason: r.releaseReason,
    requestHold: r.status === 'active' && e.status === 'new_request' ? { expiresAt: iso(r.reservedAt + 48 * 3_600_000), remind: r.reminded } : null,
  };
};
const checklistDto = (e: Ev) => e.checklist.map((c) => (c.code === 'payment' ? { ...c, dueKop: summary(e).dueKop } : c));
const opOfLink = (l: OpLink) => {
  const op = getFinanceOp(l.operationId);
  return op && !op.reversedBy ? { operation: op, role: l.role, inCost: l.inCost, lineId: l.lineId, linkedAt: l.linkedAt } : null;
};

function newEvent(v: { typeCode: string; title?: string; branchId: string; start?: number; end?: number; status?: string; customer: [string, string, string | null]; birthday?: [string | null, string | null]; participants?: number; responsible?: string; party?: Ev['party']; at: number; source?: 'crm' | 'site' }): Ev {
  const type = types.find((t) => t.code === v.typeCode)!;
  return {
    id: randomUUID(), number: `EV-${String(++evSeq).padStart(6, '0')}`, typeId: type.id, title: v.title ?? type.name, branchId: v.branchId, plannedStart: v.start ? iso(v.start) : null, plannedEnd: v.end ? iso(v.end) : null,
    status: v.status ?? 'new_request', customerName: v.customer[0], customerPhone: v.customer[1], customerClientId: v.customer[2], birthdayClientId: v.birthday?.[0] ?? null, birthdayName: v.birthday?.[1] ?? null,
    participants: v.participants ?? null, responsibleStaffId: v.responsible ?? null, wishes: null, packageId: null, party: v.party ?? null, source: v.source ?? 'crm', cancel: null, rowVersion: 1, createdAt: v.at,
    lines: [], resources: [], bookingIds: [], links: [], timeline: [],
    checklist: CHECKLIST.map(([code, title]) => ({ id: randomUUID(), code, title, status: 'todo', responsibleStaffId: null, comment: null, updatedBy: null, updatedAt: null })),
  };
}
function seedLine(e: Ev, v: Partial<Line> & { kind: string; name: string; priceKop: number }): Line {
  const l: Line = { id: randomUUID(), eventId: e.id, quantity: 1, unit: 'шт', discountKop: 0, discountReason: null, planCostKop: null, supplier: null, comment: null, status: 'active', removedReason: null, rowVersion: 1, ...v };
  e.lines.push(l);
  return l;
}

export function resetEvents(branches: BranchLite[]): void {
  replays = new Map();
  evSeq = 123;
  giftSeq = 40;
  const now = Date.now();
  const K = 'b-nsk-krasny';
  const tz = branches.find((b) => b.id === K)!.timezone;
  const today = localDate(now, tz);
  // ближайший будний день ≥ today+n: у праздника в посеве своя дата
  const weekday = (n: number) => {
    let d = addDays(today, n);
    while ([0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay())) d = addDays(d, 1);
    return d;
  };
  types = [
    ['00000000-0000-4000-a000-000000000001', 'birthday_party', 'Платный праздник'], ['00000000-0000-4000-a000-000000000002', 'birthday', 'День рождения без аренды комнаты'],
    ['00000000-0000-4000-a000-000000000003', 'group_visit', 'Групповое посещение'], ['00000000-0000-4000-a000-000000000004', 'program', 'Программа'], ['00000000-0000-4000-a000-000000000005', 'other', 'Другое'],
  ].map(([id, code, name]) => ({ id: id!, code: code!, name: name!, status: 'active' as const, rowVersion: 1 }));
  packs = [{
    id: '00000000-0000-4000-b000-000000000001', typeId: types[0]!.id, name: 'Праздник «Старт»', approxPriceKop: 1_500_000, status: 'active', rowVersion: 1,
    lines: [
      { kind: 'room_rent', name: 'Комната VR+PS4, 2 часа', quantity: 1, unit: 'шт', priceKop: 1_000_000, planCostKop: 200_000, supplier: null, comment: null },
      { kind: 'animator', name: 'Аниматор', quantity: 2, unit: 'ч', priceKop: 250_000, planCostKop: 150_000, supplier: 'Праздник рядом', comment: null },
    ],
  }];
  holidays = [
    { id: randomUUID(), scope: 'network', cityId: null, date: weekday(7), name: 'Праздник сети', status: 'active' },
    { id: randomUUID(), scope: 'city', cityId: 'c-tsk', date: weekday(14), name: 'День города Томск', status: 'active' },
  ];
  gifts = [];
  categories = [{ id: randomUUID(), name: 'VR-шлемы', sortOrder: 10, status: 'active' }, { id: randomUUID(), name: 'Приставки', sortOrder: 20, status: 'active' }, { id: randomUUID(), name: 'Старая мебель', sortOrder: 30, status: 'archived' }];
  executors = [{ id: randomUUID(), kind: 'contractor', name: 'ВР-Сервис', staffId: null, contactPerson: 'Игорь', phone: '+79130001122', email: null, address: null, inn: null, comment: null, status: 'active', rowVersion: 1 }];
  events = [];

  // Платный праздник: подтверждён, с комнатой, оплатой, расходом
  const party = newEvent({ typeCode: 'birthday_party', title: 'День рождения Ивана', branchId: K, start: zoned(weekday(5), '14:00', tz), end: zoned(weekday(5), '16:00', tz), status: 'confirmed', customer: ['Мария Иванова', '+79131234567', CLIENT(1)], birthday: [CLIENT(1), 'Иван'], participants: 8, responsible: 's-admin', party: { format: 'h2', guests: 8, catering: true }, at: now - 3 * 86_400_000 });
  const room = seedLine(party, { kind: 'room_rent', name: 'Комната VR+PS4, 2 часа', priceKop: 1_000_000, planCostKop: 200_000 });
  seedLine(party, { kind: 'catering', name: 'Праздничный стол', quantity: 8, unit: 'порц.', priceKop: 50_000, discountKop: 20_000, discountReason: 'Постоянный клиент', planCostKop: 240_000, supplier: 'Кейтеринг Плюс' });
  party.resources.push({ id: randomUUID(), eventId: party.id, resourceId: 'res-vrroom', start: Date.parse(party.plannedStart!), end: Date.parse(party.plannedEnd!), unitIds: [...(opsState().composition['res-vrroom'] ?? [])], status: 'active', releaseReason: null, reservedAt: now - 86_400_000, reminded: false });
  const income = recordMoney({ branchId: K, timezone: tz, kind: 'income', method: 'card', amountKop: 500_000, source: 'event', ref: { type: 'event', id: party.id }, comment: 'Предоплата', authorId: 's-owner', receiptIssued: true });
  party.links.push({ operationId: income.id, role: 'income', inCost: false, lineId: null, linkedAt: iso(now) });
  party.timeline.push({ id: randomUUID(), at: iso(now - 3 * 86_400_000), action: 'event.created', actorType: 'staff', actorId: 's-owner', actorRole: 'owner', before: null, after: { title: party.title }, reason: null, result: 'success' });
  party.timeline.push({ id: randomUUID(), at: iso(now - 86_400_000), action: 'event.status_changed', actorType: 'staff', actorId: 's-owner', actorRole: 'owner', before: { status: 'awaiting_confirmation' }, after: { status: 'confirmed' }, reason: null, result: 'success' });
  void room;
  events.push(party);

  // Заявка с сайта без профиля и без даты, неоплаченный остаток – 0
  events.push(newEvent({ typeCode: 'birthday_party', title: 'Заявка с сайта: праздник', branchId: K, customer: ['Пётр Без Профиля', '+79137654321', null], participants: 6, source: 'site', at: now - 86_400_000 }));

  // Заявка, у которой комната держится, пора напомнить
  const held = newEvent({ typeCode: 'group_visit', title: 'Группа школы №5', branchId: K, start: zoned(weekday(6), '11:00', tz), end: zoned(weekday(6), '13:00', tz), customer: ['Школа №5', '+79130000055', null], participants: 12, at: now - 2 * 86_400_000 });
  held.resources.push({ id: randomUUID(), eventId: held.id, resourceId: 'res-pc1', start: Date.parse(held.plannedStart!), end: Date.parse(held.plannedEnd!), unitIds: [...(opsState().composition['res-pc1'] ?? [])], status: 'active', releaseReason: null, reservedAt: now - 30 * 3_600_000, reminded: true });
  seedLine(held, { kind: 'service', name: 'Групповой сеанс', priceKop: 900_000, planCostKop: 100_000 });
  events.push(held);

  // День рождения идёт: основание подарка
  const birthday = newEvent({ typeCode: 'birthday', title: 'День рождения Анны', branchId: K, start: now - 3_600_000, end: now + 3_600_000, status: 'in_progress', customer: ['Анна Смирнова', '+79139990011', CLIENT(2)], birthday: [CLIENT(2), 'Анна'], participants: 4, at: now - 5 * 86_400_000 });
  seedLine(birthday, { kind: 'service', name: 'Игровое время', priceKop: 300_000 });
  events.push(birthday);

  // Чужая зона: Томск
  events.push(newEvent({ typeCode: 'program', title: 'Турнир в Томске', branchId: 'b-tsk-lenina', start: zoned(weekday(8), '12:00', 'Asia/Tomsk'), end: zoned(weekday(8), '15:00', 'Asia/Tomsk'), customer: ['Томский клуб', '+79130002233', null], at: now - 4 * 86_400_000 }));
}

export function registerEvents(app: FastifyInstance, P: string, d: EventsMockDeps): void {
  const inZone = (s: Staffish, branchId: string) => d.zone(s).network || d.zone(s).branchIds.includes(branchId);
  const canAt = (s: Staffish, action: string, branchId: string) => d.can(s, action) && inZone(s, branchId);
  const seesMoney = (s: Staffish, e: Ev) => canAt(s, 'event.money.view', e.branchId);
  const moneyView = (s: Staffish, e: Ev) => (seesMoney(s, e) ? summary(e) : { dueKop: summary(e).dueKop });
  const lineView = (s: Staffish, e: Ev, l: Line) => {
    if (seesMoney(s, e)) return l;
    const { planCostKop: _h, ...rest } = l;
    void _h;
    return rest;
  };
  const packView = (s: Staffish, p: Pack) => (d.can(s, 'event.money.view') ? p : { ...p, lines: p.lines.map(({ planCostKop: _h, ...rest }) => (void _h, rest)) });
  const anyZone = (s: Staffish) => {
    if (!d.can(s, 'event.view')) throw forbidden('event.view');
  };
  function guard(s: Staffish, branchId: string, action: string): void {
    if (!canAt(s, 'event.view', branchId)) throw notFound();
    if (!canAt(s, action, branchId)) throw forbidden(action);
  }
  function eventOf(s: Staffish, id: string, action: string): Ev {
    const e = events.find((x) => x.id === id);
    if (!e) throw notFound();
    guard(s, e.branchId, action);
    return e;
  }
  const assertOpen = (e: Ev, what = 'состав') => {
    if (closed(e.status)) throw new Fail(409, 'EVENT_CLOSED', `Мероприятие завершено – ${what} не меняется`, { status: e.status });
  };
  const assertVersion = (e: { rowVersion: number }, body: Rec) => {
    if (!Number.isInteger(body.rowVersion)) throw zodFail('rowVersion');
    if (body.rowVersion !== e.rowVersion) throw new Fail(409, 'VERSION_CONFLICT', 'Запись уже изменили – обновите карточку', { current: e.rowVersion });
  };
  const reasonOf = (body: Rec, field = 'reason') => {
    const r = typeof body[field] === 'string' ? (body[field] as string).trim() : '';
    if (!r) throw needReason(field);
    return r;
  };
  const tl = (e: Ev, s: Staffish, action: string, before: unknown, after: unknown, reason: string | null = null) =>
    e.timeline.push({ id: randomUUID(), at: iso(Date.now()), action, actorType: 'staff', actorId: s.id, actorRole: s.role, before, after, reason, result: 'success' });
  const send = (reply: FastifyReply, e: unknown) => {
    if (!(e instanceof Error) || !('status' in e) || !('code' in e)) throw e;
    const f = e as Fail;
    return reply.code(f.status).send({ error: { code: f.code, message: f.message, ...(f.details ? { details: f.details } : {}), requestId: randomUUID() } });
  };

  /** Команда с Idempotency-Key: повтор с тем же телом – тот же ответ, с другим телом – IDEMPOTENCY_KEY_REUSED. */
  function command(op: string, status: number, run: (s: Staffish, p: Record<string, string>, body: Rec) => unknown) {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const s = d.current(req);
        const key = String(req.headers['idempotency-key'] ?? '').trim();
        if (!key) throw new Fail(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Нужен заголовок Idempotency-Key');
        const p = req.params as Record<string, string>;
        const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Rec;
        const hash = createHash('sha256').update(JSON.stringify([p, body])).digest('hex');
        const memo = `${s.id}:${op}:${key}`;
        const seen = replays.get(memo);
        if (seen) {
          if (seen.hash !== hash) throw new Fail(409, 'IDEMPOTENCY_KEY_REUSED', 'Ключ уже использован для другого запроса');
          return reply.code(seen.status).header('idempotent-replay', 'true').send(seen.body);
        }
        const out = run(s, p, body);
        replays.set(memo, { hash, status, body: out });
        return reply.code(status).send(out);
      } catch (e) {
        return send(reply, e);
      }
    };
  }
  const read = (run: (s: Staffish, req: FastifyRequest) => unknown) => async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      return run(d.current(req), req);
    } catch (e) {
      return send(reply, e);
    }
  };
  const idOf = (req: FastifyRequest) => (req.params as { id: string }).id;

  // ---- №361 список, №362 карточка

  app.get(`${P}/events`, read((s, req) => {
    const q = req.query as Record<string, string | undefined>;
    const limit = q.limit === undefined ? 50 : Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw zodFail('limit');
    for (const f of ['from', 'to'] as const) if (q[f] !== undefined && !isMoment(q[f])) throw zodFail(f);
    if (q.status && !STATUSES.includes(q.status)) throw zodFail('status');
    if (q.customer !== undefined && (q.customer.trim() === '' || q.customer.length > 100)) throw zodFail('customer');
    const needle = q.customer?.trim().toLowerCase();
    const digits = needle?.replace(/\D/g, '') ?? '';
    const all = events
      .filter((e) => canAt(s, 'event.view', e.branchId))
      .filter((e) => !q.from || (e.plannedStart !== null && Date.parse(e.plannedStart) >= Date.parse(q.from)))
      .filter((e) => !q.to || (e.plannedStart !== null && Date.parse(e.plannedStart) < Date.parse(q.to)))
      .filter((e) => (!q.branchId || e.branchId === q.branchId) && (!q.typeId || e.typeId === q.typeId) && (!q.status || e.status === q.status) && (!q.responsibleId || e.responsibleStaffId === q.responsibleId))
      .filter((e) => !needle || e.customerName.toLowerCase().includes(needle) || (digits.length >= 4 && e.customerPhone.endsWith(digits)))
      .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
    let start = 0;
    if (q.cursor) {
      if (!/^\d{1,16}:[0-9a-f-]{36}$/i.test(q.cursor)) throw zodFail('cursor');
      start = all.findIndex((e) => e.id === q.cursor!.split(':')[1]) + 1;
    }
    const rows = all.slice(start, start + limit);
    const items = rows
      .filter((e) => (q.hasDue === 'true' ? summary(e).dueKop > 0 : q.hasDue === 'false' ? summary(e).dueKop <= 0 : true))
      .map((e) => ({ ...dto(d, e), money: moneyView(s, e), requestHoldRemind: e.status === 'new_request' && e.resources.some((r) => r.status === 'active' && r.reminded) }));
    const last = rows.at(-1);
    return { items, nextCursor: all.length > start + limit && last ? `${last.createdAt}:${last.id}` : null };
  }));

  const card = (s: Staffish, e: Ev) => {
    const money = seesMoney(s, e);
    return {
      ...dto(d, e), money: moneyView(s, e), lines: e.lines.map((l) => lineView(s, e, l)), resources: e.resources.map((r) => resourceDto(d, e, r)), checklist: checklistDto(e), bookingIds: e.bookingIds,
      timeline: [...e.timeline].reverse().map((t) => { if (money) return t; const { before: _b, after: _a, ...rest } = t; void _b; void _a; return rest; }),
    };
  };
  app.get(`${P}/events/:id`, read((s, req) => card(s, eventOf(s, idOf(req), 'event.view'))));

  app.post(`${P}/events`, command('create', 201, (s, _p, body) => {
    const c = body.customer as Rec | undefined;
    if (typeof body.typeId !== 'string' || typeof body.branchId !== 'string' || !c || typeof c.name !== 'string' || !c.name.trim() || typeof c.phone !== 'string') throw zodFail('customer');
    const branch = d.branches().find((b) => b.id === body.branchId);
    if (!branch) throw notFound();
    guard(s, branch.id, 'event.manage');
    const type = types.find((t) => t.id === body.typeId && t.status === 'active');
    if (!type) throw invalid('Тип мероприятия не найден', 'typeId');
    for (const f of ['plannedStart', 'plannedEnd']) if (body[f] != null && !isMoment(body[f])) throw zodFail(f);
    if (body.plannedStart && body.plannedEnd && Date.parse(body.plannedEnd as string) <= Date.parse(body.plannedStart as string)) throw invalid('Конец раньше начала', 'plannedEnd');
    const isParty = type.code === 'birthday_party';
    const party = (body.party ?? null) as Ev['party'];
    if (party && !isParty) throw invalid('Формат праздника – только у платного праздника', 'party');
    if (party) guests(party.guests);
    if (isParty && body.participantsCount != null) guests(body.participantsCount as number);
    const b = (body.birthdayPerson ?? {}) as Rec;
    const e: Ev = {
      ...newEvent({ typeCode: type.code, title: (body.title as string | undefined)?.trim() || type.name, branchId: branch.id, customer: [c.name.trim(), normalize(c.phone), (c.clientId as string | null | undefined) ?? null], at: Date.now(), birthday: [(b.clientId as string | null | undefined) ?? null, (b.name as string | null | undefined) ?? null] }),
      plannedStart: (body.plannedStart as string | null | undefined) ? iso(Date.parse(body.plannedStart as string)) : null,
      plannedEnd: (body.plannedEnd as string | null | undefined) ? iso(Date.parse(body.plannedEnd as string)) : null,
      participants: (body.participantsCount as number | null | undefined) ?? null, responsibleStaffId: (body.responsibleStaffId as string | null | undefined) ?? null, wishes: (body.wishes as string | null | undefined)?.trim() || null, packageId: (body.packageId as string | null | undefined) ?? null, party: party ? { format: party.format, guests: party.guests, catering: party.catering ?? false } : null,
    };
    events.push(e);
    tl(e, s, 'event.created', null, { title: e.title, status: e.status });
    return dto(d, e);
  }));

  function guests(n: unknown) {
    if (!Number.isInteger(n) || (n as number) < 1 || (n as number) > 10) throw new Fail(422, 'PARTY_GUESTS_LIMIT', 'Гостей на празднике – от 1 до 10', { max: 10 });
  }
  function assertRooms(e: Ev) {
    if (typeOf(e).code !== 'birthday_party') return;
    for (const r of e.resources.filter((x) => x.status === 'active')) assertParty(e, r.resourceId, r.start, r.end);
  }
  function assertParty(e: Ev, resourceId: string, s: number, en: number) {
    if (typeOf(e).code !== 'birthday_party') return;
    const r = opsState().resources.find((x) => x.id === resourceId)!;
    if (r.type !== 'room_whole') throw new Fail(422, 'PARTY_RESOURCE_INVALID', 'Праздник проходит только в комнате VR+PS4 целиком', { resourceType: r.type });
    const minutes = (en - s) / 60_000;
    if (minutes < 120) throw new Fail(422, 'PARTY_TOO_SHORT', 'Праздник – непрерывно не меньше 120 минут', { minMinutes: 120 });
    const f = e.party?.format;
    const tz = branchOfEvent(d, e).timezone;
    const h = opsHoursOn(e.branchId, localDate(s, tz), opsState().composition[resourceId] ?? []);
    const whole = h && localHM(s, tz) === h.open && localHM(en, tz) === h.close;
    if (f && !((f === 'h2' && minutes === 120) || (f === 'h3plus' && minutes >= 180) || (f === 'full_day' && whole))) throw new Fail(422, 'PARTY_FORMAT_MISMATCH', 'Длительность не соответствует формату праздника', { format: f });
  }

  app.patch(`${P}/events/:id`, command('update', 200, (s, p, body) => {
    const e = eventOf(s, p.id!, 'event.manage');
    assertVersion(e, body);
    assertOpen(e, 'правка');
    const start = body.plannedStart !== undefined ? ((body.plannedStart as string | null) && iso(Date.parse(body.plannedStart as string))) : e.plannedStart;
    const end = body.plannedEnd !== undefined ? ((body.plannedEnd as string | null) && iso(Date.parse(body.plannedEnd as string))) : e.plannedEnd;
    if (start && end && Date.parse(end) <= Date.parse(start)) throw invalid('Конец раньше начала', 'plannedEnd');
    if (start !== e.plannedStart || end !== e.plannedEnd) {
      if (e.resources.some((r) => r.status === 'active')) throw new Fail(400, 'VALIDATION_FAILED', 'Ресурсы заняты: дату и филиал меняет перенос', { reason: 'use_move' });
      if (['confirmed', 'preparing', 'in_progress'].includes(e.status) && (!start || !end)) throw new Fail(422, 'EVENT_NOT_READY', 'У подтверждённого мероприятия должны быть дата и время', { fields: ['plannedStart', 'plannedEnd'] });
    }
    const party = body.party !== undefined ? (body.party as Ev['party']) : e.party;
    if (party && typeOf(e).code !== 'birthday_party') throw invalid('Формат праздника – только у платного праздника', 'party');
    if (party && body.party !== undefined) guests(party.guests);
    if (typeOf(e).code === 'birthday_party' && body.participantsCount != null) guests(body.participantsCount);
    const before = { title: e.title, plannedStart: e.plannedStart, plannedEnd: e.plannedEnd, participantsCount: e.participants, responsibleStaffId: e.responsibleStaffId, wishes: e.wishes };
    const snap = { ...e };
    if (typeof body.title === 'string') e.title = body.title.trim();
    e.plannedStart = start as string | null;
    e.plannedEnd = end as string | null;
    const c = body.customer as Rec | undefined;
    if (c) {
      e.customerClientId = (c.clientId as string | null | undefined) ?? null;
      e.customerName = String(c.name);
      if (c.phone !== undefined) e.customerPhone = normalize(c.phone);
    }
    const b = body.birthdayPerson as Rec | undefined;
    if (b) {
      e.birthdayClientId = (b.clientId as string | null | undefined) ?? null;
      e.birthdayName = (b.name as string | null | undefined) ?? null;
    }
    if (body.participantsCount !== undefined) e.participants = body.participantsCount as number | null;
    if (body.responsibleStaffId !== undefined) e.responsibleStaffId = body.responsibleStaffId as string | null;
    if (body.wishes !== undefined) e.wishes = (body.wishes as string | null)?.trim() || null;
    e.party = party ? { format: party.format, guests: party.guests, catering: party.catering ?? false } : null;
    try {
      if (body.party !== undefined || body.participantsCount !== undefined) assertRooms(e);
    } catch (err) {
      Object.assign(e, snap);
      throw err;
    }
    e.rowVersion++;
    tl(e, s, 'event.updated', before, { title: e.title, plannedStart: e.plannedStart, plannedEnd: e.plannedEnd, participantsCount: e.participants, responsibleStaffId: e.responsibleStaffId, wishes: e.wishes }, typeof body.reason === 'string' ? body.reason : null);
    return dto(d, e);
  }));

  // №363: история и «требует решения»
  app.post(`${P}/events/:id/status`, command('status', 200, (s, p, body) => {
    const e = eventOf(s, p.id!, 'event.manage');
    if (!STATUSES.includes(String(body.to))) throw zodFail('to');
    assertVersion(e, body);
    const to = String(body.to);
    if (!TRANSITIONS[e.status]!.includes(to)) throw new Fail(409, 'EVENT_TRANSITION_INVALID', 'Этот переход недоступен для мероприятия в текущем статусе', { from: e.status, to });
    const cancelling = to === 'cancelled' || to === 'not_held';
    const reason = cancelling ? reasonOf(body) : (typeof body.reason === 'string' && body.reason.trim()) || null;
    if (to === 'confirmed') {
      const fields: string[] = [];
      if (!e.plannedStart) fields.push('plannedStart');
      if (!e.plannedEnd) fields.push('plannedEnd');
      if (!e.lines.some((l) => l.status === 'active')) fields.push('lines');
      if (typeOf(e).code === 'birthday_party' && !e.resources.some((r) => r.status === 'active')) fields.push('room');
      if (fields.length) throw new Fail(422, 'EVENT_NOT_READY', 'Мероприятие нельзя подтвердить: заполнено не всё', { fields });
      assertRooms(e);
    }
    const before = e.status;
    let needsDecision: Rec | null = null;
    if (cancelling) {
      for (const r of e.resources.filter((x) => x.status === 'active')) Object.assign(r, { status: 'released', releaseReason: 'cancelled' });
      e.cancel = { reason: reason!, by: s.id, at: iso(Date.now()) };
      const m = summary(e);
      needsDecision = { bookingIds: e.bookingIds, giftIds: gifts.filter((g) => g.basisEventId === e.id && g.status !== 'cancelled').map((g) => g.id), dueKop: m.dueKop, ...(seesMoney(s, e) ? { receivedKop: m.receivedKop } : {}) };
    }
    e.status = to;
    e.rowVersion++;
    tl(e, s, 'event.status_changed', { status: before }, { status: to }, reason);
    return { event: dto(d, e), needsDecision };
  }));

  // ---- №364 состав

  const lineOf = (s: Staffish, id: string) => {
    const e = events.find((x) => x.lines.some((l) => l.id === id));
    if (!e) throw notFound();
    guard(s, e.branchId, 'event.manage');
    return { e, l: e.lines.find((x) => x.id === id)! };
  };
  const qtyOk = (q: unknown) => typeof q === 'number' && q > 0 && q <= 99_999_999 && (Math.round(q * 100) === q * 100 || Number.isInteger(q * 100));
  const kopOk = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 100_000_000_000;
  function assertDiscount(q: number, price: number, discount: number, reason: unknown) {
    if (discount > 0 && !String(reason ?? '').trim()) throw new Fail(422, 'COMMENT_REQUIRED', 'Укажите причину скидки', { field: 'discountReason' });
    if (discount > round(q * price)) throw invalid('Скидка больше стоимости строки', 'discountKop');
  }
  const noPrice = () => new Fail(403, 'FORBIDDEN', 'Цену и скидку меняет Владелец или Директор', { action: 'event.price.manage' });

  app.post(`${P}/events/:id/lines`, command('line.add', 201, (s, p, body) => {
    const qtyBad = !qtyOk(body.quantity) || typeof body.name !== 'string' || !body.name.trim() || typeof body.unit !== 'string' || !body.unit.trim() || !kopOk(body.priceKop) || typeof body.kind !== 'string';
    if (qtyBad) throw zodFail('line');
    const discountKop = body.discountKop === undefined ? 0 : (body.discountKop as number);
    if (!kopOk(discountKop)) throw zodFail('discountKop');
    const e = eventOf(s, p.id!, 'event.manage');
    assertOpen(e);
    if (!canAt(s, 'event.price.manage', e.branchId)) {
      if (discountKop > 0) throw noPrice();
      const inPackage = packs.find((x) => x.id === e.packageId)?.lines.some((l) => l.name === body.name && l.priceKop === body.priceKop);
      if (body.priceKop !== 0 && !inPackage) throw noPrice();
    }
    assertDiscount(body.quantity as number, body.priceKop as number, discountKop, body.discountReason);
    const l = seedLine(e, { kind: String(body.kind), name: (body.name as string).trim(), quantity: body.quantity as number, unit: (body.unit as string).trim(), priceKop: body.priceKop as number, discountKop, discountReason: String(body.discountReason ?? '').trim() || null, planCostKop: (body.planCostKop as number | null | undefined) ?? null, supplier: (body.supplier as string | null | undefined) ?? null, comment: (body.comment as string | null | undefined) ?? null });
    tl(e, s, 'event.line_added', null, { name: l.name, agreedKop: summary(e).agreedKop });
    return lineView(s, e, l);
  }));

  app.patch(`${P}/event-lines/:id`, command('line.update', 200, (s, p, body) => {
    const { e, l } = lineOf(s, p.id!);
    assertOpen(e);
    assertVersion(l, body);
    if (l.status === 'removed') throw invalid('Строка удалена', 'status');
    if (body.quantity !== undefined && !qtyOk(body.quantity)) throw zodFail('quantity');
    const price = (body.priceKop as number | undefined) ?? l.priceKop;
    const discount = (body.discountKop as number | undefined) ?? l.discountKop;
    if ((price !== l.priceKop || discount !== l.discountKop) && !canAt(s, 'event.price.manage', e.branchId)) throw noPrice();
    const reason = body.discountReason !== undefined ? body.discountReason : l.discountReason;
    assertDiscount((body.quantity as number | undefined) ?? l.quantity, price, discount, reason);
    const before = { name: l.name, quantity: l.quantity, priceKop: l.priceKop, discountKop: l.discountKop };
    for (const f of ['kind', 'name', 'quantity', 'unit', 'planCostKop', 'supplier', 'comment'] as const) if (body[f] !== undefined) Object.assign(l, { [f]: body[f] });
    l.priceKop = price;
    l.discountKop = discount;
    l.discountReason = discount > 0 ? String(reason).trim() : null;
    l.rowVersion++;
    tl(e, s, 'event.line_updated', before, { name: l.name, quantity: l.quantity, priceKop: l.priceKop, discountKop: l.discountKop, agreedKop: summary(e).agreedKop });
    return lineView(s, e, l);
  }));

  app.post(`${P}/event-lines/:id/remove`, command('line.remove', 200, (s, p, body) => {
    const { e, l } = lineOf(s, p.id!);
    assertOpen(e);
    if (l.status === 'removed') return lineView(s, e, l);
    assertVersion(l, body);
    const reason = reasonOf(body);
    Object.assign(l, { status: 'removed', removedReason: reason, rowVersion: l.rowVersion + 1 });
    tl(e, s, 'event.line_removed', { status: 'active' }, { status: 'removed', name: l.name, agreedKop: summary(e).agreedKop }, reason);
    return lineView(s, e, l);
  }));

  app.post(`${P}/events/:id/apply-package`, command('package.apply', 200, (s, p, body) => {
    const e = eventOf(s, p.id!, 'event.manage');
    assertOpen(e);
    const pack = packs.find((x) => x.id === body.packageId);
    if (!pack || pack.status !== 'active' || pack.typeId !== e.typeId) throw invalid('Пакет не подходит к этому мероприятию', 'packageId');
    const items = pack.lines.map((l) => seedLine(e, { kind: String(l.kind), name: l.name, quantity: l.quantity as number, unit: String(l.unit), priceKop: l.priceKop, planCostKop: (l.planCostKop as number | null | undefined) ?? null, supplier: (l.supplier as string | null | undefined) ?? null, comment: (l.comment as string | null | undefined) ?? null }));
    e.packageId = pack.id;
    e.rowVersion++;
    tl(e, s, 'event.package_applied', null, { packageId: pack.id, lines: items.length, agreedKop: summary(e).agreedKop });
    return { items: items.map((l) => lineView(s, e, l)) };
  }));

  // ---- №365 ресурсы и перенос

  const allEventUnits = () => events.flatMap((e) => e.resources.filter((r) => r.status === 'active').map((r) => ({ ...r, branchId: e.branchId })));
  const eventBusy = (branchId: string, units: string[], s: number, e: number, self: string[] = []) =>
    allEventUnits().some((r) => !self.includes(r.id) && r.branchId === branchId && r.start < e && r.end > s && r.unitIds.some((u) => units.includes(u)));
  setExternalBusy((branchId, units, s, e) => eventBusy(branchId, units, s, e));

  function place(e: Ev, resourceId: string, s: number, en: number, self: string[] = []): string[] {
    const r = opsState().resources.find((x) => x.id === resourceId);
    if (!r || r.branchId !== e.branchId) throw notFound();
    if (!(s < en)) throw invalid('Конец раньше начала', 'end');
    const units = opsState().composition[resourceId] ?? [];
    const tz = branchOfEvent(d, e).timezone;
    const h = opsHoursOn(e.branchId, localDate(s, tz), units);
    if (!h || localDate(en - 1, tz) !== localDate(s, tz) || localHM(s, tz) < h.open || localHM(en, tz) > h.close) throw new Fail(409, 'OUTSIDE_SCHEDULE', 'В это время филиал не работает');
    assertParty(e, resourceId, s, en);
    if (opsState().blocks.some((b) => b.status === 'active' && b.branchId === e.branchId && b.unitIds.some((u) => units.includes(u)) && Date.parse(b.start) < en && Date.parse(b.end) > s)) throw new Fail(409, 'RESOURCE_BLOCKED', 'Ресурс заблокирован');
    if (bookingBusy(e.branchId, units, s, en) || eventBusy(e.branchId, units, s, en, self)) throw new Fail(409, 'SLOT_TAKEN', 'Это время уже занято');
    return [...units];
  }

  app.post(`${P}/events/:id/resources`, command('resource.reserve', 201, (s, p, body) => {
    if (typeof body.resourceId !== 'string' || !isMoment(body.start) || !isMoment(body.end)) throw zodFail('resource');
    const e = eventOf(s, p.id!, 'event.manage');
    assertOpen(e, 'ресурсы');
    const start = Date.parse(body.start);
    const end = Date.parse(body.end);
    const unitIds = place(e, body.resourceId, start, end);
    const r: EvResource = { id: randomUUID(), eventId: e.id, resourceId: body.resourceId, start, end, unitIds, status: 'active', releaseReason: null, reservedAt: Date.now(), reminded: false };
    e.resources.push(r);
    if (!e.plannedStart || !e.plannedEnd) {
      e.plannedStart = iso(start);
      e.plannedEnd = iso(end);
      e.rowVersion++;
    }
    tl(e, s, 'event.resource_reserved', null, { resourceId: r.resourceId, start: iso(start), end: iso(end) });
    return { eventResourceId: r.id };
  }));

  app.post(`${P}/events/:id/resources/:rid/release`, command('resource.release', 200, (s, p, body) => {
    const e = eventOf(s, p.id!, 'event.manage');
    assertOpen(e, 'ресурсы');
    const r = e.resources.find((x) => x.id === p.rid && x.status === 'active');
    if (!r) throw notFound();
    const reason = reasonOf(body);
    Object.assign(r, { status: 'released', releaseReason: reason });
    tl(e, s, 'event.resource_released', { resourceId: r.resourceId, start: iso(r.start), end: iso(r.end) }, null, reason);
    return { released: true };
  }));

  app.post(`${P}/events/:id/move`, command('move', 200, (s, p, body) => {
    if (!Number.isInteger(body.rowVersion) || !isMoment(body.plannedStart) || !isMoment(body.plannedEnd)) throw zodFail('move');
    const items = (body.resources ?? []) as Array<{ eventResourceId: string; resourceId: string; start: string; end: string }>;
    const e = eventOf(s, p.id!, 'event.manage');
    assertVersion(e, body);
    assertOpen(e, 'ресурсы');
    const reason = reasonOf(body);
    const ps = Date.parse(body.plannedStart);
    const pe = Date.parse(body.plannedEnd);
    if (!(ps < pe)) throw invalid('Конец раньше начала', 'end');
    const bad = (why: string, ids: string[]) => new Fail(422, 'EVENT_MOVE_RESOURCES_INVALID', 'Перенос должен двигать все занятые ресурсы и держать их внутри новых дат', { reason: why, eventResourceIds: ids });
    const listed = items.map((x) => x.eventResourceId);
    const repeated = listed.filter((id, i) => listed.indexOf(id) !== i);
    if (repeated.length) throw bad('duplicate', [...new Set(repeated)]);
    const active = e.resources.filter((r) => r.status === 'active');
    const missing = active.map((r) => r.id).filter((id) => !listed.includes(id));
    if (missing.length) throw bad('missing', missing);
    const outside = items.filter((x) => Date.parse(x.start) < ps || Date.parse(x.end) > pe);
    if (outside.length) throw bad('outside_planned', outside.map((x) => x.eventResourceId));
    // конфликт откатывает всё: сначала проверяем все строки, потом пишем (16 §9)
    const self = active.map((r) => r.id);
    const planned = items.map((x) => {
      if (!active.some((r) => r.id === x.eventResourceId)) throw notFound();
      return { x, unitIds: place(e, x.resourceId, Date.parse(x.start), Date.parse(x.end), self) };
    });
    for (const { x, unitIds } of planned) Object.assign(active.find((r) => r.id === x.eventResourceId)!, { resourceId: x.resourceId, start: Date.parse(x.start), end: Date.parse(x.end), unitIds });
    const before = { start: e.plannedStart, end: e.plannedEnd };
    e.plannedStart = iso(ps);
    e.plannedEnd = iso(pe);
    e.rowVersion++;
    tl(e, s, 'event.rescheduled', before, { start: e.plannedStart, end: e.plannedEnd }, reason);
    return dto(d, e);
  }));

  // ---- №366 связанные брони

  app.post(`${P}/events/:id/bookings`, command('booking.link', 200, (s, p, body) => {
    if (typeof body.bookingId !== 'string') throw zodFail('bookingId');
    const e = eventOf(s, p.id!, 'event.manage');
    const f = bookingFacts(body.bookingId);
    if (!f || f.branchId !== e.branchId) throw notFound();
    if (e.bookingIds.includes(body.bookingId)) return { eventId: e.id, bookingId: body.bookingId };
    if (events.some((x) => x.bookingIds.includes(body.bookingId as string))) throw invalid('Бронь уже связана с другим мероприятием', 'bookingId');
    e.bookingIds.push(body.bookingId);
    tl(e, s, 'event.booking_linked', null, { bookingId: body.bookingId });
    return { eventId: e.id, bookingId: body.bookingId };
  }));
  app.post(`${P}/events/:id/bookings/:bid/unlink`, command('booking.unlink', 200, (s, p) => {
    const e = eventOf(s, p.id!, 'event.manage');
    if (!e.bookingIds.includes(p.bid!)) throw notFound();
    e.bookingIds = e.bookingIds.filter((x) => x !== p.bid);
    tl(e, s, 'event.booking_unlinked', { bookingId: p.bid }, null);
    return { eventId: e.id, bookingId: p.bid };
  }));

  // ---- №367 чек-лист

  app.get(`${P}/events/:id/checklist`, read((s, req) => ({ items: checklistDto(eventOf(s, idOf(req), 'event.manage')) })));
  app.post(`${P}/events/:id/checklist`, command('checklist.add', 201, (s, p, body) => {
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title || title.length > 200) throw zodFail('title');
    const e = eventOf(s, p.id!, 'event.manage');
    const item: Check = { id: randomUUID(), code: null, title, status: 'todo', responsibleStaffId: (body.responsibleStaffId as string | null | undefined) ?? null, comment: (body.comment as string | null | undefined) ?? null, updatedBy: s.id, updatedAt: iso(Date.now()) };
    e.checklist.push(item);
    tl(e, s, 'event.checklist_changed', null, { itemId: item.id, title, status: item.status });
    return item;
  }));
  app.patch(`${P}/events/:id/checklist`, command('checklist.update', 200, (s, p, body) => {
    if (typeof body.itemId !== 'string') throw zodFail('itemId');
    const e = events.find((x) => x.id === p.id);
    const item = e?.checklist.find((c) => c.id === body.itemId);
    if (!e || !item) throw notFound();
    guard(s, e.branchId, 'event.manage');
    if (body.status !== undefined && !['todo', 'done', 'not_needed'].includes(String(body.status))) throw zodFail('status');
    const before = { status: item.status };
    if (body.status !== undefined) item.status = String(body.status);
    if (body.responsibleStaffId !== undefined) item.responsibleStaffId = body.responsibleStaffId as string | null;
    if (body.comment !== undefined) item.comment = body.comment as string | null;
    item.updatedBy = s.id;
    item.updatedAt = iso(Date.now());
    tl(e, s, 'event.checklist_changed', before, { itemId: item.id, status: item.status });
    return item;
  }));

  // ---- №368, №369 деньги: одна строка журнала кассы (mock-finance)

  const METHODS = ['cash', 'card', 'transfer'];
  function assertPlace(body: Rec) {
    if (!METHODS.includes(String(body.method))) throw zodFail('method');
    if (typeof body.amountKop !== 'number') throw zodFail('amountKop');
    if (body.place !== undefined && body.place !== (body.method === 'cash' ? 'cash' : 'noncash')) throw invalid('Место денег не соответствует способу оплаты', 'place');
  }
  const assertLine = (e: Ev, lineId: unknown) => {
    if (lineId != null && !e.lines.some((l) => l.id === lineId)) throw invalid('Строка состава не из этого мероприятия', 'lineId');
  };

  app.get(`${P}/events/:id/money`, read((s, req) => {
    const e = eventOf(s, idOf(req), 'event.money.view');
    return { summary: summary(e), operations: e.links.map(opOfLink).filter(Boolean) };
  }));
  app.post(`${P}/events/:id/income`, command('income', 201, (s, p, body) => {
    assertPlace(body);
    if (!isMoment(body.occurredAt)) throw zodFail('occurredAt');
    const e = eventOf(s, p.id!, 'event.money.record');
    const op = financeCommands().income(s, e.branchId, { method: body.method, amountKop: body.amountKop, source: 'event', occurredAt: body.occurredAt, comment: body.comment ?? null, receiptIssued: body.receiptIssued ?? null, ref: { type: 'event', id: e.id } });
    e.links.push({ operationId: op.id, role: 'income', inCost: false, lineId: null, linkedAt: iso(Date.now()) });
    return op;
  }));
  app.post(`${P}/events/:id/refund`, command('refund', 201, (s, p, body) => {
    assertPlace(body);
    if (typeof body.incomeOperationId !== 'string') throw zodFail('incomeOperationId');
    const e = eventOf(s, p.id!, 'event.money.record');
    const income = getFinanceOp(body.incomeOperationId);
    if (!income || income.kind !== 'income' || income.ref?.type !== 'event' || income.ref.id !== e.id) throw notFound();
    if (!d.can(s, 'finance.refund')) throw forbidden('finance.refund');
    const reason = reasonOf(body);
    if (!Number.isSafeInteger(body.amountKop) || (body.amountKop as number) <= 0) throw new Fail(422, 'INVALID_AMOUNT', 'Сумма – целое число копеек больше нуля');
    if (income.reversedBy) throw new Fail(409, 'OPERATION_REVERSED', 'Поступление уже сторнировано', { operationId: income.id });
    const refunded = e.links.filter((l) => l.role === 'refund').map(opOfLink).filter((x) => x && x.operation.ref?.id === income.id).reduce((a, x) => a + x!.operation.amountKop, 0);
    if (refunded + (body.amountKop as number) > income.amountKop) throw new Fail(409, 'EVENT_REFUND_EXCEEDS_INCOME', 'Сумма возврата больше поступления', { availableKop: income.amountKop - refunded });
    const op = recordMoney({ branchId: e.branchId, timezone: branchOfEvent(d, e).timezone, kind: 'refund', method: body.method as 'cash', amountKop: body.amountKop as number, source: null, ref: { type: 'operation', id: income.id }, comment: reason, authorId: s.id });
    e.links.push({ operationId: op.id, role: 'refund', inCost: false, lineId: null, linkedAt: iso(Date.now()) });
    return getFinanceOp(op.id);
  }));
  app.post(`${P}/events/:id/expense`, command('expense', 201, (s, p, body) => {
    assertPlace(body);
    if (typeof body.categoryId !== 'string' || !isMoment(body.occurredAt)) throw zodFail('expense');
    const e = eventOf(s, p.id!, 'event.money.record');
    assertLine(e, body.lineId);
    const text = String(body.comment ?? '').trim();
    const comment = body.supplier && text ? `${text} (поставщик: ${body.supplier as string})` : text;
    const op = financeCommands().expense(s, e.branchId, { method: body.method, amountKop: body.amountKop, categoryId: body.categoryId, subcategoryId: body.subcategoryId ?? null, occurredAt: body.occurredAt, comment, ref: { type: 'event', id: e.id } });
    e.links.push({ operationId: op.id, role: 'expense', inCost: (body.inCost as boolean | undefined) ?? true, lineId: (body.lineId as string | null | undefined) ?? null, linkedAt: iso(Date.now()) });
    return op;
  }));
  app.post(`${P}/events/:id/expense/link`, command('expense.link', 201, (s, p, body) => {
    if (typeof body.operationId !== 'string') throw zodFail('operationId');
    const e = eventOf(s, p.id!, 'event.money.record');
    assertLine(e, body.lineId);
    const op = getFinanceOp(body.operationId);
    if (!op || op.branchId !== e.branchId) throw notFound();
    if (e.links.some((l) => l.operationId === op.id)) throw new Fail(409, 'OPERATION_ALREADY_LINKED', 'Этот расход уже учтён в мероприятии', { ref: { type: 'event', id: e.id }, role: 'expense' });
    // одна операция – не больше одной живой связи (K17 §14)
    if (events.some((x) => x.links.some((l) => l.operationId === op.id)) || op.ref) throw new Fail(409, 'OPERATION_ALREADY_LINKED', 'Операция уже связана', { ref: null, role: 'expense' });
    if (op.kind !== 'expense' || op.reversedBy) throw new Fail(422, 'OPERATION_LINK_INVALID', 'Эту операцию нельзя привязать');
    e.links.push({ operationId: op.id, role: 'expense', inCost: (body.inCost as boolean | undefined) ?? false, lineId: (body.lineId as string | null | undefined) ?? null, linkedAt: iso(Date.now()) });
    tl(e, s, 'event.money_linked', null, { operationId: op.id, amountKop: op.amountKop });
    return { linked: true };
  }));

  // ---- №370 справочники

  app.get(`${P}/event-packages`, read((s, req) => {
    anyZone(s);
    const q = req.query as { typeId?: string; includeArchived?: string };
    return { items: packs.filter((x) => (!q.typeId || x.typeId === q.typeId) && (q.includeArchived === 'true' || x.status === 'active')).sort((a, b) => a.name.localeCompare(b.name)).map((x) => packView(s, x)) };
  }));
  const manage = (s: Staffish, action: string) => {
    if (!d.can(s, action)) throw forbidden(action);
  };
  app.post(`${P}/event-packages`, command('package.create', 201, (s, _p, body) => {
    manage(s, 'event.package.manage');
    if (typeof body.name !== 'string' || !body.name.trim() || !Array.isArray(body.lines)) throw zodFail('name');
    if (!types.some((t) => t.id === body.typeId && t.status === 'active')) throw invalid('Тип мероприятия не найден', 'typeId');
    const pack: Pack = { id: randomUUID(), typeId: body.typeId as string, name: body.name.trim(), lines: body.lines as Pack['lines'], approxPriceKop: (body.approxPriceKop as number | null | undefined) ?? null, status: 'active', rowVersion: 1 };
    packs.push(pack);
    return pack;
  }));
  app.patch(`${P}/event-packages/:id`, command('package.update', 200, (s, p, body) => {
    manage(s, 'event.package.manage');
    const x = packs.find((y) => y.id === p.id);
    if (!x) throw notFound();
    assertVersion(x, body);
    for (const f of ['name', 'lines', 'approxPriceKop', 'status'] as const) if (body[f] !== undefined) Object.assign(x, { [f]: body[f] });
    x.rowVersion++;
    return x;
  }));
  app.get(`${P}/event-types`, read((s) => {
    anyZone(s);
    return { items: [...types].sort((a, b) => a.name.localeCompare(b.name)) };
  }));
  app.post(`${P}/event-types`, command('type.create', 201, (s, _p, body) => {
    manage(s, 'event.type.manage');
    if (typeof body.code !== 'string' || !/^[a-z][a-z0-9_]*$/.test(body.code) || typeof body.name !== 'string' || !body.name.trim()) throw zodFail('code');
    if (types.some((t) => t.code === body.code)) throw invalid('Такой код уже есть', 'code');
    const t: EvType = { id: randomUUID(), code: body.code, name: body.name.trim(), status: 'active', rowVersion: 1 };
    types.push(t);
    return t;
  }));
  app.patch(`${P}/event-types/:id`, command('type.update', 200, (s, p, body) => {
    manage(s, 'event.type.manage');
    const t = types.find((y) => y.id === p.id);
    if (!t) throw notFound();
    assertVersion(t, body);
    if (body.status === 'archived' && ['birthday_party', 'birthday'].includes(t.code)) throw invalid('Этот тип нужен для праздника и подарка', 'status');
    if (typeof body.name === 'string') t.name = body.name.trim();
    if (body.status === 'active' || body.status === 'archived') t.status = body.status;
    t.rowVersion++;
    return t;
  }));

  // ---- №376–378 подарки

  const giftDto = (g: GiftRec) => ({ ...g, timezone: d.branches().find((b) => b.id === g.issueBranchId)!.timezone });
  app.get(`${P}/gifts`, read((s, req) => {
    const q = req.query as { clientId?: string; status?: string };
    return { items: gifts.filter((g) => canAt(s, 'event.view', g.issueBranchId) && (!q.clientId || g.clientId === q.clientId) && (!q.status || g.status === q.status)).sort((a, b) => (a.issuedOn < b.issuedOn ? 1 : -1)).map(giftDto) };
  }));
  app.post(`${P}/gifts`, command('issue', 201, (s, _p, body) => {
    if (typeof body.clientId !== 'string') throw zodFail('clientId');
    let branchId: string;
    let reason: string | null = null;
    if (body.basisEventId) {
      const e = events.find((x) => x.id === body.basisEventId);
      if (!e || !canAt(s, 'event.view', e.branchId)) throw notFound();
      if (!canAt(s, 'gift.issue', e.branchId)) throw forbidden('gift.issue');
      const basis = (r: string) => new Fail(422, 'GIFT_BASIS_INVALID', 'Основание – день рождения этого клиента в клубе', { reason: r });
      if (!['birthday_party', 'birthday'].includes(typeOf(e).code)) throw basis('type');
      if (e.birthdayClientId !== body.clientId) throw basis('client');
      if (!['in_progress', 'completed'].includes(e.status)) throw basis('status');
      branchId = e.branchId;
    } else {
      manage(s, 'gift.issue.manual');
      reason = reasonOf(body);
      if (!body.branchId) throw invalid('Укажите филиал выдачи', 'branchId');
      branchId = String(body.branchId);
    }
    const branch = d.branches().find((b) => b.id === branchId);
    if (!branch) throw notFound();
    const client = d.clients().find((c) => c.id === body.clientId);
    if (!client || client.status === 'anonymized') throw notFound();
    const issuedOn = localDate(Date.now(), branch.timezone);
    if (gifts.some((g) => g.clientId === body.clientId && g.status !== 'cancelled' && g.issuedOn > addDays(issuedOn, -365))) throw new Fail(409, 'GIFT_ALREADY_ISSUED', 'Подарок этому клиенту уже выдан в этом году');
    void reason;
    const g: GiftRec = {
      id: randomUUID(), number: `GF-${String(++giftSeq).padStart(6, '0')}`, clientId: body.clientId, basisEventId: (body.basisEventId as string | null | undefined) ?? null, issuedOn, validUntil: addDays(issuedOn, 60), issueBranchId: branch.id,
      terms: { devices: 2, device: 'Meta Quest 3S', minutesEach: 30, roomMinutes: 40, weekdays: [1, 2, 3, 4, 5], excludesHolidays: true, notIncluded: ['PS4', 'PS VR', 'food'] }, status: 'issued', bookingId: null, cancelReason: null, rowVersion: 1,
    };
    gifts.push(g);
    return giftDto(g);
  }));
  app.post(`${P}/gifts/:id/cancel`, command('cancel', 200, (s, p, body) => {
    manage(s, 'gift.cancel');
    const g = gifts.find((x) => x.id === p.id);
    if (!g) throw notFound();
    const reason = reasonOf(body);
    if (g.status !== 'issued') throw new Fail(409, 'GIFT_NOT_ACTIVE', 'Отменить можно только подарок без записи', { status: g.status });
    Object.assign(g, { status: 'cancelled', cancelReason: reason, rowVersion: g.rowVersion + 1 });
    return giftDto(g);
  }));

  const isHoliday = (branch: BranchLite, date: string) => holidays.some((h) => h.status === 'active' && h.date === date && (h.scope === 'network' || h.cityId === branch.cityId));
  /** assertGiftDay: срок, будни, праздник (K20 §8.2). */
  function dayClosed(g: GiftRec, branch: BranchLite, date: string): [number, string, string] | null {
    if (date > g.validUntil) return [409, 'GIFT_EXPIRED', 'Срок подарка истёк'];
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (dow === 0 || dow === 6) return [422, 'GIFT_WEEKDAY_ONLY', 'Подарок – только с понедельника по пятницу'];
    if (isHoliday(branch, date)) return [422, 'GIFT_HOLIDAY', 'В праздничный день подарок не действует'];
    return null;
  }
  const GIFT_UNITS = () => [...(opsState().composition['res-vr1'] ?? []), ...(opsState().composition['res-vr2'] ?? [])];
  app.get(`${P}/gifts/:id/slots`, read((s, req) => {
    const q = req.query as { branchId?: string; date?: string };
    if (!q.branchId || !q.date) throw zodFail('branchId');
    const g = gifts.find((x) => x.id === idOf(req));
    if (!g || !canAt(s, 'event.view', q.branchId)) throw notFound();
    const branch = d.branches().find((b) => b.id === q.branchId);
    if (!branch) throw notFound();
    const closedBy = dayClosed(g, branch, q.date);
    if (closedBy) return { date: q.date, closedReason: closedBy[1], slots: [] };
    const today = localDate(Date.now(), branch.timezone);
    if (q.date < today || q.date >= addDays(today, 30)) return { date: q.date, closedReason: 'OUTSIDE_BOOKING_WINDOW', slots: [] };
    if (!opsState().resources.some((r) => r.branchId === branch.id && r.id === 'res-vr1')) return { date: q.date, closedReason: 'RESOURCE_UNAVAILABLE', slots: [] };
    const h = opsHoursOn(branch.id, q.date, GIFT_UNITS());
    if (!h) return { date: q.date, closedReason: null, slots: [] };
    const slots: Array<{ start: string; end: string }> = [];
    const close = zoned(q.date, h.close === '24:00' ? '23:59' : h.close, branch.timezone);
    for (let t = zoned(q.date, h.open, branch.timezone); t + 40 * 60_000 <= close; t += 15 * 60_000) {
      const e = t + 40 * 60_000;
      if (t <= Date.now() || bookingBusy(branch.id, GIFT_UNITS(), t, e) || eventBusy(branch.id, GIFT_UNITS(), t, e)) continue;
      slots.push({ start: iso(t), end: iso(e) });
    }
    return { date: q.date, closedReason: null, slots };
  }));
  app.post(`${P}/gifts/:id/book`, command('book', 201, (s, p, body) => {
    if (typeof body.branchId !== 'string' || !isMoment(body.start)) throw zodFail('start');
    const g = gifts.find((x) => x.id === p.id);
    const branch = d.branches().find((b) => b.id === body.branchId);
    if (!g || !branch || !canAt(s, 'event.view', branch.id)) throw notFound();
    if (!canAt(s, 'gift.book', branch.id)) throw forbidden('gift.book');
    if (body.clientId && body.clientId !== g.clientId) throw new Fail(422, 'GIFT_CLIENT_MISMATCH', 'Записать можно только самого именинника');
    if (g.status === 'reserved') throw new Fail(409, 'GIFT_ALREADY_RESERVED', 'По подарку уже есть запись');
    if (g.status !== 'issued') throw new Fail(409, 'GIFT_NOT_ACTIVE', 'Подарок уже не активен');
    const start = Date.parse(body.start);
    const closedBy = dayClosed(g, branch, localDate(start, branch.timezone));
    if (closedBy) throw new Fail(closedBy[0], closedBy[1], closedBy[2]);
    const end = start + 40 * 60_000;
    if (bookingBusy(branch.id, GIFT_UNITS(), start, end) || eventBusy(branch.id, GIFT_UNITS(), start, end)) throw new Fail(409, 'SLOT_TAKEN', 'Это время уже занято');
    const b = addGiftBooking({ branchId: branch.id, clientId: g.clientId, start, end, comment: (body.comment as string | undefined) ?? null, unitIds: GIFT_UNITS() });
    Object.assign(g, { status: 'reserved', bookingId: b.id, rowVersion: g.rowVersion + 1 });
    return b;
  }));

  // ---- №379 праздничный календарь

  app.get(`${P}/holidays`, read((s, req) => {
    anyZone(s);
    const q = req.query as { from?: string; to?: string; cityId?: string; includeCancelled?: string };
    return { items: holidays.filter((h) => (!q.from || h.date >= q.from) && (!q.to || h.date <= q.to) && (!q.cityId || h.scope === 'network' || h.cityId === q.cityId) && (q.includeCancelled === 'true' || h.status === 'active')).sort((a, b) => (a.date < b.date ? -1 : 1)) };
  }));
  app.post(`${P}/holidays`, command('holiday.set', 201, (s, _p, body) => {
    manage(s, 'holiday.manage');
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!['network', 'city'].includes(String(body.scope)) || !name || !/^\d{4}-\d{2}-\d{2}$/.test(String(body.date))) throw zodFail('date');
    const scope = body.scope as 'network' | 'city';
    const cityId = scope === 'city' ? ((body.cityId as string | null | undefined) ?? null) : null;
    if (scope === 'city' && !cityId) throw invalid('Укажите город', 'cityId');
    const same = holidays.find((h) => h.status === 'active' && h.scope === scope && h.cityId === cityId && h.date === body.date);
    if (same) return same;
    const h: HolidayRec = { id: randomUUID(), scope, cityId, date: String(body.date), name, status: 'active' };
    holidays.push(h);
    return h;
  }));
  app.post(`${P}/holidays/:id/cancel`, command('holiday.cancel', 200, (s, p, body) => {
    manage(s, 'holiday.manage');
    const reason = reasonOf(body);
    void reason;
    const h = holidays.find((x) => x.id === p.id && x.status === 'active');
    if (!h) throw notFound();
    h.status = 'cancelled';
    return h;
  }));

  // ---- №337, №349 справочники оборудования (если их не поставил мок оборудования)

  const orphan = (method: 'GET' | 'POST' | 'PATCH', url: string) => !app.hasRoute({ method, url });
  const view = (s: Staffish) => {
    if (!d.can(s, 'equipment.view')) throw forbidden('equipment.view');
  };
  if (orphan('GET', `${P}/equipment-categories`)) {
    app.get(`${P}/equipment-categories`, read((s) => {
      view(s);
      return { items: [...categories].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)) };
    }));
    app.post(`${P}/equipment-categories`, command('category.create', 201, (s, _p, body) => {
      manage(s, 'equipment.category.manage');
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name) throw zodFail('name');
      if (categories.some((c) => c.name === name)) throw invalid('Категория с таким названием уже есть', 'name');
      const c: Category = { id: randomUUID(), name, sortOrder: (body.sortOrder as number | undefined) ?? 0, status: 'active' };
      categories.push(c);
      return c;
    }));
    app.patch(`${P}/equipment-categories/:id`, command('category.update', 200, (s, p, body) => {
      manage(s, 'equipment.category.manage');
      const c = categories.find((x) => x.id === p.id);
      if (!c) throw notFound();
      if (typeof body.name === 'string' && body.name.trim() !== c.name && categories.some((x) => x.name === body.name && x.id !== c.id)) throw invalid('Категория с таким названием уже есть', 'name');
      Object.assign(c, typeof body.name === 'string' ? { name: body.name.trim() } : {}, body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}, body.status ? { status: body.status } : {});
      return c;
    }));
  }
  if (orphan('GET', `${P}/repair-executors`)) {
    app.get(`${P}/repair-executors`, read((s, req) => {
      view(s);
      const q = req.query as { includeArchived?: string };
      return { items: executors.filter((x) => q.includeArchived === 'true' || x.status === 'active').sort((a, b) => a.name.localeCompare(b.name)) };
    }));
    app.post(`${P}/repair-executors`, command('executor.create', 201, (s, _p, body) => {
      manage(s, 'repair.executor.manage');
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name || !['staff', 'contractor', 'service_center', 'manufacturer'].includes(String(body.kind))) throw zodFail('name');
      const x: Executor = { id: randomUUID(), kind: String(body.kind), name, staffId: null, contactPerson: (body.contactPerson as string | null | undefined) ?? null, phone: (body.phone as string | null | undefined) ?? null, email: (body.email as string | null | undefined) ?? null, address: null, inn: null, comment: (body.comment as string | null | undefined) ?? null, status: 'active', rowVersion: 1 };
      executors.push(x);
      return x;
    }));
    app.patch(`${P}/repair-executors/:id`, command('executor.update', 200, (s, p, body) => {
      manage(s, 'repair.executor.manage');
      const x = executors.find((y) => y.id === p.id);
      if (!x) throw notFound();
      assertVersion(x, body);
      for (const f of ['kind', 'name', 'contactPerson', 'phone', 'email', 'comment', 'status'] as const) if (body[f] !== undefined) Object.assign(x, { [f]: body[f] });
      x.rowVersion++;
      return x;
    }));
  }
}

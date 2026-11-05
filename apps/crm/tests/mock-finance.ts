// Мок кассы CRM строго по apps/api/src/modules/finance/routes.crm.ts (K17 №37, 38, 40, 41, 44–47) и cashbox.ts,
// corrections.ts, categories.ts: журнал (только сутки и без остатков без finance.view), предпросмотр (только с
// finance.view – иначе 403), доход и расход с правилами normalize, сторно и исправление (USE_PAYMENT_REFUND,
// USE_CERTIFICATE_CANCEL, ALREADY_REVERSED), дерево категорий (два уровня, архив), закрытие месяца (PERIOD_CLOSED).
// Idempotency-Key обязателен у команд: повтор с тем же телом – тот же ответ, с другим – IDEMPOTENCY_KEY_REUSED.
// Отрицательная касса запрещена (K7 по умолчанию). CASH_INSUFFICIENT без finance.view – без чисел (решение 02.11 K17).
// Подключается из mock-api.ts (registerFinance), resetFinance() – POST /__test/reset.
// K17 §7: смена включена – операции наличных (место cash, перевод между местами) только в открытой смене и с её
// shift_id, иначе CASH_SHIFT_REQUIRED (ворота ставит mock-shifts.ts через setShiftGate). Системные категории 0210
// «Недостача кассы» / «Излишек кассы» – для решения «принять» по смене (код наружу не отдаётся, как COLUMNS в categories.ts).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';

type Rec = Record<string, unknown>;
interface Staffish { id: string; role: string }
interface Zone { network: boolean; cityIds: string[]; branchIds: string[] }
interface BranchLite { id: string; cityId: string; name: string; timezone: string }

export interface FinanceMockDeps {
  current: (req: FastifyRequest) => Staffish;
  zone: (s: Staffish) => Zone;
  can: (s: Staffish, action: string) => boolean;
  branches: () => BranchLite[];
}

type Place = 'cash' | 'noncash';
type Kind = 'opening_balance' | 'income' | 'expense' | 'withdrawal' | 'place_transfer' | 'refund' | 'correction' | 'reversal';
type Method = 'cash' | 'card' | 'transfer';
interface Op {
  id: string; number: number; branchId: string; kind: Kind; place: Place; method: Method | null; direction: 'in' | 'out'; amountKop: number;
  source: string | null; categoryId: string | null; subcategoryId: string | null; comment: string | null; ref: { type: string; id: string } | null;
  receiptIssued: boolean | null; occurredAt: string; recordedAt: string; authorId: string | null; balanceAfterKop: number;
  reversedBy: string | null; reversalOf: string | null; shiftId: string | null; postingId: string;
}
interface Category { id: string; kind: 'income' | 'expense'; parentId: string | null; name: string; sortOrder: number; status: 'active' | 'archived'; rowVersion: number }

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
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => new Fail(404, 'NOT_FOUND', 'Не найдено');
const invalid = (message: string, field: string) => new Fail(400, 'VALIDATION_FAILED', message, { field });
const zodFail = (path: string) => new Fail(400, 'VALIDATION_FAILED', 'Неверные данные запроса', { issues: [{ path, message: 'Invalid input' }] });

// ---- время по зоне филиала (core/time.ts)

const todayIn = (tz: string, at: number) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(at));
function midnight(date: string, tz: string): number {
  const guess = Date.parse(`${date}T00:00:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(guess));
  const p = (t: string) => parts.find((x) => x.type === t)!.value;
  return guess - (Date.parse(`${p('year')}-${p('month')}-${p('day')}T${p('hour')}:${p('minute')}:00Z`) - guess);
}
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const monthOf = (at: number, tz: string) => `${todayIn(tz, at).slice(0, 7)}-01`;
function prevMonth(date: string): string {
  const [y, m] = date.split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

// ---- состояние

let ops: Op[] = [];
let categories: Category[] = [];
let balances = new Map<string, number>(); // `${branchId}:${place}` → копейки
let periods = new Map<string, { closedAt: string }>(); // `${branchId}:${YYYY-MM-01}`
let seq = 1000;
let seeding = false;
let systemCategories: Record<'cash_shortage' | 'cash_surplus', string> = { cash_shortage: '', cash_surplus: '' };
/** Ворота смены: undefined – смена выключена; null – включена, открытой нет; строка – id открытой смены. */
let shiftGate: (branchId: string) => string | null | undefined = () => undefined;
export function setShiftGate(gate: (branchId: string) => string | null | undefined): void {
  shiftGate = gate;
}
const replays = new Map<string, { hash: string; status: number; body: unknown }>();

const SEED_CATEGORIES: Array<[string, string[]]> = [
  ['Коммунальные', ['Электричество', 'Отопление', 'Вода', 'Вывоз мусора', 'Откачка ямы', 'Интернет']],
  ['Аренда и содержание', ['Аренда', 'Эксплуатационные платежи', 'Уборка']],
  ['Закупки и материалы', ['Продукты', 'Напитки', 'Канцелярия', 'Хозяйственные товары']],
  ['Персонал', ['Зарплата', 'Выплаты за смены', 'Прочие согласованные выплаты']],
  ['Ремонт и обслуживание', ['Оборудование', 'Помещение', 'Мебель', 'Техника']],
  ['Маркетинг', ['Реклама', 'Печать', 'Оформление']],
  ['Подрядчики и услуги', ['Аниматор', 'Кейтеринг', 'Доставка']],
  ['Прочее', []],
];

const bal = (branchId: string, place: Place) => balances.get(`${branchId}:${place}`) ?? 0;
const catByName = (name: string, parentId: string | null = null) => categories.find((c) => c.name === name && c.parentId === parentId)!;

function insert(v: Omit<Op, 'id' | 'number' | 'recordedAt' | 'balanceAfterKop' | 'reversedBy' | 'shiftId' | 'postingId'>, transferTo?: Place, shiftId?: string): Op {
  let shift: string | null = shiftId ?? null;
  if (shiftId === undefined && !seeding && (v.place === 'cash' || v.kind === 'place_transfer')) {
    const g = shiftGate(v.branchId);
    if (g === null) throw new Fail(409, 'CASH_SHIFT_REQUIRED', 'Откройте кассовую смену', { branchId: v.branchId });
    shift = g ?? null;
  }
  const k = `${v.branchId}:${v.place}`;
  balances.set(k, bal(v.branchId, v.place) + (v.direction === 'in' ? v.amountKop : -v.amountKop));
  if (transferTo) balances.set(`${v.branchId}:${transferTo}`, bal(v.branchId, transferTo) + (v.direction === 'in' ? -v.amountKop : v.amountKop));
  const op: Op = { ...v, id: randomUUID(), number: ++seq, recordedAt: new Date().toISOString(), balanceAfterKop: bal(v.branchId, v.place), reversedBy: null, shiftId: shift, postingId: randomUUID() };
  ops.push(op);
  return op;
}

/** postMoneyOperation для чужих модулей (K16: продажа сертификата – доход certificate_sale, отмена с возвратом –
 *  refund): закрытый месяц и отрицательная касса – те же отказы, что у команд кассы. */
export function recordMoney(v: {
  branchId: string; timezone: string; kind: 'income' | 'refund'; method: Method; amountKop: number; source: string | null;
  ref: { type: string; id: string }; comment: string | null; authorId: string; receiptIssued?: boolean | null;
}): { id: string } {
  const place: Place = v.method === 'cash' ? 'cash' : 'noncash';
  const now = Date.now();
  const month = monthOf(now, v.timezone);
  if (periods.has(`${v.branchId}:${month}`)) throw new Fail(409, 'PERIOD_CLOSED', 'Месяц закрыт: исправление – операцией текущей датой', { month });
  if (v.kind === 'refund' && bal(v.branchId, place) - v.amountKop < 0) {
    throw new Fail(409, 'CASH_INSUFFICIENT', 'Недостаточно денег в кассе: внесите поступление или проверьте начальный остаток', { place, currentKop: bal(v.branchId, place), afterKop: bal(v.branchId, place) - v.amountKop });
  }
  const op = insert({
    branchId: v.branchId, kind: v.kind, place, method: v.method, direction: v.kind === 'income' ? 'in' : 'out', amountKop: v.amountKop, source: v.source,
    categoryId: null, subcategoryId: null, comment: v.comment, ref: v.ref, receiptIssued: v.receiptIssued ?? null, occurredAt: new Date(now).toISOString(), authorId: v.authorId, reversalOf: null,
  });
  return { id: op.id };
}

/** Мок мероприятий (K20 §6): команды кассы с теми же проверками и строка журнала по id. */
export const getFinanceOp = (id: string): Op | undefined => ops.find((o) => o.id === id);
let commands: { income: (s: Staffish, branchId: string, body: Rec) => Op; expense: (s: Staffish, branchId: string, body: Rec) => Op } | null = null;
export const financeCommands = () => commands!;

/** Для мока смены (shift.ts): остаток места «наличные» – expected при открытии и закрытии. */
export const cashBalance = (branchId: string) => bal(branchId, 'cash');

/** resolveShift: correct – correction на diff; accept – расход «Недостача кассы» / доход «Излишек кассы» (источник
 *  other). Операция в этой смене; закрытый месяц и минус кассы – те же отказы. */
export function recordShiftOperation(v: { branchId: string; timezone: string; action: 'correct' | 'accept'; diffKop: number; comment: string; authorId: string; shiftId: string }): Op {
  const month = monthOf(Date.now(), v.timezone);
  if (periods.has(`${v.branchId}:${month}`)) throw new Fail(409, 'PERIOD_CLOSED', 'Месяц закрыт: исправление – операцией текущей датой', { month });
  if (bal(v.branchId, 'cash') + v.diffKop < 0) {
    throw new Fail(409, 'CASH_INSUFFICIENT', 'Недостаточно денег в кассе: внесите поступление или проверьте начальный остаток', { place: 'cash', currentKop: bal(v.branchId, 'cash'), afterKop: bal(v.branchId, 'cash') + v.diffKop });
  }
  const accept = v.action === 'accept';
  const kind: Kind = accept ? (v.diffKop < 0 ? 'expense' : 'income') : 'correction';
  return insert({
    branchId: v.branchId, kind, place: 'cash', method: 'cash', direction: v.diffKop > 0 ? 'in' : 'out', amountKop: Math.abs(v.diffKop), source: kind === 'income' ? 'other' : null,
    categoryId: accept ? systemCategories[v.diffKop < 0 ? 'cash_shortage' : 'cash_surplus'] : null, subcategoryId: null, comment: v.comment, ref: { type: 'shift', id: v.shiftId },
    receiptIssued: null, occurredAt: new Date().toISOString(), authorId: v.authorId, reversalOf: null,
  }, undefined, v.shiftId);
}

export function resetFinance(branches: BranchLite[]): void {
  seeding = true;
  ops = [];
  balances = new Map();
  periods = new Map();
  replays.clear();
  seq = 1000;
  categories = [];
  SEED_CATEGORIES.forEach(([name, subs], i) => {
    const top: Category = { id: randomUUID(), kind: 'expense', parentId: null, name, sortOrder: (i + 1) * 10, status: 'active', rowVersion: 1 };
    categories.push(top, ...subs.map((s, j) => ({ id: randomUUID(), kind: 'expense' as const, parentId: top.id, name: s, sortOrder: (j + 1) * 10, status: 'active' as const, rowVersion: 1 })));
  });
  // 0210: системные, в конце уровня
  const shortage: Category = { id: randomUUID(), kind: 'expense', parentId: null, name: 'Недостача кассы', sortOrder: 1000, status: 'active', rowVersion: 1 };
  const surplus: Category = { id: randomUUID(), kind: 'income', parentId: null, name: 'Излишек кассы', sortOrder: 1000, status: 'active', rowVersion: 1 };
  categories.push(shortage, surplus);
  systemCategories = { cash_shortage: shortage.id, cash_surplus: surplus.id };
  const base = { method: null, source: null, categoryId: null, subcategoryId: null, ref: null, receiptIssued: null, reversalOf: null };
  for (const b of branches) {
    const today = todayIn(b.timezone, Date.now());
    const prev = `${prevMonth(today)}-01`;
    const at = (date: string, minutes: number) => new Date(midnight(date, b.timezone) + minutes * 60_000).toISOString();
    const coms = catByName('Коммунальные');
    if (b.id === 'b-nsk-krasny') {
      insert({ ...base, branchId: b.id, kind: 'opening_balance', place: 'cash', direction: 'in', amountKop: 1_000_000, comment: 'Пересчёт кассы при запуске', occurredAt: at(prev, 0), authorId: 's-owner' });
      insert({ ...base, branchId: b.id, kind: 'opening_balance', place: 'noncash', direction: 'in', amountKop: 500_000, comment: 'Остаток на счёте', occurredAt: at(prev, 1), authorId: 's-owner' });
      insert({ ...base, branchId: b.id, kind: 'income', place: 'cash', method: 'cash', direction: 'in', amountKop: 300_000, source: 'event', comment: 'День рождения, предоплата', occurredAt: at(addDays(prev, 14), 720), authorId: 's-director' });
      insert({ ...base, branchId: b.id, kind: 'expense', place: 'noncash', method: 'card', direction: 'out', amountKop: 120_000, categoryId: coms.id, subcategoryId: catByName('Электричество', coms.id).id, comment: 'Счёт за электричество', occurredAt: at(addDays(prev, 14), 780), authorId: 's-director' });
      // Деньги чужих модулей (K10 оплата, K16 продажа сертификата, возврат) – кнопок сторно у них нет.
      insert({ ...base, branchId: b.id, kind: 'income', place: 'noncash', method: 'card', direction: 'in', amountKop: 150_000, source: 'session', ref: { type: 'payment', id: randomUUID() }, receiptIssued: true, comment: null, occurredAt: at(today, 1), authorId: null });
      insert({ ...base, branchId: b.id, kind: 'income', place: 'cash', method: 'cash', direction: 'in', amountKop: 200_000, source: 'certificate_sale', ref: { type: 'certificate', id: randomUUID() }, comment: null, occurredAt: at(today, 2), authorId: 's-admin' });
      const buy = catByName('Закупки и материалы');
      insert({ ...base, branchId: b.id, kind: 'expense', place: 'cash', method: 'cash', direction: 'out', amountKop: 30_000, categoryId: buy.id, subcategoryId: catByName('Хозяйственные товары', buy.id).id, comment: 'Салфетки и моющее', occurredAt: at(today, 4), authorId: 's-admin' });
      insert({ ...base, branchId: b.id, kind: 'refund', place: 'noncash', method: 'card', direction: 'out', amountKop: 50_000, ref: { type: 'payment', id: randomUUID() }, comment: 'Отмена брони клиентом', occurredAt: at(today, 3), authorId: 's-director' });
    } else if (b.id === 'b-tsk-lenina') {
      insert({ ...base, branchId: b.id, kind: 'opening_balance', place: 'cash', direction: 'in', amountKop: 700_000, comment: 'Пересчёт кассы при запуске', occurredAt: at(prev, 0), authorId: 's-owner' });
      insert({ ...base, branchId: b.id, kind: 'income', place: 'cash', method: 'cash', direction: 'in', amountKop: 90_000, source: 'extra_service', comment: 'Аренда джойстиков', occurredAt: at(today, 1), authorId: 's-admin-tsk' });
    }
  }
  seeding = false;
}

// ---- маршруты

export function registerFinance(app: FastifyInstance, P: string, deps: FinanceMockDeps): void {
  const branchOf = (id: string) => deps.branches().find((b) => b.id === id);
  const inZone = (s: Staffish, b: BranchLite) => {
    const z = deps.zone(s);
    return z.network || z.branchIds.includes(b.id);
  };
  const canAt = (s: Staffish, action: string, b: BranchLite) => deps.can(s, action) && inZone(s, b);

  /** guardFinance: вне зоны (finance.view.day) – 404, без права – 403. */
  function guard(s: Staffish, branchId: string, action: string): BranchLite {
    const b = branchOf(branchId);
    if (!b || !canAt(s, 'finance.view.day', b)) throw notFound();
    if (!deps.can(s, action)) throw new Fail(403, 'FORBIDDEN', 'Недостаточно прав', { action });
    return b;
  }
  const shape = (s: Staffish, op: Op) => {
    const b = branchOf(op.branchId);
    if (b && canAt(s, 'finance.view', b)) return op;
    const { balanceAfterKop: _b, ...rest } = op;
    void _b;
    return rest;
  };
  const send = (reply: FastifyReply, e: unknown) => {
    if (!(e instanceof Fail)) throw e;
    return reply.code(e.status).send({ error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}), requestId: randomUUID() } });
  };

  // ---- журнал №37
  app.get(`${P}/branches/:branchId/finance/operations`, async (req, reply) => {
    try {
      const s = deps.current(req);
      const b = branchOf((req.params as { branchId: string }).branchId);
      if (!b || !canAt(s, 'finance.view.day', b)) throw notFound();
      const full = canAt(s, 'finance.view', b);
      const q = req.query as Record<string, string | undefined>;
      const limit = q.limit === undefined ? 50 : Number(q.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw zodFail('limit');
      if (q.cursor !== undefined && !/^\d{1,16}:\d{1,18}$/.test(q.cursor)) throw zodFail('cursor');
      const today = todayIn(b.timezone, Date.now());
      let from = q.from ?? today;
      let to = q.to ?? from;
      for (const [f, v] of [['from', from], ['to', to]] as const) if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw invalid('Неверная дата', f);
      if (!full) {
        if ((q.from && q.from !== today) || (q.to && q.to !== today)) throw new Fail(403, 'FORBIDDEN', 'Доступны только текущие сутки', { action: 'finance.view' });
        from = today;
        to = today;
      }
      if (to < from || addDays(from, 366) <= to) throw invalid('Период – от 1 до 366 дней', 'to');
      const start = midnight(from, b.timezone);
      const end = midnight(addDays(to, 1), b.timezone);
      const needle = q.q?.trim();
      const [cms, cnum] = q.cursor ? q.cursor.split(':').map(Number) : [null, null];
      const all = ops
        .filter((o) => o.branchId === b.id && Date.parse(o.occurredAt) >= start && Date.parse(o.occurredAt) < end)
        .filter((o) => (!q.kind || o.kind === q.kind) && (!q.categoryId || o.categoryId === q.categoryId || o.subcategoryId === q.categoryId) && (!q.authorId || o.authorId === q.authorId))
        .filter((o) => !needle || (/^\d{1,18}$/.test(needle) ? String(o.number) === needle : (o.comment ?? '').toLowerCase().includes(needle.toLowerCase())))
        .sort((x, y) => Date.parse(x.occurredAt) - Date.parse(y.occurredAt) || x.number - y.number)
        .filter((o) => cms === null || Date.parse(o.occurredAt) > cms || (Date.parse(o.occurredAt) === cms && o.number > cnum!));
      const items = all.slice(0, limit);
      const last = items.at(-1);
      return { items: items.map((o) => shape(s, o)), nextCursor: all.length > limit && last ? `${Date.parse(last.occurredAt)}:${last.number}` : null, from, to };
    } catch (e) {
      return send(reply, e);
    }
  });

  // ---- предпросмотр №38: только с finance.view (решение 02.11)
  app.post(`${P}/branches/:branchId/finance/preview`, async (req, reply) => {
    try {
      const s = deps.current(req);
      const body = (req.body ?? {}) as Rec;
      if (body.place !== 'cash' && body.place !== 'noncash') throw zodFail('place');
      if (!Number.isSafeInteger(body.deltaKop)) throw zodFail('deltaKop');
      const b = guard(s, (req.params as { branchId: string }).branchId, 'finance.view');
      guard(s, b.id, 'finance.expense.create');
      const currentKop = bal(b.id, body.place);
      const afterKop = currentKop + (body.deltaKop as number);
      const allowed = (body.deltaKop as number) >= 0 || afterKop >= 0;
      return { currentKop, afterKop, allowed, reason: allowed ? null : 'negative_forbidden' };
    } catch (e) {
      return send(reply, e);
    }
  });

  /** routes.crm.ts command(): ключ, повтор по хэшу запроса, откат состояния при отказе, срез остатков в CASH_INSUFFICIENT. */
  function command(op: string, run: (s: Staffish, params: Record<string, string>, body: Rec) => unknown, status = 201) {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      const s = deps.current(req);
      const params = req.params as Record<string, string>;
      try {
        const raw = req.headers['idempotency-key'];
        const key = (Array.isArray(raw) ? raw[0] : raw)?.trim();
        if (!key) throw new Fail(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Нужен заголовок Idempotency-Key');
        if (!UUID_RE.test(key)) throw new Fail(400, 'VALIDATION_FAILED', 'Idempotency-Key должен быть UUID', { field: 'Idempotency-Key' });
        const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? (req.body as Rec) : {};
        const hash = JSON.stringify({ route: `${req.method} ${req.routeOptions.url}`, params, body });
        const memoKey = `${s.id}:finance.${op}:${key.toLowerCase()}`;
        const memo = replays.get(memoKey);
        if (memo) {
          if (memo.hash !== hash) throw new Fail(409, 'IDEMPOTENCY_KEY_REUSED', 'Этот ключ уже использован для другого запроса');
          return reply.code(memo.status).header('idempotent-replay', 'true').send(memo.body);
        }
        const snap = { ops: ops.map((o) => ({ ...o })), balances: new Map(balances), categories: categories.map((c) => ({ ...c })), periods: new Map(periods), seq };
        let out: unknown;
        try {
          out = run(s, params, body);
        } catch (e) {
          ({ ops, balances, categories, periods, seq } = snap);
          throw e;
        }
        replays.set(memoKey, { hash, status, body: out });
        return reply.code(status).send(out);
      } catch (e) {
        if (e instanceof Fail && e.code === 'CASH_INSUFFICIENT') {
          const b = params.branchId ? branchOf(params.branchId) : undefined;
          if (!deps.zone(s).network && !(b && canAt(s, 'finance.view', b))) return send(reply, new Fail(e.status, e.code, e.message, { place: e.details?.place }));
        }
        return send(reply, e);
      }
    };
  }

  const isMoment = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(v) && !Number.isNaN(Date.parse(v));
  const METHODS = ['cash', 'card', 'transfer'];
  const optText = (body: Rec, f: string) => {
    if (body[f] !== undefined && body[f] !== null && (typeof body[f] !== 'string' || (body[f] as string).length > 2000)) throw zodFail(f);
  };

  /** postMoneyOperation: normalize → категория → закрытый месяц → отрицательная касса → запись. */
  function post(s: Staffish, b: BranchLite, v: { kind: 'income' | 'expense'; method: Method; amountKop: number; source: string | null; categoryId: string | null; subcategoryId: string | null; comment: string | null; occurredAt: string; ref: { type: string; id: string } | null; receiptIssued: boolean | null }): Op {
    if (!Number.isSafeInteger(v.amountKop) || v.amountKop <= 0) throw new Fail(422, 'INVALID_AMOUNT', 'Сумма – целое положительное число копеек', { amountKop: v.amountKop });
    const place: Place = v.method === 'cash' ? 'cash' : 'noncash';
    const comment = v.kind === 'expense' ? (v.comment?.trim() ?? '') : v.comment?.trim() || null;
    if (comment === '') throw new Fail(422, 'COMMENT_REQUIRED', 'Укажите комментарий', { field: 'comment' });
    let cat: { categoryId: string; subcategoryId: string | null } | null = null;
    if (v.kind === 'expense') {
      const c = categories.find((x) => x.id === v.categoryId);
      if (!c || c.kind !== 'expense' || c.parentId !== null) throw invalid('Нет такой категории расхода', 'categoryId');
      if (c.status === 'archived') throw new Fail(422, 'CATEGORY_ARCHIVED', 'Категория в архиве', { categoryId: c.id });
      if (v.subcategoryId) {
        const sub = categories.find((x) => x.id === v.subcategoryId);
        if (!sub || sub.parentId !== c.id) throw invalid('Подкатегория не из этой категории', 'subcategoryId');
        if (sub.status === 'archived') throw new Fail(422, 'CATEGORY_ARCHIVED', 'Подкатегория в архиве', { categoryId: sub.id });
        cat = { categoryId: c.id, subcategoryId: sub.id };
      } else {
        if (categories.some((x) => x.parentId === c.id && x.status === 'active')) throw new Fail(422, 'SUBCATEGORY_REQUIRED', 'Выберите подкатегорию', { categoryId: c.id });
        cat = { categoryId: c.id, subcategoryId: null };
      }
    }
    const month = monthOf(Date.parse(v.occurredAt), b.timezone);
    if (periods.has(`${b.id}:${month}`)) throw new Fail(409, 'PERIOD_CLOSED', 'Месяц закрыт: исправление – операцией текущей датой', { month });
    if (v.kind === 'expense' && bal(b.id, place) - v.amountKop < 0) {
      throw new Fail(409, 'CASH_INSUFFICIENT', 'Недостаточно денег в кассе: внесите поступление или проверьте начальный остаток', { place, currentKop: bal(b.id, place), afterKop: bal(b.id, place) - v.amountKop });
    }
    return insert({
      branchId: b.id, kind: v.kind, place, method: v.method, direction: v.kind === 'income' ? 'in' : 'out', amountKop: v.amountKop, source: v.source,
      categoryId: cat?.categoryId ?? null, subcategoryId: cat?.subcategoryId ?? null, comment, ref: v.ref, receiptIssued: v.receiptIssued,
      occurredAt: new Date(Date.parse(v.occurredAt)).toISOString(), authorId: s.id, reversalOf: null,
    });
  }

  function manualRef(body: Rec) {
    const r = body.ref as { type?: unknown; id?: unknown } | null | undefined;
    if (r === undefined || r === null) return null;
    if (!['booking', 'event', 'repair', 'staff'].includes(String(r.type)) || !UUID_RE.test(String(r.id))) throw zodFail('ref');
    return { type: String(r.type), id: String(r.id) };
  }

  /** recordIncome: схема → права → сеанс/сертификат → не в будущем → ядро. */
  function income(s: Staffish, branchId: string, body: Rec): Op {
    if (!METHODS.includes(String(body.method))) throw zodFail('method');
    if (typeof body.amountKop !== 'number') throw zodFail('amountKop');
    if (!['session', 'certificate_sale', 'event', 'extra_service', 'other'].includes(String(body.source))) throw zodFail('source');
    if (!isMoment(body.occurredAt)) throw zodFail('occurredAt');
    optText(body, 'comment');
    if (body.receiptIssued !== undefined && body.receiptIssued !== null && typeof body.receiptIssued !== 'boolean') throw zodFail('receiptIssued');
    const ref = manualRef(body);
    const b = guard(s, branchId, 'finance.income.create');
    if (body.source === 'session') throw new Fail(422, 'SESSION_INCOME_VIA_PAYMENT', 'Доход по сеансу вносится оплатой брони, не формой дохода');
    if (body.source === 'certificate_sale') throw invalid('Продажа сертификата – из раздела сертификатов', 'source');
    if (Date.parse(body.occurredAt as string) > Date.now()) throw invalid('Дата операции – не в будущем', 'occurredAt');
    return post(s, b, { kind: 'income', method: body.method as Method, amountKop: body.amountKop, source: String(body.source), categoryId: null, subcategoryId: null,
      comment: (body.comment as string | null | undefined) ?? null, occurredAt: body.occurredAt as string, ref, receiptIssued: (body.receiptIssued as boolean | null | undefined) ?? null });
  }

  function expense(s: Staffish, branchId: string, body: Rec): Op {
    if (!METHODS.includes(String(body.method))) throw zodFail('method');
    if (typeof body.amountKop !== 'number') throw zodFail('amountKop');
    if (!UUID_RE.test(String(body.categoryId))) throw zodFail('categoryId');
    if (body.subcategoryId !== undefined && body.subcategoryId !== null && !UUID_RE.test(String(body.subcategoryId))) throw zodFail('subcategoryId');
    if (!isMoment(body.occurredAt)) throw zodFail('occurredAt');
    if (body.comment !== undefined && (typeof body.comment !== 'string' || body.comment.length > 2000)) throw zodFail('comment');
    const ref = manualRef(body);
    const b = guard(s, branchId, 'finance.expense.create');
    if (Date.parse(body.occurredAt as string) > Date.now()) throw invalid('Дата операции – не в будущем', 'occurredAt');
    return post(s, b, { kind: 'expense', method: body.method as Method, amountKop: body.amountKop, source: null, categoryId: String(body.categoryId),
      subcategoryId: (body.subcategoryId as string | null | undefined) ?? null, comment: (body.comment as string | undefined) ?? null, occurredAt: body.occurredAt as string, ref, receiptIssued: null });
  }

  commands = { income, expense };
  app.post(`${P}/branches/:branchId/finance/income`, command('income', (s, p, body) => shape(s, income(s, p.branchId!, body))));
  app.post(`${P}/branches/:branchId/finance/expense`, command('expense', (s, p, body) => shape(s, expense(s, p.branchId!, body))));

  /** reverseCore: права finance.correct, причина, запреты по источнику, уже сторнирована, минус места, запись сторно. */
  function reverse(s: Staffish, id: string, body: Rec): Op {
    if (body.reason !== undefined && (typeof body.reason !== 'string' || body.reason.length > 2000)) throw zodFail('reason');
    const found = ops.find((o) => o.id === id);
    if (!found) throw notFound();
    guard(s, found.branchId, 'finance.correct');
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (reason === '') throw new Fail(422, 'COMMENT_REQUIRED', 'Укажите комментарий', { field: 'reason' });
    if (found.kind === 'reversal') throw new Fail(409, 'CANNOT_REVERSE_REVERSAL', 'Сторно нельзя сторнировать');
    // возврат refundIncome (K20 §6, ref operation) сторнируется, возврат K10 и K16 – нет
    if (found.kind === 'refund' && found.ref?.type !== 'operation') throw new Fail(409, 'USE_PAYMENT_REFUND', 'Возврат не сторнируется: исправление – корректировкой', { operationId: found.id });
    if (found.kind === 'income' && found.source === 'session') throw new Fail(409, 'USE_PAYMENT_REFUND', 'Приход по сеансу исправляется возвратом платежа', { operationId: found.id });
    if (found.kind === 'income' && found.source === 'certificate_sale') throw new Fail(409, 'USE_CERTIFICATE_CANCEL', 'Приход от продажи сертификата исправляется отменой продажи', { operationId: found.id });
    if (found.reversedBy) throw new Fail(409, 'ALREADY_REVERSED', 'Операция уже сторнирована', { reversalId: found.reversedBy });
    if (found.kind === 'income') {
      const live = ops.filter((o) => o.kind === 'refund' && o.ref?.type === 'operation' && o.ref.id === found.id && !o.reversedBy);
      if (live.length > 0) throw new Fail(409, 'INCOME_HAS_REFUNDS', 'По поступлению есть возвраты: сначала сторно возвратов', { refundIds: live.map((x) => x.id) });
    }
    const deltas: Array<[Place, number]> = found.kind === 'place_transfer'
      ? [[found.place, found.amountKop], [found.place === 'cash' ? 'noncash' : 'cash', -found.amountKop]]
      : [[found.place, found.direction === 'in' ? -found.amountKop : found.amountKop]];
    for (const [place, delta] of deltas) {
      if (delta < 0 && bal(found.branchId, place) + delta < 0) {
        throw new Fail(409, 'CASH_INSUFFICIENT', 'Недостаточно денег в кассе: внесите поступление или проверьте начальный остаток', { place, currentKop: bal(found.branchId, place), afterKop: bal(found.branchId, place) + delta });
      }
    }
    const rev = insert({
      branchId: found.branchId, kind: 'reversal', place: found.place, method: found.method, direction: found.direction === 'in' ? 'out' : 'in', amountKop: found.amountKop,
      source: null, categoryId: null, subcategoryId: null, comment: reason, ref: { type: 'operation', id: found.id }, receiptIssued: null,
      occurredAt: new Date().toISOString(), authorId: s.id, reversalOf: found.id,
    }, found.kind === 'place_transfer' ? (found.place === 'cash' ? 'noncash' : 'cash') : undefined);
    found.reversedBy = rev.id;
    return rev;
  }

  const opId = (p: Record<string, string>) => {
    if (!UUID_RE.test(p.id ?? '')) throw zodFail('operationId');
    return p.id!;
  };
  app.post(`${P}/finance/operations/:id/reverse`, command('reverse', (s, p, body) => shape(s, reverse(s, opId(p), body))));
  app.post(`${P}/finance/operations/:id/correct`, command('correct', (s, p, body) => {
    const id = opId(p);
    if (body.reason !== undefined && typeof body.reason !== 'string') throw zodFail('reason');
    const r = body.replacement as Rec | undefined;
    if (!r || typeof r !== 'object' || !['opening_balance', 'income', 'expense', 'withdrawal', 'place_transfer'].includes(String(r.kind))) throw zodFail('replacement.kind');
    const reversal = reverse(s, id, { reason: body.reason });
    const original = ops.find((o) => o.id === id)!;
    const { kind, ...rest } = r;
    if (kind !== 'income' && kind !== 'expense') throw new Fail(501, 'NOT_IMPLEMENTED', 'Мок: исправление – доходом или расходом');
    const replacement = kind === 'income' ? income(s, original.branchId, rest) : expense(s, original.branchId, rest);
    return { reversal: shape(s, reversal), replacement: shape(s, replacement) };
  }));

  // ---- категории №46
  app.get(`${P}/finance/categories`, async (req, reply) => {
    try {
      const s = deps.current(req);
      if (!deps.can(s, 'finance.view.day')) throw new Fail(403, 'FORBIDDEN', 'Недостаточно прав', { action: 'finance.view.day' });
      const q = req.query as { kind?: string; includeArchived?: string };
      if (q.kind !== undefined && q.kind !== 'income' && q.kind !== 'expense') throw zodFail('kind');
      const withArchived = q.includeArchived === 'true';
      const all = categories
        .filter((c) => (!q.kind || c.kind === q.kind) && (withArchived || c.status === 'active'))
        .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
      return { items: all.filter((c) => c.parentId === null).map((c) => ({ ...c, children: all.filter((x) => x.parentId === c.id) })) };
    } catch (e) {
      return send(reply, e);
    }
  });
  const manage = (s: Staffish) => {
    if (!deps.can(s, 'finance.category.manage')) throw new Fail(403, 'FORBIDDEN', 'Недостаточно прав', { action: 'finance.category.manage' });
  };
  const nameOf = (v: unknown) => {
    const n = typeof v === 'string' ? v.trim() : '';
    if (n.length < 1 || n.length > 200) throw zodFail('name');
    return n;
  };
  const dup = (kind: string, parentId: string | null, name: string, except?: string) => {
    if (categories.some((c) => c.kind === kind && c.parentId === parentId && c.name === name && c.id !== except)) throw invalid('Такое имя уже есть на этом уровне', 'name');
  };
  app.post(`${P}/finance/categories`, command('category.create', (s, _p, body) => {
    manage(s);
    if (body.kind !== 'income' && body.kind !== 'expense') throw zodFail('kind');
    const parentId = body.parentId === undefined || body.parentId === null ? null : String(body.parentId);
    if (parentId !== null && !UUID_RE.test(parentId)) throw zodFail('parentId');
    const name = nameOf(body.name);
    if (body.sortOrder !== undefined && !Number.isInteger(body.sortOrder)) throw zodFail('sortOrder');
    if (parentId !== null) {
      const parent = categories.find((c) => c.id === parentId);
      if (!parent) throw invalid('Нет такой категории', 'parentId');
      if (parent.parentId !== null) throw invalid('Третьего уровня категорий нет', 'parentId');
      if (parent.kind !== body.kind) throw invalid('Подкатегория того же вида, что и категория', 'kind');
      if (parent.status === 'archived') throw new Fail(422, 'CATEGORY_ARCHIVED', 'Категория в архиве', { categoryId: parent.id });
    }
    dup(body.kind, parentId, name);
    const level = categories.filter((c) => c.kind === body.kind && c.parentId === parentId);
    const c: Category = { id: randomUUID(), kind: body.kind, parentId, name, sortOrder: (body.sortOrder as number | undefined) ?? Math.max(0, ...level.filter((x) => !Object.values(systemCategories).includes(x.id)).map((x) => x.sortOrder)) + 10, status: 'active', rowVersion: 1 };
    categories.push(c);
    return c;
  }));
  app.patch(`${P}/finance/categories/:id`, command('category.update', (s, p, body) => {
    if (!Number.isInteger(body.rowVersion) || (body.rowVersion as number) < 1) throw zodFail('rowVersion');
    const name = body.name === undefined ? undefined : nameOf(body.name);
    if (body.sortOrder !== undefined && !Number.isInteger(body.sortOrder)) throw zodFail('sortOrder');
    if (body.status !== undefined && body.status !== 'active' && body.status !== 'archived') throw zodFail('status');
    if (name === undefined && body.sortOrder === undefined && body.status === undefined) throw zodFail('');
    manage(s);
    const c = categories.find((x) => x.id === p.id);
    if (!c) throw notFound();
    if (c.rowVersion !== body.rowVersion) throw new Fail(409, 'VERSION_CONFLICT', 'Категорию уже изменили', { rowVersion: c.rowVersion });
    if (body.status === 'active' && c.status === 'archived' && c.parentId) {
      const parent = categories.find((x) => x.id === c.parentId);
      if (parent?.status === 'archived') throw new Fail(422, 'CATEGORY_ARCHIVED', 'Сначала верните из архива категорию', { categoryId: parent.id });
    }
    if (name !== undefined) dup(c.kind, c.parentId, name, c.id);
    const wasActive = c.status === 'active';
    Object.assign(c, { name: name ?? c.name, sortOrder: (body.sortOrder as number | undefined) ?? c.sortOrder, status: (body.status as Category['status'] | undefined) ?? c.status, rowVersion: c.rowVersion + 1 });
    if (body.status === 'archived' && wasActive && c.parentId === null) {
      for (const x of categories) if (x.parentId === c.id && x.status === 'active') Object.assign(x, { status: 'archived', rowVersion: x.rowVersion + 1 });
    }
    return c;
  }, 200));

  // ---- закрытие месяца №47
  app.post(`${P}/branches/:branchId/finance/periods/:month/close`, command('period.close', (s, p) => {
    if (!/^\d{4}-\d{2}$/.test(p.month ?? '')) throw zodFail('month');
    const b = guard(s, p.branchId!, 'finance.period.close');
    const month = `${p.month}-01`;
    if (month >= monthOf(Date.now(), b.timezone)) throw invalid('Закрыть можно только прошедший месяц', 'month');
    const prev = periods.get(`${b.id}:${month}`);
    if (prev) throw new Fail(409, 'PERIOD_CLOSED', 'Месяц уже закрыт', { month, closedAt: prev.closedAt });
    const closedAt = new Date().toISOString();
    periods.set(`${b.id}:${month}`, { closedAt });
    return { branchId: b.id, month, closedAt, closedBy: s.id };
  }, 200));
}

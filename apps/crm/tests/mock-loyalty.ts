// Мок баллов CRM строго по apps/api/src/modules/loyalty/routes.crm.ts (K15 №24–28) и account.ts, adjust.ts, goods.ts:
// №24 бонусный счёт (баланс, доступно = max(0, баланс) − резервы, история с основанием, партии, выданные товары,
// открытые «требует решения», причина блокировки при −50); №25 корректировка (loyalty.adjust; ниже −50 – только
// Владелец с belowLimit; issueId – чужой/нет – NOT_FOUND, закрыт – LOYALTY_ISSUE_RESOLVED; повтор по ключу – тот же
// ответ); №26 каталог филиала с архивом, создание и правка (loyalty.goods.manage, rowVersion); №27 выдача целиком
// (GOODS_UNAVAILABLE с причиной, POINTS_INSUFFICIENT с числами); №28 возврат с причиной (ALREADY_REVERSED).
// Зона клиента – как clients.getClientCard (вне зоны 404), филиала – assertCan (вне зоны 404, без права 403).
// Подключается из mock-api.ts (registerLoyalty), resetLoyalty() – POST /__test/reset.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';

type Rec = Record<string, unknown>;
interface Staffish { id: string; role: string }
interface Zone { network: boolean; cityIds: string[]; branchIds: string[] }

export interface LoyaltyMockDeps {
  current: (req: FastifyRequest) => Staffish;
  zone: (s: Staffish) => Zone;
  can: (s: Staffish, action: string) => boolean;
  /** Клиент существует и в зоне сотрудника (как GET /clients/{id}). */
  clientVisible: (s: Staffish, clientId: string) => boolean;
  branchExists: (branchId: string) => boolean;
}

export const LIMIT_MESSAGE =
  'Предварительная запись временно недоступна: баланс бонусных баллов достиг минимального значения −50. Обратитесь к администратору клуба';
const MIN = -5000;

interface Entry {
  entryId: number; at: string; type: string; deltaCenti: number; balanceAfterCenti: number; comment: string | null; branchId: string | null;
  ref: { type: string; id: string } | null; author: { type: string; id: string | null };
}
interface Batch {
  id: string; clientId: string; source: 'visit' | 'manual'; entryId: number; branchId: string | null; amountCenti: number; remainingCenti: number;
  expiresAt: string | null; status: 'active' | 'depleted' | 'expired'; accruedAt: string;
}
interface Goods {
  id: string; name: string; description: string | null; imageUrl: string | null; priceRubKop: number | null; pricePointsCenti: number;
  status: 'active' | 'archived'; rowVersion: number; branches: Array<{ branchId: string; stock: number | null; active: boolean }>;
}
interface Order {
  id: string; goodsId: string; branchId: string; clientId: string; priceCenti: number; status: 'issued' | 'returned'; issuedAt: string;
  returnReason: string | null; moves: Array<{ batchId: string; centi: number }>;
}
interface Issue { id: string; clientId: string; kind: string; ref: { type: string; id: string }; amountCenti: number; createdAt: string; status: 'open' | 'resolved' }

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
const forbidden = (action: string) => new Fail(403, 'FORBIDDEN', 'Недостаточно прав', { action });
const zodFail = (path: string) => new Fail(400, 'VALIDATION_FAILED', 'Неверные данные запроса', { issues: [{ path, message: 'Invalid input' }] });

const C1 = 'c0000000-0000-4000-8000-000000000001'; // Ольга Смирнова, Красный
const C2 = 'c0000000-0000-4000-8000-000000000002'; // Иван Петров, гость, −50
const gid = (n: number) => `90000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let entries = new Map<string, Entry[]>();
let batches: Batch[] = [];
let reserves = new Map<string, number>(); // клиент → Σ занятых резервов (резервы ставит запись, не CRM)
let goods: Goods[] = [];
let orders: Order[] = [];
let issues: Issue[] = [];
let nextEntry = 1;
let memo = new Map<string, { hash: string; status: number; body: unknown }>();

const balanceOf = (clientId: string) => entries.get(clientId)?.at(-1)?.balanceAfterCenti ?? 0;
function write(clientId: string, e: Omit<Entry, 'entryId' | 'balanceAfterCenti'>): Entry {
  const list = entries.get(clientId) ?? [];
  const entry = { ...e, entryId: nextEntry++, balanceAfterCenti: balanceOf(clientId) + e.deltaCenti };
  list.push(entry);
  entries.set(clientId, list);
  return entry;
}
function credit(clientId: string, e: Entry, source: Batch['source'], at: string, expiresAt: string | null = null): void {
  const debt = Math.max(0, -(e.balanceAfterCenti - e.deltaCenti));
  const remaining = Math.max(0, e.deltaCenti - debt);
  batches.push({ id: randomUUID(), clientId, source, entryId: e.entryId, branchId: e.branchId, amountCenti: e.deltaCenti, remainingCenti: remaining, expiresAt, status: remaining > 0 ? 'active' : 'depleted', accruedAt: at });
}
/** FEFO из партий, не больше положительного баланса до записи; остаток – долг. */
function debit(clientId: string, amount: number, balanceBefore: number): Array<{ batchId: string; centi: number }> {
  let left = Math.min(amount, Math.max(0, balanceBefore));
  const moves: Array<{ batchId: string; centi: number }> = [];
  const own = batches.filter((b) => b.clientId === clientId && b.status === 'active' && b.remainingCenti > 0)
    .sort((a, b) => (a.expiresAt ?? '9999').localeCompare(b.expiresAt ?? '9999') || a.accruedAt.localeCompare(b.accruedAt));
  for (const b of own) {
    if (left === 0) break;
    const d = Math.min(b.remainingCenti, left);
    b.remainingCenti -= d;
    if (b.remainingCenti === 0) b.status = 'depleted';
    moves.push({ batchId: b.id, centi: d });
    left -= d;
  }
  return moves;
}

export function resetLoyalty(): void {
  entries = new Map();
  batches = [];
  goods = [];
  orders = [];
  issues = [];
  nextEntry = 1;
  memo = new Map();
  reserves = new Map([[C1, 600]]);
  const sys = { type: 'system', id: null };
  const a1 = write(C1, { at: '2026-10-20T08:00:00.000Z', type: 'loyalty.accrual', deltaCenti: 2000, comment: null, branchId: 'b-nsk-krasny', ref: { type: 'visit', id: randomUUID() }, author: sys });
  credit(C1, a1, 'visit', a1.at);
  const a2 = write(C1, { at: '2026-10-27T09:00:00.000Z', type: 'loyalty.accrual', deltaCenti: 3000, comment: null, branchId: 'b-nsk-krasny', ref: { type: 'visit', id: randomUUID() }, author: sys });
  credit(C1, a2, 'visit', a2.at);
  const p = write(C1, { at: '2026-10-29T10:00:00.000Z', type: 'loyalty.penalty', deltaCenti: -500, comment: null, branchId: 'b-nsk-krasny', ref: { type: 'no_show', id: randomUUID() }, author: sys });
  debit(C1, 500, p.balanceAfterCenti + 500);
  // Иван: долг −50 после сторно начисления, открыт «требует решения»
  write(C2, { at: '2026-10-25T12:00:00.000Z', type: 'loyalty.penalty', deltaCenti: -5000, comment: null, branchId: 'b-nsk-krasny', ref: { type: 'no_show', id: randomUUID() }, author: sys });
  issues.push({ id: gid(901), clientId: C2, kind: 'accrual_reversal_below_limit', ref: { type: 'visit', id: randomUUID() }, amountCenti: 1000, createdAt: '2026-10-26T12:00:00.000Z', status: 'open' });
  goods = [
    { id: gid(1), name: 'Энергетик', description: 'Банка 0,45 л', imageUrl: null, priceRubKop: 15000, pricePointsCenti: 3000, status: 'active', rowVersion: 1,
      branches: [{ branchId: 'b-nsk-krasny', stock: 5, active: true }] },
    { id: gid(2), name: 'Кружка клуба', description: null, imageUrl: null, priceRubKop: 50000, pricePointsCenti: 10000, status: 'active', rowVersion: 1,
      branches: [{ branchId: 'b-nsk-krasny', stock: null, active: true }, { branchId: 'b-tsk-lenina', stock: 2, active: true }] },
    { id: gid(3), name: 'Чипсы', description: null, imageUrl: null, priceRubKop: 9000, pricePointsCenti: 2000, status: 'archived', rowVersion: 2,
      branches: [{ branchId: 'b-nsk-krasny', stock: 0, active: true }] },
  ];
}

const dto = (g: Goods) => ({ ...g, branches: g.branches.map((b) => ({ ...b })) });
const listItem = (g: Goods, branchId: string) => {
  const b = g.branches.find((x) => x.branchId === branchId)!;
  return { id: g.id, name: g.name, description: g.description, imageUrl: g.imageUrl, priceRubKop: g.priceRubKop, pricePointsCenti: g.pricePointsCenti,
    status: g.status, stock: b.stock, rowVersion: g.rowVersion, available: g.status === 'active' && b.active && (b.stock === null || b.stock > 0) };
};

export function registerLoyalty(app: FastifyInstance, P: string, deps: LoyaltyMockDeps): void {
  const inZone = (s: Staffish, branchId: string) => deps.zone(s).network || deps.zone(s).branchIds.includes(branchId);
  /** assertCan по филиалу: вне зоны – 404, без права – 403. */
  const assertCan = (s: Staffish, action: string, branchId: string) => {
    if (!deps.branchExists(branchId) || !inZone(s, branchId)) throw notFound();
    if (!deps.can(s, action)) throw forbidden(action);
  };
  const clientInZone = (s: Staffish, clientId: string, action: string) => {
    if (!deps.clientVisible(s, clientId)) throw notFound();
    if (!deps.can(s, action)) throw forbidden(action);
    return clientId;
  };
  const available = (clientId: string) => Math.max(0, Math.max(0, balanceOf(clientId)) - (reserves.get(clientId) ?? 0));
  const send = (reply: FastifyReply, e: unknown) => {
    if (e instanceof Fail) return reply.code(e.status).send({ error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}), requestId: randomUUID() } });
    throw e;
  };
  const handle = (fn: (s: Staffish, p: Record<string, string>, body: Rec, req: FastifyRequest) => unknown) => async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      return await fn(deps.current(req), req.params as Record<string, string>, (req.body ?? {}) as Rec, req);
    } catch (e) {
      return send(reply, e);
    }
  };
  /** Команда с Idempotency-Key: повтор с тем же телом – тот же ответ, с другим – IDEMPOTENCY_KEY_REUSED. */
  const keyed = (op: string, req: FastifyRequest, reply: FastifyReply, s: Staffish, run: () => unknown) => {
    const raw = req.headers['idempotency-key'];
    const key = Array.isArray(raw) ? raw[0] : raw;
    if (!key || key.trim() === '') throw new Fail(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Нужен заголовок Idempotency-Key');
    if (!UUID_RE.test(key.trim())) throw new Fail(400, 'VALIDATION_FAILED', 'Idempotency-Key должен быть UUID', { field: 'Idempotency-Key' });
    const id = `${s.id}:${op}:${key.trim().toLowerCase()}`;
    const hash = JSON.stringify([req.params, req.body ?? null]);
    const prior = memo.get(id);
    if (prior) {
      if (prior.hash !== hash) throw new Fail(409, 'IDEMPOTENCY_KEY_REUSED', 'Этот ключ уже использован для другого запроса');
      return reply.code(prior.status).header('idempotent-replay', 'true').send(prior.body);
    }
    const body = run();
    memo.set(id, { hash, status: 201, body });
    return reply.code(201).send(body);
  };

  // №24
  app.get(`${P}/clients/:clientId/loyalty`, handle((s, p) => {
    const clientId = clientInZone(s, p.clientId ?? '', 'loyalty.view');
    const bal = balanceOf(clientId);
    const reserved = reserves.get(clientId) ?? 0;
    return {
      balanceCenti: bal, availableCenti: available(clientId), reservedCenti: reserved, nextExpiry: null, preBookingBlocked: bal <= MIN, accrualBasis: 'planned',
      history: [...(entries.get(clientId) ?? [])].reverse(),
      batches: batches.filter((b) => b.clientId === clientId).sort((a, b) => b.accruedAt.localeCompare(a.accruedAt)).map(({ clientId: _c, ...b }) => (void _c, b)),
      goodsOrders: orders.filter((o) => o.clientId === clientId).sort((a, b) => b.issuedAt.localeCompare(a.issuedAt)).map((o) => ({
        id: o.id, goodsId: o.goodsId, goodsName: goods.find((g) => g.id === o.goodsId)!.name, branchId: o.branchId, priceCenti: o.priceCenti,
        status: o.status, issuedAt: o.issuedAt, returnReason: o.returnReason,
      })),
      issues: issues.filter((i) => i.clientId === clientId && i.status === 'open').map(({ clientId: _c, status: _s, ...i }) => (void _c, void _s, i)),
      blockedReason: bal <= MIN ? LIMIT_MESSAGE : null,
    };
  }));

  // №25
  app.post(`${P}/clients/:clientId/loyalty/adjust`, async (req, reply) => {
    try {
      const s = deps.current(req);
      const clientId = clientInZone(s, (req.params as { clientId: string }).clientId, 'loyalty.adjust');
      const b = (req.body ?? {}) as Rec;
      const extra = Object.keys(b).filter((k) => !['deltaCenti', 'reason', 'belowLimit', 'issueId'].includes(k));
      if (extra.length) throw zodFail(extra[0]!);
      if (typeof b.deltaCenti !== 'number' || !Number.isInteger(b.deltaCenti) || b.deltaCenti === 0) throw zodFail('deltaCenti');
      if (typeof b.reason !== 'string' || b.reason.length > 1000) throw zodFail('reason');
      if (b.belowLimit !== undefined && b.belowLimit !== true) throw zodFail('belowLimit');
      if (b.issueId !== undefined && !UUID_RE.test(String(b.issueId))) throw zodFail('issueId');
      return keyed('adjust', req, reply, s, () => {
        const reason = (b.reason as string).trim();
        if (reason === '') throw new Fail(422, 'COMMENT_REQUIRED', 'Укажите причину корректировки', { field: 'reason' });
        const delta = b.deltaCenti as number;
        const bal = balanceOf(clientId);
        const issue = b.issueId ? issues.find((i) => i.id === b.issueId && i.clientId === clientId) : undefined;
        if (b.issueId && !issue) throw new Fail(404, 'NOT_FOUND', 'Задача «требует решения» не найдена', { issueId: b.issueId });
        if (issue && issue.status !== 'open') throw new Fail(409, 'LOYALTY_ISSUE_RESOLVED', 'Задача «требует решения» уже закрыта', { issueId: issue.id });
        if (delta < 0 && bal + delta < MIN && !(b.belowLimit === true && s.role === 'owner')) {
          throw new Fail(403, 'LIMIT_OVERRIDE_NOT_ALLOWED', 'Ниже −50 баллов – только Владелец в режиме «ниже предела»', { balanceCenti: bal, deltaCenti: delta });
        }
        const e = write(clientId, { at: new Date().toISOString(), type: 'loyalty.manual', deltaCenti: delta, comment: reason, branchId: null, ref: null, author: { type: 'staff', id: s.id } });
        if (delta > 0) credit(clientId, e, 'manual', e.at);
        else debit(clientId, -delta, bal);
        if (issue) issue.status = 'resolved';
        return { entryId: e.entryId };
      });
    } catch (e) {
      return send(reply, e);
    }
  });

  // №26
  app.get(`${P}/branches/:branchId/goods`, handle((s, p) => {
    assertCan(s, 'loyalty.view', p.branchId ?? '');
    return { items: goods.filter((g) => g.branches.some((b) => b.branchId === p.branchId)).sort((a, b) => a.name.localeCompare(b.name, 'ru')).map((g) => listItem(g, p.branchId!)) };
  }));
  const goodsBody = (b: Rec, partial: boolean) => {
    const allowed = ['name', 'description', 'imageUrl', 'priceRubKop', 'pricePointsCenti', 'branches', ...(partial ? ['rowVersion', 'status'] : [])];
    const extra = Object.keys(b).filter((k) => !allowed.includes(k));
    if (extra.length) throw zodFail(extra[0]!);
    const has = (k: string) => b[k] !== undefined;
    if ((!partial || has('name')) && (typeof b.name !== 'string' || b.name.length < 1 || b.name.length > 200)) throw zodFail('name');
    if (has('priceRubKop') && b.priceRubKop !== null && (!Number.isInteger(b.priceRubKop) || (b.priceRubKop as number) < 0)) throw zodFail('priceRubKop');
    if ((!partial || has('pricePointsCenti')) && (!Number.isInteger(b.pricePointsCenti) || (b.pricePointsCenti as number) <= 0)) throw zodFail('pricePointsCenti');
    if (!partial || has('branches')) {
      if (!Array.isArray(b.branches) || b.branches.length < 1) throw zodFail('branches');
      for (const x of b.branches as Rec[]) if (x.stock !== undefined && x.stock !== null && (!Number.isInteger(x.stock) || (x.stock as number) < 0)) throw zodFail('branches.stock');
    }
    if (partial && (!Number.isInteger(b.rowVersion) || (b.rowVersion as number) < 1)) throw zodFail('rowVersion');
    if (partial && has('status') && !['active', 'archived'].includes(String(b.status))) throw zodFail('status');
    if (has('name') && (b.name as string).trim() === '') throw new Fail(400, 'VALIDATION_FAILED', 'Нужно название', { field: 'name' });
  };
  const upsert = (s: Staffish, g: Goods, list: Rec[]) => {
    for (const x of list) {
      assertCan(s, 'loyalty.goods.manage', String(x.branchId));
      const row = { branchId: String(x.branchId), stock: (x.stock as number | null | undefined) ?? null, active: (x.active as boolean | undefined) ?? true };
      const i = g.branches.findIndex((y) => y.branchId === row.branchId);
      if (i >= 0) g.branches[i] = row;
      else g.branches.push(row);
    }
  };
  app.post(`${P}/goods`, async (req, reply) => {
    try {
      const s = deps.current(req);
      const b = (req.body ?? {}) as Rec;
      goodsBody(b, false);
      const g: Goods = { id: randomUUID(), name: (b.name as string).trim(), description: (b.description as string | null | undefined) ?? null, imageUrl: (b.imageUrl as string | null | undefined) ?? null,
        priceRubKop: (b.priceRubKop as number | null | undefined) ?? null, pricePointsCenti: b.pricePointsCenti as number, status: 'active', rowVersion: 1, branches: [] };
      upsert(s, g, b.branches as Rec[]);
      goods.push(g);
      return reply.code(201).send(dto(g));
    } catch (e) {
      return send(reply, e);
    }
  });
  app.patch(`${P}/goods/:goodsId`, handle((s, p, b) => {
    const g = goods.find((x) => x.id === p.goodsId);
    goodsBody(b, true);
    if (!g || !g.branches.some((x) => inZone(s, x.branchId))) throw notFound();
    for (const x of g.branches) if (inZone(s, x.branchId)) assertCan(s, 'loyalty.goods.manage', x.branchId);
    if (b.rowVersion !== g.rowVersion) throw new Fail(409, 'VERSION_CONFLICT', 'Карточку товара уже изменили', { rowVersion: g.rowVersion });
    if (b.name !== undefined) g.name = (b.name as string).trim();
    if (b.description !== undefined) g.description = b.description as string | null;
    if (b.imageUrl !== undefined) g.imageUrl = b.imageUrl as string | null;
    if (b.priceRubKop !== undefined) g.priceRubKop = b.priceRubKop as number | null;
    if (b.pricePointsCenti !== undefined) g.pricePointsCenti = b.pricePointsCenti as number;
    if (b.status !== undefined) g.status = b.status as Goods['status'];
    if (b.branches) upsert(s, g, b.branches as Rec[]);
    g.rowVersion++;
    return dto(g);
  }));

  // №27
  app.post(`${P}/clients/:clientId/goods-orders`, async (req, reply) => {
    try {
      const s = deps.current(req);
      const clientId = clientInZone(s, (req.params as { clientId: string }).clientId, 'loyalty.goods.issue');
      const b = (req.body ?? {}) as Rec;
      const extra = Object.keys(b).filter((k) => !['goodsId', 'branchId'].includes(k));
      if (extra.length) throw zodFail(extra[0]!);
      if (!UUID_RE.test(String(b.goodsId))) throw zodFail('goodsId');
      if (typeof b.branchId !== 'string') throw zodFail('branchId'); // в моке id филиалов не UUID
      return keyed('goods_issue', req, reply, s, () => {
        assertCan(s, 'loyalty.goods.issue', b.branchId as string);
        const g = goods.find((x) => x.id === b.goodsId);
        const gb = g?.branches.find((x) => x.branchId === b.branchId);
        const unavailable = (reason: string) => new Fail(409, 'GOODS_UNAVAILABLE', 'Товар сейчас нельзя выдать', { reason });
        if (!g || !gb) throw unavailable('not_in_branch');
        if (g.status !== 'active') throw unavailable('archived');
        if (!gb.active) throw unavailable('not_in_branch');
        if (gb.stock !== null && gb.stock <= 0) throw unavailable('out_of_stock');
        const free = available(clientId);
        if (free < g.pricePointsCenti) throw new Fail(409, 'POINTS_INSUFFICIENT', 'Баллов недостаточно для товара', { availableCenti: free, requiredCenti: g.pricePointsCenti });
        const orderId = randomUUID();
        const bal = balanceOf(clientId);
        const e = write(clientId, { at: new Date().toISOString(), type: 'loyalty.spend_goods', deltaCenti: -g.pricePointsCenti, comment: null, branchId: gb.branchId, ref: { type: 'goods_order', id: orderId }, author: { type: 'staff', id: s.id } });
        const moves = debit(clientId, g.pricePointsCenti, bal);
        if (gb.stock !== null) gb.stock--;
        orders.push({ id: orderId, goodsId: g.id, branchId: gb.branchId, clientId, priceCenti: g.pricePointsCenti, status: 'issued', issuedAt: e.at, returnReason: null, moves });
        return { orderId, entryId: e.entryId };
      });
    } catch (e) {
      return send(reply, e);
    }
  });

  // №28
  app.post(`${P}/goods-orders/:orderId/return`, async (req, reply) => {
    try {
      const s = deps.current(req);
      const b = (req.body ?? {}) as Rec;
      if (Object.keys(b).some((k) => k !== 'reason') || typeof b.reason !== 'string' || b.reason.length > 1000) throw zodFail('reason');
      const o = orders.find((x) => x.id === (req.params as { orderId: string }).orderId);
      if (!o) throw notFound();
      assertCan(s, 'loyalty.goods.issue', o.branchId);
      if (b.reason.trim() === '') throw new Fail(422, 'COMMENT_REQUIRED', 'Укажите причину возврата', { field: 'reason' });
      if (o.status !== 'issued') throw new Fail(409, 'ALREADY_REVERSED', 'Товар уже возвращён');
      write(o.clientId, { at: new Date().toISOString(), type: 'loyalty.return', deltaCenti: o.priceCenti, comment: b.reason.trim(), branchId: o.branchId, ref: { type: 'goods_order', id: o.id }, author: { type: 'staff', id: s.id } });
      for (const m of o.moves) {
        const batch = batches.find((x) => x.id === m.batchId)!;
        batch.remainingCenti += m.centi;
        batch.status = 'active';
      }
      const gb = goods.find((g) => g.id === o.goodsId)!.branches.find((x) => x.branchId === o.branchId);
      if (gb && gb.stock !== null) gb.stock++;
      o.status = 'returned';
      o.returnReason = b.reason.trim();
      return reply.code(201).send({ returnedCenti: o.priceCenti, notReturnedCenti: 0 });
    } catch (e) {
      return send(reply, e);
    }
  });
}

// S3-54: деньги мероприятия на настоящей Postgres. Предоплата наличными + доплата картой – две операции (Q-74); возврат больше
// поступления; возврат после сторно под lockPlaces – OPERATION_REVERSED (гонка); сторно поступления с живыми возвратами –
// INCOME_HAS_REFUNDS; расход виден в журнале кассы одной строкой; привязка из общих расходов без новой операции; формулы сводки
// проверяются на случайных последовательностях (property-based) против независимого подсчёта.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { AppError } from '../../apps/api/src/core/errors.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { withTx } from '../../apps/api/src/modules/clients/index.ts';
import { createEvent } from '../../apps/api/src/modules/events/events.ts';
import { addLine, removeLine } from '../../apps/api/src/modules/events/lines.ts';
import { addEventExpense, eventMoneySummary, linkEventExpense, recordEventIncome, refundEventIncome, summarize } from '../../apps/api/src/modules/events/money.ts';
import { recordExpense, recordIncome } from '../../apps/api/src/modules/finance/cashbox.ts';
import { reverseOperation } from '../../apps/api/src/modules/finance/corrections.ts';
import { createTestBranch } from '../helpers/network.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const clock = fixedClock('2026-11-14T05:00:00Z');
const AT = '2026-11-14T04:00:00Z';
let db: TestDatabase;
let pool: pg.Pool;
let owner: AccessContext;
let admin: AccessContext;
let branchId = '';
let typeId = '';
let category = { categoryId: '', subcategoryId: '' };

const meta = (ctx: AccessContext = owner): AuditRequestMeta => ({ actor: ctx.actor, access: ctx, source: 'crm', requestId: randomUUID() });
const opts = () => ({ idempotencyKey: randomUUID(), clock });
const tx = <T>(fn: (c: pg.PoolClient) => Promise<T>) => withTx(pool, fn);
async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
}
const newEvent = () => tx((c) => createEvent(c, owner, { typeId, branchId, customer: { name: 'Анна', phone: '+79131234567' } }, meta(), clock));
const income = (eventId: string, amountKop: number, method = 'cash', ctx = owner) => tx((c) => recordEventIncome(c, ctx, eventId, { method, amountKop, occurredAt: AT }, meta(ctx), opts()));
const refund = (eventId: string, incomeOperationId: string, amountKop: number, method = 'cash', reason: string | undefined = 'вернули') =>
  tx((c) => refundEventIncome(c, owner, eventId, { incomeOperationId, amountKop, method, reason }, meta(), opts()));
const expense = (eventId: string, amountKop: number, over: Record<string, unknown> = {}) =>
  tx((c) => addEventExpense(c, owner, eventId, { method: 'cash', amountKop, ...category, occurredAt: AT, comment: 'аниматор', ...over }, meta(), opts()));
const reverse = (operationId: string) => tx((c) => reverseOperation(c, owner, { operationId, reason: 'ошибка ввода' }, meta(), opts()));

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 12 });
  const s = await db.client.query<{ id: string }>(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', 'o@yu.test', 'owner', 'x'), ('А', 'Ф', 'a@yu.test', 'admin', 'x') RETURNING id`);
  owner = { actor: { kind: 'staff', staffId: s.rows[0]!.id, sessionId: randomUUID() }, role: 'owner', network: true, cityIds: new Set(), branchIds: new Set(), at: clock.now() };
  branchId = (await createTestBranch(db.client)).id;
  admin = { actor: { kind: 'staff', staffId: s.rows[1]!.id, sessionId: randomUUID() }, role: 'admin', network: false, cityIds: new Set(), branchIds: new Set([branchId]), at: clock.now() };
  typeId = (await db.client.query<{ id: string }>(`SELECT id FROM app.event_types WHERE code = 'other'`)).rows[0]!.id;
  const cat = await db.client.query<{ categoryId: string; subcategoryId: string }>(
    `SELECT p.id AS "categoryId", c.id AS "subcategoryId" FROM app.finance_categories p JOIN app.finance_categories c ON c.parent_id = p.id WHERE p.kind = 'expense' AND p.status = 'active' AND c.status = 'active' ORDER BY p.sort_order, c.sort_order LIMIT 1`,
  );
  category = cat.rows[0]!;
  // запас в кассе: расход не упирается в отрицательный остаток (K17 §6)
  await tx((c) => recordIncome(c, owner, { branchId, method: 'cash', amountKop: 100_000_000, source: 'other', occurredAt: AT }, meta(), opts()));
  await tx((c) => recordIncome(c, owner, { branchId, method: 'card', amountKop: 100_000_000, source: 'other', occurredAt: AT }, meta(), opts()));
});
afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('S3-54: поступления', () => {
  it('предоплата наличными + доплата картой – две операции, каждая одним способом; сводка 11 §11.3', async () => {
    const e = await newEvent();
    await tx((c) => addLine(c, owner, e.id, { kind: 'service', name: 'Праздник', quantity: 1, unit: 'шт', priceKop: 1_000_000, planCostKop: 300_000 }, meta(), clock));
    const a = await income(e.id, 300_000, 'cash');
    const b = await income(e.id, 500_000, 'card');
    expect([a.kind, a.method, a.place, a.source, a.ref]).toEqual(['income', 'cash', 'cash', 'event', { type: 'event', id: e.id }]);
    expect([b.method, b.place]).toEqual(['card', 'noncash']);
    expect(a.id).not.toBe(b.id);
    await expense(e.id, 200_000);
    expect(await eventMoneySummary(pool, e.id)).toEqual({
      agreedKop: 1_000_000, receivedKop: 800_000, refundedKop: 0, dueKop: 200_000, planCostKop: 300_000, factCostKop: 200_000, resultKop: 600_000, deviationKop: -100_000, discountsKop: 0, giftsIssued: 0,
    });
    const session = await db.client.query(`SELECT 1 FROM app.payment_sessions ps JOIN journal.finance_operations fo ON fo.ref_id = ps.booking_id WHERE fo.ref_id = $1`, [e.id]);
    expect(session.rowCount).toBe(0); // не сеанс K10
  });
  it('право: Администратору – нет finance.income.create (Q-29); вне зоны – 404', async () => {
    const e = await newEvent();
    expect(await codeOf(income(e.id, 100, 'cash', admin))).toBe('FORBIDDEN');
    const stranger: AccessContext = { ...admin, branchIds: new Set() };
    expect(await codeOf(income(e.id, 100, 'cash', stranger))).toBe('NOT_FOUND');
  });
  it('место денег не по способу – отказ формы; 0 – INVALID_AMOUNT', async () => {
    const e = await newEvent();
    expect(await codeOf(tx((c) => recordEventIncome(c, owner, e.id, { place: 'noncash', method: 'cash', amountKop: 100, occurredAt: AT }, meta(), opts())))).toBe('VALIDATION_FAILED');
    expect(await codeOf(income(e.id, 0))).toBe('INVALID_AMOUNT');
  });
  it('повтор с тем же ключом – та же операция и одна связь', async () => {
    const e = await newEvent();
    const key = randomUUID();
    const body = { method: 'cash', amountKop: 700, occurredAt: AT };
    const a = await tx((c) => recordEventIncome(c, owner, e.id, body, meta(), { idempotencyKey: key, clock }));
    const b = await tx((c) => recordEventIncome(c, owner, e.id, body, meta(), { idempotencyKey: key, clock }));
    expect(b.id).toBe(a.id);
    expect((await eventMoneySummary(pool, e.id)).receivedKop).toBe(700);
  });
});

describe('S3-54: возврат и сторно', () => {
  it('возврат больше поступления – EVENT_REFUND_EXCEEDS_INCOME, с учётом уже возвращённого; связан с мероприятием', async () => {
    const e = await newEvent();
    const inc = await income(e.id, 1000);
    expect(await codeOf(refund(e.id, inc.id, 1001))).toBe('EVENT_REFUND_EXCEEDS_INCOME');
    await refund(e.id, inc.id, 600);
    expect(await codeOf(refund(e.id, inc.id, 401))).toBe('EVENT_REFUND_EXCEEDS_INCOME');
    await refund(e.id, inc.id, 400);
    const s = await eventMoneySummary(pool, e.id);
    expect(s).toMatchObject({ receivedKop: 1000, refundedKop: 1000, dueKop: 0 });
  });
  it('причина обязательна; поступление другого мероприятия – 404', async () => {
    const e = await newEvent();
    const other = await newEvent();
    const inc = await income(e.id, 1000);
    expect(await codeOf(refund(e.id, inc.id, 1, 'cash', ''))).toBe('COMMENT_REQUIRED');
    expect(await codeOf(refund(other.id, inc.id, 1))).toBe('NOT_FOUND');
  });
  it('сторно поступления с живыми возвратами – INCOME_HAS_REFUNDS; после сторно возврата – можно', async () => {
    const e = await newEvent();
    const inc = await income(e.id, 1000);
    const ref = await refund(e.id, inc.id, 300);
    expect(await codeOf(reverse(inc.id))).toBe('INCOME_HAS_REFUNDS');
    await reverse(ref.id);
    expect((await eventMoneySummary(pool, e.id)).refundedKop).toBe(0);
    await reverse(inc.id);
    expect((await eventMoneySummary(pool, e.id)).receivedKop).toBe(0);
    expect(await codeOf(refund(e.id, inc.id, 1))).toBe('OPERATION_REVERSED');
  });
  it('возврат K10 по-прежнему не сторнируется', async () => {
    const k10Income = await db.client.query<{ id: string }>(
      `INSERT INTO journal.finance_operations (branch_id, kind, place, method, direction, amount_kop, source, occurred_at, author_type, author_id, posting_id)
       VALUES ($1, 'income', 'cash', 'cash', 'in', 5, 'session', now(), 'staff', $2, gen_random_uuid()) RETURNING id`,
      [branchId, owner.actor.staffId],
    );
    const k10Refund = await db.client.query<{ id: string }>(
      `INSERT INTO journal.finance_operations (branch_id, kind, place, method, direction, amount_kop, comment, ref_type, ref_id, occurred_at, author_type, author_id, posting_id)
       VALUES ($1, 'refund', 'cash', 'cash', 'out', 1, 'возврат', 'operation', $2, now(), 'staff', $3, gen_random_uuid()) RETURNING id`,
      [branchId, k10Income.rows[0]!.id, owner.actor.staffId],
    );
    expect(await codeOf(reverse(k10Refund.rows[0]!.id))).toBe('USE_PAYMENT_REFUND');
  });
  it('гонка: 20 пар «возврат ↔ сторно поступления» – либо возврат жив, либо сторно, третьего нет', async () => {
    for (let i = 0; i < 20; i++) {
      const e = await newEvent();
      const inc = await income(e.id, 1000);
      const [r, s] = await Promise.all([codeOf(refund(e.id, inc.id, 500)), codeOf(reverse(inc.id))]);
      const pair = [r, s].sort().join('+');
      expect(['INCOME_HAS_REFUNDS+ok', 'OPERATION_REVERSED+ok']).toContain(pair);
      const sum = await eventMoneySummary(pool, e.id);
      if (r === 'ok') expect(sum).toMatchObject({ receivedKop: 1000, refundedKop: 500 });
      else expect(sum).toMatchObject({ receivedKop: 0, refundedKop: 0 });
    }
  });
  it('гонка: 10 параллельных возвратов по 300 из 1000 – прошло ровно 3', async () => {
    const e = await newEvent();
    const inc = await income(e.id, 1000);
    const codes = await Promise.all(Array.from({ length: 10 }, () => codeOf(refund(e.id, inc.id, 300))));
    expect(codes.filter((c) => c === 'ok')).toHaveLength(3);
    expect(codes.filter((c) => c === 'EVENT_REFUND_EXCEEDS_INCOME')).toHaveLength(7);
    expect((await eventMoneySummary(pool, e.id)).refundedKop).toBe(900);
  });
});

describe('S3-54: расходы', () => {
  it('расход из карточки виден в журнале кассы одной строкой; поставщик и строка состава', async () => {
    const e = await newEvent();
    const line = await tx((c) => addLine(c, owner, e.id, { kind: 'animator', name: 'Аниматор', quantity: 1, unit: 'шт', priceKop: 0 }, meta(), clock));
    const op = await expense(e.id, 5000, { lineId: line.id, supplier: 'ИП Смех' });
    const rows = await db.client.query(`SELECT id, comment FROM journal.finance_operations WHERE ref_type = 'event' AND ref_id = $1`, [e.id]);
    expect(rows.rows).toEqual([{ id: op.id, comment: 'аниматор (поставщик: ИП Смех)' }]);
    const l = await db.client.query(`SELECT role, in_cost, line_id FROM app.finance_operation_links WHERE operation_id = $1`, [op.id]);
    expect(l.rows[0]).toEqual({ role: 'expense', in_cost: true, line_id: line.id });
    expect((await eventMoneySummary(pool, e.id)).factCostKop).toBe(5000);
  });
  it('чужая строка состава – отказ; расход без комментария – COMMENT_REQUIRED', async () => {
    const e = await newEvent();
    const other = await newEvent();
    const line = await tx((c) => addLine(c, owner, other.id, { kind: 'animator', name: 'А', quantity: 1, unit: 'шт', priceKop: 0 }, meta(), clock));
    expect(await codeOf(expense(e.id, 10, { lineId: line.id }))).toBe('VALIDATION_FAILED');
    expect(await codeOf(expense(e.id, 10, { comment: '' }))).toBe('COMMENT_REQUIRED');
  });
  it('привязка кейтеринга из общих расходов: новой операции нет, вторая – OPERATION_ALREADY_LINKED; другое мероприятие – тоже', async () => {
    const e = await newEvent();
    const other = await newEvent();
    const op = await tx((c) => recordExpense(c, owner, { branchId, method: 'cash', amountKop: 7000, ...category, occurredAt: AT, comment: 'кейтеринг' }, meta(), opts()));
    const n = async () => (await db.client.query('SELECT count(*)::int n FROM journal.finance_operations')).rows[0].n;
    const before = await n();
    const link = (eventId: string, inCost?: boolean) => tx((c) => linkEventExpense(c, owner, eventId, { operationId: op.id, ...(inCost !== undefined ? { inCost } : {}) }, meta(), { clock }));
    await link(e.id);
    expect(await n()).toBe(before);
    expect((await eventMoneySummary(pool, e.id)).factCostKop).toBe(0); // накладные по умолчанию не в себестоимости (11 §8.5)
    expect(await codeOf(link(e.id))).toBe('OPERATION_ALREADY_LINKED');
    expect(await codeOf(link(other.id))).toBe('OPERATION_ALREADY_LINKED');
    const log = await db.client.query(`SELECT after FROM journal.audit_events WHERE action = 'event.money_linked' AND object_id = $1`, [e.id]);
    expect(log.rows[0].after.operationId).toBe(op.id);
  });
  it('расход другого филиала – 404 как несуществующий; поступление вместо расхода – OPERATION_LINK_INVALID; сторнированный расход выпадает из факта', async () => {
    const e = await newEvent();
    const b2 = (await createTestBranch(db.client)).id;
    await tx((c) => recordIncome(c, owner, { branchId: b2, method: 'cash', amountKop: 1000, source: 'other', occurredAt: AT }, meta(), opts()));
    const far = await tx((c) => recordExpense(c, owner, { branchId: b2, method: 'cash', amountKop: 10, ...category, occurredAt: AT, comment: 'x' }, meta(), opts()));
    expect(await codeOf(tx((c) => linkEventExpense(c, owner, e.id, { operationId: far.id }, meta(), { clock })))).toBe('NOT_FOUND');
    const inc = await tx((c) => recordIncome(c, owner, { branchId, method: 'cash', amountKop: 10, source: 'other', occurredAt: AT }, meta(), opts()));
    expect(await codeOf(tx((c) => linkEventExpense(c, owner, e.id, { operationId: inc.id }, meta(), { clock })))).toBe('OPERATION_LINK_INVALID');
    const op = await expense(e.id, 900);
    expect((await eventMoneySummary(pool, e.id)).factCostKop).toBe(900);
    await reverse(op.id);
    expect((await eventMoneySummary(pool, e.id)).factCostKop).toBe(0);
  });
  it('удалённая строка не входит в план и стоимость', async () => {
    const e = await newEvent();
    const line = await tx((c) => addLine(c, owner, e.id, { kind: 'decor', name: 'Шары', quantity: 2, unit: 'шт', priceKop: 100, planCostKop: 50, discountKop: 20, discountReason: 'акция' }, meta(), clock));
    expect(await eventMoneySummary(pool, e.id)).toMatchObject({ agreedKop: 180, planCostKop: 50, discountsKop: 20 });
    await tx((c) => removeLine(c, owner, line.id, { rowVersion: line.rowVersion, reason: 'нет' }, meta(), clock));
    expect(await eventMoneySummary(pool, e.id)).toMatchObject({ agreedKop: 0, planCostKop: 0, discountsKop: 0 });
  });
});

describe('S3-54: формулы сводки (property-based)', () => {
  function prng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  it('1000 случайных наборов связей: result = received − refunded − factCost; deviation = factCost − planCost; due = agreed − received + refunded', () => {
    for (let seed = 1; seed <= 1000; seed++) {
      const rnd = prng(seed);
      const int = (n: number) => Math.floor(rnd() * n);
      const roles = ['income', 'refund', 'expense', 'payout_expense'] as const;
      const links = Array.from({ length: int(20) }, () => ({ role: roles[int(4)]!, inCost: rnd() < 0.5, operation: { amountKop: 1 + int(1_000_000) } }));
      const agreedKop = int(10_000_000);
      const planCostKop = int(1_000_000);
      const s = summarize({ agreedKop, planCostKop, discountsKop: 0, giftsIssued: 0, links });
      const sumOf = (f: (l: (typeof links)[number]) => boolean) => links.filter(f).reduce((a, l) => a + l.operation.amountKop, 0);
      const received = sumOf((l) => l.role === 'income');
      const refunded = sumOf((l) => l.role === 'refund');
      const fact = sumOf((l) => l.role === 'expense' && l.inCost);
      expect(s.receivedKop).toBe(received);
      expect(s.refundedKop).toBe(refunded);
      expect(s.factCostKop).toBe(fact);
      expect(s.resultKop).toBe(received - refunded - fact);
      expect(s.deviationKop).toBe(fact - planCostKop);
      expect(s.dueKop).toBe(agreedKop - received + refunded);
    }
  });
});

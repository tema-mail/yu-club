// S3-38: расход на ремонт (K19 §10, K17 §14, приёмка 10 §17 п.18): двойной клик – одна операция; привязка ручного – новой нет; та же
// операция к мероприятию – OPERATION_ALREADY_LINKED; сторно в кассе → статус unpaid; плательщик – другой филиал зоны (Q-120); без права в
// филиале-плательщике – FORBIDDEN. Настоящая Postgres, 20 параллельных кликов – одна проводка.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyBalance } from '../../apps/api/src/core/ledger.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { recordExpense } from '../../apps/api/src/modules/finance/cashbox.ts';
import { reverseOperation } from '../../apps/api/src/modules/finance/corrections.ts';
import { linkOperation, linksOf } from '../../apps/api/src/modules/finance/links.ts';
import { createEquipment } from '../../apps/api/src/modules/equipment/items.ts';
import { closeRepair } from '../../apps/api/src/modules/equipment/repair-close.ts';
import { createRepairExpense, linkRepairExpense } from '../../apps/api/src/modules/equipment/repair-expense.ts';
import { changeRepairStatus, getRepair, registerRepair, updateRepair } from '../../apps/api/src/modules/equipment/repairs.ts';
import { createEquipmentWorld, ctxOf, fails, inTx, metaOf, type EquipmentWorld } from '../helpers/equipment.ts';

const clock = fixedClock('2026-11-14T05:00:00Z');
const AT = '2026-11-14T04:30:00Z';
let w: EquipmentWorld;
let owner: AccessContext;
let director: AccessContext;
let admin: AccessContext;
let otherCategory = '';

const newRepair = async () => {
  const eq = await inTx(w.pool, (t) => createEquipment(t, owner, { name: 'Шлем', categoryId: w.categoryId, branchId: w.branch }, metaOf(owner), clock));
  return (await inTx(w.pool, (t) => registerRepair(t, admin, { equipmentId: eq.id, detectedAt: '2026-11-14T04:00:00Z', brokenAtUnknown: true, symptoms: 'сломалось', priority: 'low', impact: 'none' }, metaOf(admin), clock))).repair;
};
const spend = (repairId: string, body: object = {}, who = director, key: string = randomUUID()) =>
  inTx(w.pool, (t) => createRepairExpense(t, who, repairId, { branchId: w.branch, method: 'cash', amountKop: 300000, occurredAt: AT, comment: 'плата', ...body }, metaOf(who), { idempotencyKey: key, clock }));
const manual = (branchId = w.branch, amountKop = 100000) =>
  inTx(w.pool, (t) => recordExpense(t, owner, { branchId, method: 'cash', amountKop, categoryId: otherCategory, occurredAt: AT, comment: 'запчасть' }, metaOf(owner), { idempotencyKey: randomUUID(), clock }));
const link = (repairId: string, operationId: string, who = director) => inTx(w.pool, (t) => linkRepairExpense(t, who, repairId, { operationId }, metaOf(who), clock));
const payment = async (repairId: string) => (await getRepair(w.pool, owner, repairId)).payment;
const opCount = async () => (await w.db.client.query<{ n: number }>(`SELECT count(*)::int n FROM journal.finance_operations WHERE kind = 'expense'`)).rows[0]!.n;

beforeAll(async () => {
  w = await createEquipmentWorld(40);
  owner = ctxOf(clock, 'owner');
  director = ctxOf(clock, 'director', [w.branch]);
  admin = ctxOf(clock, 'admin', [w.branch]);
  for (const b of [w.branch, w.other]) {
    await w.db.client.query(`INSERT INTO app.settings_values (key, level, branch_id, value, valid_from, created_by) VALUES ('finance.negative_balance_allowed', 'branch', $1, 'true', '2026-01-01', $2)`, [b, randomUUID()]);
  }
  otherCategory = (await w.db.client.query<{ id: string }>(`SELECT id FROM app.finance_categories WHERE name = 'Прочее' AND kind = 'expense' AND parent_id IS NULL`)).rows[0]!.id;
});
afterAll(() => w.close());

describe('createRepairExpense (приёмка 18)', () => {
  it('категория «Ремонт и обслуживание» → «Оборудование», ссылка и связь в одной транзакции, аудит; статус из связей', async () => {
    const r = await newRepair();
    const op = await spend(r.id);
    const cat = await w.db.client.query<{ c: string; s: string }>(`SELECT c.name AS c, s.name AS s FROM app.finance_categories c JOIN app.finance_categories s ON s.parent_id = c.id WHERE c.id = $1 AND s.id = $2`, [op.categoryId, op.subcategoryId]);
    expect(cat.rows[0]).toEqual({ c: 'Ремонт и обслуживание', s: 'Оборудование' });
    expect(op).toMatchObject({ kind: 'expense', amountKop: 300000, ref: { type: 'repair', id: r.id }, branchId: w.branch });
    const links = await linksOf(w.pool, { type: 'repair', id: r.id });
    expect(links.map((l) => [l.operation.id, l.role])).toEqual([[op.id, 'expense']]);
    expect(await payment(r.id)).toEqual({ paidKop: 300000, status: 'paid', lastPaidAt: new Date(AT).toISOString(), operationIds: [op.id] }); // без плана и факта – считается оплаченным
    const audit = await w.db.client.query<{ after: { operationId: string; created: boolean } }>(`SELECT after FROM journal.audit_events WHERE object_id = $1 AND action = 'repair.expense_linked'`, [r.id]);
    expect(audit.rows.map((x) => x.after)).toMatchObject([{ operationId: op.id, created: true }]);
  });

  it('двойной клик: тот же ключ – одна операция и одна связь; 20 параллельных – тоже; остаток счёта сходится', async () => {
    const r = await newRepair();
    const key = randomUUID();
    const before = await opCount();
    const a = await spend(r.id, {}, director, key);
    const b = await spend(r.id, {}, director, key);
    expect(b.id).toBe(a.id);
    expect(await opCount()).toBe(before + 1);
    expect((await w.db.client.query(`SELECT 1 FROM journal.audit_events WHERE object_id = $1 AND action = 'repair.expense_linked'`, [r.id])).rowCount).toBe(1);

    const race = await newRepair();
    const raceKey = randomUUID();
    const all = await Promise.all(Array.from({ length: 20 }, () => spend(race.id, {}, director, raceKey)));
    expect(new Set(all.map((x) => x.id)).size).toBe(1);
    expect((await linksOf(w.pool, { type: 'repair', id: race.id }))).toHaveLength(1);
    expect((await w.db.client.query(`SELECT 1 FROM journal.audit_events WHERE object_id = $1 AND action = 'repair.expense_linked'`, [race.id])).rowCount).toBe(1);
    const accounts = await w.db.client.query<{ id: string }>(`SELECT id FROM app.ledger_accounts WHERE owner_type = 'branch' AND owner_id = $1`, [w.branch]);
    for (const acc of accounts.rows) expect((await verifyBalance(w.db.client, acc.id)).ok).toBe(true);
  });

  it('плательщик – другой филиал зоны (Q-120): без него в зоне – FORBIDDEN; с зоной – операция того филиала, ремонт видит оплату', async () => {
    const r = await newRepair();
    await fails(spend(r.id, { branchId: w.other }), 'FORBIDDEN');
    expect((await w.db.client.query(`SELECT 1 FROM journal.audit_events WHERE object_id = $1 AND action = 'repair.expense_linked' AND result = 'success'`, [r.id])).rowCount).toBe(0);
    const both = ctxOf(clock, 'director', [w.branch, w.other]);
    const op = await spend(r.id, { branchId: w.other }, both);
    expect(op.branchId).toBe(w.other);
    expect((await payment(r.id)).operationIds).toEqual([op.id]);
    const stored = await w.db.client.query<{ branch_id: string }>(`SELECT branch_id FROM app.finance_operation_links WHERE operation_id = $1`, [op.id]);
    expect(stored.rows[0]!.branch_id).toBe(w.other);
  });

  it('права и проверки: Администратор – FORBIDDEN; чужой филиал – 404; сумма 0 и лишнее поле – отказ; своя подкатегория', async () => {
    const r = await newRepair();
    await fails(spend(r.id, {}, admin), 'FORBIDDEN');
    await fails(spend(r.id, {}, ctxOf(clock, 'director', [w.other])), 'NOT_FOUND');
    await fails(spend(randomUUID()), 'NOT_FOUND');
    await fails(spend(r.id, { amountKop: 0 }), 'INVALID_AMOUNT');
    await fails(spend(r.id, { place: 'cash' }), 'VALIDATION_FAILED');
    await fails(spend(r.id, { subcategoryId: otherCategory }), 'VALIDATION_FAILED');
    const sub = await w.db.client.query<{ id: string }>(`SELECT s.id FROM app.finance_categories s JOIN app.finance_categories p ON p.id = s.parent_id WHERE p.name = 'Ремонт и обслуживание' AND s.name = 'Мебель'`);
    expect((await spend(r.id, { subcategoryId: sub.rows[0]!.id })).subcategoryId).toBe(sub.rows[0]!.id);
  });
});

describe('linkRepairExpense: ручной расход без двойного учёта', () => {
  it('привязка ручного – новой операции нет; повтор – без изменений; ко второму ремонту и мероприятию – OPERATION_ALREADY_LINKED', async () => {
    const r = await newRepair();
    const op = await manual();
    const before = await opCount();
    await link(r.id, op.id);
    await link(r.id, op.id);
    expect(await opCount()).toBe(before);
    expect((await payment(r.id)).paidKop).toBe(100000);
    expect((await w.db.client.query(`SELECT 1 FROM journal.audit_events WHERE object_id = $1 AND action = 'repair.expense_linked'`, [r.id])).rowCount).toBe(1);
    const second = await newRepair();
    await fails(link(second.id, op.id), 'OPERATION_ALREADY_LINKED');
    await fails(inTx(w.pool, (t) => linkOperation(t, owner, { operationId: op.id, ref: { type: 'event', id: randomUUID() }, role: 'expense' }, metaOf(owner), clock)), 'OPERATION_ALREADY_LINKED');
    expect((await payment(second.id)).paidKop).toBe(0);
  });

  it('чужой филиал операции – 404; не расход – отказ; сторнированная – отказ; гонка двух ремонтов за одну операцию – одна связь', async () => {
    const r = await newRepair();
    await fails(link(r.id, (await manual(w.other)).id), 'NOT_FOUND');
    await fails(link(r.id, randomUUID()), 'NOT_FOUND');
    const dead = await manual();
    await inTx(w.pool, (t) => reverseOperation(t, owner, { operationId: dead.id, reason: 'ошибка' }, metaOf(owner), { idempotencyKey: randomUUID(), clock }));
    await fails(link(r.id, dead.id), 'OPERATION_LINK_INVALID');

    const op = await manual();
    const a = await newRepair();
    const b = await newRepair();
    const results = await Promise.allSettled([link(a.id, op.id), link(b.id, op.id)]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect((await w.db.client.query<{ n: number }>(`SELECT count(*)::int n FROM app.finance_operation_links WHERE operation_id = $1 AND unlinked_at IS NULL`, [op.id])).rows[0]!.n).toBe(1);
  });
});

describe('статус оплаты вычисляется (K19 §10, 16 §14)', () => {
  it('план → частично → оплачено → переплата; сторно в кассе → unpaid; закрытие: факт важнее плана; «без затрат» – no_cost', async () => {
    const r = await newRepair();
    const planned = await inTx(w.pool, (t) => updateRepair(t, director, r.id, { rowVersion: r.rowVersion, plan: { costKop: 400000 } }, metaOf(director), clock));
    expect(planned.payment).toMatchObject({ status: 'unpaid', paidKop: 0, lastPaidAt: null });
    const op = await spend(r.id, { amountKop: 100000 });
    expect((await payment(r.id)).status).toBe('partially_paid');
    await spend(r.id, { amountKop: 300000 });
    expect((await payment(r.id)).status).toBe('paid');
    const extra = await spend(r.id, { amountKop: 1000 });
    expect((await payment(r.id))).toMatchObject({ status: 'overpaid', paidKop: 401000 });
    for (const o of [extra.id, op.id]) await inTx(w.pool, (t) => reverseOperation(t, owner, { operationId: o, reason: 'ошибка' }, metaOf(owner), { idempotencyKey: randomUUID(), clock }));
    expect((await payment(r.id))).toMatchObject({ status: 'partially_paid', paidKop: 300000 });

    const single = await newRepair();
    const only = await spend(single.id, { amountKop: 5000 });
    await inTx(w.pool, (t) => reverseOperation(t, owner, { operationId: only.id, reason: 'двойной ввод' }, metaOf(owner), { idempotencyKey: randomUUID(), clock }));
    expect(await payment(single.id)).toEqual({ paidKop: 0, status: 'unpaid', lastPaidAt: null, operationIds: [] });

    const step = async (repair: { id: string; rowVersion: number }, to: string) => inTx(w.pool, (t) => changeRepairStatus(t, director, repair.id, { rowVersion: repair.rowVersion, to, comment: 'ход' }, metaOf(director), clock));
    const check = await step(await step(await step(await newRepair(), 'diagnostics'), 'planned'), 'cancelled');
    await fails(spend(check.id), 'REPAIR_TRANSITION_INVALID');
    const free = await step(await step(await newRepair(), 'diagnostics'), 'done_pending_check');
    const closed = await inTx(w.pool, (t) => closeRepair(t, director, free.id, { rowVersion: free.rowVersion, worksDone: 'не потребовался', completedAt: AT, finalEquipmentStatus: 'in_service', noCost: true, costComment: 'нет затрат' }, metaOf(director), clock));
    expect(closed.repair.payment.status).toBe('no_cost');
    await fails(spend(free.id), 'REPAIR_TRANSITION_INVALID');
  });
});

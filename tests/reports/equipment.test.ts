// S4-78: отчёт «Оборудование и ремонты» (K24 §3.10, 14 §13). Простой без двойного счёта: две пересекающиеся блокировки ремонта одной
// единицы и блокировка, связанная с ремонтом (приёмка 16); ремонт без начала → missing_input; расход ремонта – по связи rpt_repair_money:
// привязанный вручную входит, сторнированный – нет, в «Финансах» тот же расход один раз; повторные поломки; права: Администратор своего
// филиала видит отчёт, чужой филиал – 404; детализация = итог; инвентарный и серийный номера в строках. Оборудование и ремонты – прямым SQL.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { withTx } from '../../apps/api/src/modules/clients/index.ts';
import { recordExpense, recordIncome } from '../../apps/api/src/modules/finance/cashbox.ts';
import { reverseOperation } from '../../apps/api/src/modules/finance/corrections.ts';
import { linkOperation } from '../../apps/api/src/modules/finance/links.ts';
import { equipmentDetail, equipmentReport, type EquipmentMetric } from '../../apps/api/src/modules/reports/equipment.ts';
import { financeReport } from '../../apps/api/src/modules/reports/finance.ts';
import type { Metric } from '../../apps/api/src/modules/reports/framework.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';
import { d, reportFixtures, SYS, type Fx } from '../helpers/reports.ts';

const clock = fixedClock('2026-11-14T05:00:00Z');
const OCT = { from: d('2026-10-01'), to: d('2026-10-31') };
let db: TestDatabase;
let fx: Fx;
let a = '';
let b = '';
let item1 = '';
let r1 = '';
let r2 = '';

const val = (m: Metric | undefined) => (m?.state === 'ok' ? m.value : m?.state === 'unavailable' ? `${m.state}/${m.reason}` : m?.state);
const meta = (o: AccessContext): AuditRequestMeta => ({ actor: o.actor, access: o, source: 'crm', requestId: randomUUID() });
const tx = <T>(fn: (c: pg.PoolClient) => Promise<T>) => withTx(fx.app, fn);

async function item(branchId: string, inv: string, status: string, unitId: string | null, category: string): Promise<string> {
  const id = (
    await db.client.query<{ id: string }>(
      `INSERT INTO app.equipment_items (inventory_number, name, category_id, status, branch_id, created_by, serial_number) VALUES ($1, 'Шлем', $2, $3, $4, $5, $6) RETURNING id`,
      [inv, category, status, branchId, SYS, `SN-${inv}`],
    )
  ).rows[0]!.id;
  await db.client.query(`INSERT INTO app.equipment_placements (item_id, branch_id, unit_id, placed_at, moved_by, reason) VALUES ($1, $2, $3, '2026-01-01T00:00:00Z', $4, 'старт')`, [id, branchId, unitId, SYS]);
  return id;
}
async function repair(n: string, equipmentId: string, branchId: string, detected: string, started: string | null, completed: string | null): Promise<string> {
  const id = (
    await db.client.query<{ id: string }>(
      `INSERT INTO app.repairs (number, equipment_id, branch_id, broken_at_unknown, detected_at, registered_at, symptoms, priority, impact, created_by, status, completed_at)
       VALUES ($1, $2, $3, true, $4, $4, 'не включается', 'high', 'partial', $5, $6, $7) RETURNING id`,
      [n, equipmentId, branchId, detected, SYS, completed ? 'done_pending_check' : 'in_repair', completed],
    )
  ).rows[0]!.id;
  if (started) await db.client.query(`INSERT INTO journal.repair_status_history (repair_id, to_status, at, by_staff_id, comment) VALUES ($1, 'in_repair', $2, $3, 'в работе')`, [id, started, SYS]);
  return id;
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  fx = await reportFixtures(db);
  a = (await fx.branch('Asia/Novosibirsk')).id;
  b = (await fx.branch('Europe/Moscow')).id;
  const cat = (await db.client.query<{ id: string }>(`INSERT INTO app.equipment_categories (name) VALUES ('VR') RETURNING id`)).rows[0]!.id;
  const u1 = await fx.unit(a, 'VR1');
  const u2 = await fx.unit(a, 'VR2');
  await fx.resource(a, 'pc', 'VR 1', [u1]);
  item1 = await item(a, 'INV-000001', 'repair', u1, cat);
  await item(a, 'INV-000002', 'in_service', u2, cat);
  await item(a, 'INV-000003', 'written_off', null, cat);
  await item(b, 'INV-000009', 'in_service', null, cat);
  r1 = await repair('R-000001', item1, a, '2026-10-10T00:00:00Z', '2026-10-11T00:00:00Z', '2026-10-12T00:00:00Z');
  r2 = await repair('R-000002', item1, a, '2026-10-20T00:00:00Z', null, '2026-10-22T00:00:00Z');
  // простой: две пересекающиеся блокировки ремонта одной единицы – 36 ч, а не 48; блокировка другой причины, связанная с ремонтом, – 1 ч
  await fx.block(a, [u1], '2026-10-10T00:00:00Z', '2026-10-11T00:00:00Z');
  await fx.block(a, [u1], '2026-10-10T12:00:00Z', '2026-10-11T12:00:00Z');
  const linked = await fx.block(a, [u2], '2026-10-15T00:00:00Z', '2026-10-15T01:00:00Z', 'maintenance');
  await db.client.query(`INSERT INTO app.repair_blocks (repair_id, block_id, linked_at, linked_by) VALUES ($1, $2, now(), $3)`, [r1, linked, SYS]);
  // расходы: внесённый в общие расходы и привязанный вручную (без ref_type) входит; привязанный и сторнированный – нет
  const o = fx.owner();
  const opts = () => ({ idempotencyKey: randomUUID(), clock });
  await tx((t) => recordIncome(t, o, { branchId: a, method: 'cash', amountKop: 1_000_000, source: 'other', occurredAt: '2026-10-01T04:00:00Z' }, meta(o), opts()));
  const category = (
    await db.client.query<{ categoryId: string; subcategoryId: string }>(
      `SELECT p.id AS "categoryId", c.id AS "subcategoryId" FROM app.finance_categories p JOIN app.finance_categories c ON c.parent_id = p.id WHERE p.kind = 'expense' AND p.status = 'active' AND c.status = 'active' ORDER BY p.sort_order, c.sort_order LIMIT 1`,
    )
  ).rows[0]!;
  const spend = (kop: number) => tx((t) => recordExpense(t, o, { branchId: a, method: 'cash', amountKop: kop, ...category, occurredAt: '2026-10-12T04:00:00Z', comment: 'запчасть' }, meta(o), opts()));
  const ok = await spend(5_000);
  await tx((t) => linkOperation(t, o, { operationId: ok.id, ref: { type: 'repair', id: r1 }, role: 'expense' }, meta(o), clock));
  const wrong = await spend(7_000);
  await tx((t) => linkOperation(t, o, { operationId: wrong.id, ref: { type: 'repair', id: r2 }, role: 'expense' }, meta(o), clock));
  await tx((t) => reverseOperation(t, o, { operationId: wrong.id, reason: 'ошибка' }, meta(o), opts()));
}, 120_000);
afterAll(async () => {
  await fx.close();
  await db.drop();
});

describe('показатели', () => {
  it('приёмка 16: простой без двойного счёта; ремонт без начала → missing_input; повторные поломки; количество по статусам', async () => {
    const r = await fx.run(fx.owner(), (env) => equipmentReport(env, { period: OCT, branchIds: [a] }));
    expect(val(r.metrics.downtimeMinutes)).toBe(36 * 60 + 60);
    expect(val(r.metrics.avgRepairMinutes)).toBe('unavailable/missing_input');
    expect(val(r.metrics.repeatBreakdowns)).toBe(1);
    expect(val(r.metrics.totalEquipment)).toBe(2);
    expect(val(r.metrics.inService)).toBe(1);
    expect(val(r.metrics.faulty)).toBe(1);
    expect(val(r.metrics.incidents)).toBe(2);
    expect(val(r.metrics.openFaults)).toBe(2);
    const avg = await fx.run(fx.owner(), (env) => equipmentDetail(env, { period: OCT, branchIds: [a] }, 'avgRepairMinutes'));
    expect(new Map(avg.rows.map((x) => [x.id, x.value]))).toEqual(new Map([[r1, 24 * 60], [r2, null]]));
    expect(avg.rows[0]).toMatchObject({ inventoryNo: 'INV-000001', serialNo: 'SN-INV-000001' });
  });

  it('с началом у каждого ремонта – средняя длительность считается', async () => {
    const r = await fx.run(fx.owner(), (env) => equipmentReport(env, { period: { from: d('2026-10-01'), to: d('2026-10-15') }, branchIds: [a] }));
    expect(val(r.metrics.avgRepairMinutes)).toBe(24 * 60);
  });

  it('расход ремонта – по связи: привязанный вручную входит, сторнированный – нет; в «Финансах» тот же расход один раз', async () => {
    const r = await fx.run(fx.owner(), (env) => equipmentReport(env, { period: OCT, branchIds: [a] }));
    expect(val(r.metrics.repairExpenses)).toBe(5_000);
    expect(r.groups.expensesByContractor).toEqual([{ contractorId: null, amountKop: 5_000 }]);
    const f = await fx.run(fx.owner(), (env) => financeReport(env, { period: OCT, branchIds: [a] }));
    expect(val(f.metrics.expenses)).toBe(5_000 + 7_000); // в 3.4 сторно – отдельной строкой исправлений, расход ремонта – одной операцией, без задвоения
  });
});

describe('права', () => {
  it('Администратор своего филиала видит отчёт; чужой филиал – 404, в агрегате его нет', async () => {
    const adm = fx.admin([a]);
    const r = await fx.run(adm, (env) => equipmentReport(env, { period: OCT }));
    expect(val(r.metrics.totalEquipment)).toBe(2);
    await expect(fx.run(adm, (env) => equipmentReport(env, { period: OCT, branchIds: [b] }))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const dirB = await fx.run(fx.director([b]), (env) => equipmentDetail(env, { period: OCT }, 'totalEquipment'));
    expect(dirB.rows.map((x) => x.inventoryNo)).toEqual(['INV-000009']);
  });
});

describe('TC-20: детализация = итог', () => {
  it('каждый показатель-количество и сумма', async () => {
    const ctx = fx.owner();
    const r = await fx.run(ctx, (env) => equipmentReport(env, { period: OCT }));
    for (const [key, m] of Object.entries(r.metrics) as Array<[EquipmentMetric, Metric]>) {
      if (key === 'avgRepairMinutes' || m.state !== 'ok') continue;
      let cursor: string | undefined;
      let sum = 0;
      do {
        const page = await fx.run(ctx, (env) => equipmentDetail(env, { period: OCT }, key, { cursor, limit: 1 }));
        sum += page.rows.reduce((s, x) => s + (x.value ?? 0), 0);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(sum, key).toBe(m.value);
    }
  });
});

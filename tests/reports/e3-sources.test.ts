// S4-79: источники Э3 в дашборде и поиске. Карточки мероприятий, пустых и незакрытых смен, открытых неисправностей и простоя – из
// source_not_ready стали числами своих отчётов при тех же фильтрах; набор – по праву роли.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dashboard } from '../../apps/api/src/modules/reports/dashboard.ts';
import { equipmentReport } from '../../apps/api/src/modules/reports/equipment.ts';
import { eventsReport } from '../../apps/api/src/modules/reports/events.ts';
import { staffReport } from '../../apps/api/src/modules/reports/staff.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';
import { d, reportFixtures, SYS, type Fx } from '../helpers/reports.ts';

const NOV = { from: d('2026-11-01'), to: d('2026-11-30') };
let db: TestDatabase;
let fx: Fx;
let a = '';
let b = '';

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  fx = await reportFixtures(db);
  a = (await fx.branch('Asia/Novosibirsk')).id;
  b = (await fx.branch('Europe/Moscow')).id;
  const type = (await db.client.query<{ id: string }>(`SELECT id FROM app.event_types WHERE code = 'other'`)).rows[0]!.id;
  for (const [branch, n] of [[a, 1], [b, 2]] as const) {
    await db.client.query(
      `INSERT INTO app.events (number, type_id, branch_id, title, planned_start, planned_end, status, customer_name, customer_phone_e164, source, created_by_type)
       VALUES ($1, $2, $3, 'Праздник', '2026-11-10T08:00:00Z', '2026-11-10T10:00:00Z', 'new_request', 'Заказчик', '+79990000000', 'crm', 'staff')`,
      [`EV-00000${n}`, type, branch],
    );
  }
  const cat = (await db.client.query<{ id: string }>(`INSERT INTO app.equipment_categories (name) VALUES ('VR') RETURNING id`)).rows[0]!.id;
  for (const [branch, inv] of [[a, 'INV-000001'], [b, 'INV-000002']] as const) {
    const item = (await db.client.query<{ id: string }>(`INSERT INTO app.equipment_items (inventory_number, name, category_id, status, branch_id, created_by, serial_number) VALUES ($1, 'Шлем', $2, 'repair', $3, $4, $5) RETURNING id`, [inv, cat, branch, SYS, `SN-${inv}`])).rows[0]!.id;
    await db.client.query(
      `INSERT INTO app.repairs (number, equipment_id, branch_id, broken_at_unknown, detected_at, registered_at, symptoms, priority, impact, created_by) VALUES ($1, $2, $3, true, '2026-11-05T00:00:00Z', '2026-11-05T00:00:00Z', 'сломан', 'high', 'partial', $4)`,
      [`R-${inv.slice(4)}`, item, branch, SYS],
    );
  }
  const u = await fx.unit(a, 'VR1');
  await fx.block(a, [u], '2026-11-05T00:00:00Z', '2026-11-05T02:00:00Z');
  const staff = (await db.client.query<{ id: string }>(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', $1, 'admin', 'x') RETURNING id`, [`${randomUUID()}@yu.test`])).rows[0]!.id;
  await db.client.query(`INSERT INTO app.staff_shifts (staff_id, branch_id, local_date, period, created_by) VALUES ($1, $2, '2026-11-03', tstzrange('2026-11-03T03:00:00Z', '2026-11-03T09:00:00Z'), $1)`, [staff, a]);
}, 120_000);
afterAll(async () => {
  await fx.close();
  await db.drop();
});

describe('дашборд: карточки Э3 – числа своих отчётов', () => {
  it.each([[{}], [{ branchIds: ['A'] }]])('Владелец %o', async (f) => {
    const p = { period: NOV, ...('branchIds' in f ? { branchIds: [a] } : {}) };
    const dash = await fx.run(fx.owner(), (env) => dashboard(env, p));
    const card = (key: string) => dash.cards.find((c) => c.key === key)!.metric;
    const e = await fx.run(fx.owner(), (env) => eventsReport(env, p));
    const s = await fx.run(fx.owner(), (env) => staffReport(env, p));
    const q = await fx.run(fx.owner(), (env) => equipmentReport(env, p));
    expect(card('eventsCount')).toEqual(e.metrics.count);
    expect(card('emptyIntervals')).toEqual(s.metrics.emptyIntervals);
    expect(card('unclosedShifts')).toEqual(s.metrics.unclosedShifts);
    expect(card('openFaults')).toEqual(q.metrics.openFaults);
    expect(card('downtime')).toEqual(q.metrics.downtimeMinutes);
    expect(card('eventsCount')).toMatchObject({ state: 'ok', value: 'branchIds' in p ? 1 : 2 });
    expect(card('openFaults')).toMatchObject({ state: 'ok', value: 'branchIds' in p ? 1 : 2 });
    expect(card('downtime')).toMatchObject({ state: 'ok', value: 120 });
    expect(card('unclosedShifts')).toMatchObject({ state: 'ok', value: 1 });
    for (const key of ['eventsCount', 'emptyIntervals', 'unclosedShifts', 'openFaults', 'downtime']) expect(card(key), key).not.toEqual({ state: 'unavailable', reason: 'source_not_ready' });
  });

  it('Администратор: неисправности и простой своего филиала; мероприятий и смен нет (нет права)', async () => {
    const dash = await fx.run(fx.admin([b]), (env) => dashboard(env, { period: NOV }));
    const keys = dash.cards.map((c) => c.key);
    expect(keys).toEqual(expect.arrayContaining(['openFaults', 'downtime']));
    for (const k of ['eventsCount', 'emptyIntervals', 'unclosedShifts']) expect(keys).not.toContain(k);
    expect(dash.cards.find((c) => c.key === 'openFaults')!.metric).toMatchObject({ value: 1 });
  });
});

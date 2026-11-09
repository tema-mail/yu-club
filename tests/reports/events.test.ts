// S4-76: отчёт «Мероприятия» (K24 §3.5, 14 §8). Приёмка 14 п.10–11: мероприятие без брони включено, план и факт себестоимости раздельно;
// предоплата прошлого месяца входит в результат мероприятия; вручную привязанный кейтеринг (без ref_type) – в факте себестоимости;
// сторнированное поступление – нет; суммы = карточка мероприятия; права и область; детализация = итог. Данные – командами модулей.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { withTx } from '../../apps/api/src/modules/clients/index.ts';
import { createEvent } from '../../apps/api/src/modules/events/events.ts';
import { addLine } from '../../apps/api/src/modules/events/lines.ts';
import { addEventExpense, eventMoneySummary, linkEventExpense, recordEventIncome } from '../../apps/api/src/modules/events/money.ts';
import { recordExpense, recordIncome } from '../../apps/api/src/modules/finance/cashbox.ts';
import { reverseOperation } from '../../apps/api/src/modules/finance/corrections.ts';
import { eventsDetail, eventsReport, type EventsMetric } from '../../apps/api/src/modules/reports/events.ts';
import type { Metric } from '../../apps/api/src/modules/reports/framework.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';
import { d, reportFixtures, type Fx } from '../helpers/reports.ts';

const clock = fixedClock('2026-11-14T05:00:00Z');
const NOV = { from: d('2026-11-01'), to: d('2026-11-30') };
let db: TestDatabase;
let fx: Fx;
let a = '';
let b = '';
let main = '';

const val = (m: Metric | undefined) => (m?.state === 'ok' ? m.value : m?.state === 'unavailable' ? `${m.state}/${m.reason}` : m?.state);
const meta = (o: AccessContext): AuditRequestMeta => ({ actor: o.actor, access: o, source: 'crm', requestId: randomUUID() });
const opts = () => ({ idempotencyKey: randomUUID(), clock });
const tx = <T>(fn: (c: pg.PoolClient) => Promise<T>) => withTx(fx.app, fn);

async function event(branchId: string, start: string): Promise<string> {
  const o = fx.owner();
  const typeId = (await db.client.query<{ id: string }>(`SELECT id FROM app.event_types WHERE code = 'other'`)).rows[0]!.id;
  const end = new Date(Date.parse(start) + 2 * 3_600_000).toISOString();
  return (await tx((c) => createEvent(c, o, { typeId, branchId, customer: { name: 'Анна', phone: '+79131234567' }, plannedStart: start, plannedEnd: end }, meta(o), clock))).id;
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  fx = await reportFixtures(db);
  a = (await fx.branch('Asia/Novosibirsk')).id;
  b = (await fx.branch('Europe/Moscow')).id;
  const o = fx.owner();
  await tx((c) => recordIncome(c, o, { branchId: a, method: 'cash', amountKop: 10_000_000, source: 'other', occurredAt: '2026-10-01T04:00:00Z' }, meta(o), opts()));
  const category = (
    await db.client.query<{ categoryId: string; subcategoryId: string }>(
      `SELECT p.id AS "categoryId", c.id AS "subcategoryId" FROM app.finance_categories p JOIN app.finance_categories c ON c.parent_id = p.id WHERE p.kind = 'expense' AND p.status = 'active' AND c.status = 'active' ORDER BY p.sort_order, c.sort_order LIMIT 1`,
    )
  ).rows[0]!;
  main = await event(a, '2026-11-25T08:00:00Z');
  const catering = await tx((c) => addLine(c, o, main, { kind: 'catering', name: 'Торт', quantity: 1, unit: 'шт', priceKop: 1_000_000, planCostKop: 300_000 }, meta(o), clock));
  await tx((c) => recordEventIncome(c, o, main, { method: 'cash', amountKop: 400_000, occurredAt: '2026-10-20T04:00:00Z' }, meta(o), opts())); // предоплата в октябре
  const wrong = await tx((c) => recordEventIncome(c, o, main, { method: 'cash', amountKop: 99_000, occurredAt: '2026-11-10T04:00:00Z' }, meta(o), opts()));
  await tx((c) => reverseOperation(c, o, { operationId: wrong.id, reason: 'ошибка' }, meta(o), opts()));
  await tx((c) => addEventExpense(c, o, main, { method: 'cash', amountKop: 120_000, ...category, occurredAt: '2026-11-10T04:00:00Z', comment: 'аниматор' }, meta(o), opts()));
  const general = await tx((c) => recordExpense(c, o, { branchId: a, method: 'cash', amountKop: 80_000, ...category, occurredAt: '2026-11-10T04:00:00Z', comment: 'кейтеринг' }, meta(o), opts()));
  await tx((c) => linkEventExpense(c, o, main, { operationId: general.id, inCost: true, lineId: (catering as { id: string }).id }, meta(o), { clock }));
  await event(a, '2026-11-26T08:00:00Z'); // без брони и денег
  await event(a, '2026-10-26T08:00:00Z'); // другой месяц
  await event(b, '2026-11-25T08:00:00Z');
}, 120_000);
afterAll(async () => {
  await fx.close();
  await db.drop();
});

describe('показатели', () => {
  it('приёмка 10–11, предоплата прошлого месяца, привязанный вручную кейтеринг; суммы = карточка мероприятия', async () => {
    const r = await fx.run(fx.owner(), (env) => eventsReport(env, { period: NOV, branchIds: [a] }));
    const s = await eventMoneySummary(fx.app, main);
    expect(val(r.metrics.count)).toBe(2);
    expect(val(r.metrics.withoutBooking)).toBe(2);
    expect(val(r.metrics.received)).toBe(400_000);
    expect(val(r.metrics.factCost)).toBe(200_000);
    expect(val(r.metrics.plannedCost)).toBe(300_000);
    expect(val(r.metrics.deviation)).toBe(s.deviationKop);
    expect(val(r.metrics.result)).toBe(s.resultKop);
    expect(val(r.metrics.due)).toBe(s.dueKop);
    expect(r.groups.costStructure).toEqual([{ kind: 'catering', amountKop: 80_000 }, { kind: 'other', amountKop: 120_000 }]);
    expect(r.groups.byStatus).toEqual([{ status: 'new_request', count: 2 }]);
  });

  it('права: Администратор – нет отчёта; Директор зоны Б – филиал А 404, в его сумме только Б', async () => {
    await expect(fx.run(fx.admin([a]), (env) => eventsReport(env, { period: NOV }))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const dir = fx.director([b]);
    await expect(fx.run(dir, (env) => eventsReport(env, { period: NOV, branchIds: [a] }))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(val((await fx.run(dir, (env) => eventsReport(env, { period: NOV }))).metrics.count)).toBe(1);
  });
});

describe('TC-20: детализация = итог', () => {
  it('каждый показатель-количество и сумма', async () => {
    const ctx = fx.owner();
    const r = await fx.run(ctx, (env) => eventsReport(env, { period: NOV }));
    for (const [key, m] of Object.entries(r.metrics) as Array<[EventsMetric, Metric]>) {
      if (key === 'avgPrice' || m.state !== 'ok') continue;
      let cursor: string | undefined;
      let sum = 0;
      do {
        const page = await fx.run(ctx, (env) => eventsDetail(env, { period: NOV }, key, { cursor, limit: 1 }));
        sum += page.rows.reduce((s, x) => s + x.value, 0);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(sum, key).toBe(m.value);
    }
  });
});

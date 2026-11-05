// S4-69: сводный дашборд (K24 §3.1). Каждая карточка = значение своего отчёта при тех же фильтрах; карточки Э3 – source_not_ready;
// Администратор не получает денежных карточек; область Директора; прибыли в подписях нет.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { recordIncome } from '../../apps/api/src/modules/finance/cashbox.ts';
import { bookingsReport } from '../../apps/api/src/modules/reports/bookings.ts';
import { dashboard } from '../../apps/api/src/modules/reports/dashboard.ts';
import { financeReport } from '../../apps/api/src/modules/reports/finance.ts';
import { utilizationReport } from '../../apps/api/src/modules/reports/utilization.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';
import { d, reportFixtures, type Fx } from '../helpers/reports.ts';

const OCT = { from: d('2026-10-01'), to: d('2026-10-31') };
let db: TestDatabase;
let fx: Fx;
let b1: string;
let b2: string;

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  fx = await reportFixtures(db);
  b1 = (await fx.branch('Asia/Novosibirsk')).id;
  b2 = (await fx.branch('Europe/Moscow')).id;
  for (const [branch, n] of [[b1, 3], [b2, 1]] as const) {
    const u = await fx.unit(branch, 'pc');
    const res = await fx.resource(branch, 'pc', 'ПК', [u]);
    const client = await fx.client();
    for (let i = 0; i < n; i++) {
      const id = await fx.booking({ branchId: branch, clientId: client, resourceId: res, units: [u], start: `2026-10-${String(10 + i).padStart(2, '0')}T07:00:00Z`, createdAt: '2026-10-01T05:00:00Z' });
      await fx.visit(id);
    }
    await fx.booking({ branchId: branch, clientId: client, resourceId: res, start: '2026-10-20T07:00:00Z', status: 'cancelled_by_client', createdAt: '2026-10-01T05:00:00Z' });
    const o = fx.owner();
    const c: pg.PoolClient = await fx.app.connect();
    try {
      await c.query('BEGIN');
      await recordIncome(c, o, { branchId: branch, method: 'cash', amountKop: 10_000 * n, source: 'event', occurredAt: '2026-10-15T07:00:00Z' }, { actor: o.actor, access: o, source: 'crm', requestId: randomUUID() }, { idempotencyKey: randomUUID(), clock: fixedClock('2026-10-15T07:00:00Z') });
      await c.query('COMMIT');
    } finally {
      c.release();
    }
  }
}, 60_000);
afterAll(async () => {
  await fx.close();
  await db.drop();
});

describe('дашборд (S4-69)', () => {
  it('каждая карточка = значение своего отчёта при тех же фильтрах (сеть и филиал)', async () => {
    for (const filter of [{}, { branchIds: [b1] }]) {
      const p = { period: OCT, ...filter };
      const dash = await fx.run(fx.owner(), (env) => dashboard(env, p));
      const b = await fx.run(fx.owner(), (env) => bookingsReport(env, p));
      const u = await fx.run(fx.owner(), (env) => utilizationReport(env, p));
      const f = await fx.run(fx.owner(), (env) => financeReport(env, p));
      for (const card of dash.cards) {
        if (card.link.report === 'bookings') expect(card.metric, card.key).toEqual(b.metrics[card.link.metric as keyof typeof b.metrics]);
        if (card.link.report === 'utilization') expect(card.metric, card.key).toEqual(u.metrics[card.link.metric as keyof typeof u.metrics]);
        if (card.link.report === 'finance') expect(card.metric, card.key).toEqual(f.metrics[card.link.metric as keyof typeof f.metrics]);
      }
      const visited = dash.cards.find((c) => c.key === 'visited')!;
      expect(visited.metric).toMatchObject({ state: 'ok', value: 'branchIds' in filter ? 3 : 4 });
      expect(dash.dayRule).toContain('филиала');
    }
  });

  it('карточки Э3 – source_not_ready, с подписью; ни в одной нет слова «прибыль»', async () => {
    const dash = await fx.run(fx.owner(), (env) => dashboard(env, { period: OCT }));
    for (const key of ['eventsCount', 'openFaults', 'downtime']) {
      const card = dash.cards.find((c) => c.key === key)!;
      expect(card.metric).toEqual({ state: 'unavailable', reason: 'source_not_ready' });
      expect(card.note).toContain('Появится');
    }
    expect(JSON.stringify(dash.cards).toLowerCase()).not.toContain('прибыль');
    expect(dash.cards.find((c) => c.key === 'incomeEvent')!.metric).toMatchObject({ value: 40_000 });
    expect(dash.cards.find((c) => c.key === 'cashClosing')!.metric).toMatchObject({ state: 'ok', value: 40_000 });
  });

  it('Администратор: операционные карточки своего филиала, денежных нет; неисправности – есть, мероприятий нет', async () => {
    const dash = await fx.run(fx.admin([b1]), (env) => dashboard(env, { period: OCT }));
    const keys = dash.cards.map((c) => c.key);
    expect(keys).toEqual(expect.arrayContaining(['created', 'visited', 'noShows', 'actualLoad', 'openFaults', 'downtime']));
    for (const money of ['incomeSession', 'incomeEvent', 'incomeCertificateSale', 'refunds', 'expenses', 'netMovement', 'cashClosing', 'eventsCount']) expect(keys, money).not.toContain(money);
    expect(dash.cards.find((c) => c.key === 'visited')!.metric).toMatchObject({ value: 3 });
    await expect(fx.run(fx.admin([b1]), (env) => dashboard(env, { period: OCT, branchIds: [b2] }))).rejects.toMatchObject({ httpStatus: 404 });
  });

  it('Директор зоны: деньги своей зоны; сеть сужена; чужой филиал – 404', async () => {
    const dash = await fx.run(fx.director([b2]), (env) => dashboard(env, { period: OCT }));
    expect(dash.cards.find((c) => c.key === 'incomeEvent')!.metric).toMatchObject({ value: 10_000 });
    expect(dash.cards.find((c) => c.key === 'visited')!.metric).toMatchObject({ value: 1 });
    await expect(fx.run(fx.director([b2]), (env) => dashboard(env, { period: OCT, branchIds: [b1] }))).rejects.toMatchObject({ httpStatus: 404 });
  });
});

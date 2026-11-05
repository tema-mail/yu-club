// S4-63: отчёт «Бронирования и посещаемость» (K24 §3.2). Приёмка 14 п.3 (дата события, не создания), п.4 (брони, посещения,
// отмены, неявки раздельно), п.12 (гость – в посещаемости, не в уникальных); перенос – по дате переноса; «ожидают решения» = K11 №3;
// сумма детализации = итог по каждому показателю; маска клиента в детализации.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bookingsDefs, bookingsDetail, bookingsReport, type BookingsMetric, type BookingsParams } from '../../apps/api/src/modules/reports/bookings.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';
import { d, reportFixtures, type Fx } from '../helpers/reports.ts';

let db: TestDatabase;
let fx: Fx;
let nsk: string;
let msk: string;
let pc: string;
let pcMsk: string;
let ivan: string;
let guest: string;
const ids: Record<string, string> = {};
const OCT = { from: d('2026-10-01'), to: d('2026-10-31') };

const value = (m: { state: string; value?: number } | undefined) => (m?.state === 'ok' ? m.value : m?.state);

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  fx = await reportFixtures(db);
  nsk = (await fx.branch('Asia/Novosibirsk')).id;
  msk = (await fx.branch('Europe/Moscow')).id;
  pc = await fx.resource(nsk, 'pc', 'ПК-1', []);
  pcMsk = await fx.resource(msk, 'pc', 'ПК-М', []);
  ivan = await fx.client({ firstName: 'Иван', lastName: 'Петров' });
  guest = await fx.client({ guest: true });

  // посещение 31.10 23:30 по НСК = 16:30 UTC = 19:30 МСК – октябрь у филиала НСК
  ids.late = await fx.booking({ branchId: nsk, clientId: ivan, resourceId: pc, start: '2026-10-31T16:30:00Z', createdAt: '2026-10-20T05:00:00Z' });
  await fx.visit(ids.late);
  // создана 30.09, сеанс 01.10: «создано» в сентябре, «запланировано» в октябре
  ids.cross = await fx.booking({ branchId: nsk, clientId: ivan, resourceId: pc, start: '2026-10-01T05:00:00Z', createdAt: '2026-09-30T05:00:00Z' });
  await fx.visit(ids.cross);
  // гость состоялся
  ids.guest = await fx.booking({ branchId: nsk, clientId: guest, resourceId: pc, start: '2026-10-05T05:00:00Z', createdAt: '2026-10-04T05:00:00Z' });
  await fx.visit(ids.guest);
  // отмены: клиентом и клубом; отмена в ноябре сеанса в октябре – относится к октябрю
  ids.cxClient = await fx.booking({ branchId: nsk, clientId: ivan, resourceId: pc, start: '2026-10-06T05:00:00Z', status: 'cancelled_by_client', createdAt: '2026-10-01T05:00:00Z', cancelledAt: '2026-11-02T05:00:00Z' });
  ids.cxClub = await fx.booking({ branchId: nsk, clientId: guest, resourceId: pc, start: '2026-10-07T05:00:00Z', status: 'cancelled_by_club', createdAt: '2026-10-01T05:00:00Z' });
  // неявка явная; и подтверждённая прошедшая без отметки – «ожидает решения», не неявка
  ids.noshow = await fx.booking({ branchId: nsk, clientId: ivan, resourceId: pc, start: '2026-10-08T05:00:00Z', status: 'no_show', createdAt: '2026-10-01T05:00:00Z' });
  await fx.noShow(ids.noshow);
  ids.pending = await fx.booking({ branchId: nsk, clientId: ivan, resourceId: pc, start: '2026-10-09T05:00:00Z', status: 'confirmed', createdAt: '2026-10-01T05:00:00Z' });
  // перенос: версия создана в октябре, сеанс уехал в декабрь
  ids.moved = await fx.booking({ branchId: nsk, clientId: ivan, resourceId: pc, start: '2026-10-10T05:00:00Z', status: 'confirmed', createdAt: '2026-10-01T05:00:00Z' });
  await fx.reschedule(ids.moved, '2026-12-10T05:00:00Z', '2026-12-10T06:00:00Z', '2026-10-09T10:00:00Z');
  // второй перенос той же брони в том же периоде – всё равно одна бронь
  await fx.reschedule(ids.moved, '2026-12-11T05:00:00Z', '2026-12-11T06:00:00Z', '2026-10-12T10:00:00Z');
  // прошлый период: сентябрь
  ids.sep = await fx.booking({ branchId: nsk, clientId: ivan, resourceId: pc, start: '2026-09-15T05:00:00Z', createdAt: '2026-09-14T05:00:00Z' });
  await fx.visit(ids.sep);
  // другой филиал
  ids.msk = await fx.booking({ branchId: msk, clientId: ivan, resourceId: pcMsk, start: '2026-10-15T10:00:00Z', createdAt: '2026-10-14T10:00:00Z' });
  await fx.visit(ids.msk);
}, 60_000);
afterAll(async () => {
  await fx.close();
  await db.drop();
});

describe('показатели (S4-63)', () => {
  it('приёмка 3 и 4: дата события, брони, посещения, отмены и неявки раздельно; прошлый период', async () => {
    const r = await fx.run(fx.owner(), (env) => bookingsReport(env, { period: OCT, branchIds: [nsk] }));
    const m = r.metrics;
    expect(value(m.created)).toBe(7); // late, guest, cxClient, cxClub, noshow, pending, moved (cross создана в сентябре)
    expect(value(m.planned)).toBe(5); // late, cross, guest, noshow, pending; moved уехал в декабрь, отмены не входят
    expect(value(m.visited)).toBe(3); // late, cross, guest
    expect(value(m.cancelledByClient)).toBe(1);
    expect(value(m.cancelledByClub)).toBe(1);
    expect(value(m.noShows)).toBe(1);
    expect(value(m.rescheduled)).toBe(1);
    expect(value(m.awaitingDecision)).toBe(1); // pending; moved ещё не прошла
    expect(value(m.avgMinutes)).toBe(60);
    expect(r.dateBasis.created).toBe('created_at');
    expect(r.dateBasis.planned).toBe('session_start');
    expect(r.dateBasis.rescheduled).toBe('rescheduled_at');
    expect(r.computedAt).toBe('2026-11-20T05:00:00.000Z');
    expect(r.dayRule).toContain('филиала');
    // сентябрь: одно посещение (sep) и созданные cross, sep; «ожидают решения» прошлого значения не имеет
    expect(m.visited).toMatchObject({ prev: 1, deltaAbs: 2, deltaPct: 200 });
    expect(m.created).toMatchObject({ prev: 2 });
    expect(m.awaitingDecision).toMatchObject({ prev: null, deltaPct: null });
    const sep = await fx.run(fx.owner(), (env) => bookingsReport(env, { period: { from: d('2026-09-01'), to: d('2026-09-30') }, branchIds: [nsk] }));
    expect(value(sep.metrics.created)).toBe(2);
    expect(value(sep.metrics.planned)).toBe(1);
  });

  it('приёмка 12: гость – в «состоялось», не в уникальных; сеть – сумма филиалов', async () => {
    const r = await fx.run(fx.owner(), (env) => bookingsReport(env, { period: OCT, branchIds: [nsk] }));
    expect(value(r.metrics.visited)).toBe(3);
    expect(value(r.metrics.uniqueVisitors)).toBe(1); // только Иван
    const net = await fx.run(fx.owner(), (env) => bookingsReport(env, { period: OCT }));
    expect(value(net.metrics.visited)).toBe(4);
    expect(value(net.metrics.uniqueVisitors)).toBe(1); // один человек в двух филиалах
  });

  it('фильтры: статус, клиент, инициатор отмены, наличие оплаты – и в связанных представлениях', async () => {
    const run = (extra: Partial<BookingsParams>) => fx.run(fx.owner(), (env) => bookingsReport(env, { period: OCT, branchIds: [nsk], ...extra }));
    expect(value((await run({ clientId: guest })).metrics.visited)).toBe(1);
    expect(value((await run({ status: ['no_show'] })).metrics.noShows)).toBe(1);
    expect(value((await run({ status: ['completed'] })).metrics.noShows)).toBe(0);
    expect(value((await run({ cancelledBy: 'club' })).metrics.cancelledByClub)).toBe(1);
    expect(value((await run({ cancelledBy: 'client' })).metrics.cancelledByClub)).toBe(0);
    expect(value((await run({ paid: true })).metrics.visited)).toBe('no_data'); // под фильтром нет ни одной записи – весь отчёт пуст
    expect(value((await run({ paid: false })).metrics.visited)).toBe(3);
    expect(value((await run({ resourceType: ['vr_seat'] })).metrics.created)).toBe('no_data');
  });

  it('пустой филиал – no_data; Директор зоны: чужой филиал – 404, сеть сужается до своей зоны', async () => {
    const empty = (await fx.branch('Europe/Kaliningrad')).id;
    expect((await fx.run(fx.owner(), (env) => bookingsReport(env, { period: OCT, branchIds: [empty] }))).metrics.visited).toEqual({ state: 'no_data' });
    const dir = fx.director([msk]);
    await expect(fx.run(dir, (env) => bookingsReport(env, { period: OCT, branchIds: [nsk] }))).rejects.toMatchObject({ httpStatus: 404 });
    expect(value((await fx.run(dir, (env) => bookingsReport(env, { period: OCT }))).metrics.visited)).toBe(1);
  });
});

describe('детализация = итог', () => {
  it('каждый показатель: строки всех страниц совпадают с итогом, условие то же', async () => {
    const p: BookingsParams = { period: OCT };
    const keys = Object.keys(bookingsDefs(p)) as BookingsMetric[];
    const report = await fx.run(fx.owner(), (env) => bookingsReport(env, p));
    for (const key of keys) {
      const rows = [];
      let cursor: string | undefined;
      let total;
      do {
        const page = await fx.run(fx.owner(), (env) => bookingsDetail(env, p, key, { limit: 2, ...(cursor ? { cursor } : {}) }));
        rows.push(...page.rows);
        cursor = page.nextCursor ?? undefined;
        total = page.total;
      } while (cursor);
      const shown = report.metrics[key];
      expect(shown.state, key).toBe('ok');
      expect(value(total), key).toBe(value(shown));
      if (key === 'avgMinutes') expect(rows.reduce((s, r) => s + r.metricValue!, 0) / rows.length).toBe(value(shown));
      else expect(rows.length, key).toBe(value(shown));
    }
  });

  it('строка: дата и время по филиалу, маска клиента без права, причина, оплата; неизвестный показатель – ошибка', async () => {
    const adm = fx.admin([nsk]);
    const page = await fx.run(adm, (env) => bookingsDetail(env, { period: OCT, branchIds: [nsk] }, 'visited'));
    const late = page.rows.find((r) => r.bookingId === ids.late)!;
    expect(late.startLocal).toContain('23:30');
    expect(late.client).toMatchObject({ name: 'Иван П.', kind: 'profile' });
    expect(late.client!.phone).toContain('•');
    expect(late.payment).toEqual({ state: 'unpaid', methods: [], paidKop: 0 });
    expect(late.resourceName).toBe('ПК-1');
    const full = await fx.run(fx.owner(), (env) => bookingsDetail(env, { period: OCT, branchIds: [nsk] }, 'visited'));
    expect(full.rows.find((r) => r.bookingId === ids.late)!.client).toMatchObject({ name: 'Иван Петров' });
    expect(full.rows.find((r) => r.bookingId === ids.guest)!.client).toMatchObject({ kind: 'guest', name: null });
    await expect(fx.run(fx.owner(), (env) => bookingsDetail(env, { period: OCT }, 'нет такого'))).rejects.toMatchObject({ code: 'REPORT_FILTER_INVALID' });
  });
});

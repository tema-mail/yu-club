// S4-62: каркас отчётов (K24 §2, §6, §9). Свойство Σ detail = aggregate на случайных фильтрах (филиалы Москва, НСК, Калининград);
// сутки филиала; база 0 → deltaPct = null; пустой филиал → no_data; pg_sleep дольше тайм-аута → REPORT_TIMEOUT, а параллельная
// оплата K10 проходит при исчерпанном пуле отчётов; маска ПДн на сервере; область: чужой филиал – 404.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { AppError } from '../../apps/api/src/core/errors.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import { fixedClock, type LocalDate } from '../../apps/api/src/core/time.ts';
import { bookingLookup, paymentBookingProvider } from '../../apps/api/src/modules/booking/providers.ts';
import { recordPayment, type PaymentDeps } from '../../apps/api/src/modules/finance/payment.ts';
import {
  aggregate, computeMetrics, createReportsPool, detailPage, loadMaskedClients, okMetric, parsePeriod, prevPeriod, resolveBranches, where, windowsOf, withReportTx, type MetricDef,
} from '../../apps/api/src/modules/reports/framework.ts';
import { createTestBranch } from '../helpers/network.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const clock = fixedClock('2026-11-20T05:00:00Z');
let db: TestDatabase;
let app: pg.Pool;
let reports: pg.Pool;
let ownerId: string;
const branches: Record<string, { id: string; cityId: string }> = {};
const clients: string[] = [];
const resources: Record<string, string> = {};

const owner = (): AccessContext => ({ actor: { kind: 'staff', staffId: ownerId, sessionId: randomUUID() }, role: 'owner', network: true, cityIds: new Set(), branchIds: new Set(), at: clock.now() });
const director = (ids: string[]): AccessContext => ({ ...owner(), role: 'director', network: false, branchIds: new Set(ids) });
const adminOf = (ids: string[]): AccessContext => ({ ...owner(), role: 'admin', network: false, branchIds: new Set(ids) });
const d = (s: string) => s as LocalDate;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function booking(branch: string, client: string, startIso: string, opts: { status?: string; price?: number; created?: string } = {}): Promise<string> {
  const start = new Date(startIso);
  const status = opts.status ?? 'completed';
  const cancelled = status.startsWith('cancelled');
  const r = await db.client.query<{ id: string }>(
    `INSERT INTO app.bookings (checkout_id, branch_id, client_id, resource_id, period, price_kop, source, created_by_type, status, created_at, cancelled_at, cancel_comment)
     VALUES (gen_random_uuid(), $1, $2, $3, tstzrange($4, $5, '[)'), $6, 'crm', 'staff', $7, $8, $9, $10) RETURNING id`,
    [branch, client, resources[branch], start, new Date(start.getTime() + 3_600_000), opts.price ?? 10_000, status, opts.created ?? startIso, cancelled ? start : null, cancelled ? 'т' : null],
  );
  await db.client.query(
    `INSERT INTO journal.booking_versions (booking_id, version, resource_id, period, branch_timezone, unit_ids, resource_snapshot, price_kop, price_snapshot, created_by_type)
     VALUES ($1, 1, $2, tstzrange($3, $4, '[)'), 'UTC', ARRAY[gen_random_uuid()], '{"name":"ПК"}', $5, '{}', 'staff')`,
    [r.rows[0]!.id, resources[branch], start, new Date(start.getTime() + 3_600_000), opts.price ?? 10_000],
  );
  return r.rows[0]!.id;
}

const created = (conds: MetricDef['spec']['conds'] = []): MetricDef => ({ spec: { view: 'app.rpt_bookings', date: 'created_at', conds }, agg: 'count', unit: 'count', dateBasis: 'created_at', idCol: 'booking_id' });
const sumPrice = (conds: MetricDef['spec']['conds'] = []): MetricDef => ({ spec: { view: 'app.rpt_bookings', date: 'start_at', conds }, agg: 'sum', col: 'price_kop', unit: 'kop', dateBasis: 'session_start', idCol: 'booking_id' });
const uniqClients: MetricDef = { spec: { view: 'app.rpt_bookings', date: 'start_at' }, agg: 'count_distinct', col: 'client_id', unit: 'count', dateBasis: 'session_start', idCol: 'booking_id' };

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  app = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 6 });
  reports = createReportsPool(db.reportsUrl);
  ownerId = (await db.client.query<{ id: string }>(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('В', 'В', $1, 'owner', 'x') RETURNING id`, [`${randomUUID()}@club.ru`])).rows[0]!.id;
  for (const [key, tz] of [['msk', 'Europe/Moscow'], ['nsk', 'Asia/Novosibirsk'], ['kgd', 'Europe/Kaliningrad'], ['empty', 'Asia/Novosibirsk']] as const) {
    branches[key] = await createTestBranch(db.client, { timezone: tz });
    resources[branches[key]!.id] = (await db.client.query<{ id: string }>(`INSERT INTO app.resources (branch_id, resource_type, name) VALUES ($1, 'pc', 'ПК') RETURNING id`, [branches[key]!.id])).rows[0]!.id;
  }
  for (let i = 0; i < 6; i++) {
    clients.push((await db.client.query<{ id: string }>(`INSERT INTO app.clients (phone_e164, first_name, last_name, status, created_by_type, registered_at) VALUES ($1, 'Иван', 'Петров', 'active', 'system', now()) RETURNING id`, [`+7913000${String(1000 + i)}`])).rows[0]!.id);
  }
  const r = rng(11);
  const statuses = ['completed', 'confirmed', 'cancelled_by_client', 'no_show', 'arrived'];
  const keys = ['msk', 'nsk', 'kgd'] as const;
  for (let i = 0; i < 220; i++) {
    const at = new Date(Date.UTC(2026, 9, 1) + Math.floor(r() * 61) * 86_400_000 + Math.floor(r() * 24) * 3_600_000 + i * 60_000);
    await booking(branches[keys[i % 3]!]!.id, clients[Math.floor(r() * clients.length)]!, at.toISOString(), { status: statuses[Math.floor(r() * statuses.length)]!, price: 1000 + Math.floor(r() * 100_000) });
  }
}, 60_000);
afterAll(async () => {
  await reports.end();
  await app.end();
  await db.drop();
});

describe('свойство Σ detail = aggregate (TC-20)', () => {
  it('случайные филиалы, статусы и периоды: все страницы детализации = итог; count, sum, count_distinct', async () => {
    const r = rng(5);
    const all = ['msk', 'nsk', 'kgd', 'empty'] as const;
    for (let i = 0; i < 12; i++) {
      const picked = all.filter(() => r() < 0.7);
      const from = 1 + Math.floor(r() * 25);
      const p = { from: d(`2026-10-${String(from).padStart(2, '0')}`), to: d(`2026-11-${String(1 + Math.floor(r() * 25)).padStart(2, '0')}`) };
      const st = ['completed', 'no_show', 'arrived', 'confirmed'].filter(() => r() < 0.5);
      const conds = st.length ? [{ sql: 'status = ANY(?::text[])', values: [st] }] : [];
      await withReportTx(reports, async (tx) => {
        const bs = await resolveBranches(tx, owner(), 'reports.ops.view', { branchIds: picked.map((k) => branches[k]!.id) });
        const w = windowsOf(picked.length ? bs : [], p);
        for (const def of [created(conds), sumPrice(conds), uniqClients]) {
          const agg = await aggregate(tx, def, w);
          let cursor: string | undefined;
          let rows: Array<Record<string, unknown>> = [];
          let pages = 0;
          do {
            const page = await detailPage<Record<string, unknown>>(tx, def, w, { limit: 17, ...(cursor ? { cursor } : {}) });
            expect(page.total).toEqual(agg);
            rows = rows.concat(page.rows);
            cursor = page.nextCursor ?? undefined;
            pages++;
            expect(pages).toBeLessThan(50);
          } while (cursor);
          if (def.agg === 'sum') expect(rows.reduce((s, x) => s + Number(x[def.col!]), 0)).toBe(agg.value);
          else expect(rows.length).toBe(agg.value);
          if (def.agg !== 'count_distinct') expect(new Set(rows.map((x) => x.booking_id)).size).toBe(rows.length);
        }
      });
    }
  });

  it('where не склеивает условия мимо параметров: значение идёт параметром, чужой источник отвергается', () => {
    const w = where({ view: 'app.rpt_bookings', conds: [{ sql: 'status = ?', values: ["x' OR 1=1 --"] }] }, []);
    expect(w.sql).toContain('(status = $4)');
    expect(w.params[3]).toBe("x' OR 1=1 --");
    expect(() => where({ view: 'app.bookings' }, [])).toThrow(/rpt_/);
  });
});

describe('период и сутки', () => {
  it('сеанс 31.08 23:30 по НСК (19:30 МСК) – в августе у филиала НСК; создание и сеанс – каждый по своей дате', async () => {
    const nsk = branches.nsk!.id;
    const b = await booking(nsk, clients[0]!, '2026-08-31T16:30:00Z', { created: '2026-08-30T10:00:00Z' }); // 31.08 23:30 НСК
    await withReportTx(reports, async (tx) => {
      const bs = await resolveBranches(tx, owner(), 'reports.ops.view', { branchIds: [nsk] });
      const aug = windowsOf(bs, { from: d('2026-08-01'), to: d('2026-08-31') });
      const sep = windowsOf(bs, { from: d('2026-09-01'), to: d('2026-09-30') });
      const idCond = [{ sql: 'booking_id = ?', values: [b] }];
      expect((await aggregate(tx, sumPrice(idCond), aug)).rows).toBe(1);
      expect((await aggregate(tx, sumPrice(idCond), sep)).rows).toBe(0);
      expect((await aggregate(tx, created(idCond), windowsOf(bs, { from: d('2026-08-30'), to: d('2026-08-30') }))).rows).toBe(1);
      expect((await aggregate(tx, created(idCond), windowsOf(bs, { from: d('2026-08-31'), to: d('2026-08-31') }))).rows).toBe(0);
    });
  });

  it('прошлый период: календарный месяц – прошлый месяц, неделя и произвольный – той же длины; ошибки периода', () => {
    expect(prevPeriod({ from: d('2026-03-01'), to: d('2026-03-31') })).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(prevPeriod({ from: d('2026-11-09'), to: d('2026-11-15') })).toEqual({ from: '2026-11-02', to: '2026-11-08' });
    expect(prevPeriod({ from: d('2026-03-10'), to: d('2026-03-12') })).toEqual({ from: '2026-03-07', to: '2026-03-09' });
    const err = (input: { from: unknown; to: unknown }, maxDays?: number) => {
      try {
        parsePeriod(input, { clock, ...(maxDays ? { maxDays } : {}) });
        return null;
      } catch (e) {
        return e as AppError;
      }
    };
    expect(err({ from: '2026-11-02', to: '2026-11-01' })?.code).toBe('REPORT_PERIOD_INVALID');
    expect(err({ from: 'вчера', to: '2026-11-01' })?.code).toBe('REPORT_PERIOD_INVALID');
    expect(err({ from: '2026-11-01', to: '2028-11-01' })?.code).toBe('REPORT_PERIOD_INVALID');
    expect(err({ from: '2026-01-01', to: '2026-06-01' }, 92)).toMatchObject({ code: 'REPORT_PERIOD_TOO_LONG', details: { useExport: true } });
    expect(err({ from: '2026-10-01', to: '2026-10-31' }, 92)).toBeNull();
  });
});

describe('Metric: три пустых состояния', () => {
  it('база 0 → deltaPct = null; пустой филиал → no_data; живой отчёт с пустым показателем → 0', async () => {
    expect(okMetric(5, 'count', 0)).toMatchObject({ value: 5, deltaAbs: 5, deltaPct: null });
    expect(okMetric(150, 'kop', 100)).toMatchObject({ deltaAbs: 50, deltaPct: 50 });
    expect(okMetric(5, 'count')).toMatchObject({ prev: null, deltaPct: null });
    await withReportTx(reports, async (tx) => {
      const empty = await resolveBranches(tx, owner(), 'reports.ops.view', { branchIds: [branches.empty!.id] });
      const p = { from: d('2026-10-01'), to: d('2026-10-31') };
      const none = await computeMetrics(tx, { a: created() }, windowsOf(empty, p), windowsOf(empty, prevPeriod(p)));
      expect(none.a).toEqual({ state: 'no_data' });
      const live = await resolveBranches(tx, owner(), 'reports.ops.view', { branchIds: [branches.msk!.id] });
      const m = await computeMetrics(
        tx,
        { all: created(), never: created([{ sql: 'status = ?', values: ['нет такого'] }]), avg: { ...sumPrice([{ sql: 'status = ?', values: ['нет такого'] }]), agg: 'avg' as const } },
        windowsOf(live, p),
        windowsOf(live, prevPeriod(p)),
      );
      expect(m.all).toMatchObject({ state: 'ok', prev: null });
      expect(m.never).toMatchObject({ state: 'ok', value: 0 });
      expect(m.avg).toEqual({ state: 'no_data' });
    });
  });
});

describe('область и маска', () => {
  it('Директор зоны: чужой филиал и город – 404; вся сеть сужается до зоны; нет права – FORBIDDEN', async () => {
    await withReportTx(reports, async (tx) => {
      const dir = director([branches.nsk!.id]);
      await expect(resolveBranches(tx, dir, 'reports.finance.view', { branchIds: [branches.msk!.id] })).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
      await expect(resolveBranches(tx, dir, 'reports.finance.view', { cityId: branches.msk!.cityId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect((await resolveBranches(tx, dir, 'reports.finance.view')).map((b) => b.id)).toEqual([branches.nsk!.id]);
      await expect(resolveBranches(tx, adminOf([branches.nsk!.id]), 'reports.finance.view')).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(await resolveBranches(tx, director([]), 'reports.ops.view')).toEqual([]);
      await expect(resolveBranches(tx, owner(), 'reports.ops.view', { branchIds: ['не-uuid'] })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  it('без client.view.full – «Иван П.» и маска; с правом на своём филиале – полное имя и телефон; в чужом филиале – маска', async () => {
    const nsk = branches.nsk!.id;
    const msk = branches.msk!.id;
    const rows = [{ clientId: clients[0]!, branchId: nsk }, { clientId: clients[0]!, branchId: msk }];
    const a = await loadMaskedClients(app, adminOf([nsk]), rows);
    expect(a.get(`${clients[0]}:${nsk}`)).toEqual({ id: clients[0], kind: 'profile', name: 'Иван П.', phone: '+7 ••• ••• ••-00' });
    const dd = await loadMaskedClients(app, director([nsk]), rows);
    expect(dd.get(`${clients[0]}:${nsk}`)).toMatchObject({ name: 'Иван Петров', phone: '+79130001000' });
    expect(dd.get(`${clients[0]}:${msk}`)).toMatchObject({ name: 'Иван П.', phone: '+7 ••• ••• ••-00' });
  });
});

describe('пул yu_reports и изоляция (17 §6)', () => {
  it('в снимке только чтение, роль – yu_reports; снимок один на отчёт', async () => {
    await withReportTx(reports, async (tx) => {
      expect((await tx.query(`SELECT current_user AS u`)).rows[0]!.u).toBe('yu_reports');
      expect((await tx.query(`SHOW transaction_isolation`)).rows[0]!.transaction_isolation).toBe('repeatable read');
      expect((await tx.query(`SHOW transaction_read_only`)).rows[0]!.transaction_read_only).toBe('on');
      const before = (await tx.query(`SELECT count(*)::int AS n FROM app.rpt_bookings`)).rows[0]!.n;
      await booking(branches.msk!.id, clients[1]!, '2026-07-01T10:00:00Z');
      expect((await tx.query(`SELECT count(*)::int AS n FROM app.rpt_bookings`)).rows[0]!.n).toBe(before);
    });
  });

  it('pg_sleep дольше тайм-аута → REPORT_TIMEOUT; пул отчётов занят целиком, оплата K10 в основном пуле проходит', async () => {
    const nsk = branches.nsk!.id;
    const paid = await booking(nsk, clients[2]!, '2026-11-19T04:00:00Z', { status: 'arrived', price: 30_000 });
    const sleepers = Array.from({ length: 3 }, () => withReportTx(reports, (tx) => tx.query('SELECT pg_sleep(5)'), { timeoutMs: 700 }));
    await new Promise((r) => setTimeout(r, 150)); // все три соединения заняты
    expect(reports.waitingCount + reports.totalCount).toBeGreaterThanOrEqual(3);
    const bookings: PaymentDeps['bookings'] = { facts: (t, id) => bookingLookup.facts(t, id), payableBooking: (t, id) => paymentBookingProvider.payableBooking(t, id) };
    const c = await app.connect();
    const started = Date.now();
    try {
      await c.query('BEGIN');
      const meta: AuditRequestMeta = { actor: owner().actor, access: owner(), source: 'crm', requestId: randomUUID() };
      const r = await recordPayment(c, owner(), { bookingId: paid, lines: [{ method: 'cash', amountKop: 30_000 }] }, meta, { bookings, clock });
      await c.query('COMMIT');
      expect(r.session.status).toBe('paid');
    } finally {
      c.release();
    }
    expect(Date.now() - started).toBeLessThan(600); // оплата не ждала отчёты
    const results = await Promise.allSettled(sleepers);
    for (const s of results) {
      expect(s.status).toBe('rejected');
      expect((s as PromiseRejectedResult).reason).toMatchObject({ code: 'REPORT_TIMEOUT', httpStatus: 504 });
    }
    // деньги видны в представлении платежей отчётов
    const pay = await withReportTx(reports, (tx) => tx.query(`SELECT method, amount_kop::int AS a FROM app.rpt_payments WHERE booking_id = $1`, [paid]));
    expect(pay.rows).toEqual([{ method: 'cash', a: 30_000 }]);
  });
});

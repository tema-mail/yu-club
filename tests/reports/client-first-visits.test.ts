// S4-131, 0442 (D5-11): первое посещение пары клиент × филиал. Агрегат пишут триггеры (вставка, в том числе пачкой; отмена отметки;
// перенос брони с посещением) и он = группировке живых посещений; строки отчёта клиентов = прежнему расчёту перебором всей истории
// посещений (оракул – прежний SQL) для сети, зоны и разбивки по филиалам; планы показателей клиентов – без полного просмотра visits и bookings.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import type { Tx } from '../../apps/api/src/core/audit.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { clientStatRows, clientsReport, type StatRow } from '../../apps/api/src/modules/reports/clients.ts';
import { getBranches } from '../../apps/api/src/modules/network/index.ts';
import { prevPeriod, windowsOf, withReportTx, type BranchWindow, type Period } from '../../apps/api/src/modules/reports/framework.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';
import { d, reportFixtures, SYS, type Fx } from '../helpers/reports.ts';

const OCT: Period = { from: d('2026-10-01'), to: d('2026-10-31') };
let db: TestDatabase;
let fx: Fx;
let b1: string;
let b2: string;

/** Прежний расчёт (до 0442): вся история посещений профилей сети. Оракул сверки. */
const ORACLE = (perBranch: boolean) => `WITH w AS (SELECT * FROM unnest($1::uuid[], $2::timestamptz[], $3::timestamptz[]) AS x(branch_id, s, e)),
  v AS (SELECT client_id, branch_id, planned_start FROM app.rpt_visits WHERE client_kind = 'profile'),
  h AS (SELECT client_id, min(planned_start) AS first_at, count(*) AS total FROM v GROUP BY client_id),
  s AS (
    SELECT v.client_id, ${perBranch ? 'v.branch_id::text' : 'min(v.branch_id::text)'} AS branch_id,
           count(*) FILTER (WHERE v.planned_start >= w.s AND v.planned_start < w.e) AS n,
           min(w.s) FILTER (WHERE v.planned_start >= w.s AND v.planned_start < w.e) AS window_start,
           bool_or(v.planned_start < w.s) AS had_prior
    FROM v JOIN w ON w.branch_id = v.branch_id GROUP BY v.client_id${perBranch ? ', v.branch_id' : ''}
  )
  SELECT s.client_id, s.branch_id, s.n, h.first_at, h.total, s.window_start, s.had_prior
  FROM s JOIN h ON h.client_id = s.client_id ORDER BY ${perBranch ? 's.branch_id, ' : ''}s.client_id`;

const norm = (rows: StatRow[]) => rows.map((r) => ({ ...r, n: Number(r.n), total: Number(r.total), first_at: r.first_at.toISOString(), window_start: r.window_start?.toISOString() ?? null }));

async function windows(ids: string[], p: Period): Promise<BranchWindow[]> {
  return windowsOf([...(await getBranches(db.client, ids)).values()].sort((a, b) => a.id.localeCompare(b.id)), p);
}

/** Агрегат = группировка живых посещений по паре (то, что пересчитал бы бэкфил 0442). */
async function aggregateMatchesVisits(): Promise<void> {
  const agg = await db.client.query(`SELECT client_id, branch_id, first_visit_at, visits_count FROM app.client_first_visits ORDER BY 1, 2`);
  const truth = await db.client.query(
    `SELECT v.client_id, v.branch_id, min(lower(b.period)) AS first_visit_at, count(*)::int AS visits_count
     FROM app.visits v JOIN app.bookings b ON b.id = v.booking_id WHERE v.status = 'active' GROUP BY 1, 2 ORDER BY 1, 2`,
  );
  expect(agg.rows).toEqual(truth.rows);
}

const c: Record<string, string> = {};
let r1: string;
let r2: string;

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  fx = await reportFixtures(db);
  b1 = (await fx.branch('Asia/Novosibirsk')).id;
  b2 = (await fx.branch('Europe/Moscow')).id;
  r1 = await fx.resource(b1, 'pc', 'ПК1', []);
  r2 = await fx.resource(b2, 'pc', 'ПК2', []);
  for (const k of ['old', 'fresh', 'lost', 'later', 'cross', 'reverted', 'moved', 'edge']) c[k] = await fx.client({ firstName: k, lastName: 'Клиент' });
  c.guest = await fx.client({ guest: true });
  const visit = async (branch: string, res: string, client: string, start: string) => fx.visit(await fx.booking({ branchId: branch, clientId: client, resourceId: res, start, createdAt: start }));
  await visit(b1, r1, c.old!, '2026-09-10T05:00:00Z');
  await visit(b1, r1, c.old!, '2026-10-05T05:00:00Z');
  await visit(b2, r2, c.old!, '2026-10-15T05:00:00Z');
  await visit(b1, r1, c.fresh!, '2026-10-06T05:00:00Z');
  await visit(b1, r1, c.lost!, '2026-09-20T05:00:00Z');
  await visit(b1, r1, c.later!, '2026-11-03T05:00:00Z'); // только после периода – ни в одном показателе
  await visit(b2, r2, c.cross!, '2026-08-01T05:00:00Z'); // первое в сети – в b2, в b1 впервые в октябре: в зоне b1 «вернувшийся»
  await visit(b1, r1, c.cross!, '2026-10-20T05:00:00Z');
  await visit(b1, r1, c.guest!, '2026-10-07T05:00:00Z');
  // у границы суток НСК: 1 октября 00:00 по НСК = 30.09 17:00Z – в периоде; минутой раньше – до периода
  await visit(b1, r1, c.edge!, '2026-09-30T16:59:00Z');
  await visit(b1, r1, c.edge!, '2026-09-30T17:00:00Z');
  // пачка одним оператором: триггер на оператор группирует пары
  const ids = [
    await fx.booking({ branchId: b1, clientId: c.reverted!, resourceId: r1, start: '2026-09-01T05:00:00Z' }),
    await fx.booking({ branchId: b1, clientId: c.reverted!, resourceId: r1, start: '2026-10-10T05:00:00Z' }),
    await fx.booking({ branchId: b2, clientId: c.moved!, resourceId: r2, start: '2026-10-25T05:00:00Z' }),
    await fx.booking({ branchId: b2, clientId: c.moved!, resourceId: r2, start: '2026-11-25T05:00:00Z' }),
  ];
  await db.client.query(
    `INSERT INTO app.visits (booking_id, branch_id, client_id, arrived_at, marked_by) SELECT id, branch_id, client_id, lower(period), $2 FROM app.bookings WHERE id = ANY($1::uuid[])`,
    [ids, SYS],
  );
}, 60_000);
afterAll(async () => {
  await fx.close();
  await db.drop();
});

describe('агрегат первого посещения (0442)', () => {
  it('вставка по одной и пачкой: агрегат = группировка живых посещений; yu_app писать в него не может', async () => {
    await aggregateMatchesVisits();
    const app = await fx.app.connect();
    try {
      await expect(app.query(`INSERT INTO app.client_first_visits VALUES ($1, $2, now(), 1)`, [c.fresh, b2])).rejects.toMatchObject({ code: '42501' });
      await expect(app.query(`DELETE FROM app.client_first_visits`)).rejects.toMatchObject({ code: '42501' });
    } finally {
      app.release();
    }
  });

  it('отмена отметки: первое посещение сдвигается, последнее отменённое убирает пару; новая отметка возвращает', async () => {
    const first = (await db.client.query<{ id: string }>(`SELECT v.id FROM app.visits v JOIN app.bookings b ON b.id = v.booking_id WHERE v.client_id = $1 ORDER BY lower(b.period) LIMIT 1`, [c.reverted])).rows[0]!.id;
    await db.client.query(`UPDATE app.visits SET status = 'reverted', reverted_at = now(), reverted_by = $2, revert_reason = 'ошибка' WHERE id = $1`, [first, SYS]);
    await aggregateMatchesVisits();
    expect((await db.client.query(`SELECT first_visit_at FROM app.client_first_visits WHERE client_id = $1`, [c.reverted])).rows).toEqual([{ first_visit_at: new Date('2026-10-10T05:00:00Z') }]);
    const lostVisit = (await db.client.query<{ id: string; booking_id: string }>(`SELECT id, booking_id FROM app.visits WHERE client_id = $1`, [c.lost])).rows[0]!;
    await db.client.query(`UPDATE app.visits SET status = 'reverted', reverted_at = now(), reverted_by = $2, revert_reason = 'ошибка' WHERE id = $1`, [lostVisit.id, SYS]);
    expect((await db.client.query(`SELECT 1 FROM app.client_first_visits WHERE client_id = $1`, [c.lost])).rowCount).toBe(0);
    await fx.visit(lostVisit.booking_id);
    await aggregateMatchesVisits();
  });

  it('перенос брони с посещением пересчитывает пару', async () => {
    const b = (await db.client.query<{ booking_id: string }>(`SELECT v.booking_id FROM app.visits v JOIN app.bookings b ON b.id = v.booking_id WHERE v.client_id = $1 AND lower(b.period) > '2026-11-01'`, [c.moved])).rows[0]!.booking_id;
    await fx.reschedule(b, '2026-10-02T05:00:00Z', '2026-10-02T06:00:00Z', '2026-09-30T00:00:00Z');
    await aggregateMatchesVisits();
    expect((await db.client.query(`SELECT first_visit_at FROM app.client_first_visits WHERE client_id = $1`, [c.moved])).rows).toEqual([{ first_visit_at: new Date('2026-10-02T05:00:00Z') }]);
  });
});

describe('отчёт клиентов по агрегату = прежний расчёт (K24 §3.6 не меняется)', () => {
  it('сеть, зона одного филиала и разбивка по филиалам; текущий и прошлый период', async () => {
    const cases: Array<[string, string[]]> = [['сеть', [b1, b2]], ['зона b1', [b1]], ['зона b2', [b2]]];
    let checked = 0;
    for (const [name, ids] of cases) {
      for (const p of [OCT, prevPeriod(OCT), { from: d('2026-10-01'), to: d('2026-11-30') }]) {
        const w = await windows(ids, p);
        for (const perBranch of [false, true]) {
          const oracle = await withReportTx(fx.reports, (tx) => tx.query<StatRow>(ORACLE(perBranch), [w.map((x) => x.branchId), w.map((x) => x.start), w.map((x) => x.end)]));
          const now = await withReportTx(fx.reports, (tx) => clientStatRows(tx, w, perBranch));
          expect(norm(now), `${name} ${p.from}…${p.to} perBranch=${perBranch}`).toEqual(norm(oracle.rows));
          if (oracle.rows.length) checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(10);
  });

  it('показатели отчёта: впервые и вернувшиеся – как по смыслу (cross в зоне b1 – вернувшийся, edge – вернувшийся)', async () => {
    const net = await fx.run(fx.owner(), (env) => clientsReport(env, { period: OCT }));
    const val = (m: { state: string; value?: number }) => (m.state === 'ok' ? m.value : m.state);
    // в октябре: old, fresh, cross, reverted (после отмены сентябрьской – впервые), moved (перенос на 2.10 – впервые), edge
    expect(val(net.metrics.withVisit)).toBe(6);
    expect(val(net.metrics.firstTime)).toBe(3); // fresh, reverted, moved
    expect(val(net.metrics.returning)).toBe(3); // old, cross, edge
    const zone = await fx.run(fx.director([b1]), (env) => clientsReport(env, { period: OCT }));
    expect(val(zone.metrics.returning)).toBe(3); // old, cross (первое в сети – в b2), edge
  });
});

describe('план без полного просмотра visits и bookings (S4-131)', () => {
  /** Запросы отчёта записываются и объясняются с enable_seqscan = off: остаётся полный просмотр только там, где индекса нет. */
  async function seqScans(run: (tx: Tx) => Promise<unknown>): Promise<string[]> {
    const seen: Array<[string, unknown[] | undefined]> = [];
    return withReportTx(fx.reports, async (tx) => {
      const rec: Tx = { query: <R extends pg.QueryResultRow>(text: string, values?: unknown[]) => (seen.push([text, values]), tx.query<R>(text, values)) };
      await run(rec);
      await tx.query('SET LOCAL enable_seqscan = off');
      const out: string[] = [];
      for (const [text, values] of seen) {
        if (!/rpt_visits|rpt_client_first_visits/.test(text)) continue;
        const plan = (await tx.query<{ 'QUERY PLAN': unknown }>(`EXPLAIN (FORMAT JSON) ${text}`, values)).rows[0]!['QUERY PLAN'];
        const walk = (n: Record<string, unknown>): void => {
          if (n['Node Type'] === 'Seq Scan') out.push(String(n['Relation Name']));
          for (const k of (n.Plans as Array<Record<string, unknown>> | undefined) ?? []) walk(k);
        };
        walk((plan as Array<{ Plan: Record<string, unknown> }>)[0]!.Plan);
      }
      expect(seen.length).toBeGreaterThan(0);
      return out;
    });
  }

  it('сеть и зона: ни visits, ни bookings не читаются целиком', async () => {
    await db.client.query('ANALYZE');
    for (const ids of [[b1, b2], [b1]]) {
      const w = await windows(ids, OCT);
      const scans = await seqScans(async (tx) => {
        await clientStatRows(tx, w, false);
        await clientStatRows(tx, w, true);
      });
      expect(scans.filter((t) => t === 'visits' || t === 'bookings'), ids.join(',')).toEqual([]);
    }
    const all = await seqScans((tx) => clientsReport({ tx, main: fx.app, ctx: fx.owner(), clock: fixedClock('2026-11-20T05:00:00Z') }, { period: OCT }));
    expect(all.filter((t) => t === 'visits' || t === 'bookings')).toEqual([]);
  });
});

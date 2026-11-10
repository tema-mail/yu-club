// S4-132 (часть отчётов): TC-20 (20 §TC) и критерии 18 §8.4 «отчёты согласуются с первичными операциями», «Директор не видит
// данные вне своей области» – через HTTP-маршруты API на настоящей Postgres, один сервер на все сценарии.
// Первичка – засев Э0–Э3 боевыми процедурами (db/seed: брони, визиты, касса, сертификаты, баллы, смены, ремонт, мероприятие)
// и операции по HTTP в первом сценарии (брони декабря с отменой и переносом, приходы у границы суток филиалов).
// Экспорт считает тот же runner, что в worker. Каждый пункт – отдельный it с номером.
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import { createFileStore, type FileStore } from '../../apps/api/src/core/files.ts';
import { clearSubscriptions, processEvent } from '../../apps/api/src/core/outbox.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { startExportRunner } from '../../apps/api/src/modules/reports/export.ts';
import { METRIC_TITLES } from '../../apps/api/src/modules/reports/export-labels.ts';
import { createReportsPool } from '../../apps/api/src/modules/reports/framework.ts';
import { HANDLER_ATTENDANCE, HANDLER_RATE, registerPayrollHandlers } from '../../apps/api/src/modules/shifts/accrual.ts';
import { staffAuthConfig } from '../../apps/api/src/modules/staff/auth.ts';
import { buildServer, networkLookup } from '../../apps/api/src/server.ts';
import { seedClub } from '../../db/seed/club.ts';
import { seedCommerce } from '../../db/seed/commerce.ts';
import { DEMO_EMAIL_DOMAIN, seedDev } from '../../db/seed/dev.ts';
import { seedResources } from '../../db/seed/resources.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const PASSWORD = 'Демо-пароль-сквозной-Э4';
const CRM = '/api/crm/v1';
const early = fixedClock('2026-11-12T05:00:00Z');
const seedClock = fixedClock('2026-11-14T05:00:00Z');
// «Сейчас» – 02.12: ноябрь закрыт, декабрьские брони – будущие (отмена и перенос по HTTP)
const clock = fixedClock('2026-12-02T05:00:00Z');
const NOV = { from: '2026-11-01', to: '2026-11-30' };
const DEC = { from: '2026-12-01', to: '2026-12-31' };
const PERIODS = [NOV, DEC];
const REPORTS = ['bookings', 'utilization', 'finance', 'clients', 'loyalty', 'certificates', 'comms', 'events', 'equipment', 'staff'] as const;
let db: TestDatabase;
let pool: pg.Pool;
let reports: pg.Pool;
let app: FastifyInstance;
let dir: string;
let store: FileStore;
const cookies: Record<string, string> = {};
const ids: Record<string, string> = {};

type Metric = { state: 'ok'; value: number; unit: string; prev: number | null } | { state: 'no_data' | 'unavailable' };
type Row = Record<string, unknown>;
type F = Record<string, string | string[] | undefined>;

const qs = (o: F) => Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${encodeURIComponent(Array.isArray(v) ? v.join(',') : v!)}`).join('&');
const get = (who: string, url: string) => app.inject({ method: 'GET', url: `${CRM}${url}`, headers: { cookie: cookies[who]! } });
const post = (who: string, url: string, payload: object) =>
  app.inject({ method: 'POST', url: `${CRM}${url}`, headers: { cookie: cookies[who]!, 'idempotency-key': randomUUID() }, payload });
const ok = async <T = Row>(p: ReturnType<typeof get>): Promise<T> => {
  const r = await p;
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as T;
};
const summary = (who: string, report: string, f: F = {}) => ok<{ metrics: Record<string, Metric> }>(get(who, `/reports/${report}?${qs({ ...NOV, ...f })}`));
const val = (m: Metric | undefined) => (m?.state === 'ok' ? m.value : 0);

/** Все страницы детализации показателя (по 37 строк – курсор проходит несколько страниц); итог одинаков на каждой. */
async function walk(who: string, report: string, metric: string, f: F = {}): Promise<{ total: Metric; rows: Row[] }> {
  const rows: Row[] = [];
  let cursor: string | undefined;
  let total: Metric | undefined;
  do {
    const p = await ok<{ rows: Row[]; total: Metric; nextCursor: string | null }>(get(who, `/reports/${report}/detail?${qs({ ...NOV, ...f, metric, limit: '37', cursor })}`));
    total ??= p.total;
    expect(p.total).toEqual(total);
    rows.push(...p.rows);
    cursor = p.nextCursor ?? undefined;
  } while (cursor);
  return { total: total!, rows };
}

/** TC-20: итог детализации = карточка экрана (0 на экране ⇔ «нет данных» в детализации); строки воспроизводят итог. */
function expectDetailMatches(where: string, m: Metric, d: { total: Metric; rows: Row[] }): void {
  if (m.state !== 'ok') {
    expect(d.total.state, where).toBe(m.state);
    return;
  }
  if (d.total.state === 'no_data') {
    expect([where, m.value]).toEqual([where, 0]);
    expect(d.rows, where).toEqual([]);
    return;
  }
  expect(d.total.state, where).toBe('ok');
  const t = d.total as Extract<Metric, { state: 'ok' }>;
  expect([where, t.unit]).toEqual([where, m.unit]);
  expect(t.value, where).toBeCloseTo(m.value, 6);
  if (m.unit === 'pct') return; // доля – отношение сумм, а не сумма строк; итог сверен выше
  // строки: число строк (count), сумма значений (sum) или среднее (avg) – одно из трёх равно итогу
  const n = d.rows.length;
  const sum = d.rows.reduce((a, r) => a + Number(r.value ?? r.metricValue ?? 0), 0);
  const candidates = [n, sum, n ? sum / n : 0];
  expect(candidates.some((c) => Math.abs(c - t.value) < 1e-6), `${where}: итог ${t.value}, строк ${n}, сумма ${sum}`).toBe(true);
}

function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ';') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      out.push(row);
      row = [];
      cell = '';
      i++;
    } else cell += ch;
  }
  return out;
}

/** Экспорт тем же runner и с тем же справочником сети, что в worker; файл CSV – строками ячеек. */
async function exportCsv(who: string, payload: object): Promise<string[][]> {
  const r = await post(who, '/reports/exports', { format: 'csv', ...payload });
  expect(r.statusCode, r.body).toBe(202);
  const runner = startExportRunner({ pool, reports, clock, store, network: networkLookup }, { start: false });
  for (let i = 0; i < 3; i++) await runner.tick();
  await runner.stop();
  const job = await ok<{ status: string; errorCode: string | null }>(get(who, `/reports/exports/${r.json().id}`));
  expect(job, JSON.stringify(payload)).toMatchObject({ status: 'ready', errorCode: null });
  const file = await get(who, `/reports/exports/${r.json().id}/file`);
  expect(file.statusCode).toBe(200);
  return parseCsv(file.body.charCodeAt(0) === 0xfeff ? file.body.slice(1) : file.body); // без BOM UTF-8
}

/** Значение показателя так, как его пишет файл (K24 §2: рубли и баллы – в единицах, проценты – до 0,1). */
function shown(m: Metric): string {
  if (m.state !== 'ok') return m.state === 'no_data' ? 'нет данных' : 'недоступно';
  const v = m.unit === 'kop' || m.unit === 'centi' ? m.value / 100 : m.unit === 'pct' ? Math.round(m.value * 10) / 10 : m.value;
  return String(v).replace('.', ',');
}
const shownTotal = (m: Metric): string => (m.state === 'ok' && (m.unit === 'kop' || m.unit === 'centi') ? (m.value / 100).toFixed(2).replace('.', ',') : shown(m));
/** Строки данных файла: после пустой строки – заголовок столбцов, дальше строки. */
const dataRows = (csv: string[][]): string[][] => csv.slice(csv.findIndex((r) => r.length === 1 && r[0] === '') + 2);
const headerValue = (csv: string[][], label: string): string | undefined => csv.find((r) => r[0] === label)?.[1];

async function login(key: string): Promise<void> {
  const res = await app.inject({ method: 'POST', url: `${CRM}/auth/login`, payload: { email: `${key}@${DEMO_EMAIL_DOMAIN}`, password: PASSWORD } });
  expect(res.statusCode, res.body).toBe(200);
  cookies[key] = String(res.headers['set-cookie']).split(';')[0]!;
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 6 });
  reports = createReportsPool(db.reportsUrl);
  dir = await mkdtemp(join(tmpdir(), 'yu-tc20-'));
  store = createFileStore({ root: dir });
  clearSubscriptions();
  registerPayrollHandlers({ clock: seedClock });
  const env = { APP_ENV: 'test' };
  await seedDev(pool, { env, password: PASSWORD }, early);
  await seedResources(pool, { env }, early);
  await seedCommerce(pool, { env, certPepper: 'p'.repeat(40) }, seedClock);
  await seedClub(pool, { env }, seedClock);
  // начисления за смены – то, что делает worker по outbox
  const ev = await db.client.query<{ id: string; event_type: string }>(
    `SELECT id, event_type FROM app.outbox_events WHERE event_type IN ('shift.attendance_changed','staff.rate_set') ORDER BY occurred_at, id`,
  );
  for (const e of ev.rows) await processEvent(pool, e.event_type === 'staff.rate_set' ? HANDLER_RATE : HANDLER_ATTENDANCE, e.id, seedClock.now());
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), { staff: { pool, auth: staffAuthConfig('k'.repeat(40)), clock }, reports: { pool: reports, exportStore: store } });
  for (const key of ['owner', 'director']) await login(key);
  for (const r of (await db.client.query<{ id: string; code: string }>(`SELECT id, code FROM app.branches`)).rows) ids[r.code] = r.id;
}, 120_000);
afterAll(async () => {
  clearSubscriptions();
  await app.close();
  await reports.end();
  await pool.end();
  await db.drop();
  await rm(dir, { recursive: true, force: true });
});

describe('S4-132: TC-20 и 18 §8.4 (отчёты) по HTTP', () => {
  it('0. Первичка по HTTP: декабрьские брони (создание, отмена клубом, перенос), приходы кассы у границы суток филиалов', async () => {
    const krasny = ids['demo-nsk-krasny']!;
    const arbat = ids['demo-msk-arbat']!;
    const pc = (await db.client.query<{ id: string }>(`SELECT id FROM app.resources WHERE branch_id = $1 AND resource_type = 'pc' ORDER BY name LIMIT 2`, [krasny])).rows;
    const client = (await db.client.query<{ id: string }>(`SELECT id FROM app.clients WHERE phone_e164 = '+79000000002'`)).rows[0]!.id;
    const reason = (await db.client.query<{ id: string }>(`SELECT id FROM app.dict_reasons WHERE domain = 'booking_cancel_club' ORDER BY code LIMIT 1`)).rows[0]!.id;
    const made: string[] = [];
    for (const hour of ['03', '05', '07']) {
      const r = await post('owner', `/branches/${krasny}/bookings`, { resourceId: pc[0]!.id, start: `2026-12-03T${hour}:00:00Z`, end: `2026-12-03T${hour}:30:00Z`, client: { clientId: client } });
      expect(r.statusCode, r.body).toBe(201);
      made.push(r.json().id);
    }
    const cancel = await post('owner', `/bookings/${made[0]}/cancel`, { rowVersion: 1, initiator: 'club', reasonId: reason, comment: 'авария' });
    expect(cancel.statusCode, cancel.body).toBe(200);
    const moved = await post('owner', `/bookings/${made[1]}/reschedule`, { rowVersion: 1, resourceId: pc[1]!.id, start: '2026-12-04T03:00:00Z', end: '2026-12-04T03:30:00Z', reason: 'просьба клиента' });
    expect(moved.statusCode, moved.body).toBe(200);
    // граница суток: 30.11 18:00Z = 01.12 01:00 Новосибирска (декабрь), 30.11 20:30Z = 30.11 23:30 Москвы (ноябрь)
    for (const [branch, at, amountKop] of [[krasny, '2026-11-30T18:00:00Z', 70_000], [arbat, '2026-11-30T20:30:00Z', 30_000]] as const) {
      const r = await post('owner', `/branches/${branch}/finance/income`, { method: 'card', amountKop, source: 'other', occurredAt: at });
      expect(r.statusCode, r.body).toBe(201);
    }
    const dec = await summary('owner', 'bookings', DEC);
    expect(dec.metrics).toMatchObject({ created: { value: 3 }, cancelledByClub: { value: 1 }, rescheduled: { value: 1 } });
  });

  it.each(REPORTS.map((r, i) => [i + 1, r] as const))('TC-20.%i %s: по каждому показателю детализация = итог карточки (ноябрь и декабрь, сеть и каждый филиал)', async (_n, report) => {
    let checked = 0;
    for (const period of PERIODS) {
      for (const scope of [{}, { branchIds: ids['demo-nsk-krasny'] }, { branchIds: ids['demo-msk-arbat'] }]) {
        const s = await summary('owner', report, { ...period, ...scope });
        for (const [key, m] of Object.entries(s.metrics)) {
          const where = `${report}.${key} ${period.from} ${JSON.stringify(scope)}`;
          const probe = await get('owner', `/reports/${report}/detail?${qs({ ...period, ...scope, metric: key, limit: '1' })}`);
          if (m.state === 'unavailable' && probe.statusCode === 422) continue; // источника нет – детализации нет
          expectDetailMatches(where, m, await walk('owner', report, key, { ...period, ...scope }));
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('TC-20.11 сумма филиалов + без филиала = сеть: денежные и минутные показатели всех отчётов сходятся по фильтру филиала', async () => {
    // запись без филиала (ручная корректировка баллов, выплата зарплаты) видна только в сетевой области (K24 §8, nullableBranch):
    // её сумма – из строк сетевой детализации с branchId = null (0443: у баллов филиал операции в строке)
    let noBranchSeen = 0;
    for (const report of REPORTS) {
      for (const period of PERIODS) {
        const net = (await summary('owner', report, period)).metrics;
        const parts = await Promise.all(['demo-nsk-krasny', 'demo-msk-arbat', 'demo-msk-dst'].map(async (c) => (await summary('owner', report, { ...period, branchIds: ids[c] })).metrics));
        for (const [key, m] of Object.entries(net)) {
          // баланс на дату – не поток: клиент с бронями в двух филиалах входит в оба (K24 §3.7)
          if (m.state !== 'ok' || !['kop', 'centi', 'minutes'].includes(m.unit) || /^avg|^per|Load$|^totalBalance$/.test(key)) continue;
          const sum = parts.reduce((a, p) => a + val(p[key]), 0);
          if (sum === m.value) continue;
          const noBranch = (await walk('owner', report, key, period)).rows.filter((r) => r.branchId === null);
          noBranchSeen += noBranch.length;
          expect([report, key, period.from, sum + noBranch.reduce((a, r) => a + Number(r.value), 0)]).toEqual([report, key, period.from, m.value]);
        }
      }
    }
    expect(noBranchSeen).toBeGreaterThan(0); // засев Э2 делает корректировку баллов без филиала – сверка её видела
  });

  it('TC-20.12 часовой пояс: приход 30.11 23:30 Москвы – в ноябре Арбата, 01.12 01:00 Новосибирска – в декабре Красного', async () => {
    const other = async (code: string, period: typeof NOV) => (await walk('owner', 'finance', 'incomeOther', { ...period, branchIds: ids[code] })).rows.map((r) => Number(r.value));
    expect(await other('demo-msk-arbat', NOV)).toContain(30_000);
    expect(await other('demo-msk-arbat', DEC)).not.toContain(30_000);
    expect(await other('demo-nsk-krasny', NOV)).not.toContain(70_000);
    expect(await other('demo-nsk-krasny', DEC)).toContain(70_000);
  });

  it('TC-20.13 отчёт = первичка (18 §8.4): приходы, расходы, визиты и брони пересчитаны из таблиц операций по суткам филиала', async () => {
    for (const period of PERIODS) {
      for (const code of ['demo-nsk-krasny', 'demo-msk-arbat']) {
        const f = { ...period, branchIds: ids[code] };
        const local = (col: string) => `(${col} AT TIME ZONE br.timezone)::date BETWEEN $2::date AND $3::date`;
        const one = async (sql: string) => Number((await db.client.query<{ v: string }>(sql, [ids[code], period.from, period.to])).rows[0]!.v);
        const money = (kind: string) =>
          one(
            `SELECT coalesce(sum(CASE WHEN o.kind = 'reversal' THEN -o.amount_kop ELSE o.amount_kop END), 0) v
             FROM journal.finance_operations o JOIN app.branches br ON br.id = o.branch_id LEFT JOIN journal.finance_operations x ON x.id = o.reversal_of
             WHERE o.branch_id = $1 AND (o.kind = '${kind}' OR x.kind = '${kind}') AND ${local('o.occurred_at')}`,
          );
        const fin = (await summary('owner', 'finance', f)).metrics;
        expect([code, period.from, 'income', val(fin.income)]).toEqual([code, period.from, 'income', await money('income')]);
        expect([code, period.from, 'expenses', Math.abs(val(fin.expenses))]).toEqual([code, period.from, 'expenses', await money('expense')]);
        const bk = (await summary('owner', 'bookings', f)).metrics;
        const visits = await one(`SELECT count(*) v FROM app.visits v JOIN app.branches br ON br.id = v.branch_id WHERE v.branch_id = $1 AND ${local('v.arrived_at')}`);
        const created = await one(`SELECT count(*) v FROM app.bookings b JOIN app.branches br ON br.id = b.branch_id WHERE b.branch_id = $1 AND ${local('b.created_at')}`);
        expect([code, period.from, 'visited', val(bk.visited)]).toEqual([code, period.from, 'visited', visits]);
        expect([code, period.from, 'created', val(bk.created)]).toEqual([code, period.from, 'created', created]);
      }
    }
  });

  it('TC-20.14 рабочий стол: каждая карточка = показатель своего отчёта и итог его детализации', async () => {
    const d = await ok<{ cards: Array<{ key: string; metric: Metric; link: { report: string; metric: string } }> }>(get('owner', `/reports/dashboard?${qs(NOV)}`));
    expect(d.cards.length).toBeGreaterThan(5);
    for (const c of d.cards) {
      const m = (await summary('owner', c.link.report)).metrics[c.link.metric]!;
      expect([c.key, c.metric]).toEqual([c.key, m]);
      expectDetailMatches(`dashboard.${c.key}`, c.metric, await walk('owner', c.link.report, c.link.metric));
    }
  });

  it.each(REPORTS.map((r, i) => [i + 15, r] as const))('TC-20.%i %s: экспорт = экран (итоги – значения карточек; детализация – тот же итог и те же строки)', async (_n, report) => {
    const s = await summary('owner', report);
    const csv = await exportCsv('owner', { report, params: NOV });
    const file = new Map(dataRows(csv).map((r) => [r[0], r[1]]));
    for (const [key, m] of Object.entries(s.metrics)) expect([key, file.get(METRIC_TITLES[key] ?? key)]).toEqual([key, shown(m)]);
    const key = Object.entries(s.metrics).find(([, m]) => m.state === 'ok' && m.value !== 0)?.[0];
    if (!key) return; // в ноябре нет ни одного ненулевого показателя (comms – см. e4-e2e)
    const d = await walk('owner', report, key);
    const detail = await exportCsv('owner', { report, detail: true, params: { ...NOV, metric: key } });
    expect(headerValue(detail, `Итого: ${METRIC_TITLES[key] ?? key}`)).toBe(shownTotal(d.total));
    expect(dataRows(detail)).toHaveLength(d.rows.length);
  });

  it('TC-20.25 18 §8.4 изоляция Директора: его «вся сеть» = отчёт Владельца по его филиалу; чужой филиал – 404 на экран, детализацию и экспорт', async () => {
    const krasny = ids['demo-nsk-krasny']!;
    const arbat = ids['demo-msk-arbat']!;
    let seen = 0;
    for (const report of REPORTS) {
      const own = await get('director', `/reports/${report}?${qs(NOV)}`);
      if (own.statusCode === 403) continue; // права на этот отчёт у Директора нет (K24 §8)
      expect(own.statusCode, own.body).toBe(200);
      seen += 1;
      const mine = own.json().metrics as Record<string, Metric>;
      const theirs = (await summary('owner', report, { branchIds: krasny })).metrics;
      for (const k of Object.keys(theirs)) expect([report, k, mine[k]]).toEqual([report, k, theirs[k]]);
      expect([report, (await get('director', `/reports/${report}?${qs({ ...NOV, branchIds: arbat })}`)).statusCode]).toEqual([report, 404]);
      const first = Object.keys(mine)[0]!;
      expect([report, (await get('director', `/reports/${report}/detail?${qs({ ...NOV, branchIds: arbat, metric: first })}`)).statusCode]).toEqual([report, 404]);
      for (const r of (await walk('director', report, first)).rows) if (typeof r.branchId === 'string') expect([report, r.branchId]).toEqual([report, krasny]);
    }
    expect(seen).toBeGreaterThanOrEqual(5);
    expect((await post('director', '/reports/exports', { report: 'bookings', format: 'csv', params: { ...NOV, branchIds: [arbat] } })).statusCode).toBe(404);
    const file = await exportCsv('director', { report: 'bookings', params: NOV });
    expect(headerValue(file, 'Область')).toBe('Ю Клуб на Красном');
  });
});

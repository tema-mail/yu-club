// S3-98. Нагрузка гонок Э3 (по образцу money-race.ts): настоящий API по HTTP (buildServer на 127.0.0.1) и embedded-postgres во временной папке,
// данные – засевы Э0, Э1, Э3 (db/seed). Только локально – на стенд нагрузку НЕ давать (общий сервер).
//   1) смены: LOAD_SHIFT_STAFF (20) сотрудников, у каждого одна и та же смена сразу в двух филиалах;
//   2) праздник против брони: LOAD_VR_SLOTS (20) слотов VR-места, в каждом – занятие для мероприятия и бронь клиента одновременно;
//   3) подарок: LOAD_GIFTS (20) подарков, у каждого две записи на разное время одновременно;
//   4) выплата: LOAD_PAYOUTS (10) выплаченных ведомостей, по два запроса расхода с разными ключами;
//   5) ремонт: LOAD_LINKS (20) уже внесённых расходов, каждый привязывается к двум ремонтам одновременно.
// После прогона – запросы к базе: ни одной пары пересекающихся живых смен сотрудника, занятий единицы, операции с двумя живыми связями,
// у подарка ≤ 1 живой записи, у ведомости один расход на сумму выплаты; ночная сверка S3-95 – ноль расхождений. Печатает p50/p95 по каждой гонке.
//
//   npm run load:club                                  – пул API 10 (как depsFromConfig на сервере)
//   LOAD_SHIFT_STAFF=100 LOAD_POOL=20 npm run load:club
// Код выхода 1 – нарушен инвариант, ответ 5xx или в гонке не тот победитель.
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { loadConfig } from '../../apps/api/src/config.ts';
import { clearSubscriptions, processEvent } from '../../apps/api/src/core/outbox.ts';
import { addDays, instantToLocal, localToInstant, type Clock, type LocalDate, type LocalTime, type TimeZone } from '../../apps/api/src/core/time.ts';
import { runReconcile } from '../../apps/api/src/modules/reports/reconcile.ts';
import { HANDLER_ATTENDANCE, HANDLER_RATE, registerPayrollHandlers } from '../../apps/api/src/modules/shifts/accrual.ts';
import { staffAuthConfig } from '../../apps/api/src/modules/staff/auth.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { migrateUp } from '../../db/migrate.ts';
import { seedClub } from '../../db/seed/club.ts';
import { DEMO_EMAIL_DOMAIN, seedDev } from '../../db/seed/dev.ts';
import { seedResources } from '../../db/seed/resources.ts';

const SHIFT_STAFF = Number(process.env.LOAD_SHIFT_STAFF ?? 20);
const VR_SLOTS = Number(process.env.LOAD_VR_SLOTS ?? 20);
const GIFTS = Number(process.env.LOAD_GIFTS ?? 20);
const PAYOUTS = Number(process.env.LOAD_PAYOUTS ?? 10);
const LINKS = Number(process.env.LOAD_LINKS ?? 20);
const POOL = Number(process.env.LOAD_POOL ?? 10);
const PASSWORD = `Нагрузка-${randomUUID()}`;
const NOW = new Date('2026-11-16T03:00:00Z'); // понедельник, 10:00 Новосибирска, 06:00 Москвы
const ENV = { APP_ENV: 'test' };

const pct = (xs: number[], p: number): number => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
};
const fmt = (xs: number[]) => `n=${xs.length} p50=${pct(xs, 50).toFixed(0)} мс p95=${pct(xs, 95).toFixed(0)} мс max=${Math.max(...xs).toFixed(0)} мс`;
const tally = (xs: string[]) => Object.fromEntries([...new Set(xs)].sort().map((k) => [k, xs.filter((x) => x === k).length]));
type Reply = { status: number; json: Record<string, unknown> & { error?: { code: string } }; ms: number; code: string };

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'yu-load-club-'));
  const password = randomBytes(12).toString('hex');
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const pgServer = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password, port, persistent: false, postgresFlags: ['-c', 'max_connections=300'], onLog: () => undefined, onError: () => undefined });
  await pgServer.initialise();
  await pgServer.start();
  const adminUrl = `postgres://postgres:${password}@127.0.0.1:${port}/postgres`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  let pool: pg.Pool | undefined;
  let app: ReturnType<typeof buildServer> | undefined;
  let sql: pg.Client | undefined;
  let failed = false;
  try {
    await admin.query(`CREATE ROLE yu_app NOLOGIN`);
    await admin.query(`CREATE ROLE yu_reports NOLOGIN`);
    await admin.query(`CREATE DATABASE yu_load`);
    await admin.end();
    const dbUrl = adminUrl.replace(/\/postgres$/, '/yu_load');
    sql = new pg.Client({ connectionString: dbUrl });
    await sql.connect();
    await migrateUp(sql);
    const one = async <T = { id: string }>(text: string, params: unknown[] = []) => (await sql!.query(text, params)).rows[0] as T;
    const n = async (text: string, params: unknown[] = []) => Number((await sql!.query<{ n: string }>(text, params)).rows[0]!.n);
    pool = new pg.Pool({ connectionString: dbUrl, options: '-c role=yu_app -c search_path=app,journal', max: POOL });
    const clock: Clock = { now: () => NOW };

    // ---- подготовка (не в замере): засевы и сервер
    const dayBefore: Clock = { now: () => new Date(NOW.getTime() - 2 * 86_400_000) };
    await seedDev(pool, { env: ENV, password: PASSWORD }, dayBefore);
    await seedResources(pool, { env: ENV }, dayBefore);
    const club = await seedClub(pool, { env: ENV }, clock);
    clearSubscriptions();
    registerPayrollHandlers({ clock });
    app = buildServer(loadConfig({ LOG_LEVEL: 'silent', APP_ENV: 'dev' }), { staff: { pool, auth: staffAuthConfig(randomBytes(32).toString('hex')), clock } });
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    const login = await fetch(`${base}/api/crm/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `owner@${DEMO_EMAIL_DOMAIN}`, password: PASSWORD }) });
    if (login.status !== 200) throw new Error(`вход: ${login.status} ${await login.text()}`);
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
    const api = async (method: string, url: string, body?: unknown): Promise<Reply> => {
      const t0 = performance.now();
      const r = await fetch(`${base}/api/crm/v1${url}`, {
        method,
        headers: { cookie, 'content-type': 'application/json', ...(method === 'GET' ? {} : { 'idempotency-key': randomUUID() }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const json = (await r.json().catch(() => ({}))) as Reply['json'];
      return { status: r.status, json, ms: performance.now() - t0, code: r.status < 300 ? 'ok' : (json.error?.code ?? String(r.status)) };
    };
    const must = async (method: string, url: string, body?: unknown) => {
      const r = await api(method, url, body);
      if (r.status >= 300) throw new Error(`${method} ${url}: ${r.status} ${JSON.stringify(r.json)}`);
      return r.json as Record<string, unknown> & { id: string; rowVersion: number };
    };
    const settle = async () => {
      const r = await sql!.query<{ id: string; event_type: string }>(
        `SELECT e.id, e.event_type FROM app.outbox_events e WHERE e.event_type IN ('shift.attendance_changed','staff.rate_set') AND NOT EXISTS (SELECT 1 FROM app.processed_events p WHERE p.event_id = e.id) ORDER BY e.occurred_at, e.id`,
      );
      for (const e of r.rows) await processEvent(pool!, e.event_type === 'staff.rate_set' ? HANDLER_RATE : HANDLER_ATTENDANCE, e.id, clock.now());
    };
    await settle();

    const krasny = await one<{ id: string; timezone: TimeZone }>(`SELECT id, timezone FROM app.branches WHERE code = 'demo-nsk-krasny'`);
    const arbat = await one<{ id: string; timezone: TimeZone }>(`SELECT id, timezone FROM app.branches WHERE code = 'demo-msk-arbat'`);
    const owner = await one(`SELECT id FROM app.staff WHERE role = 'owner' AND status = 'active'`);
    await sql.query(
      `INSERT INTO app.settings_values (key, level, branch_id, value, valid_from, created_by) SELECT 'finance.negative_balance_allowed', 'branch', id, 'true', '2026-01-01', $1 FROM app.branches WHERE id = ANY($2::uuid[])`,
      [owner.id, [krasny.id, arbat.id]],
    );
    const newStaff = async (i: number) => {
      const s = await one(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('Н', $1, $2, 'admin', 'x') RETURNING id`, [`Гонка ${i}`, `race-${i}@yu.test`]);
      await sql!.query(`INSERT INTO app.staff_assignments (staff_id, scope_type, branch_id, valid_from, created_by) SELECT $1, 'branch', b, '2026-01-01', $2 FROM unnest($3::uuid[]) b`, [s.id, owner.id, [krasny.id, arbat.id]]);
      return s.id;
    };
    const newClient = async (i: number) => (await one(`INSERT INTO app.clients (phone_e164, first_name, status, created_by_type, registered_at) VALUES ($1, 'К', 'active', 'staff', now()) RETURNING id`, [`+7999${String(1_000_000 + i)}`])).id;
    const local = (date: LocalDate, minutes: number, tz: TimeZone) => {
      const time = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}` as LocalTime;
      return localToInstant(date, time, tz).toISOString();
    };
    const vr1 = await one(`SELECT r.id FROM app.resources r WHERE r.branch_id = $1 AND r.resource_type = 'vr_seat' AND r.name = 'VR1'`, [krasny.id]);

    // 1) смены: заготовка – сотрудники
    const raceStaff: string[] = [];
    for (let i = 0; i < SHIFT_STAFF; i++) raceStaff.push(await newStaff(i));

    // 2) праздник против брони: заготовка – мероприятия и клиенты на каждый слот, среда следующей недели после исключений графика нет
    const otherType = await one(`SELECT id FROM app.event_types WHERE code = 'other'`);
    const slotDay = '2026-11-18' as LocalDate;
    const slots: Array<{ eventId: string; clientId: string; start: string; end: string }> = [];
    for (let i = 0; i < VR_SLOTS; i++) {
      const event = await must('POST', '/events', { typeId: otherType.id, branchId: krasny.id, customer: { name: `Заказчик ${i}`, phone: `+7913${String(1_000_000 + i)}` } });
      const startMin = 11 * 60 + (i % 20) * 30;
      const date = addDays(slotDay, Math.floor(i / 20));
      slots.push({ eventId: event.id, clientId: await newClient(i), start: local(date, startMin, krasny.timezone), end: local(date, startMin + 30, krasny.timezone) });
    }

    // 3) подарок: заготовка – подарки; будни Арбата, по 4 подарка на день, у каждого два часа рядом
    const weekdays: LocalDate[] = [];
    for (let d = addDays(instantToLocal(NOW, arbat.timezone).date, 1); weekdays.length < Math.ceil(GIFTS / 4) + 1; d = addDays(d, 1)) {
      const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
      if (dow !== 0 && dow !== 6 && d !== addDays(instantToLocal(NOW, arbat.timezone).date, 7) && d !== addDays(instantToLocal(NOW, arbat.timezone).date, 14)) weekdays.push(d);
    }
    const gifts: Array<{ id: string; a: string; b: string }> = [];
    for (let i = 0; i < GIFTS; i++) {
      const g = await must('POST', '/gifts', { clientId: await newClient(10_000 + i), branchId: arbat.id, reason: 'гонка' });
      const date = weekdays[Math.floor(i / 4)]!;
      const start = 11 * 60 + (i % 4) * 120;
      gifts.push({ id: g.id, a: local(date, start, arbat.timezone), b: local(date, start + 60, arbat.timezone) });
    }

    // 4) выплата: заготовка – сотрудники с отработанной сменой и выплаченной ведомостью
    const payoutStaff: string[] = [];
    for (let i = 0; i < PAYOUTS; i++) {
      const id = await newStaff(100_000 + i);
      payoutStaff.push(id);
      await must('POST', `/staff/${id}/rates`, { validFrom: '2026-01-01', hourlyKop: 60_000, attendanceFeeKop: 0, reason: 'гонка' });
      const s = await must('POST', '/shifts', { staffId: id, branchId: krasny.id, start: local('2026-10-10' as LocalDate, 12 * 60, krasny.timezone), end: local('2026-10-10' as LocalDate, 18 * 60, krasny.timezone) });
      await must('POST', `/shifts/${s.id}/attendance`, { rowVersion: s.rowVersion, status: 'worked', paidMinutes: 120, reason: 'факт' });
    }
    await settle();
    const period = await must('POST', '/payroll/periods', { from: '2026-10-01', to: '2026-10-31' });
    await must('POST', `/payroll/periods/${period.id}/calculate`, {});
    await must('POST', `/payroll/periods/${period.id}/close`, {});
    const statements = (await sql.query<{ id: string }>(`SELECT id FROM app.payroll_statements WHERE period_id = $1 AND staff_id = ANY($2::uuid[])`, [period.id, payoutStaff])).rows.map((r) => r.id);
    for (const id of statements) {
      const st = await must('GET', `/payroll/statements/${id}`);
      const checked = await must('POST', `/payroll/statements/${id}/status`, { rowVersion: st.rowVersion, status: 'checked' });
      const ready = await must('POST', `/payroll/statements/${id}/status`, { rowVersion: checked.rowVersion, status: 'ready' });
      await must('POST', `/payroll/statements/${id}/paid`, { rowVersion: ready.rowVersion, actualPayoutDate: '2026-11-05' });
    }

    // 5) ремонт: заготовка – два ремонта и расходы в кассе
    const category = await one(`SELECT id FROM app.finance_categories WHERE name = 'Прочее' AND kind = 'expense'`);
    const repairOf = async (equipmentId: string | undefined) =>
      (await must('POST', '/repairs', { equipmentId, detectedAt: '2026-11-16T02:00:00Z', brokenAtUnknown: true, symptoms: 'гонка', priority: 'low', impact: 'none' }) as unknown as { repair: { id: string } }).repair.id;
    const repairA = await repairOf(club.equipmentIds['demo-nsk-krasny/VR1']);
    const repairB = await repairOf(club.equipmentIds['demo-nsk-krasny/reserve']);
    const expenses: string[] = [];
    for (let i = 0; i < LINKS; i++) {
      expenses.push((await must('POST', `/branches/${krasny.id}/finance/expense`, { method: 'cash', amountKop: 1_000 + i, categoryId: category.id, occurredAt: '2026-11-16T02:30:00Z', comment: `запчасть ${i}` })).id);
    }

    // ---- гонки
    const measure = async (name: string, run: () => Promise<Reply[][]>) => {
      const t0 = performance.now();
      const rounds = await run();
      const all = rounds.flat();
      console.log(`  ${name}: ${(performance.now() - t0).toFixed(0)} мс всего; ${fmt(all.map((r) => r.ms))}; ${JSON.stringify(tally(all.map((r) => r.code)))}`);
      return rounds;
    };
    console.log(`Гонки Э3: пул API ${POOL}`);
    const shiftBody = (staffId: string, branchId: string) => ({ staffId, branchId, start: '2026-11-18T05:00:00Z', end: '2026-11-18T07:00:00Z' });
    const r1 = await measure('смены в двух филиалах', () => Promise.all(raceStaff.map((id) => Promise.all([api('POST', '/shifts', shiftBody(id, krasny.id)), api('POST', '/shifts', shiftBody(id, arbat.id))]))));
    const r2 = await measure('праздник против брони VR', () =>
      Promise.all(
        slots.map((s) =>
          Promise.all([
            api('POST', `/events/${s.eventId}/resources`, { resourceId: vr1.id, start: s.start, end: s.end }),
            api('POST', `/branches/${krasny.id}/bookings`, { resourceId: vr1.id, start: s.start, end: s.end, client: { clientId: s.clientId } }),
          ]),
        ),
      ),
    );
    const r3 = await measure('две записи одного подарка', () =>
      Promise.all(gifts.map((g) => Promise.all([api('POST', `/gifts/${g.id}/book`, { branchId: arbat.id, start: g.a }), api('POST', `/gifts/${g.id}/book`, { branchId: arbat.id, start: g.b })]))),
    );
    const payoutBody = { place: 'cash', method: 'cash', split: 'by_branch', occurredAt: '2026-11-16T02:40:00Z' };
    const r4 = await measure('двойной расход выплаты', () => Promise.all(statements.map((id) => Promise.all([api('POST', `/payroll/statements/${id}/payout-expense`, payoutBody), api('POST', `/payroll/statements/${id}/payout-expense`, payoutBody)]))));
    const r5 = await measure('расход к двум ремонтам', () =>
      Promise.all(expenses.map((operationId) => Promise.all([api('POST', `/repairs/${repairA}/expense/link`, { operationId }), api('POST', `/repairs/${repairB}/expense/link`, { operationId })]))),
    );

    // ---- инварианты
    await settle();
    const checks: Record<string, number> = {
      'пар пересекающихся живых смен': await n(`SELECT count(*) AS n FROM app.staff_shifts a JOIN app.staff_shifts b ON a.staff_id = b.staff_id AND a.id < b.id WHERE a.period && b.period AND a.status IN ('planned','worked','needs_review') AND b.status IN ('planned','worked','needs_review')`),
      'пар пересекающихся занятий единицы': await n(`SELECT count(*) AS n FROM app.occupancy a JOIN app.occupancy b ON a.unit_id = b.unit_id AND a.id < b.id WHERE a.active AND b.active AND a.period && b.period`),
      'операций с двумя живыми связями': await n(`SELECT count(*) AS n FROM (SELECT operation_id FROM app.finance_operation_links WHERE unlinked_at IS NULL GROUP BY 1 HAVING count(*) > 1) x`),
      'подарков с двумя живыми записями': await n(`SELECT count(*) AS n FROM (SELECT gift_id FROM app.gift_uses WHERE status IN ('held','booked','used') GROUP BY 1 HAVING count(*) > 1) x`),
      'ведомостей с расходом не на сумму выплаты': await n(
        `SELECT count(*) AS n FROM app.payroll_statements st WHERE st.id = ANY($1::uuid[]) AND (st.totals->>'toPayKop')::bigint <>
           COALESCE((SELECT sum(fo.amount_kop) FROM app.finance_operation_links l JOIN journal.finance_operations fo ON fo.id = l.operation_id WHERE l.ref_id = st.id AND l.role = 'payout_expense' AND l.unlinked_at IS NULL), 0)`,
        [statements],
      ),
    };
    const report = (await runReconcile(pool, { trigger: 'manual', clock, logger: { info: () => undefined, error: () => undefined } }))!;
    const winners: Record<string, [number, number]> = {
      смены: [r1.filter((p) => p.filter((r) => r.status === 201).length === 1).length, SHIFT_STAFF],
      'слоты VR': [r2.filter((p) => p.filter((r) => r.status < 300).length === 1).length, VR_SLOTS],
      подарки: [r3.filter((p) => p.filter((r) => r.status === 201).length === 1).length, GIFTS],
      выплаты: [r4.filter((p) => p.filter((r) => r.status === 201).length === 1).length, statements.length],
      'расходы ремонта': [r5.filter((p) => p.filter((r) => r.status < 300).length === 1).length, LINKS],
    };
    const errors5xx = [...r1, ...r2, ...r3, ...r4, ...r5].flat().filter((r) => r.status >= 500).length;
    console.log(`  база: ${JSON.stringify(checks)}`);
    console.log(`  ровно один победитель: ${JSON.stringify(winners)}`);
    console.log(`  сверка S3-95: ${report.status}, расхождений ${report.discrepancies.length}, проверено ${JSON.stringify(report.checked)}`);
    const bad = Object.entries(checks).filter(([, v]) => v !== 0);
    const noWinner = Object.entries(winners).filter(([, [got, want]]) => got !== want);
    if (bad.length || noWinner.length || errors5xx || report.status !== 'ok') {
      failed = true;
      console.error(`ПРОВАЛ: инварианты ${JSON.stringify(Object.fromEntries(bad))}, победители ${JSON.stringify(Object.fromEntries(noWinner))}, 5xx=${errors5xx}, сверка ${JSON.stringify(report.discrepancies.slice(0, 5))}`);
    } else {
      console.log(`ОК: живых пересечений нет, в каждой гонке один победитель, сверка без расхождений`);
    }
  } finally {
    clearSubscriptions();
    await app?.close();
    await pool?.end();
    await sql?.end();
    await pgServer.stop();
    await rm(dir, { recursive: true, force: true });
  }
  if (failed) process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

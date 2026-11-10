// D5-12: снимок сводки на 60 с на процесс. Тот же сотрудник, зона, права, фильтр и период – тот же снимок (computedAt не меняется,
// соединение пула отчётов не берётся); другое из этого – свой расчёт; старше 60 с – заново; ошибка не кэшируется.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { cachedDashboard, DASHBOARD_TTL_MS, dashboardKey, type DashboardResult } from '../../apps/api/src/modules/reports/dashboard.ts';
import { createReportsPool, type ReportParams } from '../../apps/api/src/modules/reports/framework.ts';
import { hashPassword, staffAuthConfig } from '../../apps/api/src/modules/staff/auth.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const P: ReportParams = { period: { from: '2026-10-01', to: '2026-10-31' } as ReportParams['period'] };
const ctx = (over: Partial<AccessContext> = {}): AccessContext => ({
  actor: { kind: 'staff', staffId: 's1', sessionId: randomUUID() }, role: 'director', network: false, cityIds: new Set(), branchIds: new Set(['b1', 'b2']), at: new Date(), ...over,
});
const result = (n: number): DashboardResult => ({ cards: [], period: P.period, prevPeriod: P.period, dayRule: '', computedAt: `t${n}` });

describe('снимок сводки (D5-12)', () => {
  it('ключ: другая сессия и порядок зоны – тот же; другой сотрудник, роль, зона, право, фильтр, период – другой', () => {
    const k = dashboardKey(ctx(), P);
    expect(dashboardKey(ctx({ branchIds: new Set(['b2', 'b1']) }), P)).toBe(k);
    const differ = [
      dashboardKey(ctx({ actor: { kind: 'staff', staffId: 's2', sessionId: 'x' } }), P),
      dashboardKey(ctx({ role: 'admin' }), P),
      dashboardKey(ctx({ branchIds: new Set(['b1']) }), P),
      dashboardKey(ctx({ grants: new Map([['finance.view', { cityIds: new Set<string>(), branchIds: new Set(['b1']) }]]) }), P),
      dashboardKey(ctx(), { ...P, branchIds: ['b1'] }),
      dashboardKey(ctx(), { period: { ...P.period, to: '2026-10-30' as ReportParams['period']['to'] } }),
    ];
    for (const x of differ) expect(x).not.toBe(k);
  });

  it('в пределах 60 с – тот же снимок; позже – расчёт заново; ошибка не остаётся в кэше', async () => {
    const owner = {};
    let n = 0;
    const compute = async () => result(++n);
    expect((await cachedDashboard(owner, 'k', compute, 1_000)).computedAt).toBe('t1');
    expect((await cachedDashboard(owner, 'k', compute, 1_000 + DASHBOARD_TTL_MS - 1)).computedAt).toBe('t1');
    expect((await cachedDashboard(owner, 'other', compute, 1_000)).computedAt).toBe('t2');
    expect((await cachedDashboard(owner, 'k', compute, 1_000 + DASHBOARD_TTL_MS)).computedAt).toBe('t3');
    await expect(cachedDashboard(owner, 'bad', () => Promise.reject(new Error('сбой')), 5_000)).rejects.toThrow('сбой');
    expect((await cachedDashboard(owner, 'bad', compute, 5_001)).computedAt).toBe('t4');
    expect((await cachedDashboard({}, 'k', compute, 1_000)).computedAt).toBe('t5'); // другой пул (процесс) – свой кэш
  });
});

describe('№239 по HTTP: повтор сводки соединение отчётов не берёт', () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let reports: pg.Pool;
  let connects = 0;
  let app: ReturnType<typeof buildServer>;
  let cookie: string;
  const PASSWORD = 'Пароль-сводки-проверка-1';

  beforeAll(async () => {
    db = await createTestDatabase({ migrate: true });
    pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
    reports = createReportsPool(db.reportsUrl);
    const connect = reports.connect.bind(reports);
    reports.connect = (() => ((connects += 1), connect())) as typeof reports.connect;
    app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), { staff: { pool, auth: staffAuthConfig('t'.repeat(40)), clock: fixedClock('2026-11-20T05:00:00Z') }, reports: { pool: reports } });
    await db.client.query(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('В', 'В', 'dash@yu.test', 'owner', $1)`, [await hashPassword(PASSWORD)]);
    const res = await app.inject({ method: 'POST', url: '/api/crm/v1/auth/login', payload: { email: 'dash@yu.test', password: PASSWORD } });
    cookie = String(res.headers['set-cookie']).split(';')[0]!;
  }, 60_000);
  afterAll(async () => {
    await app.close();
    await reports.end();
    await pool.end();
    await db.drop();
  });

  it('второй запрос того же периода – тот же computedAt и ни одного соединения; другой период – расчёт', async () => {
    const get = (qs: string) => app.inject({ method: 'GET', url: `/api/crm/v1/reports/dashboard?${qs}`, headers: { cookie } });
    const first = await get('from=2026-10-01&to=2026-10-31');
    expect(first.statusCode).toBe(200);
    const used = connects;
    expect(used).toBeGreaterThan(0);
    const again = await get('from=2026-10-01&to=2026-10-31');
    expect(again.json().computedAt).toBe(first.json().computedAt);
    expect(again.json().cards).toEqual(first.json().cards);
    expect(connects).toBe(used);
    expect((await get('from=2026-09-01&to=2026-09-30')).statusCode).toBe(200);
    expect(connects).toBeGreaterThan(used);
  });
});

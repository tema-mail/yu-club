// S3-20: K18 №311–317 по HTTP: весь путь от смены до расхода; IDOR; Директор не ставит ставку, не закрывает период, не отмечает выплату (403);
// Администратор – 403 на всё, кроме своих смен; ПДн зарплаты: журнал и timeline без сумм и ставок для Администратора, сетевые записи – только Владельцу.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import { clearSubscriptions, processEvent } from '../../apps/api/src/core/outbox.ts';
import { localToInstant, type LocalDate, type LocalTime, type TimeZone } from '../../apps/api/src/core/time.ts';
import { HANDLER_ATTENDANCE, HANDLER_RATE, registerPayrollHandlers } from '../../apps/api/src/modules/shifts/accrual.ts';
import { MONEY_MASK, maskMoney } from '../../apps/api/src/modules/shifts/routes.payroll.ts';
import { hashPassword, staffAuthConfig } from '../../apps/api/src/modules/staff/auth.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const PASSWORD = 'Пароль-зарплаты-проверка-1';
const BASE = '/api/crm/v1';
const TZ = 'Asia/Novosibirsk' as TimeZone;
const NOW = new Date('2026-11-14T05:00:00Z');
const clock = { now: () => NOW };
const at = (time: string, date: string) => localToInstant(date as LocalDate, time as LocalTime, TZ).toISOString();
let db: TestDatabase;
let pool: pg.Pool;
let app: FastifyInstance;
const cookies: Record<string, string> = {};
const ids: Record<string, string> = {};

async function staff(key: string, role: string, branch?: string): Promise<void> {
  const r = await db.client.query<{ id: string }>(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', $1, $2, $3) RETURNING id`, [`${key}@yu.test`, role, await hashPassword(PASSWORD)]);
  ids[key] = r.rows[0]!.id;
  if (branch) await db.client.query(`INSERT INTO app.staff_assignments (staff_id, scope_type, branch_id, valid_from, created_by) VALUES ($1, 'branch', $2, '2026-01-01', $1)`, [ids[key], branch]);
  const res = await app.inject({ method: 'POST', url: `${BASE}/auth/login`, payload: { email: `${key}@yu.test`, password: PASSWORD } });
  cookies[key] = String(res.headers['set-cookie']).split(';')[0]!;
}
function req(who: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object, key: string | null = randomUUID()) {
  const headers: Record<string, string> = { cookie: cookies[who]! };
  if (key && method !== 'GET') headers['idempotency-key'] = key;
  return app.inject({ method, url: `${BASE}${url}`, headers, ...(payload ? { payload } : {}) });
}
async function settle(): Promise<void> {
  const r = await db.client.query<{ id: string; event_type: string }>(
    `SELECT e.id, e.event_type FROM app.outbox_events e WHERE e.event_type IN ('shift.attendance_changed','staff.rate_set') AND NOT EXISTS (SELECT 1 FROM app.processed_events p WHERE p.event_id = e.id) ORDER BY e.occurred_at, e.id`,
  );
  for (const e of r.rows) await processEvent(pool, e.event_type === 'staff.rate_set' ? HANDLER_RATE : HANDLER_ATTENDANCE, e.id, clock.now());
}
/** Смена с фактом в прошлом через HTTP. */
async function workedShift(staffKey: string, branch: string, date: string, minutes: number): Promise<string> {
  const s = await req('owner', 'POST', '/shifts', { staffId: ids[staffKey], branchId: ids[branch], start: at('12:00', date), end: at('18:00', date) });
  expect(s.statusCode, s.body).toBe(201);
  const a = await req('owner', 'POST', `/shifts/${s.json().id}/attendance`, { rowVersion: 1, status: 'worked', paidMinutes: minutes, reason: 'факт' });
  expect(a.statusCode, a.body).toBe(200);
  return s.json().id as string;
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 8 });
  clearSubscriptions();
  registerPayrollHandlers({ clock });
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), { staff: { pool, auth: staffAuthConfig('t'.repeat(40)), clock } });
  await staff('owner', 'owner');
  const c = await req('owner', 'POST', '/cities', { slug: 'nsk', name: 'Новосибирск', timezone: TZ });
  for (const slug of ['lenina', 'marksa']) {
    const b = await req('owner', 'POST', '/branches', { cityId: c.json().id, slug, name: slug, address: 'адрес' });
    ids[slug] = b.json().id;
    await db.client.query(`INSERT INTO app.settings_values (key, level, branch_id, value, valid_from, created_by) VALUES ('finance.negative_balance_allowed', 'branch', $1, 'true', '2026-01-01', $2)`, [ids[slug], ids.owner]);
  }
  await staff('director', 'director', ids.lenina);
  await staff('admin', 'admin', ids.lenina);
  await staff('other', 'admin', ids.marksa);
  await db.client.query(`INSERT INTO app.settings_values (key, level, value, valid_from, created_by) VALUES ('payroll.penalties_enabled', 'network', 'true', '2026-01-01', $1)`, [ids.owner]);
  for (const key of ['admin', 'other']) {
    const r = await req('owner', 'POST', `/staff/${ids[key]}/rates`, { validFrom: '2026-01-01', hourlyKop: 60_000, attendanceFeeKop: 0, reason: 'старт' });
    expect(r.statusCode, r.body).toBe(201);
  }
});
afterAll(async () => {
  clearSubscriptions();
  await app.close();
  await pool.end();
  await db.drop();
});

describe('путь зарплаты по HTTP', () => {
  let periodId = '';
  let statementId = '';
  let penaltyId = '';

  it('период → смены → штраф → расчёт → закрытие → выплата → расход; Idempotency-Key на выплате и расходе', async () => {
    const p = await req('owner', 'POST', '/payroll/periods', { from: '2026-10-01', to: '2026-10-31' });
    expect(p.statusCode, p.body).toBe(201);
    periodId = p.json().id;
    expect((await req('owner', 'POST', '/payroll/periods', { from: '2026-10-15', to: '2026-11-15' })).json().error.code).toBe('PAYROLL_PERIOD_OVERLAP');

    await workedShift('admin', 'lenina', '2026-10-10', 120);
    await workedShift('other', 'marksa', '2026-10-10', 60);
    const blocked = await req('owner', 'POST', `/payroll/periods/${periodId}/close`, {});
    expect(blocked.json().error.code).toBe('PAYROLL_PERIOD_HAS_UNRESOLVED');
    await settle();

    const pen = await req('director', 'POST', '/payroll/penalties', { staffId: ids.admin, branchId: ids.lenina, date: '2026-10-10', amountKop: 10_000, reason: 'опоздание' });
    expect(pen.statusCode, pen.body).toBe(201);
    penaltyId = pen.json().id;

    const calc = await req('director', 'POST', `/payroll/periods/${periodId}/calculate`, {});
    expect(calc.statusCode, calc.body).toBe(200);
    const items = calc.json() as Array<{ id: string; staffId: string; totals: { toPayKop: number } }>;
    expect(items.map((i) => i.staffId)).toEqual([ids.admin]); // Директор – только своя зона
    expect(items[0]!.totals.toPayKop).toBe(110_000);
    statementId = items[0]!.id;

    const closed = await req('owner', 'POST', `/payroll/periods/${periodId}/close`, {});
    expect(closed.statusCode, closed.body).toBe(200);
    expect(closed.json().status).toBe('closed');

    const st = await req('owner', 'GET', `/payroll/statements/${statementId}`);
    const checked = await req('director', 'POST', `/payroll/statements/${statementId}/status`, { rowVersion: st.json().rowVersion, status: 'checked' });
    expect(checked.statusCode, checked.body).toBe(200);
    const ready = await req('owner', 'POST', `/payroll/statements/${statementId}/status`, { rowVersion: checked.json().rowVersion, status: 'ready' });
    expect(ready.statusCode, ready.body).toBe(200);
    const key = randomUUID();
    const paid = await req('owner', 'POST', `/payroll/statements/${statementId}/paid`, { rowVersion: ready.json().rowVersion, actualPayoutDate: '2026-11-05' }, key);
    expect(paid.statusCode, paid.body).toBe(200);
    expect(paid.json()).toMatchObject({ status: 'paid', actualPayoutDate: '2026-11-05' });
    const replay = await req('owner', 'POST', `/payroll/statements/${statementId}/paid`, { rowVersion: ready.json().rowVersion, actualPayoutDate: '2026-11-05' }, key);
    expect(replay.headers['idempotent-replay']).toBe('true');

    const expenseKey = randomUUID();
    const body = { place: 'cash', method: 'cash', split: 'by_branch', occurredAt: '2026-11-14T04:00:00Z' };
    const e1 = await req('owner', 'POST', `/payroll/statements/${statementId}/payout-expense`, body, expenseKey);
    expect(e1.statusCode, e1.body).toBe(201);
    expect((e1.json().operations as Array<{ amountKop: number }>).map((o) => o.amountKop)).toEqual([110_000]);
    const e2 = await req('owner', 'POST', `/payroll/statements/${statementId}/payout-expense`, body);
    expect(e2.json().error.code).toBe('PAYOUT_EXPENSE_EXISTS');
    const c = await req('owner', 'POST', '/payroll/corrections', { staffId: ids.admin, amountKop: 500, ref: { type: 'payroll_statement', id: statementId }, reason: 'недоплата' });
    expect(c.statusCode, c.body).toBe(201);
  });

  it('Директор не ставит ставку, не закрывает период, не отмечает выплату, не корректирует – 403, отказ в аудите', async () => {
    const p2 = await req('owner', 'POST', '/payroll/periods', { from: '2026-09-01', to: '2026-09-30' });
    expect((await req('director', 'POST', `/staff/${ids.admin}/rates`, { validFrom: '2026-02-01', hourlyKop: 1, attendanceFeeKop: 1, reason: 'x' })).statusCode).toBe(403);
    expect((await req('director', 'POST', '/payroll/periods', { from: '2026-08-01', to: '2026-08-31' })).statusCode).toBe(403);
    const close = await req('director', 'POST', `/payroll/periods/${p2.json().id}/close`, {});
    expect(close.statusCode).toBe(403);
    expect((await req('director', 'POST', `/payroll/statements/${statementId}/paid`, { rowVersion: 1, actualPayoutDate: '2026-11-05' })).statusCode).toBe(403);
    expect((await req('director', 'POST', `/payroll/statements/${statementId}/payout-expense`, { place: 'cash', method: 'cash', split: { branchId: ids.lenina }, occurredAt: '2026-11-14T04:00:00Z' })).statusCode).toBe(403);
    expect((await req('director', 'POST', '/payroll/corrections', { staffId: ids.admin, amountKop: 1, ref: { type: 'payroll_statement', id: statementId }, reason: 'x' })).statusCode).toBe(403);
    const denied = await db.client.query(`SELECT 1 FROM journal.audit_events WHERE action = 'payroll.period.closed' AND result = 'denied' AND object_id = $1`, [p2.json().id]);
    expect(denied.rows).toHaveLength(1);
  });

  it('Администратор – 403 на всё про зарплату, в том числе на существующие объекты; свои смены видит', async () => {
    const routes: Array<['GET' | 'POST', string, object?]> = [
      ['GET', '/payroll/periods'],
      ['POST', '/payroll/periods', { from: '2026-07-01', to: '2026-07-31' }],
      ['POST', `/payroll/periods/${periodId}/close`, {}],
      ['POST', `/payroll/periods/${periodId}/calculate`, {}],
      ['GET', `/payroll/periods/${periodId}/statements`],
      ['GET', `/payroll/statements/${statementId}`],
      ['POST', `/payroll/statements/${statementId}/status`, { rowVersion: 1, status: 'checked' }],
      ['POST', `/payroll/statements/${statementId}/paid`, { rowVersion: 1, actualPayoutDate: '2026-11-05' }],
      ['POST', `/payroll/statements/${statementId}/payout-expense`, {}],
      ['POST', `/payroll/statements/${statementId}/payout-expense/link`, {}],
      ['GET', '/payroll/penalties'],
      ['POST', '/payroll/penalties', { staffId: ids.admin, date: '2026-11-01', amountKop: 1, reason: 'x' }],
      ['POST', `/payroll/penalties/${penaltyId}/cancel`, { reason: 'x' }],
      ['POST', `/payroll/penalties/${penaltyId}/amend`, { why: 'x' }],
      ['POST', '/payroll/corrections', {}],
      ['GET', '/payroll/audit'],
    ];
    for (const [method, url, payload] of routes) {
      const r = await req('admin', method, url, payload);
      expect(r.statusCode, `${method} ${url}: ${r.body}`).toBe(403);
    }
    const own = await req('admin', 'GET', '/shifts?from=2026-10-01&to=2026-10-31');
    expect(own.statusCode).toBe(200);
    expect((own.json().items as Array<{ staffId: string }>).some((s) => s.staffId === ids.admin)).toBe(true);
  });

  it('IDOR: ведомость и штраф другого филиала и несуществующие – 404 Директору', async () => {
    const list = await req('owner', 'GET', `/payroll/periods/${periodId}/statements`);
    const foreign = (list.json().items as Array<{ id: string; staffId: string }>).find((s) => s.staffId === ids.other)!;
    const clean = (b: { error: Record<string, unknown> }) => ({ ...b.error, requestId: undefined });
    for (const url of [`/payroll/statements/${foreign.id}`, `/payroll/statements/${randomUUID()}`]) {
      expect((await req('director', 'GET', url)).statusCode).toBe(404);
    }
    const a = await req('director', 'GET', `/payroll/statements/${foreign.id}`);
    const b = await req('director', 'GET', `/payroll/statements/${randomUUID()}`);
    expect(clean(a.json())).toEqual(clean(b.json()));
    expect((await req('director', 'POST', `/payroll/statements/${foreign.id}/status`, { rowVersion: 1, status: 'checked' })).statusCode).toBe(404);
    const zone = await req('director', 'GET', `/payroll/periods/${periodId}/statements`);
    expect((zone.json().items as Array<{ staffId: string }>).map((s) => s.staffId)).toEqual([ids.admin]);
    const otherPen = await req('owner', 'POST', '/payroll/penalties', { staffId: ids.other, branchId: ids.marksa, date: '2026-11-01', amountKop: 100, reason: 'x' });
    expect((await req('director', 'POST', `/payroll/penalties/${otherPen.json().id}/cancel`, { reason: 'x' })).statusCode).toBe(404);
    expect((await req('director', 'POST', '/payroll/penalties', { staffId: ids.other, branchId: ids.marksa, date: '2026-11-01', amountKop: 100, reason: 'x' })).statusCode).toBe(404);
    expect((await req('director', 'GET', `/payroll/penalties?staffId=${ids.other}`)).json().items).toEqual([]);
  });

  it('ПДн: журнал зарплаты – только в зоне; ставки и сетевые записи – только Владельцу; timeline смены без права – маска, факт виден', async () => {
    const ownerLog = await req('owner', 'GET', '/payroll/audit?limit=100');
    const actions = (ownerLog.json().items as Array<{ action: string }>).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['staff.rate_set', 'payroll.period.closed', 'payroll.penalty.created', 'payroll.paid']));

    const directorLog = await req('director', 'GET', '/payroll/audit?limit=100');
    const seen = directorLog.json().items as Array<{ action: string; branchId: string | null }>;
    expect(seen.map((e) => e.action)).toContain('payroll.penalty.created');
    expect(seen.map((e) => e.action)).not.toContain('staff.rate_set');
    for (const e of seen) expect(e.branchId).toBe(ids.lenina);

    // /audit/timeline: объекты зарплаты не-Владельцу не отдаются, ставка – только Владельцу
    const rate = await db.client.query<{ object_id: string }>(`SELECT object_id FROM journal.audit_events WHERE action = 'staff.rate_set' LIMIT 1`);
    const rateId = rate.rows[0]!.object_id;
    expect((await req('owner', 'GET', `/audit/timeline?objectType=staff_rate&objectId=${rateId}`)).statusCode).toBe(200);
    for (const who of ['director', 'admin']) {
      expect((await req(who, 'GET', `/audit/timeline?objectType=staff_rate&objectId=${rateId}`)).statusCode).toBe(404);
      expect((await req(who, 'GET', `/audit/timeline?objectType=payroll_statement&objectId=${statementId}`)).statusCode).toBe(404);
      expect((await req(who, 'GET', `/audit/timeline?objectType=payroll_penalty&objectId=${penaltyId}`)).statusCode).toBe(404);
    }

    // timeline смены: корректировка со ссылкой на смену несёт сумму
    const shiftId = await workedShift('admin', 'lenina', '2026-11-03', 60);
    await settle();
    const fix = await req('owner', 'POST', '/payroll/corrections', { staffId: ids.admin, amountKop: 7_777, ref: { type: 'shift', id: shiftId }, reason: 'премия за смену' });
    expect(fix.statusCode, fix.body).toBe(201);
    const asDirector = await req('director', 'GET', `/shifts/${shiftId}/timeline`);
    const dirEvent = (asDirector.json().items as Array<{ action: string; after: { amountKop: unknown } }>).find((e) => e.action === 'payroll.correction.posted')!;
    expect(dirEvent.after.amountKop).toBe(7_777);
  });

  it('Администратор в timeline видит факт события, но не сумму; чужая смена вне зоны – 404', async () => {
    const shifts = await db.client.query<{ object_id: string; branch_id: string }>(`SELECT object_id, branch_id FROM journal.audit_events WHERE action = 'payroll.correction.posted' AND object_type = 'shift' LIMIT 1`);
    const shiftId = shifts.rows[0]!.object_id;
    const r = await req('admin', 'GET', `/shifts/${shiftId}/timeline`);
    expect(r.statusCode, r.body).toBe(200);
    const ev = (r.json().items as Array<{ action: string; after: { amountKop: unknown; staffId: string }; reason: string }>).find((e) => e.action === 'payroll.correction.posted')!;
    expect(ev.after.amountKop).toBe(MONEY_MASK);
    expect(ev.after.staffId).toBe(ids.admin);
    expect((await req('other', 'GET', `/shifts/${shiftId}/timeline`)).statusCode).toBe(404);
  });

  it('maskMoney: ключи сумм и ставок на любой глубине, остальное как есть', () => {
    expect(maskMoney({ hourlyKop: 1, staffId: 'x', nested: [{ attendanceFeeKop: 2, ok: true }], toPayKop: 3, totals: { a: 1 }, reason: 'r', parts: [1] })).toEqual({
      hourlyKop: MONEY_MASK,
      staffId: 'x',
      nested: [{ attendanceFeeKop: MONEY_MASK, ok: true }],
      toPayKop: MONEY_MASK,
      totals: MONEY_MASK,
      reason: 'r',
      parts: MONEY_MASK,
    });
    expect(maskMoney(null)).toBeNull();
  });
});

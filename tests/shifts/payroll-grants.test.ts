// S3-88: делегированный payroll.view по HTTP (K1 «Делегирование», Q-156): раздел открыт, суммы – только зоны права.
// Администратор назначен в Ленина и Маркса, право – на Ленина: Маркса остаётся закрыта, хотя в зоне его роли.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import { clearSubscriptions, processEvent } from '../../apps/api/src/core/outbox.ts';
import { localToInstant, type LocalDate, type LocalTime, type TimeZone } from '../../apps/api/src/core/time.ts';
import { HANDLER_ATTENDANCE, HANDLER_RATE, registerPayrollHandlers } from '../../apps/api/src/modules/shifts/accrual.ts';
import { hashPassword, staffAuthConfig } from '../../apps/api/src/modules/staff/auth.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const PASSWORD = 'Пароль-делегирования-1';
const BASE = '/api/crm/v1';
const TZ = 'Asia/Novosibirsk' as TimeZone;
const clock = { now: () => new Date('2026-11-14T05:00:00Z') };
const at = (time: string, date: string) => localToInstant(date as LocalDate, time as LocalTime, TZ).toISOString();
let db: TestDatabase;
let pool: pg.Pool;
let app: FastifyInstance;
const cookies: Record<string, string> = {};
const ids: Record<string, string> = {};
let periodId = '';
let statementId = '';
let shiftLenina = '';
let shiftMarksa = '';

async function staff(key: string, role: string, branches: string[] = []): Promise<void> {
  const r = await db.client.query<{ id: string }>(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', $1, $2, $3) RETURNING id`, [`${key}@yu.test`, role, await hashPassword(PASSWORD)]);
  ids[key] = r.rows[0]!.id;
  for (const b of branches) await db.client.query(`INSERT INTO app.staff_assignments (staff_id, scope_type, branch_id, valid_from, created_by) VALUES ($1, 'branch', $2, '2026-01-01', $1)`, [ids[key], b]);
  const res = await app.inject({ method: 'POST', url: `${BASE}/auth/login`, payload: { email: `${key}@yu.test`, password: PASSWORD } });
  cookies[key] = String(res.headers['set-cookie']).split(';')[0]!;
}
function req(who: string, method: 'GET' | 'POST', url: string, payload?: object) {
  const headers: Record<string, string> = { cookie: cookies[who]! };
  if (method !== 'GET') headers['idempotency-key'] = randomUUID();
  return app.inject({ method, url: `${BASE}${url}`, headers, ...(payload ? { payload } : {}) });
}
async function settle(): Promise<void> {
  const r = await db.client.query<{ id: string; event_type: string }>(
    `SELECT e.id, e.event_type FROM app.outbox_events e WHERE e.event_type IN ('shift.attendance_changed','staff.rate_set') AND NOT EXISTS (SELECT 1 FROM app.processed_events p WHERE p.event_id = e.id) ORDER BY e.occurred_at, e.id`,
  );
  for (const e of r.rows) await processEvent(pool, e.event_type === 'staff.rate_set' ? HANDLER_RATE : HANDLER_ATTENDANCE, e.id, clock.now());
}
async function worked(who: string, branch: string, minutes: number): Promise<string> {
  const s = await req('owner', 'POST', '/shifts', { staffId: ids[who], branchId: ids[branch], start: at(branch === 'lenina' ? '10:00' : '15:00', '2026-10-10'), end: at(branch === 'lenina' ? '14:00' : '19:00', '2026-10-10') });
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
  }
  await staff('colleague', 'admin', [ids.lenina!, ids.marksa!]);
  await staff('only_marksa', 'admin', [ids.marksa!]);
  await staff('deleg', 'admin', [ids.lenina!, ids.marksa!]);
  await db.client.query(`INSERT INTO app.settings_values (key, level, value, valid_from, created_by) VALUES ('payroll.penalties_enabled', 'network', 'true', '2026-01-01', $1)`, [ids.owner]);
  const rate = await req('owner', 'POST', `/staff/${ids.colleague}/rates`, { validFrom: '2026-01-01', hourlyKop: 60_000, attendanceFeeKop: 0, reason: 'старт' });
  expect(rate.statusCode, rate.body).toBe(201);
  const p = await req('owner', 'POST', '/payroll/periods', { from: '2026-10-01', to: '2026-10-31' });
  periodId = p.json().id;
  shiftLenina = await worked('colleague', 'lenina', 60);
  shiftMarksa = await worked('colleague', 'marksa', 120);
  await settle();
  for (const branch of ['lenina', 'marksa']) {
    const pen = await req('owner', 'POST', '/payroll/penalties', { staffId: ids.colleague, branchId: ids[branch], date: '2026-10-10', amountKop: 1_000, reason: `штраф ${branch}` });
    expect(pen.statusCode, pen.body).toBe(201);
  }
  const calc = await req('owner', 'POST', `/payroll/periods/${periodId}/calculate`, {});
  statementId = (calc.json() as Array<{ id: string; staffId: string }>).find((x) => x.staffId === ids.colleague)!.id;
});
afterAll(async () => {
  clearSubscriptions();
  await app.close();
  await pool.end();
  await db.drop();
});

describe('делегированный payroll.view', () => {
  it('без права – 403 на весь раздел', async () => {
    for (const url of ['/payroll/report?from=2026-10-01&to=2026-10-31', `/payroll/statements/${statementId}`, '/payroll/penalties', '/payroll/periods']) {
      expect((await req('deleg', 'GET', url)).statusCode, url).toBe(403);
    }
    expect((await req('deleg', 'GET', `/staff/${ids.colleague}/rates`)).statusCode).toBe(403);
    expect((await req('deleg', 'GET', `/shifts/${shiftLenina}`)).json().factAccrualKop).toBeNull();
  });

  it('с правом на Ленина: суммы Ленина видны, Маркса – нет ни в одном разделе', async () => {
    await db.client.query(`INSERT INTO app.staff_grants (staff_id, action, scope_type, branch_id, valid_from, granted_by) VALUES ($1, 'payroll.view', 'branch', $2, '2026-11-01', $3)`, [ids.deleg, ids.lenina, ids.owner]);

    const rep = await req('deleg', 'GET', '/payroll/report?from=2026-10-01&to=2026-10-31');
    expect(rep.statusCode, rep.body).toBe(200);
    const accrued = rep.json().totals.accruedKop as number;
    expect(accrued).toBe(60_000);
    expect((await req('deleg', 'GET', `/payroll/report?from=2026-10-01&to=2026-10-31&branchIds=${ids.marksa}`)).statusCode).toBe(404);
    expect((await req('owner', 'GET', '/payroll/report?from=2026-10-01&to=2026-10-31')).json().totals.accruedKop).toBe(180_000);

    const st = await req('deleg', 'GET', `/payroll/statements/${statementId}`);
    expect(st.statusCode, st.body).toBe(200);
    expect((st.json().byBranch as Array<{ branchId: string }>).map((l) => l.branchId)).toEqual([ids.lenina]);

    const pen = await req('deleg', 'GET', '/payroll/penalties');
    expect(pen.statusCode, pen.body).toBe(200);
    expect((pen.json().items as Array<{ branchId: string }>).map((x) => x.branchId)).toEqual([ids.lenina]);

    expect((await req('deleg', 'GET', `/shifts/${shiftLenina}`)).json().factAccrualKop).toBe(60_000);
    expect((await req('deleg', 'GET', `/shifts/${shiftMarksa}`)).json().factAccrualKop).toBeNull();

    expect((await req('deleg', 'GET', `/staff/${ids.colleague}/rates`)).statusCode).toBe(200); // коллега на обоих филиалах – найден филиал права
    expect((await req('deleg', 'GET', `/staff/${ids.only_marksa}/rates`)).statusCode).toBe(403); // только Маркса: зона роли, без права
  });

  it('команды и остальные действия право не открывает', async () => {
    const pen = await req('deleg', 'POST', '/payroll/penalties', { staffId: ids.colleague, branchId: ids.lenina, date: '2026-10-10', amountKop: 1_000, reason: 'нельзя' });
    expect(pen.statusCode).toBe(403);
    expect((await req('deleg', 'POST', `/payroll/periods/${periodId}/calculate`, {})).statusCode).toBe(403);
    expect((await req('deleg', 'POST', `/payroll/statements/${statementId}/paid`, {})).statusCode).toBe(403);
  });

  it('отзыв действует со следующего запроса', async () => {
    await db.client.query(`UPDATE app.staff_grants SET revoked_at = now(), revoked_by = $2 WHERE staff_id = $1`, [ids.deleg, ids.owner]);
    expect((await req('deleg', 'GET', '/payroll/penalties')).statusCode).toBe(403);
    expect((await req('deleg', 'GET', `/shifts/${shiftLenina}`)).json().factAccrualKop).toBeNull();
  });
});

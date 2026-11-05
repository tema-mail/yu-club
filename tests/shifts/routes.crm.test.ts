// S3-14: K18 №301–310 по HTTP. IDOR по каждому маршруту → 404; без payroll.view суммы null; TC-16: Директор зоны {А} не видит смены
// филиала Б; Idempotency-Key – повтор возвращает ту же смену; «мои изменения» с отметкой; ставки и «временно не работает».
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import { localToInstant, type LocalDate, type LocalTime, type TimeZone } from '../../apps/api/src/core/time.ts';
import { hashPassword, staffAuthConfig } from '../../apps/api/src/modules/staff/auth.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const PASSWORD = 'Пароль-смены-проверка-1';
const BASE = '/api/crm/v1';
const TZ = 'Asia/Novosibirsk' as TimeZone;
const DAY = '2026-11-20' as LocalDate;
const at = (time: string, date: LocalDate = DAY) => localToInstant(date, time as LocalTime, TZ).toISOString();
let db: TestDatabase;
let pool: pg.Pool;
let app: FastifyInstance;
const cookies: Record<string, string> = {};
const ids: Record<string, string> = {};
const now = { value: new Date('2026-11-14T05:00:00Z') };
const clock = { now: () => now.value };

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

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 6 });
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), { staff: { pool, auth: staffAuthConfig('t'.repeat(40)), clock } });
  await staff('owner', 'owner');
  const c = await req('owner', 'POST', '/cities', { slug: 'nsk', name: 'Новосибирск', timezone: TZ });
  for (const slug of ['lenina', 'marksa']) {
    const b = await req('owner', 'POST', '/branches', { cityId: c.json().id, slug, name: slug, address: 'адрес' });
    ids[slug] = b.json().id;
  }
  await staff('director', 'director', ids.lenina);
  await staff('admin', 'admin', ids.lenina);
  await staff('other', 'admin', ids.marksa);
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await db.drop();
});

const newShift = async (who: string, staffKey: string, branch: string, from: string, to: string, date: LocalDate = DAY) => {
  const r = await req(who, 'POST', '/shifts', { staffId: ids[staffKey], branchId: ids[branch], start: at(from, date), end: at(to, date) });
  expect(r.statusCode, r.body).toBe(201);
  return r.json<{ id: string; rowVersion: number; plannedAccrualKop: number | null; factAccrualKop: number | null }>();
};

describe('смены по HTTP', () => {
  it('Владелец создаёт, суммы видит; Idempotency-Key: повтор – та же смена и заголовок; нет ключа – 400', async () => {
    await req('owner', 'POST', `/staff/${ids.admin}/rates`, { validFrom: '2026-01-01', hourlyKop: 30_000, attendanceFeeKop: 10_000, reason: 'старт' });
    const key = randomUUID();
    const body = { staffId: ids.admin, branchId: ids.lenina, start: at('10:00'), end: at('12:00') };
    const first = await req('owner', 'POST', '/shifts', body, key);
    expect(first.statusCode).toBe(201);
    expect(first.json().plannedAccrualKop).toBe(70_000);
    const again = await req('owner', 'POST', '/shifts', body, key);
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotent-replay']).toBe('true');
    expect(again.json().id).toBe(first.json().id);
    const noKey = await req('owner', 'POST', '/shifts', { ...body, start: at('13:00'), end: at('14:00') }, null);
    expect(noKey.statusCode).toBe(400);
    expect(noKey.json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('без payroll.view суммы null: Администратор видит график без сумм, в том числе свою смену (Q-108)', async () => {
    const list = await req('admin', 'GET', `/shifts?branchIds=${ids.lenina}&from=${DAY}&to=${DAY}`);
    expect(list.statusCode).toBe(200);
    const items = list.json().items as Array<{ staffId: string; plannedAccrualKop: number | null; factAccrualKop: number | null; plannedMinutes: number }>;
    expect(items.length).toBeGreaterThan(0);
    for (const i of items) {
      expect(i.plannedAccrualKop).toBeNull();
      expect(i.factAccrualKop).toBeNull();
    }
    const asDirector = await req('director', 'GET', `/shifts?from=${DAY}&to=${DAY}`);
    expect((asDirector.json().items as Array<{ plannedAccrualKop: number | null }>)[0]?.plannedAccrualKop).toBe(70_000);
  });

  it('TC-16: Директор зоны {А} не видит смены филиала Б, по прямому id – 404, в списке их нет', async () => {
    const shift = await newShift('owner', 'other', 'marksa', '10:00', '12:00');
    expect((await req('director', 'GET', `/shifts/${shift.id}`)).statusCode).toBe(404);
    expect((await req('director', 'GET', `/shifts?branchIds=${ids.marksa}&from=${DAY}&to=${DAY}`)).statusCode).toBe(404);
    expect((await req('director', 'GET', `/shifts/coverage?branchIds=${ids.marksa}&from=${DAY}&to=${DAY}`)).statusCode).toBe(404);
    const list = await req('director', 'GET', `/shifts?from=${DAY}&to=${DAY}`);
    expect((list.json().items as Array<{ id: string }>).map((i) => i.id)).not.toContain(shift.id);
  });

  it('IDOR: каждый маршрут со сменой другого филиала и несуществующим id – 404 с одним телом', async () => {
    const shift = await newShift('owner', 'other', 'marksa', '13:00', '14:00');
    const routes: Array<['GET' | 'POST' | 'PATCH', string, object?]> = [
      ['GET', `/shifts/${shift.id}`],
      ['PATCH', `/shifts/${shift.id}`, { rowVersion: 1, end: at('15:00'), reason: 'x' }],
      ['POST', `/shifts/${shift.id}/cancel`, { rowVersion: 1, reason: 'x' }],
      ['POST', `/shifts/${shift.id}/check-in`, {}],
      ['POST', `/shifts/${shift.id}/check-out`, {}],
      ['POST', `/shifts/${shift.id}/attendance`, { rowVersion: 1, status: 'no_show', reason: 'x' }],
    ];
    for (const [method, url, payload] of routes) {
      const foreign = await req('director', method, url, payload);
      const missing = await req('director', method, url.replace(shift.id, randomUUID()), payload);
      expect(foreign.statusCode, url).toBe(404);
      expect(missing.statusCode, url).toBe(404);
      const clean = (b: { error: Record<string, unknown> }) => ({ ...b.error, requestId: undefined });
      expect(clean(foreign.json())).toEqual(clean(missing.json()));
    }
    expect((await req('owner', 'GET', `/shifts/${shift.id}`)).statusCode).toBe(200);
    expect((await req('director', 'POST', '/shifts', { staffId: ids.other, branchId: ids.marksa, start: at('15:00'), end: at('16:00') })).statusCode).toBe(404);
  });

  it('свою смену видно, чужую в зоне Администратор видит без сумм, но не правит (403 + отказ в аудите)', async () => {
    const shift = await newShift('owner', 'director', 'lenina', '10:00', '12:00', '2026-11-21' as LocalDate);
    expect((await req('admin', 'GET', `/shifts/${shift.id}`)).json().plannedAccrualKop).toBeNull();
    const denied = await req('admin', 'PATCH', `/shifts/${shift.id}`, { rowVersion: 1, end: at('13:00', '2026-11-21' as LocalDate), reason: 'x' });
    expect(denied.statusCode).toBe(403);
    const audit = await db.client.query(`SELECT result FROM journal.audit_events WHERE action = 'shift.updated' AND object_id = $1 AND result = 'denied'`, [shift.id]);
    expect(audit.rows).toHaveLength(1);
  });

  it('приход и уход сам сотрудник; за другого – 403; факт виден с суммой Директору и без суммы самому', async () => {
    const date = '2026-11-14' as LocalDate; // сегодня: часы сессии двигать на дни нельзя
    const shift = await newShift('owner', 'admin', 'lenina', '11:50', '12:10', date);
    expect((await req('director', 'POST', `/shifts/${shift.id}/check-in`, {})).statusCode).toBe(403);
    const inn = await req('admin', 'POST', `/shifts/${shift.id}/check-in`, {});
    expect(inn.statusCode, inn.body).toBe(200);
    now.value = new Date(now.value.getTime() + 5 * 60_000);
    const out = await req('admin', 'POST', `/shifts/${shift.id}/check-out`, {});
    expect(out.json()).toMatchObject({ status: 'worked', paidMinutes: 5, factAccrualKop: null });
    expect((await req('admin', 'POST', `/shifts/${shift.id}/attendance`, { rowVersion: 3, status: 'no_show', reason: 'x' })).statusCode).toBe(403);
    const fixed = await req('director', 'POST', `/shifts/${shift.id}/attendance`, { rowVersion: 3, status: 'worked', paidMinutes: 100, reason: 'поправка' });
    expect(fixed.json()).toMatchObject({ paidMinutes: 100, paidMinutesSource: 'manual' });
    now.value = new Date('2026-11-14T05:00:00Z');
  });

  it('покрытие в зоне; период больше 31 дня – 400', async () => {
    const r = await req('director', 'GET', `/shifts/coverage?branchIds=${ids.lenina}&from=${DAY}&to=${DAY}`);
    expect(r.statusCode).toBe(200);
    expect(r.json()[0]).toMatchObject({ branchId: ids.lenina, date: DAY, state: 'partial' });
    expect((await req('director', 'GET', `/shifts/coverage?branchIds=${ids.lenina}&from=2026-01-01&to=2026-03-01`)).statusCode).toBe(400);
    expect((await req('director', 'GET', `/shifts?from=2026-01-01&to=2026-03-01`)).statusCode).toBe(400);
  });

  it('№308: чужая правка видна сотруднику до отметки; чужую отметить нельзя (404); отметка – повторно без ошибки', async () => {
    const shift = await newShift('owner', 'admin', 'lenina', '10:00', '12:00', '2026-11-25' as LocalDate);
    const list = await req('admin', 'GET', '/me/shift-changes?unread=true');
    const change = (list.json().items as Array<{ id: string; shiftId: string; kind: string }>).find((c) => c.shiftId === shift.id);
    expect(change?.kind).toBe('created');
    expect((await req('other', 'POST', `/me/shift-changes/${change!.id}/ack`, {})).statusCode).toBe(404);
    const ack = await req('admin', 'POST', `/me/shift-changes/${change!.id}/ack`, {});
    expect(ack.statusCode).toBe(200);
    expect((await req('admin', 'POST', `/me/shift-changes/${change!.id}/ack`, {})).statusCode).toBe(200);
    const unread = await req('admin', 'GET', '/me/shift-changes?unread=true');
    expect((unread.json().items as Array<{ id: string }>).map((c) => c.id)).not.toContain(change!.id);
    const all = await req('admin', 'GET', '/me/shift-changes');
    expect((all.json().items as Array<{ id: string; acknowledgedAt: string | null }>).find((c) => c.id === change!.id)?.acknowledgedAt).not.toBeNull();
  });

  it('№309: Директор видит ставки своей зоны, не ставит (403); чужой зоны – 404; Администратор – 403', async () => {
    expect((await req('director', 'GET', `/staff/${ids.admin}/rates`)).json().items[0]).toMatchObject({ hourlyKop: 30_000 });
    expect((await req('director', 'GET', `/staff/${ids.other}/rates`)).statusCode).toBe(404);
    expect((await req('admin', 'GET', `/staff/${ids.admin}/rates`)).statusCode).toBe(403);
    expect((await req('director', 'POST', `/staff/${ids.admin}/rates`, { validFrom: '2026-02-01', hourlyKop: 1, attendanceFeeKop: 1, reason: 'x' })).statusCode).toBe(403);
    const set = await req('owner', 'POST', `/staff/${ids.admin}/rates`, { validFrom: '2026-02-01', hourlyKop: 31_000, attendanceFeeKop: 10_000, reason: 'индексация' });
    expect(set.statusCode).toBe(201);
    expect(set.json().rate.hourlyKop).toBe(31_000);
    expect(Array.isArray(set.json().affectedShiftIds)).toBe(true);
    expect((await req('owner', 'POST', `/staff/${randomUUID()}/rates`, { validFrom: '2026-02-01', hourlyKop: 1, attendanceFeeKop: 1, reason: 'x' })).statusCode).toBe(404);
  });

  it('№310: Директор ставит «временно не работает», будущие смены в ответе; новая смена – 409 STAFF_ON_LEAVE; вход не отключается', async () => {
    const shift = await newShift('owner', 'other', 'marksa', '10:00', '12:00', '2026-11-26' as LocalDate);
    expect((await req('director', 'PATCH', `/staff/${ids.other}/planning`, { planningStatus: 'on_leave' })).statusCode).toBe(404);
    const r = await req('owner', 'PATCH', `/staff/${ids.other}/planning`, { planningStatus: 'on_leave' });
    expect(r.statusCode).toBe(200);
    expect((r.json().futureShiftsNeedingDecision as Array<{ id: string }>).map((s) => s.id)).toContain(shift.id);
    const denied = await req('owner', 'POST', '/shifts', { staffId: ids.other, branchId: ids.marksa, start: at('13:00', '2026-11-26' as LocalDate), end: at('14:00', '2026-11-26' as LocalDate) });
    expect([denied.statusCode, denied.json().error.code]).toEqual([409, 'STAFF_ON_LEAVE']);
    expect((await req('other', 'GET', '/me/shift-changes')).statusCode).toBe(200);
    await req('owner', 'PATCH', `/staff/${ids.other}/planning`, { planningStatus: 'available' });
  });
});

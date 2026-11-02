// S2-17 по HTTP: K17 №49–50. Администратор открывает и закрывает смену вслепую – expected и diff не получает;
// resolve – только Директор/Владелец, корректировка со ссылкой на смену; IDOR – 404; Idempotency-Key обязателен.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { hashPassword, staffAuthConfig } from '../../apps/api/src/modules/staff/auth.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const PASSWORD = 'Пароль-смены-проверка-1';
const BASE = '/api/crm/v1';
let db: TestDatabase;
let pool: pg.Pool;
let app: FastifyInstance;
const cookies: Record<string, string> = {};
const ids: Record<string, string> = {};
const clock = fixedClock('2026-11-14T05:00:00Z');

async function staff(key: string, role: string, branch?: string): Promise<void> {
  const r = await db.client.query<{ id: string }>(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', $1, $2, $3) RETURNING id`, [`${key}@yu.test`, role, await hashPassword(PASSWORD)]);
  ids[key] = r.rows[0]!.id;
  if (branch) await db.client.query(`INSERT INTO app.staff_assignments (staff_id, scope_type, branch_id, valid_from, created_by) VALUES ($1, 'branch', $2, '2026-01-01', $1)`, [r.rows[0]!.id, branch]);
  const res = await app.inject({ method: 'POST', url: `${BASE}/auth/login`, payload: { email: `${key}@yu.test`, password: PASSWORD } });
  cookies[key] = String(res.headers['set-cookie']).split(';')[0]!;
}
function req(who: string, url: string, payload: object = {}, key: string | null = randomUUID()) {
  const headers: Record<string, string> = { cookie: cookies[who]! };
  if (key) headers['idempotency-key'] = key;
  return app.inject({ method: 'POST', url: `${BASE}${url}`, headers, payload });
}

function get(who: string, url: string) {
  return app.inject({ method: 'GET', url: `${BASE}${url}`, headers: { cookie: cookies[who]! } });
}
const hasKop = (o: object) => Object.keys(o).some((k) => k.endsWith('Kop'));

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), { staff: { pool, auth: staffAuthConfig('t'.repeat(40)), clock } });
  await staff('owner', 'owner');
  const c = await req('owner', '/cities', { slug: 'nsk', name: 'Новосибирск', timezone: 'Asia/Novosibirsk' });
  for (const slug of ['lenina', 'marksa']) {
    ids[slug] = (await req('owner', '/branches', { cityId: c.json().id, slug, name: slug, address: 'адрес' })).json().id;
    await db.client.query(`INSERT INTO app.settings_values (key, level, branch_id, value, valid_from, created_by) VALUES ('finance.cash_shift_enabled', 'branch', $1, 'true', '2026-01-01', $2)`, [ids[slug], ids.owner]);
  }
  await staff('director', 'director', ids.lenina);
  await staff('admin', 'admin', ids.lenina);
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await db.drop();
});

describe('смена в CRM', () => {
  it('Администратор: открытие и закрытие – только id и статус, без expected и diff; Директор решает расхождение', async () => {
    const o = await req('admin', `/branches/${ids.lenina}/cash-shifts/open`, { countedKop: 0 });
    expect(o.statusCode).toBe(201);
    expect(o.json()).toEqual({ shiftId: expect.any(String), status: 'open' });
    expect((await req('admin', `/branches/${ids.lenina}/cash-shifts/open`, { countedKop: 0 })).json().error.code).toBe('CASH_SHIFT_ALREADY_OPEN');
    const inc = await req('owner', `/branches/${ids.lenina}/finance/income`, { method: 'cash', amountKop: 2_000, source: 'other', occurredAt: '2026-11-14T04:00:00Z' });
    expect(inc.json().shiftId).toBe(o.json().shiftId);
    const cl = await req('admin', `/cash-shifts/${o.json().shiftId}/close`, { countedKop: 1_500 });
    expect(cl.statusCode).toBe(200);
    expect(cl.json()).toEqual({ shiftId: o.json().shiftId, status: 'needs_resolution' });
    const no = await req('admin', `/cash-shifts/${o.json().shiftId}/resolve`, { action: 'correct', reason: 'x' });
    expect(no.statusCode).toBe(403);
    const r = await req('director', `/cash-shifts/${o.json().shiftId}/resolve`, { action: 'correct', reason: 'недостача' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      shift: { status: 'resolved', closingExpectedKop: 2_000, closingDiffKop: -500 },
      operation: { kind: 'correction', amountKop: 500, direction: 'out', ref: { type: 'shift', id: o.json().shiftId } },
    });
    const denied = await db.client.query(`SELECT action FROM journal.audit_events WHERE actor_id = $1 AND result = 'denied'`, [ids.admin]);
    expect(denied.rows).toEqual([{ action: 'cash_shift.resolved' }]);
  });

  it('IDOR: №49–50 с чужим филиалом – 404; без Idempotency-Key – 400', async () => {
    const foreign = (await req('owner', `/branches/${ids.marksa}/cash-shifts/open`, { countedKop: 0 })).json();
    expect(foreign).toMatchObject({ status: 'open', openingExpectedKop: 0 }); // Владельцу – полные данные
    for (const who of ['director', 'admin']) {
      expect((await req(who, `/branches/${ids.marksa}/cash-shifts/open`, { countedKop: 0 })).statusCode).toBe(404);
      expect((await req(who, `/cash-shifts/${foreign.shiftId}/close`, { countedKop: 0 })).statusCode).toBe(404);
      expect((await req(who, `/cash-shifts/${foreign.shiftId}/resolve`, { action: 'accept', reason: 'x' })).statusCode).toBe(404);
    }
    expect((await req('admin', `/branches/${ids.lenina}/cash-shifts/open`, { countedKop: 0 }, null)).json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('чтение: текущая смена и список – Администратору без сумм и только свои; Директору с expected/diff; чужой – 404', async () => {
    const B = `/branches/${ids.lenina}/cash-shifts`;
    expect((await get('admin', `${B}/current`)).json()).toEqual({ enabled: true, openShift: null });
    clock.advance(60_000); // разное время открытия – порядок списка «новые сверху» однозначен
    const s2 = (await req('admin', `${B}/open`, { countedKop: 100 })).json().shiftId;
    const cur = await get('admin', `${B}/current`);
    expect(cur.statusCode).toBe(200);
    expect(cur.json()).toEqual({ enabled: true, openShift: { shiftId: s2, branchId: ids.lenina, status: 'open', openedAt: clock.now().toISOString(), openedBy: ids.admin, closedAt: null, closedBy: null } });
    expect((await get('director', `${B}/current`)).json().openShift).toMatchObject({ shiftId: s2, openingCountedKop: 100, openingExpectedKop: 1_500, openingDiffKop: -1_400 });
    await req('admin', `/cash-shifts/${s2}/close`, { countedKop: 100 });
    await req('director', `/cash-shifts/${s2}/resolve`, { action: 'accept', reason: 'приняли' });
    clock.advance(60_000);
    const s3 = (await req('director', `${B}/open`, { countedKop: 100 })).json().shiftId;

    const mine = (await get('admin', B)).json();
    expect(mine.items.map((x: { shiftId: string }) => x.shiftId)).not.toContain(s3); // чужую смену Администратор не видит
    expect(mine.items).toHaveLength(2);
    for (const x of mine.items) expect(hasKop(x)).toBe(false);
    const all = (await get('director', B)).json();
    expect(all.items.map((x: { shiftId: string }) => x.shiftId)[0]).toBe(s3);
    expect(all.items).toHaveLength(3);
    expect(all.items.find((x: { shiftId: string }) => x.shiftId === s2)).toMatchObject({ status: 'resolved', resolution: 'accept', closingExpectedKop: 1_500, closingDiffKop: -1_400 });
    expect((await get('director', `${B}?status=open`)).json().items.map((x: { shiftId: string }) => x.shiftId)).toEqual([s3]);
    const p1 = (await get('director', `${B}?limit=2`)).json();
    expect(p1.items).toHaveLength(2);
    const p2 = (await get('director', `${B}?limit=2&cursor=${encodeURIComponent(p1.nextCursor)}`)).json();
    expect([...p1.items, ...p2.items].map((x: { shiftId: string }) => x.shiftId)).toEqual(all.items.map((x: { shiftId: string }) => x.shiftId));
    expect(p2.nextCursor).toBeNull();
    expect((await get('director', `${B}?status=bad`)).statusCode).toBe(400);

    for (const who of ['director', 'admin']) {
      expect((await get(who, `/branches/${ids.marksa}/cash-shifts/current`)).statusCode).toBe(404);
      expect((await get(who, `/branches/${ids.marksa}/cash-shifts`)).statusCode).toBe(404);
    }
    const off = (await req('owner', '/branches', { cityId: (await db.client.query(`SELECT city_id FROM app.branches WHERE id = $1`, [ids.lenina])).rows[0].city_id, slug: 'off', name: 'off', address: 'адрес' })).json().id;
    expect((await get('owner', `/branches/${off}/cash-shifts/current`)).json()).toEqual({ enabled: false, openShift: null });
  });
});

// S2-14 по HTTP: K17 №37–47. IDOR по каждому маршруту – 404 с телом несуществующего; Администратор видит только
// текущие сутки и без остатков (журнал, ответы команд, предпросмотр); Idempotency-Key: повтор – та же операция.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { hashPassword, staffAuthConfig } from '../../apps/api/src/modules/staff/auth.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const PASSWORD = 'Пароль-кассы-проверка-1';
const BASE = '/api/crm/v1';
let db: TestDatabase;
let pool: pg.Pool;
let app: FastifyInstance;
const cookies: Record<string, string> = {};
const ids: Record<string, string> = {};
const clock = fixedClock('2026-11-14T05:00:00Z'); // 12:00 в Новосибирске
const AT = '2026-11-14T04:00:00Z';

async function staff(key: string, role: string, branch?: string): Promise<void> {
  const r = await db.client.query<{ id: string }>(
    `INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', $1, $2, $3) RETURNING id`,
    [`${key}@yu.test`, role, await hashPassword(PASSWORD)],
  );
  ids[key] = r.rows[0]!.id;
  if (branch) {
    await db.client.query(
      `INSERT INTO app.staff_assignments (staff_id, scope_type, branch_id, valid_from, created_by) VALUES ($1, 'branch', $2, '2026-01-01', $1)`,
      [r.rows[0]!.id, branch],
    );
  }
  const res = await app.inject({ method: 'POST', url: `${BASE}/auth/login`, payload: { email: `${key}@yu.test`, password: PASSWORD } });
  cookies[key] = String(res.headers['set-cookie']).split(';')[0]!;
}

function req(who: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object, key: string | null = randomUUID()) {
  const headers: Record<string, string> = { cookie: cookies[who]! };
  if (key && method !== 'GET') headers['idempotency-key'] = key;
  return app.inject({ method, url: `${BASE}${url}`, headers, ...(payload ? { payload } : {}) });
}
const bodyWithoutRequestId = (b: { error: Record<string, unknown> }) => ({ ...b.error, requestId: undefined });

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), { staff: { pool, auth: staffAuthConfig('t'.repeat(40)), clock } });
  await staff('owner', 'owner');
  const c = await req('owner', 'POST', '/cities', { slug: 'nsk', name: 'Новосибирск', timezone: 'Asia/Novosibirsk' });
  for (const slug of ['lenina', 'marksa']) {
    const b = await req('owner', 'POST', '/branches', { cityId: c.json().id, slug, name: slug, address: 'адрес' });
    ids[slug] = b.json().id;
  }
  await staff('director', 'director', ids.lenina);
  await staff('admin', 'admin', ids.lenina);
  const cat = await db.client.query<{ id: string }>(`SELECT id FROM app.finance_categories WHERE name = 'Прочее'`);
  ids.other = cat.rows[0]!.id;
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await db.drop();
});

const expense = { method: 'cash', amountKop: 1_000, categoryId: '', occurredAt: AT, comment: 'хозтовары' };

describe('касса в CRM', () => {
  it('Владелец: начальный остаток, доход, расход – 201; журнал с остатками в порядке времени', async () => {
    const ob = await req('owner', 'POST', `/branches/${ids.lenina}/finance/opening-balance`, { place: 'cash', amountKop: 100_000, date: '2026-11-14', comment: 'старт' });
    expect(ob.statusCode).toBe(201);
    expect(ob.json()).toMatchObject({ kind: 'opening_balance', balanceAfterKop: 100_000 });
    const inc = await req('owner', 'POST', `/branches/${ids.lenina}/finance/income`, { method: 'card', amountKop: 5_000, source: 'event', occurredAt: AT });
    expect(inc.statusCode).toBe(201);
    const exp = await req('owner', 'POST', `/branches/${ids.lenina}/finance/expense`, { ...expense, categoryId: ids.other });
    expect(exp.json()).toMatchObject({ kind: 'expense', balanceAfterKop: 99_000 });
    ids.expense = exp.json().id;
    const list = await req('owner', 'GET', `/branches/${ids.lenina}/finance/operations?from=2026-11-14`);
    expect(list.statusCode).toBe(200);
    expect(list.json().items.map((o: { kind: string; balanceAfterKop: number }) => [o.kind, o.balanceAfterKop])).toEqual([
      ['opening_balance', 100_000],
      ['income', 5_000],
      ['expense', 99_000],
    ]);
    const page = await req('owner', 'GET', `/branches/${ids.lenina}/finance/operations?limit=2`);
    expect(page.json().items).toHaveLength(2);
    const next = await req('owner', 'GET', `/branches/${ids.lenina}/finance/operations?limit=2&cursor=${page.json().nextCursor}`);
    expect(next.json()).toMatchObject({ items: [{ kind: 'expense' }], nextCursor: null });
    const byText = await req('owner', 'GET', `/branches/${ids.lenina}/finance/operations?q=${encodeURIComponent('хоз')}`);
    expect(byText.json().items.map((o: { id: string }) => o.id)).toEqual([ids.expense]);
  });

  it('Idempotency-Key: повтор – та же операция и заголовок replay; без ключа – 400', async () => {
    const key = randomUUID();
    const body = { method: 'cash', amountKop: 700, source: 'other', occurredAt: AT };
    const a = await req('owner', 'POST', `/branches/${ids.marksa}/finance/income`, body, key);
    const b = await req('owner', 'POST', `/branches/${ids.marksa}/finance/income`, body, key);
    expect(b.headers['idempotent-replay']).toBe('true');
    expect(b.json()).toEqual(a.json());
    const n = await db.client.query(`SELECT count(*)::int AS n FROM journal.finance_operations WHERE branch_id = $1`, [ids.marksa]);
    expect(n.rows[0].n).toBe(1);
    expect((await req('owner', 'POST', `/branches/${ids.marksa}/finance/income`, body, null)).json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('Администратор: расход своего филиала без остатка в ответе; журнал – только сутки и без остатков; предпросмотр – только allowed', async () => {
    const exp = await req('admin', 'POST', `/branches/${ids.lenina}/finance/expense`, { ...expense, categoryId: ids.other, amountKop: 500 });
    expect(exp.statusCode).toBe(201);
    expect(exp.json()).not.toHaveProperty('balanceAfterKop');
    const day = await req('admin', 'GET', `/branches/${ids.lenina}/finance/operations`);
    expect(day.statusCode).toBe(200);
    expect(day.json().items.length).toBeGreaterThan(0);
    for (const o of day.json().items) expect(o).not.toHaveProperty('balanceAfterKop');
    expect((await req('admin', 'GET', `/branches/${ids.lenina}/finance/operations?from=2026-11-13&to=2026-11-14`)).statusCode).toBe(403);
    const short = await req('admin', 'POST', `/branches/${ids.lenina}/finance/expense`, { ...expense, categoryId: ids.other, amountKop: 10_000_000 });
    expect(short.statusCode).toBe(409);
    expect(short.json().error).toMatchObject({ code: 'CASH_INSUFFICIENT', details: { place: 'cash' } });
    expect(short.json().error.details).not.toHaveProperty('currentKop');
    const shortDir = await req('director', 'POST', `/branches/${ids.lenina}/finance/expense`, { ...expense, categoryId: ids.other, amountKop: 10_000_000 });
    expect(shortDir.json().error.details).toMatchObject({ currentKop: 98_500 });
    const pv = await req('admin', 'POST', `/branches/${ids.lenina}/finance/preview`, { place: 'cash', deltaKop: -1_000_000 });
    expect(pv.json()).toEqual({ allowed: false, reason: 'negative_forbidden' });
    const pvOwner = await req('owner', 'POST', `/branches/${ids.lenina}/finance/preview`, { place: 'cash', deltaKop: -500 });
    expect(pvOwner.json()).toEqual({ currentKop: 98_500, afterKop: 98_000, allowed: true, reason: null });
    // ручной доход, изъятие, начальный остаток, сторно – не его
    expect((await req('admin', 'POST', `/branches/${ids.lenina}/finance/income`, { method: 'cash', amountKop: 1, source: 'other', occurredAt: AT })).statusCode).toBe(403);
    expect((await req('admin', 'POST', `/branches/${ids.lenina}/finance/withdrawal`, { amountKop: 1, occurredAt: AT, comment: 'x' })).statusCode).toBe(403);
    expect((await req('admin', 'POST', `/finance/operations/${ids.expense}/reverse`, { reason: 'x' })).statusCode).toBe(403);
    const denied = await db.client.query(`SELECT action, object_type FROM journal.audit_events WHERE actor_id = $1 AND result = 'denied' ORDER BY id`, [ids.admin]);
    expect(denied.rows).toEqual([
      { action: 'finance.operation.created', object_type: 'branch' },
      { action: 'finance.operation.created', object_type: 'branch' },
      { action: 'finance.operation.reversed', object_type: 'finance_operation' },
    ]);
  });

  it('IDOR: каждый маршрут №37–47 с чужим филиалом или его операцией – 404, как несуществующий', async () => {
    const foreignOp = (await db.client.query<{ id: string }>(`SELECT id FROM journal.finance_operations WHERE branch_id = $1 LIMIT 1`, [ids.marksa])).rows[0]!.id;
    const f = ids.marksa;
    const calls: Array<['GET' | 'POST', string, object?]> = [
      ['GET', `/branches/${f}/finance/operations`],
      ['POST', `/branches/${f}/finance/preview`, { place: 'cash', deltaKop: -1 }],
      ['POST', `/branches/${f}/finance/opening-balance`, { place: 'cash', amountKop: 1, date: '2026-11-14', comment: 'x' }],
      ['POST', `/branches/${f}/finance/income`, { method: 'cash', amountKop: 1, source: 'other', occurredAt: AT }],
      ['POST', `/branches/${f}/finance/expense`, { ...expense, categoryId: ids.other }],
      ['POST', `/branches/${f}/finance/withdrawal`, { amountKop: 1, occurredAt: AT, comment: 'x' }],
      ['POST', `/branches/${f}/finance/place-transfer`, { from: 'cash', amountKop: 1, occurredAt: AT, comment: 'x' }],
      ['POST', `/finance/operations/${foreignOp}/reverse`, { reason: 'x' }],
      ['POST', `/finance/operations/${foreignOp}/correct`, { reason: 'x', replacement: { kind: 'income', method: 'cash', amountKop: 1, source: 'other', occurredAt: AT } }],
      ['POST', `/branches/${f}/finance/periods/2026-10/close`],
    ];
    const missing = await req('director', 'GET', `/branches/${randomUUID()}/finance/operations`);
    for (const who of ['director', 'admin']) {
      for (const [method, url, body] of calls) {
        const r = await req(who, method, url, body);
        expect([who, url, r.statusCode]).toEqual([who, url, 404]);
        expect(bodyWithoutRequestId(r.json())).toEqual(bodyWithoutRequestId(missing.json()));
      }
    }
  });

  it('сторно и исправление Владельцем; закрытие месяца; категории – дерево всем, правка – Владельцу', async () => {
    const rev = await req('owner', 'POST', `/finance/operations/${ids.expense}/reverse`, { reason: 'ошибочный чек' });
    expect(rev.statusCode).toBe(201);
    expect(rev.json()).toMatchObject({ kind: 'reversal', reversalOf: ids.expense });
    expect((await req('owner', 'POST', `/finance/operations/${ids.expense}/reverse`, { reason: 'ещё' })).json().error.code).toBe('ALREADY_REVERSED');
    const inc = await req('owner', 'POST', `/branches/${ids.lenina}/finance/income`, { method: 'cash', amountKop: 3_000, source: 'other', occurredAt: AT });
    const cor = await req('owner', 'POST', `/finance/operations/${inc.json().id}/correct`, {
      reason: 'не та сумма', replacement: { kind: 'income', method: 'cash', amountKop: 300, source: 'other', occurredAt: AT },
    });
    expect(cor.statusCode).toBe(201);
    expect(cor.json()).toMatchObject({ reversal: { reversalOf: inc.json().id }, replacement: { amountKop: 300, branchId: ids.lenina } });
    const close = await req('owner', 'POST', `/branches/${ids.lenina}/finance/periods/2026-10/close`);
    expect(close.statusCode).toBe(200);
    expect(close.json()).toMatchObject({ month: '2026-10-01' });
    const late = await req('owner', 'POST', `/branches/${ids.lenina}/finance/income`, { method: 'cash', amountKop: 1, source: 'other', occurredAt: '2026-10-15T05:00:00Z' });
    expect(late.json().error.code).toBe('PERIOD_CLOSED');
    expect((await req('director', 'POST', `/branches/${ids.lenina}/finance/periods/2026-09/close`)).statusCode).toBe(403);

    const tree = await req('admin', 'GET', '/finance/categories?kind=expense');
    expect(tree.statusCode).toBe(200);
    expect(tree.json().items[0]).toMatchObject({ name: 'Коммунальные', children: expect.arrayContaining([expect.objectContaining({ name: 'Электричество' })]) });
    expect((await req('director', 'POST', '/finance/categories', { kind: 'expense', name: 'Новая' })).statusCode).toBe(403);
    const created = await req('owner', 'POST', '/finance/categories', { kind: 'expense', name: 'Новая' });
    expect(created.statusCode).toBe(201);
    const archived = await req('owner', 'PATCH', `/finance/categories/${created.json().id}`, { rowVersion: 1, status: 'archived' });
    expect(archived.json()).toMatchObject({ status: 'archived', rowVersion: 2 });
    const useArchived = await req('owner', 'POST', `/branches/${ids.lenina}/finance/expense`, { ...expense, categoryId: created.json().id });
    expect(useArchived.json().error.code).toBe('CATEGORY_ARCHIVED');
  });
});

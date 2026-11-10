// S2-22 по HTTP: K10 №19–23. allowedMethods считает сервер; Администратор проводит оплату, но не возврат (403 + аудит);
// Idempotency-Key: повтор – тот же paymentId, новый ключ – ALREADY_PAID; код сертификата проверяется до транзакции:
// 6 неверных кодов через оплату → блок; IDOR по каждому маршруту – 404 как несуществующее.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { confirmHold } from '../../apps/api/src/modules/booking/confirm.ts';
import { createHold } from '../../apps/api/src/modules/booking/hold.ts';
import { runOccupancyCommand } from '../../apps/api/src/modules/booking/occupancy.ts';
import { createCertificatePaymentMethod } from '../../apps/api/src/modules/certificates/payment-method.ts';
import { sellCertificate } from '../../apps/api/src/modules/certificates/sale.ts';
import { createBatch, openAccount, postPoints, SYSTEM_AUTHOR } from '../../apps/api/src/modules/loyalty/account.ts';
import { registerPaymentMethod } from '../../apps/api/src/modules/finance/methods.ts';
import { reserveForHold } from '../../apps/api/src/modules/loyalty/reserve.ts';
import { hashPassword, staffAuthConfig } from '../../apps/api/src/modules/staff/auth.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const PASSWORD = 'Пароль-оплаты-проверка-1';
const PEPPER = 'cert-pepper-'.padEnd(40, 'r');
const BASE = '/api/crm/v1';
const clock = fixedClock('2026-11-15T05:00:00Z'); // 12:00 по Новосибирску
let db: TestDatabase;
let pool: pg.Pool;
let app: FastifyInstance;
const cookies: Record<string, string> = {};
const ids: Record<string, string> = {};
let slot = 0;

async function staff(key: string, role: string, branch?: string): Promise<void> {
  const r = await db.client.query<{ id: string }>(
    `INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', $1, $2, $3) RETURNING id`,
    [`${key}@yu.test`, role, await hashPassword(PASSWORD)],
  );
  ids[key] = r.rows[0]!.id;
  if (branch) {
    await db.client.query(`INSERT INTO app.staff_assignments (staff_id, scope_type, branch_id, valid_from, created_by) VALUES ($1, 'branch', $2, '2026-01-01', $1)`, [r.rows[0]!.id, branch]);
  }
  const res = await app.inject({ method: 'POST', url: `${BASE}/auth/login`, payload: { email: `${key}@yu.test`, password: PASSWORD } });
  cookies[key] = String(res.headers['set-cookie']).split(';')[0]!;
}
function req(who: string, method: 'GET' | 'POST', url: string, payload?: object, key: string | null = randomUUID()) {
  const headers: Record<string, string> = { cookie: cookies[who]! };
  if (key && method !== 'GET') headers['idempotency-key'] = key;
  return app.inject({ method, url: `${BASE}${url}`, headers, ...(payload ? { payload } : {}) });
}
const bodyWithoutRequestId = (b: { error: Record<string, unknown> }) => ({ ...b.error, requestId: undefined });

async function booking(branch: string, status = 'arrived', priceKop = 30_000, clientId = ids.client): Promise<string> {
  const start = new Date(Date.parse('2026-11-15T01:00:00Z') + slot++ * 3_600_000);
  const end = new Date(start.getTime() + 3_600_000);
  const res = ids[`pc_${branch}`]!;
  const b = await db.client.query<{ id: string }>(
    `INSERT INTO app.bookings (checkout_id, branch_id, client_id, resource_id, period, price_kop, source, created_by_type, status)
     VALUES (gen_random_uuid(), $1, $2, $3, tstzrange($4, $5, '[)'), $6, 'crm', 'staff', $7) RETURNING id`,
    [branch, clientId, res, start, end, priceKop, status],
  );
  await db.client.query(
    `INSERT INTO journal.booking_versions (booking_id, version, resource_id, period, branch_timezone, unit_ids, resource_snapshot, price_kop, price_snapshot, created_by_type)
     VALUES ($1, 1, $2, tstzrange($3, $4, '[)'), 'Asia/Novosibirsk', ARRAY[gen_random_uuid()], '{"name":"ПК"}', $5, '{}', 'staff')`,
    [b.rows[0]!.id, res, start, end, priceKop],
  );
  return b.rows[0]!.id;
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 6 });
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), { staff: { pool, auth: staffAuthConfig('t'.repeat(40)), clock }, certificates: { pepper: PEPPER } });
  registerPaymentMethod(createCertificatePaymentMethod({ pepper: PEPPER }));
  await staff('owner', 'owner');
  const c = await req('owner', 'POST', '/cities', { slug: 'nsk', name: 'Новосибирск', timezone: 'Asia/Novosibirsk' });
  for (const slug of ['lenina', 'marksa']) {
    const b = await req('owner', 'POST', '/branches', { cityId: c.json().id, slug, name: slug, address: 'адрес' });
    ids[slug] = b.json().id;
    ids[`pc_${b.json().id}`] = (await db.client.query<{ id: string }>(`INSERT INTO app.resources (branch_id, resource_type, name) VALUES ($1, 'pc', 'ПК') RETURNING id`, [b.json().id])).rows[0]!.id;
  }
  await staff('director', 'director', ids.lenina);
  await staff('admin', 'admin', ids.lenina);
  ids.client = (await db.client.query<{ id: string }>(`INSERT INTO app.clients (phone_e164, first_name, status, created_by_type, registered_at) VALUES ('+79130000003', 'К', 'active', 'system', now()) RETURNING id`)).rows[0]!.id;
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await db.drop();
});

describe('оплата в CRM', () => {
  it('№19: допустимые способы считает сервер; после оплаты – пусто и платёж в карточке', async () => {
    const b = await booking(ids.lenina!);
    const v = await req('admin', 'GET', `/bookings/${b}/payment`);
    expect(v.statusCode).toBe(200);
    expect(v.json()).toMatchObject({ session: null, payment: null, refunds: [], amountDueKop: 30_000, topupEnabled: false, pointsAvailableCenti: 0, pointsRequiredCenti: 6_000 });
    expect(v.json().allowedMethods).toEqual(['cash', 'card', 'transfer', 'certificate']); // баллов нет – points не предлагается
    const confirmed = await booking(ids.lenina!, 'confirmed');
    expect((await req('admin', 'GET', `/bookings/${confirmed}/payment`)).json().allowedMethods).toEqual([]);
    const free = await booking(ids.lenina!, 'arrived', 0);
    expect((await req('admin', 'GET', `/bookings/${free}/payment`)).json().allowedMethods).toEqual(['none']);
    await req('admin', 'POST', `/bookings/${b}/payment`, { lines: [{ method: 'cash', amountKop: 30_000 }] });
    const after = (await req('admin', 'GET', `/bookings/${b}/payment`)).json();
    expect(after).toMatchObject({ allowedMethods: [], session: { status: 'paid' }, payment: { status: 'active', lines: [{ method: 'cash' }] } });
  });

  it('№19: свой резерв баллов под эту бронь не вычитается – points предлагается, оплата баллами проходит', async () => {
    const clientId = (await db.client.query<{ id: string }>(`INSERT INTO app.clients (phone_e164, first_name, status, created_by_type, registered_at) VALUES ('+79130000004', 'Р', 'active', 'system', now()) RETURNING id`)).rows[0]!.id;
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await openAccount(c, clientId, clock.now());
      const p = await postPoints(c, clientId, { amount: 6_000, type: 'loyalty.accrual', branchId: null, occurredAt: clock.now() }, randomUUID(), SYSTEM_AUTHOR);
      await createBatch(c, { clientId, entryId: p.entryId, amount: 6_000, balanceBefore: p.balanceBefore, source: 'visit', branchId: null, expiresAt: null, accruedAt: clock.now() });
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    const b = await booking(ids.lenina!, 'arrived', 30_000, clientId);
    await db.client.query(`INSERT INTO app.loyalty_reserves (client_id, amount_centi, booking_id, status) VALUES ($1, 6000, $2, 'booking')`, [clientId, b]);
    const v = (await req('admin', 'GET', `/bookings/${b}/payment`)).json();
    expect(v).toMatchObject({ pointsAvailableCenti: 6_000, pointsRequiredCenti: 6_000 });
    expect(v.allowedMethods).toContain('points');
    const paid = await req('admin', 'POST', `/bookings/${b}/payment`, { lines: [{ method: 'points', amountKop: 30_000 }] });
    expect(paid.statusCode).toBe(201);
    expect(paid.json().session.status).toBe('paid');
  });

  it('№19: бронь из удержания, worker ещё не перенёс резерв удержания на бронь – он не вычитается, points предлагается', async () => {
    const clientId = (await db.client.query<{ id: string }>(`INSERT INTO app.clients (phone_e164, first_name, status, created_by_type, registered_at) VALUES ('+79130000005', 'У', 'active', 'system', now()) RETURNING id`)).rows[0]!.id;
    const branchId = ids.lenina!;
    const resourceId = ids[`pc_${branchId}`]!;
    await db.client.query(`INSERT INTO app.tariffs (branch_id, resource_type, name, unit_minutes, price_per_unit_kop, valid_from, status, created_by) VALUES ($1, 'pc', 'ПК', 30, 100, '2026-01-01', 'active', $2)`, [branchId, ids.owner]);
    const u = await db.client.query<{ id: string }>(`INSERT INTO app.occupancy_units (branch_id, code, name) VALUES ($1, 'PC-H', 'PC-H') RETURNING id`, [branchId]);
    await db.client.query(`INSERT INTO app.resource_units (resource_id, unit_id, valid_from) VALUES ($1, $2, '2026-01-01')`, [resourceId, u.rows[0]!.id]);
    await db.client.query(`UPDATE app.branches SET status = 'active' WHERE id = $1`, [branchId]); // удержание – только в работающем филиале
    const start = new Date('2026-11-16T07:00:00Z');
    const h = await runOccupancyCommand(pool, (t) => createHold(t, { clientId, visitorId: null }, { branchId, items: [{ resourceId, start, end: new Date(start.getTime() + 3_600_000) }] }, clock));
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await openAccount(c, clientId, clock.now());
      const p = await postPoints(c, clientId, { amount: 6_000, type: 'loyalty.accrual', branchId: null, occurredAt: clock.now() }, randomUUID(), SYSTEM_AUTHOR);
      await createBatch(c, { clientId, entryId: p.entryId, amount: 6_000, balanceBefore: p.balanceBefore, source: 'visit', branchId: null, expiresAt: null, accruedAt: clock.now() });
      await c.query('COMMIT');
      await c.query('BEGIN');
      await reserveForHold(c, { clientId, holdId: h.id }, { actor: { kind: 'client', clientId, sessionId: randomUUID() }, source: 'site', requestId: randomUUID() }, clock);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    const b = (await runOccupancyCommand(pool, (t) => confirmHold(t, clientId, h.id, clock))).bookings[0]!.id;
    await db.client.query(`UPDATE app.bookings SET status = 'arrived' WHERE id = $1`, [b]); // приход отмечен, событие подтверждения ещё в очереди
    const v = (await req('admin', 'GET', `/bookings/${b}/payment`)).json();
    expect(v).toMatchObject({ pointsAvailableCenti: 6_000, pointsRequiredCenti: 6_000 }); // до исправления – 0: свой резерв удержания
    expect(v.allowedMethods).toContain('points');
    const paid = await req('admin', 'POST', `/bookings/${b}/payment`, { lines: [{ method: 'points', amountKop: v.amountDueKop }] });
    expect(paid.statusCode, paid.body).toBe(201);
  });

  it('№19: удержание на 2 брони, бронь 1 удлинена до worker – доступно только своя доля резерва удержания и свободный баланс', async () => {
    // тариф, место и рабочий филиал – из предыдущего теста
    const clientId = (await db.client.query<{ id: string }>(`INSERT INTO app.clients (phone_e164, first_name, status, created_by_type, registered_at) VALUES ('+79130000006', 'Д', 'active', 'system', now()) RETURNING id`)).rows[0]!.id;
    const branchId = ids.lenina!;
    const resourceId = ids[`pc_${branchId}`]!;
    const at = (iso: string) => ({ resourceId, start: new Date(iso), end: new Date(Date.parse(iso) + 30 * 60_000) });
    const h = await runOccupancyCommand(pool, (t) => createHold(t, { clientId, visitorId: null }, { branchId, items: [at('2026-11-17T04:00:00Z'), at('2026-11-17T06:00:00Z')] }, clock));
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await openAccount(c, clientId, clock.now());
      const p = await postPoints(c, clientId, { amount: 6_000, type: 'loyalty.accrual', branchId: null, occurredAt: clock.now() }, randomUUID(), SYSTEM_AUTHOR);
      await createBatch(c, { clientId, entryId: p.entryId, amount: 6_000, balanceBefore: p.balanceBefore, source: 'visit', branchId: null, expiresAt: null, accruedAt: clock.now() });
      await c.query('COMMIT');
      await c.query('BEGIN');
      await reserveForHold(c, { clientId, holdId: h.id }, { actor: { kind: 'client', clientId, sessionId: randomUUID() }, source: 'site', requestId: randomUUID() }, clock); // 6000: по 3000 на бронь
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    const confirmed = (await runOccupancyCommand(pool, (t) => confirmHold(t, clientId, h.id, clock))).bookings;
    const first = confirmed.find((x) => x.start === '2026-11-17T04:00:00.000Z')!.id;
    // перенос удлинил бронь 1 до 60 минут (новая версия), затем приход; событие подтверждения ещё в очереди
    await db.client.query(
      `INSERT INTO journal.booking_versions (booking_id, version, resource_id, period, branch_timezone, unit_ids, resource_snapshot, tariff_id, price_kop, price_snapshot, reason, created_by_type, created_by_id)
       SELECT booking_id, 2, resource_id, tstzrange('2026-11-17T04:00:00Z', '2026-11-17T05:00:00Z', '[)'), branch_timezone, unit_ids, resource_snapshot, tariff_id, 400, price_snapshot, 'удлинили', 'staff', $2
       FROM journal.booking_versions WHERE booking_id = $1 AND version = 1`,
      [first, ids.owner],
    );
    await db.client.query(`UPDATE app.bookings SET current_version = 2, status = 'arrived' WHERE id = $1`, [first]);
    const v = (await req('admin', 'GET', `/bookings/${first}/payment`)).json();
    expect(v).toMatchObject({ pointsAvailableCenti: 3_000, pointsRequiredCenti: 6_000 }); // до исправления – 6000: съедалась доля брони 2
    expect(v.allowedMethods).not.toContain('points');
  });

  it('№20: Администратор проводит; повтор с ключом – тот же paymentId; новый ключ – ALREADY_PAID; без ключа – 400', async () => {
    const b = await booking(ids.lenina!);
    const key = randomUUID();
    const body = { lines: [{ method: 'card', amountKop: 30_000 }], receiptIssued: true };
    const a = await req('admin', 'POST', `/bookings/${b}/payment`, body, key);
    expect(a.statusCode).toBe(201);
    const again = await req('admin', 'POST', `/bookings/${b}/payment`, body, key);
    expect(again.headers['idempotent-replay']).toBe('true');
    expect(again.json().paymentId).toBe(a.json().paymentId);
    const other = await req('admin', 'POST', `/bookings/${b}/payment`, body);
    expect(other.statusCode).toBe(409);
    expect(other.json().error).toMatchObject({ code: 'ALREADY_PAID', details: { paymentId: a.json().paymentId } });
    expect((await req('admin', 'POST', `/bookings/${b}/payment`, body, null)).json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('сертификат: 6 неверных кодов через оплату → блок 15 минут; код в idempotency_keys не хранится', async () => {
    const owner: AccessContext = { actor: { kind: 'staff', staffId: ids.owner!, sessionId: randomUUID() }, role: 'owner', network: true, cityIds: new Set(), branchIds: new Set(), at: clock.now() };
    const c = await pool.connect();
    let sold;
    try {
      await c.query('BEGIN');
      sold = await sellCertificate(c, owner, { branchId: ids.lenina!, nominalKop: 50_000, method: 'cash' }, { actor: owner.actor, access: owner, source: 'crm', requestId: randomUUID() }, { pepper: PEPPER, clock });
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    const b = await booking(ids.lenina!);
    const wrongPin = sold.pin === '0000' ? '1111' : '0000';
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await req('admin', 'POST', `/bookings/${b}/payment`, { lines: [{ method: 'certificate', amountKop: 30_000, certificate: { number: sold.certificate.number, pin: wrongPin } }] })).statusCode);
    }
    expect(statuses).toEqual([404, 404, 404, 404, 429, 429]);
    const right = await req('admin', 'POST', `/bookings/${b}/payment`, { lines: [{ method: 'certificate', amountKop: 30_000, certificate: { number: sold.certificate.number, pin: sold.pin } }] });
    expect(right.json().error.code).toBe('CERTIFICATE_PIN_LOCKED');
    clock.advance(15 * 60_000 + 1000);
    try {
      const key = randomUUID();
      const ok = await req('admin', 'POST', `/bookings/${b}/payment`, { lines: [{ method: 'certificate', amountKop: 30_000, certificate: { number: sold.certificate.number, pin: sold.pin } }] }, key);
      expect(ok.statusCode).toBe(201);
      const rows = await db.client.query<{ body: string }>(`SELECT request_hash || coalesce(response_body::text, '') AS body FROM app.idempotency_keys WHERE key = $1`, [key]);
      expect(rows.rows[0]!.body).not.toContain(sold.pin);
    } finally {
      clock.set('2026-11-15T05:00:00Z');
    }
  });

  it('№21: Администратор – 403 и отказ в аудит; Директор возвращает; №22 – снова к оплате; №23 – статусы', async () => {
    const b = await booking(ids.lenina!);
    const p = (await req('admin', 'POST', `/bookings/${b}/payment`, { lines: [{ method: 'cash', amountKop: 30_000 }] })).json();
    const no = await req('admin', 'POST', `/payments/${p.paymentId}/refund`, { rowVersion: p.session.rowVersion, lines: [{ lineNo: 1 }], reason: 'ошибка' });
    expect(no.statusCode).toBe(403);
    const denied = await db.client.query(`SELECT action, result FROM journal.audit_events WHERE actor_id = $1 AND result = 'denied'`, [ids.admin]);
    expect(denied.rows).toEqual([{ action: 'payment.refunded', result: 'denied' }]);
    const ok = await req('director', 'POST', `/payments/${p.paymentId}/refund`, { rowVersion: p.session.rowVersion, lines: [{ lineNo: 1 }], reason: 'ошибка способа' });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().session.status).toBe('refunded');
    const unpaid = await req('admin', 'GET', `/branches/${ids.lenina}/unpaid?date=2026-11-15`);
    expect(unpaid.json().items.map((r: { bookingId: string }) => r.bookingId)).toContain(b);
    const st = await req('admin', 'POST', '/bookings/payment-status', { bookingIds: [b] }, null);
    expect(st.json()).toEqual({ items: [{ bookingId: b, status: 'refunded' }] });
  });

  it('IDOR: №19–23 с чужим филиалом – 404 (как несуществующее); в №23 чужие брони не попадают', async () => {
    const foreign = await booking(ids.marksa!);
    const fp = (await req('owner', 'POST', `/bookings/${foreign}/payment`, { lines: [{ method: 'cash', amountKop: 30_000 }] })).json();
    const missing = await req('director', 'GET', `/bookings/${randomUUID()}/payment`);
    const calls: Array<['GET' | 'POST', string, object?]> = [
      ['GET', `/bookings/${foreign}/payment`],
      ['POST', `/bookings/${foreign}/payment`, { lines: [{ method: 'cash', amountKop: 30_000 }] }],
      ['POST', `/payments/${fp.paymentId}/refund`, { rowVersion: fp.session.rowVersion, lines: [{ lineNo: 1 }], reason: 'x' }],
      ['GET', `/branches/${ids.marksa}/unpaid?date=2026-11-15`],
    ];
    for (const who of ['director', 'admin']) {
      for (const [method, url, body] of calls) {
        const r = await req(who, method, url, body);
        expect([who, url, r.statusCode]).toEqual([who, url, 404]);
        expect(bodyWithoutRequestId(r.json())).toEqual(bodyWithoutRequestId(missing.json()));
      }
      const st = await req(who, 'POST', '/bookings/payment-status', { bookingIds: [foreign] }, null);
      expect(st.json()).toEqual({ items: [] });
    }
  });
});

// S2-54 по HTTP: K16 §8, 08 §10 – ЛК «Мои сертификаты». Видны только свои (получатель или покупатель без
// получателя); у истёкшего – сгоревшая сумма; кода нет; в истории нет внутренних комментариев; чужой номер – 404.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { clientAuthConfig, createDevSmsSender } from '../../apps/api/src/modules/clients/otp.ts';
import { correctBalance, expireDueCertificates } from '../../apps/api/src/modules/certificates/lifecycle.ts';
import { createCertificatePaymentMethod } from '../../apps/api/src/modules/certificates/payment-method.ts';
import { sellCertificate, type CertificateDto } from '../../apps/api/src/modules/certificates/sale.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { createTestBranch } from '../helpers/network.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';
import { createTestPayment } from '../helpers/payment.ts';

const BASE = '/api/public/v1';
const PEPPER = 'cert-pepper-'.padEnd(40, 'p');
const T0 = new Date('2026-11-14T05:00:00Z');
const clock = fixedClock(T0);
const sms = createDevSmsSender('dev');
let db: TestDatabase;
let pool: pg.Pool;
let app: FastifyInstance;
let cookie: string;
let me: string;
let other: string;
let branchId: string;
let owner: AccessContext;
const sold: Record<string, CertificateDto> = {};

async function login(phone: string): Promise<string> {
  const req = await app.inject({ method: 'POST', url: `${BASE}/auth/otp/request`, headers: { 'idempotency-key': randomUUID() }, payload: { phone, purpose: 'login' } });
  const code = /\d{6}/.exec(sms.sent.at(-1)!.text)![0];
  const res = await app.inject({ method: 'POST', url: `${BASE}/auth/otp/verify`, payload: { challengeId: req.json().challengeId, code, consents: { pdProcessing: true } } });
  expect(res.statusCode).toBe(200);
  return String(res.headers['set-cookie']).split(';')[0]!;
}
async function tx<T>(fn: (t: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}
const meta = () => ({ actor: owner.actor, access: owner, source: 'crm' as const, requestId: randomUUID() });
const sell = (input: { buyerClientId?: string; recipientClientId?: string }, daysAgo = 0) =>
  tx((t) =>
    sellCertificate(t, owner, { branchId, nominalKop: 100_000, method: 'cash', ...input }, meta(), { pepper: PEPPER, clock: fixedClock(new Date(T0.getTime() - daysAgo * 86_400_000)) }),
  );
const get = (url: string, c = cookie) => app.inject({ method: 'GET', url: `${BASE}${url}`, headers: { cookie: c } });

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), { clients: { pool, auth: clientAuthConfig('c'.repeat(40)), sms, clock } });
  cookie = await login('+79135550101');
  me = (await db.client.query(`SELECT id FROM app.clients WHERE phone_e164 = '+79135550101'`)).rows[0].id;
  other = (await db.client.query(`INSERT INTO app.clients (phone_e164, status, created_by_type) VALUES ('+79135550202', 'active', 'system') RETURNING id`)).rows[0].id;
  branchId = (await createTestBranch(db.client)).id;
  const ownerId = (await db.client.query(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('В', 'С', 'o@yu.test', 'owner', 'x') RETURNING id`)).rows[0].id;
  owner = { actor: { kind: 'staff', staffId: ownerId, sessionId: randomUUID() }, role: 'owner', network: true, cityIds: new Set(), branchIds: new Set(), at: T0 };

  const r = await sell({ recipientClientId: me });
  sold.recipient = r.certificate;
  sold.bought = (await sell({ buyerClientId: me })).certificate;
  sold.gifted = (await sell({ buyerClientId: me, recipientClientId: other })).certificate; // подарил – уже не мой
  sold.foreign = (await sell({ recipientClientId: other })).certificate;
  sold.burned = (await sell({ recipientClientId: me }, 200)).certificate; // продан 200 дней назад – истёк
  expect(await expireDueCertificates(pool, clock)).toBe(1);
  // движение по «моему» сертификату: погашение, возврат, корректировка
  const resource = (await db.client.query(`INSERT INTO app.resources (branch_id, resource_type, name) VALUES ($1, 'pc', 'ПК') RETURNING id`, [branchId])).rows[0].id;
  const booking = (await db.client.query(
    `INSERT INTO app.bookings (checkout_id, branch_id, client_id, resource_id, period, price_kop, source, created_by_type, status)
     VALUES (gen_random_uuid(), $1, $2, $3, tstzrange('2026-11-14T04:00:00Z', '2026-11-14T05:00:00Z', '[)'), 30000, 'crm', 'staff', 'arrived') RETURNING id`,
    [branchId, me, resource],
  )).rows[0].id as string;
  const handler = createCertificatePaymentMethod({ pepper: PEPPER });
  const paymentId = await createTestPayment(db.client, booking);
  const author = { type: 'staff' as const, id: ownerId };
  const charged = await tx((t) =>
    handler.charge(t, {
      session: { id: booking, bookingId: booking, branchId, clientId: me, amountDueKop: 30_000, bookingVersion: 1, status: 'unpaid', activePaymentId: null, rowVersion: 1 },
      lineNo: 1, amountKop: 30_000, minutes: 60, resourceType: 'pc', certificate: { number: r.certificate.number, pin: r.pin },
      idempotencyKey: `payment:${booking}:1:1`, author, occurredAt: T0, mode: 'exact', paymentId,
    }),
  );
  await tx((t) =>
    handler.refund(t, {
      line: { lineNo: 1, method: 'certificate', amountKop: 30_000, certificateId: r.certificate.id, ledgerPostingId: charged.postingId },
      amountKop: 30_000, idempotencyKey: `refund:${randomUUID()}`, author, occurredAt: T0, reason: 'внутренняя причина возврата',
    }),
  );
  await tx((t) => correctBalance(t, owner, { certificateId: r.certificate.id, rowVersion: 1, deltaKop: -1_000, reason: 'внутренний комментарий корректировки' }, meta(), clock));
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await db.drop();
});

describe('GET /me/certificates', () => {
  it('только свои: получатель или покупатель без получателя; кода нет; у истёкшего – сгоревшая сумма', async () => {
    const res = await get('/me/certificates');
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<Record<string, unknown>>;
    expect(items.map((i) => i.number).sort()).toEqual([sold.recipient!.number, sold.bought!.number, sold.burned!.number].sort());
    expect(items.find((i) => i.number === sold.burned!.number)).toEqual({
      number: sold.burned!.number,
      nominalKop: 100_000,
      balanceKop: 0,
      soldAt: sold.burned!.soldAt,
      expiresOn: sold.burned!.expiresOn,
      status: 'expired',
      burnedKop: 100_000,
    });
    expect(items.find((i) => i.number === sold.recipient!.number)).toMatchObject({ balanceKop: 99_000, status: 'partially_used', burnedKop: null });
    for (const i of items) expect(Object.keys(i).sort()).toEqual(['balanceKop', 'burnedKop', 'expiresOn', 'nominalKop', 'number', 'soldAt', 'status']);
    expect(res.body).not.toMatch(/pin|id"/i);
  });

  it('без входа – 401', async () => {
    const res = await app.inject({ method: 'GET', url: `${BASE}/me/certificates` });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /me/certificates/{number}/history', () => {
  it('движение остатка с филиалом, без внутренних комментариев', async () => {
    const res = await get(`/me/certificates/${sold.recipient!.number.toLowerCase()}/history`);
    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((i: { type: string; amountKop: number; balanceAfterKop: number }) => [i.type, i.amountKop, i.balanceAfterKop])).toEqual([
      ['sale', 100_000, 100_000],
      ['redeem', -30_000, 70_000],
      ['return', 30_000, 100_000],
      ['correction', -1_000, 99_000],
    ]);
    expect(res.json().items[0].branchName).toEqual(expect.any(String));
    expect(res.body).not.toContain('внутренн');
    const burned = await get(`/me/certificates/${sold.burned!.number}/history`);
    expect(burned.json().items.map((i: { type: string }) => i.type)).toEqual(['sale', 'expire']);
  });

  it('чужой и подаренный номер – 404 как несуществующий', async () => {
    const foreign = await get(`/me/certificates/${sold.foreign!.number}/history`);
    const gifted = await get(`/me/certificates/${sold.gifted!.number}/history`);
    const missing = await get(`/me/certificates/YC-ZZZZ-ZZZZ/history`);
    for (const r of [foreign, gifted, missing]) expect(r.statusCode).toBe(404);
    expect({ ...foreign.json().error, requestId: 0 }).toEqual({ ...missing.json().error, requestId: 0 });
  });
});

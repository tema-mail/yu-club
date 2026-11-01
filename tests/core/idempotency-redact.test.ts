// S2-08: идемпотентность с маскировкой секрета (K16 §3, D2-07). Код сертификата не хранится в idempotency_keys:
// ответ сохраняется без кода (redact), в request_hash вместо кода – HMAC с CERT_PEPPER (hashBody).
import { randomInt, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import { requestHash, runIdempotent, secretDigest, type IdempotentResponse } from '../../apps/api/src/core/idempotency.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const PEPPER = 'p'.repeat(16) + randomUUID();
const clock = fixedClock(new Date('2026-11-15T07:00:00Z'));
let db: TestDatabase;
let pool: pg.Pool;

async function inTx<T>(fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
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

// «Продажа сертификата» K16 №31: ответ { certificate, pin }, pin – только в первом ответе.
type SaleBody = { certificate: { id: string; number: string }; pin: string | null; pinShownOnce?: true };
const redactSale = (b: unknown) => ({ ...(b as SaleBody), pin: null, pinShownOnce: true });
let sold = 0;
const sellCommand = (pin: string) => async (): Promise<IdempotentResponse> => {
  sold++;
  return { status: 201, body: { certificate: { id: randomUUID(), number: 'YC-7K2M-9QXD' }, pin } satisfies SaleBody };
};

// Тело оплаты K10 №20 со строкой сертификата: код – секрет запроса.
type PayBody = { lines: Array<{ method: string; amountKop: number; certificate?: { number: string; pin: string } }> };
const hashPay = (b: unknown) => ({
  ...(b as PayBody),
  lines: (b as PayBody).lines.map((l) => (l.certificate ? { ...l, certificate: { ...l.certificate, pin: secretDigest(PEPPER, l.certificate.pin) } } : l)),
});

const pinOf = () => String(randomInt(0, 10_000)).padStart(4, '0');
const keysRows = () => db.client.query<{ request_hash: string; body: string | null }>(`SELECT request_hash, response_body::text AS body FROM app.idempotency_keys`);

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
});
afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('redact: ответ продажи сохраняется без кода', () => {
  it('первый ответ с кодом; повтор – тот же сертификат без кода и с pinShownOnce; кода нет в response_body', async () => {
    const pin = pinOf();
    const key = randomUUID();
    const run = () =>
      inTx((tx) =>
        runIdempotent(tx, { scope: 'staff:s1:certificate.sell', key, request: { route: 'POST /branches/:id/certificates', body: { nominalKop: 500000, method: 'cash' } }, clock, redact: redactSale }, sellCommand(pin)),
      );
    const first = await run();
    const again = await run();
    expect(first.replayed).toBe(false);
    expect((first.body as SaleBody).pin).toBe(pin);
    expect(again.replayed).toBe(true);
    expect(again.status).toBe(201);
    expect(again.body).toEqual({ certificate: (first.body as SaleBody).certificate, pin: null, pinShownOnce: true });
    expect(sold).toBe(1);
    const rows = await db.client.query(`SELECT count(*)::int AS n FROM app.idempotency_keys WHERE key = $1 AND response_body::text LIKE $2`, [key, `%"pin": "${pin}"%`]);
    expect(rows.rows[0].n).toBe(0);
    const stored = await db.client.query(`SELECT response_body FROM app.idempotency_keys WHERE key = $1`, [key]);
    expect(stored.rows[0].response_body.pin).toBeNull();
  });
});

describe('hashBody: код не участвует в request_hash открыто', () => {
  it('в request_hash – HMAC кода; перебор всех 10 000 кодов по чистому SHA-256 не находит хэш', async () => {
    const pin = pinOf();
    const key = randomUUID();
    const body: PayBody = { lines: [{ method: 'certificate', amountKop: 30000, certificate: { number: 'YC-7K2M-9QXD', pin } }] };
    const route = 'POST /bookings/:id/payment';
    const params = { bookingId: 'b1' };
    const res = await inTx((tx) =>
      runIdempotent(tx, { scope: 'staff:s1:finance.payment.record', key, request: { route, params, body }, clock, hashBody: hashPay }, async () => ({ status: 201, body: { paymentId: 'p1' } })),
    );
    expect(res.replayed).toBe(false);
    const stored = (await db.client.query<{ request_hash: string }>(`SELECT request_hash FROM app.idempotency_keys WHERE key = $1`, [key])).rows[0]!.request_hash;
    expect(stored).toBe(requestHash({ route, params, body: hashPay(body) }));
    expect(stored).not.toBe(requestHash({ route, params, body }));
    const withPin = (p: string) => ({ lines: [{ ...body.lines[0]!, certificate: { number: 'YC-7K2M-9QXD', pin: p } }] });
    for (let i = 0; i < 10_000; i++) expect(requestHash({ route, params, body: withPin(String(i).padStart(4, '0')) }) === stored).toBe(false);
  });

  it('тот же ключ с другим кодом – IDEMPOTENCY_KEY_REUSED; с тем же – повтор', async () => {
    const key = randomUUID();
    const body = (pin: string): PayBody => ({ lines: [{ method: 'certificate', amountKop: 30000, certificate: { number: 'YC-7K2M-9QXD', pin } }] });
    const run = (pin: string) =>
      inTx((tx) =>
        runIdempotent(tx, { scope: 'staff:s1:pay', key, request: { route: 'r', body: body(pin) }, clock, hashBody: hashPay }, async () => ({ status: 201, body: { paymentId: 'p2' } })),
      );
    await run('1234');
    expect((await run('1234')).replayed).toBe(true);
    await expect(run('4321')).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });
});

describe('без опций – как раньше', () => {
  it('ответ и повтор совпадают, тело сохраняется целиком', async () => {
    const key = randomUUID();
    const run = () =>
      inTx((tx) => runIdempotent(tx, { scope: 'staff:s1:x', key, request: { route: 'r', body: { a: 1 } }, clock }, async () => ({ status: 200, body: { b: 2, a: 'x' } })));
    const first = await run();
    const again = await run();
    expect(again).toEqual({ ...first, replayed: true });
    const all = await keysRows();
    expect(all.rows.some((r) => r.body === '{"a": "x", "b": 2}')).toBe(true);
  });

  it('secretDigest требует pepper ≥ 32; CERT_PEPPER в конфиге: короткий не проходит, значение в ошибку не попадает', () => {
    expect(() => secretDigest('short', '1234')).toThrow(/32/);
    expect(secretDigest(PEPPER, '1234')).toMatch(/^[0-9a-f]{64}$/);
    expect(secretDigest(PEPPER, '1234')).not.toBe(secretDigest(PEPPER + 'x', '1234'));
    expect(() => loadConfig({ CERT_PEPPER: 'секрет-короткий' })).toThrow(/CERT_PEPPER/);
    expect(() => loadConfig({ CERT_PEPPER: 'секрет-короткий' })).not.toThrow(/секрет-короткий/);
    expect(loadConfig({ CERT_PEPPER: 'c'.repeat(32) }).CERT_PEPPER).toBe('c'.repeat(32));
    expect(loadConfig({}).CERT_PEPPER).toBeUndefined();
  });
});

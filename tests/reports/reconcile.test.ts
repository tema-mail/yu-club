// S2-80: ночная сверка 16 §14 (modules/reports/reconcile.ts, миграция 0211). Данные – командами модулей:
// касса (начальные остатки, приход, перевод между местами и его сторно), сертификаты (продажа, погашение, возврат
// погашения, корректировка, отмена с возвратом денег, сгорание), баллы (плюс, минус FEFO, долг). Чистые данные – ноль
// расхождений; испорченный суперпользователем кэш баланса и остаток партии – расхождения в журнале и в логе error;
// плановый запуск – раз в сутки по 03:30 зоны расписания.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import { fixedClock, type Clock, type LocalTime, type TimeZone } from '../../apps/api/src/core/time.ts';
import { cancelSale, correctBalance, expireDueCertificates } from '../../apps/api/src/modules/certificates/lifecycle.ts';
import { createCertificatePaymentMethod } from '../../apps/api/src/modules/certificates/payment-method.ts';
import { sellCertificate, type CertificateDto } from '../../apps/api/src/modules/certificates/sale.ts';
import { recordIncome, recordOpeningBalance, transferBetweenPlaces } from '../../apps/api/src/modules/finance/cashbox.ts';
import { reverseOperation } from '../../apps/api/src/modules/finance/corrections.ts';
import type { PaymentLine } from '../../apps/api/src/modules/finance/methods.ts';
import { adjust } from '../../apps/api/src/modules/loyalty/adjust.ts';
import { dueDate, runReconcile, startNightlyReconcile, type ReconcileLogger } from '../../apps/api/src/modules/reports/reconcile.ts';
import { createTestBranch } from '../helpers/network.ts';
import { createTestPayment } from '../helpers/payment.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const PEPPER = 'cert-pepper-'.padEnd(40, 'r');
const T0 = new Date('2026-11-14T05:00:00Z');
const clock = fixedClock(T0);
const MSK = 'Europe/Moscow' as TimeZone;
let db: TestDatabase;
let pool: pg.Pool;
let ownerId: string;
let branchId: string;
let cashAccountId: string;
let clientA: string;
let clientB: string;

const owner = (): AccessContext => ({
  actor: { kind: 'staff', staffId: ownerId, sessionId: randomUUID() },
  role: 'owner',
  network: true,
  cityIds: new Set(),
  branchIds: new Set(),
  at: T0,
});
const meta = (): AuditRequestMeta => ({ actor: owner().actor, access: owner(), source: 'crm', requestId: randomUUID() });
const opts = () => ({ idempotencyKey: randomUUID(), clock });

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

function memoryLogger(): ReconcileLogger & { errors: Array<{ obj: Record<string, unknown>; msg: string }>; infos: string[] } {
  const errors: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  const infos: string[] = [];
  return { errors, infos, error: (obj, msg) => void errors.push({ obj, msg }), info: (_obj, msg) => void infos.push(msg) };
}

const client = async (phone: string): Promise<string> =>
  (await db.client.query<{ id: string }>(`INSERT INTO app.clients (phone_e164, first_name, status, created_by_type, registered_at) VALUES ($1, 'К', 'active', 'system', now()) RETURNING id`, [phone])).rows[0]!.id;

async function redeem(cert: { certificate: CertificateDto; pin: string }, amountKop: number, resourceId: string) {
  const handler = createCertificatePaymentMethod({ pepper: PEPPER });
  const b = await db.client.query<{ id: string }>(
    `INSERT INTO app.bookings (checkout_id, branch_id, client_id, resource_id, period, price_kop, source, created_by_type, status)
     VALUES (gen_random_uuid(), $1, $2, $3, tstzrange('2026-11-14T04:00:00Z', '2026-11-14T05:00:00Z', '[)'), 300000, 'crm', 'staff', 'arrived') RETURNING id`,
    [branchId, clientA, resourceId],
  );
  const id = b.rows[0]!.id;
  const paymentId = await createTestPayment(db.client, id);
  const session = { id, bookingId: id, branchId, clientId: clientA, amountDueKop: amountKop, bookingVersion: 1, status: 'unpaid' as const, activePaymentId: null, rowVersion: 1 };
  const charged = await tx((t) =>
    handler.charge(t, {
      session, lineNo: 1, amountKop, minutes: 60, resourceType: 'pc',
      certificate: { number: cert.certificate.number, pin: cert.pin },
      idempotencyKey: `payment:${id}:1:1`, author: { type: 'staff', id: ownerId }, occurredAt: T0, mode: 'exact', paymentId,
    }),
  );
  return { handler, charged };
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 6 });
  ownerId = (await db.client.query<{ id: string }>(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('В', 'В', $1, 'owner', 'x') RETURNING id`, [`${randomUUID()}@club.ru`])).rows[0]!.id;
  branchId = (await createTestBranch(db.client)).id;
  clientA = await client('+79130000801');
  clientB = await client('+79130000802');
  const resourceId = (await db.client.query<{ id: string }>(`INSERT INTO app.resources (branch_id, resource_type, name) VALUES ($1, 'pc', 'ПК-1') RETURNING id`, [branchId])).rows[0]!.id;

  // касса: остатки, приход картой, перевод наличных в безнал и его сторно
  await tx((t) => recordOpeningBalance(t, owner(), { branchId, place: 'cash', amountKop: 1_000_000, date: '2026-11-01', comment: 'остаток' }, meta(), opts()));
  await tx((t) => recordOpeningBalance(t, owner(), { branchId, place: 'noncash', amountKop: 500_000, date: '2026-11-01', comment: 'остаток' }, meta(), opts()));
  await tx((t) => recordIncome(t, owner(), { branchId, method: 'card', amountKop: 30_000, source: 'other', occurredAt: T0.toISOString(), comment: 'прочее' }, meta(), opts()));
  const tr = await tx((t) => transferBetweenPlaces(t, owner(), { branchId, from: 'cash', amountKop: 200_000, occurredAt: T0.toISOString(), comment: 'инкассация' }, meta(), opts()));
  await tx((t) => reverseOperation(t, owner(), { operationId: tr.id, reason: 'ошибка' }, meta(), opts()));
  await tx((t) => transferBetweenPlaces(t, owner(), { branchId, from: 'noncash', amountKop: 50_000, occurredAt: T0.toISOString(), comment: 'снятие' }, meta(), opts()));

  // сертификаты: погашение + возврат одного из погашений + корректировка; отмена продажи с деньгами; сгорание остатков
  const sell = (nominalKop: number) => tx((t) => sellCertificate(t, owner(), { branchId, nominalKop, method: 'cash' }, meta(), { pepper: PEPPER, clock }));
  const c1 = await sell(500_000);
  await redeem(c1, 100_000, resourceId);
  const second = await redeem(c1, 50_000, resourceId);
  await tx((t) =>
    second.handler.refund(t, {
      line: { ledgerPostingId: second.charged.postingId } as PaymentLine,
      amountKop: 50_000, idempotencyKey: `refund:${randomUUID()}:1:1`, author: { type: 'staff', id: ownerId }, occurredAt: T0, reason: 'возврат',
    }),
  );
  const v = (await db.client.query<{ row_version: number }>(`SELECT row_version FROM app.certificates WHERE id = $1`, [c1.certificate.id])).rows[0]!.row_version;
  await tx((t) => correctBalance(t, owner(), { certificateId: c1.certificate.id, rowVersion: v, deltaKop: -20_000, reason: 'исправление' }, meta(), clock));
  const c2 = await sell(300_000);
  await tx((t) => cancelSale(t, owner(), { certificateId: c2.certificate.id, rowVersion: c2.certificate.rowVersion, reason: 'передумал', refundMoney: true }, meta(), clock));
  await sell(200_000);
  expect(await expireDueCertificates(pool, fixedClock(new Date(new Date(c1.certificate.expiresAt).getTime() + 1000)))).toBe(2);

  // баллы: A +10 и −3 (FEFO), B −2 (долг, партий нет)
  await tx((t) => adjust(t, owner(), { clientId: clientA, deltaCenti: 1000, reason: 'подарок' }, meta(), clock));
  await tx((t) => adjust(t, owner(), { clientId: clientA, deltaCenti: -300, reason: 'исправление' }, meta(), clock));
  await tx((t) => adjust(t, owner(), { clientId: clientB, deltaCenti: -200, reason: 'долг' }, meta(), clock));

  cashAccountId = (await db.client.query<{ id: string }>(`SELECT id FROM app.ledger_accounts WHERE kind = 'cash_branch' AND owner_id = $1`, [branchId])).rows[0]!.id;
}, 60_000);

afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('S2-80: сверка 16 §14', () => {
  it('чистые данные – ноль расхождений; проверены все пять видов; запуск записан как ok', async () => {
    const log = memoryLogger();
    const r = (await runReconcile(pool, { trigger: 'manual', clock, logger: log }))!;
    expect(r.discrepancies).toEqual([]);
    expect(r.status).toBe('ok');
    expect(r.checked.ledger_balance).toBe(7); // 2 места денег, 3 сертификата, 2 счёта баллов
    expect(r.checked).toMatchObject({ loyalty_points: 2, certificate_balance: 3, cash_place: 2 });
    expect(r.checked.loyalty_batch).toBeGreaterThanOrEqual(1);
    expect(log.errors).toEqual([]);
    const run = (await db.client.query(`SELECT trigger, status, discrepancy_count, finished_at IS NOT NULL AS finished FROM app.reconcile_runs WHERE id = $1`, [r.runId])).rows[0];
    expect(run).toEqual({ trigger: 'manual', status: 'ok', discrepancy_count: 0, finished: true });
    // формулы сверки опираются на настоящие числа, а не на ноль с нулём
    const cert = (await db.client.query(`SELECT nominal_kop, redeemed_kop, expired_kop, corrections_kop, balance_kop FROM app.rpt_certificate_balances WHERE redeemed_kop > 0`)).rows[0];
    expect(cert).toEqual({ nominal_kop: '500000', redeemed_kop: '100000', expired_kop: '380000', corrections_kop: '-20000', balance_kop: '0' });
    const cash = (await db.client.query(`SELECT place, balance, operations_sum FROM app.rpt_cash_places WHERE branch_id = $1 ORDER BY place`, [branchId])).rows;
    expect(cash).toEqual([
      { place: 'cash', balance: '1750000', operations_sum: '1750000' }, // 10 000 + 500 из безнала + 10 000 продаж − 3 000 отмены
      { place: 'noncash', balance: '480000', operations_sum: '480000' }, // 5 000 + 300 − 500
    ]);
  });

  it('испорченный суперпользователем кэш баланса кассы – расхождения ledger_balance и cash_place в журнале и в логе error', async () => {
    await db.client.query(`UPDATE app.ledger_accounts SET balance = balance + 100 WHERE id = $1`, [cashAccountId]);
    try {
      const log = memoryLogger();
      const r = (await runReconcile(pool, { trigger: 'manual', clock, logger: log }))!;
      expect(r.status).toBe('discrepancies');
      expect(r.discrepancies.map((d) => [d.check, d.objectId, d.expected, d.actual])).toEqual([
        ['ledger_balance', cashAccountId, 1_750_000, 1_750_100],
        ['cash_place', branchId, 1_750_000, 1_750_100],
      ]);
      expect(log.errors.map((e) => e.msg)).toEqual(['reconcile: расхождение ledger_balance', 'reconcile: расхождение cash_place']);
      expect(log.errors[0]!.obj).toMatchObject({ runId: r.runId, diff: 100, details: { kind: 'cash_branch' } });
      const rows = await db.client.query(`SELECT check_name, expected, actual FROM journal.reconcile_discrepancies WHERE run_id = $1 ORDER BY id`, [r.runId]);
      expect(rows.rows).toEqual([
        { check_name: 'ledger_balance', expected: '1750000', actual: '1750100' },
        { check_name: 'cash_place', expected: '1750000', actual: '1750100' },
      ]);
      const run = (await db.client.query(`SELECT status, discrepancy_count FROM app.reconcile_runs WHERE id = $1`, [r.runId])).rows[0];
      expect(run).toEqual({ status: 'discrepancies', discrepancy_count: 2 });
    } finally {
      await db.client.query(`UPDATE app.ledger_accounts SET balance = balance - 100 WHERE id = $1`, [cashAccountId]);
    }
  });

  it('остаток партии и кэш сертификата не сходятся – loyalty_batch, loyalty_points, certificate_balance', async () => {
    const batch = (await db.client.query<{ id: string }>(`SELECT id FROM app.loyalty_batches WHERE client_id = $1 AND status = 'active'`, [clientA])).rows[0]!.id;
    const red = (await db.client.query<{ id: string; certificate_id: string }>(`SELECT id, certificate_id FROM app.certificate_redemptions WHERE status = 'active'`)).rows;
    expect(red).toHaveLength(1);
    await db.client.query(`UPDATE app.loyalty_batches SET remaining_centi = remaining_centi - 50 WHERE id = $1`, [batch]);
    // погашение помечено возвращённым мимо модуля (без записи K3): сумма записей и кэш сходятся, формула 16 §14 – нет
    await db.client.query(`UPDATE app.certificate_redemptions SET status = 'returned', return_entry_id = ledger_entry_id WHERE id = $1`, [red[0]!.id]);
    const log = memoryLogger();
    const r = (await runReconcile(pool, { trigger: 'manual', clock, logger: log }))!;
    expect(r.discrepancies.map((d) => [d.check, d.objectId, d.expected, d.actual])).toEqual([
      ['loyalty_points', clientA, 700, 650],
      ['loyalty_batch', batch, 700, 650],
      ['certificate_balance', red[0]!.certificate_id, 100_000, 0], // 5 000 − 0 − 3 800 − 200
    ]);
    expect(log.errors).toHaveLength(3);
    await db.client.query(`UPDATE app.loyalty_batches SET remaining_centi = remaining_centi + 50 WHERE id = $1`, [batch]);
    await db.client.query(`UPDATE app.certificate_redemptions SET status = 'active', return_entry_id = NULL WHERE id = $1`, [red[0]!.id]);
    expect((await runReconcile(pool, { trigger: 'manual', clock, logger: memoryLogger() }))!.status).toBe('ok');
  });

  it('плановый запуск: до 03:30 по зоне – нет; после – один раз за сутки, и второй экземпляр его не повторяет', async () => {
    expect(dueDate(new Date('2026-11-15T00:29:00Z'), '03:30' as LocalTime, MSK)).toBeNull(); // 03:29 Москвы
    expect(dueDate(new Date('2026-11-15T00:30:00Z'), '03:30' as LocalTime, MSK)).toBe('2026-11-15');
    let now = new Date('2026-11-15T00:29:00Z');
    const c: Clock = { now: () => now };
    const log = memoryLogger();
    const a = startNightlyReconcile({ pool, clock: c, logger: log, timeZone: MSK, intervalMs: 3_600_000 });
    const b = startNightlyReconcile({ pool, clock: c, logger: log, timeZone: MSK, intervalMs: 3_600_000 });
    try {
      expect(await a.tick()).toBeNull();
      now = new Date('2026-11-15T00:31:00Z');
      const first = await a.tick();
      expect(first).toMatchObject({ trigger: 'schedule', scheduledFor: '2026-11-15' });
      expect(await a.tick()).toBeNull();
      expect(await b.tick()).toBeNull(); // сутки уже сверены – уникальный индекс
      now = new Date('2026-11-16T09:00:00Z'); // worker стоял ночью – догоняет днём
      expect(await b.tick()).toMatchObject({ scheduledFor: '2026-11-16' });
      const runs = await db.client.query(`SELECT scheduled_for::text AS d FROM app.reconcile_runs WHERE trigger = 'schedule' ORDER BY scheduled_for`);
      expect(runs.rows.map((x) => x.d)).toEqual(['2026-11-15', '2026-11-16']);
    } finally {
      a.stop();
      b.stop();
    }
  });

  it('представления rpt_* и журнал расхождений – только чтение и вставка для yu_app', async () => {
    const code = (sql: string) => pool.query(sql).then(() => 'ok', (e: { code?: string }) => e.code);
    expect(await code(`UPDATE app.rpt_ledger_balances SET balance = 0`)).toBe('42501');
    expect(await code(`DELETE FROM journal.reconcile_discrepancies`)).toBe('42501');
    expect(await code(`DELETE FROM app.reconcile_runs`)).toBe('42501');
  });

  it('ручной запуск командой: код 0 и строка лога «сверка завершена»; запуск manual в базе', async () => {
    const { stdout } = await promisify(execFile)(process.execPath, ['apps/api/src/modules/reports/reconcile.ts'], { env: { ...process.env, DATABASE_URL: db.url } });
    const line = JSON.parse(stdout.trim().split('\n').at(-1)!);
    expect(line).toMatchObject({ level: 'info', proc: 'reconcile', msg: 'reconcile: сверка завершена', status: 'ok', trigger: 'manual' });
    expect((await db.client.query(`SELECT status FROM app.reconcile_runs WHERE id = $1`, [line.runId])).rows[0]).toEqual({ status: 'ok' });
  });
});

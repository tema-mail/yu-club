// S2-81: засев Э2 поверх Э0 и Э1 – начальные остатки кассы, категории, сертификаты, баллы (партии), оплаченные и
// неоплаченные брони командами модулей с аудитом; повтор без дублей; демо помечено; на проде – отказ; коды сертификатов
// в строки лога – только на dev/stage; ночная сверка S2-80 на засеянных данных – ноль расхождений.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixedClock } from '../apps/api/src/core/time.ts';
import { bookingLookup } from '../apps/api/src/modules/booking/providers.ts';
import { getPaymentStatus } from '../apps/api/src/modules/finance/payment.ts';
import { runReconcile } from '../apps/api/src/modules/reports/reconcile.ts';
import { certificateLines, seedCommerce, type CommerceSeedReport } from '../db/seed/commerce.ts';
import { DEMO_MARK, seedDev } from '../db/seed/dev.ts';
import { DEMO_CLIENTS, seedResources } from '../db/seed/resources.ts';
import { createTestDatabase, type TestDatabase } from './helpers/pg.ts';

const early = fixedClock('2026-11-12T05:00:00Z'); // Э0 и Э1 – за два дня: вчерашние сеансы возможны
const clock = fixedClock('2026-11-14T05:00:00Z'); // 12:00 Новосибирска, 08:00 Москвы
const PEPPER = 'seed-cert-pepper-'.padEnd(40, 'x');
let db: TestDatabase;
let pool: pg.Pool;
let first: CommerceSeedReport;

async function counts(): Promise<Record<string, number>> {
  const r = await db.client.query(`SELECT
    (SELECT count(*)::int FROM app.finance_categories) categories, (SELECT count(*)::int FROM journal.finance_operations) operations,
    (SELECT count(*)::int FROM app.finance_opening_balances) openings, (SELECT count(*)::int FROM app.certificates) certificates,
    (SELECT count(*)::int FROM app.loyalty_batches) batches, (SELECT count(*)::int FROM app.bookings) bookings,
    (SELECT count(*)::int FROM app.payments) payments, (SELECT count(*)::int FROM journal.ledger_entries) entries,
    (SELECT count(*)::int FROM journal.audit_events) audit`);
  return r.rows[0];
}
const quiet = { info: () => undefined, error: () => undefined };

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
});
afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('S2-81: засев Э2', () => {
  it('на проде – отказ до записи; без Э0/Э1 – понятная ошибка; короткий CERT_PEPPER – отказ', async () => {
    const before = await counts();
    await expect(seedCommerce(pool, { env: { APP_ENV: 'prod' }, certPepper: PEPPER }, clock)).rejects.toThrow(/только для dev\/stage\/test/);
    await expect(seedCommerce(pool, { env: { NODE_ENV: 'production' }, certPepper: PEPPER }, clock)).rejects.toThrow(/только для dev\/stage\/test/);
    await expect(seedCommerce(pool, { env: { APP_ENV: 'test' }, certPepper: 'short' }, clock)).rejects.toThrow(/CERT_PEPPER/);
    await expect(seedCommerce(pool, { env: { APP_ENV: 'test' }, certPepper: PEPPER }, clock)).rejects.toThrow(/засев Э0 и Э1/);
    expect(await counts()).toEqual(before);
  });

  it('в двух активных демо-филиалах: остатки, расход, 2 сертификата, 4 брони (2 оплачены); баллы трёх клиентов', async () => {
    await seedDev(pool, { env: { APP_ENV: 'test' }, password: 'Демо-пароль-засева-1' }, early);
    await seedResources(pool, { env: { APP_ENV: 'test' } }, early);
    const before = await counts();
    first = await seedCommerce(pool, { env: { APP_ENV: 'test' }, certPepper: PEPPER }, clock);
    expect(first.created).toEqual({ categories: 3, openingBalances: 4, operations: 2, certificates: 4, pointBatches: 3, bookings: 8, payments: 4 });
    expect(first.certificates.map((c) => c.branchCode).sort()).toEqual(['demo-msk-arbat', 'demo-msk-arbat', 'demo-nsk-krasny', 'demo-nsk-krasny']);
    expect(first.certificates.every((c) => /^\d{4}$/.test(c.pin))).toBe(true);
    const after = await counts();
    expect(after.audit!).toBeGreaterThan(before.audit!);

    for (const code of ['demo-nsk-krasny', 'demo-msk-arbat']) {
      const b = (await db.client.query<{ id: string }>(`SELECT id FROM app.branches WHERE code = $1`, [code])).rows[0]!.id;
      const cash = await db.client.query(`SELECT kind, balance FROM app.ledger_accounts WHERE owner_type = 'branch' AND owner_id = $1 ORDER BY kind`, [b]);
      // наличные: 20 000 − 500 расход + 3 000 сертификат + оплата наличными; безнал: 5 000 + 5 000 сертификат + оплата картой
      const paid = await db.client.query<{ method: string; amount: string }>(
        `SELECT pl.method, pl.amount_kop AS amount FROM app.payment_lines pl JOIN app.payments p ON p.id = pl.payment_id JOIN app.payment_sessions s ON s.booking_id = p.session_id WHERE s.branch_id = $1 ORDER BY pl.method`,
        [b],
      );
      const by = Object.fromEntries(paid.rows.map((r) => [r.method, Number(r.amount)]));
      expect(cash.rows.map((r) => [r.kind, Number(r.balance)])).toEqual([
        ['cash_branch', 2_000_000 - 50_000 + 300_000 + by.cash!],
        ['cash_branch_noncash', 500_000 + 500_000 + by.card!],
      ]);
      const bookings = await db.client.query<{ id: string; status: string; phone: string }>(
        `SELECT bk.id, bk.status, c.phone_e164 AS phone FROM app.bookings bk JOIN app.clients c ON c.id = bk.client_id WHERE bk.branch_id = $1 ORDER BY c.phone_e164`,
        [b],
      );
      const status = await getPaymentStatus(pool, bookings.rows.map((r) => r.id));
      expect(bookings.rows.map((r) => [r.phone, r.status, status.get(r.id) ?? 'none'])).toEqual([
        [DEMO_CLIENTS[0].phone, 'arrived', 'paid'],
        [DEMO_CLIENTS[1].phone, 'arrived', 'paid'],
        [DEMO_CLIENTS[2].phone, 'arrived', 'unpaid'],
        [DEMO_CLIENTS[3].phone, 'confirmed', 'unpaid'],
      ]);
      const facts = (await bookingLookup.facts(pool, bookings.rows[0]!.id))!;
      expect(facts.end.getTime()).toBeLessThan(clock.now().getTime()); // оплаченный сеанс – вчерашний
    }
    const batches = await db.client.query(`SELECT c.phone_e164 AS phone, b.amount_centi FROM app.loyalty_batches b JOIN app.clients c ON c.id = b.client_id ORDER BY c.phone_e164`);
    expect(batches.rows.map((r) => [r.phone, Number(r.amount_centi)])).toEqual([
      [DEMO_CLIENTS[0].phone, 5_000],
      [DEMO_CLIENTS[1].phone, 1_250],
      [DEMO_CLIENTS[4].phone, 10_000],
    ]);
  });

  it('создано командами модулей: аудит продаж, оплат, прихода, операций кассы и баллов; демо помечено', async () => {
    const audit = await db.client.query<{ action: string; n: number }>(
      `SELECT action, count(*)::int AS n FROM journal.audit_events WHERE action IN ('certificate.sold', 'payment.recorded', 'visit.confirmed', 'finance.operation.created', 'finance.category.created', 'loyalty.adjusted') GROUP BY action ORDER BY action`,
    );
    const by = Object.fromEntries(audit.rows.map((r) => [r.action, r.n]));
    expect(by).toMatchObject({ 'certificate.sold': 4, 'payment.recorded': 4, 'visit.confirmed': 6, 'finance.category.created': 3 });
    expect(by['finance.operation.created']).toBeGreaterThanOrEqual(6); // 4 остатка + 2 расхода (+ продажи, если пишут свой)
    const ops = await db.client.query(`SELECT kind, comment FROM journal.finance_operations WHERE kind IN ('opening_balance', 'expense')`);
    expect(ops.rows).toHaveLength(6);
    expect(ops.rows.every((r) => r.comment.startsWith(DEMO_MARK))).toBe(true);
    const certs = await db.client.query(`SELECT comment FROM app.certificates`);
    expect(certs.rows.every((r) => r.comment.startsWith(DEMO_MARK))).toBe(true);
    const cats = await db.client.query(`SELECT name FROM app.finance_categories WHERE name LIKE '%(демо)' ORDER BY name`);
    expect(cats.rows.map((r) => r.name)).toEqual(['Демо-доходы (демо)', 'Демо-расходы (демо)', 'Кофе для гостей (демо)']);
    // код сертификата в базе – только HMAC
    const pins = await db.client.query(`SELECT count(*)::int AS n FROM app.certificates WHERE pin_hash = ANY($1::text[])`, [first.certificates.map((c) => c.pin)]);
    expect(pins.rows[0].n).toBe(0);
  });

  it('коды сертификатов в строках лога – только на dev/stage; на test – одни номера', () => {
    const pin = first.certificates[0]!.pin;
    expect(certificateLines(first, { APP_ENV: 'stage' }).join('\n')).toContain(`код ${pin}`);
    expect(certificateLines(first, { APP_ENV: 'dev' }).join('\n')).toContain(`код ${pin}`);
    const test = certificateLines(first, { APP_ENV: 'test' });
    expect(test).toHaveLength(4);
    expect(test.join('\n')).not.toContain('код');
  });

  it('повтор не плодит дубли и не пишет аудит; на следующий день – тоже', async () => {
    const before = await counts();
    const again = await seedCommerce(pool, { env: { APP_ENV: 'stage' }, certPepper: PEPPER }, clock);
    expect(again.created).toEqual({ categories: 0, openingBalances: 0, operations: 0, certificates: 0, pointBatches: 0, bookings: 0, payments: 0 });
    expect(again.certificates).toEqual([]);
    expect(await counts()).toEqual(before);
    const later = await seedCommerce(pool, { env: { APP_ENV: 'test' }, certPepper: PEPPER }, fixedClock('2026-11-15T05:00:00Z'));
    expect(later.created.bookings).toBe(0);
    expect(await counts()).toEqual(before);
  });

  it('ночная сверка S2-80 на засеянных данных – ноль расхождений', async () => {
    const r = (await runReconcile(pool, { trigger: 'manual', clock, logger: quiet }))!;
    expect(r.discrepancies).toEqual([]);
    expect(r.checked).toMatchObject({ certificate_balance: 4, loyalty_points: 3, cash_place: 4 });
  });
});

describe('S2-81: свежий стенд – Э0, Э1 и Э2 одним запуском', () => {
  it('вчера у филиала не было графика и ПК: сеансы с приходом – завтра; брони, оплаты и сверка – как обычно', async () => {
    const fresh = await createTestDatabase({ migrate: true });
    const p = new pg.Pool({ connectionString: fresh.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
    try {
      await seedDev(p, { env: { APP_ENV: 'test' }, password: 'Демо-пароль-засева-1' }, clock);
      await seedResources(p, { env: { APP_ENV: 'test' } }, clock);
      const r = await seedCommerce(p, { env: { APP_ENV: 'test' }, certPepper: PEPPER }, clock);
      expect(r.created).toMatchObject({ bookings: 8, payments: 4 });
      const paid = await fresh.client.query(`SELECT min(lower(b.period)) AS s FROM app.bookings b JOIN app.payment_sessions s ON s.booking_id = b.id`);
      expect(paid.rows[0].s.getTime()).toBeGreaterThan(clock.now().getTime());
      expect((await runReconcile(p, { trigger: 'manual', clock, logger: quiet }))!.discrepancies).toEqual([]);
    } finally {
      await p.end();
      await fresh.drop();
    }
  });
});

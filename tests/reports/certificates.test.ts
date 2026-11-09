// S4-68: отчёт «Сертификаты» (K24 §3.8, 14 §11). TC-08 в отчёте: продажа – поступление, погашение уменьшает остаток без дохода,
// сгорание отдельно; погашение в другом филиале – в филиале погашения, выручка – в филиале продажи (Q-25); подарок имениннику –
// право на услугу (выдано, использовано, сгорело – rpt_gift_ops 0425); детализация = итог; права. Данные – командами модулей, как в S2-80.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { cancelSale, expireDueCertificates } from '../../apps/api/src/modules/certificates/lifecycle.ts';
import { createCertificatePaymentMethod } from '../../apps/api/src/modules/certificates/payment-method.ts';
import { expireDueGifts, issueGift } from '../../apps/api/src/modules/events/gifts.ts';
import { sellCertificate, type CertificateDto } from '../../apps/api/src/modules/certificates/sale.ts';
import { certificateDefs, certificatesDetail, certificatesReport, giftDefs, type CertificatesMetric } from '../../apps/api/src/modules/reports/certificates.ts';
import { financeReport } from '../../apps/api/src/modules/reports/finance.ts';
import { createTestPayment } from '../helpers/payment.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';
import { d, reportFixtures, type Fx } from '../helpers/reports.ts';

const PEPPER = 'cert-pepper-'.padEnd(40, 'c');
const SALE_AT = '2026-10-05T05:00:00Z';
const OCT = { from: d('2026-10-01'), to: d('2026-10-31') };
const clock = fixedClock(SALE_AT);
let db: TestDatabase;
let fx: Fx;
let saleBranch: string;
let otherBranch: string;
let resOther: string;
let clientId: string;
let c1: { certificate: CertificateDto; pin: string };
let usedBooking: string;

const val = (m: { state: string; value?: number } | undefined) => (m?.state === 'ok' ? m.value : m?.state);
const meta = (o: AccessContext) => ({ actor: o.actor, access: o, source: 'crm' as const, requestId: randomUUID() });
async function tx<T>(fn: (t: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await fx.app.connect();
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
const sell = (nominalKop: number, branchId = saleBranch, at = clock) => {
  const o = fx.owner();
  return tx((t) => sellCertificate(t, o, { branchId, nominalKop, method: 'card' }, meta(o), { pepper: PEPPER, clock: at }));
};
async function redeem(cert: typeof c1, amountKop: number, branchId: string, resourceId: string, at: string) {
  const handler = createCertificatePaymentMethod({ pepper: PEPPER });
  const id = await fx.booking({ branchId, clientId, resourceId, start: at, status: 'arrived', priceKop: amountKop });
  const paymentId = await createTestPayment(db.client, id);
  const session = { id, bookingId: id, branchId, clientId, amountDueKop: amountKop, bookingVersion: 1, status: 'unpaid' as const, activePaymentId: null, rowVersion: 1 };
  await tx((t) =>
    handler.charge(t, {
      session, lineNo: 1, amountKop, minutes: 60, resourceType: 'pc', certificate: { number: cert.certificate.number, pin: cert.pin },
      idempotencyKey: `payment:${id}:1:1`, author: { type: 'staff', id: fx.ownerId }, occurredAt: new Date(at), mode: 'exact', paymentId,
    }),
  );
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  fx = await reportFixtures(db);
  saleBranch = (await fx.branch('Asia/Novosibirsk')).id;
  otherBranch = (await fx.branch('Europe/Moscow')).id;
  resOther = await fx.resource(otherBranch, 'pc', 'ПК', []);
  clientId = await fx.client({ firstName: 'Иван', lastName: 'Петров' });
  // c1: продан в НСК, частично погашен в Москве
  c1 = await sell(500_000);
  await redeem(c1, 120_000, otherBranch, resOther, '2026-10-10T10:00:00Z');
  // c2: продан и аннулирован
  const c2 = await sell(100_000);
  const o = fx.owner();
  await tx((t) => cancelSale(t, o, { certificateId: c2.certificate.id, rowVersion: c2.certificate.rowVersion, reason: 'передумал', refundMoney: true }, meta(o), clock));
  // c3: продан, сгорел остаток – сгорание на дату за пределами октября, проверим на месяце сгорания
  const c3 = await sell(70_000);
  await expireDueCertificates(fx.app, fixedClock(new Date(new Date(c3.certificate.expiresAt).getTime() + 1000).toISOString()));
  // подарки: три выдачи в НСК в октябре; g1 использован в Москве, g2 сгорел (60 дней – 04.12 последний день, сгорание 05.12 по НСК)
  const gift = async (firstName: string) => {
    const cid = await fx.client({ firstName, lastName: 'Именинник' });
    return tx((t) => issueGift(t, o, { clientId: cid, branchId: saleBranch, reason: 'день рождения в клубе' }, meta(o), clock));
  };
  const g1 = await gift('Аня');
  await gift('Боря');
  await gift('Вера');
  // использование – как обработчик visit.confirmed (gift-booking.ts): запись gift_uses used + статус подарка
  usedBooking = await fx.booking({ branchId: otherBranch, clientId: g1.clientId, resourceId: resOther, start: '2026-10-20T09:00:00Z', status: 'completed', priceKop: 0 });
  await db.client.query(`INSERT INTO app.gift_uses (gift_id, booking_id, status, changed_at) VALUES ($1, $2, 'used', '2026-10-20T09:40:00Z')`, [g1.id, usedBooking]);
  await db.client.query(`UPDATE app.birthday_gifts SET status = 'used' WHERE id = $1`, [g1.id]);
  expect(await expireDueGifts(fx.app, fixedClock('2026-12-06T00:00:00Z'))).toBe(2); // g2 и g3 не использованы
}, 60_000);
afterAll(async () => {
  await fx.close();
  await db.drop();
});

describe('сертификаты (S4-68)', () => {
  it('TC-08: продажа – поступление, погашение – не поступление, сумма поступлений не выросла при погашении', async () => {
    const r = await fx.run(fx.owner(), (env) => certificatesReport(env, { period: OCT }));
    expect(val(r.metrics.salesCount)).toBe(3);
    expect(val(r.metrics.salesAmount)).toBe(670_000);
    expect(val(r.metrics.redeemedAmount)).toBe(120_000);
    expect(val(r.metrics.cancelledCount)).toBe(1);
    expect(r.labels.redeemed).toContain('не является поступлением');
    const fin = await fx.run(fx.owner(), (env) => financeReport(env, { period: OCT }));
    expect(val(fin.metrics.incomeCertificateSale)).toBe(670_000); // в кассе только продажа, 120 000 погашения там нет
    expect(val(fin.metrics.income)).toBe(670_000);
    expect(val(fin.metrics.nonMoneyCertificate)).toBe(0); // оплата K10 не записана – только списание сертификата
  });

  it('Q-25: погашение – в филиале погашения, выручка – в филиале продажи', async () => {
    const sale = await fx.run(fx.owner(), (env) => certificatesReport(env, { period: OCT, branchIds: [saleBranch] }));
    expect(val(sale.metrics.salesAmount)).toBe(670_000);
    expect(val(sale.metrics.redeemedAmount)).toBe(0);
    const other = await fx.run(fx.owner(), (env) => certificatesReport(env, { period: OCT, branchIds: [otherBranch] }));
    expect(val(other.metrics.redeemedAmount)).toBe(120_000);
    expect(other.metrics.salesAmount).toMatchObject({ value: 0 });
    // остаток активных – у филиала продажи
    expect(val(sale.metrics.activeBalance)).toBe(380_000 + 70_000); // c1 + c3 ещё не сгорел в октябре
    expect(val(sale.metrics.activeCount)).toBe(2);
    expect(val(sale.metrics.partiallyRedeemed)).toBe(1);
    expect(other.metrics.activeCount).toEqual({ state: 'no_data' });
  });

  it('сгорание – отдельным показателем в своём месяце; активные на конец учитывают сгорание', async () => {
    const months = (await db.client.query<{ at: Date }>(`SELECT at FROM app.rpt_certificate_ops WHERE op = 'expire'`)).rows;
    expect(months).toHaveLength(2); // c1 и c3
    const at = months[0]!.at;
    const y = at.getUTCFullYear();
    const m = String(at.getUTCMonth() + 1).padStart(2, '0');
    const last = new Date(Date.UTC(y, at.getUTCMonth() + 1, 0)).getUTCDate();
    const later = await fx.run(fx.owner(), (env) => certificatesReport(env, { period: { from: d(`${y}-${m}-01`), to: d(`${y}-${m}-${String(last).padStart(2, '0')}`) } }), `${y}-${m}-28T00:00:00Z`);
    expect(val(later.metrics.expiredCount)).toBe(2);
    expect(val(later.metrics.expiredAmount)).toBe(380_000 + 70_000);
    expect(val(later.metrics.activeCount)).toBe(0);
    expect(val(later.metrics.activeBalance)).toBe(0);
  });

  it('подарок имениннику – право на услугу: выдано в филиале выдачи, использовано в филиале брони, сгорело в своём месяце; не деньги', async () => {
    const r = await fx.run(fx.owner(), (env) => certificatesReport(env, { period: OCT }));
    expect([val(r.metrics.birthdayGift), val(r.metrics.birthdayGiftUsed), val(r.metrics.birthdayGiftExpired)]).toEqual([3, 1, 0]);
    expect(r.metrics.birthdayGift).toMatchObject({ unit: 'count' });
    expect(val(r.metrics.salesCount)).toBe(3); // сертификаты подарками не выросли
    expect(r.labels.birthdayGift).toContain('не деньги');
    const sale = await fx.run(fx.owner(), (env) => certificatesReport(env, { period: OCT, branchIds: [saleBranch] }));
    expect([val(sale.metrics.birthdayGift), val(sale.metrics.birthdayGiftUsed)]).toEqual([3, 0]);
    const other = await fx.run(fx.owner(), (env) => certificatesReport(env, { period: OCT, branchIds: [otherBranch] }));
    expect([val(other.metrics.birthdayGift), val(other.metrics.birthdayGiftUsed)]).toEqual([0, 1]);
    const dec = await fx.run(fx.owner(), (env) => certificatesReport(env, { period: { from: d('2026-12-01'), to: d('2026-12-31') } }), '2026-12-20T00:00:00Z');
    expect([val(dec.metrics.birthdayGift), val(dec.metrics.birthdayGiftExpired)]).toEqual([0, 2]);
    const fin = await fx.run(fx.owner(), (env) => financeReport(env, { period: OCT }));
    expect(val(fin.metrics.income)).toBe(670_000);
    const used = await fx.run(fx.director([otherBranch]), (env) => certificatesDetail(env, { period: OCT }, 'birthdayGiftUsed'));
    expect(used.rows).toHaveLength(1);
    expect(used.rows[0]).toMatchObject({ op: 'use', branchId: otherBranch, bookingId: usedBooking, value: 1, balanceAfterKop: 0 });
    expect(used.rows[0]!.number).toMatch(/^GF-/);
    expect(used.rows[0]!.client).toMatchObject({ name: expect.stringContaining('Аня') });
    const issued = await fx.run(fx.director([otherBranch]), (env) => certificatesDetail(env, { period: OCT }, 'birthdayGift'));
    expect(issued.total).toEqual({ state: 'no_data' }); // выдача – в зоне НСК, Директору Москвы не видна
  });

  it('детализация = итог; строка погашения: клиент-маска, сеанс, сотрудник, остаток после; права', async () => {
    const report = await fx.run(fx.owner(), (env) => certificatesReport(env, { period: OCT }));
    for (const key of [...Object.keys(certificateDefs()), 'activeCount', 'activeBalance', 'partiallyRedeemed', ...Object.keys(giftDefs())] as CertificatesMetric[]) {
      const rows: Array<{ value: number }> = [];
      let cursor: string | undefined;
      do {
        const page = await fx.run(fx.owner(), (env) => certificatesDetail(env, { period: OCT }, key, { limit: 2, ...(cursor ? { cursor } : {}) }));
        rows.push(...page.rows);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(rows.reduce((s, x) => s + x.value, 0), key).toBe(val(report.metrics[key]));
    }
    const dir = fx.director([otherBranch]);
    const page = await fx.run(dir, (env) => certificatesDetail(env, { period: OCT }, 'redeemedAmount'));
    expect(page.rows).toHaveLength(1);
    const row = page.rows[0]!;
    expect(row).toMatchObject({ op: 'redeem', branchId: otherBranch, balanceAfterKop: 380_000, value: 120_000, authorId: fx.ownerId, number: c1.certificate.number });
    expect(row.bookingId).toBeTruthy();
    expect(row.client).toMatchObject({ name: 'Иван Петров' }); // Директор зоны с client.view.full
    await expect(fx.run(dir, (env) => certificatesReport(env, { period: OCT, branchIds: [saleBranch] }))).rejects.toMatchObject({ httpStatus: 404 });
    await expect(fx.run(fx.admin([saleBranch]), (env) => certificatesReport(env, { period: OCT }))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(fx.run(fx.owner(), (env) => certificatesDetail(env, { period: OCT }, 'нет'))).rejects.toMatchObject({ code: 'REPORT_FILTER_INVALID' });
  });
});

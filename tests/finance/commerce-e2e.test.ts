// S2-82: сквозные контрольные сценарии 18 §6.3 (все 10) на API через app.inject и embedded-postgres.
// Полный путь каждого: бронь администратором (K11 №4) → приход → оплата / возврат / баллы / сертификат / неявка / штраф
// → обработчики outbox (как worker.ts: начисление, штраф, резерв – доставка processEvent до пустой очереди).
// После каждого шага – журнал K3 (кэш баланса = Σ записей), касса (счёт места денег = Σ операций кассы), партии баллов
// (Σ remaining активных = max(0, баланс)), остатки сертификатов (≥ 0) – invariants(); плюс ожидаемые дельты шага.
// Где сценарий ТЗ уже по решению по умолчанию (docs/reshenia.md) – тест проверяет поведение по умолчанию и ссылается
// на решение: п.2 – R-03 (Q-24, payment.certificate_topup_enabled = false), п.9 – R-05 (Q-43: бессрочно, здесь срок
// партий включён на 30 дней, чтобы «исходный срок» был датой), п.7 – Q-20 (оплата только после прихода), Q-40 (за баллы
// не начисляется).
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import { listSubscriptions, processEvent } from '../../apps/api/src/core/outbox.ts';
import type { Clock } from '../../apps/api/src/core/time.ts';
import { paymentBookingProvider } from '../../apps/api/src/modules/booking/providers.ts';
import { expireDueCertificates } from '../../apps/api/src/modules/certificates/lifecycle.ts';
import { createCertificatePaymentMethod } from '../../apps/api/src/modules/certificates/payment-method.ts';
import { registerPaymentMethod } from '../../apps/api/src/modules/finance/methods.ts';
import { paymentLookup } from '../../apps/api/src/modules/finance/payment.ts';
import { registerAccrualHandlers } from '../../apps/api/src/modules/loyalty/accrual.ts';
import { registerPenaltyHandlers } from '../../apps/api/src/modules/loyalty/penalty.ts';
import { registerReserveHandlers } from '../../apps/api/src/modules/loyalty/reserve.ts';
import { hashPassword, staffAuthConfig } from '../../apps/api/src/modules/staff/auth.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const SYS = '00000000-0000-0000-0000-000000000001';
const PASSWORD = 'Пароль-сквозных-сценариев-1';
const PEPPER = 'cert-pepper-'.padEnd(40, 'e');
const BASE = '/api/crm/v1';
const PRICE = 40_000; // ПК: 200 ₽ за 30 мин → час 400 ₽
let t = Date.parse('2026-11-15T03:00:00Z');
const clock: Clock = { now: () => new Date(t) };
let db: TestDatabase;
let pool: pg.Pool;
let app: FastifyInstance;
const cookies: Record<string, string> = {};
const ids: Record<string, string> = {};
let slotNo = 0;

type Res = Awaited<ReturnType<FastifyInstance['inject']>>;
async function one<T = { id: string }>(sql: string, params: unknown[] = []): Promise<T> {
  return (await db.client.query(sql, params)).rows[0] as T;
}
const num = async (sql: string, params: unknown[] = []) => Number((await one<{ n: string | number | null } | undefined>(sql, params))?.n ?? 0);
async function signIn(key: string): Promise<void> {
  const res = await app.inject({ method: 'POST', url: `${BASE}/auth/login`, payload: { email: `${key}@yu.test`, password: PASSWORD } });
  expect(res.statusCode, res.body).toBe(200);
  cookies[key] = String(res.headers['set-cookie']).split(';')[0]!;
}
async function staff(key: string, role: string, branchId?: string): Promise<string> {
  const r = await one(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', $1, $2, $3) RETURNING id`, [`${key}@yu.test`, role, await hashPassword(PASSWORD)]);
  if (branchId) await db.client.query(`INSERT INTO app.staff_assignments (staff_id, scope_type, branch_id, valid_from, created_by) VALUES ($1, 'branch', $2, '2026-01-01', $1)`, [r.id, branchId]);
  await signIn(key);
  return r.id;
}
/** Часы вперёд; сессия сотрудника живёт по тем же часам – входим заново. */
async function setTime(ms: number): Promise<void> {
  t = ms;
  for (const k of Object.keys(cookies)) await signIn(k);
}
function req(who: string, method: 'GET' | 'POST', url: string, payload?: object, key: string = randomUUID()): Promise<Res> {
  const headers: Record<string, string> = { cookie: cookies[who]! };
  if (method !== 'GET') headers['idempotency-key'] = key;
  return app.inject({ method, url: `${BASE}${url}`, headers, ...(payload ? { payload } : {}) });
}
const code = (r: Res) => (r.json() as { error?: { code: string } }).error?.code ?? String(r.statusCode);
const rowVersion = async (bookingId: string) => (await req('admin', 'GET', `/bookings/${bookingId}`)).json().rowVersion as number;
async function newClient(): Promise<string> {
  return (await one(`INSERT INTO app.clients (phone_e164, first_name, status, created_by_type, registered_at) VALUES ($1, 'К', 'active', 'system', now()) RETURNING id`, [`+7913${String(2_000_000 + slotNo * 13 + Math.floor(Math.random() * 1000)).padStart(7, '0')}`])).id;
}
async function setNetwork(key: string, value: unknown): Promise<void> {
  await db.client.query(`DELETE FROM app.settings_values WHERE key = $1`, [key]);
  await db.client.query(`INSERT INTO app.settings_values (key, level, value, valid_from, created_by) VALUES ($1, 'network', $2, '2026-01-01', $3)`, [key, JSON.stringify(value), SYS]);
}

/** Слот следующего часа: 11:00–20:00 по Новосибирску, по 10 в день, начиная с 16.11. */
function nextSlot(): { start: number; end: number } {
  for (;;) {
    const i = slotNo++;
    const start = Date.parse('2026-11-16T04:00:00Z') + Math.floor(i / 10) * 86_400_000 + (i % 10) * 3_600_000;
    if (start >= t + 30 * 60_000) return { start, end: start + 3_600_000 }; // часы уже ушли вперёд – слот позже
  }
}
/** Бронь администратором через CRM (K11 №4) за 30 мин до начала – с этого момента разрешён приход (Q-101). */
async function book(clientId: string, at?: { start: number; end: number }): Promise<{ id: string; start: number; end: number }> {
  const s = at ?? nextSlot();
  await setTime(Math.max(t, s.start - 30 * 60_000));
  const r = await req('admin', 'POST', `/branches/${ids.b1}/bookings`, { resourceId: ids.pc, start: new Date(s.start).toISOString(), end: new Date(s.end).toISOString(), client: { clientId } });
  expect(r.statusCode, r.body).toBe(201);
  return { id: r.json().id, ...s };
}
async function arrive(bookingId: string): Promise<void> {
  const r = await req('admin', 'POST', `/bookings/${bookingId}/arrive`, { rowVersion: await rowVersion(bookingId) });
  expect(r.statusCode, r.body).toBe(200);
}
const payment = async (bookingId: string, who = 'admin') => (await req(who, 'GET', `/bookings/${bookingId}/payment`)).json();
const pay = (bookingId: string, lines: object[], key?: string, who = 'admin') => req(who, 'POST', `/bookings/${bookingId}/payment`, { lines }, key);
async function sell(nominalKop: number, method: 'cash' | 'card' = 'cash'): Promise<{ id: string; number: string; pin: string }> {
  const r = await req('director', 'POST', `/branches/${ids.b1}/certificates`, { nominalKop, method });
  expect(r.statusCode, r.body).toBe(201);
  return { id: r.json().certificate.id, number: r.json().certificate.number, pin: r.json().pin };
}
const certLine = (c: { number: string; pin: string }, amountKop = PRICE) => ({ method: 'certificate', amountKop, certificate: { number: c.number, pin: c.pin } });

/** Доставка outbox всем подпискам этого процесса (как worker), пока очередь не опустеет. */
async function drain(): Promise<number> {
  let total = 0;
  for (;;) {
    let n = 0;
    for (const s of listSubscriptions()) {
      const ev = await db.client.query<{ id: string }>(
        `SELECT e.id FROM app.outbox_events e WHERE e.event_type = $1
           AND NOT EXISTS (SELECT 1 FROM app.processed_events p WHERE p.handler = $2 AND p.event_id = e.id)
         ORDER BY e.occurred_at, e.xmin::text::bigint`,
        [s.type, s.name],
      );
      for (const r of ev.rows) n += (await processEvent(pool, s.name, r.id, clock.now())) === 'processed' ? 1 : 0;
    }
    total += n;
    if (n === 0) return total;
  }
}

// ---- снимки и инварианты

const cashOf = (place: 'cash' | 'noncash') =>
  num(`SELECT balance AS n FROM app.ledger_accounts WHERE owner_id = $1 AND kind = $2`, [ids.b1, place === 'cash' ? 'cash_branch' : 'cash_branch_noncash']);
const certBalance = (certId: string) => num(`SELECT la.balance AS n FROM app.certificates c JOIN app.ledger_accounts la ON la.id = c.ledger_account_id WHERE c.id = $1`, [certId]);
const points = (clientId: string) => num(`SELECT balance AS n FROM app.ledger_accounts WHERE kind = 'loyalty_client' AND owner_id = $1`, [clientId]);
const opsCount = () => num(`SELECT count(*) AS n FROM journal.finance_operations WHERE branch_id = $1`, [ids.b1]);
const livePayments = (bookingId: string) => num(`SELECT count(*) AS n FROM app.payments WHERE session_id = $1 AND status IN ('active','partially_refunded')`, [bookingId]);
const entries = (type: string, accountKind: string) =>
  num(`SELECT count(*) AS n FROM journal.ledger_entries e JOIN app.ledger_accounts a ON a.id = e.account_id WHERE e.entry_type = $1 AND a.kind = $2`, [type, accountKind]);

/** Инварианты базы после шага (16 §14, S2-80): нарушение – список строк, ожидание – пусто. */
async function invariants(step: string): Promise<void> {
  const rows = async (sql: string) => (await db.client.query(sql)).rows;
  const report = {
    // K3: кэш баланса = Σ записей журнала
    ledger: await rows(`SELECT a.id, a.kind, a.balance, coalesce(sum(e.amount), 0) AS sum FROM app.ledger_accounts a LEFT JOIN journal.ledger_entries e ON e.account_id = a.id
                        GROUP BY a.id HAVING a.balance <> coalesce(sum(e.amount), 0)`),
    // K15 §2: Σ остатков активных партий = max(0, баланс)
    batches: await rows(`SELECT a.owner_id, a.balance, coalesce(sum(b.remaining_centi), 0) AS sum FROM app.ledger_accounts a
                         LEFT JOIN app.loyalty_batches b ON b.client_id = a.owner_id AND b.status = 'active'
                         WHERE a.kind = 'loyalty_client' GROUP BY a.owner_id, a.balance HAVING coalesce(sum(b.remaining_centi), 0) <> greatest(0, a.balance)`),
    // K15 §5: ниже −50 баланс не уходит без корректировки Владельца
    belowLimit: await rows(`SELECT owner_id, balance FROM app.ledger_accounts WHERE kind = 'loyalty_client' AND balance < -5000`),
    // K16: остаток сертификата ≥ 0 и = номинал − погашения + возвраты погашений − сгорание (корректировок здесь нет)
    certNegative: await rows(`SELECT id, balance FROM app.ledger_accounts WHERE kind = 'certificate' AND balance < 0`),
    certFormula: await rows(`SELECT c.id, la.balance, c.nominal_kop
                             FROM app.certificates c JOIN app.ledger_accounts la ON la.id = c.ledger_account_id
                             WHERE la.balance <> c.nominal_kop - coalesce((SELECT sum(r.amount_kop) FROM app.certificate_redemptions r WHERE r.certificate_id = c.id AND r.status IN ('active','not_restored')), 0)
                                  - coalesce((SELECT -sum(e.amount) FROM journal.ledger_entries e WHERE e.account_id = la.id AND e.entry_type = 'certificate.expire'), 0)`),
    // K17: касса = операции (по месту денег; переводов между местами в сценариях нет)
    cash: await rows(`SELECT a.owner_id, a.kind, a.balance FROM app.ledger_accounts a WHERE a.kind IN ('cash_branch','cash_branch_noncash')
                        AND a.balance <> coalesce((SELECT sum(CASE WHEN o.direction = 'in' THEN o.amount_kop ELSE -o.amount_kop END) FROM journal.finance_operations o
                                                   WHERE o.branch_id = a.owner_id AND o.place = CASE a.kind WHEN 'cash_branch' THEN 'cash' ELSE 'noncash' END), 0)`),
    // TC-07: один живой платёж на сеанс
    livePayments: await rows(`SELECT session_id, count(*) FROM app.payments WHERE status IN ('active','partially_refunded') GROUP BY session_id HAVING count(*) > 1`),
    // начисление – только при посещении и живом платеже не баллами (K15 §4)
    accrualWithoutVisit: await rows(`SELECT a.id FROM app.loyalty_accruals a JOIN app.bookings b ON b.id = a.booking_id WHERE a.status = 'active' AND b.status NOT IN ('arrived','completed')`),
  };
  expect({ step, ...report }).toEqual({ step, ledger: [], batches: [], belowLimit: [], certNegative: [], certFormula: [], cash: [], livePayments: [], accrualWithoutVisit: [] });
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 20 });
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), { staff: { pool, auth: staffAuthConfig('c'.repeat(40)), clock }, certificates: { pepper: PEPPER } });
  registerPaymentMethod(createCertificatePaymentMethod({ pepper: PEPPER }));
  // подписки баллов – как worker.ts (без уведомлений): штраф, резерв, начисление по finance paymentLookup
  registerPenaltyHandlers({ bookings: paymentBookingProvider, clock });
  registerReserveHandlers({ bookings: paymentBookingProvider, clock, payments: paymentLookup });
  registerAccrualHandlers({ bookings: paymentBookingProvider, payments: paymentLookup, clock });

  const city = await one(`INSERT INTO app.cities (code, slug, name, timezone) VALUES ('nsk', 'nsk', 'НСК', 'Asia/Novosibirsk') RETURNING id`);
  ids.b1 = (await one(`INSERT INTO app.branches (city_id, code, slug, name, address, timezone, status) VALUES ($1, 'b1', 'b1', 'Красный', 'адрес', 'Asia/Novosibirsk', 'active') RETURNING id`, [city.id])).id;
  await db.client.query(`INSERT INTO app.branch_weekly_hours (branch_id, weekday, open_time, close_time, valid_from, created_by) SELECT $1, d, '10:00', '22:00', '2026-01-01', $2 FROM generate_series(1, 7) d`, [ids.b1, SYS]);
  await db.client.query(`INSERT INTO app.tariffs (branch_id, resource_type, name, unit_minutes, price_per_unit_kop, valid_from, status, created_by) VALUES ($1, 'pc', 'ПК', 30, 20000, '2026-01-01', 'active', $2)`, [ids.b1, SYS]);
  const unit = await one(`INSERT INTO app.occupancy_units (branch_id, room_id, code, name) VALUES ($1, NULL, 'PC1', 'PC1') RETURNING id`, [ids.b1]);
  ids.pc = (await one(`INSERT INTO app.resources (branch_id, room_id, resource_type, name) VALUES ($1, NULL, 'pc', 'ПК-1') RETURNING id`, [ids.b1])).id;
  await db.client.query(`INSERT INTO app.resource_units (resource_id, unit_id, valid_from) VALUES ($1, $2, '2026-01-01')`, [ids.pc, unit.id]);
  await setNetwork('loyalty.penalties_from', '2026-11-01T00:00:00.000Z'); // D2-03: штрафы включены с запуска Э2
  await setNetwork('loyalty.batch_ttl_days', 30); // R-05 по умолчанию бессрочно; срок нужен п.9 – «исходный срок» датой
  ids.owner = await staff('owner', 'owner');
  ids.director = await staff('director', 'director', ids.b1);
  ids.admin = await staff('admin', 'admin', ids.b1);
});
afterAll(async () => {
  await app?.close();
  await pool?.end();
  await db?.drop();
});

describe('18 §6.3: обязательные контрольные сценарии Э2', () => {
  it('п.1 повторное нажатие оплаты не создаёт дубль: тот же ключ – тот же платёж, 10 параллельных ключей – один 201', async () => {
    const client = await newClient();
    const b = await book(client);
    await arrive(b.id);
    await invariants('п.1 приход');
    const cash0 = await cashOf('cash');
    const ops0 = await opsCount();
    const key = randomUUID();
    const first = await pay(b.id, [{ method: 'cash', amountKop: PRICE }], key);
    expect(first.statusCode, first.body).toBe(201);
    const again = await pay(b.id, [{ method: 'cash', amountKop: PRICE }], key);
    expect([again.statusCode, again.headers['idempotent-replay'], again.json().paymentId]).toEqual([201, 'true', first.json().paymentId]);
    expect([await livePayments(b.id), (await cashOf('cash')) - cash0, (await opsCount()) - ops0]).toEqual([1, PRICE, 1]);
    const other = await pay(b.id, [{ method: 'cash', amountKop: PRICE }]);
    expect([other.statusCode, code(other), other.json().error.details.paymentId]).toEqual([409, 'ALREADY_PAID', first.json().paymentId]);
    await invariants('п.1 повтор');

    // двойной клик с разными ключами (две вкладки): параллельно – ровно один платёж
    const b2 = await book(client);
    await arrive(b2.id);
    const rs = await Promise.all(Array.from({ length: 10 }, () => pay(b2.id, [{ method: 'card', amountKop: PRICE }])));
    const outcomes = rs.map((r) => `${r.statusCode} ${r.statusCode === 201 ? 'ok' : code(r)}`).sort();
    expect(outcomes.filter((o) => o === '201 ok')).toHaveLength(1);
    expect(outcomes.filter((o) => o !== '201 ok').every((o) => o === '409 ALREADY_PAID' || o === '409 VERSION_CONFLICT')).toBe(true);
    expect([await livePayments(b2.id), await num(`SELECT count(*) AS n FROM journal.finance_operations o JOIN app.payments p ON p.id = o.ref_id WHERE o.source = 'session' AND p.session_id = $1`, [b2.id])]).toEqual([1, 1]);
    expect(await cashOf('noncash')).toBe(PRICE);
    await drain();
    await invariants('п.1 параллельно');
  });

  it('п.2 один сеанс – один способ: пары способов – PAYMENT_METHODS_COMBINED (R-03 по умолчанию выключен: Q-24)', async () => {
    const client = await newClient();
    const cert = await sell(10_000); // 100 ₽ – меньше цены сеанса
    const b = await book(client);
    await arrive(b.id);
    expect((await payment(b.id)).topupEnabled).toBe(false); // R-03: payment.certificate_topup_enabled = false
    const before = { cash: await cashOf('cash'), noncash: await cashOf('noncash'), cert: await certBalance(cert.id), ops: await opsCount() };
    const pairs: object[][] = [
      [{ method: 'cash', amountKop: 20_000 }, { method: 'card', amountKop: 20_000 }],
      [certLine(cert, 10_000), { method: 'cash', amountKop: 30_000 }],
      [{ method: 'points', amountKop: 20_000 }, { method: 'cash', amountKop: 20_000 }],
    ];
    for (const lines of pairs) {
      const r = await pay(b.id, lines);
      expect([r.statusCode, code(r)]).toEqual([422, 'PAYMENT_METHODS_COMBINED']);
    }
    expect({ cash: await cashOf('cash'), noncash: await cashOf('noncash'), cert: await certBalance(cert.id), ops: await opsCount() }).toEqual(before);
    expect(await num(`SELECT count(*) AS n FROM app.payments WHERE session_id = $1`, [b.id])).toBe(0);
    // одним способом сеанс закрывается
    const ok = await pay(b.id, [{ method: 'transfer', amountKop: PRICE }]);
    expect(ok.statusCode, ok.body).toBe(201);
    expect(await num(`SELECT count(*) AS n FROM app.payment_lines WHERE payment_id = $1`, [ok.json().paymentId])).toBe(1);
    await drain();
    await invariants('п.2');
  });

  it('п.3 и п.5 частичные погашения уменьшают остаток; сверх остатка – CERTIFICATE_INSUFFICIENT, остаток не меняется', async () => {
    const client = await newClient();
    const cert = await sell(100_000); // 1000 ₽
    ids.cert = cert.id;
    for (const [i, left] of [[1, 60_000], [2, 20_000]] as const) {
      const b = await book(client);
      await arrive(b.id);
      const r = await pay(b.id, [certLine(cert)]);
      expect([i, r.statusCode, r.json().session?.status]).toEqual([i, 201, 'paid']);
      expect(await certBalance(cert.id)).toBe(left);
      const check = await req('admin', 'POST', '/certificates/check', { branchId: ids.b1, number: cert.number, pin: cert.pin });
      expect(check.json()).toMatchObject({ balanceKop: left, status: 'partially_used' });
      await invariants(`п.5 погашение ${i}`);
    }
    expect(await entries('certificate.redeem', 'certificate')).toBeGreaterThanOrEqual(2);
    const card = (await req('director', 'GET', `/certificates/${cert.id}`)).json();
    expect(card.balanceKop).toBe(20_000);

    const over = await book(client);
    await arrive(over.id);
    const r = await pay(over.id, [certLine(cert)]);
    expect([r.statusCode, code(r)]).toEqual([409, 'CERTIFICATE_INSUFFICIENT']);
    expect([await certBalance(cert.id), await num(`SELECT count(*) AS n FROM app.certificate_redemptions WHERE booking_id = $1`, [over.id]), await livePayments(over.id)]).toEqual([20_000, 0, 0]);
    expect((await payment(over.id)).allowedMethods).toContain('cash'); // сеанс остался к оплате
    await invariants('п.3 сверх остатка');
    ids.overBooking = over.id;
  });

  it('п.6 продажа сертификата и его погашение – одно денежное поступление: погашение только в nonMoney', async () => {
    const client = await newClient();
    const ops0 = await opsCount();
    const cash0 = await cashOf('noncash');
    const cert = await sell(50_000, 'card');
    expect([(await opsCount()) - ops0, (await cashOf('noncash')) - cash0]).toEqual([1, 50_000]);
    expect(await one(`SELECT kind, source, direction, amount_kop::int AS amount FROM journal.finance_operations WHERE ref_type = 'certificate' AND ref_id = $1`, [cert.id])).toEqual({ kind: 'income', source: 'certificate_sale', direction: 'in', amount: 50_000 });
    const b = await book(client);
    await arrive(b.id);
    const sum0 = (await req('owner', 'GET', `/branches/${ids.b1}/finance/summary?from=2026-11-15&to=2026-12-31`)).json();
    const r = await pay(b.id, [certLine(cert)]);
    expect(r.statusCode, r.body).toBe(201);
    expect([(await opsCount()) - ops0, (await cashOf('noncash')) - cash0]).toEqual([1, 50_000]); // погашение кассу не трогает
    const line = await one<{ finance_operation_id: string | null }>(`SELECT finance_operation_id FROM app.payment_lines WHERE payment_id = $1`, [r.json().paymentId]);
    expect(line.finance_operation_id).toBeNull();
    const sum1 = (await req('owner', 'GET', `/branches/${ids.b1}/finance/summary?from=2026-11-15&to=2026-12-31`)).json();
    expect(sum1.total.incomeKop).toBe(sum0.total.incomeKop);
    expect(sum1.incomeBySource.session).toBe(sum0.incomeBySource.session);
    expect(sum1.nonMoney.certificateRedeemedKop - sum0.nonMoney.certificateRedeemedKop).toBe(PRICE);
    await drain();
    await invariants('п.6');
  });

  it('п.7 баллы начисляются только после подтверждённого посещения: до прихода оплаты нет (Q-20), неявка – без начисления', async () => {
    const client = await newClient();
    ids.pointsClient = client;
    const b = await book(client);
    const early = await pay(b.id, [{ method: 'cash', amountKop: PRICE }]);
    expect([early.statusCode, code(early)]).toEqual([409, 'BOOKING_NOT_PAYABLE']);
    expect((await payment(b.id)).allowedMethods).toEqual([]);
    await drain();
    expect(await num(`SELECT count(*) AS n FROM app.loyalty_accruals WHERE booking_id = $1`, [b.id])).toBe(0);
    await arrive(b.id);
    await drain();
    expect(await num(`SELECT count(*) AS n FROM app.loyalty_accruals WHERE booking_id = $1`, [b.id])).toBe(0); // посещение без оплаты – рано
    const r = await pay(b.id, [{ method: 'cash', amountKop: PRICE }]);
    expect(r.statusCode, r.body).toBe(201);
    await drain();
    const acc = await one<{ status: string; amount: number; batches: number }>(
      `SELECT a.status, a.amount_centi::int AS amount, (SELECT count(*)::int FROM app.loyalty_batches WHERE booking_id = $1) AS batches FROM app.loyalty_accruals a WHERE a.booking_id = $1`,
      [b.id],
    );
    expect(acc).toEqual({ status: 'active', amount: 1_000, batches: 1 }); // 60 мин ÷ 6 = 10 баллов (07 §4.2)
    expect(await points(client)).toBe(1_000);
    await drain(); // повторная доставка – без второго начисления
    expect(await points(client)).toBe(1_000);
    await invariants('п.7 начисление');

    // неявка: посещения нет – начисления нет
    const ns = await book(client);
    await setTime(ns.start + 5 * 60_000);
    expect((await req('admin', 'POST', `/bookings/${ns.id}/no-show`, { rowVersion: await rowVersion(ns.id) })).statusCode).toBe(200);
    await drain();
    expect(await num(`SELECT count(*) AS n FROM app.loyalty_accruals WHERE booking_id = $1`, [ns.id])).toBe(0);
    expect(await points(ids.pointsClient)).toBe(1_000 - 500); // зато штраф 5 баллов (K15 §5)
    // исправили неявку – штраф снят
    expect((await req('director', 'POST', `/bookings/${ns.id}/revert-visit`, { rowVersion: await rowVersion(ns.id), reason: 'ошибка отметки' })).statusCode).toBe(200);
    await drain();
    expect(await points(ids.pointsClient)).toBe(1_000);
    await invariants('п.7 неявка и исправление');
  });

  it('п.8 неявка создаёт штраф, но баланс не опускается ниже −50; на −50 запись администратором закрыта', async () => {
    const client = await newClient();
    const adj = await req('owner', 'POST', `/clients/${client}/loyalty/adjust`, { deltaCenti: -4_800, reason: 'долг по прошлой системе' });
    expect(adj.statusCode, adj.body).toBe(201);
    const b = await book(client);
    nextSlot(); // пропуск часа: вторая бронь – отдельный визит, не «подряд» (Q-44)
    const later = nextSlot();
    const b2 = await book(client, later); // записан, пока баланс −48
    await setTime(b.start + 5 * 60_000);
    expect((await req('admin', 'POST', `/bookings/${b.id}/no-show`, { rowVersion: await rowVersion(b.id) })).statusCode).toBe(200);
    await drain();
    expect(await one(`SELECT status, applied_centi::int AS applied FROM app.loyalty_penalties WHERE booking_id = $1`, [b.id])).toEqual({ status: 'active', applied: -200 });
    expect(await points(client)).toBe(-5_000);
    await invariants('п.8 штраф обрезан');

    // на −50 новая запись администратором закрыта (K15 §8, R-13)
    const slot = nextSlot();
    const refused = await req('admin', 'POST', `/branches/${ids.b1}/bookings`, { resourceId: ids.pc, start: new Date(slot.start).toISOString(), end: new Date(slot.end).toISOString(), client: { clientId: client } });
    expect([refused.statusCode, code(refused)]).toEqual([403, 'LOYALTY_LIMIT_REACHED']);
    // следующая неявка на −50 пишется, баланс не меняется (07 §9.1, Q-103)
    await setTime(b2.start + 5 * 60_000);
    expect((await req('admin', 'POST', `/bookings/${b2.id}/no-show`, { rowVersion: await rowVersion(b2.id) })).statusCode).toBe(200);
    await drain();
    expect(await one(`SELECT status, applied_centi::int AS applied FROM app.loyalty_penalties WHERE booking_id = $1`, [b2.id])).toEqual({ status: 'active', applied: 0 });
    expect(await points(client)).toBe(-5_000);
    expect(await entries('loyalty.penalty', 'loyalty_client')).toBeGreaterThanOrEqual(1);
    await invariants('п.8 на пределе');
  });

  it('п.9 возврат баллов сохраняет исходный срок: та же партия, тот же expires_at, новой партии нет; за баллы не начисляется (Q-40)', async () => {
    const client = ids.pointsClient!;
    // 10 баллов за визит п.7 (партия со сроком) + 50 корректировкой Директора = 60 баллов на час ПК (1 балл = 1 минута, Q-42)
    const adj = await req('director', 'POST', `/clients/${client}/loyalty/adjust`, { deltaCenti: 5_000, reason: 'компенсация за сбой ПК' });
    expect(adj.statusCode, adj.body).toBe(201);
    const batches = () => db.client.query(`SELECT id, source, status, expires_at, remaining_centi::int AS remaining FROM app.loyalty_batches WHERE client_id = $1 ORDER BY accrued_at, id`, [client]).then((r) => r.rows);
    const batches0 = await batches();
    expect(batches0.map((x) => [x.source, x.status, x.remaining])).toEqual([['visit', 'active', 1_000], ['manual', 'active', 5_000]]);
    expect(batches0[0].expires_at).not.toBeNull(); // batch_ttl_days = 30 (R-05 по умолчанию – бессрочно)
    await invariants('п.9 корректировка');
    const b = await book(client);
    await arrive(b.id);
    const info = await payment(b.id);
    expect(info).toMatchObject({ pointsAvailableCenti: 6_000, pointsRequiredCenti: 6_000 });
    expect(info.allowedMethods).toContain('points');
    const ops0 = await opsCount();
    const r = await pay(b.id, [{ method: 'points', amountKop: PRICE }]);
    expect(r.statusCode, r.body).toBe(201);
    await drain();
    expect([await points(client), await opsCount() - ops0]).toEqual([0, 0]); // баллы – не деньги кассы
    expect((await batches()).map((x) => [x.status, x.remaining])).toEqual([['depleted', 0], ['depleted', 0]]);
    expect(await num(`SELECT count(*) AS n FROM app.loyalty_accruals WHERE booking_id = $1`, [b.id])).toBe(0);
    await invariants('п.9 оплата баллами');

    // админ возвращать не может (R-14), Директор – целиком с причиной
    const p = r.json();
    const denied = await req('admin', 'POST', `/payments/${p.paymentId}/refund`, { rowVersion: p.session.rowVersion, lines: [{ lineNo: 1 }], reason: 'ошибка' });
    expect(denied.statusCode).toBe(403);
    await setTime(t + 3 * 86_400_000); // возврат спустя три дня – срок партии не продлевается
    const lastMove = await num(`SELECT coalesce(max(id), 0) AS n FROM journal.loyalty_batch_moves`);
    const back = await req('director', 'POST', `/payments/${p.paymentId}/refund`, { rowVersion: p.session.rowVersion, lines: [{ lineNo: 1 }], reason: 'клиент передумал' });
    expect(back.statusCode, back.body).toBe(201);
    await drain();
    // те же партии, те же сроки, остатки восстановлены; новой партии нет (07 §7)
    expect(await batches()).toEqual(batches0);
    expect(await points(client)).toBe(6_000);
    const moves = await db.client.query(`SELECT batch_id, kind, delta_centi::int AS delta FROM journal.loyalty_batch_moves WHERE kind = 'return' AND id > $2 AND batch_id = ANY($1::uuid[]) ORDER BY id`, [batches0.map((x) => x.id), lastMove]);
    expect(moves.rows.map((m) => [m.batch_id, m.delta]).sort()).toEqual([[batches0[0].id, 1_000], [batches0[1].id, 5_000]].sort());
    await invariants('п.9 возврат');
  });

  it('п.10 финансовая корректировка не удаляет первичный платёж и операцию', async () => {
    // ручной приход: исправление = сторно + новая, исходная на месте
    const inc = await req('owner', 'POST', `/branches/${ids.b1}/finance/income`, { method: 'cash', amountKop: 15_000, source: 'other', occurredAt: new Date(t).toISOString(), comment: 'аренда стола' });
    expect(inc.statusCode, inc.body).toBe(201);
    const cash0 = await cashOf('cash');
    const fix = await req('owner', 'POST', `/finance/operations/${inc.json().id}/correct`, { reason: 'опечатка в сумме', replacement: { kind: 'income', method: 'cash', amountKop: 12_000, source: 'other', occurredAt: new Date(t).toISOString(), comment: 'аренда стола' } });
    expect(fix.statusCode, fix.body).toBe(201);
    expect((await cashOf('cash')) - cash0).toBe(-3_000);
    expect(await one(`SELECT amount_kop::int AS amount, kind FROM journal.finance_operations WHERE id = $1`, [inc.json().id])).toEqual({ amount: 15_000, kind: 'income' });
    expect(await num(`SELECT count(*) AS n FROM journal.finance_operations WHERE reversal_of = $1`, [inc.json().id])).toBe(1);
    await invariants('п.10 исправление прихода');

    // приход по сеансу сторнировать нельзя – только возврат; возврат – новые записи, платёж и строки на месте
    const client = await newClient();
    const b = await book(client);
    await arrive(b.id);
    const p = (await pay(b.id, [{ method: 'cash', amountKop: PRICE }])).json();
    await drain();
    const op = await one<{ id: string }>(`SELECT id FROM journal.finance_operations WHERE source = 'session' AND ref_type = 'payment' AND ref_id = $1`, [p.paymentId]);
    const rev = await req('owner', 'POST', `/finance/operations/${op.id}/reverse`, { reason: 'ошибка' });
    expect([rev.statusCode, code(rev)]).toEqual([409, 'USE_PAYMENT_REFUND']);
    const ref = await req('director', 'POST', `/payments/${p.paymentId}/refund`, { rowVersion: p.session.rowVersion, lines: [{ lineNo: 1, amountKop: 10_000 }], reason: 'ушёл раньше' });
    expect(ref.statusCode, ref.body).toBe(201);
    expect(await one(`SELECT p.status, (SELECT count(*)::int FROM app.payment_lines l WHERE l.payment_id = p.id) AS lines FROM app.payments p WHERE p.id = $1`, [p.paymentId])).toEqual({ status: 'partially_refunded', lines: 1 });
    expect(await one(`SELECT kind, direction, amount_kop::int AS amount FROM journal.finance_operations WHERE kind = 'refund' AND ref_id = $1`, [op.id])).toEqual({ kind: 'refund', direction: 'out', amount: 10_000 });
    expect(await num(`SELECT count(*) AS n FROM journal.finance_operations WHERE id = $1`, [op.id])).toBe(1);
    const view = await payment(b.id, 'director');
    expect(view.payment).toMatchObject({ id: p.paymentId, status: 'partially_refunded' });
    expect(view.refunds).toHaveLength(1);
    await drain();
    await invariants('п.10 возврат');
  });

  it('п.4 истёкший сертификат нельзя применить: сгорание отдельной записью, касса не меняется (последним – часы на 7 месяцев вперёд)', async () => {
    const client = await newClient();
    const cert = await sell(30_000);
    const cash0 = await cashOf('cash');
    const expiresAt = (await one<{ expires_at: Date }>(`SELECT expires_at FROM app.certificates WHERE id = $1`, [cert.id])).expires_at;
    await setTime(expiresAt.getTime() + 86_400_000);
    expect(await expireDueCertificates(pool, clock, 200, () => undefined)).toBeGreaterThanOrEqual(1);
    expect(await certBalance(cert.id)).toBe(0);
    expect(await cashOf('cash')).toBe(cash0);
    // остаток п.3 тоже сгорел, его погашения – на месте
    expect(await certBalance(ids.cert!)).toBe(0);
    await invariants('п.4 сгорание');

    const day = Date.parse(new Date(t).toISOString().slice(0, 10) + 'T00:00:00Z') + 86_400_000;
    const b = await book(client, { start: day + 4 * 3_600_000, end: day + 5 * 3_600_000 });
    await arrive(b.id);
    const r = await pay(b.id, [certLine(cert)]);
    expect([r.statusCode, code(r)]).toEqual([409, 'CERTIFICATE_EXPIRED']);
    const check = await req('admin', 'POST', '/certificates/check', { branchId: ids.b1, number: cert.number, pin: cert.pin });
    expect(check.json().status).toBe('expired');
    expect([await livePayments(b.id), await certBalance(cert.id), await cashOf('cash')]).toEqual([0, 0, cash0]);
    await invariants('п.4 отказ');
  });
});

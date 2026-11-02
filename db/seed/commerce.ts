// S2-81. Тестовые данные Э2 поверх засевов Э0 и Э1 (db/seed/dev.ts, db/seed/resources.ts). В каждом активном
// демо-филиале (код demo-*): начальные остатки кассы (наличные и безнал), расход по демо-категории, два проданных
// сертификата (наличные, карта), брони демо-клиентов – оплаченные (наличные, карта), пришедшая неоплаченная и будущая
// неоплаченная; по сети – демо-категории расхода и дохода, баллы демо-клиентов (ручные партии).
// Всё создаётся командами модулей (finance, certificates, loyalty, booking) – с проверками, проводками K3 и аудитом.
// Сеансы с приходом создаются командами на часах того момента: удержание и подтверждение за 3 часа до начала, приход
// в начале, оплата через 10 минут. День – вчера по зоне филиала; на свежем стенде (Э0–Э2 одним запуском: вчера у
// филиала не было графика и ПК) – завтра, то есть приход и оплата датированы началом завтрашнего сеанса (демо).
// Повтор без дублей: категории – по имени, остатки – по действующему остатку места, операции и сертификаты – по
// демо-метке в комментарии, баллы – по ручной партии клиента, брони – по наличию брони демо-клиента в филиале.
// Демо-метка – DEMO_MARK (+ « #n») в комментариях и причинах, «(демо)» в названиях категорий.
// На прод не попадает: assertNotProduction до первого запроса к базе (19 §10.1). Коды сертификатов возвращаются
// только в отчёте этого запуска (в базе – HMAC); CLI печатает их только на dev/stage.
//
// CLI – через db/seed/dev.ts (после Э0 и Э1); отдельно: APP_ENV=stage DATABASE_URL=... CERT_PEPPER=... node db/seed/commerce.ts
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import { addDays, fixedClock, localToInstant, systemClock, todayIn, type Clock, type LocalDate, type LocalTime, type TimeZone } from '../../apps/api/src/core/time.ts';
import { confirmHold } from '../../apps/api/src/modules/booking/confirm.ts';
import { createHold } from '../../apps/api/src/modules/booking/hold.ts';
import { runOccupancyCommand } from '../../apps/api/src/modules/booking/occupancy.ts';
import { bookingLookup, paymentBookingProvider } from '../../apps/api/src/modules/booking/providers.ts';
import { markArrived } from '../../apps/api/src/modules/booking/visit.ts';
import { sellCertificate } from '../../apps/api/src/modules/certificates/sale.ts';
import { recordExpense, recordOpeningBalance } from '../../apps/api/src/modules/finance/cashbox.ts';
import { createCategory } from '../../apps/api/src/modules/finance/categories.ts';
import { recordPayment, type PaymentDeps } from '../../apps/api/src/modules/finance/payment.ts';
import { adjust } from '../../apps/api/src/modules/loyalty/adjust.ts';
import { listBookableResources } from '../../apps/api/src/modules/resources/index.ts';
import { withTx, type Pool } from '../../apps/api/src/modules/staff/auth.ts';
import { assertNotProduction, DEMO_MARK } from './dev.ts';
import { DEMO_CLIENTS } from './resources.ts';

const LOCK_KEY = 7_204_513_038;
const mark = (n: string): string => `${DEMO_MARK} #${n}`;

/** Демо-категории (06 §7): расход с подкатегорией и доход. */
const CATEGORIES = [
  { key: 'expense', kind: 'expense', name: 'Демо-расходы (демо)', parent: null },
  { key: 'expenseSub', kind: 'expense', name: 'Кофе для гостей (демо)', parent: 'expense' },
  { key: 'income', kind: 'income', name: 'Демо-доходы (демо)', parent: null },
] as const;

const OPENING = { cash: 2_000_000, noncash: 500_000 } as const; // 20 000 ₽ в ящике, 5 000 ₽ на безнале
const EXPENSE_KOP = 50_000;
const CERTIFICATES = [
  { n: 'cert-1', nominalKop: 300_000, method: 'cash' },
  { n: 'cert-2', nominalKop: 500_000, method: 'card' },
] as const;

/** Баллы клиентов (сотые): ручная партия. */
const POINTS: ReadonlyArray<{ phone: string; centi: number }> = [
  { phone: DEMO_CLIENTS[0].phone, centi: 5_000 },
  { phone: DEMO_CLIENTS[1].phone, centi: 1_250 },
  { phone: DEMO_CLIENTS[4].phone, centi: 10_000 },
];

/** Брони на ПК: день от «сегодня» филиала, начало, оплата (null – не оплачено), приход. */
/** past – день сеансов с приходом: вчера; на свежем стенде (графика и ПК вчера не было) – завтра. */
const BOOKINGS = [
  { client: 0, pc: 0, day: 'past', at: '10:00', arrive: true, pay: 'cash' },
  { client: 1, pc: 1, day: 'past', at: '11:00', arrive: true, pay: 'card' },
  { client: 2, pc: 2, day: 'past', at: '10:30', arrive: true, pay: null },
  { client: 3, pc: 0, day: 'future', at: '12:00', arrive: false, pay: null },
] as const;
const FUTURE_IN_DAYS = 3; // исключения графика Э1 – через 7 и 14 дней

export interface CommerceSeedReport {
  created: { categories: number; openingBalances: number; operations: number; certificates: number; pointBatches: number; bookings: number; payments: number };
  /** Только созданные в этом запуске: номер и код (код в базе не хранится). */
  certificates: Array<{ branchCode: string; number: string; pin: string; nominalKop: number }>;
}

export async function seedCommerce(
  pool: Pool,
  opts: { env: { APP_ENV?: string | undefined; NODE_ENV?: string | undefined }; certPepper: string },
  clock: Clock = systemClock,
): Promise<CommerceSeedReport> {
  assertNotProduction(opts.env);
  if (opts.certPepper.length < 32) throw new Error('Нужен CERT_PEPPER не короче 32 символов (продажа демо-сертификатов)');
  const lockConn = await pool.connect();
  try {
    await lockConn.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]); // два параллельных засева не создадут дублей
    return await run(pool, opts.certPepper, clock);
  } finally {
    await lockConn.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    lockConn.release();
  }
}

async function run(pool: Pool, pepper: string, clock: Clock): Promise<CommerceSeedReport> {
  const report: CommerceSeedReport = { created: { categories: 0, openingBalances: 0, operations: 0, certificates: 0, pointBatches: 0, bookings: 0, payments: 0 }, certificates: [] };
  const branches = (
    await pool.query<{ id: string; code: string; timezone: TimeZone }>(`SELECT id, code, timezone FROM app.branches WHERE code LIKE 'demo-%' AND status = 'active' ORDER BY code`)
  ).rows;
  const owner = (await pool.query<{ id: string }>(`SELECT id FROM app.staff WHERE role = 'owner' AND status = 'active'`)).rows[0];
  if (branches.length === 0 || !owner) throw new Error('Нет демо-филиалов или Владельца: сначала засев Э0 и Э1 (db/seed/dev.ts)');
  const clients = new Map(
    (await pool.query<{ id: string; phone_e164: string }>(`SELECT id, phone_e164 FROM app.clients WHERE phone_e164 = ANY($1::text[])`, [DEMO_CLIENTS.map((c) => c.phone)])).rows.map((r) => [
      r.phone_e164,
      r.id,
    ]),
  );
  if (clients.size !== DEMO_CLIENTS.length) throw new Error('Нет демо-клиентов: сначала засев Э1 (db/seed/resources.ts)');

  const ctxAt = (at: Date): AccessContext => ({
    actor: { kind: 'staff', staffId: owner.id, sessionId: randomUUID() },
    role: 'owner',
    network: true,
    cityIds: new Set(),
    branchIds: new Set(),
    at,
  });
  const metaAt = (at: Date): AuditRequestMeta => ({ actor: { kind: 'system', process: 'seed-commerce' }, source: 'cli', requestId: `seed-commerce:${at.toISOString()}` });
  const now = clock.now();
  const ctx = ctxAt(now);
  const meta = metaAt(now);

  // 1) категории сети
  const catIds: Record<string, string> = {};
  await withTx(pool, async (tx) => {
    for (const c of CATEGORIES) {
      const parentId = c.parent ? catIds[c.parent]! : null;
      const found = await tx.query<{ id: string }>(
        `SELECT id FROM app.finance_categories WHERE kind = $1 AND name = $2 AND parent_id IS NOT DISTINCT FROM $3::uuid`,
        [c.kind, c.name, parentId],
      );
      if (found.rows[0]) {
        catIds[c.key] = found.rows[0].id;
        continue;
      }
      catIds[c.key] = (await createCategory(tx, ctx, { kind: c.kind, name: c.name, parentId }, meta, clock)).id;
      report.created.categories++;
    }
  });

  // 2) касса и сертификаты по филиалам
  for (const b of branches) {
    const today = todayIn(clock, b.timezone);
    await withTx(pool, async (tx) => {
      for (const place of ['cash', 'noncash'] as const) {
        const has = await tx.query(`SELECT 1 FROM app.finance_opening_balances WHERE branch_id = $1 AND place = $2 AND status = 'active'`, [b.id, place]);
        if (has.rowCount) continue;
        const date = addDays(today, -7);
        await recordOpeningBalance(tx, ctx, { branchId: b.id, place, amountKop: OPENING[place], date, comment: mark(`opening-${place}`) }, meta, { idempotencyKey: randomUUID(), clock });
        report.created.openingBalances++;
      }
      if (!(await hasOperation(tx, b.id, mark('expense')))) {
        const input = { branchId: b.id, method: 'cash', amountKop: EXPENSE_KOP, categoryId: catIds.expense, subcategoryId: catIds.expenseSub, occurredAt: now.toISOString(), comment: mark('expense') };
        await recordExpense(tx, ctx, input, meta, { idempotencyKey: randomUUID(), clock });
        report.created.operations++;
      }
    });
    for (const c of CERTIFICATES) {
      await withTx(pool, async (tx) => {
        const has = await tx.query(`SELECT 1 FROM app.certificates WHERE sale_branch_id = $1 AND comment = $2`, [b.id, mark(c.n)]);
        if (has.rowCount) return;
        const sold = await sellCertificate(tx, ctx, { branchId: b.id, nominalKop: c.nominalKop, method: c.method, comment: mark(c.n) }, meta, { pepper, clock });
        report.certificates.push({ branchCode: b.code, number: sold.certificate.number, pin: sold.pin, nominalKop: c.nominalKop });
        report.created.certificates++;
      });
    }
  }

  // 3) баллы демо-клиентов – ручная партия (K15 §9), ключ намерения на клиента
  for (const p of POINTS) {
    const clientId = clients.get(p.phone)!;
    await withTx(pool, async (tx) => {
      const has = await tx.query(`SELECT 1 FROM app.loyalty_batches WHERE client_id = $1 AND source = 'manual'`, [clientId]);
      if (has.rowCount) return;
      await adjust(tx, ctx, { clientId, deltaCenti: p.centi, reason: mark('points'), idempotencyKey: `seed-commerce:points:${clientId}` }, meta, clock);
      report.created.pointBatches++;
    });
  }

  // 4) брони демо-клиентов: оплаченные, пришедшая неоплаченная, будущая неоплаченная
  const bookings: PaymentDeps['bookings'] = { facts: (tx, id) => bookingLookup.facts(tx, id), payableBooking: (tx, id) => paymentBookingProvider.payableBooking(tx, id) };
  for (const b of branches) {
    const pcs = (await listBookableResources(pool, b.id)).filter((r) => r.type === 'pc');
    if (pcs.length < 3) throw new Error(`В филиале ${b.code} меньше трёх ПК: сначала засев Э1`);
    const today = todayIn(clock, b.timezone);
    // вчера – если тогда уже были график филиала и состав ПК; на свежем стенде (Э0–Э2 одним запуском) – завтра
    const yesterday = addDays(today, -1);
    const since = (
      await pool.query<{ hours: string | null; units: Date | null }>(
        `SELECT (SELECT min(valid_from)::text FROM app.branch_weekly_hours WHERE branch_id = $1) AS hours,
                (SELECT max(f) FROM (SELECT min(valid_from) AS f FROM app.resource_units WHERE resource_id = ANY($2::uuid[]) GROUP BY resource_id) x) AS units`,
        [b.id, pcs.slice(0, 3).map((r) => r.id)],
      )
    ).rows[0]!;
    const earliest = localToInstant(yesterday, '00:00' as LocalTime, b.timezone);
    const pastDay = since.hours && since.hours <= yesterday && since.units && since.units <= earliest ? yesterday : addDays(today, 1);
    for (const s of BOOKINGS) {
      const clientId = clients.get(DEMO_CLIENTS[s.client].phone)!;
      const has = await pool.query(`SELECT 1 FROM app.bookings WHERE client_id = $1 AND branch_id = $2`, [clientId, b.id]);
      if (has.rowCount) continue;
      const day: LocalDate = s.day === 'past' ? pastDay : addDays(today, FUTURE_IN_DAYS);
      const start = localToInstant(day, s.at as LocalTime, b.timezone);
      const end = new Date(start.getTime() + 3_600_000);
      // прошлый сеанс – команды на часах «за 3 часа до начала»; будущий – сейчас
      const bookAt = s.day === 'past' && pastDay === yesterday ? fixedClock(new Date(start.getTime() - 3 * 3_600_000)) : clock;
      const done = await runOccupancyCommand(pool, async (tx) => {
        const hold = await createHold(tx, { clientId, visitorId: null }, { branchId: b.id, items: [{ resourceId: pcs[s.pc]!.id, start, end }] }, bookAt);
        return confirmHold(tx, clientId, hold.id, bookAt);
      });
      const booking = done.bookings[0]!;
      report.created.bookings++;
      if (!s.arrive) continue;
      const arriveClock = fixedClock(start);
      await withTx(pool, async (tx) => {
        const rv = (await tx.query<{ row_version: number }>(`SELECT row_version FROM app.bookings WHERE id = $1`, [booking.id])).rows[0]!.row_version;
        await markArrived(tx, booking.id, { ctx: ctxAt(start), rowVersion: rv }, metaAt(start), arriveClock);
      });
      if (!s.pay) continue;
      const payAt = new Date(start.getTime() + 10 * 60_000);
      await withTx(pool, (tx) =>
        recordPayment(tx, ctxAt(payAt), { bookingId: booking.id, lines: [{ method: s.pay, amountKop: booking.priceKop }], comment: mark('payment') }, metaAt(payAt), { bookings, clock: fixedClock(payAt) }),
      );
      report.created.payments++;
    }
  }
  return report;
}

async function hasOperation(tx: { query: pg.ClientBase['query'] }, branchId: string, comment: string): Promise<boolean> {
  return Boolean((await tx.query(`SELECT 1 FROM journal.finance_operations WHERE branch_id = $1 AND comment = $2`, [branchId, comment])).rowCount);
}

/** Коды демо-сертификатов – в лог только на dev/stage (на test и где-либо ещё – только номера). */
export function certificateLines(report: CommerceSeedReport, env: { APP_ENV?: string | undefined; NODE_ENV?: string | undefined }): string[] {
  const v = (env.APP_ENV ?? env.NODE_ENV ?? '').toLowerCase();
  const showPin = ['development', 'dev', 'stage', 'staging'].includes(v);
  return report.certificates.map((c) => `  ${c.branchCode}: ${c.number}${showPin ? ` код ${c.pin}` : ''} – ${c.nominalKop / 100} ₽`);
}

async function cli(): Promise<void> {
  assertNotProduction(process.env);
  const url = process.env.DATABASE_URL;
  const pepper = process.env.CERT_PEPPER;
  if (!url) throw new Error('Нужен DATABASE_URL (рантайм-учётка yu_app)');
  if (!pepper) throw new Error('Нужен CERT_PEPPER (как у API) – продажа демо-сертификатов');
  const pool = new pg.Pool({ connectionString: url, options: '-c search_path=app,journal', max: 2 });
  try {
    const r = await seedCommerce(pool, { env: process.env, certPepper: pepper });
    console.log(`Засев Э2: создано ${JSON.stringify(r.created)}`);
    for (const line of certificateLines(r, process.env)) console.log(line);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

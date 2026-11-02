// S2-80. Ночная сверка 16 §14 (модуль reports, ADR 0002 п.1: чужие данные – только чтение через представления rpt_*
// модулей-владельцев, миграция 0211). Пять проверок одним снимком базы (REPEATABLE READ, READ ONLY):
//   ledger_balance      – verifyBalance всех счетов K3: кэш balance = сумма записей счёта;
//   loyalty_points      – Σ remaining активных партий клиента = max(0, баланс баллов) (K15 §2);
//   loyalty_batch       – кэш remaining партии = amount + Σ движений партии (K15 §2);
//   certificate_balance – остаток сертификата = номинал − погашения − сгорание ± корректировки (K16 §1; отменённый – 0);
//   cash_place          – остаток места денег филиала (наличные, безнал) = Σ операций кассы по этому месту (K17 §2).
// Результат – строка app.reconcile_runs и по строке journal.reconcile_discrepancies на расхождение; каждое расхождение –
// в лог уровнем error (17 §13). Сверка ничего не исправляет: исправление – корректировкой модуля-владельца.
//
// Запуск: worker раз в сутки (startNightlyReconcile, по умолчанию 03:30 по зоне RECONCILE_TIMEZONE, Europe/Moscow;
// плановый запуск – один на сутки, индекс reconcile_runs_one_per_day) и вручную командой:
//   DATABASE_URL=... node apps/api/src/modules/reports/reconcile.ts      (код выхода 0 – чисто, 2 – есть расхождения)
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { instantToLocal, isValidTimeZone, parseLocalTime, systemClock, type Clock, type LocalDate, type LocalTime, type TimeZone } from '../../core/time.ts';

export const CHECKS = ['ledger_balance', 'loyalty_points', 'loyalty_batch', 'certificate_balance', 'cash_place'] as const;
export type ReconcileCheck = (typeof CHECKS)[number];

export const DEFAULT_RECONCILE_AT = '03:30' as LocalTime;
export const DEFAULT_RECONCILE_TZ = 'Europe/Moscow' as TimeZone;

export interface Discrepancy {
  check: ReconcileCheck;
  objectType: 'ledger_account' | 'client' | 'loyalty_batch' | 'certificate' | 'branch';
  objectId: string;
  branchId: string | null;
  /** Что должно быть по первичным данным. */
  expected: number;
  /** Что хранится (кэш, остаток счёта). */
  actual: number;
  details: Record<string, unknown>;
}

export interface ReconcileReport {
  runId: string;
  trigger: 'schedule' | 'manual';
  scheduledFor: LocalDate | null;
  status: 'ok' | 'discrepancies';
  checked: Record<ReconcileCheck, number>;
  discrepancies: Discrepancy[];
}

export interface ReconcileLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

type Queryable = Pick<pg.ClientBase, 'query'>;
interface Pool {
  connect(): Promise<pg.PoolClient>;
}

const num = (v: string | number | null): number => Number(v ?? 0);

/** Все расхождения на снимке db (вызывающий держит снимок транзакцией). Только чтение представлений rpt_*. */
export async function findDiscrepancies(db: Queryable): Promise<{ checked: Record<ReconcileCheck, number>; discrepancies: Discrepancy[] }> {
  const out: Discrepancy[] = [];
  const count = async (view: string): Promise<number> => num((await db.query<{ n: string }>(`SELECT count(*) AS n FROM app.${view}`)).rows[0]!.n);

  const ledger = await db.query<{ account_id: string; kind: string; branch_id: string | null; owner_type: string; owner_id: string; balance: string; entries_sum: string }>(
    `SELECT account_id, kind, branch_id, owner_type, owner_id, balance, entries_sum FROM app.rpt_ledger_balances WHERE balance <> entries_sum ORDER BY account_id`,
  );
  for (const r of ledger.rows) {
    out.push({
      check: 'ledger_balance', objectType: 'ledger_account', objectId: r.account_id, branchId: r.branch_id,
      expected: num(r.entries_sum), actual: num(r.balance), details: { kind: r.kind, ownerType: r.owner_type, ownerId: r.owner_id },
    });
  }

  const points = await db.query<{ client_id: string; account_id: string; balance: string; batches_remaining: string }>(
    `SELECT client_id, account_id, balance, batches_remaining FROM app.rpt_loyalty_points
     WHERE batches_remaining <> greatest(0, balance) ORDER BY client_id`,
  );
  for (const r of points.rows) {
    out.push({
      check: 'loyalty_points', objectType: 'client', objectId: r.client_id, branchId: null,
      expected: Math.max(0, num(r.balance)), actual: num(r.batches_remaining), details: { accountId: r.account_id, balance: num(r.balance) },
    });
  }

  const batches = await db.query<{ batch_id: string; client_id: string; branch_id: string | null; status: string; remaining_centi: string; moves_remaining: string }>(
    `SELECT batch_id, client_id, branch_id, status, remaining_centi, moves_remaining FROM app.rpt_loyalty_batches
     WHERE remaining_centi <> moves_remaining ORDER BY batch_id`,
  );
  for (const r of batches.rows) {
    out.push({
      check: 'loyalty_batch', objectType: 'loyalty_batch', objectId: r.batch_id, branchId: r.branch_id,
      expected: num(r.moves_remaining), actual: num(r.remaining_centi), details: { clientId: r.client_id, status: r.status },
    });
  }

  const certs = await db.query<{
    certificate_id: string; number: string; branch_id: string; nominal_kop: string; cancelled: boolean;
    redeemed_kop: string; expired_kop: string; corrections_kop: string; balance_kop: string; expected: string;
  }>(
    `SELECT *, (CASE WHEN cancelled THEN 0 ELSE nominal_kop END - redeemed_kop - expired_kop + corrections_kop) AS expected
     FROM app.rpt_certificate_balances
     WHERE balance_kop <> CASE WHEN cancelled THEN 0 ELSE nominal_kop END - redeemed_kop - expired_kop + corrections_kop
     ORDER BY certificate_id`,
  );
  for (const r of certs.rows) {
    out.push({
      check: 'certificate_balance', objectType: 'certificate', objectId: r.certificate_id, branchId: r.branch_id,
      expected: num(r.expected), actual: num(r.balance_kop),
      details: { number: r.number, nominalKop: num(r.nominal_kop), cancelled: r.cancelled, redeemedKop: num(r.redeemed_kop), expiredKop: num(r.expired_kop), correctionsKop: num(r.corrections_kop) },
    });
  }

  const cash = await db.query<{ branch_id: string; place: string; account_id: string | null; balance: string; operations_sum: string }>(
    `SELECT branch_id, place, account_id, balance, operations_sum FROM app.rpt_cash_places WHERE balance <> operations_sum ORDER BY branch_id, place`,
  );
  for (const r of cash.rows) {
    out.push({
      check: 'cash_place', objectType: 'branch', objectId: r.branch_id, branchId: r.branch_id,
      expected: num(r.operations_sum), actual: num(r.balance), details: { place: r.place, accountId: r.account_id },
    });
  }

  const checked: Record<ReconcileCheck, number> = {
    ledger_balance: await count('rpt_ledger_balances'),
    loyalty_points: await count('rpt_loyalty_points'),
    loyalty_batch: await count('rpt_loyalty_batches'),
    certificate_balance: await count('rpt_certificate_balances'),
    cash_place: await count('rpt_cash_places'),
  };
  return { checked, discrepancies: out };
}

async function inTx<T>(pool: Pool, begin: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query(begin);
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

/**
 * Один запуск сверки. Плановый (scheduledFor задан) – только если за эти сутки запуска ещё не было, иначе null.
 * Ошибка проверки – запуск со статусом failed и исключение наружу.
 */
export async function runReconcile(
  pool: Pool,
  opts: { trigger: 'schedule' | 'manual'; scheduledFor?: LocalDate; clock?: Clock; logger: ReconcileLogger },
): Promise<ReconcileReport | null> {
  const clock = opts.clock ?? systemClock;
  const scheduledFor = opts.trigger === 'schedule' ? (opts.scheduledFor ?? null) : null;
  if (opts.trigger === 'schedule' && !scheduledFor) throw new Error('reconcile: плановому запуску нужны сутки scheduledFor');
  const claimed = await inTx(pool, 'BEGIN', async (c) =>
    c.query<{ id: string }>(
      `INSERT INTO app.reconcile_runs (trigger, scheduled_for, started_at) VALUES ($1, $2, $3)
       ON CONFLICT (scheduled_for) WHERE trigger = 'schedule' DO NOTHING RETURNING id`,
      [opts.trigger, scheduledFor, clock.now()],
    ),
  );
  const runId = claimed.rows[0]?.id;
  if (!runId) return null; // сутки уже сверены (перезапуск worker, второй экземпляр)

  let found: Awaited<ReturnType<typeof findDiscrepancies>>;
  try {
    found = await inTx(pool, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', (c) => findDiscrepancies(c));
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    await inTx(pool, 'BEGIN', (c) => c.query(`UPDATE app.reconcile_runs SET status = 'failed', finished_at = $2, error = $3 WHERE id = $1`, [runId, clock.now(), text]));
    opts.logger.error({ runId, err: text }, 'reconcile: сверка упала');
    throw err;
  }

  const status = found.discrepancies.length === 0 ? 'ok' : 'discrepancies';
  await inTx(pool, 'BEGIN', async (c) => {
    for (const d of found.discrepancies) {
      await c.query(
        `INSERT INTO journal.reconcile_discrepancies (run_id, check_name, object_type, object_id, branch_id, expected, actual, details)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [runId, d.check, d.objectType, d.objectId, d.branchId, d.expected, d.actual, JSON.stringify(d.details)],
      );
    }
    await c.query(`UPDATE app.reconcile_runs SET status = $2, finished_at = $3, checked = $4, discrepancy_count = $5 WHERE id = $1`, [
      runId, status, clock.now(), JSON.stringify(found.checked), found.discrepancies.length,
    ]);
  });
  for (const d of found.discrepancies) {
    opts.logger.error({ runId, ...d, diff: d.actual - d.expected }, `reconcile: расхождение ${d.check}`);
  }
  opts.logger.info({ runId, trigger: opts.trigger, scheduledFor, status, checked: found.checked, discrepancies: found.discrepancies.length }, 'reconcile: сверка завершена');
  return { runId, trigger: opts.trigger, scheduledFor: scheduledFor as LocalDate | null, status, checked: found.checked, discrepancies: found.discrepancies };
}

/** Сутки, за которые пора плановой сверке: локальное время зоны дошло до at – сегодняшние сутки, иначе null. */
export function dueDate(now: Date, at: LocalTime, tz: TimeZone): LocalDate | null {
  const local = instantToLocal(now, tz);
  return local.time >= at ? local.date : null;
}

/**
 * Плановая сверка раз в сутки (worker.ts): проверка «пора ли» каждые intervalMs; пропущенное время (worker стоял)
 * догоняется в тот же день. Таймер unref – процесс держат соединения.
 */
export function startNightlyReconcile(opts: {
  pool: Pool;
  logger: ReconcileLogger;
  clock?: Clock;
  at?: LocalTime;
  timeZone?: TimeZone;
  intervalMs?: number;
}): { stop(): void; tick(): Promise<ReconcileReport | null> } {
  const clock = opts.clock ?? systemClock;
  const at = opts.at ?? DEFAULT_RECONCILE_AT;
  const tz = opts.timeZone ?? DEFAULT_RECONCILE_TZ;
  let done: LocalDate | null = null;
  let busy: Promise<ReconcileReport | null> | null = null;
  const tick = (): Promise<ReconcileReport | null> => {
    if (busy) return busy;
    const day = dueDate(clock.now(), at, tz);
    if (!day || day === done) return Promise.resolve(null);
    busy = runReconcile(opts.pool, { trigger: 'schedule', scheduledFor: day, clock, logger: opts.logger })
      .then((r) => {
        done = day; // и при r === null: сутки уже сверил кто-то другой
        return r;
      })
      .catch((err: unknown) => {
        done = day; // упавшую сверку не повторяем каждую минуту: строка failed, следующий запуск – завтра или вручную
        opts.logger.error({ err: err instanceof Error ? err.message : String(err), scheduledFor: day }, 'reconcile: плановый проход упал');
        return null;
      })
      .finally(() => {
        busy = null;
      });
    return busy;
  };
  const t = setInterval(() => void tick(), opts.intervalMs ?? 60_000);
  t.unref();
  return { stop: () => clearInterval(t), tick };
}

/** Время и зона расписания из окружения (RECONCILE_AT 'HH:mm', RECONCILE_TIMEZONE IANA); неверное значение – ошибка старта. */
export function scheduleFromEnv(env: NodeJS.ProcessEnv = process.env): { at: LocalTime; timeZone: TimeZone } {
  const at = env.RECONCILE_AT ? parseLocalTime(env.RECONCILE_AT) : DEFAULT_RECONCILE_AT;
  const tz = env.RECONCILE_TIMEZONE ?? DEFAULT_RECONCILE_TZ;
  if (!isValidTimeZone(tz)) throw new Error(`RECONCILE_TIMEZONE: неизвестная зона ${tz}`);
  return { at, timeZone: tz };
}

const jsonLogger: ReconcileLogger = {
  info: (obj, msg) => console.info(JSON.stringify({ level: 'info', time: new Date().toISOString(), proc: 'reconcile', msg, ...obj })),
  error: (obj, msg) => console.error(JSON.stringify({ level: 'error', time: new Date().toISOString(), proc: 'reconcile', msg, ...obj })),
};

async function cli(): Promise<number> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('reconcile: нужен DATABASE_URL (рантайм-учётка yu_app)');
  const pool = new pg.Pool({ connectionString: url, options: '-c search_path=app,journal', max: 2 });
  try {
    const r = await runReconcile(pool, { trigger: 'manual', logger: jsonLogger });
    return r?.status === 'ok' ? 0 : 2;
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli().then(
    (code) => process.exit(code),
    (err: unknown) => {
      jsonLogger.error({ err: err instanceof Error ? err.message : String(err) }, 'reconcile: ручной запуск не выполнен');
      process.exit(1);
    },
  );
}

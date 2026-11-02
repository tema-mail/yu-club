// Фоновый процесс (ADR 0002: процесс worker – тот же образ API, другая команда).
// Запускает: подписки уведомлений на события брони (K14, до startOutboxWorker – подписки замораживаются),
// подписки баллов (K15: штраф за неявку, резерв; начисление и paid_other – когда передан PaymentLookup finance),
// доставку outbox через pg-boss (K4, core/outbox-worker.ts), истечение партий баллов раз в 10 мин, истечение удержаний раз в 15 с
// (modules/booking/hold.ts), сгорание сертификатов раз в 5 мин (modules/certificates/lifecycle.ts) и диспетчер
// запланированных уведомлений Web Push раз в 30 с (modules/notifications/sender.ts).
// SIGTERM/SIGINT: перестаём брать новое, ждём текущие задачи pg-boss, закрываем пулы, код выхода 0.
//
// Окружение: DATABASE_URL – рантайм yu_app (данные модулей); PGBOSS_DATABASE_URL – роль yu_boss, владелец
// только схемы pgboss (pg-boss создаёт в ней таблицы и разделы очередей, DDL рантайм-роли не даём; ADR 0001);
// VAPID_* – как у API (без них уведомления получают «нет канала»).
//   node apps/api/src/worker.ts
import { pathToFileURL } from 'node:url';
import { PgBoss } from 'pg-boss';
import pg from 'pg';
import { loadConfig } from './config.ts';
import { startOutboxWorker, type OutboxWorker, type WorkerLogger } from './core/outbox-worker.ts';
import { systemClock, type Clock } from './core/time.ts';
import { startHoldExpiry } from './modules/booking/hold.ts';
import { startCertificateExpiry } from './modules/certificates/lifecycle.ts';
import { bookingLookup, paymentBookingProvider } from './modules/booking/providers.ts';
import { registerAccrualHandlers, type PaymentLookup } from './modules/loyalty/accrual.ts';
import { startLoyaltyExpiry } from './modules/loyalty/adjust.ts';
import { registerPenaltyHandlers } from './modules/loyalty/penalty.ts';
import { registerReserveHandlers } from './modules/loyalty/reserve.ts';
import { registerNotificationHandlers } from './modules/notifications/handlers.ts';
import { startDispatcher } from './modules/notifications/sender.ts';
import { vapidKeys, type VapidKeys } from './modules/notifications/webpush.ts';

const log = (level: 'info' | 'error', msg: string, extra: Record<string, unknown> = {}): void => {
  const line = JSON.stringify({ level, time: new Date().toISOString(), proc: 'worker', msg, ...extra });
  if (level === 'error') console.error(line);
  else console.info(line);
};
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export interface WorkerTasks {
  outbox: OutboxWorker;
  /** Остановить таймеры и outbox (pg-boss и пулы закрывает вызывающий). */
  stop(): Promise<void>;
}

/** Все фоновые задачи процесса worker на готовых pool (yu_app) и boss (уже start()). Тесты зовут её напрямую. */
export async function startWorkerTasks(opts: {
  pool: pg.Pool;
  boss: PgBoss;
  vapid: VapidKeys | null;
  clock?: Clock;
  outboxIntervalMs?: number;
  pollingIntervalSeconds?: number;
  holdIntervalMs?: number;
  loyaltyExpiryIntervalMs?: number;
  dispatcherIntervalMs?: number;
  certificateIntervalMs?: number;
  logger?: WorkerLogger;
  /** Чтение оплаты для начисления баллов (K15 §4) – реализация finance (K10, S2-20). Нет – начисление не подключается. */
  payments?: PaymentLookup;
}): Promise<WorkerTasks> {
  const clock = opts.clock ?? systemClock;
  const logger = opts.logger ?? { error: (obj: Record<string, unknown>, msg: string) => log('error', msg, obj) };
  // подписки – до startOutboxWorker: он замораживает их и создаёт очереди по снимку
  registerNotificationHandlers({ bookings: bookingLookup, clock });
  registerPenaltyHandlers({ bookings: paymentBookingProvider, clock });
  registerReserveHandlers({ bookings: paymentBookingProvider, clock, ...(opts.payments ? { payments: opts.payments } : {}) });
  if (opts.payments) registerAccrualHandlers({ bookings: paymentBookingProvider, payments: opts.payments, clock });
  const outbox = await startOutboxWorker({
    pool: opts.pool,
    boss: opts.boss,
    clock,
    logger,
    ...(opts.outboxIntervalMs ? { intervalMs: opts.outboxIntervalMs } : {}),
    ...(opts.pollingIntervalSeconds ? { pollingIntervalSeconds: opts.pollingIntervalSeconds } : {}),
  });
  const holds = startHoldExpiry({
    pool: opts.pool,
    clock,
    intervalMs: opts.holdIntervalMs ?? 15_000,
    onError: (err) => logger.error({ err: errText(err) }, 'hold-expiry: проход упал'),
  });
  // сгорание сертификатов раз в 5 минут (K16 §4): касса не меняется
  const certificates = startCertificateExpiry({
    pool: opts.pool,
    clock,
    intervalMs: opts.certificateIntervalMs ?? 5 * 60_000,
    onError: (err) => logger.error({ err: errText(err) }, 'certificates:expire: проход упал'),
  });
  // K15 §2: истечение партий баллов (при loyalty.batch_ttl_days = null проход ничего не делает)
  const loyaltyExpiry = startLoyaltyExpiry({
    pool: opts.pool,
    clock,
    intervalMs: opts.loyaltyExpiryIntervalMs ?? 600_000,
    onError: (err) => logger.error({ err: errText(err) }, 'loyalty-expiry: проход упал'),
  });
  // проверки 1–4 перед отправкой – по таблице броней (как в API, server.ts)
  const stopDispatcher = startDispatcher(
    { pool: opts.pool, vapid: opts.vapid, clock, bookings: bookingLookup },
    { intervalMs: opts.dispatcherIntervalMs ?? 30_000, log: (err) => logger.error({ err: errText(err) }, 'notifications: диспетчер') },
  );
  return {
    outbox,
    stop: async () => {
      holds.stop();
      certificates.stop();
      loyaltyExpiry.stop();
      stopDispatcher();
      await outbox.stop();
    },
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const bossUrl = process.env.PGBOSS_DATABASE_URL;
  if (!config.DATABASE_URL) throw new Error('worker: нужен DATABASE_URL (рантайм-учётка yu_app)');
  if (!bossUrl) throw new Error('worker: нужен PGBOSS_DATABASE_URL (роль yu_boss, схема pgboss)');

  const pool = new pg.Pool({ connectionString: config.DATABASE_URL, options: '-c search_path=app,journal', max: 5 });
  pool.on('error', (err) => log('error', 'пул yu_app: ошибка простаивающего соединения', { err: errText(err) }));
  // createSchema: false – схему pgboss с владельцем yu_boss создаёт выкладка; права CREATE на базу у yu_boss нет.
  const boss = new PgBoss({ connectionString: bossUrl, schema: 'pgboss', max: 3, createSchema: false });
  boss.on('error', (err) => log('error', 'pg-boss', { err: errText(err) }));
  await boss.start();

  const vapid =
    config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY && config.VAPID_SUBJECT
      ? vapidKeys(config.VAPID_PUBLIC_KEY, config.VAPID_PRIVATE_KEY, config.VAPID_SUBJECT)
      : null;
  const tasks = await startWorkerTasks({ pool, boss, vapid });
  log('info', 'запущен: уведомления по событиям брони, outbox (pg-boss), истечение удержаний 15 с, партий баллов 10 мин, сгорание сертификатов 5 мин, отправка 30 с', {
    version: config.GIT_SHA,
    webPush: Boolean(vapid),
  });

  // Процесс держат соединения pg-boss и LISTEN outbox; таймеры удержаний и уведомлений – unref.
  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log('info', `остановка по ${signal}`);
    const force = setTimeout(() => {
      log('error', 'остановка не уложилась в 25 с – выход');
      process.exit(1);
    }, 25_000);
    force.unref();
    try {
      await tasks.stop();
      await boss.stop({ graceful: true, timeout: 20_000 });
      await pool.end();
      log('info', 'остановлен');
      process.exit(0);
    } catch (err) {
      log('error', 'ошибка при остановке', { err: errText(err) });
      process.exit(1);
    }
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void shutdown(signal));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    log('error', 'worker не запустился', { err: errText(err) });
    process.exit(1);
  });
}

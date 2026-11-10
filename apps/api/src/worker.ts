// Фоновый процесс (ADR 0002: процесс worker – тот же образ API, другая команда).
// Запускает: подписки уведомлений на события брони (K14, до startOutboxWorker – подписки замораживаются),
// подписки баллов (K15: штраф за неявку, резерв, начисление и paid_other по PaymentLookup finance), начисление зарплаты (K18 §6),
// доставку outbox через pg-boss (K4, core/outbox-worker.ts), истечение партий баллов раз в 10 мин, истечение удержаний раз в 15 с
// (modules/booking/hold.ts), сгорание сертификатов раз в 5 мин (modules/certificates/lifecycle.ts) и диспетчер
// запланированных уведомлений Web Push раз в 30 с (modules/notifications/sender.ts) и ночную сверку 16 §14 раз в сутки
// (modules/reports/reconcile.ts, 03:30 по RECONCILE_TIMEZONE; ручной запуск – командой из того же файла),
// проверку смен без отметки раз в 15 мин (modules/shifts/attendance.ts, K18 §5),
// файлы экспорта отчётов и их уборку (modules/reports/export.ts, K24 §7) – если задан REPORTS_DATABASE_URL.
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
import { createFileStore, type FileStore } from './core/files.ts';
import { startHeartbeat, workerDetails } from './core/heartbeat.ts';
import { startOutboxWorker, type OutboxWorker, type WorkerLogger } from './core/outbox-worker.ts';
import { systemClock, type Clock, type LocalTime, type TimeZone } from './core/time.ts';
import { startHoldExpiry } from './modules/booking/hold.ts';
import { startCertificateExpiry } from './modules/certificates/lifecycle.ts';
import { registerContentHandlers } from './modules/content/handlers.ts';
import { startMediaGc } from './modules/content/media.ts';
import { bookingLookup, paymentBookingProvider } from './modules/booking/providers.ts';
import { paymentLookup } from './modules/finance/payment.ts';
import { registerAccrualHandlers, type PaymentLookup } from './modules/loyalty/accrual.ts';
import { startLoyaltyExpiry } from './modules/loyalty/adjust.ts';
import { registerPenaltyHandlers } from './modules/loyalty/penalty.ts';
import { registerReserveHandlers } from './modules/loyalty/reserve.ts';
import { startCampaignRunner } from './modules/notifications/campaign-runner.ts';
import { registerGiftHandlers } from './modules/events/gift-booking.ts';
import { startGiftExpiry } from './modules/events/gifts.ts';
import { startRequestHoldExpiry } from './modules/events/resources.ts';
import { registerNotificationHandlers } from './modules/notifications/handlers.ts';
import { startDispatcher } from './modules/notifications/sender.ts';
import { startStaffFeedTimers } from './modules/notifications/staff-feed-events.ts';
import { registerStaffFeedHandlers } from './modules/notifications/staff-feed.ts';
import { branchIdsOfCities, timezonesOf } from './modules/network/index.ts';
import { startExportGc, startExportRunner } from './modules/reports/export.ts';
import { createReportsPool, type ReportsPool } from './modules/reports/framework.ts';
import { scheduleFromEnv, startNightlyReconcile, type ReconcileLogger } from './modules/reports/reconcile.ts';
import { registerPayrollHandlers } from './modules/shifts/accrual.ts';
import { startShiftReview } from './modules/shifts/attendance.ts';
import { vapidKeys, type VapidKeys } from './modules/notifications/webpush.ts';

const log = (level: 'info' | 'error', msg: string, extra: Record<string, unknown> = {}): void => {
  const line = JSON.stringify({ level, time: new Date().toISOString(), proc: 'worker', msg, ...extra });
  if (level === 'error') console.error(line);
  else console.info(line);
};
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export interface WorkerTasks {
  outbox: OutboxWorker;
  /** Ночная сверка: tick() – проверить «пора ли» и выполнить (тесты). */
  reconcile: { tick(): Promise<unknown> };
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
  shiftReviewIntervalMs?: number;
  /** Таймерные события ленты CRM (13 §11): пустая смена, подготовка мероприятия, окончание гарантии; по умолчанию раз в час. */
  staffFeedIntervalMs?: number;
  campaignIntervalMs?: number;
  /** UNSUBSCRIBE_SECRET: без него рекламные строки не уходят (K21 §7). */
  unsubscribeSecret?: string | null;
  requestHoldIntervalMs?: number;
  giftExpiryIntervalMs?: number;
  logger?: WorkerLogger;
  /** Ночная сверка (S2-80): время и зона расписания, частота проверки «пора ли»; по умолчанию 03:30 Europe/Moscow, раз в минуту. */
  reconcile?: { at?: LocalTime; timeZone?: TimeZone; intervalMs?: number; logger?: ReconcileLogger };
  /** Чтение оплаты для начисления баллов и снятия резерва paid_other (K15 §3–4); по умолчанию – finance paymentLookup (K10, S2-20). */
  payments?: PaymentLookup;
  /** Медиатека CMS: ночная уборка «сирот» content:media-gc (K22 §8). Нет – задача не запускается. */
  mediaStore?: FileStore;
  /** Экспорт отчётов: пул yu_reports и каталог EXPORT_DIR (K24 §7, §9). Нет – задачи стоят в очереди, файлы не считаются. */
  exports?: { reports: ReportsPool; store: FileStore; intervalMs?: number };
}): Promise<WorkerTasks> {
  const clock = opts.clock ?? systemClock;
  const logger = opts.logger ?? { error: (obj: Record<string, unknown>, msg: string) => log('error', msg, obj) };
  // подписки – до startOutboxWorker: он замораживает их и создаёт очереди по снимку
  registerNotificationHandlers({ bookings: bookingLookup, clock });
  registerStaffFeedHandlers({ clock }); // 13 §11: лента событий CRM – смены (K18 §11), ремонт (K19 §11), брони (K11), блокировки (K6), без push сотрудникам
  registerPenaltyHandlers({ bookings: paymentBookingProvider, clock });
  const payments = opts.payments ?? paymentLookup;
  registerReserveHandlers({ bookings: paymentBookingProvider, clock, payments });
  registerAccrualHandlers({ bookings: paymentBookingProvider, payments, clock });
  registerContentHandlers({ clock }); // история адресов K23 §5: смена слага города, филиала, комнаты
  registerGiftHandlers({ clock }); // K20 §8.2: жизненный цикл записи по подарку
  registerPayrollHandlers({ clock }); // K18 §6: начисление зарплаты по факту смены и новой ставке
  const outbox = await startOutboxWorker({
    pool: opts.pool,
    boss: opts.boss,
    clock,
    logger,
    ...(opts.outboxIntervalMs ? { intervalMs: opts.outboxIntervalMs } : {}),
    ...(opts.pollingIntervalSeconds ? { pollingIntervalSeconds: opts.pollingIntervalSeconds } : {}),
  });
  const heartbeat = startHeartbeat({ pool: opts.pool, clock, service: 'worker', details: () => workerDetails(opts.boss), onError: (err) => logger.error({ err: errText(err) }, 'heartbeat: пульс worker не записан') }); // 17 §13.1, /health/deep
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
  // K20 §4: комната под необработанную заявку – снятие по истечении срока раз в 5 минут
  const requestHolds = startRequestHoldExpiry({
    pool: opts.pool,
    clock,
    intervalMs: opts.requestHoldIntervalMs ?? 5 * 60_000,
    onError: (err) => logger.error({ err: errText(err) }, 'events:request-hold-expire: проход упал'),
  });
  // K20 §8.1: истечение подарков раз в 10 минут
  const gifts = startGiftExpiry({
    pool: opts.pool,
    clock,
    intervalMs: opts.giftExpiryIntervalMs ?? 10 * 60_000,
    onError: (err) => logger.error({ err: errText(err) }, 'events.gift_expire: проход упал'),
  });
  // K18 §5: смена без отметки после review_grace – needs_review
  const shiftReview = startShiftReview({
    pool: opts.pool,
    clock,
    intervalMs: opts.shiftReviewIntervalMs ?? 15 * 60_000,
    onError: (err) => logger.error({ err: errText(err) }, 'shifts.review: проход упал'),
  });
  // 13 §11: события ленты без источника в outbox – пустая смена, подготовка мероприятия, окончание гарантии (пороги K7 notifications.feed_*)
  const staffFeedTimers = startStaffFeedTimers({
    pool: opts.pool,
    clock,
    intervalMs: opts.staffFeedIntervalMs ?? 60 * 60_000,
    onError: (err) => logger.error({ err: errText(err) }, 'notifications:staff-feed-timers: проход упал'),
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
    { pool: opts.pool, vapid: opts.vapid, clock, bookings: bookingLookup, unsubscribeSecret: opts.unsubscribeSecret ?? null },
    { intervalMs: opts.dispatcherIntervalMs ?? 30_000, log: (err) => logger.error({ err: errText(err) }, 'notifications: диспетчер') },
  );
  // K21 §6: разворачивание подтверждённых кампаний и закрытие завершённых
  const stopCampaigns = startCampaignRunner(
    { pool: opts.pool, clock },
    { intervalMs: opts.campaignIntervalMs ?? 30_000, log: (err) => logger.error({ err: errText(err) }, 'notifications: кампании') },
  );
  const reconcileLogger: ReconcileLogger = opts.reconcile?.logger ?? {
    info: (obj, msg) => log('info', msg, obj),
    error: (obj, msg) => logger.error(obj, msg),
  };
  const reconcile = startNightlyReconcile({
    pool: opts.pool,
    clock,
    logger: reconcileLogger,
    ...(opts.reconcile?.at ? { at: opts.reconcile.at } : {}),
    ...(opts.reconcile?.timeZone ? { timeZone: opts.reconcile.timeZone } : {}),
    ...(opts.reconcile?.intervalMs ? { intervalMs: opts.reconcile.intervalMs } : {}),
  });
  const mediaGc = opts.mediaStore
    ? startMediaGc({
        pool: opts.pool,
        store: opts.mediaStore,
        clock,
        onError: (err) => logger.error({ err: errText(err) }, 'content:media-gc: проход упал'),
        onDone: (r) => {
          if (r.removed.length > 0) log('info', 'content:media-gc: удалены файлы без строки', { removed: r.removed.length, kept: r.kept });
        },
      })
    : null;
  const exportRunner = opts.exports
    ? startExportRunner(
        {
          pool: opts.pool,
          reports: opts.exports.reports,
          store: opts.exports.store,
          clock,
          network: { branchesOfCities: branchIdsOfCities, timezonesOf },
          log: (err) => logger.error({ err: errText(err) }, 'reports:export: сбой задачи'),
        },
        { intervalMs: opts.exports.intervalMs ?? 5_000 },
      )
    : null;
  const exportGc = opts.exports
    ? startExportGc({ pool: opts.pool, store: opts.exports.store, clock, onError: (err) => logger.error({ err: errText(err) }, 'reports:export-gc: проход упал') })
    : null;
  return {
    outbox,
    reconcile,
    stop: async () => {
      heartbeat.stop();
      exportGc?.stop();
      await exportRunner?.stop();
      mediaGc?.stop();
      reconcile.stop();
      holds.stop();
      certificates.stop();
      requestHolds.stop();
      gifts.stop();
      shiftReview.stop();
      staffFeedTimers.stop();
      loyaltyExpiry.stop();
      stopDispatcher();
      stopCampaigns();
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
  const schedule = scheduleFromEnv();
  const reportsPool = config.REPORTS_DATABASE_URL ? createReportsPool(config.REPORTS_DATABASE_URL, config.REPORTS_POOL_MAX) : null;
  const tasks = await startWorkerTasks({
    pool,
    boss,
    vapid,
    reconcile: schedule,
    unsubscribeSecret: config.UNSUBSCRIBE_SECRET ?? null,
    mediaStore: createFileStore({ root: config.MEDIA_DIR }),
    ...(reportsPool ? { exports: { reports: reportsPool, store: createFileStore({ root: config.EXPORT_DIR }) } } : {}),
  });
  log('info', 'запущен: уведомления по событиям брони, outbox (pg-boss), истечение удержаний 15 с, партий баллов 10 мин, сгорание сертификатов 5 мин, отправка 30 с, сверка раз в сутки', {
    version: config.GIT_SHA,
    webPush: Boolean(vapid),
    reconcileAt: `${schedule.at} ${schedule.timeZone}`,
  });

  // Процесс держат соединения pg-boss и LISTEN outbox; таймеры удержаний и уведомлений – unref.
  let stopping = false;
  const shutdown = async (signal: string, code = 0): Promise<void> => {
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
      await reportsPool?.end();
      await pool.end();
      log('info', 'остановлен');
      process.exit(code);
    } catch (err) {
      log('error', 'ошибка при остановке', { err: errText(err) });
      process.exit(1);
    }
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void shutdown(signal));
  // Необработанный отказ промиса – ошибка в коде задачи, состояние процесса неизвестно. Лог и штатная остановка с кодом 1:
  // Docker (restart: unless-stopped) поднимет worker заново, задачи pg-boss и outbox лежат в базе и повторятся, зависший экспорт
  // подберёт failStale. Продолжать после неизвестного сбоя опаснее перезапуска; известные источники экспорта (fail, возврат в очередь) ловятся на месте.
  process.on('unhandledRejection', (err) => {
    log('error', 'необработанный отказ промиса – остановка для перезапуска', { err: errText(err), stack: err instanceof Error ? err.stack : undefined });
    void shutdown('unhandledRejection', 1);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    log('error', 'worker не запустился', { err: errText(err) });
    process.exit(1);
  });
}

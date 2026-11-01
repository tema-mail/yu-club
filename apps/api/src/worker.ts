// Фоновый процесс (ADR 0002: процесс worker – тот же образ API, другая команда).
// Запускает: доставку outbox через pg-boss (K4, core/outbox-worker.ts), истечение удержаний раз в 15 с
// (modules/booking/hold.ts) и диспетчер запланированных уведомлений Web Push раз в 30 с (modules/notifications/sender.ts).
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
import { startOutboxWorker } from './core/outbox-worker.ts';
import { systemClock } from './core/time.ts';
import { startHoldExpiry } from './modules/booking/hold.ts';
import { startDispatcher } from './modules/notifications/sender.ts';
import { vapidKeys } from './modules/notifications/webpush.ts';

const log = (level: 'info' | 'error', msg: string, extra: Record<string, unknown> = {}): void => {
  const line = JSON.stringify({ level, time: new Date().toISOString(), proc: 'worker', msg, ...extra });
  if (level === 'error') console.error(line);
  else console.info(line);
};
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

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

  const outbox = await startOutboxWorker({
    pool,
    boss,
    clock: systemClock,
    logger: { error: (obj, msg) => log('error', msg, obj) },
  });
  const holds = startHoldExpiry({ pool, clock: systemClock, intervalMs: 15_000, onError: (err) => log('error', 'hold-expiry: проход упал', { err: errText(err) }) });
  const vapid =
    config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY && config.VAPID_SUBJECT
      ? vapidKeys(config.VAPID_PUBLIC_KEY, config.VAPID_PRIVATE_KEY, config.VAPID_SUBJECT)
      : null;
  const stopDispatcher = startDispatcher({ pool, vapid }, { log: (err) => log('error', 'notifications: диспетчер', { err: errText(err) }) });
  log('info', 'запущен: outbox (pg-boss), истечение удержаний 15 с, уведомления 30 с', { version: config.GIT_SHA, webPush: Boolean(vapid) });

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
      holds.stop();
      stopDispatcher();
      await outbox.stop();
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

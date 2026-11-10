// Пульс фонового процесса (17 §13.1 «задержки фоновых задач»; 18 §9.4). Worker раз в intervalMs (30 с) обновляет
// свою строку app.service_heartbeats (миграция 0446): кто, какой версии, когда последний раз был жив и цифры очереди
// pg-boss. GET /health/deep (core/health.ts) читает строку под yu_app: схему pgboss API не видит (ADR 0001), поэтому
// глубину очереди считает worker через соединение pg-boss (роль yu_boss) и кладёт в details. В details – только числа:
// строку отдаёт маршрут без авторизации.
import { hostname } from 'node:os';
import type { PgBoss } from 'pg-boss';
import type pg from 'pg';
import type { Clock } from './time.ts';

export const HEARTBEAT_INTERVAL_MS = 30_000;

/** Цифры очереди pg-boss на момент пульса. null – посчитать не удалось (ошибка в onError). */
export interface QueueStats {
  /** Задачи в состояниях created и retry по всем очередям. */
  queued: number;
  active: number;
  /** Задачи, окончательно упавшие (failed) за последний час. */
  failedLastHour: number;
  /** Возраст самой старой задачи, которой уже пора выполняться (start_after прошёл), с; null – таких нет. */
  oldestReadySec: number | null;
}

/** Содержимое details строки пульса – только числа (строку отдаёт /health/deep без авторизации). */
export interface HeartbeatDetails {
  queue?: QueueStats;
}

export interface HeartbeatOptions {
  pool: pg.Pool;
  clock: Clock;
  /** Имя службы – ключ строки ('worker'). */
  service: string;
  /** По умолчанию GIT_SHA процесса. */
  version?: string;
  intervalMs?: number;
  /** Что положить в details при каждом пульсе (worker – workerDetails). Ошибка – в onError, пульс пишется с {}. */
  details?: () => Promise<HeartbeatDetails>;
  onError: (err: unknown) => void;
}

export interface Heartbeat {
  /** Немедленный пульс (тесты). */
  beatNow(): Promise<void>;
  stop(): void;
}

/** Глубина очередей pg-boss через публичный API плюс возраст самой старой готовой задачи одним SQL по pgboss.job
 *  (у yu_boss есть право на схему). Ошибка SQL не валит пульс: oldestReadySec = null. */
export async function queueStats(boss: PgBoss): Promise<QueueStats> {
  const queues = await boss.getQueues();
  const stats: QueueStats = { queued: 0, active: 0, failedLastHour: 0, oldestReadySec: null };
  for (const q of queues) {
    stats.queued += q.queuedCount;
    stats.active += q.activeCount;
  }
  const r = await boss.getDb().executeSql(
    `SELECT count(*) FILTER (WHERE state = 'failed' AND completed_on >= now() - interval '1 hour')::int AS failed_hour,
            extract(epoch FROM now() - min(created_on) FILTER (WHERE state IN ('created','retry') AND start_after <= now()))::int AS oldest_sec
       FROM pgboss.job`,
  );
  const row = r.rows[0] as { failed_hour: number; oldest_sec: number | null } | undefined;
  stats.failedLastHour = row?.failed_hour ?? 0;
  stats.oldestReadySec = row?.oldest_sec ?? null;
  return stats;
}

/** details пульса процесса worker: очередь pg-boss. */
export const workerDetails = async (boss: PgBoss): Promise<HeartbeatDetails> => ({ queue: await queueStats(boss) });

export function startHeartbeat(opts: HeartbeatOptions): Heartbeat {
  const startedAt = opts.clock.now();
  const instance = `${hostname()}:${process.pid}`;
  const version = opts.version ?? process.env.GIT_SHA ?? 'dev';
  let stopped = false;
  let running: Promise<void> | null = null;

  const beat = async (): Promise<void> => {
    let details: HeartbeatDetails = {};
    if (opts.details) {
      try {
        details = await opts.details();
      } catch (err) {
        opts.onError(err);
      }
    }
    await opts.pool.query(
      `INSERT INTO app.service_heartbeats (service, instance, version, started_at, beat_at, details)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (service) DO UPDATE
         SET instance = EXCLUDED.instance, version = EXCLUDED.version, started_at = EXCLUDED.started_at,
             beat_at = EXCLUDED.beat_at, details = EXCLUDED.details`,
      [opts.service, instance, version, startedAt, opts.clock.now(), JSON.stringify(details)],
    );
  };
  // один пульс за раз: долгий запрос не копит очередь из таймера
  const beatNow = (): Promise<void> => {
    if (running) return running;
    running = beat().finally(() => {
      running = null;
    });
    return running;
  };
  const tick = (): void => {
    if (stopped) return;
    beatNow().catch(opts.onError);
  };
  const timer = setInterval(tick, opts.intervalMs ?? HEARTBEAT_INTERVAL_MS);
  timer.unref();
  tick();
  return {
    beatNow,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

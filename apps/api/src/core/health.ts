// GET /health/deep (17 §13.1, 18 §9.2 п.8, §9.4 «мониторинг и уведомления об авариях работают»): состояние системы
// одним запросом для cron владельца (scripts/monitor-check.sh). Без авторизации, поэтому наружу – только статусы и числа:
// ни строк данных, ни путей, ни текстов ошибок (только код вроде ECONNREFUSED), ни имени хоста worker.
// Проверки: база (SELECT 1 с таймаутом 2 с), отставание outbox, пульс worker (core/heartbeat.ts, таблица 0446) и
// цифры очереди pg-boss из него, свободное место медиатеки и вложений, ошибки сервисных уведомлений за час (K21 §9).
// Итог: down – база не отвечает (503); degraded – порог превышен (200, тревога по телу); ok – всё в порядке.
// Частота: результат кэшируется cacheMs (5 с) и один проход на все одновременные запросы – частые опросы базу не грузят.
import { statfs } from 'node:fs/promises';
import type pg from 'pg';
import type { Db } from './audit.ts';
import type { HeartbeatDetails, QueueStats } from './heartbeat.ts';

export type HealthStatus = 'ok' | 'degraded' | 'down';
type CheckStatus = HealthStatus | 'skipped';

export interface HealthThresholds {
  /** Таймаут SELECT 1 и каждого запроса проверки, мс. */
  dbTimeoutMs: number;
  /** Самое старое неразосланное событие outbox старше – degraded. */
  outboxLagSec: number;
  /** Пульс worker старше – degraded (пульс раз в 30 с: три пропуска). */
  workerStaleSec: number;
  /** Самая старая готовая задача pg-boss ждёт дольше – degraded. */
  queueOldestSec: number;
  /** Свободно меньше, МБ (медиатека, вложения) – degraded. */
  diskMinFreeMb: number;
}

export const DEFAULT_THRESHOLDS: HealthThresholds = { dbTimeoutMs: 2_000, outboxLagSec: 60, workerStaleSec: 90, queueOldestSec: 300, diskMinFreeMb: 1_024 };

export interface DeepHealthOptions {
  /** Пул yu_app; нет (API без DATABASE_URL) – down. */
  pool?: Db;
  version: string;
  dirs: { media: string; attachments: string };
  thresholds?: Partial<HealthThresholds>;
  /** Срок кэша результата, мс; 0 – без кэша (тесты). */
  cacheMs?: number;
}

interface DbCheck { status: CheckStatus; latencyMs?: number; error?: string }
interface OutboxCheck { status: CheckStatus; pending?: number; oldestSec?: number | null; dispatchFailed?: number; error?: string }
interface WorkerCheck { status: CheckStatus; reason?: 'never' | 'stale'; ageSec?: number; version?: string; startedAt?: string; error?: string }
interface QueueCheck extends Partial<QueueStats> { status: CheckStatus; reason?: 'no_heartbeat' | 'unavailable' }
interface DiskEntry { status: CheckStatus; freeMb?: number; error?: string }
interface DiskCheck { status: CheckStatus; media: DiskEntry; attachments: DiskEntry }
interface NotificationsCheck { status: CheckStatus; serviceErrorsLastHour?: number; error?: string }

export interface DeepHealth {
  status: HealthStatus;
  version: string;
  checkedAt: string;
  checks: { db: DbCheck; outbox: OutboxCheck; worker: WorkerCheck; queue: QueueCheck; disk: DiskCheck; notifications: NotificationsCheck };
}

class TimeoutError extends Error {
  readonly code = 'TIMEOUT';
}

/** Код ошибки без текста: в тексте pg и fs бывают адреса, пути и значения строк. */
function errorCode(err: unknown): string {
  const code = (err as { code?: unknown })?.code;
  return typeof code === 'string' && code ? code : 'ERROR';
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError('timeout')), ms);
  });
  try {
    return await Promise.race([p, t]);
  } finally {
    clearTimeout(timer);
  }
}

const worst = (...s: CheckStatus[]): HealthStatus =>
  s.includes('down') ? 'down' : s.includes('degraded') ? 'degraded' : 'ok';

async function checkDisk(path: string, minFreeMb: number): Promise<DiskEntry> {
  try {
    const s = await statfs(path);
    const freeMb = Math.floor((s.bavail * s.bsize) / 1_048_576);
    return { status: freeMb < minFreeMb ? 'degraded' : 'ok', freeMb };
  } catch (err) {
    return { status: 'degraded', error: errorCode(err) };
  }
}

interface HeartbeatRow { version: string; started_at: Date; age_sec: number; details: HeartbeatDetails }

export async function deepHealth(opts: DeepHealthOptions): Promise<DeepHealth> {
  const th = { ...DEFAULT_THRESHOLDS, ...opts.thresholds };
  const checkedAt = new Date().toISOString();
  const [media, attachments] = await Promise.all([checkDisk(opts.dirs.media, th.diskMinFreeMb), checkDisk(opts.dirs.attachments, th.diskMinFreeMb)]);
  const disk: DiskCheck = { status: worst(media.status, attachments.status), media, attachments };
  const skipped = { status: 'skipped' as const };
  const result = (db: DbCheck, outbox: OutboxCheck, worker: WorkerCheck, queue: QueueCheck, notifications: NotificationsCheck): DeepHealth => ({
    status: worst(db.status, outbox.status, worker.status, queue.status, disk.status, notifications.status),
    version: opts.version,
    checkedAt,
    checks: { db, outbox, worker, queue, disk, notifications },
  });

  const pool = opts.pool;
  if (!pool) return result({ status: 'down', error: 'NOT_CONFIGURED' }, skipped, skipped, skipped, skipped);
  const q = <R extends pg.QueryResultRow>(sql: string) => withTimeout(pool.query<R>(sql), th.dbTimeoutMs);

  const started = Date.now();
  try {
    await q('SELECT 1');
  } catch (err) {
    return result({ status: 'down', error: errorCode(err) }, skipped, skipped, skipped, skipped);
  }
  const db: DbCheck = { status: 'ok', latencyMs: Date.now() - started };

  let outbox: OutboxCheck;
  try {
    const r = await q<{ pending: number; oldest_sec: number | null; failed: number }>(
      `SELECT count(*) FILTER (WHERE dispatched_at IS NULL AND dispatch_failed_at IS NULL)::int AS pending,
              extract(epoch FROM now() - min(occurred_at) FILTER (WHERE dispatched_at IS NULL AND dispatch_failed_at IS NULL))::int AS oldest_sec,
              count(*) FILTER (WHERE dispatch_failed_at IS NOT NULL)::int AS failed
         FROM app.outbox_events
        WHERE dispatched_at IS NULL`,
    );
    const row = r.rows[0]!;
    const lagging = row.oldest_sec !== null && row.oldest_sec > th.outboxLagSec;
    outbox = { status: lagging || row.failed > 0 ? 'degraded' : 'ok', pending: row.pending, oldestSec: row.oldest_sec, dispatchFailed: row.failed };
  } catch (err) {
    outbox = { status: 'down', error: errorCode(err) };
  }

  let worker: WorkerCheck;
  let queue: QueueCheck;
  try {
    const r = await q<HeartbeatRow>(
      `SELECT version, started_at, extract(epoch FROM now() - beat_at)::int AS age_sec, details
         FROM app.service_heartbeats WHERE service = 'worker'`,
    );
    const row = r.rows[0];
    if (!row) {
      worker = { status: 'degraded', reason: 'never' };
      queue = { status: 'skipped', reason: 'no_heartbeat' };
    } else {
      worker = { status: row.age_sec > th.workerStaleSec ? 'degraded' : 'ok', ageSec: row.age_sec, version: row.version, startedAt: row.started_at.toISOString() };
      if (worker.status === 'degraded') worker.reason = 'stale';
      const stats = row.details.queue;
      if (!stats) queue = { status: 'degraded', reason: 'unavailable' };
      else {
        const slow = stats.oldestReadySec !== null && stats.oldestReadySec > th.queueOldestSec;
        queue = { status: slow || stats.failedLastHour > 0 ? 'degraded' : 'ok', ...stats };
      }
    }
  } catch (err) {
    worker = { status: 'down', error: errorCode(err) };
    queue = skipped;
  }

  let notifications: NotificationsCheck;
  try {
    const r = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM app.notifications
        WHERE category = 'service' AND status = 'error' AND updated_at >= now() - interval '1 hour'`,
    );
    const n = r.rows[0]!.n;
    notifications = { status: n > 0 ? 'degraded' : 'ok', serviceErrorsLastHour: n };
  } catch (err) {
    notifications = { status: 'down', error: errorCode(err) };
  }

  return result(db, outbox, worker, queue, notifications);
}

/** Обёртка маршрута: один проход на все одновременные запросы и кэш на cacheMs (по умолчанию 5 с). */
export function createDeepHealth(opts: DeepHealthOptions): () => Promise<DeepHealth> {
  const cacheMs = opts.cacheMs ?? 5_000;
  let cached: { at: number; value: DeepHealth } | null = null;
  let running: Promise<DeepHealth> | null = null;
  return () => {
    if (cached && Date.now() - cached.at < cacheMs) return Promise.resolve(cached.value);
    if (running) return running;
    running = deepHealth(opts)
      .then((value) => {
        cached = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        running = null;
      });
    return running;
  };
}

// K4. Доставка outbox через pg-boss – часть процесса worker (ADR 0002).
// Диспетчер: по NOTIFY outbox и раз в intervalMs (1 с) вызывает dispatchOutbox → задача pg-boss
// в очередь 'outbox/<handler>' на каждого подписчика (singletonKey = <eventId>:<handler>).
// Обработчик: processEvent в своей транзакции; исключение → pg-boss повторяет с экспонентой до retryLimit (10),
// последняя неудача – статус failed и лог уровня error с eventId и handler (17 §13).
import type { PgBoss } from 'pg-boss';
import type pg from 'pg';
import { dispatchOutbox, listSubscriptions, processEvent, type OutboxJob } from './outbox.ts';
import type { Clock } from './time.ts';

export interface WorkerLogger {
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface OutboxWorkerOptions {
  pool: pg.Pool;
  /** Уже запущенный экземпляр pg-boss (boss.start() делает вход worker). */
  boss: PgBoss;
  clock: Clock;
  /** Резервный опрос outbox, мс. По умолчанию 1000 (K4). */
  intervalMs?: number;
  /** Опрос очередей pg-boss, с (≥ 0,5). */
  pollingIntervalSeconds?: number;
  /** Начальная задержка повтора, с; дальше экспонента pg-boss. По умолчанию 1. */
  retryDelaySeconds?: number;
  logger?: WorkerLogger;
}

export interface OutboxWorker {
  /** Немедленный проход диспетчера (тесты, ручной запуск). Возвращает число разосланных событий. */
  dispatchNow(): Promise<number>;
  stop(): Promise<void>;
}

interface JobData {
  eventId: string;
}

const consoleLogger: WorkerLogger = {
  error: (obj, msg) => console.error(msg, obj),
};

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function startOutboxWorker(opts: OutboxWorkerOptions): Promise<OutboxWorker> {
  const { pool, boss, clock } = opts;
  const logger = opts.logger ?? consoleLogger;
  const retryDelay = opts.retryDelaySeconds ?? 1;
  const subs = listSubscriptions();

  for (const sub of subs) {
    if (!(await boss.getQueue(sub.queue))) {
      await boss.createQueue(sub.queue, { retryLimit: sub.retryLimit, retryBackoff: sub.retryBackoff, retryDelay });
    }
    const workOptions = { includeMetadata: true, batchSize: 1, pollingIntervalSeconds: opts.pollingIntervalSeconds ?? 2 } as const;
    await boss.work<JobData, void, typeof workOptions>(
      sub.queue,
      workOptions,
      async (jobs) => {
        for (const job of jobs) {
          try {
            await processEvent(pool, sub.name, job.data.eventId);
          } catch (err) {
            if (job.retryCount >= job.retryLimit) {
              logger.error(
                { eventId: job.data.eventId, handler: sub.name, jobId: job.id, attempts: job.retryCount + 1, err: errorText(err) },
                'outbox: обработчик исчерпал повторы, задача failed',
              );
            }
            throw err;
          }
        }
      },
    );
  }

  const enqueue = async (job: OutboxJob): Promise<void> => {
    await boss.send(job.queue, { eventId: job.eventId } satisfies JobData, {
      singletonKey: job.singletonKey,
      retryLimit: job.retryLimit,
      retryBackoff: job.retryBackoff,
      retryDelay,
    });
  };

  // Один проход за раз; пришедший во время прохода сигнал – ещё один проход после него.
  let running: Promise<number> | null = null;
  let again = false;
  let stopped = false;
  const runOnce = async (): Promise<number> => {
    let total = 0;
    do {
      again = false;
      let n: number;
      do {
        n = await dispatchOutbox(pool, enqueue, clock.now());
        total += n;
      } while (n === 100 && !stopped);
    } while (again && !stopped);
    return total;
  };
  const kick = (): Promise<number> => {
    if (running) {
      again = true;
      return running;
    }
    running = runOnce().finally(() => {
      running = null;
    });
    return running;
  };
  const kickLogged = (): void => {
    if (stopped) return;
    kick().catch((err: unknown) => logger.error({ err: errorText(err) }, 'outbox: проход диспетчера упал'));
  };

  const listener = await pool.connect();
  let listenerAlive = true;
  listener.on('notification', (m) => {
    if (m.channel === 'outbox') kickLogged();
  });
  listener.on('error', (err) => {
    // Резервный опрос продолжает работу; соединение отдаётся пулу как сломанное при остановке.
    listenerAlive = false;
    logger.error({ err: errorText(err) }, 'outbox: соединение LISTEN потеряно, остаётся опрос');
  });
  await listener.query('LISTEN outbox');
  const timer = setInterval(kickLogged, opts.intervalMs ?? 1000);
  kickLogged(); // разослать накопленное до старта

  return {
    dispatchNow: kick,
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      if (listenerAlive) await listener.query('UNLISTEN outbox').catch(() => undefined);
      listener.release(!listenerAlive);
      await running?.catch(() => undefined);
      for (const sub of subs) await boss.offWork(sub.queue);
    },
  };
}

// K4. События outbox (ADR 0004 §4, model-dannyh 0005).
// publish   – внутри транзакции команды: событие видно только после её фиксации.
// subscribe – регистрация обработчика со стабильным именем (processed_events.handler).
// dispatchOutbox – диспетчер: берёт неразосланные (FOR UPDATE SKIP LOCKED), ставит задачу на каждого
//                  подписчика через переданный enqueue (pg-boss – core/outbox-worker.ts), ставит dispatched_at.
// processEvent – обработка одной задачи: своя транзакция, processed_events гасит повторную доставку,
//                исключение обработчика откатывает транзакцию и пробрасывается (повтор – дело очереди).
import type pg from 'pg';

export type Tx = Pick<pg.ClientBase, 'query'>;

/**
 * Реестр событий: модуль-производитель добавляет свои типы в своём файле (ADR 0002):
 *   declare module '<путь>/core/outbox.ts' { interface EventRegistry { 'booking.confirmed': BookingConfirmedPayload } }
 * Zod-схемы payload – packages/contracts/src/events/<модуль>.ts (K4).
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- точка расширения для модулей
export interface EventRegistry {}

export type EventType = keyof EventRegistry & string;
export type EventPayload<T extends EventType> = EventRegistry[T];
export type AggregateType = 'hold' | 'booking' | 'resource_block' | 'client';

export interface EventEnvelope<T extends EventType = EventType> {
  eventId: string;
  type: T;
  version: number;
  aggregateType: AggregateType;
  aggregateId: string;
  branchId: string | null;
  occurredAt: string; // ISO UTC
  payload: EventPayload<T>;
}

export interface PublishInput<T extends EventType> {
  type: T;
  aggregateType: AggregateType;
  aggregateId: string;
  aggregateVersion: number | string;
  branchId: string | null;
  payload: EventPayload<T>;
  /** $now команды из Clock (ADR 0003 п.10). */
  occurredAt: Date;
  /** Версия схемы payload; по умолчанию 1. */
  version?: number;
}

/** Внутри транзакции команды. Второй publish того же факта (тот же dedupeKey) возвращает существующий eventId. */
export async function publish<T extends EventType>(tx: Tx, e: PublishInput<T>): Promise<{ eventId: string }> {
  const version = e.version ?? 1;
  if (!Number.isInteger(version) || version < 1) throw new Error(`publish: версия события – целое ≥ 1, получено ${version}`);
  const dedupeKey = `${e.type}:${e.aggregateId}:${String(e.aggregateVersion)}`;
  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO app.outbox_events (event_type, event_version, aggregate_type, aggregate_id, branch_id, payload, dedupe_key, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [e.type, version, e.aggregateType, e.aggregateId, e.branchId, JSON.stringify(e.payload), dedupeKey, e.occurredAt],
  );
  const id =
    inserted.rows[0]?.id ??
    (await tx.query<{ id: string }>('SELECT id FROM app.outbox_events WHERE dedupe_key = $1', [dedupeKey])).rows[0]?.id;
  if (!id) throw new Error(`publish: событие ${dedupeKey} не записано и не найдено`);
  return { eventId: id };
}

// ---- подписки

export type Handler<T extends EventType = EventType> = (tx: Tx, e: EventEnvelope<T>) => Promise<void>;

export interface Subscription {
  type: EventType;
  name: string;
  queue: string;
  handler: Handler;
  retryLimit: number;
  retryBackoff: boolean;
}

const HANDLER_NAME_RE = /^[A-Za-z0-9_.-]+$/;
const subscriptions = new Map<string, Subscription>();

/** Имя очереди pg-boss для обработчика. ':' в именах очередей pg-boss запрещён, поэтому 'outbox/<handler>'. */
export function outboxQueue(handlerName: string): string {
  return `outbox/${handlerName}`;
}

/** Регистрация обработчика. name – стабильное имя, уникальное во всём приложении. */
export function subscribe<T extends EventType>(
  type: T,
  name: string,
  handler: Handler<T>,
  opts: { retryLimit?: number; retryBackoff?: true } = {},
): void {
  if (!HANDLER_NAME_RE.test(name)) throw new Error(`subscribe: имя обработчика «${name}» – только [A-Za-z0-9_.-]`);
  if (subscriptions.has(name)) throw new Error(`subscribe: обработчик «${name}» уже зарегистрирован`);
  const retryLimit = opts.retryLimit ?? 10;
  if (!Number.isInteger(retryLimit) || retryLimit < 0) throw new Error(`subscribe: retryLimit – целое ≥ 0`);
  subscriptions.set(name, {
    type,
    name,
    queue: outboxQueue(name),
    handler: handler as unknown as Handler,
    retryLimit,
    retryBackoff: true, // K4: повтор всегда экспоненциальный
  });
}

export function listSubscriptions(): Subscription[] {
  return [...subscriptions.values()];
}

/** Только для тестов и перезапуска воркера: снять все подписки. */
export function clearSubscriptions(): void {
  subscriptions.clear();
}

// ---- диспетчер

export interface OutboxJob {
  queue: string;
  handler: string;
  eventId: string;
  /** singletonKey = <eventId>:<handler> (K4). */
  singletonKey: string;
  retryLimit: number;
  retryBackoff: boolean;
}

/**
 * Один проход диспетчера: до `limit` неразосланных событий, задача на каждого подписчика, dispatched_at = now.
 * Событие без подписчиков тоже помечается разосланным (иначе оно вечно занимает голову очереди); строка остаётся.
 * Ошибка enqueue откатывает проход – события будут взяты снова (дубли гасит processed_events).
 * Возвращает число помеченных событий.
 */
export async function dispatchOutbox(
  pool: pg.Pool,
  enqueue: (job: OutboxJob) => Promise<void>,
  now: Date,
  limit = 100,
): Promise<number> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const res = await c.query<{ id: string; event_type: string }>(
      `SELECT id, event_type FROM app.outbox_events
       WHERE dispatched_at IS NULL ORDER BY occurred_at, id LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    for (const ev of res.rows) {
      for (const sub of subscriptions.values()) {
        if (sub.type !== ev.event_type) continue;
        await enqueue({
          queue: sub.queue,
          handler: sub.name,
          eventId: ev.id,
          singletonKey: `${ev.id}:${sub.name}`,
          retryLimit: sub.retryLimit,
          retryBackoff: sub.retryBackoff,
        });
      }
    }
    if (res.rows.length > 0) {
      await c.query('UPDATE app.outbox_events SET dispatched_at = $2 WHERE id = ANY($1::uuid[])', [res.rows.map((r) => r.id), now]);
    }
    await c.query('COMMIT');
    return res.rows.length;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

// ---- обработка

interface EventRow {
  id: string;
  event_type: string;
  event_version: number;
  aggregate_type: AggregateType;
  aggregate_id: string;
  branch_id: string | null;
  payload: unknown;
  occurred_at: Date;
}

/**
 * Обработать событие одним обработчиком в своей транзакции.
 * 'duplicate' – уже обработано (повторная доставка); исключение обработчика – откат и проброс.
 */
export async function processEvent(pool: pg.Pool, handlerName: string, eventId: string): Promise<'processed' | 'duplicate'> {
  const sub = subscriptions.get(handlerName);
  if (!sub) throw new Error(`processEvent: нет обработчика «${handlerName}»`);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const claimed = await c.query(
      'INSERT INTO app.processed_events (handler, event_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING event_id',
      [handlerName, eventId],
    );
    if (claimed.rowCount !== 1) {
      await c.query('COMMIT');
      return 'duplicate';
    }
    const row = (
      await c.query<EventRow>(
        `SELECT id, event_type, event_version, aggregate_type, aggregate_id, branch_id, payload, occurred_at
         FROM app.outbox_events WHERE id = $1`,
        [eventId],
      )
    ).rows[0];
    if (!row) throw new Error(`processEvent: события ${eventId} нет`);
    if (row.event_type !== sub.type) throw new Error(`processEvent: «${handlerName}» не подписан на ${row.event_type}`);
    const envelope = {
      eventId: row.id,
      type: row.event_type,
      version: row.event_version,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      branchId: row.branch_id,
      occurredAt: row.occurred_at.toISOString(),
      payload: row.payload,
    } as EventEnvelope;
    await sub.handler(c, envelope);
    await c.query('COMMIT');
    return 'processed';
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

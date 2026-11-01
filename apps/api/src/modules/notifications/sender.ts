// K14 §Отправка (S1-16): плановые строки app.notifications → Web Push на все активные подписки клиента.
// Транзакция А: строка под FOR UPDATE, проверки перед отправкой (09 §6.4), статус 'sending'.
// Сеть – вне транзакции. Транзакция Б: журнал попыток, подписки 404/410 → revoked('gone'), итоговый статус, аудит.
// Статусы журнала: sent_to_provider («отправлено провайдеру»), no_channel («нет канала»),
// skipped_by_prefs / skipped_booking_changed («пропущено»), error («ошибка»). 'delivered' не ставим: Web Push
// не подтверждает показ (09 §9). Нет канала – бронь не страдает, строка остаётся для ЛК (16 §15.5).
//
// Проверки перед отправкой (09 §6.4, 7 штук):
//   1. бронь есть                 – BookingLookup (поток брони), без него не проверяется
//   2. бронь не отменена          – BookingLookup; для самого сообщения «отменено клубом» не применяется
//   3. не завершена, не перенесена – BookingLookup (версия = booking_version) + not_after (сеанс начался – не шлём)
//   4. клиент тот же              – BookingLookup (client_id брони = client_id уведомления)
//   5. настройка включена         – здесь: reminder → «Напоминания», marketing → «Реклама» (без согласия – пропуск)
//   6. есть push-подписка         – здесь: нет активной → no_channel
//   7. этап ещё не отправлен      – здесь: dedupe_key UNIQUE + статус 'queued' под FOR UPDATE (повтор задачи – выход)
import type pg from 'pg';
import { writeAudit, type AuditRequestMeta } from '../../core/audit.ts';
import { resolveSetting } from '../../core/settings.ts';
import { systemClock, type Clock } from '../../core/time.ts';
import { getNotificationPrefs, withTx, type Pool } from '../clients/index.ts';
import { buildPushRequest, pushTopic, sendPushRequest, type FetchLike, type PushOutcome, type VapidKeys } from './webpush.ts';

/** Состояние брони для проверок 1–4. Реализацию даёт модуль booking (S1-07/S1-09). */
export interface BookingLookup {
  snapshot(tx: pg.ClientBase, bookingId: string): Promise<{ version: number; clientId: string; state: 'active' | 'cancelled' | 'finished' } | null>;
}

export interface SenderDeps {
  pool: Pool;
  clock?: Clock;
  /** null – ключей VAPID нет: всё уходит в no_channel, запись остаётся в ЛК. */
  vapid: VapidKeys | null;
  fetch?: FetchLike;
  timeoutMs?: number;
  bookings?: BookingLookup;
}

export type SendResult = 'sent_to_provider' | 'no_channel' | 'skipped_by_prefs' | 'skipped_booking_changed' | 'error' | 'retry' | 'not_queued';

/** Задержки повторов после временной ошибки (K14): 1, 5, 15 мин. */
export const RETRY_DELAYS_MIN = [1, 5, 15] as const;
const TTL_BEFORE_START_SEC = 3600;
const TTL_DEFAULT_SEC = 12 * 3600;

const SYSTEM_META: AuditRequestMeta = { actor: { kind: 'system', process: 'notifications.sender' }, source: 'system', requestId: 'notifications.sender' };

interface Row {
  id: string;
  client_id: string;
  branch_id: string | null;
  category: string;
  kind: string;
  booking_id: string | null;
  booking_version: number | null;
  title: string;
  body: string;
  url: string | null;
  not_after: Date | null;
  status: string;
  attempts: number;
  dedupe_key: string;
}

interface Sub {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** Плановые с наступившим моментом → 'queued'. Возвращает их id (FOR UPDATE SKIP LOCKED – параллельные диспетчеры не пересекаются). */
export async function claimDue(pool: Pool, now: Date, limit = 200): Promise<string[]> {
  const r = await pool.query<{ id: string }>(
    `UPDATE app.notifications SET status = 'queued', updated_at = $1
     WHERE id IN (SELECT id FROM app.notifications
                  WHERE status = 'planned' AND coalesce(retry_at, planned_at) <= $1
                  ORDER BY coalesce(retry_at, planned_at) LIMIT $2 FOR UPDATE SKIP LOCKED)
     RETURNING id`,
    [now, limit],
  );
  return r.rows.map((x) => x.id);
}

type Verdict = { status: 'skipped_by_prefs' | 'skipped_booking_changed' | 'no_channel'; reason: string } | { status: 'send'; subs: Sub[] };

async function preCheck(tx: pg.ClientBase, row: Row, now: Date, deps: SenderDeps): Promise<Verdict> {
  if (row.not_after && row.not_after.getTime() <= now.getTime()) return { status: 'skipped_booking_changed', reason: 'expired' }; // 3
  if (row.booking_id && deps.bookings) {
    const b = await deps.bookings.snapshot(tx, row.booking_id);
    if (!b) return { status: 'skipped_booking_changed', reason: 'booking_missing' }; // 1
    if (b.state === 'cancelled' && row.kind !== 'booking_cancelled') return { status: 'skipped_booking_changed', reason: 'booking_cancelled' }; // 2
    if (b.state === 'finished') return { status: 'skipped_booking_changed', reason: 'booking_finished' }; // 3
    if (b.version !== row.booking_version) return { status: 'skipped_booking_changed', reason: 'booking_changed' }; // 3
    if (b.clientId !== row.client_id) return { status: 'skipped_booking_changed', reason: 'client_changed' }; // 4
  }
  if (row.category === 'reminder' || row.category === 'marketing') {
    const prefs = await getNotificationPrefs(tx, row.client_id); // 5
    if (row.category === 'reminder' && !prefs.remindersEnabled) return { status: 'skipped_by_prefs', reason: 'reminders_disabled' };
    if (row.category === 'marketing' && !prefs.marketingEnabled) return { status: 'skipped_by_prefs', reason: 'marketing_not_consented' };
  }
  if (!deps.vapid) return { status: 'no_channel', reason: 'push_not_configured' };
  const subs = await tx.query<Sub>(
    'SELECT id, endpoint, p256dh, auth FROM app.push_subscriptions WHERE client_id = $1 AND revoked_at IS NULL ORDER BY created_at',
    [row.client_id],
  );
  if (subs.rows.length === 0) return { status: 'no_channel', reason: 'no_subscription' }; // 6
  return { status: 'send', subs: subs.rows };
}

async function finishWithoutSend(tx: pg.ClientBase, row: Row, status: string, reason: string, now: Date, clock: Clock): Promise<void> {
  await tx.query('UPDATE app.notifications SET status = $2, skip_reason = $3, updated_at = $4 WHERE id = $1', [row.id, status, reason, now]);
  await writeAudit(
    tx,
    SYSTEM_META,
    { action: 'notification.skipped', object: { type: 'notification', id: row.id }, branchId: row.branch_id, after: { status, reason, kind: row.kind } },
    clock,
  );
}

function outcomeLabel(o: PushOutcome): 'accepted' | 'gone' | 'retryable' | 'rejected' | 'timeout' {
  return o.kind;
}

/** Одна задача notifications:send(id). Повторный вызов для уже обработанной строки – 'not_queued'. */
export async function sendNotification(deps: SenderDeps, id: string): Promise<SendResult> {
  const clock = deps.clock ?? systemClock;

  // Транзакция А: проверки и 'sending'.
  const prepared = await withTx(deps.pool, async (tx) => {
    const now = clock.now();
    const r = await tx.query<Row>(
      `SELECT id, client_id, branch_id, category, kind, booking_id, booking_version, title, body, url, not_after, status, attempts, dedupe_key
       FROM app.notifications WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const row = r.rows[0];
    if (!row || row.status !== 'queued') return null; // 7: уже отправлено или обработано другим
    const v = await preCheck(tx, row, now, deps);
    if (v.status !== 'send') {
      await finishWithoutSend(tx, row, v.status, v.reason, now, clock);
      return { row, result: v.status as SendResult, subs: [] as Sub[] };
    }
    await tx.query(`UPDATE app.notifications SET status = 'sending', attempts = attempts + 1, updated_at = $2 WHERE id = $1`, [id, now]);
    return { row: { ...row, attempts: row.attempts + 1 }, result: null, subs: v.subs };
  });
  if (!prepared) return 'not_queued';
  if (prepared.result) return prepared.result;
  const { row, subs } = prepared;

  // Сеть: по каждой подписке, вне транзакции.
  const vapid = deps.vapid!;
  const now = clock.now();
  const before = row.kind === 'reminder_before_start';
  const payload = { title: row.title, body: row.body, url: row.url ?? '/account/', tag: pushTopic(row.dedupe_key), id: row.id };
  const outcomes: Array<{ sub: Sub; outcome: PushOutcome }> = [];
  for (const sub of subs) {
    let outcome: PushOutcome;
    try {
      const req = buildPushRequest(sub, payload, {
        vapid,
        now,
        ttlSec: before ? TTL_BEFORE_START_SEC : TTL_DEFAULT_SEC,
        topic: pushTopic(row.dedupe_key),
        urgency: before || row.kind === 'booking_cancelled' ? 'high' : 'normal',
      });
      outcome = await sendPushRequest(req, deps.fetch ?? (fetch as unknown as FetchLike), deps.timeoutMs);
    } catch {
      outcome = { kind: 'rejected', status: 0 }; // кривые ключи подписки – повтор не поможет
    }
    outcomes.push({ sub, outcome });
  }

  // Транзакция Б: журнал, подписки, итог.
  return withTx(deps.pool, async (tx) => {
    const at = clock.now();
    for (const { sub, outcome } of outcomes) {
      const status = 'status' in outcome ? outcome.status : null;
      await tx.query(
        `INSERT INTO journal.notification_deliveries (notification_id, subscription_id, attempt, outcome, http_status, at) VALUES ($1, $2, $3, $4, $5, $6)`,
        [row.id, sub.id, row.attempts, outcomeLabel(outcome), status || null, at],
      );
      if (outcome.kind === 'gone') {
        await tx.query(
          `UPDATE app.push_subscriptions SET revoked_at = $2, revoke_reason = 'gone', updated_at = $2 WHERE id = $1 AND revoked_at IS NULL`,
          [sub.id, at],
        );
      } else if (outcome.kind === 'accepted') {
        await tx.query('UPDATE app.push_subscriptions SET last_success_at = $2, last_error = NULL WHERE id = $1', [sub.id, at]);
      } else {
        await tx.query('UPDATE app.push_subscriptions SET last_error = $2 WHERE id = $1', [sub.id, outcome.kind === 'timeout' ? 'timeout' : `http ${outcome.status}`]);
      }
    }
    const count = (k: PushOutcome['kind']) => outcomes.filter((o) => o.outcome.kind === k).length;
    const summary = { accepted: count('accepted'), gone: count('gone'), retryable: count('retryable') + count('timeout'), rejected: count('rejected') };
    const audit = (action: 'notification.sent' | 'notification.failed' | 'notification.skipped', after: object) =>
      writeAudit(tx, SYSTEM_META, { action, object: { type: 'notification', id: row.id }, branchId: row.branch_id, after: { kind: row.kind, attempt: row.attempts, ...summary, ...after } }, clock);

    if (summary.accepted > 0) {
      await tx.query(`UPDATE app.notifications SET status = 'sent_to_provider', sent_at = $2, error = NULL, retry_at = NULL, updated_at = $2 WHERE id = $1`, [row.id, at]);
      await audit('notification.sent', { status: 'sent_to_provider' });
      return 'sent_to_provider';
    }
    if (summary.gone === outcomes.length) {
      await tx.query(`UPDATE app.notifications SET status = 'no_channel', skip_reason = 'subscriptions_gone', updated_at = $2 WHERE id = $1`, [row.id, at]);
      await audit('notification.skipped', { status: 'no_channel', reason: 'subscriptions_gone' });
      return 'no_channel';
    }
    if (summary.retryable > 0) {
      const limit = (await resolveSetting(tx, 'notifications.push_retry_limit', { network: true }, at)).value;
      if (row.attempts <= limit) {
        const delay = RETRY_DELAYS_MIN[Math.min(row.attempts - 1, RETRY_DELAYS_MIN.length - 1)]!;
        await tx.query(`UPDATE app.notifications SET status = 'planned', retry_at = $2, error = $3, updated_at = $4 WHERE id = $1`, [
          row.id,
          new Date(at.getTime() + delay * 60_000),
          'provider_unavailable',
          at,
        ]);
        return 'retry';
      }
    }
    const error = summary.retryable > 0 ? 'retries_exhausted' : 'provider_rejected';
    await tx.query(`UPDATE app.notifications SET status = 'error', error = $2, updated_at = $3 WHERE id = $1`, [row.id, error, at]);
    await audit('notification.failed', { status: 'error', error });
    return 'error';
  });
}

/** Одна итерация диспетчера: взять наступившие и отправить по одной. Возвращает счётчики итогов. */
export async function runDue(deps: SenderDeps, limit = 200): Promise<Partial<Record<SendResult, number>>> {
  const ids = await claimDue(deps.pool, (deps.clock ?? systemClock).now(), limit);
  const counts: Partial<Record<SendResult, number>> = {};
  for (const id of ids) {
    const r = await sendNotification(deps, id);
    counts[r] = (counts[r] ?? 0) + 1;
  }
  return counts;
}

/**
 * Возврат «зависших»: 'queued'/'sending' дольше staleMs (процесс упал между транзакциями) → снова 'planned'.
 * Повтор допустим: Topic схлопывает дубль на устройстве (K14, ADR 0004 §2).
 */
export async function requeueStale(pool: Pool, now: Date, staleMs = 10 * 60_000): Promise<number> {
  const r = await pool.query(
    `UPDATE app.notifications SET status = 'planned', updated_at = $1 WHERE status IN ('queued','sending') AND updated_at < $2`,
    [now, new Date(now.getTime() - staleMs)],
  );
  return r.rowCount ?? 0;
}

/** Диспетчер раз в intervalMs (K14: 30 с). Итерации не накладываются. Возвращает остановку. */
export function startDispatcher(deps: SenderDeps, opts: { intervalMs?: number; log?: (err: unknown) => void } = {}): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await requeueStale(deps.pool, (deps.clock ?? systemClock).now());
      await runDue(deps);
    } catch (err) {
      (opts.log ?? ((e) => console.error('notifications: диспетчер', e)))(err);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), opts.intervalMs ?? 30_000);
  timer.unref();
  return () => clearInterval(timer);
}

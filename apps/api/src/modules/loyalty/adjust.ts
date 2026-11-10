// K15 §9 (07 §10.3): ручная корректировка баллов с причиной и задача истечения партий (K15 §2, Q-43).
// «+» – новая партия source='manual' (срок – по loyalty.batch_ttl_days); «−» – расход FEFO, остаток – долг.
// Ниже −50 – только Владелец (loyalty.adjust_below_limit) явным режимом K3 allowBelowLimit; иначе LIMIT_OVERRIDE_NOT_ALLOWED.
// Исходная операция не меняется – корректировка всегда новая запись (16 §2.7). Закрытие loyalty_issues – этой же командой
// со ссылкой на issue (нет, чужое – NOT_FOUND, закрыто – LOYALTY_ISSUE_RESOLVED). Повтор по ключу распознаётся до
// проверки предела: прежний ответ без аудита. Зону клиента (K1 assertCanClient) проверяет маршрут CRM; здесь – право роли.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { writeAudit, type AuditRequestMeta } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import type { Tx } from '../../core/ledger.ts';
import { roleAllows, type AccessContext } from '../../core/permissions.ts';
import { resolveSetting } from '../../core/settings.ts';
import { systemClock, type Clock, type TimeZone } from '../../core/time.ts';
import { createBatch, debitBatches, openAccount, openClientAccount, POINTS_MIN_BALANCE, postPoints } from './account.ts';
import { batchExpiry } from './accrual.ts';

export interface AdjustInput {
  clientId: string;
  deltaCenti: number;
  reason: string;
  /** Явный режим «ниже −50» (K15 №25 belowLimit) – только с правом loyalty.adjust_below_limit. */
  belowLimit?: boolean;
  /** Закрыть «требует решения» этой корректировкой (K15 §9). */
  issueId?: string;
  /** Филиал операции (срок партии – конец суток по его зоне); нет – сутки по UTC. */
  branch?: { id: string; timezone: string };
  /** Ключ намерения (Idempotency-Key маршрута); повтор – та же запись K3. */
  idempotencyKey?: string;
}

const forbidden = (action: string) => new AppError('FORBIDDEN', 403, 'Недостаточно прав', { action });

export async function adjust(tx: Tx, ctx: AccessContext, input: AdjustInput, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<{ entryId: number }> {
  const reason = input.reason?.trim() ?? '';
  if (reason === '') throw new AppError('COMMENT_REQUIRED', 422, 'Укажите причину корректировки', { field: 'reason' });
  if (!Number.isSafeInteger(input.deltaCenti) || input.deltaCenti === 0) {
    throw new AppError('VALIDATION_FAILED', 400, 'Сумма корректировки – целое ненулевое число сотых балла', { field: 'deltaCenti' });
  }
  if (!roleAllows(ctx.role, 'loyalty.adjust')) throw forbidden('loyalty.adjust');
  const now = clock.now();
  const acc = await openClientAccount(tx, input.clientId, now); // объединённая карточка – CLIENT_MERGED под замком счёта (D5-09)
  const author = { type: 'staff' as const, id: ctx.actor.staffId };
  const key = `loyalty-adjust:${input.idempotencyKey ?? randomUUID()}`;
  // повтор по ключу – до проверки предела и issue: прежний ответ, без аудита; тот же ключ с другой суммой – отказ
  const prior = (
    await tx.query<{ id: string; account_id: string; amount: string; entry_type: string }>(
      'SELECT id, account_id, amount, entry_type FROM journal.ledger_entries WHERE idempotency_key = $1',
      [`${key}#0`],
    )
  ).rows[0];
  if (prior) {
    if (prior.account_id !== acc.accountId || Number(prior.amount) !== input.deltaCenti || prior.entry_type !== 'loyalty.manual') {
      throw new AppError('IDEMPOTENCY_KEY_REUSED', 409, 'Ключ уже использован для другой операции');
    }
    return { entryId: Number(prior.id) };
  }
  if (input.issueId) {
    const issue = (await tx.query<{ status: string }>('SELECT status FROM app.loyalty_issues WHERE id = $1 AND client_id = $2 FOR UPDATE', [input.issueId, acc.clientId])).rows[0];
    if (!issue) throw new AppError('NOT_FOUND', 404, 'Задача «требует решения» не найдена', { issueId: input.issueId });
    if (issue.status !== 'open') throw new AppError('LOYALTY_ISSUE_RESOLVED', 409, 'Задача «требует решения» уже закрыта', { issueId: input.issueId });
  }
  const ref = input.issueId ? { issueId: input.issueId } : undefined;
  let entryId: number;
  if (input.deltaCenti > 0) {
    const p = await postPoints(tx, acc.clientId, { amount: input.deltaCenti, type: 'loyalty.manual', basis: reason, branchId: input.branch?.id ?? null, occurredAt: now, ...(ref ? { refs: ref } : {}) }, key, author);
    entryId = p.entryId;
    if (!p.replayed) {
      const ttl = (await resolveSetting(tx, 'loyalty.batch_ttl_days', { network: true }, now)).value;
      await createBatch(tx, {
        clientId: acc.clientId, entryId, amount: input.deltaCenti, balanceBefore: p.balanceBefore, source: 'manual', branchId: input.branch?.id ?? null,
        expiresAt: batchExpiry(now, ttl, (input.branch?.timezone ?? 'UTC') as TimeZone), accruedAt: now,
      });
    }
  } else {
    const below = acc.balance + input.deltaCenti < POINTS_MIN_BALANCE;
    if (below && !(input.belowLimit === true && roleAllows(ctx.role, 'loyalty.adjust_below_limit'))) {
      throw new AppError('LIMIT_OVERRIDE_NOT_ALLOWED', 403, 'Ниже −50 баллов – только Владелец в режиме «ниже предела»', { balanceCenti: acc.balance, deltaCenti: input.deltaCenti });
    }
    const p = await postPoints(
      tx, acc.clientId, { amount: input.deltaCenti, type: 'loyalty.manual', basis: reason, branchId: input.branch?.id ?? null, occurredAt: now, ...(ref ? { refs: ref } : {}) },
      key, author, below ? { reason } : undefined,
    );
    entryId = p.entryId;
    if (!p.replayed) await debitBatches(tx, { clientId: acc.clientId, entryId, amount: -input.deltaCenti, balanceBefore: p.balanceBefore, kind: 'manual' });
  }
  await writeAudit(tx, meta, { action: 'loyalty.adjusted', object: { type: 'client', id: acc.clientId }, branchId: input.branch?.id ?? null, before: { balanceCenti: acc.balance }, after: { deltaCenti: input.deltaCenti, entryId, belowLimit: input.belowLimit === true }, reason }, clock);
  if (input.issueId) {
    await tx.query(
      `UPDATE app.loyalty_issues SET status = 'resolved', resolved_entry_id = $3, resolved_by = $4, resolved_at = $5 WHERE id = $1 AND client_id = $2 AND status = 'open'`,
      [input.issueId, acc.clientId, entryId, ctx.actor.staffId, now],
    );
    await writeAudit(tx, meta, { action: 'loyalty.issue.resolved', object: { type: 'client', id: acc.clientId }, after: { issueId: input.issueId, entryId }, reason }, clock);
  }
  return { entryId };
}

// ---- задача истечения партий (K15 §2): при batch_ttl_days = null ничего не делает

/** Один проход: клиенты с партиями, срок которых наступил, – по одной транзакции (openAccount списывает loyalty.expire). */
export async function expireBatches(pool: { connect(): Promise<pg.PoolClient> }, clock: Clock = systemClock, limit = 100): Promise<number> {
  const now = clock.now();
  const c = await pool.connect();
  let clients: string[];
  try {
    const ttl = (await resolveSetting(c, 'loyalty.batch_ttl_days', { network: true }, now)).value;
    if (ttl === null) return 0;
    clients = (
      await c.query<{ client_id: string }>(
        `SELECT DISTINCT client_id FROM app.loyalty_batches WHERE status IN ('active','depleted') AND expires_at IS NOT NULL AND expires_at <= $1 LIMIT $2`,
        [now, limit],
      )
    ).rows.map((r) => r.client_id);
  } finally {
    c.release();
  }
  for (const clientId of clients) {
    const tx = await pool.connect();
    try {
      await tx.query('BEGIN');
      await openAccount(tx, clientId, now);
      await tx.query('COMMIT');
    } catch (err) {
      await tx.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      tx.release();
    }
  }
  return clients.length;
}

/** Задача истечения раз в intervalMs (worker.ts); таймер unref – процесс держат соединения. */
export function startLoyaltyExpiry(opts: { pool: { connect(): Promise<pg.PoolClient> }; clock?: Clock; intervalMs?: number; onError?: (err: unknown) => void }): { stop(): void } {
  let busy = false;
  const t = setInterval(() => {
    if (busy) return;
    busy = true;
    expireBatches(opts.pool, opts.clock)
      .catch((err: unknown) => opts.onError?.(err))
      .finally(() => {
        busy = false;
      });
  }, opts.intervalMs ?? 600_000);
  t.unref();
  return { stop: () => clearInterval(t) };
}

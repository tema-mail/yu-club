// Публичные функции модуля notifications (S1-15, подписочная часть; K9 §ЛК, K14).
// Подписка Web Push: endpoint – персональные данные (адрес браузера), в аудит идёт только хост; ключи – никогда.
// Endpoint принимается только от известных push-сервисов: иначе сервер слал бы POST на любой адрес (SSRF).
// Настройки «Напоминания»/«Реклама» (09 §5): таблица client_notification_prefs и журнал согласий – из 0105;
// включение рекламы = согласие с версией текста (09 §5.1); сервисные сообщения не выключаются (09 §5.3).
import type pg from 'pg';
import { writeAudit, type AuditRequestMeta, type Tx } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { idempotencyScope, runIdempotent, type IdempotentResult } from '../../core/idempotency.ts';
import { publish } from '../../core/outbox.ts';
import { type Clock } from '../../core/time.ts';
import { getNotificationPrefs, withTx, type Pool } from '../clients/index.ts';
import { skipRemindersForClient } from './reminders.ts';
import { fromB64url, maskEndpoint } from './webpush.ts';

declare module '../../core/outbox.ts' {
  interface EventRegistry {
    'client.notification_prefs_changed': { clientId: string; remindersEnabled: boolean; marketingEnabled: boolean };
  }
}

/** Push-сервисы браузеров (Chrome/Edge/Opera – FCM, Firefox – Mozilla, Safari – Apple, старый Edge – WNS). '*.' – поддомены. */
export const DEFAULT_PUSH_HOSTS: readonly string[] = [
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'push.services.mozilla.com',
  '*.push.apple.com',
  '*.notify.windows.com',
];

/** Активных подписок у клиента не больше – лишние (старые) гасятся: каждое сообщение уходит на все. */
export const MAX_ACTIVE_SUBSCRIPTIONS = 10;
export const MARKETING_DOCUMENT_VERSION = 'marketing-2026-11';

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent?: string | undefined;
}

function hostAllowed(host: string, allowed: readonly string[]): boolean {
  return allowed.some((p) => (p.startsWith('*.') ? host.endsWith(p.slice(1)) && host.length > p.length - 1 : host === p));
}

/** Проверка подписки до записи. http:// – только для 127.0.0.1/localhost из списка (тестовый приёмник стенда). */
export function validateSubscription(input: PushSubscriptionInput, allowedHosts: readonly string[]): void {
  let url: URL;
  try {
    url = new URL(input.endpoint);
  } catch {
    throw new AppError('VALIDATION_FAILED', 400, 'Неверный адрес подписки', { field: 'endpoint' });
  }
  if (input.endpoint.length > 2048 || url.username || url.password) {
    throw new AppError('VALIDATION_FAILED', 400, 'Неверный адрес подписки', { field: 'endpoint' });
  }
  const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  // https – только стандартный порт (URL нормализует :443 в ''): иначе внутренние сервисы на нестандартных портах.
  const httpsOk = url.protocol === 'https:' && url.port === '';
  if (!hostAllowed(url.hostname, allowedHosts) || !(httpsOk || (local && url.protocol === 'http:'))) {
    throw new AppError('PUSH_ENDPOINT_NOT_ALLOWED', 422, 'Этот браузер не поддерживается для уведомлений', { host: url.hostname });
  }
  try {
    const p = fromB64url(input.keys.p256dh, 65, 'p256dh');
    fromB64url(input.keys.auth, 16, 'auth');
    if (p[0] !== 0x04) throw new Error('p256dh');
  } catch {
    throw new AppError('VALIDATION_FAILED', 400, 'Неверные ключи подписки', { field: 'keys' });
  }
}

interface SubRow {
  id: string;
  client_id: string;
  session_id: string | null;
  p256dh: string;
  auth: string;
  revoked_at: Date | null;
}

/** POST подписки. Повтор той же подписки – без изменений (created=false). Тот же endpoint у другого клиента – переносится. */
export async function savePushSubscription(
  pool: Pool,
  clock: Clock,
  session: { clientId: string; sessionId: string },
  input: PushSubscriptionInput,
  allowedHosts: readonly string[],
  meta: AuditRequestMeta,
): Promise<{ id: string; created: boolean }> {
  validateSubscription(input, allowedHosts);
  const { clientId, sessionId } = session;
  return withTx(pool, async (tx) => {
    const now = clock.now();
    // Блокировка клиента сериализует параллельные подписки одного клиента (лимит MAX_ACTIVE_SUBSCRIPTIONS).
    await tx.query('SELECT 1 FROM app.clients WHERE id = $1 FOR UPDATE', [clientId]);
    const prev = (
      await tx.query<SubRow>('SELECT id, client_id, session_id, p256dh, auth, revoked_at FROM app.push_subscriptions WHERE endpoint = $1 FOR UPDATE', [input.endpoint])
    ).rows[0];
    if (prev && prev.client_id === clientId && !prev.revoked_at && prev.p256dh === input.keys.p256dh && prev.auth === input.keys.auth) {
      // То же устройство после нового входа: подписка переезжает на текущую сессию (выход из неё её погасит).
      if (prev.session_id !== sessionId) {
        await tx.query('UPDATE app.push_subscriptions SET session_id = $2, updated_at = $3 WHERE id = $1', [prev.id, sessionId, clock.now()]);
      }
      return { id: prev.id, created: false };
    }
    const ua = input.userAgent ? input.userAgent.slice(0, 512) : null;
    const r = await tx.query<{ id: string }>(
      `INSERT INTO app.push_subscriptions (client_id, session_id, endpoint, p256dh, auth, user_agent, created_at, updated_at)
       VALUES ($1, $7, $2, $3, $4, $5, $6, $6)
       ON CONFLICT (endpoint) DO UPDATE SET client_id = EXCLUDED.client_id, session_id = EXCLUDED.session_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
         user_agent = EXCLUDED.user_agent, updated_at = EXCLUDED.updated_at, revoked_at = NULL, revoke_reason = NULL, last_error = NULL
       RETURNING id`,
      [clientId, input.endpoint, input.keys.p256dh, input.keys.auth, ua, now, sessionId],
    );
    const id = r.rows[0]!.id;
    const extra = await tx.query<{ id: string }>(
      `UPDATE app.push_subscriptions SET revoked_at = $3, revoke_reason = 'unsubscribed', updated_at = $3
       WHERE id IN (SELECT id FROM app.push_subscriptions WHERE client_id = $1 AND revoked_at IS NULL AND id <> $2
                    ORDER BY updated_at DESC OFFSET $4)
       RETURNING id`,
      [clientId, id, now, MAX_ACTIVE_SUBSCRIPTIONS - 1],
    );
    await writeAudit(
      tx,
      meta,
      {
        action: 'notification.push_subscribed',
        object: { type: 'client', id: clientId },
        after: { endpoint: maskEndpoint(input.endpoint), transferred: Boolean(prev && prev.client_id !== clientId), evicted: extra.rowCount ?? 0 },
      },
      clock,
    );
    return { id, created: !prev };
  });
}

/** DELETE по endpoint (тело запроса, не URL – адрес браузера не попадает в журнал запросов): только своя активная. */
export async function removePushSubscriptionByEndpoint(pool: Pool, clock: Clock, clientId: string, endpoint: string, meta: AuditRequestMeta): Promise<boolean> {
  const r = await pool.query<{ id: string }>(
    'SELECT id FROM app.push_subscriptions WHERE endpoint = $1 AND client_id = $2 AND revoked_at IS NULL',
    [endpoint, clientId],
  );
  const id = r.rows[0]?.id;
  return id ? removePushSubscriptionById(pool, clock, clientId, id, meta) : false;
}

/** DELETE подписки (K9 /me/push-subscriptions/{id}): только своей и активной; повтор и чужая – false (ответ всё равно 204). */
export async function removePushSubscriptionById(pool: Pool, clock: Clock, clientId: string, id: string, meta: AuditRequestMeta): Promise<boolean> {
  return withTx(pool, async (tx) => {
    const now = clock.now();
    const r = await tx.query<{ endpoint: string }>(
      `UPDATE app.push_subscriptions SET revoked_at = $3, revoke_reason = 'unsubscribed', updated_at = $3
       WHERE id = $1 AND client_id = $2 AND revoked_at IS NULL RETURNING endpoint`,
      [id, clientId, now],
    );
    const row = r.rows[0];
    if (!row) return false;
    await writeAudit(
      tx,
      meta,
      { action: 'notification.push_unsubscribed', object: { type: 'client', id: clientId }, after: { endpoint: maskEndpoint(row.endpoint), reason: 'unsubscribed' } },
      clock,
    );
    return true;
  });
}

/** Выход из ЛК (K9 №3): подписки, сохранённые из этой сессии → revoked('logout'). Другие устройства клиента не трогаем.
 *  Вызывается из clients.logoutClient в той же транзакции. */
export async function revokeSessionSubscriptions(tx: Tx, sessionId: string, now: Date): Promise<number> {
  const r = await tx.query(
    `UPDATE app.push_subscriptions SET revoked_at = $2, revoke_reason = 'logout', updated_at = $2 WHERE session_id = $1 AND revoked_at IS NULL`,
    [sessionId, now],
  );
  return r.rowCount ?? 0;
}

export interface NotificationSettingsDto {
  remindersEnabled: boolean;
  marketingEnabled: boolean;
  /** Сервисные (подтверждение, перенос, отмена клубом) приходят всегда – для подписи в ЛК (09 §5.3). */
  serviceAlwaysOn: true;
  pushSubscriptions: number;
}

export async function getNotificationSettings(db: Tx, clientId: string): Promise<NotificationSettingsDto> {
  const prefs = await getNotificationPrefs(db, clientId);
  const n = await db.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM app.push_subscriptions WHERE client_id = $1 AND revoked_at IS NULL',
    [clientId],
  );
  return { ...prefs, serviceAlwaysOn: true, pushSubscriptions: n.rows[0]?.n ?? 0 };
}

export const SETTINGS_ROUTE = 'PUT /api/public/v1/me/notification-settings';

/**
 * PUT настроек (Idempotency-Key). Изменённая настройка → строка journal.client_consents (kind reminders / marketing),
 * аудит client.notification_prefs_changed, событие K4. Выключение напоминаний сразу гасит запланированные (09 §5.4).
 */
export async function updateNotificationSettings(
  pool: Pool,
  clock: Clock,
  clientId: string,
  input: { remindersEnabled: boolean; marketingEnabled: boolean; documentVersion?: string | undefined },
  idempotencyKey: string,
  meta: AuditRequestMeta,
): Promise<IdempotentResult> {
  return withTx(pool, async (tx: pg.PoolClient) =>
    runIdempotent(
      tx,
      { scope: idempotencyScope('client', clientId, SETTINGS_ROUTE), key: idempotencyKey, request: { route: SETTINGS_ROUTE, body: input }, clock },
      async () => {
        const now = clock.now();
        await tx.query('SELECT 1 FROM app.clients WHERE id = $1 FOR UPDATE', [clientId]);
        const before = await getNotificationPrefs(tx, clientId);
        const after = { remindersEnabled: input.remindersEnabled, marketingEnabled: input.marketingEnabled };
        await tx.query(
          `INSERT INTO app.client_notification_prefs (client_id, reminders_enabled, marketing_enabled, updated_at) VALUES ($1, $2, $3, $4)
           ON CONFLICT (client_id) DO UPDATE SET reminders_enabled = EXCLUDED.reminders_enabled, marketing_enabled = EXCLUDED.marketing_enabled,
             updated_at = EXCLUDED.updated_at`,
          [clientId, after.remindersEnabled, after.marketingEnabled, now],
        );
        const changes: Array<['reminders' | 'marketing', boolean]> = [];
        if (before.remindersEnabled !== after.remindersEnabled) changes.push(['reminders', after.remindersEnabled]);
        if (before.marketingEnabled !== after.marketingEnabled) changes.push(['marketing', after.marketingEnabled]);
        for (const [kind, granted] of changes) {
          const version = kind === 'marketing' && granted ? (input.documentVersion ?? MARKETING_DOCUMENT_VERSION).slice(0, 64) : null;
          await tx.query(
            `INSERT INTO journal.client_consents (client_id, kind, granted, document_version, source, at, actor_type, actor_id)
             VALUES ($1, $2, $3, $4, 'account', $5, 'client', $1)`,
            [clientId, kind, granted, version, now],
          );
          await writeAudit(
            tx,
            meta,
            { action: 'client.consent_changed', object: { type: 'client', id: clientId }, after: { kind, granted, documentVersion: version } },
            clock,
          );
        }
        if (changes.length > 0) {
          await writeAudit(tx, meta, { action: 'client.notification_prefs_changed', object: { type: 'client', id: clientId }, before, after }, clock);
          await publish(tx, {
            type: 'client.notification_prefs_changed',
            aggregateType: 'client',
            aggregateId: clientId,
            aggregateVersion: now.getTime(),
            branchId: null,
            payload: { clientId, ...after },
            occurredAt: now,
          });
          if (before.remindersEnabled && !after.remindersEnabled) await skipRemindersForClient(tx, clientId, now);
        }
        return { status: 200, body: await getNotificationSettings(tx, clientId) };
      },
    ),
  );
}

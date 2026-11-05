// K21 §4, §11 №205–206: отписка от рекламы по ссылке без входа. Токен = base64url(JSON [clientId, campaignId, exp]) + '.' + HMAC-SHA256
// на UNSUBSCRIBE_SECRET, срок 90 дней. GET ничего не меняет (предзагрузка ссылок не отписывает) и не раскрывает имя и телефон;
// согласие меняет только POST. Повтор – тот же ответ без новых записей журнала. Подпись сверяется в постоянное время.
// Журнал: client_consents(marketing, granted=false, source='site'); что это отписка по ссылке – в аудите (D4-04).
import { createHmac, timingSafeEqual } from 'node:crypto';
import { writeAudit, type AuditRequestMeta, type Db } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { publish } from '../../core/outbox.ts';
import type { Clock } from '../../core/time.ts';
import { withTx, type Pool } from '../clients/index.ts';

export const UNSUBSCRIBE_TTL_MS = 90 * 86_400_000;
export const UNSUBSCRIBE_MIN_SECRET = 32;

export interface UnsubscribeClaims {
  clientId: string;
  campaignId: string | null;
  /** Секунды эпохи. */
  exp: number;
}

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64url');
const sign = (secret: string, payload: string) => createHmac('sha256', secret).update(payload).digest();
const invalid = () => new AppError('UNSUBSCRIBE_TOKEN_INVALID', 400, 'Ссылка отписки недействительна');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function signUnsubscribeToken(secret: string, c: UnsubscribeClaims): string {
  const payload = b64(JSON.stringify([c.clientId, c.campaignId, c.exp]));
  return `${payload}.${sign(secret, payload).toString('base64url')}`;
}

/** Адрес страницы отписки для payload push (K21 §4). */
export function unsubscribeUrl(secret: string, clientId: string, campaignId: string | null, now: Date): string {
  const exp = Math.floor((now.getTime() + UNSUBSCRIBE_TTL_MS) / 1000);
  return `/unsubscribe/?t=${signUnsubscribeToken(secret, { clientId, campaignId, exp })}`;
}

/** Подпись → срок: поддельный – 400, подлинный просроченный – 410 (страница предлагает войти). */
export function verifyUnsubscribeToken(secret: string, token: string, now: Date): UnsubscribeClaims {
  const [payload, mac, extra] = String(token).split('.');
  if (!payload || !mac || extra !== undefined || token.length > 512) throw invalid();
  const expected = sign(secret, payload);
  const got = Buffer.from(mac, 'base64url');
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) throw invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  if (!Array.isArray(parsed) || parsed.length !== 3) throw invalid();
  const [clientId, campaignId, exp] = parsed as [unknown, unknown, unknown];
  if (typeof clientId !== 'string' || !UUID_RE.test(clientId) || (campaignId !== null && typeof campaignId !== 'string') || typeof exp !== 'number') throw invalid();
  if (exp * 1000 <= now.getTime()) throw new AppError('UNSUBSCRIBE_TOKEN_EXPIRED', 410, 'Срок ссылки истёк, войдите в кабинет и выключите рекламу в настройках');
  return { clientId, campaignId, exp };
}

const notConfigured = () => new AppError('MARKETING_NOT_CONFIGURED', 503, 'Отписка по ссылке не настроена');

/** №205: только чтение. Состояние – без имени и телефона. */
export async function checkUnsubscribe(db: Db, secret: string | null, token: string, now: Date): Promise<{ valid: true; marketingEnabled: boolean }> {
  if (!secret) throw notConfigured();
  const c = verifyUnsubscribeToken(secret, token, now);
  const r = await db.query<{ marketing_enabled: boolean }>('SELECT marketing_enabled FROM app.client_notification_prefs WHERE client_id = $1', [c.clientId]);
  return { valid: true, marketingEnabled: r.rows[0]?.marketing_enabled ?? false };
}

/** №206: отказ немедленно (38-ФЗ ст. 18 ч. 1). Запланированные гасятся повторной проверкой в send (K21 §4). Повтор – без записей. */
export async function applyUnsubscribe(pool: Pool, clock: Clock, secret: string | null, token: string, request: { requestId: string; ip?: string | undefined }): Promise<{ marketingEnabled: false }> {
  if (!secret) throw notConfigured();
  const now = clock.now();
  const c = verifyUnsubscribeToken(secret, token, now);
  return withTx(pool, async (tx) => {
    const client = await tx.query('SELECT 1 FROM app.clients WHERE id = $1 FOR UPDATE', [c.clientId]);
    if (!client.rowCount) throw invalid();
    const prefs = (await tx.query<{ reminders_enabled: boolean; marketing_enabled: boolean }>('SELECT reminders_enabled, marketing_enabled FROM app.client_notification_prefs WHERE client_id = $1', [c.clientId])).rows[0];
    if (!prefs?.marketing_enabled) return { marketingEnabled: false as const };
    await tx.query('UPDATE app.client_notification_prefs SET marketing_enabled = false, updated_at = $2 WHERE client_id = $1', [c.clientId, now]);
    await tx.query(
      `INSERT INTO journal.client_consents (client_id, kind, granted, document_version, source, at, actor_type, actor_id) VALUES ($1, 'marketing', false, NULL, 'site', $2, 'client', $1)`,
      [c.clientId, now],
    );
    const meta: AuditRequestMeta = { actor: { kind: 'client', clientId: c.clientId, sessionId: 'unsubscribe' }, source: 'site', requestId: request.requestId, ...(request.ip ? { ip: request.ip } : {}) };
    await writeAudit(tx, meta, { action: 'notification.unsubscribed', object: { type: 'client', id: c.clientId }, after: { via: 'unsubscribe_link', campaignId: c.campaignId } }, clock);
    await publish(tx, {
      type: 'client.notification_prefs_changed',
      aggregateType: 'client',
      aggregateId: c.clientId,
      aggregateVersion: now.getTime(),
      branchId: null,
      payload: { clientId: c.clientId, remindersEnabled: prefs.reminders_enabled, marketingEnabled: false },
      occurredAt: now,
    });
    return { marketingEnabled: false as const };
  });
}

/** Ограничение K21 §11: 10 запросов в минуту с IP на процесс API (окно фиксированной минуты). 11-й → 429 RATE_LIMITED. */
export function unsubscribeRateLimiter(clock: Clock, limit = 10): (ip: string) => void {
  const hits = new Map<string, { minute: number; n: number }>();
  return (ip) => {
    const nowMs = clock.now().getTime();
    const minute = Math.floor(nowMs / 60_000);
    if (hits.size > 10_000) hits.clear();
    const h = hits.get(ip);
    const n = h && h.minute === minute ? h.n + 1 : 1;
    hits.set(ip, { minute, n });
    if (n > limit) throw new AppError('RATE_LIMITED', 429, 'Слишком много запросов, попробуйте позже', { retryAfterSec: Math.ceil((minute + 1) * 60 - nowMs / 1000) });
  };
}

// K9 «Обезличивание» (152-ФЗ, 03 §13, Q-91 по умолчанию, техдолг 4.6): одна транзакция вызывающего.
// Затирает ПДн карточки и технические следы входа (сессии, push-подписки, коды входа), выключает рассылки,
// пишет отказ от согласий в журнал (только вставка), ставит статус anonymized. Деньги, брони, баллы, сертификаты
// и журналы только на вставку не трогаются – связь по client_id остаётся (03 §13: «финансовые операции нельзя удалять»).
// ПДн в таблицах других модулей затирают их обработчики (registerClientAnonymizer, как ворота записи K9 S2-33):
// регистрирует server.ts при старте; без любого из обязательных процедура не запускается (fail closed).
// Повторный вызов на обезличенной карточке – тот же ответ, ничего не пишет (идемпотентность).
// Решения, которых нет в K9, – docs/reshenia.md D4-60…D4-64.
import { writeAudit, type AuditRequestMeta, type Tx } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { systemClock, type Clock } from '../../core/time.ts';
import { creatorOf, type ClientStatus } from './index.ts';

/** Основание (решение D4-61): только код – свободный текст сотрудника мог бы унести ПДн в аудит. */
export const ANONYMIZE_REASONS = ['client_request', 'retention_expired'] as const;
export type AnonymizeReason = (typeof ANONYMIZE_REASONS)[number];

/** Обработчик модуля-владельца таблиц с ПДн клиента. blockers – сколько живых записей мешает (бронь впереди,
 *  мероприятие в работе); run – затирает ПДн и возвращает число затронутых строк. Оба – в транзакции процедуры. */
export interface ClientAnonymizer {
  name: string;
  /** Замки модуля ДО строки клиента (D5-08: мероприятие → клиент, как events.ts и слияние) – иначе взаимоблокировка. */
  prelock?(tx: Tx, clientId: string): Promise<void>;
  blockers?(tx: Tx, clientId: string, now: Date): Promise<number>;
  run(tx: Tx, clientId: string, now: Date): Promise<number>;
}

/** Модули, у которых есть ПДн клиента или живые записи с ним (K20 §14, K21 §15, K5). */
export const REQUIRED_CLIENT_ANONYMIZERS = ['booking', 'events', 'notifications'] as const;

const anonymizers = new Map<string, ClientAnonymizer>();

/** Повторная регистрация того же имени заменяет обработчик (сервер в тестах собирается многократно). */
export function registerClientAnonymizer(a: ClientAnonymizer): void {
  anonymizers.set(a.name, a);
}

/** Только для тестов. */
export function clearClientAnonymizers(): void {
  anonymizers.clear();
}

export interface AnonymizeResult {
  clientId: string;
  status: 'anonymized';
  alreadyAnonymized: boolean;
  /** Строк затронуто обработчиками модулей; пусто при повторе. */
  affected: Record<string, number>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function anonymizeClient(
  tx: Tx,
  clientId: string,
  input: { reason: AnonymizeReason },
  meta: AuditRequestMeta,
  clock: Clock = systemClock,
): Promise<AnonymizeResult> {
  const missing = REQUIRED_CLIENT_ANONYMIZERS.filter((n) => !anonymizers.has(n));
  if (missing.length > 0) throw new Error(`anonymizeClient: не зарегистрирован обработчик модуля ${missing.join(', ')}`);
  if (!(ANONYMIZE_REASONS as readonly string[]).includes(input.reason)) {
    throw new AppError('VALIDATION_FAILED', 400, 'Неверное основание обезличивания', { field: 'reason', allowed: ANONYMIZE_REASONS });
  }
  if (!UUID_RE.test(clientId)) throw new AppError('NOT_FOUND', 404, 'Не найдено');

  const list = [...anonymizers.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const a of list) if (a.prelock) await a.prelock(tx, clientId);
  const cur = await tx.query<{ status: ClientStatus; phone_e164: string | null; merged_into_id: string | null }>(
    'SELECT status, phone_e164, merged_into_id FROM app.clients WHERE id = $1 FOR UPDATE',
    [clientId],
  );
  const row = cur.rows[0];
  if (!row) throw new AppError('NOT_FOUND', 404, 'Не найдено');
  if (row.status === 'anonymized') return { clientId, status: 'anonymized', alreadyAnonymized: true, affected: {} };
  // Объединённая карточка (0450) уже без ПДн; её данные живут в основной – обезличивать нужно основную.
  if (row.status === 'merged') {
    throw new AppError('CLIENT_MERGED', 409, 'Карточка объединена – обезличьте основную', { clientId, mergedIntoId: row.merged_into_id });
  }

  const now = clock.now();
  const blockers: Record<string, number> = {};
  for (const a of list) {
    const n = a.blockers ? await a.blockers(tx, clientId, now) : 0;
    if (n > 0) blockers[a.name] = n;
  }
  if (Object.keys(blockers).length > 0) {
    throw new AppError('CLIENT_HAS_ACTIVE_RECORDS', 409, 'Сначала завершите или отмените живые брони и мероприятия клиента', { blockers });
  }

  await tx.query(
    `UPDATE app.clients SET phone_e164 = NULL, phone_verified_at = NULL, first_name = NULL, last_name = NULL, email = NULL,
       birth_date = NULL, status = 'anonymized', status_reason = NULL, status_until = NULL, row_version = row_version + 1
     WHERE id = $1`,
    [clientId],
  );
  // Технические следы: устройство (user agent), адрес браузера (endpoint), IP и телефон кода входа – тоже ПДн.
  // revoke_reason – из существующих CHECK 0106/0111 (решение D4-62): blocked / unsubscribed.
  await tx.query(
    `UPDATE app.client_sessions SET revoked_at = coalesce(revoked_at, $2), revoke_reason = coalesce(revoke_reason, 'blocked'), user_agent = NULL
     WHERE client_id = $1`,
    [clientId, now],
  );
  await tx.query(
    `UPDATE app.push_subscriptions SET endpoint = 'https://anonymized.invalid/' || id, user_agent = NULL, last_error = NULL,
       revoked_at = coalesce(revoked_at, $2), revoke_reason = coalesce(revoke_reason, 'unsubscribed'), updated_at = $2
     WHERE client_id = $1`,
    [clientId, now],
  );
  if (row.phone_e164) await tx.query('DELETE FROM app.client_otp_challenges WHERE phone_e164 = $1', [row.phone_e164]);
  await tx.query(
    `INSERT INTO app.client_notification_prefs (client_id, reminders_enabled, marketing_enabled, updated_at) VALUES ($1, false, false, $2)
     ON CONFLICT (client_id) DO UPDATE SET reminders_enabled = false, marketing_enabled = false, updated_at = $2`,
    [clientId, now],
  );
  const by = creatorOf(meta);
  await tx.query(
    `INSERT INTO journal.client_consents (client_id, kind, granted, source, at, actor_type, actor_id)
     SELECT $1, k, false, 'crm', $2, $3, $4 FROM unnest(ARRAY['pd_processing','marketing','reminders']) AS k`,
    [clientId, now, by.type, by.id],
  );

  const affected: Record<string, number> = {};
  for (const a of list) affected[a.name] = await a.run(tx, clientId, now);

  await writeAudit(
    tx,
    meta,
    {
      action: 'client.status_changed',
      object: { type: 'client', id: clientId },
      before: { status: row.status },
      after: { status: 'anonymized', affected },
      reason: input.reason,
    },
    clock,
  );
  return { clientId, status: 'anonymized', alreadyAnonymized: false, affected };
}

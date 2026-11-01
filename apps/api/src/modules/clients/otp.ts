// K9 (S1-12). Вход клиента по одноразовому коду (R-18: телефон + SMS через адаптер), согласие на ПДн, сессия.
// Правила:
//  - ответ на запрос кода одинаков, есть аккаунт или нет: запрос вообще не читает таблицу клиентов (03 §5.2);
//  - новый код гасит прежний (superseded_at); лимиты – пауза между кодами, коды на номер и на IP за час;
//  - код – 6 цифр crypto.randomInt; в базе только HMAC; в аудит, логи и ответы код не попадает;
//  - неверный код → OTP_INVALID с attemptsLeft; попытки кончились / истёк / заменён → OTP_EXPIRED;
//  - карточки нет → создаётся active; guest → active без второй карточки (Q-09); повторная регистрация = вход;
//  - новому клиенту (и guest) без согласия на ПДн → CONSENT_REQUIRED, код не гасится; согласие – запись
//    journal.client_consents с версией текста и временем из Clock;
//  - сессия: 32 случайных байта в куке yu_client, в базе HMAC (как K12).
// Числа по умолчанию – K7 client.*; чтение из настроек (core/settings) подключится вместе с модулем настроек.
import { createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { writeAudit, type AuditRequestMeta, type Db, type Tx } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { claimKey, idempotencyScope, requestHash, saveResponse, type IdempotentResult } from '../../core/idempotency.ts';
import type { Clock } from '../../core/time.ts';
import { getNotificationPrefs, maskPhone, normalizePhone, withTx, type ClientStatus, type Pool } from './index.ts';

// ---- адаптер SMS (ADR 0001)

export type SmsResult = { status: 'accepted'; providerMessageId: string } | { status: 'rejected'; reason: string } | { status: 'unknown' };

export interface SmsSender {
  send(input: { phoneE164: string; text: string; idempotencyKey: string }): Promise<SmsResult>;
}

export interface DevSmsSender extends SmsSender {
  /** Отправленное – для тестов и стенда. Только в памяти процесса. */
  readonly sent: Array<{ phoneE164: string; text: string; idempotencyKey: string }>;
}

/** Тестовый адаптер: сообщение остаётся в памяти и (если дан log) пишется в лог стенда.
 *  В production не создаётся – там код в лог попасть не может. */
export function createDevSmsSender(env: string, log?: (line: string) => void): DevSmsSender {
  if (env === 'production') throw new Error('SMS: тестовый адаптер запрещён в production (K9)');
  const sent: DevSmsSender['sent'] = [];
  return {
    sent,
    async send(input) {
      sent.push(input);
      log?.(`[sms:dev] ${maskPhone(input.phoneE164)}: ${input.text}`);
      return { status: 'accepted', providerMessageId: `dev-${input.idempotencyKey}` };
    },
  };
}

/** Боевой адаптер – заготовка: провайдер не выбран (R-18). Каждое сообщение отклоняется → 503 SMS_UNAVAILABLE.
 *  Реализация провайдера: тот же интерфейс, idempotencyKey = challengeId (без двойной отправки). */
export const unconfiguredSmsSender: SmsSender = {
  async send() {
    return { status: 'rejected', reason: 'provider_not_configured' };
  },
};

// ---- настройки

export interface ClientAuthConfig {
  sessionPepper: string;
  otpTtlSeconds: number; // K7 client.otp_ttl_seconds
  otpMaxAttempts: number; // K7 client.otp_max_attempts
  resendCooldownSeconds: number; // K7 client.otp_resend_cooldown_seconds
  maxPerPhonePerHour: number; // K7 client.otp_max_per_phone_per_hour
  maxPerIpPerHour: number; // решение: в K7 ключа нет, защита от перебора номеров с одного адреса
  sessionDays: number; // K7 client.session_days
  consentDocumentVersion: string; // версия текста согласия на ПДн, если сайт её не прислал
}

export function clientAuthConfig(sessionPepper: string, overrides: Partial<ClientAuthConfig> = {}): ClientAuthConfig {
  if (sessionPepper.length < 32) throw new Error('SESSION_PEPPER: нужно не короче 32 символов');
  return {
    sessionPepper,
    otpTtlSeconds: 300,
    otpMaxAttempts: 5,
    resendCooldownSeconds: 60,
    maxPerPhonePerHour: 5,
    maxPerIpPerHour: 30,
    sessionDays: 30,
    consentDocumentVersion: 'pd-2026-11',
    ...overrides,
  };
}

export interface ClientReqInfo {
  requestId: string;
  ip?: string | undefined;
  userAgent?: string | undefined;
}

const SEC = 1000;
const HOUR = 3600 * SEC;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const hmac = (pepper: string, value: string) => createHmac('sha256', pepper).update(value).digest('hex');
/** Код привязан к своему запросу: одинаковые коды разных запросов дают разный хеш. */
const codeHash = (pepper: string, challengeId: string, code: string) => hmac(pepper, `otp:${challengeId}:${code}`);
export const clientTokenHash = (pepper: string, token: string) => hmac(pepper, token);

function visitorMeta(req: ClientReqInfo): AuditRequestMeta {
  const m: AuditRequestMeta = { actor: { kind: 'visitor', visitorId: 'client-login' }, source: 'site', requestId: req.requestId };
  if (req.ip !== undefined) m.ip = req.ip;
  return m;
}

function clientMeta(req: ClientReqInfo, clientId: string, sessionId: string): AuditRequestMeta {
  const m: AuditRequestMeta = { actor: { kind: 'client', clientId, sessionId }, source: 'site', requestId: req.requestId };
  if (req.ip !== undefined) m.ip = req.ip;
  return m;
}

// ---- запрос кода (K9 №1)

export const OTP_REQUEST_ROUTE = 'POST /api/public/v1/auth/otp/request';

function rateLimited(resendAfterSec: number): AppError {
  return new AppError('OTP_RATE_LIMITED', 429, 'Слишком много запросов кода, попробуйте позже', {
    resendAfterSec: Math.max(1, Math.ceil(resendAfterSec)),
  });
}

/** Ответ 202 { challengeId, resendAfterSec, expiresInSec } – одинаковый для любого номера.
 *  Идемпотентность (ADR 0004): ключ захватывается вместе с созданием запроса кода, ответ сохраняется после
 *  отправки SMS – повтор с тем же ключом не шлёт второе сообщение и получает тот же ответ (в т.ч. 503). */
export async function requestOtp(
  pool: Pool,
  cfg: ClientAuthConfig,
  clock: Clock,
  sms: SmsSender,
  input: { phone: string; idempotencyKey: string },
  req: ClientReqInfo,
): Promise<IdempotentResult> {
  const phone = normalizePhone(input.phone);
  const now = clock.now();
  const key = { scope: idempotencyScope('anonymous', 'otp', 'auth.otp.request'), key: input.idempotencyKey };
  const hash = requestHash({ route: OTP_REQUEST_ROUTE, body: { phone, purpose: 'login' } });

  const created = await withTx(pool, async (tx) => {
    const claim = await claimKey(tx, { ...key, requestHash: hash, now });
    if (claim.kind === 'replay') return { kind: 'replay', response: claim.response } as const;
    // Запросы одного номера – по очереди: лимиты и «один живой код» без гонок.
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 7204513))', [`otp:${phone}`]);
    const hourAgo = new Date(now.getTime() - HOUR);
    const byPhone = await tx.query<{ created_at: Date }>(
      'SELECT created_at FROM app.client_otp_challenges WHERE phone_e164 = $1 AND created_at > $2 ORDER BY created_at',
      [phone, hourAgo],
    );
    const last = byPhone.rows.at(-1);
    if (last) {
      const wait = cfg.resendCooldownSeconds * SEC - (now.getTime() - last.created_at.getTime());
      if (wait > 0) throw rateLimited(wait / SEC);
    }
    if (byPhone.rows.length >= cfg.maxPerPhonePerHour) {
      const oldest = byPhone.rows[byPhone.rows.length - cfg.maxPerPhonePerHour]!;
      throw rateLimited((oldest.created_at.getTime() + HOUR - now.getTime()) / SEC);
    }
    if (req.ip !== undefined) {
      const byIp = await tx.query<{ created_at: Date }>(
        'SELECT created_at FROM app.client_otp_challenges WHERE ip = $1 AND created_at > $2 ORDER BY created_at DESC LIMIT $3',
        [req.ip, hourAgo, cfg.maxPerIpPerHour],
      );
      if (byIp.rows.length >= cfg.maxPerIpPerHour) {
        throw rateLimited((byIp.rows.at(-1)!.created_at.getTime() + HOUR - now.getTime()) / SEC);
      }
    }
    await tx.query(
      `UPDATE app.client_otp_challenges SET superseded_at = $2
       WHERE phone_e164 = $1 AND consumed_at IS NULL AND superseded_at IS NULL`,
      [phone, now],
    );
    const challengeId = randomUUID();
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await tx.query(
      `INSERT INTO app.client_otp_challenges (id, phone_e164, code_hash, expires_at, max_attempts, ip, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [challengeId, phone, codeHash(cfg.sessionPepper, challengeId, code), new Date(now.getTime() + cfg.otpTtlSeconds * SEC), cfg.otpMaxAttempts, req.ip ?? null, now],
    );
    return { kind: 'created', challengeId, code } as const;
  });
  if (created.kind === 'replay') return { ...created.response, replayed: true };

  // Отправка – вне транзакции: сеть провайдера не держит блокировки базы. Текст без имени клиента (K9).
  let result: SmsResult;
  try {
    result = await sms.send({
      phoneE164: phone,
      text: `Код для входа: ${created.code}. Никому его не сообщайте.`,
      idempotencyKey: created.challengeId,
    });
  } catch {
    result = { status: 'unknown' };
  }
  const response =
    result.status === 'accepted'
      ? { status: 202, body: { challengeId: created.challengeId, resendAfterSec: cfg.resendCooldownSeconds, expiresInSec: cfg.otpTtlSeconds } }
      : {
          status: 503,
          body: {
            error: {
              code: 'SMS_UNAVAILABLE',
              message: 'Не удалось отправить код, попробуйте позже',
              details: { resendAfterSec: cfg.resendCooldownSeconds },
            },
          },
        };
  const saved = await withTx(pool, (tx) => saveResponse(tx, key, response));
  return { ...saved, replayed: false };
}

// ---- проверка кода (K9 №2)

export interface MeDto {
  id: string;
  phoneMasked: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  birthDate: string | null;
  status: 'active' | 'restricted';
  notifications: { remindersEnabled: boolean; marketingEnabled: boolean };
  loyalty: null;
  certificates: null;
}

export interface ClientLoginHooks {
  /** K5: при входе удержания посетителя (кука yu_visitor) переходят к клиенту. Реализацию даст модуль booking
   *  (S1-06/S1-08, attach). Вызывается в транзакции входа: сбой хука отменяет вход. */
  onLogin?(tx: Tx, input: { clientId: string; visitorId: string | null; at: Date }): Promise<void>;
}

export interface VerifyInput {
  challengeId: string;
  code: string;
  consents?: { pdProcessing: boolean; marketing?: boolean | undefined } | undefined;
  documentVersion?: string | undefined;
  visitorId?: string | null | undefined;
}

export interface VerifyResult {
  token: string;
  sessionId: string;
  expiresAt: Date;
  client: MeDto;
  isNew: boolean;
}

interface ChallengeRow {
  phone_e164: string;
  code_hash: string;
  expires_at: Date;
  attempts: number;
  max_attempts: number;
  consumed_at: Date | null;
  superseded_at: Date | null;
}
interface LoginClientRow {
  id: string;
  status: ClientStatus;
}

type Outcome =
  | { ok: true; result: VerifyResult }
  | { ok: false; error: AppError };

const expired = () => new AppError('OTP_EXPIRED', 410, 'Код недействителен, запросите новый');

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
}

async function hasPdConsent(tx: Tx, clientId: string): Promise<boolean> {
  const r = await tx.query<{ granted: boolean }>(
    `SELECT granted FROM journal.client_consents WHERE client_id = $1 AND kind = 'pd_processing' ORDER BY at DESC, id DESC LIMIT 1`,
    [clientId],
  );
  return r.rows[0]?.granted === true;
}

async function addConsent(
  tx: Tx,
  clock: Clock,
  meta: AuditRequestMeta,
  clientId: string,
  kind: 'pd_processing' | 'marketing',
  documentVersion: string,
): Promise<void> {
  await tx.query(
    `INSERT INTO journal.client_consents (client_id, kind, granted, document_version, source, at, actor_type, actor_id)
     VALUES ($1, $2, true, $3, 'site', $4, 'client', $1)`,
    [clientId, kind, documentVersion, clock.now()],
  );
  await writeAudit(
    tx,
    meta,
    { action: 'client.consent_changed', object: { type: 'client', id: clientId }, after: { kind, granted: true, documentVersion } },
    clock,
  );
}

/** Код → вход или регистрация. Ошибки попыток фиксируются (счётчик попыток не откатывается вместе с отказом). */
export async function verifyOtp(
  pool: Pool,
  cfg: ClientAuthConfig,
  clock: Clock,
  input: VerifyInput,
  req: ClientReqInfo,
  hooks: ClientLoginHooks = {},
): Promise<VerifyResult> {
  if (!UUID_RE.test(input.challengeId)) throw expired();
  if (!/^\d{6}$/.test(input.code)) throw new AppError('VALIDATION_FAILED', 400, 'Код – 6 цифр', { field: 'code' });
  const now = clock.now();
  const outcome = await withTx<Outcome>(pool, async (tx) => {
    const c = await tx.query<ChallengeRow>(
      `SELECT phone_e164, code_hash, expires_at, attempts, max_attempts, consumed_at, superseded_at
       FROM app.client_otp_challenges WHERE id = $1 FOR UPDATE`,
      [input.challengeId],
    );
    const ch = c.rows[0];
    if (!ch || ch.consumed_at || ch.superseded_at || ch.expires_at <= now || ch.attempts >= ch.max_attempts) {
      return { ok: false, error: expired() };
    }
    const phone = ch.phone_e164;
    if (!sameHash(ch.code_hash, codeHash(cfg.sessionPepper, input.challengeId, input.code))) {
      await tx.query('UPDATE app.client_otp_challenges SET attempts = attempts + 1 WHERE id = $1', [input.challengeId]);
      await writeAudit(
        tx,
        visitorMeta(req),
        { action: 'auth.client.login_failed', object: { type: 'client', id: null }, after: { phoneE164: phone }, reason: 'bad_code', result: 'denied' },
        clock,
      );
      const attemptsLeft = ch.max_attempts - ch.attempts - 1;
      return { ok: false, error: new AppError('OTP_INVALID', 401, 'Неверный код', { attemptsLeft }) };
    }

    const select = () =>
      tx.query<LoginClientRow>('SELECT id, status FROM app.clients WHERE phone_e164 = $1 FOR UPDATE', [phone]).then((r) => r.rows[0]);
    let client = await select();
    if (client && (client.status === 'blocked' || client.status === 'deletion_requested' || client.status === 'anonymized')) {
      await tx.query('UPDATE app.client_otp_challenges SET consumed_at = $2 WHERE id = $1', [input.challengeId, now]);
      await writeAudit(
        tx,
        visitorMeta(req),
        { action: 'auth.client.login_failed', object: { type: 'client', id: client.id }, reason: `status_${client.status}`, result: 'denied' },
        clock,
      );
      return { ok: false, error: new AppError('CLIENT_RESTRICTED', 403, 'Вход ограничен, обратитесь в клуб', { status: client.status }) };
    }
    const needsConsent = !client || client.status === 'guest' || !(await hasPdConsent(tx, client.id));
    if (needsConsent && input.consents?.pdProcessing !== true) {
      return { ok: false, error: new AppError('CONSENT_REQUIRED', 422, 'Нужно согласие на обработку персональных данных') };
    }

    let created = false;
    if (!client) {
      const ins = await tx.query<LoginClientRow>(
        `INSERT INTO app.clients (phone_e164, phone_verified_at, status, registration_source, registered_at, last_login_at,
                                  created_at, created_by_type)
         VALUES ($1, $2, 'active', 'site', $2, $2, $2, 'client')
         ON CONFLICT (phone_e164) DO NOTHING RETURNING id, status`,
        [phone, now],
      );
      created = ins.rows[0] !== undefined;
      client = ins.rows[0] ?? (await select());
      if (!client) throw new Error('verifyOtp: карточка клиента не создана и не найдена');
    }
    const clientId = client.id;
    const isNew = created || client.status === 'guest';

    const sessionToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + cfg.sessionDays * 24 * HOUR);
    const s = await tx.query<{ id: string }>(
      `INSERT INTO app.client_sessions (client_id, token_hash, created_at, last_seen_at, expires_at, user_agent)
       VALUES ($1, $2, $3, $3, $4, $5) RETURNING id`,
      [clientId, clientTokenHash(cfg.sessionPepper, sessionToken), now, expiresAt, req.userAgent ?? null],
    );
    const sessionId = s.rows[0]!.id;
    const meta = clientMeta(req, clientId, sessionId);

    if (created) {
      await writeAudit(tx, meta, { action: 'client.created', object: { type: 'client', id: clientId }, after: { status: 'active', phoneE164: phone } }, clock);
    } else if (client.status === 'guest') {
      await tx.query(
        `UPDATE app.clients SET status = 'active', registered_at = $2, registration_source = 'site', phone_verified_at = $2,
           last_login_at = $2, row_version = row_version + 1 WHERE id = $1`,
        [clientId, now],
      );
      await writeAudit(
        tx,
        meta,
        { action: 'client.status_changed', object: { type: 'client', id: clientId }, before: { status: 'guest' }, after: { status: 'active' }, reason: 'registered' },
        clock,
      );
    } else {
      await tx.query('UPDATE app.clients SET last_login_at = $2, phone_verified_at = coalesce(phone_verified_at, $2) WHERE id = $1', [clientId, now]);
    }
    const documentVersion = (input.documentVersion ?? cfg.consentDocumentVersion).slice(0, 64);
    if (needsConsent) await addConsent(tx, clock, meta, clientId, 'pd_processing', documentVersion);
    if (isNew) {
      const marketing = input.consents?.marketing === true;
      if (marketing) await addConsent(tx, clock, meta, clientId, 'marketing', documentVersion);
      await tx.query(
        `INSERT INTO app.client_notification_prefs (client_id, marketing_enabled, updated_at) VALUES ($1, $2, $3)
         ON CONFLICT (client_id) DO NOTHING`,
        [clientId, marketing, now],
      );
    }
    await tx.query('UPDATE app.client_otp_challenges SET consumed_at = $2 WHERE id = $1', [input.challengeId, now]);
    await hooks.onLogin?.(tx, { clientId, visitorId: input.visitorId ?? null, at: now });
    await writeAudit(tx, meta, { action: 'auth.client.login', object: { type: 'client', id: clientId }, after: { isNew } }, clock);
    const me = await getMe(tx, clientId);
    if (!me) throw new Error('verifyOtp: клиент без доступа в ЛК после входа');
    return { ok: true, result: { token: sessionToken, sessionId, expiresAt, client: me, isNew } };
  });
  if (!outcome.ok) throw outcome.error;
  return outcome.result;
}

// ---- сессия и ЛК

/** Кука → сессия. null – нет, отозвана, истекла или клиент не active/restricted (K9: в ЛК не пускают). */
export async function resolveClientSession(
  db: Db,
  cfg: ClientAuthConfig,
  rawToken: string,
  clock: Clock,
): Promise<{ clientId: string; sessionId: string } | null> {
  if (rawToken.length === 0 || rawToken.length > 256) return null;
  const now = clock.now();
  const r = await db.query<{ id: string; client_id: string; last_seen_at: Date; expires_at: Date; status: ClientStatus }>(
    `SELECT s.id, s.client_id, s.last_seen_at, s.expires_at, c.status
     FROM app.client_sessions s JOIN app.clients c ON c.id = s.client_id
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL`,
    [clientTokenHash(cfg.sessionPepper, rawToken)],
  );
  const s = r.rows[0];
  if (!s || (s.status !== 'active' && s.status !== 'restricted')) return null;
  if (now >= s.expires_at) {
    await db.query("UPDATE app.client_sessions SET revoked_at = $2, revoke_reason = 'expired' WHERE id = $1 AND revoked_at IS NULL", [s.id, now]);
    return null;
  }
  if (now.getTime() - s.last_seen_at.getTime() >= 60 * SEC) {
    await db.query('UPDATE app.client_sessions SET last_seen_at = $2 WHERE id = $1', [s.id, now]);
  }
  return { clientId: s.client_id, sessionId: s.id };
}

/** Выход (K9 №3): сессия → 'logout'. Push-подписки устройства – с модулем уведомлений (0111, S1-15). */
export async function logoutClient(
  pool: Pool,
  clock: Clock,
  session: { clientId: string; sessionId: string },
  req: ClientReqInfo,
): Promise<void> {
  const now = clock.now();
  await withTx(pool, async (tx) => {
    const r = await tx.query(
      "UPDATE app.client_sessions SET revoked_at = $2, revoke_reason = 'logout' WHERE id = $1 AND revoked_at IS NULL",
      [session.sessionId, now],
    );
    if (r.rowCount) {
      await writeAudit(tx, clientMeta(req, session.clientId, session.sessionId), { action: 'auth.client.logout', object: { type: 'client', id: session.clientId } }, clock);
    }
  });
}

/** MeDto (K9 §ЛК). null – клиента нет или статус не пускает в ЛК. */
export async function getMe(db: Db, clientId: string): Promise<MeDto | null> {
  const r = await db.query<{
    id: string;
    phone_e164: string | null;
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    birth_date: string | null;
    status: ClientStatus;
  }>(
    `SELECT id, phone_e164, first_name, last_name, email, to_char(birth_date, 'YYYY-MM-DD') AS birth_date, status
     FROM app.clients WHERE id = $1`,
    [clientId],
  );
  const row = r.rows[0];
  if (!row || (row.status !== 'active' && row.status !== 'restricted')) return null;
  return {
    id: row.id,
    phoneMasked: maskPhone(row.phone_e164),
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    birthDate: row.birth_date,
    status: row.status,
    notifications: await getNotificationPrefs(db, row.id),
    loyalty: null,
    certificates: null,
  };
}

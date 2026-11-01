// Идемпотентность команд (ADR 0004 §2, model-dannyh 0002).
// Ключ захватывается в той же транзакции, что и команда: INSERT ... ON CONFLICT DO NOTHING.
//  - вставили → выполняем команду, сохраняем ответ, вызывающий фиксирует всё вместе;
//  - параллельный дубль ждёт уникальный индекс; после фиксации первой читает сохранённый ответ;
//  - первая откатилась (ошибка или отказ по правилу) → ключа нет, вторая выполняется заново;
//  - тот же ключ, другой request_hash → 409 IDEMPOTENCY_KEY_REUSED.
// Транзакцию модуль НЕ открывает: tx – соединение с уже начатой транзакцией команды.
import { createHash, createHmac } from 'node:crypto';
import type pg from 'pg';
import { AppError } from './errors.ts';
import type { Clock } from './time.ts';

export type Tx = Pick<pg.ClientBase, 'query'>;

export const IDEMPOTENCY_TTL_MS = 72 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface IdempotentResponse {
  status: number;
  body: unknown;
}

export interface IdempotentResult extends IdempotentResponse {
  /** true – ответ взят из сохранённого (HTTP-слой ставит заголовок Idempotent-Replay: true). */
  replayed: boolean;
}

/** Заголовок Idempotency-Key: обязателен (сервер ключ не генерирует), формат – UUID. */
export function requireIdempotencyKey(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined || value.trim() === '') {
    throw new AppError('IDEMPOTENCY_KEY_REQUIRED', 400, 'Нужен заголовок Idempotency-Key');
  }
  if (!UUID_RE.test(value.trim())) {
    throw new AppError('VALIDATION_FAILED', 400, 'Idempotency-Key должен быть UUID', { field: 'Idempotency-Key' });
  }
  return value.trim().toLowerCase();
}

/** scope = '<тип актора>:<id актора>:<операция>' – ключи разных акторов не пересекаются. */
export function idempotencyScope(actorType: string, actorId: string, operation: string): string {
  return `${actorType}:${actorId}:${operation}`;
}

/** Канонический JSON: ключи объектов отсортированы, undefined в объектах опущен (как в JSON.stringify). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const s = JSON.stringify(value);
    return s === undefined ? 'null' : s;
  }
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const parts = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
  return `{${parts.join(',')}}`;
}

/** HMAC-SHA256(value, pepper) в hex – замена секрета (код сертификата) в теле для request_hash и в базе (K16 §3).
 *  4 цифры под чистым SHA-256 подбираются перебором мгновенно, под HMAC без pepper – нет. */
export function secretDigest(pepper: string, value: string): string {
  if (pepper.length < 32) throw new Error('secretDigest: pepper короче 32 символов');
  return createHmac('sha256', pepper).update(value).digest('hex');
}

/** request_hash = SHA-256 канонического JSON от {route, params, body}. */
export function requestHash(req: { route: string; params?: unknown; body?: unknown }): string {
  const canonical = canonicalJson({ route: req.route, params: req.params ?? null, body: req.body ?? null });
  return createHash('sha256').update(canonical).digest('hex');
}

export type ClaimResult = { kind: 'claimed' } | { kind: 'replay'; response: IdempotentResponse };

interface KeyRow {
  request_hash: string;
  response_status: number | null;
  response_body: unknown;
}

/** Захват ключа. claimed – команду выполнять; replay – вернуть сохранённый ответ. */
export async function claimKey(
  tx: Tx,
  input: { scope: string; key: string; requestHash: string; now: Date },
): Promise<ClaimResult> {
  const expiresAt = new Date(input.now.getTime() + IDEMPOTENCY_TTL_MS);
  // Две попытки: между конфликтом вставки и чтением строку могла удалить очистка – тогда ключ свободен.
  for (let attempt = 0; attempt < 2; attempt++) {
    const inserted = await tx.query(
      `INSERT INTO app.idempotency_keys (scope, key, request_hash, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (scope, key) DO NOTHING
       RETURNING key`,
      [input.scope, input.key, input.requestHash, input.now, expiresAt],
    );
    if (inserted.rowCount === 1) return { kind: 'claimed' };

    const existing = await tx.query<KeyRow>(
      'SELECT request_hash, response_status, response_body FROM app.idempotency_keys WHERE scope = $1 AND key = $2',
      [input.scope, input.key],
    );
    const row = existing.rows[0];
    if (!row) continue;
    if (row.request_hash !== input.requestHash) {
      throw new AppError('IDEMPOTENCY_KEY_REUSED', 409, 'Этот ключ уже использован для другого запроса');
    }
    if (row.response_status === null) {
      // Своя же незавершённая запись (тот же ключ дважды в одной транзакции) – ответа ещё нет.
      throw new AppError('IDEMPOTENCY_KEY_REUSED', 409, 'Запрос с этим ключом ещё выполняется', { reason: 'in_progress' });
    }
    return { kind: 'replay', response: { status: row.response_status, body: row.response_body } };
  }
  throw new Error(`claimKey: ключ ${input.scope}/${input.key} не удалось ни захватить, ни прочитать`);
}

/** Сохранить ответ команды перед фиксацией. Возвращает ответ в сохранённом виде (jsonb) – таким же его отдаст повтор. */
export async function saveResponse(
  tx: Tx,
  input: { scope: string; key: string },
  response: IdempotentResponse,
): Promise<IdempotentResponse> {
  const res = await tx.query<{ response_status: number; response_body: unknown }>(
    `UPDATE app.idempotency_keys SET response_status = $3, response_body = $4::jsonb
     WHERE scope = $1 AND key = $2 AND response_status IS NULL
     RETURNING response_status, response_body`,
    [input.scope, input.key, response.status, JSON.stringify(response.body ?? null)],
  );
  const row = res.rows[0];
  if (!row) throw new Error(`saveResponse: ключ ${input.scope}/${input.key} не захвачен этой транзакцией`);
  return { status: row.response_status, body: row.response_body };
}

/**
 * Обёртка команды: захват → команда → сохранение ответа. Вызывать внутри транзакции команды;
 * исключение команды пробрасывается – вызывающий откатывает транзакцию, ключ не сохраняется
 * (отказы по бизнес-правилам не закрепляются за ключом).
 */
export async function runIdempotent(
  tx: Tx,
  input: {
    scope: string;
    key: string;
    request: { route: string; params?: unknown; body?: unknown };
    clock: Clock;
    /** S2-08 (K16 §3): вид ответа для idempotency_keys – секреты вырезаны. Первый ответ уходит целиком,
     *  повтор отдаёт сохранённый (redact) вид: «код показан один раз». */
    redact?: (body: unknown) => unknown;
    /** S2-08: тело для request_hash – секретные поля заменены secretDigest, чтобы хэш не выдавал секрет перебором. */
    hashBody?: (body: unknown) => unknown;
  },
  command: () => Promise<IdempotentResponse>,
): Promise<IdempotentResult> {
  const now = input.clock.now();
  const request = input.hashBody ? { ...input.request, body: input.hashBody(input.request.body) } : input.request;
  const claim = await claimKey(tx, { scope: input.scope, key: input.key, requestHash: requestHash(request), now });
  if (claim.kind === 'replay') return { ...claim.response, replayed: true };
  const response = await command();
  if (input.redact) {
    await saveResponse(tx, input, { status: response.status, body: input.redact(response.body) });
    return { ...response, replayed: false };
  }
  // Отдаём сохранённое (jsonb нормализует порядок ключей) – первый ответ и повтор совпадают байт в байт.
  const saved = await saveResponse(tx, input, response);
  return { ...saved, replayed: false };
}

/** Очистка просроченных ключей (задача раз в час, $now из Clock). Возвращает число удалённых. */
export async function purgeExpiredKeys(db: Tx, now: Date): Promise<number> {
  const res = await db.query('DELETE FROM app.idempotency_keys WHERE expires_at < $1', [now]);
  return res.rowCount ?? 0;
}

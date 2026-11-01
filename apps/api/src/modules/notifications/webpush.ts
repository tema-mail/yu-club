// Web Push на node:crypto без внешней зависимости (решение S1-16: библиотека web-push тянет 6 пакетов ради ~150 строк).
// Шифрование тела – RFC 8291 + RFC 8188 (Content-Encoding: aes128gcm, одна запись); подпись – VAPID RFC 8292 (JWT ES256).
// Здесь только сборка запроса и отправка с тайм-аутом; статусы, повторы и подписки – sender.ts.
// Ключи подписки (p256dh, auth) и endpoint в логи не пишутся: endpoint – персональные данные (адрес браузера).
import { createECDH, createHash, createHmac, createPrivateKey, randomBytes, sign, createCipheriv, type KeyObject } from 'node:crypto';

export interface VapidKeys {
  /** Несжатая точка P-256, 65 байт, base64url – её же получает браузер как applicationServerKey. */
  publicKey: string;
  privateKey: KeyObject;
  /** mailto: или https: – контакт отправителя для push-сервиса (RFC 8292 §2.1). */
  subject: string;
}

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushRequest {
  url: string;
  headers: Record<string, string>;
  body: Buffer;
}

const B64URL_RE = /^[A-Za-z0-9_-]+$/;

export function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

export function fromB64url(s: string, bytes: number, what: string): Buffer {
  if (!B64URL_RE.test(s)) throw new Error(`webpush: ${what} – не base64url`);
  const buf = Buffer.from(s, 'base64url');
  if (buf.length !== bytes) throw new Error(`webpush: ${what} – ожидалось ${bytes} байт, получено ${buf.length}`);
  return buf;
}

/** Ключи VAPID из окружения: открытый 65 байт, закрытый 32 байта (base64url). Несовпадение пары – ошибка запуска. */
export function vapidKeys(publicKey: string, privateKey: string, subject: string): VapidKeys {
  const pub = fromB64url(publicKey, 65, 'VAPID_PUBLIC_KEY');
  const priv = fromB64url(privateKey, 32, 'VAPID_PRIVATE_KEY');
  if (pub[0] !== 0x04) throw new Error('webpush: VAPID_PUBLIC_KEY – нужна несжатая точка (0x04…)');
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(priv);
  if (!ecdh.getPublicKey().equals(pub)) throw new Error('webpush: VAPID_PUBLIC_KEY не соответствует VAPID_PRIVATE_KEY');
  if (!/^(mailto:|https:\/\/)/.test(subject)) throw new Error('webpush: VAPID_SUBJECT – mailto: или https://');
  const key = createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: b64url(priv), x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33, 65)) },
    format: 'jwk',
  });
  return { publicKey, privateKey: key, subject };
}

/** Новая пара VAPID (для тестов и разовой генерации на сервере). */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64url(ecdh.getPublicKey()), privateKey: b64url(ecdh.getPrivateKey()) };
}

/** JWT ES256 для заголовка Authorization: vapid t=…, k=… (RFC 8292 §2–3). aud – origin push-сервиса. */
export function vapidJwt(vapid: VapidKeys, endpoint: string, now: Date, ttlSec = 12 * 3600): string {
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = { aud: new URL(endpoint).origin, exp: Math.floor(now.getTime() / 1000) + ttlSec, sub: vapid.subject };
  const body = b64url(Buffer.from(JSON.stringify(claims)));
  const signature = sign('sha256', Buffer.from(`${header}.${body}`), { key: vapid.privateKey, dsaEncoding: 'ieee-p1363' });
  return `${header}.${body}.${b64url(signature)}`;
}

function hmac(key: Buffer, data: Buffer): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

/** HKDF-SHA256 с одним блоком вывода (length ≤ 32) – всё, что нужно RFC 8291. */
function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  const prk = hmac(salt, ikm);
  return hmac(prk, Buffer.concat([info, Buffer.from([1])])).subarray(0, length);
}

const RECORD_SIZE = 4096;

/** Тело aes128gcm (RFC 8291 §3.4): заголовок salt|rs|idlen|keyid + одна зашифрованная запись с разделителем 0x02. */
export function encryptPayload(target: PushTarget, plaintext: Buffer, opts: { salt?: Buffer; ecdh?: ReturnType<typeof createECDH> } = {}): Buffer {
  const uaPublic = fromB64url(target.p256dh, 65, 'p256dh');
  const authSecret = fromB64url(target.auth, 16, 'auth');
  if (plaintext.length > RECORD_SIZE - 17 - 86) throw new Error('webpush: тело уведомления длиннее одной записи');
  const ecdh = opts.ecdh ?? createECDH('prime256v1');
  if (!opts.ecdh) ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const salt = opts.salt ?? randomBytes(16);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hkdf(authSecret, shared, keyInfo, 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const encrypted = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, encrypted]);
}

/** Topic (RFC 8030 §5.4): ≤ 32 символа base64url. Повтор с тем же Topic заменяет непоказанное сообщение на устройстве. */
export function pushTopic(dedupeKey: string): string {
  return createHash('sha256').update(dedupeKey).digest('base64url').slice(0, 32);
}

export function buildPushRequest(
  target: PushTarget,
  payload: unknown,
  opts: { vapid: VapidKeys; now: Date; ttlSec: number; topic?: string; urgency?: 'normal' | 'high' },
): PushRequest {
  const body = encryptPayload(target, Buffer.from(JSON.stringify(payload)));
  const headers: Record<string, string> = {
    'content-type': 'application/octet-stream',
    'content-encoding': 'aes128gcm',
    ttl: String(Math.max(0, Math.floor(opts.ttlSec))),
    urgency: opts.urgency ?? 'normal',
    authorization: `vapid t=${vapidJwt(opts.vapid, target.endpoint, opts.now)}, k=${opts.vapid.publicKey}`,
  };
  if (opts.topic) headers.topic = opts.topic;
  return { url: target.endpoint, headers, body };
}

export type PushOutcome =
  | { kind: 'accepted'; status: number }
  | { kind: 'gone'; status: 404 | 410 }
  | { kind: 'retryable'; status: number }
  | { kind: 'rejected'; status: number }
  | { kind: 'timeout' };

/** Классификация ответа push-сервиса (RFC 8030 §5, 8292 §4). */
export function classifyStatus(status: number): PushOutcome {
  if (status >= 200 && status < 300) return { kind: 'accepted', status };
  if (status === 404 || status === 410) return { kind: 'gone', status };
  if (status === 429 || status >= 500) return { kind: 'retryable', status };
  return { kind: 'rejected', status }; // 400, 401/403 (VAPID), 413 – повтор не поможет
}

export type FetchLike = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: Buffer; signal: AbortSignal; redirect: 'manual' },
) => Promise<{ status: number }>;

/** Отправка с тайм-аутом. Тайм-аут и сетевой сбой – неизвестный исход, повтор допустим (Topic схлопнет дубль, K14). */
export async function sendPushRequest(req: PushRequest, fetchImpl: FetchLike, timeoutMs = 10_000): Promise<PushOutcome> {
  try {
    // redirect: 'manual' – по 3xx не идём на другой адрес (SSRF через редирект push-сервиса); 3xx = rejected.
    const res = await fetchImpl(req.url, { method: 'POST', headers: req.headers, body: req.body, signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    return classifyStatus(res.status);
  } catch {
    return { kind: 'timeout' };
  }
}

/** Маска endpoint для аудита и журнала (152-ФЗ): только хост push-сервиса. */
export function maskEndpoint(endpoint: string): string {
  try {
    return `${new URL(endpoint).host}/…`;
  } catch {
    return '…';
  }
}

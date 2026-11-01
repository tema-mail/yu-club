// Фейковый push-сервис для тестов: HTTP на 127.0.0.1, сам расшифровывает тело (RFC 8291/8188) ключами «браузера»
// и проверяет подпись VAPID (RFC 8292). Расшифровка написана отдельно от модуля – не тот же код в обе стороны.
import { createDecipheriv, createECDH, createHmac, createPublicKey, randomBytes, verify } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';

export interface FakeBrowser {
  p256dh: string;
  auth: string;
  ecdh: ReturnType<typeof createECDH>;
  authSecret: Buffer;
}

export function fakeBrowser(): FakeBrowser {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const authSecret = randomBytes(16);
  return { ecdh, authSecret, p256dh: ecdh.getPublicKey().toString('base64url'), auth: authSecret.toString('base64url') };
}

const hmac = (k: Buffer, d: Buffer) => createHmac('sha256', k).update(d).digest();

/** Расшифровка aes128gcm на стороне браузера. Бросает, если тело не по стандарту. */
export function decryptAes128gcm(body: Buffer, ua: FakeBrowser): { plaintext: Buffer; recordSize: number } {
  const salt = body.subarray(0, 16);
  const recordSize = body.readUInt32BE(16);
  const idlen = body[20]!;
  if (idlen !== 65) throw new Error(`keyid ${idlen} байт, ожидалось 65`);
  const asPublic = body.subarray(21, 21 + idlen);
  const record = body.subarray(21 + idlen);
  const shared = ua.ecdh.computeSecret(asPublic);
  const uaPublic = ua.ecdh.getPublicKey();
  const prkKey = hmac(ua.authSecret, shared);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const padded = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  if (padded[end] !== 2) throw new Error('нет разделителя последней записи 0x02');
  return { plaintext: padded.subarray(0, end), recordSize };
}

/** Проверка заголовка Authorization: vapid t=<jwt>, k=<key>. Возвращает claims. */
export function verifyVapid(authorization: string | undefined, expectedKey: string): { aud: string; exp: number; sub: string } {
  const m = /^vapid t=([^,]+), k=([A-Za-z0-9_-]+)$/.exec(authorization ?? '');
  if (!m) throw new Error(`Authorization не по RFC 8292: ${authorization}`);
  const [, jwt, k] = m;
  if (k !== expectedKey) throw new Error('k не совпадает с VAPID_PUBLIC_KEY');
  const [h, p, s] = jwt!.split('.');
  const pub = Buffer.from(k, 'base64url');
  const key = createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') },
    format: 'jwk',
  });
  const ok = verify('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s!, 'base64url'));
  if (!ok) throw new Error('подпись VAPID не сходится');
  const header = JSON.parse(Buffer.from(h!, 'base64url').toString()) as { alg: string };
  if (header.alg !== 'ES256') throw new Error(`alg ${header.alg}`);
  return JSON.parse(Buffer.from(p!, 'base64url').toString()) as { aud: string; exp: number; sub: string };
}

export interface ReceivedPush {
  path: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export interface PushReceiver {
  origin: string;
  received: ReceivedPush[];
  /** Ответ для пути: число – статус; 'hang' – не отвечать (тайм-аут). По умолчанию 201. */
  respond: Map<string, number | 'hang'>;
  endpoint(path: string): string;
  close(): Promise<void>;
}

export async function startPushReceiver(): Promise<PushReceiver> {
  const received: ReceivedPush[] = [];
  const respond = new Map<string, number | 'hang'>();
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const path = req.url ?? '/';
      received.push({ path, headers: req.headers, body: Buffer.concat(chunks) });
      const r = respond.get(path) ?? 201;
      if (r === 'hang') return;
      res.statusCode = r;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr !== 'object') throw new Error('нет адреса приёмника');
  const origin = `http://127.0.0.1:${addr.port}`;
  return {
    origin,
    received,
    respond,
    endpoint: (path) => `${origin}${path}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

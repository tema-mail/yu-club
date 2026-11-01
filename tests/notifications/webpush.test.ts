// S1-16: запрос Web Push – шифрование aes128gcm (RFC 8291/8188), VAPID (RFC 8292), заголовки, классификация ответов.
import { createECDH, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildPushRequest,
  classifyStatus,
  generateVapidKeys,
  privateKey32,
  maskEndpoint,
  pushTopic,
  sendPushRequest,
  vapidKeys,
  type VapidKeys,
} from '../../apps/api/src/modules/notifications/webpush.ts';
import { decryptAes128gcm, fakeBrowser, startPushReceiver, verifyVapid, type PushReceiver } from '../helpers/push-receiver.ts';

const pair = generateVapidKeys();
const vapid: VapidKeys = vapidKeys(pair.publicKey, pair.privateKey, 'mailto:ops@yu-club.test');
const now = new Date('2026-11-14T14:00:00Z');

describe('ключи VAPID', () => {
  it('закрытый ключ с ведущим нулевым байтом: генератор отдаёт 32 байта, пара принимается (≈1 из 256 ключей)', () => {
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(Buffer.concat([Buffer.alloc(1), randomBytes(31)]));
    expect(ecdh.getPrivateKey().length).toBeLessThan(32); // так ведёт себя node: ведущий ноль отброшен
    const pair = generateVapidKeys(ecdh);
    expect(Buffer.from(pair.privateKey, 'base64url').length).toBe(32);
    expect(() => vapidKeys(pair.publicKey, pair.privateKey, 'mailto:ops@yu-club.test')).not.toThrow();
    expect(privateKey32(Buffer.alloc(32, 1)).length).toBe(32);
    expect(() => privateKey32(Buffer.alloc(33))).toThrow();
  });

  it('пара проверяется на старте: чужой открытый ключ, кривая длина, плохой subject – ошибка', () => {
    const other = generateVapidKeys();
    expect(() => vapidKeys(other.publicKey, pair.privateKey, 'mailto:a@b.c')).toThrow(/не соответствует/);
    expect(() => vapidKeys(pair.publicKey.slice(2), pair.privateKey, 'mailto:a@b.c')).toThrow(/65 байт/);
    expect(() => vapidKeys(pair.publicKey, pair.privateKey, 'ops@yu-club.test')).toThrow(/VAPID_SUBJECT/);
  });
});

describe('buildPushRequest', () => {
  const ua = fakeBrowser();
  const target = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc123', p256dh: ua.p256dh, auth: ua.auth };

  it('тело расшифровывается ключами браузера; заголовки RFC 8030/8188/8292', () => {
    const payload = { title: 'Ю-Клуб: сеанс скоро начнётся', body: 'В 14:00 – Центр, ПК 7', url: '/account/bookings/' };
    const req = buildPushRequest(target, payload, { vapid, now, ttlSec: 3600, topic: pushTopic('reminder_before_start:x:1'), urgency: 'high' });
    expect(req.headers['content-encoding']).toBe('aes128gcm');
    expect(req.headers['content-type']).toBe('application/octet-stream');
    expect(req.headers.ttl).toBe('3600');
    expect(req.headers.urgency).toBe('high');
    expect(req.headers.topic).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const { plaintext, recordSize } = decryptAes128gcm(req.body, ua);
    expect(recordSize).toBe(4096);
    expect(JSON.parse(plaintext.toString())).toEqual(payload);
    const claims = verifyVapid(req.headers.authorization, pair.publicKey);
    expect(claims).toEqual({ aud: 'https://fcm.googleapis.com', exp: now.getTime() / 1000 + 12 * 3600, sub: 'mailto:ops@yu-club.test' });
  });

  it('каждый запрос – новая соль и новый эфемерный ключ; чужой браузер не расшифрует', () => {
    const a = buildPushRequest(target, { t: 1 }, { vapid, now, ttlSec: 60 });
    const b = buildPushRequest(target, { t: 1 }, { vapid, now, ttlSec: 60 });
    expect(a.body.subarray(0, 16).equals(b.body.subarray(0, 16))).toBe(false);
    expect(a.body.subarray(21, 86).equals(b.body.subarray(21, 86))).toBe(false);
    expect(() => decryptAes128gcm(a.body, fakeBrowser())).toThrow();
  });

  it('кривые ключи подписки – ошибка до сети', () => {
    expect(() => buildPushRequest({ ...target, auth: 'short' }, {}, { vapid, now, ttlSec: 60 })).toThrow(/auth/);
  });

  it('Topic стабилен для dedupe_key и укладывается в 32 символа', () => {
    expect(pushTopic('reminder_day_before:b:1')).toBe(pushTopic('reminder_day_before:b:1'));
    expect(pushTopic('reminder_day_before:b:1')).not.toBe(pushTopic('reminder_day_before:b:2'));
  });

  it('маска endpoint – только хост', () => {
    expect(maskEndpoint(target.endpoint)).toBe('fcm.googleapis.com/…');
    expect(maskEndpoint('не адрес')).toBe('…');
  });
});

describe('отправка на фейковый push-сервис', () => {
  let rx: PushReceiver;
  beforeAll(async () => {
    rx = await startPushReceiver();
  });
  afterAll(async () => rx.close());

  it('201 – accepted; приёмник получил корректный запрос и расшифровал его', async () => {
    const ua = fakeBrowser();
    const req = buildPushRequest({ endpoint: rx.endpoint('/push/ok'), p256dh: ua.p256dh, auth: ua.auth }, { hi: 'там' }, { vapid, now, ttlSec: 60 });
    expect(await sendPushRequest(req, fetch)).toEqual({ kind: 'accepted', status: 201 });
    const got = rx.received.at(-1)!;
    expect(got.headers['content-encoding']).toBe('aes128gcm');
    expect(JSON.parse(decryptAes128gcm(got.body, ua).plaintext.toString())).toEqual({ hi: 'там' });
    expect(verifyVapid(got.headers.authorization, pair.publicKey).aud).toBe(rx.origin);
  });

  it('410 – gone, 429 – retryable, 403 – rejected, нет ответа – timeout', async () => {
    const ua = fakeBrowser();
    const send = async (path: string, r: number | 'hang') => {
      rx.respond.set(path, r);
      const req = buildPushRequest({ endpoint: rx.endpoint(path), p256dh: ua.p256dh, auth: ua.auth }, {}, { vapid, now, ttlSec: 60 });
      return sendPushRequest(req, fetch, 300);
    };
    expect(await send('/push/gone', 410)).toEqual({ kind: 'gone', status: 410 });
    expect(await send('/push/busy', 429)).toEqual({ kind: 'retryable', status: 429 });
    expect(await send('/push/bad', 403)).toEqual({ kind: 'rejected', status: 403 });
    expect(await send('/push/hang', 'hang')).toEqual({ kind: 'timeout' });
    // 3xx: по редиректу не идём (SSRF), это rejected; на /redirected запроса нет
    const before = rx.received.length;
    expect(await send('/push/moved', 307)).toEqual({ kind: 'rejected', status: 307 });
    expect(rx.received.slice(before).map((r) => r.path)).toEqual(['/push/moved']);
  });

  it('classifyStatus: 202 и 404 тоже по стандарту', () => {
    expect(classifyStatus(202).kind).toBe('accepted');
    expect(classifyStatus(404).kind).toBe('gone');
    expect(classifyStatus(503).kind).toBe('retryable');
  });
});

// Чистые функции безопасности CRM: возврат после входа (open redirect) и адрес посетителя для лимита входа.
import { expect, test } from '../../../tests/support/e2e.ts';
import { safeNext } from '../src/lib/api.ts';
import { clientIp, parseTrusted } from '../src/lib/client-ip.ts';

const ORIGIN = 'https://crm.yu.test';

test('safeNext: чужие адреса и управляющие символы – на главную', () => {
  for (const bad of [
    '/\t/evil.com', '/\n/evil.com', '/\r/evil.com',
    '/\\evil.com', '//evil.com', 'https://evil.com', '\t//evil.com', '', null, undefined, 'branches/1',
  ]) {
    expect(safeNext(bad, ORIGIN), JSON.stringify(bad)).toBe('/');
  }
  // Как приходит из URLSearchParams: %09/%0A/%0D уже раскодированы в управляющие символы.
  for (const enc of ['/%09/evil.com', '/%0A/evil.com', '/%0D/evil.com']) {
    const decoded = new URLSearchParams(`next=${enc}`).get('next');
    expect(safeNext(decoded, ORIGIN), enc).toBe('/');
  }
});

test('safeNext: свой путь сохраняется целиком', () => {
  expect(safeNext('/branches/1?x=1#a', ORIGIN)).toBe('/branches/1?x=1#a');
  expect(safeNext('/', ORIGIN)).toBe('/');
});

test('clientIp: X-Forwarded-For – только от доверенного прокси', () => {
  const trusted = parseTrusted(undefined); // loopback и сети Docker
  // Напрямую из интернета: подделанный XFF игнорируется.
  expect(clientIp('203.0.113.7', '1.2.3.4', trusted)).toBe('203.0.113.7');
  // Через Caddy в Docker-сети: правый недоверенный адрес.
  expect(clientIp('172.18.0.5', '1.2.3.4, 198.51.100.9', trusted)).toBe('198.51.100.9');
  expect(clientIp('::ffff:127.0.0.1', '198.51.100.9, 172.18.0.2', trusted)).toBe('198.51.100.9');
  // От доверенного без XFF – адрес соединения.
  expect(clientIp('127.0.0.1', null, trusted)).toBe('127.0.0.1');
  // Свой список из окружения.
  expect(clientIp('10.0.0.3', '198.51.100.9', parseTrusted('10.0.0.0/8'))).toBe('198.51.100.9');
  expect(clientIp('172.18.0.5', '198.51.100.9', parseTrusted('10.0.0.0/8'))).toBe('172.18.0.5');
});

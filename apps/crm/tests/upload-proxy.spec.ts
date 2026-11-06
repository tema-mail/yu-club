// S4-09: прокси CRM /api/crm/v1/* передаёт тело запроса потоком (duplex: 'half'), не копит его в памяти.
// Без браузера: маршрут вызывается напрямую, «API» – отдельный процесс node (его буферы не попадают в замер памяти).
// Лимиты Caddy (2 МБ везде, 11 МБ на загрузку медиа №224 и вложений №350) этим тестом не проверяются – только caddy validate
// и curl на стенде (deploy/Caddyfile.yu-club).
import { expect, test } from '../../../tests/support/e2e.ts';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { ALL } from '../src/pages/api/crm/v1/[...path].ts';

const MB = 1024 * 1024;
const CHUNK = new Uint8Array(64 * 1024).fill(0x5a); // один буфер на весь поток – поток сам не мусорит

// «API»: считает байты и SHA-256 тела и отвечает JSON.
const UPSTREAM = `
const http = require('node:http'); const { createHash } = require('node:crypto');
const s = http.createServer((req, res) => {
  const h = createHash('sha256'); let n = 0;
  req.on('data', (c) => { n += c.length; h.update(c); });
  req.on('end', () => { res.writeHead(201, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ path: req.url, method: req.method, bytes: n, sha: h.digest('hex'), chunked: req.headers['transfer-encoding'] === 'chunked' })); });
});
s.listen(0, '127.0.0.1', () => process.stdout.write(String(s.address().port) + String.fromCharCode(10)));`;

let upstream: ChildProcess;

test.beforeAll(async () => {
  upstream = spawn(process.execPath, ['-e', UPSTREAM], { stdio: ['ignore', 'pipe', 'inherit'] });
  const [line] = (await once(upstream.stdout!, 'data')) as [Buffer];
  process.env.API_URL = `http://127.0.0.1:${line.toString().trim()}`;
});
test.afterAll(() => {
  upstream.kill();
});

/** Тело заданного размера – потоком из одного повторяемого буфера. */
function bodyStream(bytes: number): ReadableStream<Uint8Array> {
  let left = bytes;
  return new ReadableStream<Uint8Array>({
    pull(ctrl) {
      if (left <= 0) return ctrl.close();
      const n = Math.min(left, CHUNK.length);
      ctrl.enqueue(n === CHUNK.length ? CHUNK : CHUNK.subarray(0, n));
      left -= n;
    },
  });
}

function expectedSha(bytes: number): string {
  const h = createHash('sha256');
  for (let left = bytes; left > 0; left -= CHUNK.length) h.update(CHUNK.subarray(0, Math.min(left, CHUNK.length)));
  return h.digest('hex');
}

function call(path: string, init: RequestInit & { duplex?: 'half' }) {
  const request = new Request(`http://crm.test/api/crm/v1/${path}`, init);
  // Вызов маршрута Astro напрямую: нужны только request, params и clientAddress.
  return ALL({ request, params: { path }, clientAddress: '127.0.0.1' } as unknown as Parameters<typeof ALL>[0]) as Promise<Response>;
}

test('9 МБ на загрузку медиа (№224) доходят до API целиком и потоком', async () => {
  const bytes = 9 * MB;
  const res = await call('content/media', {
    method: 'POST',
    headers: { 'content-type': 'multipart/form-data; boundary=x', 'idempotency-key': 'k1' },
    body: bodyStream(bytes),
    duplex: 'half',
  });
  expect(res.status).toBe(201);
  const got = (await res.json()) as { path: string; method: string; bytes: number; sha: string; chunked: boolean };
  expect(got).toMatchObject({ path: '/api/crm/v1/content/media', method: 'POST', bytes, sha: expectedSha(bytes) });
  expect(got.chunked).toBe(true); // тело ушло потоком, а не одним буфером с длиной
});

test('память процесса CRM при загрузке 10 МБ не растёт на размер файла', async () => {
  const before = process.memoryUsage().arrayBuffers;
  const res = await call('content/media', { method: 'POST', body: bodyStream(10 * MB), duplex: 'half' });
  const after = process.memoryUsage().arrayBuffers;
  expect(res.status).toBe(201);
  expect(after - before).toBeLessThan(4 * MB);
});

test('в fetch к API уходит поток с duplex: half, а не прочитанный буфер', async () => {
  const realFetch = globalThis.fetch;
  let seen: (RequestInit & { duplex?: string }) | undefined;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    seen = init;
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  try {
    await call('content/media', { method: 'POST', body: bodyStream(1024), duplex: 'half' });
    expect(seen?.body).toBeInstanceOf(ReadableStream);
    expect(seen?.duplex).toBe('half');
    await call('notifications/campaigns', { method: 'GET' });
    expect(seen?.body ?? undefined).toBeUndefined();
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('JSON обычных маршрутов проходит как раньше', async () => {
  const json = JSON.stringify({ title: 'Акция', body: 'x'.repeat(1000) });
  const res = await call('notifications/campaigns', { method: 'POST', headers: { 'content-type': 'application/json' }, body: json });
  expect(res.status).toBe(201);
  const got = (await res.json()) as { bytes: number; sha: string };
  expect(got.bytes).toBe(Buffer.byteLength(json));
  expect(got.sha).toBe(createHash('sha256').update(json).digest('hex'));
});

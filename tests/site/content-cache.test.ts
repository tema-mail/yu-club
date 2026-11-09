// S4-110: кэш контента на сайте (K22 §12). Публикация видна ≤ 60 с; ETag – 304 продлевает запись; API недоступен – устаревшее ≤ 10 мин,
// затем 503; 404 – null; доступность и другие пути мимо кэша. Файл в tests/site: vitest собирает только tests/**/*.test.ts.
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../apps/site/src/lib/api.ts';
import { createContentClient } from '../../apps/site/src/lib/content.ts';

type Reply = { status: number; body?: unknown; etag?: string } | 'down';

function harness(ttlMs = 60_000) {
  let t = 1_000_000;
  const calls: Array<{ url: string; inm: string | null }> = [];
  const replies: Reply[] = [];
  const logs: string[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const h = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, inm: h['if-none-match'] ?? null });
    const r = replies.shift() ?? 'down';
    if (r === 'down') throw new TypeError('fetch failed');
    const headers = new Headers(r.etag ? { etag: r.etag } : {});
    return new Response(r.status === 304 ? null : JSON.stringify(r.body ?? {}), { status: r.status, headers });
  }) as unknown as typeof fetch;
  const client = createContentClient({ fetch: fetchFn, now: () => t, ttlMs, base: () => 'http://api', log: (m) => logs.push(m) });
  return { client, calls, replies, logs, tick: (ms: number) => (t += ms) };
}

describe('кэш контента сайта', () => {
  it('в пределах 60 с – из памяти, после – запрос с If-None-Match; 304 продлевает', async () => {
    const h = harness();
    h.replies.push({ status: 200, body: { v: 1 }, etag: '"a"' });
    expect(await h.client.get('/content/pages/about')).toEqual({ v: 1 });
    h.tick(59_000);
    expect(await h.client.get('/content/pages/about')).toEqual({ v: 1 });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.url).toBe('http://api/api/public/v1/content/pages/about');
    h.tick(2_000);
    h.replies.push({ status: 304 });
    expect(await h.client.get('/content/pages/about')).toEqual({ v: 1 });
    expect(h.calls[1]!.inm).toBe('"a"');
    h.tick(30_000);
    expect(await h.client.get('/content/pages/about')).toEqual({ v: 1 });
    expect(h.calls).toHaveLength(2);
  });

  it('новая публикация видна не позже чем через 60 с', async () => {
    const h = harness();
    h.replies.push({ status: 200, body: { title: 'старое' }, etag: '"a"' });
    await h.client.get('/content/home');
    h.tick(60_000);
    h.replies.push({ status: 200, body: { title: 'новое' }, etag: '"b"' });
    expect(await h.client.get('/content/home')).toEqual({ title: 'новое' });
  });

  it('404 – null и тоже кэшируется на TTL', async () => {
    const h = harness();
    h.replies.push({ status: 404, body: { error: { code: 'NOT_FOUND', message: 'Не найдено' } } });
    expect(await h.client.get('/content/publications/news/x')).toBeNull();
    expect(await h.client.get('/content/publications/news/x')).toBeNull();
    expect(h.calls).toHaveLength(1);
  });

  it('API недоступен: устаревшее до 10 минут с записью в лог, потом 503', async () => {
    const h = harness();
    h.replies.push({ status: 200, body: { v: 1 }, etag: '"a"' });
    await h.client.get('/content/games');
    h.tick(9 * 60_000);
    h.replies.push('down');
    expect(await h.client.get('/content/games')).toEqual({ v: 1 });
    expect(h.logs).toHaveLength(1);
    h.tick(60_000);
    h.replies.push({ status: 502, body: {} });
    expect(await h.client.get('/content/games')).toEqual({ v: 1 }); // ровно 10 минут – ещё можно
    h.tick(1);
    h.replies.push('down');
    await expect(h.client.get('/content/games')).rejects.toMatchObject({ status: 503 });
  });

  it('без сохранённого ответа сбой – сразу 503; 400 – ошибка как есть, без устаревшего', async () => {
    const h = harness();
    h.replies.push('down');
    await expect(h.client.get('/content/home')).rejects.toBeInstanceOf(ApiError);
    h.replies.push({ status: 200, body: { v: 1 } });
    await h.client.get('/content/publications?limit=5');
    h.tick(61_000);
    h.replies.push({ status: 400, body: { error: { code: 'VALIDATION_FAILED', message: 'плохо' } } });
    await expect(h.client.get('/content/publications?limit=5')).rejects.toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
  });

  it('доступность, ЛК и прочие пути через кэш не идут', async () => {
    const h = harness();
    await expect(h.client.get('/branches/x/availability')).rejects.toThrow(/только \/content/);
    await expect(h.client.get('/me/notifications')).rejects.toThrow();
    expect(h.calls).toHaveLength(0);
  });

  it('одновременные запросы одного пути – один вызов API; больше 500 записей – вытесняется самая старая', async () => {
    const h = harness();
    h.replies.push({ status: 200, body: { v: 1 } });
    const [a, b] = await Promise.all([h.client.get('/content/home'), h.client.get('/content/home')]);
    expect(a).toEqual(b);
    expect(h.calls).toHaveLength(1);
    for (let i = 0; i < 500; i++) h.replies.push({ status: 200, body: { i } });
    for (let i = 0; i < 500; i++) await h.client.get(`/content/games/pc/g${i}`);
    expect(h.client.size()).toBe(500);
    h.replies.push({ status: 200, body: { v: 2 } });
    await h.client.get('/content/home');
    expect(h.calls).toHaveLength(502); // /content/home вытеснен первым
  });
});

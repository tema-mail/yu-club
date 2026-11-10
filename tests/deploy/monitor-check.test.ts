// scripts/monitor-check.sh (17 §13.3, 18 §9.4): настоящий скрипт против локального HTTP-сервера, который отдаёт тела
// /health/deep как server.ts (status первым ключом). Код выхода 0 – порядок, 1 – строка для оповещения, 2 – неверный вызов.
// Отправка оповещения – техдолг владельца (cron ловит код 1).
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const SCRIPT = join(import.meta.dirname, '../../scripts/monitor-check.sh');
let server: Server;
let base: string;
let response: { code: number; body: string } = { code: 200, body: '' };

const body = (status: string, checks: Record<string, string>) =>
  JSON.stringify({ status, version: 'abc', checkedAt: '2026-11-10T12:00:00Z', checks: Object.fromEntries(Object.entries(checks).map(([k, s]) => [k, { status: s, n: 1 }])) });

async function check(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number; out: string }> {
  try {
    const r = await run('bash', [SCRIPT, ...args], { env: { ...process.env, ...env } });
    return { code: 0, out: r.stdout + r.stderr };
  } catch (err) {
    const e = err as { code: number; stdout: string; stderr: string };
    return { code: e.code, out: e.stdout + e.stderr };
  }
}

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url !== '/health/deep') {
      res.writeHead(404, { 'content-type': 'text/html' }).end('<html>сайт</html>');
      return;
    }
    res.writeHead(response.code, { 'content-type': 'application/json' }).end(response.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('scripts/monitor-check.sh', () => {
  it('ok → код 0', async () => {
    response = { code: 200, body: body('ok', { db: 'ok', worker: 'ok' }) };
    const r = await check([`${base}/`]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^ok yu-club/);
  });

  it('degraded → код 1 и строка с проблемными проверками; с порогом down – код 0', async () => {
    response = { code: 200, body: body('degraded', { db: 'ok', worker: 'degraded', queue: 'skipped', disk: 'degraded' }) };
    const r = await check([base]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('ТРЕВОГА yu-club: degraded – worker=degraded disk=degraded');
    const soft = await check([base, 'down']);
    expect(soft.code).toBe(0);
    expect(soft.out).toContain('без тревоги');
    const viaEnv = await check([base], { MONITOR_ALERT_ON: 'down' });
    expect(viaEnv.code).toBe(0);
  });

  it('down (503) → код 1 АВАРИЯ', async () => {
    response = { code: 503, body: body('down', { db: 'down', outbox: 'skipped' }) };
    const r = await check([base]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('АВАРИЯ yu-club: down (HTTP 503) – db=down');
  });

  it('нет ответа или не наш JSON → код 1', async () => {
    const dead = await check(['http://127.0.0.1:1'], { MONITOR_TIMEOUT: '2' });
    expect(dead.code).toBe(1);
    expect(dead.out).toContain('не отвечает');
    response = { code: 200, body: '<html>не api</html>' };
    const html = await check([base]);
    expect(html.code).toBe(1);
    expect(html.out).toContain('без статуса');
  });

  it('без адреса или с неверным порогом → код 2', async () => {
    expect((await check([])).code).toBe(2);
    expect((await check([base, 'maybe'])).code).toBe(2);
  });
});

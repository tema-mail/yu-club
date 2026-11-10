// GET /health/deep (core/health.ts) и пульс worker (core/heartbeat.ts, миграция 0446) на настоящей Postgres:
// всё в порядке → 200 ok; остановленный worker (старый пульс) → degraded; закрытый пул → 503 down.
// Наружу – только статусы и числа: ни путей каталогов, ни хоста worker, ни текстов ошибок.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import { startHeartbeat, workerDetails } from '../../apps/api/src/core/heartbeat.ts';
import { systemClock } from '../../apps/api/src/core/time.ts';
import { buildServer, type ServerDeps } from '../../apps/api/src/server.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

let db: TestDatabase;
let pool: pg.Pool;
let boss: PgBoss;
let dir: string;
let env: Record<string, string>;
const errors: unknown[] = [];
const apps: ReturnType<typeof buildServer>[] = [];

function server(deps: ServerDeps, extraEnv: Record<string, string> = {}) {
  const app = buildServer(loadConfig({ ...env, ...extraEnv }), { health: { cacheMs: 0 }, ...deps });
  apps.push(app);
  return app;
}
const deep = (app: ReturnType<typeof buildServer>) => app.inject({ method: 'GET', url: '/health/deep' });

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
  boss = new PgBoss({ connectionString: db.url, schema: 'pgboss' });
  boss.on('error', (err) => errors.push(err));
  await boss.start();
  dir = await mkdtemp(join(tmpdir(), 'yu-health-'));
  await mkdir(join(dir, 'media'));
  await mkdir(join(dir, 'att'));
  env = { LOG_LEVEL: 'silent', GIT_SHA: 'abc1234', MEDIA_DIR: join(dir, 'media'), ATTACHMENTS_DIR: join(dir, 'att') };
}, 60_000);

afterAll(async () => {
  for (const app of apps) await app.close();
  await boss?.stop({ graceful: false });
  await pool?.end();
  await rm(dir, { recursive: true, force: true });
  await db?.drop();
});

describe('пульс worker', () => {
  it('пишет одну строку app.service_heartbeats с цифрами очереди; повтор – обновление той же строки', async () => {
    const hb = startHeartbeat({ pool, clock: systemClock, service: 'worker', version: 'w1', intervalMs: 60_000, details: () => workerDetails(boss), onError: (err) => errors.push(err) });
    await hb.beatNow();
    await hb.beatNow();
    hb.stop();
    const rows = (await db.client.query('SELECT service, instance, version, details, started_at, beat_at FROM app.service_heartbeats')).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ service: 'worker', version: 'w1', details: { queue: { queued: 0, active: 0, failedLastHour: 0, oldestReadySec: null } } });
    expect(rows[0].instance).toMatch(/:\d+$/);
    expect(rows[0].beat_at.getTime()).toBeGreaterThanOrEqual(rows[0].started_at.getTime());
    expect(errors).toEqual([]);
  });
});

describe('GET /health/deep', () => {
  it('всё в порядке → 200 ok; status первым ключом; без путей и хоста', async () => {
    const res = await deep(server({ network: { pool } }));
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.startsWith('{"status":"ok","version":"abc1234"')).toBe(true);
    const body = res.json();
    expect(body.checks.db).toMatchObject({ status: 'ok' });
    expect(body.checks.outbox).toEqual({ status: 'ok', pending: 0, oldestSec: null, dispatchFailed: 0 });
    expect(body.checks.worker).toMatchObject({ status: 'ok', version: 'w1' });
    expect(body.checks.worker.ageSec).toBeLessThanOrEqual(5);
    expect(body.checks.queue).toEqual({ status: 'ok', queued: 0, active: 0, failedLastHour: 0, oldestReadySec: null });
    expect(body.checks.disk.status).toBe('ok');
    expect(body.checks.disk.media.freeMb).toBeGreaterThan(0);
    expect(body.checks.notifications).toEqual({ status: 'ok', serviceErrorsLastHour: 0 });
    const instance = (await db.client.query('SELECT instance FROM app.service_heartbeats')).rows[0].instance as string;
    expect(res.body).not.toContain(dir);
    expect(res.body).not.toContain(instance);
  });

  it('частота: кэш 5 с – два запроса подряд дают один и тот же проход', async () => {
    const app = buildServer(loadConfig(env), { network: { pool } });
    apps.push(app);
    const a = (await deep(app)).json();
    const b = (await deep(app)).json();
    expect(b.checkedAt).toBe(a.checkedAt);
  });

  it('пульс worker старше 90 с → degraded (200), без пульса – degraded never', async () => {
    const app = server({ network: { pool } });
    await db.client.query(`UPDATE app.service_heartbeats SET beat_at = now() - interval '10 minutes'`);
    let res = await deep(app);
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('degraded');
    expect(res.json().checks.worker).toMatchObject({ status: 'degraded', reason: 'stale' });
    expect(res.json().checks.worker.ageSec).toBeGreaterThanOrEqual(600);
    expect(res.json().checks.queue.status).toBe('ok'); // цифры последнего пульса

    await db.client.query('DELETE FROM app.service_heartbeats');
    res = await deep(app);
    expect(res.json().status).toBe('degraded');
    expect(res.json().checks.worker).toEqual({ status: 'degraded', reason: 'never' });
    expect(res.json().checks.queue).toEqual({ status: 'skipped', reason: 'no_heartbeat' });
  });

  it('неразосланное событие outbox старше минуты и ошибка сервисного уведомления за час → degraded', async () => {
    const app = server({ network: { pool } });
    await db.client.query(`INSERT INTO app.outbox_events (event_type, event_version, aggregate_type, aggregate_id, payload, dedupe_key, occurred_at)
      VALUES ('t.happened', 1, 'booking', gen_random_uuid(), '{}', 't:1', now() - interval '5 minutes')`);
    const clientId = (await db.client.query(`INSERT INTO app.clients (phone_e164, status, created_by_type) VALUES ('+79130000001', 'active', 'system') RETURNING id`)).rows[0].id;
    await db.client.query(
      `INSERT INTO app.notifications (client_id, category, kind, source, title, body, planned_at, status, error, dedupe_key)
       VALUES ($1, 'service', 'booking_confirmed', 'system', 'т', 'т', now(), 'error', 'push: 500', 'booking_confirmed:x:1')`,
      [clientId],
    );
    const body = (await deep(app)).json();
    expect(body.status).toBe('degraded');
    expect(body.checks.outbox).toMatchObject({ status: 'degraded', pending: 1, dispatchFailed: 0 });
    expect(body.checks.outbox.oldestSec).toBeGreaterThanOrEqual(300);
    expect(body.checks.notifications).toEqual({ status: 'degraded', serviceErrorsLastHour: 1 });
    expect(JSON.stringify(body)).not.toContain('+7913');
    await db.client.query('DELETE FROM app.notifications');
    await db.client.query('DELETE FROM app.clients');
    await db.client.query('DELETE FROM app.outbox_events');
  });

  it('нет каталога медиатеки → degraded с кодом ошибки, без пути', async () => {
    const res = await deep(server({ network: { pool } }, { MEDIA_DIR: join(dir, 'net-takogo') }));
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('degraded');
    expect(res.json().checks.disk.media).toEqual({ status: 'degraded', error: 'ENOENT' });
    expect(res.json().checks.disk.attachments.status).toBe('ok');
    expect(res.body).not.toContain('net-takogo');
  });

  it('закрытый пул → 503 down, остальные проверки skipped', async () => {
    const closed = new pg.Pool({ connectionString: db.url, max: 1 });
    await closed.end();
    const res = await deep(server({ network: { pool: closed } }));
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.status).toBe('down');
    expect(body.checks.db).toEqual({ status: 'down', error: 'ERROR' });
    expect(body.checks.outbox).toEqual({ status: 'skipped' });
    expect(body.checks.worker).toEqual({ status: 'skipped' });
    expect(body.checks.disk.status).toBe('ok');
    expect(res.body).not.toContain(db.url);
  });

  it('база не отвечает дольше 2 с → 503 down TIMEOUT', async () => {
    const slow = { query: () => new Promise<never>(() => undefined) } as unknown as pg.Pool;
    const res = await deep(server({ network: { pool: slow }, health: { cacheMs: 0, thresholds: { dbTimeoutMs: 50 } } }));
    expect(res.statusCode).toBe(503);
    expect(res.json().checks.db).toEqual({ status: 'down', error: 'TIMEOUT' });
  });

  it('API без DATABASE_URL → 503 down NOT_CONFIGURED', async () => {
    const res = await deep(server({}));
    expect(res.statusCode).toBe(503);
    expect(res.json().checks.db).toEqual({ status: 'down', error: 'NOT_CONFIGURED' });
  });
});

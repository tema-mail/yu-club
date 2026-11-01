import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import { buildServer, depsFromConfig } from '../../apps/api/src/server.ts';

describe('GET /health', () => {
  it('отдаёт 200, статус и версию из GIT_SHA', async () => {
    const app = buildServer(loadConfig({ GIT_SHA: 'abc1234', LOG_LEVEL: 'silent' }));
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', version: 'abc1234' });
    await app.close();
  });

  it('без GIT_SHA версия = dev', async () => {
    const app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }));
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.json()).toMatchObject({ version: 'dev' });
    await app.close();
  });
});

describe('loadConfig', () => {
  it('отклоняет неверный порт', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/PORT/);
  });

  it('берёт порт из окружения', () => {
    expect(loadConfig({ PORT: '4100' }).PORT).toBe(4100);
  });
});

describe('вход сотрудников из окружения', () => {
  it('короткий SESSION_PEPPER не проходит валидацию, значение в ошибку не попадает', () => {
    expect(() => loadConfig({ SESSION_PEPPER: 'секрет-короткий' })).toThrow(/SESSION_PEPPER/);
    expect(() => loadConfig({ SESSION_PEPPER: 'секрет-короткий' })).not.toThrow(/секрет-короткий/);
  });

  it('без DATABASE_URL зависимостей нет, без SESSION_PEPPER – нет маршрутов входа', async () => {
    expect(depsFromConfig(loadConfig({})).deps).toEqual({});
    const noPepper = depsFromConfig(loadConfig({ DATABASE_URL: 'postgres://u:p@127.0.0.1:1/x' }));
    expect(noPepper.deps.staff).toBeUndefined();
    await noPepper.close();
    const full = depsFromConfig(loadConfig({ DATABASE_URL: 'postgres://u:p@127.0.0.1:1/x', SESSION_PEPPER: 'p'.repeat(32) }));
    expect(full.deps.staff?.auth.maxFailures).toBe(10);
    const app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), full.deps);
    const res = await app.inject({ method: 'GET', url: '/api/crm/v1/auth/session' });
    expect(res.json().error.code).toBe('AUTH_REQUIRED');
    await app.close();
    await full.close();
  });
});

import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import { buildServer } from '../../apps/api/src/server.ts';

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

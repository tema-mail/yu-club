// 17 §13.2: необработанная ошибка API пишется одной JSON-строкой с кодом, маршрутом (шаблон, не адрес) и reqId,
// без тела запроса и без detail ошибки pg (там значения строк – ПДн). Клиенту – INTERNAL с тем же requestId.
import { Writable } from 'node:stream';
import { expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import { buildServer } from '../../apps/api/src/server.ts';

it('500: JSON-лог с code, route, reqId; без тела, query и detail', async () => {
  let logs = '';
  const logStream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      logs += chunk.toString();
      cb();
    },
  });
  const app = buildServer(loadConfig({ LOG_LEVEL: 'error' }), { logStream });
  app.post('/t/boom/:id', async () => {
    const err = Object.assign(new Error('duplicate key value violates unique constraint "clients_phone_key"'), {
      code: '23505',
      detail: 'Key (phone_e164)=(+79130000777) already exists.',
    });
    throw err;
  });
  const res = await app.inject({ method: 'POST', url: '/t/boom/42?phone=%2B79130000777', payload: { phone: '+79130000777', name: 'Иван' } });
  await app.close();
  expect(res.statusCode).toBe(500);
  const requestId = res.json().error.requestId;
  const lines = logs.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  const line = lines.find((l) => l.msg === 'необработанная ошибка API');
  expect(line).toMatchObject({ level: 50, code: 'INTERNAL', method: 'POST', route: '/t/boom/:id', reqId: requestId, error: { type: 'Error', pgCode: '23505' } });
  expect(logs).not.toContain('79130000777');
  expect(logs).not.toContain('Иван');
});

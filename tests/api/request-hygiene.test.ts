// Гигиена ответов и лога API (скилл «защита-сайта»: ошибки без внутренностей наружу, логи без ПДн).
// 1. Неизвестный маршрут – тело ошибки ADR 0002 { error: { code: 'NOT_FOUND', … } }, а не сырой ответ Fastify
//    («Route GET:/… not found» выдаёт фреймворк и список маршрутов перебором).
// 2. Лог запроса: значения параметров поиска и контактов (q, phone, email, …) маскируются – в логах нет телефонов и имён
//    клиентов из строки поиска CRM; адрес маршрута и прочие параметры остаются (тест отписки проверяет ?t= и ?x=1).
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import { buildServer } from '../../apps/api/src/server.ts';

function capture() {
  let logs = '';
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      logs += chunk.toString();
      cb();
    },
  });
  return { stream, text: () => logs };
}

describe('неизвестный маршрут', () => {
  it('404 в формате ADR 0002, без слов фреймворка', async () => {
    const app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }));
    for (const url of ['/api/crm/v1/zzz', '/api/public/v1/zzz', '/nope']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
      expect(res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Не найдено', requestId: expect.any(String) } });
      expect(res.body).not.toMatch(/Route|Fastify/);
    }
    await app.close();
  });
});

describe('лог запроса', () => {
  it('значения q, phone, email маскируются; путь и остальные параметры остаются', async () => {
    const log = capture();
    const app = buildServer(loadConfig({ LOG_LEVEL: 'trace' }), { logStream: log.stream });
    await app.inject({ method: 'GET', url: '/api/crm/v1/clients?q=%2B79135550101&status=active&limit=20' });
    await app.inject({ method: 'GET', url: '/api/crm/v1/search?q=Иванов%20Пётр' });
    await app.inject({ method: 'GET', url: '/api/crm/v1/staff?email=ivan@example.ru&phone=79990001122' });
    await app.close();
    const text = log.text();
    expect(text).toContain('/api/crm/v1/clients?q=*&status=active&limit=20');
    expect(text).toContain('/api/crm/v1/search?q=*');
    expect(text).toContain('/api/crm/v1/staff?email=*&phone=*');
    for (const secret of ['79135550101', '9135550101', encodeURIComponent('Иванов'), 'Иванов', 'ivan@example.ru', '79990001122']) expect(text).not.toContain(secret);
  });
});

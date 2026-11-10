// Страж моков экранов (10.11.2026): один маршрут API – один обработчик во всех mock-*.ts приложения.
// Было: два потока независимо замокали №251 (failures/summary) в mock-ops.ts и mock-notifications.ts с разной формой ответа;
// Fastify падал на старте мока – не запускался ни один спек CRM, а экран рабочего стола ждал не ту форму, что отдаёт API.
// Тест ловит дубль без браузера и без запуска мока. Форма ответа – только тип из apps/<app>/src/lib (его же импортирует мок).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROUTE = /app\.(get|post|put|patch|delete)\(\s*`([^`]+)`/g;

function routesOf(dir: string): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  for (const file of readdirSync(dir).filter((f) => /^mock-.*\.ts$/.test(f))) {
    const text = readFileSync(join(dir, file), 'utf8');
    for (const m of text.matchAll(ROUTE)) {
      const key = `${m[1]!.toUpperCase()} ${m[2]!.replace(/:\w+/g, ':id')}`;
      seen.set(key, [...(seen.get(key) ?? []), file]);
    }
  }
  return seen;
}

describe.each(['apps/crm/tests', 'apps/site/tests'])('моки %s', (dir) => {
  it('каждый маршрут объявлен один раз', () => {
    const routes = routesOf(dir);
    expect(routes.size).toBeGreaterThan(0);
    const dups = [...routes].filter(([, files]) => files.length > 1).map(([key, files]) => `${key}: ${files.join(', ')}`);
    expect(dups).toEqual([]);
  });
});

// «Одна ошибка – один раз»: у долгоживущего пула процессов API и worker есть обработчик ошибок –
// без него обрыв простаивающего соединения роняет процесс. Разовые команды (засев, ручная сверка) сюда не входят.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const LONG_LIVED = ['apps/api/src/server.ts', 'apps/api/src/worker.ts', 'apps/api/src/modules/reports/framework.ts'];

describe('pg.Pool долгоживущих процессов', () => {
  it.each(LONG_LIVED)('%s: на каждый new pg.Pool есть .on("error")', (file) => {
    const src = readFileSync(file, 'utf8');
    const pools = src.match(/new (pg\.)?Pool\(/g)?.length ?? 0;
    const handlers = src.match(/\.on\(\s*['"]error['"]/g)?.length ?? 0;
    expect(pools).toBeGreaterThan(0);
    expect(handlers).toBeGreaterThanOrEqual(pools);
  });
});

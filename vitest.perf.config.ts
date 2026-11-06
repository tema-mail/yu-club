import { defineConfig } from 'vitest/config';

// Замеры времени отчётов (npm run test:perf) – отдельным прогоном: засев даёт минуту нагрузки, а в общем параллельном наборе
// замер меряет соседей по кластеру (дашборд: 1,1 с в одиночку, больше 10 с три раза подряд в полном наборе).
export default defineConfig({
  test: {
    include: ['tests/perf/**/*.perf.ts'],
    globalSetup: ['tests/helpers/pg.ts'],
    hookTimeout: 300_000,
    testTimeout: 120_000,
    silent: false,
  },
});

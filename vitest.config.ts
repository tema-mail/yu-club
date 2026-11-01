import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/helpers/pg.ts'],
    hookTimeout: 60_000,
    // Гонки гоняют по 10–50 параллельных транзакций; под нагрузкой всего набора 5 с не хватает.
    testTimeout: 30_000,
  },
});

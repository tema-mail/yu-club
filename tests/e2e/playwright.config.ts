// e2e против живого стенда (S1-27): сайт и CRM из окружения (SITE_URL, CRM_URL), сертификат стенда – tls internal Caddy.
// Нагрузки на стенд не даём: тесты строго по одному (workers: 1, без параллели и повторов).
// Отчёт html – E2E_REPORT_DIR (по умолчанию ~/Downloads/yu-club/e2e-report), снимки и трассы падений – рядом.
//   npm run test:e2e:stand
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const OUT = process.env.E2E_OUT_DIR ?? join(homedir(), 'Downloads/yu-club');

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  outputDir: join(OUT, 'e2e-results'),
  reporter: [['list'], ['html', { outputFolder: process.env.E2E_REPORT_DIR ?? join(OUT, 'e2e-report'), open: 'never' }]],
  use: {
    ignoreHTTPSErrors: true,
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});

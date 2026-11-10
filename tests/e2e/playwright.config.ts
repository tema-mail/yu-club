// e2e против живого стенда (S1-27): сайт и CRM из окружения (SITE_URL, CRM_URL), сертификат стенда – tls internal Caddy.
// Нагрузки на стенд не даём: тесты строго по одному (workers: 1, без параллели и повторов).
// Отчёт html – E2E_REPORT_DIR (по умолчанию ~/Downloads/yu-club/e2e-report), снимки и трассы падений – рядом.
// В GitHub Actions (.github/workflows/stand-e2e.yml) E2E_OUT_DIR указывает внутрь workspace, папка уходит артефактом,
// репортер github добавляет аннотации падений к прогону.
//   npm run test:e2e:stand
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices, type ReporterDescription } from '@playwright/test';

const OUT = process.env.E2E_OUT_DIR ?? join(homedir(), 'Downloads/yu-club');
const REPORTERS: ReporterDescription[] = [
  ['list'],
  ['html', { outputFolder: process.env.E2E_REPORT_DIR ?? join(OUT, 'e2e-report'), open: 'never' }],
  ...(process.env.GITHUB_ACTIONS ? [['github'] as ReporterDescription] : []),
];

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  outputDir: join(OUT, 'e2e-results'),
  reporter: REPORTERS,
  use: {
    ignoreHTTPSErrors: true,
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 15_000,
    // прогон 10.11 (9a0e0ca): переходы стенда при загруженной машине падали (commerce.spec.ts:197, e4.spec.ts:210), отдельно – секунды.
    // Медленный ответ – запас до 90 с, но меньше времени теста (180 с): медленная страница не роняет сценарий, зависшая – роняет.
    // Сетевой сбой Chromium (net::ERR_TIMED_OUT) таймаут не лечит – его повторяет gotoStand() из stand.ts.
    // Готовность после перехода – hydrated() (острова без ssr), а не sleep.
    navigationTimeout: 90_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});

// e2e сайта без бэкенда: мок публичного API (tests/mock-api.ts) + собранный сайт, смотрящий в мок через API_URL.
// Режим стенда (APP_ENV=stage): noindex везде. Бой проверяется вторым сервером на том же моке (APP_ENV=prod).
import { defineConfig, devices } from '@playwright/test';
import { fixE2eClock } from '../../tests/support/e2e.ts';

// Весь прогон – в одном зафиксированном «сейчас»: засевы от текущего времени не зависят от часа запуска (tests/support/e2e.ts).
fixE2eClock();

// Порты можно сдвинуть через E2E_PORT_BASE (несколько прогонов на одной машине): мок = база, стенд = база+320, прод = база+321.
const BASE = Number(process.env.E2E_PORT_BASE ?? 4022);
export const MOCK_PORT = BASE;
export const STAGE_PORT = BASE + 320;
export const PROD_PORT = BASE + 321;
export const PREVIEW_SECRET = 'e2e-preview-secret-not-for-production';

export default defineConfig({
  testDir: 'tests',
  testMatch: '*.spec.ts',
  reporter: 'list',
  workers: 1,
  use: { baseURL: `http://127.0.0.1:${STAGE_PORT}`, trace: 'retain-on-failure', locale: 'ru-RU', timezoneId: 'Asia/Novosibirsk' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node tests/mock-api.ts',
      env: { MOCK_PORT: String(MOCK_PORT), MOCK_PREVIEW_SECRET: PREVIEW_SECRET },
      url: `http://127.0.0.1:${MOCK_PORT}/api/public/v1/cities`,
      reuseExistingServer: false,
    },
    {
      command: 'npm run build && node dist/server/entry.mjs',
      env: { HOST: '127.0.0.1', PORT: String(STAGE_PORT), API_URL: `http://127.0.0.1:${MOCK_PORT}`, APP_ENV: 'stage', PREVIEW_SECRET,
        // Стенд e2e без кэша контента: переключатели мока видны сразу; ETag/304 всё равно работает. Кэш 60 с – на бою и в tests/site/content-cache.test.ts.
        CONTENT_CACHE_TTL_SECONDS: '0' },
      url: `http://127.0.0.1:${STAGE_PORT}/robots.txt`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      // Та же сборка, другой режим: сборка уже лежит в dist после первого сервера.
      command: 'node dist/server/entry.mjs',
      env: {
        HOST: '127.0.0.1', PORT: String(PROD_PORT), API_URL: `http://127.0.0.1:${MOCK_PORT}`,
        APP_ENV: 'prod', PUBLIC_SITE_URL: 'https://yu-club.test',
        // Loopback здесь не доверенный прокси: e2e проверяет, что подделанный X-Forwarded-For не проходит.
        TRUSTED_PROXIES: '10.0.0.0/8',
      },
      url: `http://127.0.0.1:${PROD_PORT}/robots.txt`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});

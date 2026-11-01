// e2e сайта без бэкенда: мок публичного API (tests/mock-api.ts) + собранный сайт, смотрящий в мок через API_URL.
// Режим стенда (APP_ENV=stage): noindex везде. Бой проверяется вторым сервером на том же моке (APP_ENV=prod).
import { defineConfig, devices } from '@playwright/test';

export const MOCK_PORT = 4022;
export const STAGE_PORT = 4342;
export const PROD_PORT = 4343;

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
      env: { MOCK_PORT: String(MOCK_PORT) },
      url: `http://127.0.0.1:${MOCK_PORT}/api/public/v1/cities`,
      reuseExistingServer: false,
    },
    {
      command: 'npm run build && node dist/server/entry.mjs',
      env: { HOST: '127.0.0.1', PORT: String(STAGE_PORT), API_URL: `http://127.0.0.1:${MOCK_PORT}`, APP_ENV: 'stage' },
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

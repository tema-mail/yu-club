// e2e CRM без бэкенда: мок API (tests/mock-api.ts) + собранная CRM, смотрящая в мок через API_URL.
import { defineConfig, devices } from '@playwright/test';

const MOCK_PORT = 4012;
const CRM_PORT = 4332;

export default defineConfig({
  testDir: 'tests',
  testMatch: '*.spec.ts',
  reporter: 'list',
  use: { baseURL: `http://127.0.0.1:${CRM_PORT}`, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: `node tests/mock-api.ts`,
      // Страница по 2 филиала: Владелец (3 филиала) проверяет проход курсора до конца.
      env: { MOCK_PORT: String(MOCK_PORT), MOCK_PAGE_SIZE: '2' },
      url: `http://127.0.0.1:${MOCK_PORT}/api/crm/v1/me`,
      reuseExistingServer: false,
    },
    {
      command: `npm run build && node dist/server/entry.mjs`,
      env: { HOST: '127.0.0.1', PORT: String(CRM_PORT), API_URL: `http://127.0.0.1:${MOCK_PORT}` },
      url: `http://127.0.0.1:${CRM_PORT}/login`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});

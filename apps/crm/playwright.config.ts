// e2e CRM без бэкенда: мок API (tests/mock-api.ts) + собранная CRM, смотрящая в мок через API_URL.
import { defineConfig, devices } from '@playwright/test';
import { fixE2eClock } from '../../tests/support/e2e.ts';

// Весь прогон – в одном зафиксированном «сейчас»: засевы от текущего времени не зависят от часа запуска (tests/support/e2e.ts).
fixE2eClock();

// Порты можно сдвинуть через E2E_PORT_BASE (несколько прогонов на одной машине): мок = база, CRM = база+320, сайт = база+321.
const BASE = Number(process.env.E2E_PORT_BASE ?? 4012);
const MOCK_PORT = BASE;
// Спеки берут адрес мока из MOCK_URL – задаём его здесь, чтобы E2E_PORT_BASE хватало одного (воркеры наследуют env).
process.env.MOCK_URL ??= `http://127.0.0.1:${MOCK_PORT}`;
const CRM_PORT = BASE + 320;
// Предпросмотр K22 §11: «сайт» внутренней сети поднимает сам tests/content-preview.spec.ts.
export const SITE_PORT = BASE + 321;
export const PREVIEW_SECRET = 'e2e-preview-secret-not-for-production';

export default defineConfig({
  testDir: 'tests',
  testMatch: '*.spec.ts',
  reporter: 'list',
  // Один мок на все файлы, а S0-15 меняет данные (создание, архив): файлы идут по очереди, каждый меняющий
  // начинает с POST /__test/reset – чтение в crm.spec не видит чужих черновиков.
  workers: 1,
  use: { baseURL: `http://127.0.0.1:${CRM_PORT}`, trace: 'retain-on-failure', locale: 'ru-RU', timezoneId: 'Asia/Novosibirsk' },
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
      env: { HOST: '127.0.0.1', PORT: String(CRM_PORT), API_URL: `http://127.0.0.1:${MOCK_PORT}`, SITE_INTERNAL_URL: `http://127.0.0.1:${SITE_PORT}`, PREVIEW_SECRET },
      url: `http://127.0.0.1:${CRM_PORT}/login`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});

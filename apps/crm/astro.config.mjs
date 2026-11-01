// CRM: SSR (адаптер node) + острова Preact (S0-14). Почему SSR, а не статика с островами:
// 1) CRM целиком за входом – сессия проверяется на сервере ДО отдачи HTML, без мигания меню и экранов;
// 2) меню и переключатель контекста строятся на сервере из GET /me (K11 №1), в браузер не уходит лишнее;
// 3) адрес API (API_URL) читается в рантайме – подмена мок ↔ бэкенд одной переменной без пересборки;
// 4) кука yu_staff (K12) живёт на домене CRM: браузер ходит в /api/crm/v1/* этого же сервера, тот проксирует в API_URL;
// 5) ADR 0001 уже держит отдельный контейнер `crm` в Compose.
import { defineConfig } from 'astro/config';
import preact from '@astrojs/preact';
import node from '@astrojs/node';

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  integrations: [preact()],
  server: { host: '127.0.0.1', port: 4331 },
  devToolbar: { enabled: false },
});

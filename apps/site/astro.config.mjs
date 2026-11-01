// Публичный сайт: SSR (адаптер node) + острова Preact (S1-18), как CRM.
// Почему SSR, а не статика: филиалы, адреса и часы – из API на каждый запрос (12 приёмка 23), город и филиал
// посетителя – из куки yu_branch на сервере, режим индексации (APP_ENV) и адрес API (API_URL) – в рантайме,
// без пересборки при смене стенд ↔ бой. trailingSlash: 'always' – адреса со слешем в конце (карта сайта п.2.1).
import { defineConfig } from 'astro/config';
import preact from '@astrojs/preact';
import node from '@astrojs/node';

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  integrations: [preact()],
  trailingSlash: 'always',
  server: { host: '127.0.0.1', port: 4341 },
  devToolbar: { enabled: false },
});

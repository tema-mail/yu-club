import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['.claude/', 'node_modules/', 'dist/', 'docs/', 'tz/', 'apps/crm/dist/', 'apps/crm/.astro/', 'apps/crm/test-results/', 'apps/crm/playwright-report/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);

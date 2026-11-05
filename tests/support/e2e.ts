// Единое «сейчас» e2e CRM и сайта: засевы мока считаются от текущего времени, и с 23:00 до 00:30 по Новосибирску (бронь через полночь, «вчера» у идущего сеанса)
// и в конце месяца проверки падали. Поэтому весь прогон живёт в одном моменте: playwright.config вызывает fixE2eClock(), мок, сервер и процессы тестов получают
// сдвиг через NODE_OPTIONS, браузер – через test из этого файла. Спеки импортируют test и expect отсюда, а не из @playwright/test (tests/core/e2e-clock.test.ts).
// Часы идут обычным ходом от этого момента; page.clock работает поверх. E2E_NOW – прогнать в другое время: E2E_NOW=2026-11-11T23:30:00+07:00 npm run test:crm.
import { fileURLToPath } from 'node:url';
import { test as base } from '@playwright/test';
import { shiftDate } from './clock-shim.ts';

export { expect } from '@playwright/test';
export type { APIRequestContext, Page } from '@playwright/test';

export const E2E_NOW_DEFAULT = '2026-11-11T12:00:00+07:00'; // среда в середине месяца, филиалы открыты

/** Вызывается из playwright.config.ts. Конфиг читают и процессы тестов: сдвиг считается один раз, дальше берётся из окружения. */
export function fixE2eClock(): void {
  if (process.env.E2E_CLOCK_OFFSET_MS !== undefined) return;
  const target = Date.parse(process.env.E2E_NOW ?? E2E_NOW_DEFAULT);
  if (Number.isNaN(target)) throw new Error(`E2E_NOW: неверная дата ${process.env.E2E_NOW}`);
  process.env.E2E_CLOCK_OFFSET_MS = String(target - Date.now());
  const preload = fileURLToPath(new URL('./fixed-now.ts', import.meta.url));
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --import ${preload}`.trim();
}

export const test = base.extend({
  // Любой контекст – и обычный page, и browser.newContext в снимках – создаётся здесь, поэтому браузер получает тот же сдвиг.
  browser: [
    async ({ browser }, use) => {
      const offset = Number(process.env.E2E_CLOCK_OFFSET_MS ?? 0);
      const newContext = browser.newContext.bind(browser);
      browser.newContext = async (options) => {
        const context = await newContext(options);
        await context.addInitScript(shiftDate, offset);
        return context;
      };
      await use(browser);
    },
    { scope: 'worker' },
  ],
});

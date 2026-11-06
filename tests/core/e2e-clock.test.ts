// Правило «одна ошибка – один раз»: e2e CRM и сайта идут в зафиксированном «сейчас» (tests/support/e2e.ts). Новый спек с прямым импортом @playwright/test
// получил бы браузер с настоящими часами против мока со сдвинутыми – и снова падал бы ночью и в конце месяца.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { shiftDate } from '../support/clock-shim.ts';

const root = join(import.meta.dirname, '..', '..');
const specs = ['apps/crm/tests', 'apps/site/tests'].flatMap((dir) => readdirSync(join(root, dir)).filter((f) => f.endsWith('.spec.ts')).map((f) => join(dir, f)));

describe('зафиксированное время e2e', () => {
  it('спеки берут test из tests/support/e2e.ts, а не из @playwright/test', () => {
    expect(specs.length).toBeGreaterThan(30);
    const direct = specs.filter((f) => readFileSync(join(root, f), 'utf8').includes("from '@playwright/test'"));
    expect(direct).toEqual([]);
  });

  it('оба конфига фиксируют часы', () => {
    for (const app of ['crm', 'site']) expect(readFileSync(join(root, 'apps', app, 'playwright.config.ts'), 'utf8')).toContain('fixE2eClock()');
  });

  it('сдвиг: new Date() и Date.now() от нового момента, явная дата и instanceof – как обычно', () => {
    const Real = globalThis.Date;
    try {
      shiftDate(3_600_000);
      expect(Math.abs(Date.now() - Real.now() - 3_600_000)).toBeLessThan(1000);
      expect(Math.abs(new Date().getTime() - Real.now() - 3_600_000)).toBeLessThan(1000);
      expect(new Date('2026-01-01T00:00:00Z').toISOString()).toBe('2026-01-01T00:00:00.000Z');
      expect(new Date() instanceof Real).toBe(true);
      expect(Date.UTC(2026, 0, 1)).toBe(Real.UTC(2026, 0, 1));
      expect(typeof Date()).toBe('string');
    } finally {
      globalThis.Date = Real;
      delete (globalThis as unknown as { __e2eClockShifted?: boolean }).__e2eClockShifted;
    }
  });
});

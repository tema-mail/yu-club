// ADR 0002 п.1: модуль events не читает чужие таблицы SQL-запросом – занятость и удержания через booking/providers.ts,
// ресурсы через resources/index.ts, тарифы через pricing/tariff.ts. Известные исключения по импортам – D3-15 в reshenia.md.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const DIR = new URL('../../apps/api/src/modules/events/', import.meta.url);
const FOREIGN = /\bapp\.(resources|rooms|resource_units|occupancy_units|occupancy|resource_block_units|resource_blocks|holds|hold_items|bookings|tariffs)\b/;

describe('ADR 0002: events и чужие таблицы', () => {
  it('ни один файл модуля не упоминает таблицы booking, resources и pricing в SQL', () => {
    const offenders = readdirSync(DIR)
      .filter((f) => f.endsWith('.ts'))
      .flatMap((f) => readFileSync(new URL(f, DIR), 'utf8').split('\n').map((line, i) => ({ f, i: i + 1, line })))
      .filter(({ line }) => FOREIGN.test(line))
      .map(({ f, i }) => `${f}:${i}`);
    expect(offenders).toEqual([]);
  });
});

// Страж Э5: у каждого контрольного сценария TC-01…TC-20 (tz/20 §10, матрица docs/tc-matrica.md) есть хотя бы один
// интеграционный тест на настоящей Postgres, проходящий сценарий целиком, с именем, начинающимся на «TC-NN:».
// Куски по разным файлам (describe с номером, «(TC-NN)» в хвосте имени) не считаются: имя носит только сценарий целиком.
// Падает, если сценарий остался без такого теста, и если тест назван так в экранных спеках, но не в интеграции.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');
const SELF = relative(root, import.meta.filename);
const TCS = Array.from({ length: 20 }, (_, i) => `TC-${String(i + 1).padStart(2, '0')}`);
/** Имя теста сразу за it( / test( / it.each(...)( и т. п., начинающееся на TC-NN: – одна строка, как принято в репозитории. */
const NAME_RE = /^\s*(?:it|test)(?:\.\w+)*\((?:[^\n]*\))?\s*\(?\s*['"`](TC-\d{2}):/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === 'node_modules' ? [] : walk(p);
    return p.endsWith('.ts') ? [p] : [];
  });
}
/** Файл → список TC из имён тестов. */
function namedTests(files: string[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const f of files) {
    const found = new Set<string>();
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      const m = NAME_RE.exec(line);
      if (m) found.add(m[1]!);
    }
    if (found.size > 0) out.set(relative(root, f), found);
  }
  return out;
}

const integration = namedTests(walk(join(root, 'tests')).filter((f) => f.endsWith('.test.ts') && relative(root, f) !== SELF));
const screens = namedTests(['apps/crm/tests', 'apps/site/tests', 'tests/e2e'].flatMap((d) => walk(join(root, d))).filter((f) => f.endsWith('.spec.ts')));
const coveredBy = (map: Map<string, Set<string>>, tc: string) => [...map.entries()].filter(([, s]) => s.has(tc)).map(([f]) => f);

describe('покрытие TC-01…TC-20 (tz/20 §10)', () => {
  it.each(TCS)('%s: есть интеграционный тест tests/**/*.test.ts с именем «TC-NN: …»', (tc) => {
    expect(coveredBy(integration, tc), `${tc} без теста целиком – см. docs/tc-matrica.md`).not.toEqual([]);
  });

  it('экранные спеки с именем TC-NN: не подменяют интеграцию: у каждого такого TC есть и интеграционный тест', () => {
    const onlyScreens = TCS.filter((tc) => coveredBy(screens, tc).length > 0 && coveredBy(integration, tc).length === 0);
    expect(onlyScreens).toEqual([]);
  });

  it('гонки TC-01…TC-04 – в tests/booking/tc-races.test.ts (N параллельных соединений, план §8)', () => {
    for (const tc of ['TC-01', 'TC-02', 'TC-03', 'TC-04']) expect(coveredBy(integration, tc)).toContain('tests/booking/tc-races.test.ts');
    const src = readFileSync(join(root, 'tests/booking/tc-races.test.ts'), 'utf8');
    expect(src).toContain('Promise.all');
    expect(src).toContain('overlapsInDb');
  });
});

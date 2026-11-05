// ADR 0002, K24 §1: модуль reports читает чужие данные только через rpt_* и публичные входы модулей (index.ts), чужих таблиц и внутренних файлов не касается.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const DIR = join(import.meta.dirname, '../../apps/api/src/modules/reports');
const files = readdirSync(DIR).filter((f) => f.endsWith('.ts')).map((f) => ({ name: f, text: readFileSync(join(DIR, f), 'utf8') }));
// свои таблицы reports (K24 шапка): журнал сверки и задачи экспорта
const OWN = new Set(['app.reconcile_runs', 'journal.reconcile_discrepancies', 'app.report_exports']);

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
}, 60_000);
afterAll(async () => {
  await db.drop();
});

describe('границы модуля reports (ADR 0002)', () => {
  it('из других модулей импортируются только index.ts', () => {
    const bad = files.flatMap((f) =>
      [...f.text.matchAll(/from '\.\.\/([a-z]+)\/([a-z.-]+\.ts)'/g)].filter((m) => m[1] !== 'core' && m[2] !== 'index.ts').map((m) => `${f.name}: ${m[0]}`),
    );
    expect(bad).toEqual([]);
  });

  it('из SQL видны только представления rpt_* и свои таблицы', () => {
    const bad = files.flatMap((f) =>
      [...f.text.matchAll(/\b(app|journal)\.([a-z_]+)/g)]
        .filter((m) => !m[2]!.startsWith('rpt_') && !OWN.has(m[0]) && !['register', 'get', 'post'].includes(m[2]!))
        .map((m) => `${f.name}: ${m[0]}`),
    );
    expect(bad).toEqual([]);
  });

  it('у yu_reports нет прав на справочник кассы напрямую', async () => {
    const r = await db.client.query<{ ok: boolean }>(`SELECT has_table_privilege('yu_reports', 'app.finance_categories', 'SELECT') AS ok`);
    expect(r.rows[0]!.ok).toBe(false);
  });
});

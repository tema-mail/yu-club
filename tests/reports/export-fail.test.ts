// «Одна ошибка – один раз»: сбой базы внутри fail() задачи экспорта не уходит необработанным отказом промиса
// (раньше ронял worker), а у долгоживущего worker есть process.on('unhandledRejection') с логом.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { FileStore } from '../../apps/api/src/core/files.ts';
import { noNetwork } from '../../apps/api/src/core/permissions.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import type { Pool } from '../../apps/api/src/modules/clients/index.ts';
import { runExportJob, type ExportRunDeps } from '../../apps/api/src/modules/reports/export.ts';

type JobRow = Parameters<typeof runExportJob>[1];

describe('reports:export – сбой БД в fail()', () => {
  it('runExportJob не отклоняется, ошибка fail() уходит в лог', async () => {
    const down = () => Promise.reject(new Error('connection terminated'));
    const pool = { query: down, connect: down } as unknown as Pool; // загрузка прав и транзакция fail() – обе падают
    const store = { remove: () => Promise.resolve() } as unknown as FileStore;
    const logged: unknown[] = [];
    const deps: ExportRunDeps = { pool, reports: {} as ExportRunDeps['reports'], store, network: noNetwork, clock: fixedClock('2026-11-20T05:00:00Z'), log: (e) => logged.push(e) };
    const row = { id: '00000000-0000-0000-0000-000000000001', staff_id: '00000000-0000-0000-0000-000000000002', report: 'bookings', format: 'csv', params: {}, detail: false, masked: true, status: 'running' } as unknown as JobRow;
    await expect(runExportJob(deps, row)).resolves.toBeUndefined();
    expect(logged.map((e) => (e as Error).message)).toContain('connection terminated');
  });
});

describe('worker: необработанный отказ промиса не проходит молча', () => {
  it('apps/api/src/worker.ts: есть process.on("unhandledRejection") с логом', () => {
    const src = readFileSync('apps/api/src/worker.ts', 'utf8');
    expect(src).toMatch(/process\.on\(\s*['"]unhandledRejection['"][\s\S]{0,200}log\(/);
  });
});

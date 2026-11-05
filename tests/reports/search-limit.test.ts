// Поиск идёт основным пулом (K24 §5): одновременных поисков не больше предела, лишний – RATE_LIMITED, а не очередь к пулу брони и оплаты (17 §6).
import { afterEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { MAX_CONCURRENT_SEARCHES, globalSearch } from '../../apps/api/src/modules/reports/search.ts';

const ctx = { actor: { kind: 'staff', staffId: 'x', sessionId: 'y' }, role: 'owner', network: true, cityIds: new Set(), branchIds: new Set(), at: new Date() } as unknown as AccessContext;
const meta = { actor: ctx.actor, source: 'crm', requestId: 'r' } as never;

afterEach(() => vi.restoreAllMocks());

describe('предел одновременных поисков', () => {
  it('сверх предела – 429; после завершения снова можно', async () => {
    const waiters: Array<(c: pg.PoolClient) => void> = [];
    const idle = { query: async () => ({ rows: [], rowCount: 0 }), release: () => {}, processID: 1 } as unknown as pg.PoolClient;
    const pool = { connect: () => new Promise<pg.PoolClient>((r) => waiters.push(r)), query: async () => ({ rows: [], rowCount: 0 }) } as never;
    const deps = { pool, clock: fixedClock('2026-11-20T05:00:00Z') };
    const running = Array.from({ length: MAX_CONCURRENT_SEARCHES }, () => globalSearch(deps, ctx, meta, 'имя'));
    await new Promise((r) => setTimeout(r, 10));
    await expect(globalSearch(deps, ctx, meta, 'имя')).rejects.toMatchObject({ code: 'RATE_LIMITED', httpStatus: 429 });
    for (const w of waiters) w(idle);
    await Promise.allSettled(running);
    const again = globalSearch(deps, ctx, meta, 'имя');
    await new Promise((r) => setTimeout(r, 10));
    waiters[waiters.length - 1]!(idle);
    await Promise.allSettled([again]);
    expect(waiters).toHaveLength(MAX_CONCURRENT_SEARCHES + 1);
  });

  it('ошибка поиска освобождает место', async () => {
    const pool = { connect: async () => { throw new Error('нет связи'); }, query: async () => ({ rows: [] }) } as never;
    const deps = { pool, clock: fixedClock('2026-11-20T05:00:00Z') };
    for (let i = 0; i < MAX_CONCURRENT_SEARCHES + 2; i += 1) await expect(globalSearch(deps, ctx, meta, 'имя')).rejects.toThrow('нет связи');
  });
});

// S2-30: миграция 0203, счёт баллов, партии, FEFO, «долг», returnSpend, getBalance (K15 §1–§3, §7).
// Property-based: случайные последовательности (свой генератор с зерном – воспроизводимо без внешней зависимости)
// начислений, штрафов, списаний, возвратов, сторно и истечений → Σ remaining = max(0, баланс), баланс = Σ K3,
// кэш каждой партии = amount + Σ её движений, партии не уходят в минус.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyBalance, type Tx } from '../../apps/api/src/core/ledger.ts';
import {
  createBatch,
  debitBatches,
  getBalance,
  openAccount,
  postPoints,
  returnSpend,
  reverseWithBatches,
  SYSTEM_AUTHOR,
} from '../../apps/api/src/modules/loyalty/account.ts';
import { migrateDown, migrateUp } from '../../db/migrate.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

let db: TestDatabase;
let pool: pg.Pool;
const DAY = 86_400_000;

async function inTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}
const newClient = async (): Promise<string> =>
  (await db.client.query<{ id: string }>(`INSERT INTO app.clients (phone_e164, first_name, status, created_by_type, registered_at) VALUES ($1, 'Т', 'active', 'system', now()) RETURNING id`, [`+7913${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`])).rows[0]!.id;

async function accrue(clientId: string, amount: number, at: Date, expiresAt: Date | null): Promise<{ entryId: number; batchId: string }> {
  return inTx(async (tx) => {
    await openAccount(tx, clientId, at);
    const p = await postPoints(tx, clientId, { amount, type: 'loyalty.accrual', branchId: null, occurredAt: at }, randomUUID(), SYSTEM_AUTHOR);
    const batchId = await createBatch(tx, { clientId, entryId: p.entryId, amount, balanceBefore: p.balanceBefore, source: 'visit', branchId: null, expiresAt, accruedAt: at });
    return { entryId: p.entryId, batchId };
  });
}
async function debit(clientId: string, amount: number, type: 'loyalty.penalty' | 'loyalty.spend_time', at: Date): Promise<number> {
  return inTx(async (tx) => {
    await openAccount(tx, clientId, at);
    const p = await postPoints(tx, clientId, { amount: -amount, type, branchId: null, occurredAt: at }, randomUUID(), SYSTEM_AUTHOR);
    await debitBatches(tx, { clientId, entryId: p.entryId, amount, balanceBefore: p.balanceBefore, kind: type === 'loyalty.penalty' ? 'penalty' : 'spend_time' });
    return p.entryId;
  });
}
const balanceOf = async (clientId: string, at: Date) => (await getBalance(pool, clientId, at)).balanceCenti;

async function assertInvariant(clientId: string, label: string): Promise<void> {
  const acc = (await db.client.query<{ id: string; balance: string }>(`SELECT id, balance FROM app.ledger_accounts WHERE owner_id = $1`, [clientId])).rows[0]!;
  const v = await verifyBalance(pool, acc.id);
  expect(v.ok, `${label}: кэш K3`).toBe(true);
  const sum = Number((await db.client.query<{ s: string | null }>(`SELECT sum(remaining_centi) AS s FROM app.loyalty_batches WHERE client_id = $1 AND status = 'active'`, [clientId])).rows[0]!.s ?? 0);
  expect(sum, `${label}: Σ remaining = max(0, баланс)`).toBe(Math.max(0, Number(acc.balance)));
  const bad = await db.client.query(
    `SELECT b.id, b.remaining_centi, b.amount_centi + COALESCE(sum(m.delta_centi), 0) AS computed FROM app.loyalty_batches b
     LEFT JOIN journal.loyalty_batch_moves m ON m.batch_id = b.id WHERE b.client_id = $1
     GROUP BY b.id HAVING b.remaining_centi <> b.amount_centi + COALESCE(sum(m.delta_centi), 0) OR b.remaining_centi < 0
        OR (b.status = 'active' AND b.remaining_centi = 0) OR (b.status = 'depleted' AND b.remaining_centi > 0)`,
    [clientId],
  );
  expect(bad.rows, `${label}: кэш партий = amount + Σ движений, статус по остатку`).toEqual([]);
}

/** Детерминированный генератор (mulberry32) – воспроизводимая последовательность по зерну. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 6 });
});
afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('миграция 0203', () => {
  it('вниз и снова вверх на базе с данными Э1; движения партий – только вставка', async () => {
    const t = await createTestDatabase({ migrate: true });
    try {
      // откат до 0203 включительно – вместе с более поздними миграциями (раннер откатывает с конца)
      const later = (await t.client.query<{ version: string }>(`SELECT version FROM public.schema_migrations WHERE version >= '0203' ORDER BY version`)).rows.map((r) => r.version);
      expect((await migrateDown(t.client, later.length)).at(-1)).toBe('0203');
      expect((await t.client.query(`SELECT to_regclass('app.loyalty_batches') AS r`)).rows[0].r).toBeNull();
      expect(await migrateUp(t.client)).toEqual(later);
      expect((await t.client.query(`SELECT to_regclass('app.loyalty_reserves') AS r`)).rows[0].r).not.toBeNull();
      expect((await t.client.query(`SELECT * FROM journal.append_only_violations()`)).rows).toEqual([]);
    } finally {
      await t.drop();
    }
  });
});

describe('партии и долг (K15 §2)', () => {
  it('штраф ниже нуля уходит в долг, начисление сначала гасит долг (debt_cover)', async () => {
    const c = await newClient();
    const at = new Date('2026-11-15T07:00:00Z');
    await accrue(c, 300, at, null);
    await debit(c, 500, 'loyalty.penalty', at);
    expect(await balanceOf(c, at)).toBe(-200);
    await assertInvariant(c, 'после штрафа');
    const { batchId } = await accrue(c, 1000, at, null);
    const b = (await db.client.query(`SELECT remaining_centi, status FROM app.loyalty_batches WHERE id = $1`, [batchId])).rows[0];
    expect(b).toEqual({ remaining_centi: '800', status: 'active' });
    await assertInvariant(c, 'после начисления');
  });

  it('FEFO: сначала партия с ближайшим сроком, бессрочная – последней', async () => {
    const c = await newClient();
    const at = new Date('2026-11-15T07:00:00Z');
    const never = await accrue(c, 500, at, null);
    const late = await accrue(c, 500, at, new Date(at.getTime() + 30 * DAY));
    const soon = await accrue(c, 500, at, new Date(at.getTime() + 10 * DAY));
    await debit(c, 700, 'loyalty.spend_time', at);
    const rem = async (id: string) => Number((await db.client.query(`SELECT remaining_centi FROM app.loyalty_batches WHERE id = $1`, [id])).rows[0].remaining_centi);
    expect([await rem(soon.batchId), await rem(late.batchId), await rem(never.batchId)]).toEqual([0, 300, 500]);
    await assertInvariant(c, 'FEFO');
  });

  it('истечение при открытии счёта: loyalty.expire на остаток, партия expired', async () => {
    const c = await newClient();
    const at = new Date('2026-11-15T07:00:00Z');
    await accrue(c, 400, at, new Date(at.getTime() + DAY));
    await inTx((tx) => openAccount(tx, c, new Date(at.getTime() + 2 * DAY)));
    expect(await balanceOf(c, at)).toBe(0);
    await assertInvariant(c, 'истечение');
  });
});

describe('возврат в исходную партию (K15 §7, 18 §6.3 п.9)', () => {
  it('часть из истёкшей партии – «не возвращено», остальное – в свою партию с прежним сроком', async () => {
    const c = await newClient();
    const at = new Date('2026-11-15T07:00:00Z');
    const exp1 = new Date(at.getTime() + DAY);
    const exp2 = new Date(at.getTime() + 60 * DAY);
    const a = await accrue(c, 300, at, exp1);
    const b = await accrue(c, 500, at, exp2);
    const spend = await debit(c, 600, 'loyalty.spend_time', at); // 300 из a, 300 из b
    const later = new Date(at.getTime() + 3 * DAY);
    const r = await inTx((tx) => returnSpend(tx, { originalEntryId: spend, reason: 'возврат платежа', idempotencyKey: `ret-${spend}`, author: SYSTEM_AUTHOR, occurredAt: later }));
    expect(r).toMatchObject({ returnedCenti: 300, notReturnedCenti: 300 });
    expect(await balanceOf(c, later)).toBe(500);
    const rows = (await db.client.query(`SELECT id, remaining_centi, expires_at, status FROM app.loyalty_batches WHERE id = ANY($1::uuid[])`, [[a.batchId, b.batchId]])).rows;
    expect(rows.find((x) => x.id === b.batchId)).toMatchObject({ remaining_centi: '500', status: 'active', expires_at: exp2 });
    expect(rows.find((x) => x.id === a.batchId)).toMatchObject({ remaining_centi: '0', status: 'expired' });
    await assertInvariant(c, 'возврат');
    // повтор с тем же ключом – тот же ответ; другой ключ – ALREADY_REVERSED
    expect(await inTx((tx) => returnSpend(tx, { originalEntryId: spend, reason: 'повтор', idempotencyKey: `ret-${spend}`, author: SYSTEM_AUTHOR, occurredAt: later }))).toEqual(r);
    await expect(inTx((tx) => returnSpend(tx, { originalEntryId: spend, reason: 'ещё', idempotencyKey: randomUUID(), author: SYSTEM_AUTHOR, occurredAt: later }))).rejects.toMatchObject({ code: 'ALREADY_REVERSED' });
  });

  it('возврат при долге сначала гасит долг', async () => {
    const c = await newClient();
    const at = new Date('2026-11-15T07:00:00Z');
    await accrue(c, 500, at, null);
    const spend = await debit(c, 500, 'loyalty.spend_time', at);
    await debit(c, 300, 'loyalty.penalty', at);
    expect(await balanceOf(c, at)).toBe(-300);
    await inTx((tx) => returnSpend(tx, { originalEntryId: spend, reason: 'возврат', idempotencyKey: randomUUID(), author: SYSTEM_AUTHOR, occurredAt: at }));
    expect(await balanceOf(c, at)).toBe(200);
    await assertInvariant(c, 'возврат при долге');
  });

  it('сторно штрафа: взятое из истёкшей партии истекает снова', async () => {
    const c = await newClient();
    const at = new Date('2026-11-15T07:00:00Z');
    await accrue(c, 300, at, new Date(at.getTime() + DAY));
    const pen = await debit(c, 300, 'loyalty.penalty', at);
    const later = new Date(at.getTime() + 2 * DAY);
    await inTx(async (tx) => {
      await openAccount(tx, c, later);
      await reverseWithBatches(tx, { clientId: c, entryId: pen, reason: 'неявка ошибочна', idempotencyKey: `rev-${pen}`, author: SYSTEM_AUTHOR, occurredAt: later });
    });
    expect(await balanceOf(c, later)).toBe(0);
    await assertInvariant(c, 'сторно с истёкшей партией');
  });
});

describe('getBalance', () => {
  it('нет счёта – нули; −50 – preBookingBlocked; ближайшее истечение', async () => {
    const c = await newClient();
    const at = new Date('2026-11-15T07:00:00Z');
    expect(await getBalance(pool, c, at)).toEqual({ balanceCenti: 0, availableCenti: 0, reservedCenti: 0, nextExpiry: null, preBookingBlocked: false, accrualBasis: 'planned' });
    const exp = new Date(at.getTime() + 5 * DAY);
    await accrue(c, 250, at, exp);
    expect((await getBalance(pool, c, at)).nextExpiry).toEqual({ at: exp.toISOString(), centi: 250 });
    await debit(c, 500, 'loyalty.penalty', at);
    await debit(c, 500, 'loyalty.penalty', at);
    await debit(c, 500, 'loyalty.penalty', at);
    await debit(c, 500, 'loyalty.penalty', at);
    await debit(c, 500, 'loyalty.penalty', at);
    await debit(c, 500, 'loyalty.penalty', at);
    await debit(c, 500, 'loyalty.penalty', at);
    await debit(c, 500, 'loyalty.penalty', at);
    await debit(c, 500, 'loyalty.penalty', at);
    await debit(c, 500, 'loyalty.penalty', at);
    await debit(c, 250, 'loyalty.penalty', at);
    expect(await getBalance(pool, c, at)).toMatchObject({ balanceCenti: -5000, availableCenti: 0, preBookingBlocked: true });
  });
});

describe('property-based: случайные последовательности сохраняют инвариант (K15 §14)', () => {
  for (const seed of [1, 7, 42, 99, 314]) {
    it(`зерно ${seed}`, async () => {
      const rand = rng(seed);
      const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
      const c = await newClient();
      let now = new Date('2026-11-15T07:00:00Z');
      const spends: number[] = [];
      const penalties: number[] = [];
      const accruals: Array<{ entryId: number; amount: number }> = [];
      for (let step = 0; step < 45; step++) {
        await inTx((tx) => openAccount(tx, c, now)); // баланс – после ленивого истечения
        const bal = await balanceOf(c, now);
        const op = pick(['accrue', 'accrue', 'penalty', 'spend', 'spend', 'return', 'unpenalty', 'unaccrue', 'time']);
        if (op === 'accrue') {
          const amount = 50 * (1 + Math.floor(rand() * 20));
          const ttl = pick([null, 1, 3, 10]);
          const r = await accrue(c, amount, now, ttl === null ? null : new Date(now.getTime() + ttl * DAY));
          accruals.push({ entryId: r.entryId, amount });
        } else if (op === 'penalty') {
          const applied = Math.min(0, Math.max(-500, -5000 - bal)); // K15 §5
          if (applied < 0) penalties.push(await debit(c, -applied, 'loyalty.penalty', now));
        } else if (op === 'spend') {
          const max = Math.max(0, bal);
          if (max >= 50) spends.push(await debit(c, 50 * (1 + Math.floor(rand() * (max / 50))), 'loyalty.spend_time', now));
        } else if (op === 'return' && spends.length > 0) {
          const id = spends.splice(Math.floor(rand() * spends.length), 1)[0]!;
          await inTx((tx) => returnSpend(tx, { originalEntryId: id, reason: 'возврат', idempotencyKey: `ret-${id}`, author: SYSTEM_AUTHOR, occurredAt: now }));
        } else if (op === 'unpenalty' && penalties.length > 0) {
          const id = penalties.splice(Math.floor(rand() * penalties.length), 1)[0]!;
          await inTx(async (tx) => {
            await openAccount(tx, c, now);
            await reverseWithBatches(tx, { clientId: c, entryId: id, reason: 'исправление', idempotencyKey: `rev-${id}`, author: SYSTEM_AUTHOR, occurredAt: now });
          });
        } else if (op === 'unaccrue' && accruals.length > 0) {
          const i = Math.floor(rand() * accruals.length);
          if (bal - accruals[i]!.amount >= -5000) {
            const { entryId } = accruals.splice(i, 1)[0]!;
            await inTx(async (tx) => {
              await openAccount(tx, c, now);
              await reverseWithBatches(tx, { clientId: c, entryId, reason: 'исправление посещения', idempotencyKey: `rev-${entryId}`, author: SYSTEM_AUTHOR, occurredAt: now });
            });
          }
        } else if (op === 'time') {
          now = new Date(now.getTime() + Math.floor(rand() * 4) * DAY);
          await inTx((tx) => openAccount(tx, c, now));
        }
        await assertInvariant(c, `зерно ${seed}, шаг ${step} (${op})`);
      }
      // последовательность не вырожденная: в журнале есть все виды операций
      const kinds = (await db.client.query<{ k: string }>(
        `SELECT DISTINCT e.entry_type AS k FROM journal.ledger_entries e JOIN app.ledger_accounts a ON a.id = e.account_id WHERE a.owner_id = $1`, [c])).rows.map((r) => r.k);
      expect(kinds.length, kinds.join(',')).toBeGreaterThanOrEqual(5);
    });
  }
});

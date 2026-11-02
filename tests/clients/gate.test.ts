// S2-33: ворота записи в clients (K9): registerBookingGate, необязательный обход в assertCanBook.
// Без ворот – поведение Э1 (статусы клиента); ворота с отказом роняют assertCanBook; обход доходит до ворот.
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../../apps/api/src/core/errors.ts';
import { assertCanBook, clearBookingGates, registerBookingGate, type BookingGate } from '../../apps/api/src/modules/clients/index.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

let db: TestDatabase;
let pool: pg.Pool;
const at = new Date('2026-11-15T07:00:00Z');
const client = async (status: string) =>
  (await db.client.query<{ id: string }>(
    `INSERT INTO app.clients (phone_e164, first_name, status, status_until, created_by_type, registered_at) VALUES ($1, 'К', $2, $3, 'system', CASE WHEN $2 = 'guest' THEN NULL ELSE now() END) RETURNING id`,
    [`+7913${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`, status, status === 'restricted' ? '2026-12-01' : null],
  )).rows[0]!.id;
const code = (p: Promise<unknown>) => p.then(() => 'ok', (err: { code?: string }) => err.code ?? String(err));

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 2 });
});
afterAll(async () => {
  clearBookingGates();
  await pool.end();
  await db.drop();
});
afterEach(() => clearBookingGates());

describe('assertCanBook без ворот – как в Э1', () => {
  it('active и guest – можно; blocked и restricted до срока – CLIENT_RESTRICTED; нет клиента – NOT_FOUND', async () => {
    expect(await code(assertCanBook(pool, await client('active'), at))).toBe('ok');
    expect(await code(assertCanBook(pool, await client('guest'), at))).toBe('ok');
    expect(await code(assertCanBook(pool, await client('blocked'), at))).toBe('CLIENT_RESTRICTED');
    expect(await code(assertCanBook(pool, await client('restricted'), at))).toBe('CLIENT_RESTRICTED');
    expect(await code(assertCanBook(pool, '00000000-0000-0000-0000-00000000dead', at))).toBe('NOT_FOUND');
  });
});

describe('ворота', () => {
  it('отказ ворот роняет assertCanBook; обход передаётся воротам', async () => {
    const seen: Array<{ clientId: string; override?: { reason: string; staffId: string } }> = [];
    const gate: BookingGate = {
      name: 'test',
      check: async (_tx, input) => {
        seen.push(input);
        if (!input.override) throw new AppError('LOYALTY_LIMIT_REACHED', 403, 'нельзя');
      },
    };
    registerBookingGate(gate);
    const id = await client('active');
    expect(await code(assertCanBook(pool, id, at))).toBe('LOYALTY_LIMIT_REACHED');
    const override = { reason: 'по решению директора', staffId: '00000000-0000-0000-0000-000000000077' };
    expect(await code(assertCanBook(pool, id, at, { override: { loyaltyLimit: override } }))).toBe('ok');
    expect(seen.at(-1)).toEqual({ clientId: id, at, override });
  });

  it('статус клиента проверяется раньше ворот; дубль имени ворот – ошибка старта', async () => {
    let called = false;
    registerBookingGate({ name: 'g', check: async () => void (called = true) });
    expect(await code(assertCanBook(pool, await client('blocked'), at))).toBe('CLIENT_RESTRICTED');
    expect(called).toBe(false);
    expect(() => registerBookingGate({ name: 'g', check: async () => {} })).toThrow(/уже зарегистрированы/);
  });
});

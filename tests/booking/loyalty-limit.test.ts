// S2-35: проверка −50 в удержании и обход в CRM (K15 §8, K11 изменение №4, TC-10 «новая запись блокируется», R-13).
// createHold и attachHold известного клиента → LOYALTY_LIMIT_REACHED; бронь в CRM: Администратор – отказ (и с полем
// обхода – FORBIDDEN), Директор с причиной – бронь и запись аудита loyalty.booked_below_limit.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import type { Clock } from '../../apps/api/src/core/time.ts';
import { createStaffBooking } from '../../apps/api/src/modules/booking/change.ts';
import { attachHold, createHold } from '../../apps/api/src/modules/booking/hold.ts';
import { runOccupancyCommand } from '../../apps/api/src/modules/booking/occupancy.ts';
import { clearBookingGates, registerBookingGate } from '../../apps/api/src/modules/clients/index.ts';
import { debitBatches, openAccount, postPoints, SYSTEM_AUTHOR } from '../../apps/api/src/modules/loyalty/account.ts';
import { loyaltyGate } from '../../apps/api/src/modules/loyalty/gate.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const SYS = '00000000-0000-0000-0000-000000000001';
const clock: Clock = { now: () => new Date('2026-11-14T05:00:00Z') };
let db: TestDatabase;
let pool: pg.Pool;
const ids: Record<string, string> = {};
let hour = 0;

async function one<T = { id: string }>(sql: string, params: unknown[] = []): Promise<T> {
  return (await db.client.query(sql, params)).rows[0] as T;
}
const newClient = async () => (await one(`INSERT INTO app.clients (phone_e164, first_name, status, created_by_type, registered_at) VALUES ($1, 'К', 'active', 'system', now()) RETURNING id`, [`+7913${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`])).id;
/** Клиент на −50: десять штрафов по −5 (K3 + партии). */
async function blockedClient(): Promise<string> {
  const clientId = await newClient();
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await openAccount(c, clientId, clock.now());
    for (let i = 0; i < 10; i++) {
      const p = await postPoints(c, clientId, { amount: -500, type: 'loyalty.penalty', branchId: null, occurredAt: clock.now() }, randomUUID(), SYSTEM_AUTHOR);
      await debitBatches(c, { clientId, entryId: p.entryId, amount: 500, balanceBefore: p.balanceBefore, kind: 'penalty' });
    }
    await c.query('COMMIT');
  } finally {
    c.release();
  }
  return clientId;
}
const slot = () => {
  const start = new Date(Date.parse('2026-11-16T04:00:00Z') + hour++ * 3_600_000);
  return { resourceId: ids.pc!, start, end: new Date(start.getTime() + 3_600_000) };
};
const codeOf = (p: Promise<unknown>) => p.then(() => 'ok', (err: { code?: string }) => err.code ?? String(err));
const ctxOf = (staffId: string, role: 'owner' | 'director' | 'admin'): AccessContext => ({
  actor: { kind: 'staff', staffId, sessionId: randomUUID() }, role, network: role === 'owner', cityIds: new Set(), branchIds: new Set(role === 'owner' ? [] : [ids.b1!]), at: clock.now(),
});
const metaOf = (ctx: AccessContext): AuditRequestMeta => ({ actor: ctx.actor, source: 'crm', requestId: randomUUID() });
const staffBook = (ctx: AccessContext, clientId: string, override?: { reason: string }) => {
  const s = slot();
  return runOccupancyCommand(pool, (tx) =>
    createStaffBooking(tx, { ctx, branchId: ids.b1!, resourceId: s.resourceId, start: s.start, end: s.end, client: { clientId }, overrideLoyaltyLimit: override }, metaOf(ctx), clock),
  );
};

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
  const city = await one(`INSERT INTO app.cities (code, slug, name, timezone) VALUES ('nsk', 'nsk', 'НСК', 'Asia/Novosibirsk') RETURNING id`);
  ids.b1 = (await one(`INSERT INTO app.branches (city_id, code, slug, name, address, timezone, status) VALUES ($1, 'b1', 'b1', 'b1', 'а', 'Asia/Novosibirsk', 'active') RETURNING id`, [city.id])).id;
  await db.client.query(`INSERT INTO app.branch_weekly_hours (branch_id, weekday, open_time, close_time, valid_from, created_by) SELECT $1, d, '00:00', '23:30', '2026-01-01', $2 FROM generate_series(1, 7) d`, [ids.b1, SYS]);
  await db.client.query(`INSERT INTO app.tariffs (branch_id, resource_type, name, unit_minutes, price_per_unit_kop, valid_from, status, created_by) VALUES ($1, 'pc', 'ПК', 30, 100, '2026-01-01', 'active', $2)`, [ids.b1, SYS]);
  const u = await one(`INSERT INTO app.occupancy_units (branch_id, code, name) VALUES ($1, 'PC1', 'PC1') RETURNING id`, [ids.b1]);
  ids.pc = (await one(`INSERT INTO app.resources (branch_id, resource_type, name) VALUES ($1, 'pc', 'ПК-1') RETURNING id`, [ids.b1])).id;
  await db.client.query(`INSERT INTO app.resource_units (resource_id, unit_id, valid_from) VALUES ($1, $2, '2026-01-01')`, [ids.pc, u.id]);
  for (const role of ['owner', 'director', 'admin'] as const) {
    ids[role] = (await one(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('С', 'С', $1, $2, 'x') RETURNING id`, [`${role}@yu.test`, role])).id;
  }
  clearBookingGates();
  registerBookingGate(loyaltyGate); // как buildServer (S2-34)
});
afterAll(async () => {
  clearBookingGates();
  await pool.end();
  await db.drop();
});

describe('сайт: удержание известного клиента на −50', () => {
  it('createHold → LOYALTY_LIMIT_REACHED; посетитель (клиент неизвестен) – удержание создаётся', async () => {
    const c = await blockedClient();
    expect(await codeOf(runOccupancyCommand(pool, (tx) => createHold(tx, { clientId: c, visitorId: null }, { branchId: ids.b1!, items: [slot()] }, clock)))).toBe('LOYALTY_LIMIT_REACHED');
    expect(await codeOf(runOccupancyCommand(pool, (tx) => createHold(tx, { clientId: null, visitorId: randomUUID() }, { branchId: ids.b1!, items: [slot()] }, clock)))).toBe('ok');
  });

  it('attachHold удержания посетителя клиенту на −50 → LOYALTY_LIMIT_REACHED, удержание остаётся посетителю', async () => {
    const c = await blockedClient();
    const visitorId = randomUUID();
    const h = await runOccupancyCommand(pool, (tx) => createHold(tx, { clientId: null, visitorId }, { branchId: ids.b1!, items: [slot()] }, clock));
    expect(await codeOf(runOccupancyCommand(pool, (tx) => attachHold(tx, c, visitorId, h.id, clock)))).toBe('LOYALTY_LIMIT_REACHED');
    expect((await one<{ client_id: string | null }>('SELECT client_id FROM app.holds WHERE id = $1', [h.id])).client_id).toBeNull();
  });
});

describe('CRM: бронь администратором (K11 №4)', () => {
  it('Администратор: без обхода – LOYALTY_LIMIT_REACHED, с обходом – FORBIDDEN', async () => {
    const c = await blockedClient();
    const admin = ctxOf(ids.admin!, 'admin');
    expect(await codeOf(staffBook(admin, c))).toBe('LOYALTY_LIMIT_REACHED');
    expect(await codeOf(staffBook(admin, c, { reason: 'очень просили' }))).toBe('FORBIDDEN');
  });

  it('Директор с причиной – бронь и запись аудита; без причины – COMMENT_REQUIRED', async () => {
    const c = await blockedClient();
    const director = ctxOf(ids.director!, 'director');
    expect(await codeOf(staffBook(director, c, { reason: '  ' }))).toBe('COMMENT_REQUIRED');
    const bookingId = await staffBook(director, c, { reason: 'постоянный клиент, решение директора' });
    const audit = await db.client.query(`SELECT actor_id, reason FROM journal.audit_events WHERE action = 'loyalty.booked_below_limit' AND object_id = $1`, [bookingId]);
    expect(audit.rows).toEqual([{ actor_id: ids.director, reason: 'постоянный клиент, решение директора' }]);
  });

  it('клиент выше −50: обход не нужен и не пишется в аудит', async () => {
    const c = await newClient();
    const bookingId = await staffBook(ctxOf(ids.admin!, 'admin'), c, { reason: 'на всякий случай' });
    expect((await db.client.query(`SELECT 1 FROM journal.audit_events WHERE action = 'loyalty.booked_below_limit' AND object_id = $1`, [bookingId])).rowCount).toBe(0);
  });
});

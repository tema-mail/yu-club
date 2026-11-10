// S2-32: штраф за неявку (K15 §5, TC-10, TC-11). Настоящие команды брони (markNoShow, revertVisit, cancelBooking)
// и outbox: события no_show.* доставляются processEvent, в том числе повторно и не по порядку.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { clearSubscriptions, processEvent } from '../../apps/api/src/core/outbox.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import type { Clock } from '../../apps/api/src/core/time.ts';
import { cancelBooking } from '../../apps/api/src/modules/booking/change.ts';
import { confirmHold } from '../../apps/api/src/modules/booking/confirm.ts';
import { createHold } from '../../apps/api/src/modules/booking/hold.ts';
import { runOccupancyCommand } from '../../apps/api/src/modules/booking/occupancy.ts';
import { paymentBookingProvider } from '../../apps/api/src/modules/booking/providers.ts';
import { markNoShow, revertVisit } from '../../apps/api/src/modules/booking/visit.ts';
import { clearBookingGates, registerBookingGate } from '../../apps/api/src/modules/clients/index.ts';
import { debitBatches, getBalance, openAccount, postPoints, SYSTEM_AUTHOR } from '../../apps/api/src/modules/loyalty/account.ts';
import { loyaltyGate } from '../../apps/api/src/modules/loyalty/gate.ts';
import { applyPenalty, clipPenalty, PENALTY_HANDLERS, registerPenaltyHandlers } from '../../apps/api/src/modules/loyalty/penalty.ts';
import { lockAccounts } from '../../apps/api/src/core/ledger.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const SYS = '00000000-0000-0000-0000-000000000001';
let now = new Date('2026-11-15T07:00:00Z');
const clock: Clock = { now: () => now };
let db: TestDatabase;
let pool: pg.Pool;
const ids: Record<string, string> = {};
let owner: AccessContext;
let day = 0;

async function one<T = { id: string }>(sql: string, params: unknown[] = []): Promise<T> {
  return (await db.client.query(sql, params)).rows[0] as T;
}
async function inTx<T>(fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
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
const meta = (): AuditRequestMeta => ({ actor: owner.actor, source: 'crm', requestId: randomUUID() });
const rowVersion = async (id: string) => Number((await one<{ row_version: number }>('SELECT row_version FROM app.bookings WHERE id = $1', [id])).row_version);
const newClient = async () => (await one(`INSERT INTO app.clients (phone_e164, first_name, status, created_by_type, registered_at) VALUES ($1, 'К', 'active', 'system', now()) RETURNING id`, [`+7913${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`])).id;

/** Брони клиента подряд (каждая по часу) с 12:00 местного нового дня; часы – после их конца. */
async function book(clientId: string, count = 1, gapHours = 0): Promise<string[]> {
  const base = Date.parse('2026-11-16T05:00:00Z') + day++ * 86_400_000;
  now = new Date(base - 3_600_000);
  const items = Array.from({ length: count }, (_, i) => {
    const start = new Date(base + i * (1 + gapHours) * 3_600_000);
    return { resourceId: i % 2 === 0 ? ids.pc! : ids.pc2!, start, end: new Date(start.getTime() + 3_600_000) };
  });
  const h = await runOccupancyCommand(pool, (c) => createHold(c, { clientId, visitorId: null }, { branchId: ids.b1!, items }, clock));
  const r = await runOccupancyCommand(pool, (c) => confirmHold(c, clientId, h.id, clock));
  now = new Date(base + count * (1 + gapHours) * 3_600_000);
  return [...r.bookings].sort((a, b) => Date.parse(a.start) - Date.parse(b.start)).map((b) => b.id);
}
const noShow = async (id: string) => runOccupancyCommand(pool, async (c) => markNoShow(c, id, { ctx: owner, rowVersion: await rowVersion(id) }, meta(), clock));
const revert = async (id: string) => runOccupancyCommand(pool, async (c) => revertVisit(c, id, { ctx: owner, rowVersion: await rowVersion(id), reason: 'ошибка' }, meta(), clock));
const eventsOf = async (type: string, bookingId: string) =>
  (await db.client.query<{ id: string }>(`SELECT id FROM app.outbox_events WHERE event_type = $1 AND payload ->> 'bookingId' = $2 ORDER BY occurred_at, xmin::text::bigint`, [type, bookingId])).rows.map((r) => r.id);
const deliver = (handler: string, eventId: string) => processEvent(pool, handler, eventId, now);
async function redeliver(handler: string, eventId: string): Promise<void> {
  await db.client.query('DELETE FROM app.processed_events WHERE handler = $1 AND event_id = $2', [handler, eventId]);
  await deliver(handler, eventId);
}
const marked = async (bookingId: string) => deliver(PENALTY_HANDLERS.marked, (await eventsOf('no_show.marked', bookingId)).at(-1)!);
const unmarked = async (bookingId: string) => deliver(PENALTY_HANDLERS.reverted, (await eventsOf('no_show.reverted', bookingId)).at(-1)!);
const balance = async (c: string) => (await getBalance(pool, c, now)).balanceCenti;
const penalties = (bookingId: string) => db.client.query('SELECT status, applied_centi FROM app.loyalty_penalties WHERE booking_id = $1 ORDER BY created_at', [bookingId]).then((r) => r.rows);
/** Довести баланс до `target` штрафами (через K3 и партии), ниже −50 – корректировкой Владельца. */
async function setBalance(c: string, target: number): Promise<void> {
  await inTx(async (tx) => {
    const acc = await openAccount(tx, c, now);
    let left = acc.balance - target;
    while (left > 0) {
      const d = Math.min(500, left);
      const bal = (await getBalance(tx, c, now)).balanceCenti;
      const override = bal - d < -5000 ? { reason: 'корректировка Владельца' } : undefined;
      const p = await postPoints(tx, c, { amount: -d, type: override ? 'loyalty.manual' : 'loyalty.penalty', basis: override?.reason, branchId: null, occurredAt: now }, randomUUID(), override ? { type: 'staff', id: ids.owner! } : SYSTEM_AUTHOR, override);
      await debitBatches(tx, { clientId: c, entryId: p.entryId, amount: d, balanceBefore: p.balanceBefore, kind: 'manual' });
      left -= d;
    }
  });
}
const setNetwork = (key: string, value: unknown) =>
  db.client.query(`INSERT INTO app.settings_values (key, level, value, valid_from, created_by) VALUES ($1, 'network', $2::jsonb, '2026-01-01', $3)`, [key, JSON.stringify(value), SYS]);

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 6 });
  const city = await one(`INSERT INTO app.cities (code, slug, name, timezone) VALUES ('nsk', 'nsk', 'НСК', 'Asia/Novosibirsk') RETURNING id`);
  ids.b1 = (await one(`INSERT INTO app.branches (city_id, code, slug, name, address, timezone, status) VALUES ($1, 'b1', 'b1', 'b1', 'а', 'Asia/Novosibirsk', 'active') RETURNING id`, [city.id])).id;
  await db.client.query(`INSERT INTO app.branch_weekly_hours (branch_id, weekday, open_time, close_time, valid_from, created_by) SELECT $1, d, '10:00', '23:00', '2026-01-01', $2 FROM generate_series(1, 7) d`, [ids.b1, SYS]);
  await db.client.query(`INSERT INTO app.tariffs (branch_id, resource_type, name, unit_minutes, price_per_unit_kop, valid_from, status, created_by) VALUES ($1, 'pc', 'ПК', 30, 100, '2026-01-01', 'active', $2)`, [ids.b1, SYS]);
  const u = await one(`INSERT INTO app.occupancy_units (branch_id, code, name) VALUES ($1, 'PC1', 'PC1') RETURNING id`, [ids.b1]);
  ids.pc = (await one(`INSERT INTO app.resources (branch_id, resource_type, name) VALUES ($1, 'pc', 'ПК-1') RETURNING id`, [ids.b1])).id;
  await db.client.query(`INSERT INTO app.resource_units (resource_id, unit_id, valid_from) VALUES ($1, $2, '2026-01-01')`, [ids.pc, u.id]);
  const u2 = await one(`INSERT INTO app.occupancy_units (branch_id, code, name) VALUES ($1, 'PC2', 'PC2') RETURNING id`, [ids.b1]);
  ids.pc2 = (await one(`INSERT INTO app.resources (branch_id, resource_type, name) VALUES ($1, 'pc', 'ПК-2') RETURNING id`, [ids.b1])).id;
  await db.client.query(`INSERT INTO app.resource_units (resource_id, unit_id, valid_from) VALUES ($1, $2, '2026-01-01')`, [ids.pc2, u2.id]);
  ids.owner = (await one(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('В', 'В', 'o@yu.test', 'owner', 'x') RETURNING id`)).id;
  owner = { actor: { kind: 'staff', staffId: ids.owner, sessionId: randomUUID() }, role: 'owner', network: true, cityIds: new Set(), branchIds: new Set(), at: now };
  clearSubscriptions();
  registerPenaltyHandlers({ bookings: paymentBookingProvider, clock });
});
afterAll(async () => {
  clearSubscriptions();
  await pool.end();
  await db.drop();
});

it('clipPenalty: −43 → −5, −48 → −2, −50 → 0, −52 → 0 (не +2)', () => {
  expect([clipPenalty(-4300), clipPenalty(-4800), clipPenalty(-5000), clipPenalty(-5200), clipPenalty(1000)]).toEqual([-500, -200, 0, 0, -500]);
});

describe('penalties_from = null (D2-03) – штрафы выключены', () => {
  it('неявка → строка skipped, баланс не меняется', async () => {
    const c = await newClient();
    const [b] = await book(c);
    await noShow(b!);
    await marked(b!);
    expect(await penalties(b!)).toEqual([{ status: 'skipped', applied_centi: '0' }]);
    expect(await balance(c)).toBe(0);
  });
});

describe('штрафы включены с даты запуска', () => {
  beforeAll(async () => {
    await setNetwork('loyalty.penalties_from', '2026-11-01T00:00:00.000Z');
  });

  it('неявка до penalties_from – без штрафа', async () => {
    const c = await newClient();
    const [b] = await book(c);
    await noShow(b!);
    const noShowId = (await one<{ id: string }>(`SELECT id FROM app.no_shows WHERE booking_id = $1`, [b])).id;
    const r = await inTx((tx) => applyPenalty(tx, { noShowId, bookingId: b!, markedAt: new Date('2026-10-30T10:00:00Z') }, { bookings: paymentBookingProvider, clock }));
    expect(r).toBe('skipped');
    expect(await balance(c)).toBe(0);
  });

  it('TC-10: −48 → штраф −2 → −50; следующая неявка – событие без изменения баланса; новая запись блокируется (LOYALTY_LIMIT_REACHED)', async () => {
    const c = await newClient();
    await setBalance(c, -4800);
    const [b1] = await book(c);
    await noShow(b1!);
    const ev = (await eventsOf('no_show.marked', b1!))[0]!;
    await deliver(PENALTY_HANDLERS.marked, ev);
    await redeliver(PENALTY_HANDLERS.marked, ev);
    expect(await penalties(b1!)).toEqual([{ status: 'active', applied_centi: '-200' }]);
    expect(await balance(c)).toBe(-5000);
    const [b2] = await book(c);
    await noShow(b2!);
    await marked(b2!);
    expect(await penalties(b2!)).toEqual([{ status: 'active', applied_centi: '0' }]);
    expect(await balance(c)).toBe(-5000);
    // новая запись блокируется: ворота −50 (их подключает buildServer, S2-34) – удержание известного клиента отказывает
    registerBookingGate(loyaltyGate);
    try {
      const start = new Date(now.getTime() + 86_400_000);
      const items = [{ resourceId: ids.pc!, start, end: new Date(start.getTime() + 3_600_000) }];
      const code = await runOccupancyCommand(pool, (tx) => createHold(tx, { clientId: c, visitorId: null }, { branchId: ids.b1!, items }, clock)).then(() => 'ok', (e: { code?: string }) => e.code);
      expect(code).toBe('LOYALTY_LIMIT_REACHED');
      expect((await one<{ n: number }>(`SELECT count(*)::int n FROM app.holds WHERE client_id = $1 AND status = 'active'`, [c])).n).toBe(0);
    } finally {
      clearBookingGates();
    }
  });

  it('при −52 (ниже предела по праву Владельца) штраф 0, баланс −52, а не −50', async () => {
    const c = await newClient();
    await setBalance(c, -5200);
    const [b] = await book(c);
    await noShow(b!);
    await marked(b!);
    expect(await penalties(b!)).toEqual([{ status: 'active', applied_centi: '0' }]);
    expect(await balance(c)).toBe(-5200);
  });

  it('цепочка подряд – один штраф; исправление первой – штраф переходит на вторую; исправление второй – сторно', async () => {
    const c = await newClient();
    const [a, b] = await book(c, 2);
    await noShow(a!);
    await noShow(b!);
    await marked(b!);
    await marked(a!);
    expect([...(await penalties(a!)), ...(await penalties(b!))].map((x) => x.status).sort()).toEqual(['active', 'merged']);
    expect(await balance(c)).toBe(-500);
    const head = (await penalties(b!))[0]!.status === 'active' ? b! : a!;
    const tail = head === a ? b! : a!;
    await revert(head);
    await unmarked(head);
    expect(await penalties(tail)).toEqual([{ status: 'active', applied_centi: '-500' }]);
    expect(await balance(c)).toBe(-500);
    await revert(tail);
    await unmarked(tail);
    expect((await penalties(tail))[0]).toMatchObject({ status: 'reversed' });
    expect(await balance(c)).toBe(0);
  });

  it('брони с перерывом – отдельные штрафы', async () => {
    const c = await newClient();
    const [a, b] = await book(c, 2, 1);
    await noShow(a!);
    await noShow(b!);
    await marked(a!);
    await marked(b!);
    expect(await balance(c)).toBe(-1000);
  });

  it('исправление пришло раньше отметки – итог без штрафа', async () => {
    const c = await newClient();
    const [b] = await book(c);
    await noShow(b!);
    await revert(b!);
    await unmarked(b!);
    await marked(b!);
    expect(await penalties(b!)).toEqual([]);
    expect(await balance(c)).toBe(0);
  });

  it('TC-11: отмена клубом – события неявки нет, штрафа нет', async () => {
    const c = await newClient();
    const [b] = await book(c);
    now = new Date(now.getTime() - 3 * 3_600_000); // до начала сеанса
    const reasonId = (await one(`SELECT id FROM app.dict_reasons WHERE domain = 'booking_cancel_club' AND code = 'equipment_failure'`)).id;
    await runOccupancyCommand(pool, async (tx) => cancelBooking(tx, b!, { kind: 'staff', ctx: owner, rowVersion: await rowVersion(b!), initiator: 'club', reasonId, comment: 'сломался ПК' }, meta(), clock));
    expect(await eventsOf('no_show.marked', b!)).toEqual([]);
    expect(await penalties(b!)).toEqual([]);
    expect(await balance(c)).toBe(0);
  });
});

/** Единый порядок K17 «Решения 02.11»: команда под счётом баллов берёт бронь FOR UPDATE, пока обработчик ждёт блокировку.
 *  Обработчик в порядке «бронь FOR SHARE → счёт» даёт 40P01. */
async function underAccountThenBooking(clientId: string, bookingId: string, handler: () => Promise<unknown>): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const acc = await one(`SELECT id FROM app.ledger_accounts WHERE kind = 'loyalty_client' AND owner_id = $1`, [clientId]);
    await lockAccounts(c, [acc.id]);
    const run = handler();
    for (let i = 0; i < 200; i++) {
      if ((await one<{ n: number }>(`SELECT count(*)::int n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)).n > 0) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    await c.query('SELECT 1 FROM app.bookings WHERE id = $1 FOR UPDATE', [bookingId]);
    await c.query('COMMIT');
    await run;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

describe('ревизия 02.11: порядок блокировок – счёт до брони (penalties_from уже стоит – блок выше)', () => {
  it('штраф и его исправление параллельно с командой «счёт → бронь» – без дедлока', async () => {
    const c = await newClient();
    await setBalance(c, 0); // счёт есть, баланс 0
    const [b] = await book(c);
    await noShow(b!);
    await underAccountThenBooking(c, b!, () => marked(b!));
    expect(await penalties(b!)).toEqual([{ status: 'active', applied_centi: '-500' }]);
    await revert(b!);
    await underAccountThenBooking(c, b!, () => unmarked(b!));
    expect((await penalties(b!)).map((x) => x.status)).toEqual(['reversed']);
    expect(await balance(c)).toBe(0);
  });
});

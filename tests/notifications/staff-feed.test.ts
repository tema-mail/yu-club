// S4-28 (13 §11, D4-46): лента событий CRM на настоящей Postgres и настоящем outbox. Двойная доставка события → одна строка;
// смена – только её сотруднику; ремонт – зоне филиала с equipment.view; не дошедшее критичное сервисное клиенту – зоне с
// notifications.view (триггер 0420), реклама и подтверждение брони – нет; чужая зона не видна, прочтение чужого – 404;
// прочтение у каждого своё; курсор и «прочитать все».
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearSubscriptions, processEvent, publish, type EventPayload } from '../../apps/api/src/core/outbox.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import {
  FEED_HANDLERS, feedUnreadCount, listStaffFeed, markAllFeedRead, markFeedRead, registerStaffFeedHandlers,
} from '../../apps/api/src/modules/notifications/staff-feed.ts';
import { createTestBranch } from '../helpers/network.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const clock = fixedClock('2026-11-14T05:00:00Z');
let db: TestDatabase;
let pool: pg.Pool;
let b1: string;
let b2: string;
let n = 0;
let version = 1;
const staff: Record<'owner' | 'dir1' | 'dir2' | 'admin1' | 'admin1b', string> = { owner: '', dir1: '', dir2: '', admin1: '', admin1b: '' };
const ctx: Record<keyof typeof staff, AccessContext> = {} as never;

const newStaff = async (role: string) =>
  (await db.client.query<{ id: string }>(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', $1, $2, 'x') RETURNING id`, [`s${n++}@yu.test`, role])).rows[0]!.id;
const access = (staffId: string, role: 'owner' | 'director' | 'admin', branches: string[], network = false): AccessContext =>
  ({ actor: { kind: 'staff', staffId, sessionId: 's' }, role, network, cityIds: new Set(), branchIds: new Set(branches), at: clock.now() });

async function emit<T extends 'shift.changed' | 'repair.registered' | 'repair.closed'>(type: T, aggregateId: string, branchId: string, payload: EventPayload<T>): Promise<string> {
  const aggregateType = type === 'shift.changed' ? 'shift' : 'repair';
  const v = type === 'repair.registered' ? 1 : type === 'repair.closed' ? 'closed' : version++;
  return (await publish(db.client, { type, aggregateType, aggregateId, aggregateVersion: v, branchId, occurredAt: clock.now(), payload })).eventId;
}
const shiftChanged = (staffId: string, branchId: string, kind: 'created' | 'updated' | 'cancelled' = 'updated', changedBy = staff.dir1) => {
  const shiftId = randomUUID();
  return emit('shift.changed', shiftId, branchId, {
    shiftId, staffId, branchId, branchTimezone: 'Asia/Novosibirsk', changedBy, kind,
    before: kind === 'created' ? null : { start: '2026-11-16T03:00:00Z', end: '2026-11-16T11:00:00Z', branchId },
    after: kind === 'cancelled' ? null : { start: '2026-11-16T05:00:00Z', end: '2026-11-16T13:00:00Z', branchId },
    reason: 'замена',
  });
};
const repairRegistered = (repairId: string, branchId: string, number = 'Р-1') =>
  emit('repair.registered', repairId, branchId, { repairId, number, equipmentId: randomUUID(), branchId, priority: 'critical', impact: 'full', autoBlockId: randomUUID() });
const feedRows = async (kind: string) => (await db.client.query<{ id: string; branch_id: string; staff_id: string | null; title: string; body: string | null }>(
  `SELECT id, branch_id, staff_id, title, body FROM app.staff_feed_events WHERE kind = $1 ORDER BY created_at, id`, [kind])).rows;
const byEvent = async (kind: string, eventId: string) => (await db.client.query<{ id: string; title: string; body: string | null }>(
  `SELECT id, title, body FROM app.staff_feed_events WHERE dedupe_key = $1`, [`${kind}:${eventId}`])).rows[0];
const ids = async (who: keyof typeof staff) => (await listStaffFeed(pool, ctx[who], { limit: 50 })).items.map((i) => i.id);

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
  b1 = (await createTestBranch(db.client)).id;
  b2 = (await createTestBranch(db.client)).id;
  staff.owner = await newStaff('owner');
  staff.dir1 = await newStaff('director');
  staff.dir2 = await newStaff('director');
  staff.admin1 = await newStaff('admin');
  staff.admin1b = await newStaff('admin');
  ctx.owner = access(staff.owner, 'owner', [], true);
  ctx.dir1 = access(staff.dir1, 'director', [b1]);
  ctx.dir2 = access(staff.dir2, 'director', [b2]);
  ctx.admin1 = access(staff.admin1, 'admin', [b1]);
  ctx.admin1b = access(staff.admin1b, 'admin', [b1]);
  clearSubscriptions();
  registerStaffFeedHandlers({ clock });
});
afterAll(async () => {
  clearSubscriptions();
  await pool.end();
  await db.drop();
});

describe('обработчики outbox', () => {
  it('двойная доставка shift.changed – одна строка, в том числе мимо processed_events', async () => {
    const id = await shiftChanged(staff.admin1, b1);
    await processEvent(pool, FEED_HANDLERS.shiftChanged, id, clock.now());
    await processEvent(pool, FEED_HANDLERS.shiftChanged, id, clock.now());
    await db.client.query(`DELETE FROM app.processed_events WHERE event_id = $1`, [id]);
    await processEvent(pool, FEED_HANDLERS.shiftChanged, id, clock.now());
    const rows = (await feedRows('shift_changed')).filter((r) => r.staff_id === staff.admin1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe('Ваша смена изменена');
    expect(rows[0]!.body).toBe('Было: 16 ноября, 10:00–18:00. Стало: 16 ноября, 12:00–20:00. Причина: замена'); // по НСК, не UTC
  });

  it('смена видна только её сотруднику: коллега того же филиала, Директор и Владелец её не видят', async () => {
    const id = await shiftChanged(staff.admin1, b1, 'cancelled');
    await processEvent(pool, FEED_HANDLERS.shiftChanged, id, clock.now());
    const row = await byEvent('shift_changed', id);
    expect(row!.title).toBe('Ваша смена отменена');
    expect(await ids('admin1')).toContain(row!.id);
    for (const who of ['admin1b', 'dir1', 'owner'] as const) expect(await ids(who)).not.toContain(row!.id);
    await expect(markFeedRead(pool, ctx.admin1b, row!.id, clock.now())).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
  });

  it('свою смену сотрудник правил сам – строки нет', async () => {
    const before = (await feedRows('shift_changed')).length;
    await processEvent(pool, FEED_HANDLERS.shiftChanged, await shiftChanged(staff.admin1, b1, 'created', staff.admin1), clock.now());
    expect(await feedRows('shift_changed')).toHaveLength(before);
  });

  it('ремонт: зона филиала с equipment.view; чужой филиал не видит; закрытие берёт номер регистрации', async () => {
    const repairId = randomUUID();
    const reg = await repairRegistered(repairId, b1, 'Р-77');
    await processEvent(pool, FEED_HANDLERS.repairRegistered, reg, clock.now());
    await processEvent(pool, FEED_HANDLERS.repairRegistered, reg, clock.now());
    const [row] = (await feedRows('repair_registered')).filter((r) => r.title.includes('Р-77'));
    expect(row).toMatchObject({ branch_id: b1, staff_id: null, title: 'Новый ремонт № Р-77', body: 'Приоритет критичный, полный простой, ресурс заблокирован' });
    for (const who of ['admin1', 'admin1b', 'dir1', 'owner'] as const) expect(await ids(who)).toContain(row!.id);
    expect(await ids('dir2')).not.toContain(row!.id);
    await expect(markFeedRead(pool, ctx.dir2, row!.id, clock.now())).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const closed = await emit('repair.closed', repairId, b1, { repairId, branchId: b1, finalEquipmentStatus: 'in_service', stillBlockedIds: [randomUUID()] });
    await processEvent(pool, FEED_HANDLERS.repairClosed, closed, clock.now());
    const c = await byEvent('repair_closed', closed);
    expect(c).toMatchObject({ title: 'Ремонт № Р-77 закрыт', body: 'Остались блокировки: 1 – снимите их в карточке ремонта' });
  });
});

describe('не дошедшее критичное сервисное клиенту (K21 §9, триггер 0420)', () => {
  let phone = 79160000000;
  const notice = async (kind: string, category: string, branchId: string | null = b1) => {
    const clientId = (await db.client.query<{ id: string }>(`INSERT INTO app.clients (phone_e164, status, created_by_type) VALUES ($1, 'active', 'system') RETURNING id`, [`+${phone++}`])).rows[0]!.id;
    const id = (await db.client.query<{ id: string }>(
      `INSERT INTO app.notifications (client_id, branch_id, category, kind, source, title, body, planned_at, dedupe_key, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'system', 'Ю-Клуб: мероприятие отменено', 'т', $5, $6, $5, $5) RETURNING id`,
      [clientId, branchId, category, kind, clock.now(), `t:${randomUUID()}`],
    )).rows[0]!.id;
    return { id, clientId };
  };
  const setStatus = (id: string, status: string) => db.client.query(`UPDATE app.notifications SET status = $2, updated_at = $3 WHERE id = $1`, [id, status, clock.now()]);

  it('error и no_channel у отмены/переноса – одна строка зоне с notifications.view; повтор статуса – без второй', async () => {
    const a = await notice('event_cancelled', 'service');
    await setStatus(a.id, 'sending');
    await setStatus(a.id, 'error');
    await setStatus(a.id, 'planned');
    await setStatus(a.id, 'error');
    const b = await notice('event_rescheduled', 'service');
    await setStatus(b.id, 'no_channel');
    const rows = (await db.client.query<{ ref_id: string; ref_type: string; action: string; title: string; body: string }>(
      `SELECT ref_id, ref_type, action, title, body FROM app.staff_feed_events WHERE kind = 'service_notification_failed' ORDER BY created_at, id`)).rows;
    expect(rows.filter((r) => r.ref_id === a.clientId)).toHaveLength(1);
    expect(rows.find((r) => r.ref_id === a.clientId)).toMatchObject({ ref_type: 'client', action: 'notifications.view', title: 'Клиент не получил: Ю-Клуб: мероприятие отменено' });
    expect(rows.find((r) => r.ref_id === b.clientId)!.body).toContain('Нет канала push');
    const visible = (await listStaffFeed(pool, ctx.admin1, { limit: 50 })).items.filter((i) => i.kind === 'service_notification_failed');
    expect(visible.map((i) => i.refId)).toEqual(expect.arrayContaining([a.clientId, b.clientId]));
    expect((await listStaffFeed(pool, ctx.dir2, { limit: 50 })).items.filter((i) => i.kind === 'service_notification_failed')).toHaveLength(0);
  });

  it('реклама, подтверждение брони и строка без филиала в ленту не попадают', async () => {
    const before = (await feedRows('service_notification_failed')).length;
    const m = await notice('campaign', 'marketing');
    await setStatus(m.id, 'error');
    const c = await notice('event_cancelled', 'service', null);
    await setStatus(c.id, 'error');
    expect(await feedRows('service_notification_failed')).toHaveLength(before);
  });
});

describe('прочтение и страницы', () => {
  it('прочтение у каждого своё; повтор не меняет время; «прочитать все» – только видимые не новее before', async () => {
    const repairId = randomUUID();
    await processEvent(pool, FEED_HANDLERS.repairRegistered, await repairRegistered(repairId, b1, 'Р-90'), clock.now());
    const [row] = (await feedRows('repair_registered')).filter((r) => r.title.includes('Р-90'));
    const unreadAdmin = await feedUnreadCount(pool, ctx.admin1);
    const unreadB = await feedUnreadCount(pool, ctx.admin1b);
    await markFeedRead(pool, ctx.admin1, row!.id, clock.now());
    await markFeedRead(pool, ctx.admin1, row!.id, new Date(clock.now().getTime() + 60_000));
    expect(await feedUnreadCount(pool, ctx.admin1)).toBe(unreadAdmin - 1);
    expect(await feedUnreadCount(pool, ctx.admin1b)).toBe(unreadB);
    const reads = (await db.client.query<{ read_at: Date }>(`SELECT read_at FROM app.staff_feed_reads WHERE event_id = $1`, [row!.id])).rows;
    expect(reads).toHaveLength(1);
    expect(reads[0]!.read_at.toISOString()).toBe(clock.now().toISOString());
    const page = await listStaffFeed(pool, ctx.admin1, { limit: 50 });
    expect(page.items.find((i) => i.id === row!.id)).toMatchObject({ read: true, refType: 'repair', refId: repairId });
    expect(page.unread).toBe(unreadAdmin - 1);

    expect(await markAllFeedRead(pool, ctx.dir2, clock.now(), clock.now())).toBe(0); // в зоне b2 нечего
    const marked = await markAllFeedRead(pool, ctx.admin1b, clock.now(), clock.now());
    expect(marked).toBe(unreadB);
    expect(await feedUnreadCount(pool, ctx.admin1b)).toBe(0);
    expect((await listStaffFeed(pool, ctx.admin1b, { unreadOnly: true })).items).toHaveLength(0);
    expect(await feedUnreadCount(pool, ctx.admin1)).toBe(unreadAdmin - 1); // чужое «прочитать все» не трогает
  });

  it('курсор: страницы без пропусков и повторов; неверный курсор – 400', async () => {
    const all = await ids('owner');
    expect(all.length).toBeGreaterThan(3);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const p = await listStaffFeed(pool, ctx.owner, { limit: 2, cursor });
      seen.push(...p.items.map((i) => i.id));
      cursor = p.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(all);
    await expect(listStaffFeed(pool, ctx.owner, { cursor: 'мусор' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED', httpStatus: 400 });
  });
});

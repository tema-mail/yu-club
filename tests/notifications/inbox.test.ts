// S4-10: миграция 0401 и центр уведомлений K21 §3 на настоящей Postgres (роль yu_app).
// Видимость по статусам, реклама с отказом, чужая строка, срок показа 365 дней, прочтение одной и всех, состояние брони.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateDown, migrateUp } from '../../db/migrate.ts';
import { listInbox, markAllRead, markRead, unreadCount, type InboxBookingLookup } from '../../apps/api/src/modules/notifications/inbox.ts';
import { createTestBooking } from '../helpers/booking.ts';
import { createTestBranch } from '../helpers/network.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

let db: TestDatabase;
let pool: pg.Pool;
let branchId: string;
let phone = 79140001000;
const now = new Date('2026-11-20T10:00:00Z');
const day = 86_400_000;

async function client(marketing = false): Promise<string> {
  const id = (
    await db.client.query<{ id: string }>(
      `INSERT INTO app.clients (phone_e164, status, registered_at, created_by_type) VALUES ($1, 'active', now(), 'system') RETURNING id`,
      [`+${++phone}`],
    )
  ).rows[0]!.id;
  await db.client.query('INSERT INTO app.client_notification_prefs (client_id, reminders_enabled, marketing_enabled) VALUES ($1, true, $2)', [id, marketing]);
  return id;
}

async function row(clientId: string, over: { category?: string; kind?: string; status?: string; at?: Date; push?: boolean; bookingId?: string | null } = {}): Promise<string> {
  const at = over.at ?? new Date(now.getTime() - 3600_000);
  const status = over.status ?? 'sent_to_provider';
  const r = await db.client.query<{ id: string }>(
    `INSERT INTO app.notifications (client_id, branch_id, category, kind, booking_id, booking_version, source, title, body, planned_at, status, sent_at, push, dedupe_key)
     VALUES ($1, $2, $3, $4, $5, 1, 'system', 'Заголовок', 'Текст', $6, $7, $8, $9, $10) RETURNING id`,
    [
      clientId,
      branchId,
      over.category ?? 'service',
      over.kind ?? 'booking_confirmed',
      over.bookingId === undefined ? await createTestBooking(db.client, { clientId, branchId }) : over.bookingId,
      at,
      status,
      status === 'sent_to_provider' ? at : null,
      over.push ?? status !== 'inbox_only',
      `t:${randomUUID()}`,
    ],
  );
  return r.rows[0]!.id;
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
  branchId = (await createTestBranch(db.client)).id;
});
afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('миграция 0401', () => {
  it('вверх / вниз / вверх; прежние категории event_cancel и personal больше не принимаются', async () => {
    const t = await createTestDatabase({ migrate: true });
    try {
      const later = (await t.client.query<{ version: string }>(`SELECT version FROM public.schema_migrations WHERE version >= '0401' ORDER BY version`)).rows.map((r) => r.version);
      expect((await migrateDown(t.client, later.length)).at(-1)).toBe('0401');
      expect((await t.client.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'notifications' AND column_name = 'read_at'`)).rowCount).toBe(0);
      expect(await migrateUp(t.client)).toEqual(later);
      expect((await t.client.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'notifications' AND column_name = 'read_at'`)).rowCount).toBe(1);
      expect((await t.client.query(`SELECT * FROM journal.append_only_violations()`)).rows).toEqual([]);
    } finally {
      await t.drop();
    }
    const c = await client();
    await expect(row(c, { category: 'personal', kind: 'personal' })).rejects.toMatchObject({ code: '23514' });
    await expect(row(c, { status: 'planned', push: false })).rejects.toMatchObject({ code: '23514' }); // push=false – только inbox_only
    await expect(row(c, { bookingId: randomUUID() })).rejects.toMatchObject({ code: '23503' }); // 0412: бронь должна существовать
  });

  it('согласие на рекламу без версии документа → 23514; отказ и согласие с версией – проходят', async () => {
    const c = await client();
    const ins = (granted: boolean, version: string | null) =>
      pool.query(
        `INSERT INTO journal.client_consents (client_id, kind, granted, document_version, source, actor_type, actor_id) VALUES ($1, 'marketing', $2, $3, 'account', 'client', $1)`,
        [c, granted, version],
      );
    await expect(ins(true, null)).rejects.toMatchObject({ code: '23514' });
    await expect(ins(true, 'marketing-2026-11')).resolves.toBeDefined();
    await expect(ins(false, null)).resolves.toBeDefined();
  });
});

describe('центр уведомлений K21 §3', () => {
  it('видны только наступившие строки нужных статусов; service + no_channel видна; реклама при отказе – нет', async () => {
    const c = await client(false);
    const visible = {
      sent: await row(c),
      noChannel: await row(c, { status: 'no_channel' }),
      error: await row(c, { status: 'error' }),
      inbox: await row(c, { status: 'inbox_only', kind: 'personal', bookingId: null }),
    };
    for (const status of ['planned', 'queued', 'sending', 'cancelled', 'skipped_by_prefs', 'skipped_booking_changed', 'skipped_by_frequency']) await row(c, { status });
    await row(c, { status: 'sent_to_provider', at: new Date(now.getTime() + 3600_000) }); // ещё не наступила
    await row(c, { category: 'marketing', kind: 'campaign', bookingId: null }); // реклама ушла, но «Реклама» выключена
    const page = await listInbox(pool, c, { now });
    expect(page.items.map((i) => i.id).sort()).toEqual(Object.values(visible).sort());
    expect(page.unread).toBe(4);

    await pool.query('UPDATE app.client_notification_prefs SET marketing_enabled = true WHERE client_id = $1', [c]);
    expect((await listInbox(pool, c, { now })).items).toHaveLength(5); // при включённой рекламе – видна
  });

  it('старше 365 дней не показывается; курсор листает без повторов; порядок – по дате убыванием', async () => {
    const c = await client();
    await row(c, { at: new Date(now.getTime() - 366 * day) });
    const ids: string[] = [];
    for (let i = 1; i <= 5; i++) ids.push(await row(c, { at: new Date(now.getTime() - i * day) }));
    const p1 = await listInbox(pool, c, { now, limit: 2 });
    expect(p1.items.map((i) => i.id)).toEqual(ids.slice(0, 2));
    const p2 = await listInbox(pool, c, { now, limit: 2, cursor: p1.nextCursor! });
    const p3 = await listInbox(pool, c, { now, limit: 2, cursor: p2.nextCursor! });
    expect([...p2.items, ...p3.items].map((i) => i.id)).toEqual(ids.slice(2));
    expect(p3.nextCursor).toBeNull();
    await expect(listInbox(pool, c, { now, cursor: 'мусор' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('прочтение: своя – да, повтор – без ошибки; чужая и скрытая → NOT_FOUND; «все» – только не новее before', async () => {
    const a = await client();
    const b = await client();
    const mine = await row(a, { at: new Date(now.getTime() - 2 * day) });
    const fresh = await row(a, { at: new Date(now.getTime() - 60_000) });
    const hidden = await row(a, { status: 'skipped_by_prefs' });
    const foreign = await row(b);
    await markRead(pool, a, mine, now);
    await markRead(pool, a, mine, now);
    await expect(markRead(pool, a, foreign, now)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(markRead(pool, a, hidden, now)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(markRead(pool, a, 'не-uuid', now)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await unreadCount(pool, a, now)).toBe(1);
    expect(await markAllRead(pool, a, new Date(now.getTime() - day), now)).toBe(0); // fresh новее before
    expect(await markAllRead(pool, a, now, now)).toBe(1);
    expect(await unreadCount(pool, a, now)).toBe(0);
    expect(await unreadCount(pool, b, now)).toBe(1);
    const items = (await listInbox(pool, a, { now })).items;
    expect(items.find((i) => i.id === fresh)?.read).toBe(true);
  });

  it('состояние связанной брони – из провайдера booking: active / cancelled / finished / unavailable', async () => {
    const c = await client();
    const other = randomUUID();
    const states: Record<string, { clientId: string; state: 'active' | 'cancelled' | 'finished' }> = {};
    const booking = () => createTestBooking(db.client, { clientId: c, branchId });
    const bk = { active: await booking(), cancelled: await booking(), finished: await booking(), missing: await booking(), foreign: await booking() };
    states[bk.active] = { clientId: c, state: 'active' };
    states[bk.cancelled] = { clientId: c, state: 'cancelled' };
    states[bk.finished] = { clientId: c, state: 'finished' };
    states[bk.foreign] = { clientId: other, state: 'active' };
    const lookup: InboxBookingLookup = { snapshot: async (_db, id) => states[id] ?? null };
    for (const id of Object.values(bk)) await row(c, { bookingId: id });
    await row(c, { kind: 'personal', bookingId: null, status: 'inbox_only' });
    const items = (await listInbox(pool, c, { now, bookings: lookup })).items;
    const stateOf = (id: string) => items.find((i) => i.booking?.id === id)?.booking?.state;
    expect([stateOf(bk.active), stateOf(bk.cancelled), stateOf(bk.finished), stateOf(bk.missing), stateOf(bk.foreign)]).toEqual([
      'active',
      'cancelled',
      'finished',
      'unavailable',
      'unavailable',
    ]);
    expect(items.filter((i) => i.booking === null)).toHaveLength(1);
  });
});

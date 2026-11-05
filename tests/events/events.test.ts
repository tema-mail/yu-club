// S3-50: мероприятие на настоящей Postgres – миграция вверх/вниз/вверх, создание без брони и профиля, таблица переходов,
// подтверждение с проверкой готовности, конечные статусы, номер без дублей при параллельном создании.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { AppError } from '../../apps/api/src/core/errors.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { withTx } from '../../apps/api/src/modules/clients/index.ts';
import { changeEventStatus, createEvent, updateEvent, type EventDto } from '../../apps/api/src/modules/events/events.ts';
import { loadMigrations, migrateDown, migrateUp } from '../../db/migrate.ts';
import { createTestBranch } from '../helpers/network.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const clock = fixedClock('2026-11-14T05:00:00Z');
let db: TestDatabase;
let pool: pg.Pool;
let owner: AccessContext;
let branchId = '';
let otherBranch = '';
const types: Record<string, string> = {};

const meta = (ctx: AccessContext = owner): AuditRequestMeta => ({ actor: ctx.actor, access: ctx, source: 'crm', requestId: randomUUID() });
const tx = <T>(fn: (c: pg.PoolClient) => Promise<T>) => withTx(pool, fn);
async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
}
const newEvent = (over: Record<string, unknown> = {}, ctx = owner) =>
  tx((c) => createEvent(c, ctx, { typeId: types.other, branchId, customer: { name: 'Анна', phone: '+79131234567' }, ...over }, meta(ctx), clock));
const setStatus = (e: EventDto, to: string, reason?: string) =>
  tx((c) => changeEventStatus(c, owner, e.id, { rowVersion: e.rowVersion, to, ...(reason ? { reason } : {}) }, meta(), clock));
async function addLine(eventId: string): Promise<void> {
  await db.client.query(`INSERT INTO app.event_lines (event_id, kind, name, quantity, unit, price_kop) VALUES ($1, 'service', 'Аниматор', 1, 'шт', 500000)`, [eventId]);
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 25 });
  const s = await db.client.query<{ id: string }>(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', 'o@yu.test', 'owner', 'x') RETURNING id`);
  owner = { actor: { kind: 'staff', staffId: s.rows[0]!.id, sessionId: randomUUID() }, role: 'owner', network: true, cityIds: new Set(), branchIds: new Set(), at: clock.now() };
  branchId = (await createTestBranch(db.client)).id;
  otherBranch = (await createTestBranch(db.client)).id;
  for (const t of (await db.client.query<{ id: string; code: string }>('SELECT id, code FROM app.event_types')).rows) types[t.code] = t.id;
});
afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('S3-50: миграция 0305', () => {
  it('вверх/вниз/вверх на отдельной базе, посев 5 типов', async () => {
    const d = await createTestDatabase({ migrate: true });
    try {
      const all = await loadMigrations();
      await migrateDown(d.client, all.filter((m) => m.version >= '0305').length);
      expect((await d.client.query(`SELECT to_regclass('app.events') AS t`)).rows[0].t).toBeNull();
      await migrateUp(d.client);
      expect((await d.client.query('SELECT count(*)::int n FROM app.event_types')).rows[0].n).toBe(5);
    } finally {
      await d.drop();
    }
  });
  it('у yu_app нет DELETE мероприятий', async () => {
    const e = await newEvent();
    await expect(pool.query('DELETE FROM app.events WHERE id = $1', [e.id])).rejects.toMatchObject({ code: '42501' });
  });
});

describe('S3-50: создание', () => {
  it('без брони и без профиля; телефон маскирован; профиль клиента не создан; чек-лист из 10 пунктов', async () => {
    const before = (await db.client.query('SELECT count(*)::int n FROM app.clients')).rows[0].n;
    const e = await newEvent({ title: 'Выпускной' });
    expect(e.status).toBe('new_request');
    expect(e.number).toMatch(/^EV-\d{6}$/);
    expect(e.customer).toEqual({ clientId: null, name: 'Анна', phoneMasked: '+7 ••• ••• ••-67' });
    expect(e.plannedStart).toBeNull();
    expect((await db.client.query('SELECT count(*)::int n FROM app.clients')).rows[0].n).toBe(before);
    expect((await db.client.query('SELECT count(*)::int n FROM app.event_checklist WHERE event_id = $1', [e.id])).rows[0].n).toBe(10);
  });
  it('номер без дублей при 20 параллельных созданиях', async () => {
    const all = await Promise.all(Array.from({ length: 20 }, () => newEvent()));
    expect(new Set(all.map((e) => e.number)).size).toBe(20);
  });
  it('гостей больше 10 у праздника – PARTY_GUESTS_LIMIT; формат у другого типа – отказ', async () => {
    expect(await codeOf(newEvent({ typeId: types.birthday_party, party: { format: 'h2', guests: 11 } }))).toBe('PARTY_GUESTS_LIMIT');
    expect(await codeOf(newEvent({ party: { format: 'h2', guests: 5 } }))).toBe('VALIDATION_FAILED');
  });
  it('филиал вне зоны – 404; в своём филиале Администратор создаёт', async () => {
    const admin: AccessContext = { ...owner, role: 'admin', network: false, branchIds: new Set([otherBranch]) };
    expect(await codeOf(newEvent({}, admin))).toBe('NOT_FOUND');
    expect(await codeOf(newEvent({ branchId: otherBranch }, admin))).toBe('ok');
  });
});

describe('S3-50: статусы', () => {
  it('подтверждение без даты и состава – EVENT_NOT_READY со списком полей', async () => {
    let e = await newEvent();
    e = (await setStatus(e, 'awaiting_confirmation')).event;
    await expect(setStatus(e, 'confirmed')).rejects.toMatchObject({ code: 'EVENT_NOT_READY', details: { fields: ['plannedStart', 'plannedEnd', 'lines'] } });
  });
  it('праздник без занятой комнаты не подтверждается (поле room)', async () => {
    let e = await newEvent({ typeId: types.birthday_party, plannedStart: '2026-11-20T05:00:00Z', plannedEnd: '2026-11-20T07:00:00Z' });
    await addLine(e.id);
    e = (await setStatus(e, 'awaiting_confirmation')).event;
    await expect(setStatus(e, 'confirmed')).rejects.toMatchObject({ code: 'EVENT_NOT_READY', details: { fields: ['room'] } });
  });
  it('полный путь: снимок стоимости, событие event.confirmed, история в аудите', async () => {
    let e = await newEvent({ plannedStart: '2026-11-20T05:00:00Z', plannedEnd: '2026-11-20T07:00:00Z' });
    await addLine(e.id);
    e = (await setStatus(e, 'awaiting_confirmation')).event;
    e = (await setStatus(e, 'confirmed')).event;
    expect(e.status).toBe('confirmed');
    const snap = await db.client.query('SELECT agreed_snapshot FROM app.events WHERE id = $1', [e.id]);
    expect(snap.rows[0].agreed_snapshot.agreedKop).toBe(500000);
    const ev = await db.client.query(`SELECT payload FROM app.outbox_events WHERE event_type = 'event.confirmed' AND aggregate_id = $1`, [e.id]);
    expect(ev.rows[0].payload.number).toBe(e.number);
    e = (await setStatus(e, 'in_progress')).event;
    e = (await setStatus(e, 'completed')).event;
    const a = await db.client.query(`SELECT after FROM journal.audit_events WHERE action = 'event.status_changed' AND object_id = $1 ORDER BY id`, [e.id]);
    expect(a.rows.map((r) => r.after.status)).toEqual(['awaiting_confirmation', 'confirmed', 'in_progress', 'completed']);
  });
  it('переход не по таблице – EVENT_TRANSITION_INVALID; конечные статусы не меняются', async () => {
    const e = await newEvent();
    expect(await codeOf(setStatus(e, 'completed'))).toBe('EVENT_TRANSITION_INVALID');
    const done = (await setStatus(e, 'cancelled', 'передумали')).event;
    for (const to of ['new_request', 'negotiation', 'confirmed', 'cancelled', 'not_held']) expect(await codeOf(setStatus(done, to))).toBe('EVENT_TRANSITION_INVALID');
  });
  it('отмена без причины – COMMENT_REQUIRED; причина, автор и время записаны; событие event.cancelled', async () => {
    const e = await newEvent();
    expect(await codeOf(setStatus(e, 'cancelled'))).toBe('COMMENT_REQUIRED');
    const r = await setStatus(e, 'cancelled', 'передумали');
    expect(r.event.cancel).toEqual({ reason: 'передумали', by: owner.actor.staffId, at: clock.now().toISOString() });
    expect(r.needsDecision).toEqual({ bookingIds: [], giftIds: [] });
    const ev = await db.client.query(`SELECT payload FROM app.outbox_events WHERE event_type = 'event.cancelled' AND aggregate_id = $1`, [e.id]);
    expect(ev.rows[0].payload.reason).toBe('передумали');
  });
  it('устаревшая форма – VERSION_CONFLICT', async () => {
    const e = await newEvent();
    await setStatus(e, 'negotiation');
    expect(await codeOf(setStatus(e, 'cancelled', 'x'))).toBe('VERSION_CONFLICT');
  });
});

describe('S3-50: правка', () => {
  it('история в аудите: только изменённые поля; телефон маскирован', async () => {
    const e = await newEvent();
    const u = await tx((c) => updateEvent(c, owner, e.id, { rowVersion: e.rowVersion, wishes: 'шарики', customer: { name: 'Анна', phone: '+79137654321' }, reason: 'звонок' }, meta(), clock));
    expect(u.wishes).toBe('шарики');
    expect(u.rowVersion).toBe(e.rowVersion + 1);
    const a = await db.client.query(`SELECT after, reason FROM journal.audit_events WHERE action = 'event.updated' AND object_id = $1`, [e.id]);
    expect(a.rows[0].after.wishes).toBe('шарики');
    expect(a.rows[0].reason).toBe('звонок');
    expect(JSON.stringify(a.rows[0])).not.toContain('7654321');
  });
  it('в конечном статусе – EVENT_CLOSED', async () => {
    const e = await newEvent();
    const done = (await setStatus(e, 'cancelled', 'x')).event;
    expect(await codeOf(tx((c) => updateEvent(c, owner, done.id, { rowVersion: done.rowVersion, wishes: 'y' }, meta(), clock)))).toBe('EVENT_CLOSED');
  });
});

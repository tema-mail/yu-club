// S3-57: подарок – основание, 60 дней, один в 365 дней (база, 20 параллельных), ручная выдача только Владельцем, истечение один раз.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { AppError } from '../../apps/api/src/core/errors.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import { fixedClock, type Clock } from '../../apps/api/src/core/time.ts';
import { withTx } from '../../apps/api/src/modules/clients/index.ts';
import { changeEventStatus, createEvent, type EventDto } from '../../apps/api/src/modules/events/events.ts';
import { cancelGift, expireDueGifts, issueGift } from '../../apps/api/src/modules/events/gifts.ts';
import { eventMoneySummary } from '../../apps/api/src/modules/events/money.ts';
import { createTestBranch } from '../helpers/network.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

// 01.06.2026 12:00 по Новосибирску
const clock = fixedClock('2026-06-01T05:00:00Z');
let db: TestDatabase;
let pool: pg.Pool;
let owner: AccessContext;
let director: AccessContext;
let branchId = '';
const types: Record<string, string> = {};
let phone = 79000000000;

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
async function newClient(): Promise<string> {
  const r = await db.client.query<{ id: string }>(`INSERT INTO app.clients (phone_e164, first_name, status, created_by_type) VALUES ($1, 'Катя', 'active', 'system') RETURNING id`, [`+${++phone}`]);
  return r.rows[0]!.id;
}
async function birthdayEvent(clientId: string | null, type = 'birthday_party', statuses: string[] = ['in_progress']): Promise<EventDto> {
  let e = await tx((c) =>
    createEvent(c, owner, { typeId: types[type], branchId, plannedStart: '2026-06-01T05:00:00Z', plannedEnd: '2026-06-01T07:00:00Z', customer: { name: 'Мама', phone: '+79131234567' }, birthdayPerson: { clientId, name: 'Катя' } }, meta(), clock),
  );
  // таблицу переходов и требования проверяет events.test.ts; здесь – нужный статус напрямую
  for (const to of statuses) {
    await db.client.query(`UPDATE app.events SET status = $2, row_version = row_version + 1 WHERE id = $1`, [e.id, to]);
    e = { ...e, status: to as EventDto['status'], rowVersion: e.rowVersion + 1 };
  }
  return e;
}
const issue = (clientId: string, basisEventId: string, ctx = owner, at: Clock = clock) => tx((c) => issueGift(c, ctx, { clientId, basisEventId }, meta(ctx), at));

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 25 });
  const s = await db.client.query<{ id: string }>(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', 'o@yu.test', 'owner', 'x') RETURNING id`);
  owner = { actor: { kind: 'staff', staffId: s.rows[0]!.id, sessionId: randomUUID() }, role: 'owner', network: true, cityIds: new Set(), branchIds: new Set(), at: clock.now() };
  branchId = (await createTestBranch(db.client)).id;
  director = { ...owner, role: 'director', network: false, branchIds: new Set([branchId]) };
  for (const t of (await db.client.query<{ id: string; code: string }>('SELECT id, code FROM app.event_types')).rows) types[t.code] = t.id;
});
afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('S3-57: выдача', () => {
  it('01.06 → validUntil 31.07; снимок условий; номер GF-; событие gift.issued; сводка считает подарок', async () => {
    const clientId = await newClient();
    const e = await birthdayEvent(clientId);
    const g = await issue(clientId, e.id, director);
    expect(g).toMatchObject({ issuedOn: '2026-06-01', validUntil: '2026-07-31', status: 'issued', clientId, basisEventId: e.id, issueBranchId: branchId });
    expect(g.number).toMatch(/^GF-\d{6}$/);
    expect(g.terms).toEqual({ devices: 2, device: 'Meta Quest 3S', minutesEach: 30, roomMinutes: 40, weekdays: [1, 2, 3, 4, 5], excludesHolidays: true, notIncluded: ['PS4', 'PS VR', 'food'] });
    const ev = await db.client.query(`SELECT payload FROM app.outbox_events WHERE event_type = 'gift.issued' AND aggregate_id = $1`, [g.id]);
    expect(ev.rows[0].payload).toEqual({ giftId: g.id, clientId, validUntil: '2026-07-31', issueBranchId: branchId });
    expect((await eventMoneySummary(pool, e.id)).giftsIssued).toBe(1);
  });
  it('второй за год – GIFT_ALREADY_ISSUED; 20 параллельных – одна запись; через год – снова можно', async () => {
    const clientId = await newClient();
    const a = await birthdayEvent(clientId);
    const results = await Promise.all(Array.from({ length: 20 }, () => codeOf(issue(clientId, a.id))));
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r === 'GIFT_ALREADY_ISSUED')).toHaveLength(19);
    expect((await db.client.query('SELECT count(*)::int n FROM app.birthday_gifts WHERE client_id = $1', [clientId])).rows[0].n).toBe(1);
    expect(await codeOf(issue(clientId, a.id, owner, fixedClock('2027-05-31T05:00:00Z')))).toBe('GIFT_ALREADY_ISSUED');
    expect(await codeOf(issue(clientId, a.id, owner, fixedClock('2027-06-01T05:00:00Z')))).toBe('ok');
  });
  it('основание: не день рождения клиента, другой клиент, рано – GIFT_BASIS_INVALID; дню рождения без комнаты – можно', async () => {
    const clientId = await newClient();
    const other = await newClient();
    const e = await birthdayEvent(other);
    expect(await codeOf(issue(clientId, e.id))).toBe('GIFT_BASIS_INVALID');
    const wrongType = await birthdayEvent(clientId, 'group_visit');
    expect(await codeOf(issue(clientId, wrongType.id))).toBe('GIFT_BASIS_INVALID');
    const early = await birthdayEvent(clientId, 'birthday_party', []);
    expect(await codeOf(issue(clientId, early.id))).toBe('GIFT_BASIS_INVALID');
    const noRoom = await birthdayEvent(clientId, 'birthday', ['completed']);
    expect(await codeOf(issue(clientId, noRoom.id))).toBe('ok');
  });
  it('ручная выдача: Директором – FORBIDDEN; Владельцем – только с причиной и филиалом', async () => {
    const clientId = await newClient();
    expect(await codeOf(tx((c) => issueGift(c, director, { clientId, branchId, reason: 'акция' }, meta(director), clock)))).toBe('FORBIDDEN');
    expect(await codeOf(tx((c) => issueGift(c, owner, { clientId, branchId }, meta(), clock)))).toBe('COMMENT_REQUIRED');
    expect(await codeOf(tx((c) => issueGift(c, owner, { clientId, reason: 'акция' }, meta(), clock)))).toBe('VALIDATION_FAILED');
    const g = await tx((c) => issueGift(c, owner, { clientId, branchId, reason: 'акция' }, meta(), clock));
    expect(g.basisEventId).toBeNull();
  });
  it('филиал вне зоны – 404', async () => {
    const clientId = await newClient();
    const e = await birthdayEvent(clientId);
    const stranger: AccessContext = { ...director, branchIds: new Set() };
    expect(await codeOf(issue(clientId, e.id, stranger))).toBe('NOT_FOUND');
  });
  it('отмена мероприятия показывает подарок в needsDecision и не трогает его', async () => {
    const clientId = await newClient();
    const e = await birthdayEvent(clientId, 'birthday_party', ['confirmed']);
    await db.client.query(`UPDATE app.events SET status = 'in_progress' WHERE id = $1`, [e.id]);
    const g = await issue(clientId, e.id);
    await db.client.query(`UPDATE app.events SET status = 'confirmed' WHERE id = $1`, [e.id]);
    const r = await tx((c) => changeEventStatus(c, owner, e.id, { rowVersion: e.rowVersion, to: 'cancelled', reason: 'заболел' }, meta(), clock));
    expect(r.needsDecision!.giftIds).toEqual([g.id]);
    const ev = await db.client.query(`SELECT payload FROM app.outbox_events WHERE event_type = 'event.cancelled' AND aggregate_id = $1`, [e.id]);
    expect(ev.rows[0].payload.giftIds).toEqual([g.id]);
    expect((await db.client.query('SELECT status FROM app.birthday_gifts WHERE id = $1', [g.id])).rows[0].status).toBe('issued');
  });
});

describe('S3-57: отмена и истечение', () => {
  it('отмена Владельцем с причиной освобождает годовое окно; Директору – нет', async () => {
    const clientId = await newClient();
    const e = await birthdayEvent(clientId);
    const g = await issue(clientId, e.id);
    expect(await codeOf(tx((c) => cancelGift(c, director, g.id, { reason: 'x' }, meta(director), clock)))).toBe('FORBIDDEN');
    expect(await codeOf(tx((c) => cancelGift(c, owner, g.id, {}, meta(), clock)))).toBe('COMMENT_REQUIRED');
    const done = await tx((c) => cancelGift(c, owner, g.id, { reason: 'ошибка' }, meta(), clock));
    expect(done).toMatchObject({ status: 'cancelled', cancelReason: 'ошибка' });
    expect(await codeOf(tx((c) => cancelGift(c, owner, g.id, { reason: 'ещё' }, meta(), clock)))).toBe('GIFT_NOT_ACTIVE');
    expect(await codeOf(issue(clientId, e.id))).toBe('ok');
  });
  it('истечение: в последний день ещё живой, на следующий – expired один раз, с аудитом', async () => {
    const clientId = await newClient();
    const e = await birthdayEvent(clientId);
    const g = await issue(clientId, e.id);
    // 31.07 23:59 по Новосибирску = 16:59 UTC – срок ещё идёт
    await expireDueGifts(pool, fixedClock('2026-07-31T16:59:00Z'));
    expect((await db.client.query('SELECT status FROM app.birthday_gifts WHERE id = $1', [g.id])).rows[0].status).toBe('issued');
    expect(await expireDueGifts(pool, fixedClock('2026-07-31T17:00:00Z'))).toBeGreaterThanOrEqual(1);
    expect((await db.client.query('SELECT status FROM app.birthday_gifts WHERE id = $1', [g.id])).rows[0].status).toBe('expired');
    expect(await expireDueGifts(pool, fixedClock('2026-08-02T05:00:00Z'))).toBe(0);
    const log = await db.client.query(`SELECT count(*)::int n FROM journal.audit_events WHERE action = 'gift.expired' AND object_id = $1`, [g.id]);
    expect(log.rows[0].n).toBe(1);
  });
});

// Вложения мероприятия (K19 §9, 11 §11.4): владелец 'event' зарегистрирован сервером; запись – event.money.record,
// чтение – event.view, вне зоны – 404 на загрузке, списке и выдаче; файл – только через GET /attachments/:id.
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { AppError } from '../../apps/api/src/core/errors.ts';
import { createFileStore } from '../../apps/api/src/core/files.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { withTx } from '../../apps/api/src/modules/clients/index.ts';
import { expenseDocumentsOf, setExpenseDocument } from '../../apps/api/src/modules/events/attachments.ts';
import { hashPassword, staffAuthConfig } from '../../apps/api/src/modules/staff/auth.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const PASSWORD = 'Пароль-документов-мероприятия-1';
const BASE = '/api/crm/v1';
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
const clock = fixedClock('2026-11-14T05:00:00Z');
let db: TestDatabase;
let pool: pg.Pool;
let app: FastifyInstance;
let root: string;
const cookies: Record<string, string> = {};
const ids: Record<string, string> = {};

type Who = 'owner' | 'admin' | 'stranger';
const one = async (sql: string, params: unknown[] = []) => (await db.client.query(sql, params)).rows[0];
async function staff(who: Who, role: string, branchId: string | null): Promise<void> {
  const s = await one(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', $1, $2, $3) RETURNING id`, [`${who}@yu.test`, role, await hashPassword(PASSWORD)]);
  ids[who] = s.id;
  if (branchId) await db.client.query(`INSERT INTO app.staff_assignments (staff_id, scope_type, branch_id, valid_from, created_by) VALUES ($1, 'branch', $2, '2026-01-01', $1)`, [s.id, branchId]);
  const res = await app.inject({ method: 'POST', url: `${BASE}/auth/login`, payload: { email: `${who}@yu.test`, password: PASSWORD } });
  cookies[who] = String(res.headers['set-cookie']).split(';')[0]!;
}
const get = (who: Who, url: string) => app.inject({ method: 'GET', url: `${BASE}${url}`, headers: { cookie: cookies[who]! } });
const post = (who: Who, url: string, payload: object) => app.inject({ method: 'POST', url: `${BASE}${url}`, headers: { cookie: cookies[who]!, 'idempotency-key': randomUUID() }, payload });
const upload = (who: Who, eventId: string, file: Buffer = PDF) =>
  app.inject({
    method: 'POST',
    url: `${BASE}/attachments?${new URLSearchParams({ ownerType: 'event', ownerId: eventId, docType: 'check', name: 'чек.pdf' })}`,
    headers: { cookie: cookies[who]!, 'content-type': 'application/pdf', 'idempotency-key': randomUUID() },
    payload: file,
  });
const ctxOf = (who: Who, role: AccessContext['role'], branchId: string | null): AccessContext => ({
  actor: { kind: 'staff', staffId: ids[who]!, sessionId: randomUUID() },
  role,
  network: branchId === null,
  cityIds: new Set(),
  branchIds: new Set(branchId ? [branchId] : []),
  at: clock.now(),
});
const meta = (ctx: AccessContext): AuditRequestMeta => ({ actor: ctx.actor, access: ctx, source: 'crm', requestId: randomUUID() });
async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
}
const setDoc = (ctx: AccessContext, eventId: string, operationId: string, attachmentId: string) =>
  withTx(pool, (c) => setExpenseDocument(c, ctx, eventId, { operationId, attachmentId }, meta(ctx), clock));
async function expenseOf(eventId: string): Promise<string> {
  const r = await post('owner', `/events/${eventId}/expense`, { method: 'cash', amountKop: 50_000, categoryId: ids.category, subcategoryId: ids.subcategory, occurredAt: '2026-11-14T04:00:00Z', comment: 'аниматор' });
  expect(r.statusCode).toBe(201);
  return r.json().id;
}
async function newEvent(): Promise<string> {
  const r = await post('owner', '/events', { typeId: ids.type, branchId: ids.b1, customer: { name: 'Анна Смирнова', phone: '+79131234567' } });
  expect(r.statusCode).toBe(201);
  return r.json().id;
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
  root = await mkdtemp(path.join(os.tmpdir(), 'yu-event-docs-'));
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), { staff: { pool, auth: staffAuthConfig('d'.repeat(40)), clock }, attachments: { store: createFileStore({ root }) } });
  const city = await one(`INSERT INTO app.cities (code, slug, name, timezone) VALUES ('nsk', 'nsk', 'НСК', 'Asia/Novosibirsk') RETURNING id`);
  for (const code of ['b1', 'b2']) {
    ids[code] = (await one(`INSERT INTO app.branches (city_id, code, slug, name, address, timezone, status) VALUES ($1, $2, $2, $2, 'адрес', 'Asia/Novosibirsk', 'active') RETURNING id`, [city.id, code])).id;
  }
  await staff('owner', 'owner', null);
  await staff('admin', 'admin', ids.b1!);
  await staff('stranger', 'director', ids.b2!);
  ids.type = (await one(`SELECT id FROM app.event_types WHERE code = 'other'`)).id;
  const cat = await one(`SELECT p.id AS "categoryId", c.id AS "subcategoryId" FROM app.finance_categories p JOIN app.finance_categories c ON c.parent_id = p.id WHERE p.kind = 'expense' AND p.status = 'active' AND c.status = 'active' ORDER BY p.sort_order, c.sort_order LIMIT 1`);
  ids.category = cat.categoryId;
  ids.subcategory = cat.subcategoryId;
  // запас в кассе филиала: расход не упирается в отрицательный остаток (K17 §6)
  expect((await post('owner', `/events/${await newEvent()}/income`, { method: 'cash', amountKop: 10_000_000, occurredAt: '2026-11-14T04:00:00Z' })).statusCode).toBe(201);
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await db.drop();
  await rm(root, { recursive: true, force: true });
});

describe('владелец вложений event', () => {
  it('Администратор филиала кладёт чек и скачивает его через API; чужой филиал – 404 на загрузке, списке и выдаче', async () => {
    const eventId = await newEvent();
    const up = await upload('admin', eventId);
    expect(up.statusCode).toBe(201);
    const id = up.json().attachmentId as string;
    expect(up.json().attachment).toMatchObject({ ownerType: 'event', ownerId: eventId, docType: 'check', status: 'active' });

    const file = await get('admin', `/attachments/${id}`);
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-disposition']).toMatch(/^attachment;/);
    expect(file.rawPayload.equals(PDF)).toBe(true);
    expect((await get('admin', `/attachments?ownerType=event&ownerId=${eventId}`)).json().items.map((a: { id: string }) => a.id)).toEqual([id]);

    expect((await upload('stranger', eventId)).statusCode).toBe(404);
    expect((await get('stranger', `/attachments/${id}`)).statusCode).toBe(404);
    expect((await get('stranger', `/attachments?ownerType=event&ownerId=${eventId}`)).statusCode).toBe(404);
    expect((await post('stranger', `/attachments/${id}/invalidate`, { reason: 'x' })).statusCode).toBe(404);
  });

  it('несуществующее мероприятие – 404, как чужое', async () => {
    expect((await upload('owner', randomUUID())).statusCode).toBe(404);
  });
});

describe('документ к расходу мероприятия (0435)', () => {
  it('ставится, повтор – без изменений, новый заменяет прежний; живая строка одна на операцию', async () => {
    const admin = ctxOf('admin', 'admin', ids.b1!);
    const eventId = await newEvent();
    const op = await expenseOf(eventId);
    const a1 = (await upload('admin', eventId)).json().attachmentId as string;
    const a2 = (await upload('admin', eventId, Buffer.concat([PDF, Buffer.from('%2')]))).json().attachmentId as string;
    expect(await setDoc(admin, eventId, op, a1)).toEqual({ operationId: op, attachmentId: a1 });
    expect(await setDoc(admin, eventId, op, a1)).toEqual({ operationId: op, attachmentId: a1 });
    expect(await setDoc(admin, eventId, op, a2)).toEqual({ operationId: op, attachmentId: a2 });
    expect([...(await expenseDocumentsOf(pool, eventId))]).toEqual([[op, a2]]);
    const rows = await db.client.query(`SELECT attachment_id, replaced_at IS NOT NULL AS replaced FROM app.event_expense_documents WHERE operation_id = $1 ORDER BY created_at, replaced_at NULLS LAST`, [op]);
    expect(rows.rows).toEqual([{ attachment_id: a1, replaced: true }, { attachment_id: a2, replaced: false }]);
    const audit = await db.client.query(`SELECT after FROM journal.audit_events WHERE action = 'event.money_linked' AND object_id = $1 ORDER BY occurred_at, id`, [eventId]);
    expect(audit.rows.map((r) => r.after.attachmentId)).toEqual([a1, a2]);
  });

  it('вложение чужого мероприятия, недействительное или несуществующее – 400; операция не расход этого мероприятия – 404; чужой филиал – 404', async () => {
    const admin = ctxOf('admin', 'admin', ids.b1!);
    const eventId = await newEvent();
    const other = await newEvent();
    const op = await expenseOf(eventId);
    const foreignOp = await expenseOf(other);
    const own = (await upload('admin', eventId)).json().attachmentId as string;
    const foreign = (await upload('admin', other)).json().attachmentId as string;
    const bad = (await upload('admin', eventId, Buffer.concat([PDF, Buffer.from('%bad')]))).json().attachmentId as string;
    expect((await post('admin', `/attachments/${bad}/invalidate`, { reason: 'не тот чек' })).statusCode).toBe(200);
    expect(await codeOf(setDoc(admin, eventId, op, foreign))).toBe('VALIDATION_FAILED');
    expect(await codeOf(setDoc(admin, eventId, op, bad))).toBe('VALIDATION_FAILED');
    expect(await codeOf(setDoc(admin, eventId, op, randomUUID()))).toBe('VALIDATION_FAILED');
    expect(await codeOf(setDoc(admin, eventId, foreignOp, own))).toBe('NOT_FOUND');
    expect(await codeOf(setDoc(admin, eventId, randomUUID(), own))).toBe('NOT_FOUND');
    const incomeOp = (await post('owner', `/events/${eventId}/income`, { method: 'cash', amountKop: 100, occurredAt: '2026-11-14T04:00:00Z' })).json().id as string;
    expect(await codeOf(setDoc(admin, eventId, incomeOp, own))).toBe('NOT_FOUND');
    expect(await codeOf(setDoc(ctxOf('stranger', 'director', ids.b2!), eventId, op, own))).toBe('NOT_FOUND');
    expect((await expenseDocumentsOf(pool, eventId)).size).toBe(0);
  });

  it('yu_app: строки не удаляются, документ в строке не меняется – только поля замены', async () => {
    const role = new pg.Client({ connectionString: db.url });
    await role.connect();
    try {
      await role.query('SET ROLE yu_app');
      await role.query('UPDATE app.event_expense_documents SET replaced_at = replaced_at, replaced_by = replaced_by WHERE false');
      await expect(role.query('DELETE FROM app.event_expense_documents WHERE false')).rejects.toMatchObject({ code: '42501' });
      await expect(role.query('UPDATE app.event_expense_documents SET attachment_id = attachment_id WHERE false')).rejects.toMatchObject({ code: '42501' });
    } finally {
      await role.end();
    }
  });
});

describe('документ к расходу по HTTP', () => {
  const expenseBody = (over: object = {}) => ({ method: 'cash', amountKop: 30_000, categoryId: ids.category, subcategoryId: ids.subcategory, occurredAt: '2026-11-14T04:00:00Z', comment: 'кейтеринг', ...over });

  it('расход с attachmentId – документ в той же транзакции; GET money отдаёт attachmentId у расхода; замена отдельным маршрутом', async () => {
    const eventId = await newEvent();
    const a1 = (await upload('admin', eventId)).json().attachmentId as string;
    const created = await post('admin', `/events/${eventId}/expense`, expenseBody({ attachmentId: a1 }));
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ kind: 'expense', attachmentId: a1 });
    const op = created.json().id as string;
    const plain = await post('admin', `/events/${eventId}/expense`, expenseBody());
    expect(plain.json().attachmentId).toBeNull();

    const money = (await get('owner', `/events/${eventId}/money`)).json();
    const byOp = new Map(money.operations.map((o: { operation: { id: string }; attachmentId?: string | null }) => [o.operation.id, o.attachmentId]));
    expect(byOp.get(op)).toBe(a1);
    expect(byOp.get(plain.json().id)).toBeNull();

    const a2 = (await upload('admin', eventId, Buffer.concat([PDF, Buffer.from('%v2')]))).json().attachmentId as string;
    const put = await post('admin', `/events/${eventId}/expense/${op}/document`, { attachmentId: a2 });
    expect([put.statusCode, put.json()]).toEqual([200, { operationId: op, attachmentId: a2 }]);
    expect((await post('stranger', `/events/${eventId}/expense/${op}/document`, { attachmentId: a2 })).statusCode).toBe(404);
    expect((await post('admin', `/events/${eventId}/expense/${randomUUID()}/document`, { attachmentId: a2 })).statusCode).toBe(404);
  });

  it('чужое вложение в расходе – 400, и операция не создаётся (одна транзакция)', async () => {
    const eventId = await newEvent();
    const other = await newEvent();
    const foreign = (await upload('admin', other)).json().attachmentId as string;
    const r = await post('admin', `/events/${eventId}/expense`, expenseBody({ attachmentId: foreign }));
    expect([r.statusCode, r.json().error.details]).toEqual([400, { field: 'attachmentId' }]);
    expect((await get('owner', `/events/${eventId}/money`)).json().operations).toEqual([]);
  });
});

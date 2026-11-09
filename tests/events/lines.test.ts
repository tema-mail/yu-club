// S3-51: состав и пакеты – правка строк не меняет шаблон (приёмка 4), цена и скидка Администратором – FORBIDDEN,
// история цены – в аудите before/after (11 §7.4), удаление – статусом с причиной, согласованная стоимость по активным строкам.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { AppError } from '../../apps/api/src/core/errors.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { withTx } from '../../apps/api/src/modules/clients/index.ts';
import { agreedOf, changeEventStatus, createEvent } from '../../apps/api/src/modules/events/events.ts';
import { addLine, applyPackage, createEventType, createPackage, listLines, listPackages, removeLine, updateEventType, updateLine, updatePackage } from '../../apps/api/src/modules/events/lines.ts';
import { createTestBranch } from '../helpers/network.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const clock = fixedClock('2026-11-14T05:00:00Z');
let db: TestDatabase;
let pool: pg.Pool;
let owner: AccessContext;
let admin: AccessContext;
let branchId = '';
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
const newEvent = () => tx((c) => createEvent(c, owner, { typeId: types.other, branchId, customer: { name: 'Анна', phone: '+79131234567' } }, meta(), clock));
const line = { kind: 'animator', name: 'Аниматор', quantity: 2, unit: 'час', priceKop: 300000, planCostKop: 150000 };

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 5 });
  const s = await db.client.query<{ id: string }>(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', 'o@yu.test', 'owner', 'x'), ('А', 'Ф', 'a@yu.test', 'admin', 'x') RETURNING id`);
  owner = { actor: { kind: 'staff', staffId: s.rows[0]!.id, sessionId: randomUUID() }, role: 'owner', network: true, cityIds: new Set(), branchIds: new Set(), at: clock.now() };
  branchId = (await createTestBranch(db.client)).id;
  admin = { actor: { kind: 'staff', staffId: s.rows[1]!.id, sessionId: randomUUID() }, role: 'admin', network: false, cityIds: new Set(), branchIds: new Set([branchId]), at: clock.now() };
  for (const t of (await db.client.query<{ id: string; code: string }>('SELECT id, code FROM app.event_types')).rows) types[t.code] = t.id;
});
afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('S3-51: строки', () => {
  it('стоимость = Σ активных quantity × price − discount; удаление – статусом с причиной', async () => {
    const e = await newEvent();
    const a = await tx((c) => addLine(c, owner, e.id, line, meta(), clock));
    const b = await tx((c) => addLine(c, owner, e.id, { kind: 'catering', name: 'Стол', quantity: 1.5, unit: 'набор', priceKop: 100000, discountKop: 50000, discountReason: 'постоянный' }, meta(), clock));
    expect((await agreedOf(pool, e.id)).agreedKop).toBe(600000 + 100000);
    expect(await codeOf(tx((c) => removeLine(c, owner, b.id, { rowVersion: b.rowVersion }, meta(), clock)))).toBe('COMMENT_REQUIRED');
    const removed = await tx((c) => removeLine(c, owner, b.id, { rowVersion: b.rowVersion, reason: 'отказ' }, meta(), clock));
    expect(removed).toMatchObject({ status: 'removed', removedReason: 'отказ' });
    expect((await agreedOf(pool, e.id)).agreedKop).toBe(600000);
    expect((await listLines(pool, e.id)).map((l) => l.id)).toEqual([a.id, b.id]);
    await expect(pool.query('DELETE FROM app.event_lines WHERE id = $1', [b.id])).rejects.toMatchObject({ code: '42501' });
  });
  it('скидка без причины – COMMENT_REQUIRED; скидка больше строки – отказ', async () => {
    const e = await newEvent();
    expect(await codeOf(tx((c) => addLine(c, owner, e.id, { ...line, discountKop: 100 }, meta(), clock)))).toBe('COMMENT_REQUIRED');
    expect(await codeOf(tx((c) => addLine(c, owner, e.id, { ...line, discountKop: 700000, discountReason: 'x' }, meta(), clock)))).toBe('VALIDATION_FAILED');
  });
  it('количество: 1,1 и 0,29 принимаются (плавающая точка), 2,675 – три знака, отказ', async () => {
    const e = await newEvent();
    expect((await tx((c) => addLine(c, owner, e.id, { ...line, quantity: 1.1 }, meta(), clock))).quantity).toBe(1.1);
    expect((await tx((c) => addLine(c, owner, e.id, { ...line, quantity: 0.29 }, meta(), clock))).quantity).toBe(0.29);
    expect(await codeOf(tx((c) => addLine(c, owner, e.id, { ...line, quantity: 2.675 }, meta(), clock)))).toBe('VALIDATION_FAILED');
  });
  it('история цены: before/after в аудите со стоимостью', async () => {
    const e = await newEvent();
    const a = await tx((c) => addLine(c, owner, e.id, line, meta(), clock));
    await tx((c) => updateLine(c, owner, a.id, { rowVersion: a.rowVersion, priceKop: 350000 }, meta(), clock));
    const log = await db.client.query(`SELECT before, after FROM journal.audit_events WHERE action = 'event.line_updated' AND object_id = $1`, [e.id]);
    expect(log.rows[0].before.priceKop).toBe(300000);
    expect(log.rows[0].after.priceKop).toBe(350000);
    expect(log.rows[0].after.agreedKop).toBe(700000);
  });
  it('цена и скидка Администратором – FORBIDDEN; оргполя и 0 ₽ – можно', async () => {
    const e = await newEvent();
    expect(await codeOf(tx((c) => addLine(c, admin, e.id, line, meta(admin), clock)))).toBe('FORBIDDEN');
    const free = await tx((c) => addLine(c, admin, e.id, { ...line, priceKop: 0 }, meta(admin), clock));
    expect(await codeOf(tx((c) => updateLine(c, admin, free.id, { rowVersion: free.rowVersion, priceKop: 100 }, meta(admin), clock)))).toBe('FORBIDDEN');
    expect(await codeOf(tx((c) => updateLine(c, admin, free.id, { rowVersion: free.rowVersion, discountKop: 1, discountReason: 'x' }, meta(admin), clock)))).toBe('FORBIDDEN');
    const u = await tx((c) => updateLine(c, admin, free.id, { rowVersion: free.rowVersion, comment: 'с шарами' }, meta(admin), clock));
    expect(u.comment).toBe('с шарами');
  });
  it('устаревшая форма – VERSION_CONFLICT; завершённое мероприятие – EVENT_CLOSED', async () => {
    const e = await newEvent();
    const a = await tx((c) => addLine(c, owner, e.id, line, meta(), clock));
    await tx((c) => updateLine(c, owner, a.id, { rowVersion: a.rowVersion, comment: 'x' }, meta(), clock));
    expect(await codeOf(tx((c) => updateLine(c, owner, a.id, { rowVersion: a.rowVersion, comment: 'y' }, meta(), clock)))).toBe('VERSION_CONFLICT');
    await tx((c) => changeEventStatus(c, owner, e.id, { rowVersion: e.rowVersion, to: 'cancelled', reason: 'x' }, meta(), clock));
    expect(await codeOf(tx((c) => addLine(c, owner, e.id, line, meta(), clock)))).toBe('EVENT_CLOSED');
  });
});

describe('S3-51: пакеты', () => {
  it('applyPackage копирует строки; правка строки не меняет шаблон; Администратор ставит цену пакета', async () => {
    const pack = await tx((c) => createPackage(c, owner, { typeId: types.other, name: 'Стандарт', lines: [line, { kind: 'decor', name: 'Шары', quantity: 1, unit: 'набор', priceKop: 90000 }], approxPriceKop: 700000 }, meta(), clock));
    const e = await newEvent();
    const copied = await tx((c) => applyPackage(c, admin, e.id, { packageId: pack.id }, meta(admin), clock));
    expect(copied).toHaveLength(2);
    expect((await agreedOf(pool, e.id)).agreedKop).toBe(690000);
    await tx((c) => updateLine(c, owner, copied[0]!.id, { rowVersion: 1, priceKop: 1, comment: 'другая цена' }, meta(), clock));
    const again = (await listPackages(pool)).find((p) => p.id === pack.id)!;
    expect(again.lines[0]!.priceKop).toBe(300000);
    // Администратор: цена строки равна цене пакета мероприятия – можно, другая – нельзя
    expect(await codeOf(tx((c) => addLine(c, admin, e.id, { ...line }, meta(admin), clock)))).toBe('ok');
    expect(await codeOf(tx((c) => addLine(c, admin, e.id, { ...line, priceKop: 299999 }, meta(admin), clock)))).toBe('FORBIDDEN');
  });
  it('пакет чужого типа и архивный – отказ; архив вместо удаления; справочник – только Владелец', async () => {
    const pack = await tx((c) => createPackage(c, owner, { typeId: types.program, name: 'П', lines: [] }, meta(), clock));
    const e = await newEvent();
    expect(await codeOf(tx((c) => applyPackage(c, owner, e.id, { packageId: pack.id }, meta(), clock)))).toBe('VALIDATION_FAILED');
    const arch = await tx((c) => updatePackage(c, owner, pack.id, { rowVersion: pack.rowVersion, status: 'archived' }, meta(), clock));
    expect(arch.status).toBe('archived');
    expect((await listPackages(pool)).some((p) => p.id === pack.id)).toBe(false);
    expect(await codeOf(tx((c) => createPackage(c, admin, { typeId: types.other, name: 'Н', lines: [] }, meta(admin), clock)))).toBe('FORBIDDEN');
    const log = await db.client.query(`SELECT 1 FROM journal.audit_events WHERE action = 'event.package.archived' AND object_id = $1`, [pack.id]);
    expect(log.rowCount).toBe(1);
  });
  it('тип: создание и архив; праздник и день рождения не архивируются', async () => {
    const t = await tx((c) => createEventType(c, owner, { code: 'quest', name: 'Квест' }, meta(), clock));
    expect((await tx((c) => updateEventType(c, owner, t.id, { rowVersion: t.rowVersion, status: 'archived' }, meta(), clock))).status).toBe('archived');
    expect(await codeOf(tx((c) => updateEventType(c, owner, types.birthday_party!, { rowVersion: 1, status: 'archived' }, meta(), clock)))).toBe('VALIDATION_FAILED');
  });
});

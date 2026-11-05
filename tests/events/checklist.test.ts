// S3-53: чек-лист – посев 10 пунктов 11 §6, статусы и ответственный, пункт не удаляется, только «не нужно»; пункт «оплата»
// показывает остаток и не меняет его (касса не трогается).
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { withTx } from '../../apps/api/src/modules/clients/index.ts';
import { addChecklistItem, listChecklist, updateChecklistItem } from '../../apps/api/src/modules/events/checklist.ts';
import { createEvent } from '../../apps/api/src/modules/events/events.ts';
import { createTestBranch } from '../helpers/network.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const clock = fixedClock('2026-11-14T05:00:00Z');
let db: TestDatabase;
let pool: pg.Pool;
let owner: AccessContext;
let branchId = '';
let typeId = '';

const meta = (): AuditRequestMeta => ({ actor: owner.actor, access: owner, source: 'crm', requestId: randomUUID() });
const tx = <T>(fn: (c: pg.PoolClient) => Promise<T>) => withTx(pool, fn);
const newEvent = () => tx((c) => createEvent(c, owner, { typeId, branchId, customer: { name: 'Анна', phone: '+79131234567' } }, meta(), clock));
const due = (kop: number) => async () => kop;

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 5 });
  const s = await db.client.query<{ id: string }>(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', 'o@yu.test', 'owner', 'x') RETURNING id`);
  owner = { actor: { kind: 'staff', staffId: s.rows[0]!.id, sessionId: randomUUID() }, role: 'owner', network: true, cityIds: new Set(), branchIds: new Set(), at: clock.now() };
  branchId = (await createTestBranch(db.client)).id;
  typeId = (await db.client.query<{ id: string }>(`SELECT id FROM app.event_types WHERE code = 'other'`)).rows[0]!.id;
});
afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('S3-53: чек-лист', () => {
  it('посев: 10 пунктов 11 §6 в порядке, все todo', async () => {
    const e = await newEvent();
    const items = await listChecklist(pool, e.id, due(0));
    expect(items.map((i) => i.code)).toEqual(['date', 'composition', 'participants', 'responsible', 'contractor', 'catering', 'room', 'purchase', 'payment', 'gift']);
    expect(new Set(items.map((i) => i.status))).toEqual(new Set(['todo']));
  });
  it('статус, ответственный, комментарий – с автором, временем и аудитом', async () => {
    const e = await newEvent();
    const [first] = await listChecklist(pool, e.id, due(0));
    const u = await tx((c) => updateChecklistItem(c, owner, first!.id, { status: 'done', responsibleStaffId: owner.actor.staffId, comment: 'созвонились' }, meta(), clock));
    expect(u).toMatchObject({ status: 'done', responsibleStaffId: owner.actor.staffId, comment: 'созвонились', updatedBy: owner.actor.staffId, updatedAt: clock.now().toISOString() });
    const log = await db.client.query(`SELECT after FROM journal.audit_events WHERE action = 'event.checklist_changed' AND object_id = $1`, [e.id]);
    expect(log.rows[0].after).toMatchObject({ itemId: first!.id, status: 'done' });
  });
  it('пункт не удаляется, только «не нужно»; свой пункт добавляется в конец', async () => {
    const e = await newEvent();
    const added = await tx((c) => addChecklistItem(c, owner, e.id, { title: 'Купить торт' }, meta(), clock));
    const list = await listChecklist(pool, e.id, due(0));
    expect(list.at(-1)!.id).toBe(added.id);
    await expect(pool.query('DELETE FROM app.event_checklist WHERE id = $1', [added.id])).rejects.toMatchObject({ code: '42501' });
    const off = await tx((c) => updateChecklistItem(c, owner, added.id, { status: 'not_needed' }, meta(), clock));
    expect(off.status).toBe('not_needed');
    expect(await listChecklist(pool, e.id, due(0))).toHaveLength(11);
  });
  it('пункт «оплата» показывает остаток и не меняет его: операций кассы нет', async () => {
    const e = await newEvent();
    const before = (await db.client.query('SELECT count(*)::int n FROM journal.finance_operations')).rows[0].n;
    const payment = (await listChecklist(pool, e.id, due(500000))).find((i) => i.code === 'payment')!;
    expect(payment.dueKop).toBe(500000);
    await tx((c) => updateChecklistItem(c, owner, payment.id, { status: 'done' }, meta(), clock));
    const after = (await listChecklist(pool, e.id, due(500000))).find((i) => i.code === 'payment')!;
    expect(after).toMatchObject({ status: 'done', dueKop: 500000 });
    expect((await db.client.query('SELECT count(*)::int n FROM journal.finance_operations')).rows[0].n).toBe(before);
    expect((await listChecklist(pool, e.id, due(0))).filter((i) => i.dueKop !== undefined)).toHaveLength(1);
  });
});

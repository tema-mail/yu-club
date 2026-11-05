// S3-32: учётки PS/VR (K19 §5, приёмка 10 §17 п.5–6): перепривязка закрывает прежнюю с датой и причиной, полей пароля нет ни в
// схеме команды, ни в таблице; Администратор учётки не получает.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { bindAccount, listAccounts, rebindAccount } from '../../apps/api/src/modules/equipment/accounts.ts';
import { createEquipment, setEquipmentStatus } from '../../apps/api/src/modules/equipment/items.ts';
import { createEquipmentWorld, ctxOf, fails, inTx, metaOf, type EquipmentWorld } from '../helpers/equipment.ts';

const clock = fixedClock('2026-11-14T05:00:00Z');
let w: EquipmentWorld;
let owner: AccessContext;
let director: AccessContext;
let admin: AccessContext;
let first = '';
let second = '';

const bind = (body: Record<string, unknown>, who = director) =>
  inTx(w.pool, (t) => bindAccount(t, who, { platform: 'playstation', displayName: 'psn-club-1', equipmentId: first, branchId: w.branch, boundFrom: '2026-11-01', ...body }, metaOf(who), clock));
const rebind = (id: string, body: Record<string, unknown>, who = director) => inTx(w.pool, (t) => rebindAccount(t, who, id, body, metaOf(who), clock));
const item = (name: string) => inTx(w.pool, (t) => createEquipment(t, owner, { name, categoryId: w.categoryId, branchId: w.branch }, metaOf(owner), clock));

beforeAll(async () => {
  w = await createEquipmentWorld();
  owner = ctxOf(clock, 'owner');
  director = ctxOf(clock, 'director', [w.branch]);
  admin = ctxOf(clock, 'admin', [w.branch]);
  first = (await item('PS5 №1')).id;
  second = (await item('PS5 №2')).id;
});
afterAll(() => w.close());

describe('учётки PS/VR (10 §5)', () => {
  it('полей пароля нет: схема отвергает лишнее, в таблице колонок секрета нет', async () => {
    await fails(bind({ password: 'секрет' }), 'VALIDATION_FAILED');
    await fails(bind({ code: '1234' }), 'VALIDATION_FAILED');
    const created = await bind({});
    await fails(rebind(created.id, { equipmentId: second, at: '2026-11-10', reason: 'x', password: 'секрет' }), 'VALIDATION_FAILED');
    const cols = await w.db.client.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'app' AND table_name = 'equipment_accounts'`);
    expect(cols.rows.map((c) => c.column_name).filter((c) => /pass|secret|pin|code|token/.test(c))).toEqual([]);
    expect(JSON.stringify(created)).not.toMatch(/password/);
  });

  it('перепривязка закрывает прежнюю связь с датой и причиной и создаёт новую, аудит (10 §5.4)', async () => {
    const a = await bind({ accessHint: 'у директора в сейфе', displayName: 'psn-club-2' });
    const r = await rebind(a.id, { equipmentId: second, at: '2026-11-10', reason: 'приставка в ремонте' });
    expect(r.ended).toMatchObject({ id: a.id, status: 'ended', boundTo: '2026-11-10', endReason: 'приставка в ремонте', equipmentId: first });
    expect(r.current).toMatchObject({ status: 'active', equipmentId: second, boundFrom: '2026-11-10', boundTo: null, displayName: 'psn-club-2', accessHint: 'у директора в сейфе' });
    await fails(rebind(a.id, { equipmentId: first, at: '2026-11-11', reason: 'ещё раз' }), 'VERSION_CONFLICT');
    const audit = await w.db.client.query<{ action: string; reason: string }>(`SELECT action, reason FROM journal.audit_events WHERE object_id = $1 AND action = 'equipment.account.rebound'`, [a.id]);
    expect(audit.rows[0]?.reason).toBe('приставка в ремонте');
    const history = await listAccounts(w.pool, owner, { equipmentId: first });
    expect(history.find((x) => x.id === a.id)?.status).toBe('ended');
  });

  it('снятие без новой связи; дата раньше начала – отказ; списанное не привязывается', async () => {
    const a = await bind({ displayName: 'meta-1', platform: 'meta' });
    await fails(rebind(a.id, { equipmentId: null, at: '2026-10-01', reason: 'x' }), 'VALIDATION_FAILED');
    expect((await rebind(a.id, { equipmentId: null, at: '2026-11-12', reason: 'продали' })).current).toBeNull();
    const dead = await item('Сломанный');
    await inTx(w.pool, (t) => setEquipmentStatus(t, owner, dead.id, { rowVersion: 1, status: 'written_off', reason: 'сгорел' }, metaOf(owner), clock));
    await fails(bind({ equipmentId: dead.id }), 'EQUIPMENT_WRITTEN_OFF');
  });

  it('Администратор учётки не получает и не создаёт; чужой филиал – 404', async () => {
    await fails(listAccounts(w.pool, admin, { equipmentId: first }), 'FORBIDDEN');
    await fails(bind({}, admin), 'FORBIDDEN');
    const foreign = ctxOf(clock, 'director', [w.other]);
    await fails(bind({}, foreign), 'NOT_FOUND');
    await fails(listAccounts(w.pool, foreign, { equipmentId: first }), 'NOT_FOUND');
    expect((await listAccounts(w.pool, director, { branchId: w.branch })).length).toBeGreaterThan(0);
  });
});

// S3-34: ремонт (K19 §6, приёмка 10 §17 п.7–8) на настоящей Postgres: дата поломки ≠ дате обнаружения, «неизвестна» без даты – можно;
// переход не по таблице – REPAIR_TRANSITION_INVALID; план 15 000 ₽ без согласования – REPAIR_APPROVAL_REQUIRED, согласование Директором –
// FORBIDDEN; первоначальное описание не перезаписывается; статус оборудования следует за ремонтом.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateDown, migrateUp } from '../../db/migrate.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { createEquipment, getEquipment } from '../../apps/api/src/modules/equipment/items.ts';
import { approveRepair, changeRepairStatus, getRepair, listRepairs, registerRepair, updateRepair, type RepairDto } from '../../apps/api/src/modules/equipment/repairs.ts';
import { createEquipmentWorld, ctxOf, fails, inTx, metaOf, type EquipmentWorld } from '../helpers/equipment.ts';
import { createTestDatabase } from '../helpers/pg.ts';

const clock = fixedClock('2026-11-14T05:00:00Z');
const DETECTED = '2026-11-14T04:00:00Z';
const BROKEN = '2026-11-13T20:00:00Z';
let w: EquipmentWorld;
let owner: AccessContext;
let director: AccessContext;
let admin: AccessContext;
let foreign: AccessContext;

const item = async (body: object = {}) => inTx(w.pool, (t) => createEquipment(t, owner, { name: 'Шлем', categoryId: w.categoryId, branchId: w.branch, ...body }, metaOf(owner), clock));
const register = (equipmentId: string, body: object = {}, who = admin) =>
  inTx(w.pool, (t) => registerRepair(t, who, { equipmentId, detectedAt: DETECTED, brokenAt: BROKEN, symptoms: 'не включается', priority: 'high', impact: 'partial', ...body }, metaOf(who), clock));
const update = (id: string, body: object, who = director) => inTx(w.pool, (t) => updateRepair(t, who, id, body, metaOf(who), clock));
const status = (r: { id: string; rowVersion: number }, to: string, who = director, comment: string | undefined = 'переход') =>
  inTx(w.pool, (t) => changeRepairStatus(t, who, r.id, { rowVersion: r.rowVersion, to, comment }, metaOf(who), clock));
const approve = (r: { id: string; rowVersion: number }, decision: string, who = owner) => inTx(w.pool, (t) => approveRepair(t, who, r.id, { rowVersion: r.rowVersion, decision, comment: 'решение' }, metaOf(who), clock));

beforeAll(async () => {
  w = await createEquipmentWorld();
  owner = ctxOf(clock, 'owner');
  director = ctxOf(clock, 'director', [w.branch]);
  admin = ctxOf(clock, 'admin', [w.branch]);
  foreign = ctxOf(clock, 'director', [w.other]);
});
afterAll(() => w.close());

describe('0307: схема', () => {
  it('вверх/вниз/вверх на чистой базе', async () => {
    const clean = await createTestDatabase({ migrate: true });
    try {
      const applied = (await clean.client.query<{ version: string }>(`SELECT version FROM schema_migrations ORDER BY version`)).rows.map((r) => r.version);
      await migrateDown(clean.client, applied.length - applied.indexOf('0307'));
      expect((await clean.client.query<{ t: string | null }>(`SELECT to_regclass('app.repairs')::text t`)).rows[0]!.t).toBeNull();
      expect((await clean.client.query<{ t: string | null }>(`SELECT to_regclass('app.equipment_items')::text t`)).rows[0]!.t).not.toBeNull();
      await migrateUp(clean.client);
    } finally {
      await clean.drop();
    }
  });

  it('у yu_app нет правки описания и дат, нет DELETE; история ремонта только дополняется', async () => {
    const eq = await item();
    const { repair } = await register(eq.id);
    await expect(w.pool.query(`UPDATE app.repairs SET symptoms = 'другое' WHERE id = $1`, [repair.id])).rejects.toMatchObject({ code: '42501' });
    await expect(w.pool.query(`UPDATE app.repairs SET detected_at = now() WHERE id = $1`, [repair.id])).rejects.toMatchObject({ code: '42501' });
    await expect(w.pool.query(`DELETE FROM app.repairs WHERE id = $1`, [repair.id])).rejects.toMatchObject({ code: '42501' });
    await expect(w.pool.query(`UPDATE journal.repair_status_history SET comment = 'x' WHERE repair_id = $1`, [repair.id])).rejects.toBeDefined();
  });
});

describe('регистрация (10 §6, §7.1)', () => {
  it('три даты различаются; «неизвестна» без даты – можно; без отметки и позже обнаружения – REPAIR_DATES_INVALID (приёмка 7–8)', async () => {
    const eq = await item({ unitId: w.units.VR1 });
    const r = await register(eq.id, { reportedByName: 'Администратор Анна' });
    expect(r.repair).toMatchObject({ brokenAt: new Date(BROKEN).toISOString(), detectedAt: new Date(DETECTED).toISOString(), registeredAt: clock.now().toISOString(), brokenAtUnknown: false, status: 'new', unitId: w.units.VR1, roomId: w.room });
    expect(r.repair.number).toMatch(/^R-\d{6}$/);
    expect(r.repair.reportedBy).toEqual({ staffId: admin.actor.staffId, name: 'Администратор Анна' });
    const unknown = await register(eq.id, { brokenAt: null, brokenAtUnknown: true });
    expect(unknown.repair).toMatchObject({ brokenAt: null, brokenAtUnknown: true });
    await fails(register(eq.id, { brokenAt: null }), 'REPAIR_DATES_INVALID');
    await fails(register(eq.id, { brokenAtUnknown: true }), 'REPAIR_DATES_INVALID');
    await fails(register(eq.id, { brokenAt: '2026-11-14T04:30:00Z' }), 'REPAIR_DATES_INVALID');
    await fails(register(eq.id, { detectedAt: '2026-11-14T06:00:00Z' }), 'REPAIR_DATES_INVALID');
  });

  it('событие и аудит; повтор показывает прошлые ремонты; связь ставит сотрудник, чужой ремонт – отказ', async () => {
    const eq = await item({ unitId: w.units.VR2 });
    const first = await register(eq.id);
    expect(first.details.history).toEqual([]);
    const second = await register(eq.id, { previousRepairId: first.repair.id });
    expect(second.details.history.map((h) => h.id)).toEqual([first.repair.id]);
    expect(second.repair.previousRepairId).toBe(first.repair.id);
    const away = await item();
    await fails(register(away.id, { previousRepairId: first.repair.id }), 'VALIDATION_FAILED');
    const outbox = await w.db.client.query<{ payload: { number: string; autoBlockId: string | null } }>(`SELECT payload FROM app.outbox_events WHERE event_type = 'repair.registered' AND aggregate_id = $1`, [first.repair.id]);
    expect(outbox.rows[0]!.payload).toMatchObject({ number: first.repair.number, autoBlockId: null });
    expect((await w.db.client.query(`SELECT 1 FROM journal.audit_events WHERE action = 'repair.registered' AND object_id = $1`, [first.repair.id])).rowCount).toBe(1);
  });

  it('регистрация только предлагает блокировку: блокировок нет; impact none – без предложения; списанное – отказ', async () => {
    const eq = await item({ unitId: w.units.PS4 });
    const r = await register(eq.id);
    expect(r.blockProposal).toMatchObject({ target: { type: 'unit', ids: [w.units.PS4] }, reasonCode: 'repair' });
    expect(r.autoBlock).toBeNull();
    expect((await w.db.client.query(`SELECT 1 FROM app.resource_blocks WHERE $1 = ANY(target_ids)`, [w.units.PS4])).rowCount).toBe(0);
    expect((await register(eq.id, { impact: 'none' })).blockProposal).toBeNull();
    const noPlace = await item();
    expect((await register(noPlace.id)).blockProposal).toBeNull();
  });

  it('права: чужой филиал – 404; лишние поля – отказ; Администратор регистрирует, но не правит', async () => {
    const eq = await item();
    await fails(register(eq.id, {}, foreign), 'NOT_FOUND');
    await fails(register(randomUUID()), 'NOT_FOUND');
    await fails(register(eq.id, { status: 'closed' }), 'VALIDATION_FAILED');
    const { repair } = await register(eq.id);
    await fails(update(repair.id, { rowVersion: 1, diagnostics: 'x' }, admin), 'FORBIDDEN');
    await fails(status(repair, 'diagnostics', admin), 'FORBIDDEN');
    await fails(getRepair(w.pool, foreign, repair.id), 'NOT_FOUND');
  });
});

describe('правка и описание (10 §7.2–§7.3)', () => {
  it('первоначальное описание не перезаписывается: поле отвергается схемой; диагностика и план – отдельно', async () => {
    const eq = await item();
    const { repair } = await register(eq.id);
    await fails(update(repair.id, { rowVersion: 1, symptoms: 'другое' }), 'VALIDATION_FAILED');
    const u = await update(repair.id, { rowVersion: 1, diagnostics: 'сгорела плата', cause: 'скачок', plan: { works: 'замена платы', start: '2026-11-15', end: '2026-11-20', costKop: 500000, partsNeeded: true } });
    expect(u).toMatchObject({ symptoms: 'не включается', diagnostics: 'сгорела плата', plan: { works: 'замена платы', end: '2026-11-20', costKop: 500000, partsNeeded: true } });
    await fails(update(repair.id, { rowVersion: 1, cause: 'x' }), 'VERSION_CONFLICT');
    await fails(update(repair.id, { rowVersion: u.rowVersion, plan: { start: '2026-11-21' } }), 'VALIDATION_FAILED');
  });
});

describe('переходы (K19 §6)', () => {
  it('не по таблице – REPAIR_TRANSITION_INVALID; без комментария – COMMENT_REQUIRED; closed – только закрытием; каждая смена в истории', async () => {
    const eq = await item();
    const { repair } = await register(eq.id);
    await fails(status(repair, 'done_pending_check'), 'REPAIR_TRANSITION_INVALID');
    await fails(status(repair, 'closed'), 'REPAIR_TRANSITION_INVALID');
    await fails(inTx(w.pool, (t) => changeRepairStatus(t, director, repair.id, { rowVersion: repair.rowVersion, to: 'diagnostics' }, metaOf(director), clock)), 'COMMENT_REQUIRED');
    const d = await status(repair, 'diagnostics');
    const ip = await status(d, 'in_repair');
    await fails(status(ip, 'cancelled'), 'REPAIR_TRANSITION_INVALID'); // после in_repair – только закрытием
    const done = await status(ip, 'done_pending_check');
    await fails(status(done, 'closed'), 'REPAIR_TRANSITION_INVALID');
    const history = await w.db.client.query<{ from_status: string | null; to_status: string; comment: string; by_staff_id: string }>(`SELECT from_status, to_status, comment, by_staff_id FROM journal.repair_status_history WHERE repair_id = $1 ORDER BY id`, [repair.id]);
    expect(history.rows.map((h) => h.to_status)).toEqual(['new', 'diagnostics', 'in_repair', 'done_pending_check']);
    expect(history.rows[1]).toMatchObject({ from_status: 'new', comment: 'переход', by_staff_id: director.actor.staffId });
    const cancelled = await register(eq.id);
    expect((await status(cancelled.repair, 'cancelled')).status).toBe('cancelled');
    await fails(update(cancelled.repair.id, { rowVersion: cancelled.repair.rowVersion + 1, cause: 'x' }), 'REPAIR_TRANSITION_INVALID');
  });

  it('статус оборудования следует за ремонтом: диагностика, ремонт, ожидание запчастей; блокировок не появляется', async () => {
    const eq = await item({ unitId: w.units.PS4 });
    const { repair } = await register(eq.id);
    const statusOf = async () => (await getEquipment(w.pool, owner, eq.id)).status;
    expect(await statusOf()).toBe('in_service'); // регистрация сама статус не меняет
    const d = await status(repair, 'diagnostics');
    expect(await statusOf()).toBe('diagnostics');
    const ip = await status(d, 'in_repair');
    expect(await statusOf()).toBe('repair');
    await status(ip, 'awaiting_parts');
    expect(await statusOf()).toBe('awaiting_parts');
    expect((await w.db.client.query(`SELECT 1 FROM app.repair_blocks WHERE repair_id = $1`, [repair.id])).rowCount).toBe(0);
    const audit = await w.db.client.query<{ after: { source: string } }>(`SELECT after FROM journal.audit_events WHERE object_id = $1 AND action = 'equipment.status_changed' ORDER BY id`, [eq.id]);
    expect(audit.rows.map((x) => x.after.source)).toEqual(['repair', 'repair', 'repair']);
  });
});

describe('согласование выше порога (Q-52)', () => {
  const planned = async (costKop: number): Promise<RepairDto> => {
    const eq = await item();
    const { repair } = await register(eq.id);
    return update(repair.id, { rowVersion: 1, plan: { works: 'замена', costKop } });
  };

  it('план 15 000 ₽ без согласования – REPAIR_APPROVAL_REQUIRED; 10 000 ₽ – без согласования', async () => {
    const big = await planned(1_500_000);
    expect(big.approval.required).toBe(true);
    await fails(status(big, 'planned'), 'REPAIR_APPROVAL_REQUIRED');
    await fails(status(big, 'in_repair'), 'REPAIR_APPROVAL_REQUIRED');
    const small = await planned(1_000_000);
    expect(small.approval.required).toBe(false);
    expect((await status(small, 'planned')).status).toBe('planned');
  });

  it('согласование Директором – FORBIDDEN; Владелец согласует → planned, отклоняет → diagnostics; не в ожидании – отказ', async () => {
    const big = await planned(1_500_000);
    await fails(approve(big, 'approve'), 'REPAIR_TRANSITION_INVALID');
    const d = await status(big, 'diagnostics');
    const waiting = await status(d, 'awaiting_approval');
    await fails(status(waiting, 'planned'), 'REPAIR_TRANSITION_INVALID'); // только через approveRepair
    await fails(approve(waiting, 'approve', director), 'FORBIDDEN');
    const rejected = await approve(waiting, 'reject');
    expect(rejected.status).toBe('diagnostics');
    expect(rejected.approval.approvedAt).toBeNull();
    const again = await status(rejected, 'awaiting_approval');
    const ok = await approve(again, 'approve');
    expect(ok).toMatchObject({ status: 'planned', approval: { approvedBy: owner.actor.staffId } });
    expect((await status(ok, 'in_repair')).status).toBe('in_repair');
    expect((await w.db.client.query(`SELECT 1 FROM journal.audit_events WHERE action = 'repair.approved' AND object_id = $1`, [big.id])).rowCount).toBe(2);
  });

  it('изменение плана после согласования выше порога сбрасывает согласование', async () => {
    const big = await planned(2_000_000);
    const d = await status(big, 'diagnostics');
    const ok = await approve(await status(d, 'awaiting_approval'), 'approve');
    const changed = await update(ok.id, { rowVersion: ok.rowVersion, plan: { costKop: 2_500_000 } });
    expect(changed.approval).toMatchObject({ required: true, approvedAt: null });
    await fails(status(changed, 'in_repair'), 'REPAIR_APPROVAL_REQUIRED');
    // выход из сброса: Директору нельзя, Владелец согласует на месте, статус тот же, работа продолжается
    await fails(approve(changed, 'approve', director), 'FORBIDDEN');
    const again = await approve(changed, 'approve');
    expect(again).toMatchObject({ status: 'planned', approval: { approvedBy: owner.actor.staffId } });
    const working = await status(again, 'in_repair');
    await fails(approve(working, 'approve'), 'REPAIR_TRANSITION_INVALID'); // согласовывать нечего
    // план подняли уже в работе: на проверку без согласования нельзя; отказ на месте согласования не даёт
    const raised = await update(working.id, { rowVersion: working.rowVersion, plan: { costKop: 3_000_000 } });
    await fails(status(raised, 'done_pending_check'), 'REPAIR_APPROVAL_REQUIRED');
    const refused = await approve(raised, 'reject');
    expect(refused).toMatchObject({ status: 'in_repair', approval: { approvedAt: null } });
    await fails(status(refused, 'done_pending_check'), 'REPAIR_APPROVAL_REQUIRED');
    expect((await status(await approve(refused, 'approve'), 'done_pending_check')).status).toBe('done_pending_check');
    // правка диагностики план не меняет – согласование цело
    const okAgain = await planned(2_000_000);
    const a = await approve(await status(await status(okAgain, 'diagnostics'), 'awaiting_approval'), 'approve');
    expect((await update(a.id, { rowVersion: a.rowVersion, diagnostics: 'подробнее' })).approval.approvedAt).not.toBeNull();
  });

  it('порог null – согласование не требуется', async () => {
    await w.db.client.query(`INSERT INTO app.settings_values (key, level, value, valid_from, created_by) VALUES ('repair.approval_threshold_kop', 'network', 'null', '2026-01-01', $1)`, [randomUUID()]);
    try {
      expect((await status(await planned(9_000_000), 'planned')).status).toBe('planned');
    } finally {
      await w.db.client.query(`DELETE FROM app.settings_values WHERE key = 'repair.approval_threshold_kop'`);
    }
  });
});

describe('список (№341)', () => {
  it('фильтры, зона, просроченный план, курсор', async () => {
    const eq = await item();
    const { repair } = await register(eq.id, { priority: 'critical' });
    const late = await update(repair.id, { rowVersion: 1, plan: { end: '2026-11-01' } });
    const onEq = await listRepairs(w.pool, admin, { equipmentId: eq.id }, clock);
    expect(onEq.items.map((x) => x.id)).toEqual([late.id]);
    expect((await listRepairs(w.pool, foreign, { equipmentId: eq.id }, clock)).items).toEqual([]);
    expect((await listRepairs(w.pool, owner, { planOverdue: 'true', equipmentId: eq.id }, clock)).items).toHaveLength(1);
    expect((await listRepairs(w.pool, owner, { planOverdue: 'false', equipmentId: eq.id }, clock)).items).toHaveLength(0);
    expect((await listRepairs(w.pool, owner, { priority: 'critical', status: 'new', branchId: w.branch, equipmentId: eq.id, from: '2026-11-14T00:00:00Z', to: '2026-11-15T00:00:00Z' }, clock)).items).toHaveLength(1);
    const page = await listRepairs(w.pool, owner, { limit: 1 }, clock);
    expect(page.nextCursor).toMatch(/^R-/);
    const next = await listRepairs(w.pool, owner, { limit: 1, cursor: page.nextCursor }, clock);
    expect(next.items[0]!.number < page.items[0]!.number).toBe(true);
    await fails(listRepairs(w.pool, owner, { cursor: 'мусор' }, clock), 'VALIDATION_FAILED');
  });
});

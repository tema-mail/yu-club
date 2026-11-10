// S4-28 (13 §11): события ленты без источника в outbox – проход таймера раз в час (staff-feed-events.ts) на настоящей Postgres:
// незаполненная смена (филиал открыт, ни одной смены; за notifications.feed_shift_unfilled_hours), мероприятие требует подготовки
// (confirmed/preparing, начало в пределах feed_event_prepare_days, есть пункты чек-листа todo), окончание гарантии (feed_warranty_days).
// Повторный проход не дублирует (ключ – сущность и порог); строки адресованы зоне филиала: пустая смена – shift.manage (Администратор
// не видит), подготовка – event.view, гарантия – equipment.view; чужой филиал не видит.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { runStaffFeedTimers, startStaffFeedTimers } from '../../apps/api/src/modules/notifications/staff-feed-events.ts';
import { listStaffFeed, markFeedRead } from '../../apps/api/src/modules/notifications/staff-feed.ts';
import { createTestBranch } from '../helpers/network.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

// Суббота 14 ноября 2026, 12:00 по Новосибирску. Филиалы открыты 10:00–22:00 ежедневно: сегодня уже идёт, завтра открывается через 22 ч.
const clock = fixedClock('2026-11-14T05:00:00Z');
const SYS = randomUUID();
let db: TestDatabase;
let pool: pg.Pool;
let b1: string;
let b2: string;
let n = 0;
const staff: Record<'dir1' | 'dir2' | 'admin1', string> = { dir1: '', dir2: '', admin1: '' };
const ctx = {} as Record<keyof typeof staff, AccessContext>;
type Row = { id: string; branch_id: string; action: string; ref_type: string; ref_id: string; title: string; body: string | null; dedupe_key: string };

const newStaff = async (role: string) =>
  (await db.client.query<{ id: string }>(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', $1, $2, 'x') RETURNING id`, [`t${n++}@yu.test`, role])).rows[0]!.id;
const access = (staffId: string, role: 'director' | 'admin', branches: string[]): AccessContext =>
  ({ actor: { kind: 'staff', staffId, sessionId: 's' }, role, network: false, cityIds: new Set(), branchIds: new Set(branches), at: clock.now() });
const openDaily = (branchId: string) =>
  db.client.query(`INSERT INTO app.branch_weekly_hours (branch_id, weekday, open_time, close_time, valid_from, created_by) SELECT $1, d, '10:00', '22:00', '2026-01-01', $2 FROM generate_series(1, 7) d`, [branchId, SYS]);
const rows = async (kind: string, branchId?: string) => (await db.client.query<Row>(
  `SELECT id, branch_id, action, ref_type, ref_id, title, body, dedupe_key FROM app.staff_feed_events WHERE kind = $1 AND ($2::uuid IS NULL OR branch_id = $2) ORDER BY title`, [kind, branchId ?? null])).rows;
const ids = async (who: keyof typeof staff) => (await listStaffFeed(pool, ctx[who], { limit: 50 })).items.map((i) => i.id);
async function expectVisible(row: Row, yes: (keyof typeof staff)[], no: (keyof typeof staff)[]): Promise<void> {
  for (const who of yes) expect(await ids(who), who).toContain(row.id);
  for (const who of no) {
    expect(await ids(who), who).not.toContain(row.id);
    await expect(markFeedRead(pool, ctx[who], row.id, clock.now())).rejects.toMatchObject({ code: 'NOT_FOUND' });
  }
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
  b1 = (await createTestBranch(db.client)).id;
  b2 = (await createTestBranch(db.client)).id;
  await openDaily(b1);
  await openDaily(b2);
  staff.dir1 = await newStaff('director');
  staff.dir2 = await newStaff('director');
  staff.admin1 = await newStaff('admin');
  ctx.dir1 = access(staff.dir1, 'director', [b1]);
  ctx.dir2 = access(staff.dir2, 'director', [b2]);
  ctx.admin1 = access(staff.admin1, 'admin', [b1]);
  // b2: сегодня и завтра закрыты сменой, сегодня – событие готовится без пунктов todo, гарантия далеко
  for (const date of ['2026-11-14', '2026-11-15', '2026-11-16']) {
    const [start, end] = [`${date}T03:00:00Z`, `${date}T15:00:00Z`];
    await db.client.query(`INSERT INTO app.staff_shifts (staff_id, branch_id, local_date, period, status, created_by) VALUES ($1, $2, $3, tstzrange($4, $5, '[)'), 'planned', $6)`, [staff.dir2, b2, date, start, end, SYS]);
  }
});
afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('незаполненная смена (05 §6.3, Q-63: ни одного сотрудника)', () => {
  it('b1 без смен: сегодня (идёт) и завтра (через 22 ч) – по строке; b2 со сменами – нет; повтор прохода – 0 новых', async () => {
    const first = await runStaffFeedTimers(pool, clock);
    expect(first.shiftsUnfilled).toBe(2);
    const list = await rows('shift_unfilled', b1);
    expect(list.map((r) => r.title)).toEqual(['Смена 14 ноября не заполнена', 'Смена 15 ноября не заполнена']);
    expect(list[0]).toMatchObject({ action: 'shift.manage', ref_type: 'branch', ref_id: b1, body: 'Филиал открыт 10:00–22:00, ни одного сотрудника на смене', dedupe_key: `shift_unfilled:${b1}:2026-11-14:24` });
    expect(await rows('shift_unfilled', b2)).toHaveLength(0);
    expect((await runStaffFeedTimers(pool, clock)).shiftsUnfilled).toBe(0);
    expect(await rows('shift_unfilled', b1)).toHaveLength(2);
  });

  it('видна Директору филиала; Администратору (нет shift.manage) и Директору другого филиала – нет', async () => {
    const [row] = await rows('shift_unfilled', b1);
    await expectVisible(row!, ['dir1'], ['admin1', 'dir2']);
  });

  it('смена появилась – новый день с ней строки не получает; исключение «закрыто» – тоже', async () => {
    await db.client.query(`INSERT INTO app.staff_shifts (staff_id, branch_id, local_date, period, status, created_by) VALUES ($1, $2, '2026-11-16', tstzrange('2026-11-16T03:00:00Z', '2026-11-16T15:00:00Z', '[)'), 'planned', $3)`, [staff.dir1, b1, SYS]);
    const later = fixedClock('2026-11-15T05:00:00Z'); // воскресенье 12:00: окно до понедельника 12:00 захватывает 16-е
    const r = await runStaffFeedTimers(pool, later);
    expect(r.shiftsUnfilled).toBe(0); // 15-е уже записано, 16-е закрыто сменой
    expect((await rows('shift_unfilled', b1)).map((x) => x.title)).not.toContain('Смена 16 ноября не заполнена');
  });
});

describe('мероприятие требует подготовки (11 §6: чек-лист)', () => {
  const event = async (branchId: string, status: string, start: string, todo: number, number: string) => {
    const type = (await db.client.query<{ id: string }>(`SELECT id FROM app.event_types WHERE code = 'other'`)).rows[0]!.id;
    const id = (await db.client.query<{ id: string }>(
      `INSERT INTO app.events (number, type_id, branch_id, title, planned_start, planned_end, status, customer_name, customer_phone_e164, source, created_by_type)
       VALUES ($1, $2, $3, 'Выпускной', $4, $4::timestamptz + interval '2 hours', $5, 'Анна', '+79131110001', 'crm', 'system') RETURNING id`,
      [number, type, branchId, start, status],
    )).rows[0]!.id;
    for (let i = 0; i < 3; i++) await db.client.query(`INSERT INTO app.event_checklist (event_id, title, status, sort_order) VALUES ($1, $2, $3, $4)`, [id, `Пункт ${i}`, i < todo ? 'todo' : 'done', i]);
    return id;
  };

  it('подтверждённое через 2 дня с пунктами todo – одна строка зоне event.view; готовое, далёкое и неподтверждённое – нет; повтор – 0', async () => {
    const soon = await event(b1, 'confirmed', '2026-11-16T07:00:00Z', 2, 'EV-0001');
    await event(b1, 'preparing', '2026-11-15T07:00:00Z', 0, 'EV-0002'); // всё сделано
    await event(b1, 'confirmed', '2026-11-20T07:00:00Z', 3, 'EV-0003'); // дальше 3 дней
    await event(b1, 'awaiting_confirmation', '2026-11-15T07:00:00Z', 3, 'EV-0004');
    await event(b2, 'preparing', '2026-11-15T07:00:00Z', 1, 'EV-0005');
    const r = await runStaffFeedTimers(pool, clock);
    expect(r.eventsPreparation).toBe(2);
    const [row] = await rows('event_preparation', b1);
    expect(await rows('event_preparation', b1)).toHaveLength(1);
    expect(row).toMatchObject({ action: 'event.view', ref_type: 'event', ref_id: soon, title: 'Мероприятие № EV-0001: подготовка', body: 'Выпускной, 16 ноября, 14:00, не сделано пунктов чек-листа: 2', dedupe_key: `event_preparation:${soon}:3` });
    await expectVisible(row!, ['dir1', 'admin1'], ['dir2']);
    expect((await runStaffFeedTimers(pool, clock)).eventsPreparation).toBe(0);
  });
});

describe('окончание гарантии (10 §9)', () => {
  const equipment = async (branchId: string, inv: string, status = 'in_service') => {
    const cat = (await db.client.query<{ id: string }>(`SELECT id FROM app.equipment_categories WHERE name = 'VR-шлемы'`)).rows[0]!.id;
    return (await db.client.query<{ id: string }>(`INSERT INTO app.equipment_items (inventory_number, name, category_id, status, branch_id, created_by) VALUES ($1, 'Шлем', $2, $3, $4, $5) RETURNING id`, [inv, cat, status, branchId, SYS])).rows[0]!.id;
  };
  const warranty = async (equipmentId: string, endsOn: string, status = 'active') =>
    (await db.client.query<{ id: string }>(`INSERT INTO app.equipment_warranties (kind, equipment_id, starts_on, ends_on, status) VALUES ('manufacturer', $1, '2025-11-01', $2, $3) RETURNING id`, [equipmentId, endsOn, status])).rows[0]!.id;

  it('гарантия, заканчивающаяся в пределах 30 дней, – одна строка зоне equipment.view; далёкая, недействительная, списанного – нет; повтор – 0', async () => {
    const eq = await equipment(b1, 'INV-000101');
    const w = await warranty(eq, '2026-12-10');
    await warranty(eq, '2027-03-01'); // далеко
    await warranty(await equipment(b1, 'INV-000102'), '2026-11-20', 'invalid');
    await warranty(await equipment(b1, 'INV-000103', 'written_off'), '2026-11-20');
    await warranty(await equipment(b2, 'INV-000104'), '2026-11-14'); // сегодня – ещё действует
    const r = await runStaffFeedTimers(pool, clock);
    expect(r.warrantiesEnding).toBe(2);
    const list = await rows('warranty_ending', b1);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ action: 'equipment.view', ref_type: 'equipment', ref_id: eq, title: 'Гарантия на Шлем заканчивается 10.12.2026', body: 'INV-000101, гарантия производителя до 10.12.2026', dedupe_key: `warranty_ending:${w}:30` });
    await expectVisible(list[0]!, ['dir1', 'admin1'], ['dir2']);
    expect((await runStaffFeedTimers(pool, clock)).warrantiesEnding).toBe(0);
  });

  it('таймер запускается и останавливается без ошибок', async () => {
    const seen: unknown[] = [];
    const task = startStaffFeedTimers({ pool, clock, intervalMs: 10, onError: (e) => seen.push(e) });
    await new Promise((r) => setTimeout(r, 60));
    task.stop();
    expect(seen).toEqual([]);
  });
});

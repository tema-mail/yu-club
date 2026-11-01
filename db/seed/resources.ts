// S1-28. Тестовые данные Э1 поверх засева Э0 (db/seed/dev.ts): в каждом демо-филиале (код demo-*)
//   VR-комната: места VR1, VR2 (vr_seat), единица PS4 без своего ресурса (01 §5.2) и «вся комната» (room_whole из трёх единиц);
//   5 ПК в общем зале; 3 комнаты PS5 (ps_room); базовые тарифы на все бронируемые типы – две ступени длительности
//   [0, 180) и [180, ∞), то есть на любую длительность; два исключения графика (сокращённый день, закрытие);
//   демо-клиенты. Всё создаётся командами модулей (resources, pricing, network calendar) – с проверками и аудитом.
// Повторный запуск не плодит дублей: комнаты ищутся по slug, ресурсы – по имени в филиале, единица PS4 – по коду,
// тарифы – по наличию действующего тарифа типа, исключения – по метке DEMO в причине, клиенты – по телефону.
// Демо-метка – DEMO_MARK в служебных комментариях и причинах, «(демо)» в именах клиентов, телефоны +7900000000x.
// На прод не попадает: assertNotProduction до первого запроса к базе (19 §10.1).
//
// CLI – через db/seed/dev.ts (засев Э0, затем этот); отдельно: APP_ENV=stage DATABASE_URL=... node db/seed/resources.ts
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import type { AuditRequestMeta, Tx } from '../../apps/api/src/core/audit.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import { addDays, systemClock, todayIn, type Clock, type LocalTime, type TimeZone } from '../../apps/api/src/core/time.ts';
import { bookingsProvider } from '../../apps/api/src/modules/booking/providers.ts';
import { applyHoursChange, previewHoursChange } from '../../apps/api/src/modules/network/calendar.ts';
import { createTariff } from '../../apps/api/src/modules/pricing/tariff.ts';
import { createEntity, createUnit } from '../../apps/api/src/modules/resources/routes.ts';
import { withTx, type Pool } from '../../apps/api/src/modules/staff/auth.ts';
import { assertNotProduction, DEMO_MARK } from './dev.ts';

const LOCK_KEY = 7_204_513_028;
const TARIFF_FROM = '2026-01-01T00:00:00Z';
const LONG_FROM_MIN = 180;

/** Цена за единицу (коп.): base – до 3 часов, long – от 3 часов. Единица = шаг типа (15 §7.2). */
const TARIFFS = [
  { type: 'pc', name: 'ПК', unit: 30, base: 10_000, long: 8_500 },
  { type: 'vr_seat', name: 'VR-место', unit: 15, base: 15_000, long: 12_500 },
  { type: 'room_whole', name: 'VR-комната целиком', unit: 15, base: 35_000, long: 30_000 },
  { type: 'ps_room', name: 'PS5-комната', unit: 30, base: 25_000, long: 21_000 },
] as const;

/** Исключения графика: через сколько дней от «сегодня» филиала. Даты гонки S1-26 их обходят (+2 дня). */
const EXCEPTIONS = [
  { inDays: 7, kind: 'short_day', open: '12:00', close: '18:00', reason: 'сокращённый день' },
  { inDays: 14, kind: 'closed', reason: 'санитарный день, филиал закрыт' },
] as const;

export const DEMO_CLIENTS = [
  { phone: '+79000000001', firstName: 'Иван', lastName: 'Петров (демо)' },
  { phone: '+79000000002', firstName: 'Мария', lastName: 'Смирнова (демо)' },
  { phone: '+79000000003', firstName: 'Кирилл', lastName: 'Волков (демо)' },
  { phone: '+79000000004', firstName: 'Алина', lastName: 'Козлова (демо)' },
  { phone: '+79000000005', firstName: 'Тимур', lastName: 'Ахметов (демо)' },
] as const;

export interface BranchResources {
  vrRoomId: string;
  vr1: string;
  vr2: string;
  vrWhole: string;
  ps4UnitId: string;
  pcs: string[];
  ps5: string[];
}

export interface ResourcesSeedReport {
  created: { rooms: number; resources: number; units: number; tariffs: number; exceptions: number; clients: number };
  branches: Record<string, BranchResources>;
}

type Created = ResourcesSeedReport['created'];

interface Ctx {
  tx: Tx;
  ctx: AccessContext;
  meta: AuditRequestMeta;
  clock: Clock;
  created: Created;
}

async function room(c: Ctx, branchId: string, input: { slug: string; name: string; capacity: number; wholeRentAllowed: boolean }): Promise<string> {
  const found = await c.tx.query<{ id: string }>('SELECT id FROM app.rooms WHERE branch_id = $1 AND slug = $2', [branchId, input.slug]);
  if (found.rows[0]) return found.rows[0].id;
  const row = await createEntity(c.tx, c.ctx, 'room', branchId, { ...input, isPublished: true, internalDescription: DEMO_MARK }, c.meta, c.clock);
  c.created.rooms++;
  return row.id;
}

async function resource(
  c: Ctx,
  branchId: string,
  input: { roomId: string | null; type: string; name: string; sortOrder: number; unitCode?: string; unitIds?: string[] },
): Promise<string> {
  const found = await c.tx.query<{ id: string }>(`SELECT id FROM app.resources WHERE branch_id = $1 AND name = $2 AND status <> 'archived'`, [branchId, input.name]);
  if (found.rows[0]) return found.rows[0].id;
  const row = await createEntity(c.tx, c.ctx, 'resource', branchId, { ...input, internalComment: DEMO_MARK }, c.meta, c.clock);
  c.created.resources++;
  return row.id;
}

async function unitOf(c: Ctx, resourceId: string): Promise<string> {
  const r = await c.tx.query<{ unit_id: string }>('SELECT unit_id FROM app.resource_units WHERE resource_id = $1 AND valid_to IS NULL ORDER BY unit_id LIMIT 1', [resourceId]);
  return r.rows[0]!.unit_id;
}

async function seedBranch(c: Ctx, branch: { id: string; timezone: TimeZone }): Promise<BranchResources> {
  const b = branch.id;
  // VR-комната: VR1, VR2 – места; PS4 – единица комнаты без своего ресурса; «вся комната» – из трёх единиц.
  const vrRoomId = await room(c, b, { slug: 'vr', name: 'VR-комната', capacity: 6, wholeRentAllowed: true });
  const vr1 = await resource(c, b, { roomId: vrRoomId, type: 'vr_seat', name: 'VR1', sortOrder: 10, unitCode: 'VR1' });
  const vr2 = await resource(c, b, { roomId: vrRoomId, type: 'vr_seat', name: 'VR2', sortOrder: 20, unitCode: 'VR2' });
  const ps4 = await c.tx.query<{ id: string }>('SELECT id FROM app.occupancy_units WHERE branch_id = $1 AND code = $2', [b, 'PS4']);
  let ps4UnitId = ps4.rows[0]?.id;
  if (!ps4UnitId) {
    ps4UnitId = (await createUnit(c.tx, c.ctx, b, { roomId: vrRoomId, code: 'PS4', name: 'PS4 в VR-комнате' }, c.meta, c.clock)).id;
    c.created.units++;
  }
  const units = [await unitOf(c, vr1), await unitOf(c, vr2), ps4UnitId];
  const vrWhole = await resource(c, b, { roomId: vrRoomId, type: 'room_whole', name: 'VR-комната целиком', sortOrder: 30, unitIds: units });

  const pcs: string[] = [];
  for (let k = 1; k <= 5; k++) pcs.push(await resource(c, b, { roomId: null, type: 'pc', name: `ПК-${k}`, sortOrder: 100 + k, unitCode: `PC${k}` }));

  const ps5: string[] = [];
  for (let k = 1; k <= 3; k++) {
    const roomId = await room(c, b, { slug: `ps5-${k}`, name: `PS5-комната ${k}`, capacity: 4, wholeRentAllowed: false });
    ps5.push(await resource(c, b, { roomId, type: 'ps_room', name: `PS5 · комната ${k}`, sortOrder: 200 + k, unitCode: `PS5-${k}` }));
  }

  for (const t of TARIFFS) {
    const has = await c.tx.query(`SELECT 1 FROM app.tariffs WHERE branch_id = $1 AND resource_type = $2 AND status = 'active' LIMIT 1`, [b, t.type]);
    if (has.rowCount) continue;
    const common = { branchId: b, resourceType: t.type, unitMinutes: t.unit, validFrom: TARIFF_FROM, status: 'active' };
    await createTariff(c.tx, c.ctx, { ...common, name: `${t.name} – базовый (демо)`, pricePerUnitKop: t.base, durationFromMin: 0, durationToMin: LONG_FROM_MIN }, c.meta, c.clock);
    await createTariff(c.tx, c.ctx, { ...common, name: `${t.name} – от 3 часов (демо)`, pricePerUnitKop: t.long, durationFromMin: LONG_FROM_MIN }, c.meta, c.clock);
    c.created.tariffs += 2;
  }

  const demoExc = await c.tx.query(`SELECT 1 FROM app.calendar_exceptions WHERE branch_id = $1 AND reason LIKE 'DEMO:%' LIMIT 1`, [b]);
  if (!demoExc.rowCount) {
    const today = todayIn(c.clock, branch.timezone);
    for (const e of EXCEPTIONS) {
      const times = 'open' in e ? { open: e.open as LocalTime, close: e.close as LocalTime } : {};
      const input = {
        kind: 'exception', branchId: b, scope: { type: 'branch' }, date: addDays(today, e.inDays), exceptionKind: e.kind, ...times,
        reason: `DEMO: ${e.reason} (засев S1-28)`,
      };
      // Брони на эту дату (стенд живой) не отменяются – только подтверждаются как затронутые (01 §4.1 п.5).
      const deps = { clock: c.clock, bookings: bookingsProvider };
      const { affectedBookingIds } = await previewHoursChange(c.tx, c.ctx, input, deps);
      await applyHoursChange(c.tx, c.ctx, { ...input, confirmedAffected: affectedBookingIds }, c.meta, deps);
      c.created.exceptions++;
    }
  }
  return { vrRoomId, vr1, vr2, vrWhole, ps4UnitId, pcs, ps5 };
}

export async function seedResources(pool: Pool, opts: { env: { APP_ENV?: string | undefined; NODE_ENV?: string | undefined } }, clock: Clock = systemClock): Promise<ResourcesSeedReport> {
  assertNotProduction(opts.env);
  return withTx(pool, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
    const owner = await tx.query<{ id: string }>(`SELECT id FROM app.staff WHERE role = 'owner' AND status = 'active'`);
    if (!owner.rows[0]) throw new Error('Нет активного Владельца – сначала засев Э0 (db/seed/dev.ts)');
    const ctx: AccessContext = {
      actor: { kind: 'staff', staffId: owner.rows[0].id, sessionId: randomUUID() },
      role: 'owner',
      network: true,
      cityIds: new Set(),
      branchIds: new Set(),
      at: clock.now(),
    };
    const meta: AuditRequestMeta = { actor: { kind: 'system', process: 'seed-resources' }, source: 'cli', requestId: `seed-resources:${clock.now().toISOString()}` };
    const report: ResourcesSeedReport = { created: { rooms: 0, resources: 0, units: 0, tariffs: 0, exceptions: 0, clients: 0 }, branches: {} };
    const c: Ctx = { tx, ctx, meta, clock, created: report.created };

    const branches = await tx.query<{ id: string; code: string; timezone: TimeZone }>(`SELECT id, code, timezone FROM app.branches WHERE code LIKE 'demo-%' ORDER BY code`);
    if (branches.rows.length === 0) throw new Error('Нет демо-филиалов – сначала засев Э0 (db/seed/dev.ts)');
    for (const b of branches.rows) report.branches[b.code] = await seedBranch(c, b);

    for (const cl of DEMO_CLIENTS) {
      const ins = await tx.query(
        `INSERT INTO app.clients (phone_e164, phone_verified_at, first_name, last_name, status, registration_source, registered_at, created_by_type)
         VALUES ($1, $3, $2, $4, 'active', 'crm', $3, 'system') ON CONFLICT (phone_e164) DO NOTHING`,
        [cl.phone, cl.firstName, clock.now(), cl.lastName],
      );
      report.created.clients += ins.rowCount ?? 0;
    }
    return report;
  });
}

async function cli(): Promise<void> {
  assertNotProduction(process.env);
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Нужен DATABASE_URL (рантайм-учётка yu_app)');
  const pool = new pg.Pool({ connectionString: url, options: '-c search_path=app,journal', max: 1 });
  try {
    const r = await seedResources(pool, { env: process.env });
    console.log(`Засев Э1: создано ${JSON.stringify(r.created)}`);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

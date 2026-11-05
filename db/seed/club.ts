// S3-96. Тестовые данные Э3 поверх засевов Э0 и Э1 (db/seed/dev.ts, db/seed/resources.ts): ставки и смены демо-сотрудников в двух филиалах
// (Директор на Красном, Администратор на Арбате; вчерашняя отработанная и будущая плановая), реестр оборудования с привязкой к VR1/VR2 и резерв,
// один открытый ремонт, подарочный ресурс и тариф 0 ₽ в каждом филиале с VR-комнатой (ensureAllGiftResources → ensureGiftResource, S3-62),
// праздники сети, платный праздник и подарок имениннику. Всё – командами модулей: с проверками, проводками K3 и аудитом.
// Начисление по отработанной смене проведёт worker (outbox shift.attendance_changed), как в бою.
// Повтор без дублей: поиск по демо-метке в комментарии, причине или описании; категория – по имени; праздник – setHoliday сам идемпотентен.
// Метка – DEMO_MARK (+ « #n»), «(демо)» в названиях. На прод не попадает: assertNotProduction до первого запроса к базе (19 §10.1).
//
// CLI – через db/seed/dev.ts; отдельно: APP_ENV=stage DATABASE_URL=... node db/seed/club.ts
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { addDays, localToInstant, systemClock, todayIn, type Clock, type LocalDate, type LocalTime, type TimeZone } from '../../apps/api/src/core/time.ts';
import { createCategory, createEquipment } from '../../apps/api/src/modules/equipment/items.ts';
import { registerRepair } from '../../apps/api/src/modules/equipment/repairs.ts';
import { createEvent } from '../../apps/api/src/modules/events/events.ts';
import { systemGiftContext } from '../../apps/api/src/modules/events/gift-resource.ts';
import { issueGift } from '../../apps/api/src/modules/events/gifts.ts';
import { setHoliday } from '../../apps/api/src/modules/network/holidays.ts';
import { setAttendance } from '../../apps/api/src/modules/shifts/attendance.ts';
import { createShift } from '../../apps/api/src/modules/shifts/plan.ts';
import { setRate } from '../../apps/api/src/modules/shifts/rates.ts';
import { withTx, type Pool } from '../../apps/api/src/modules/staff/auth.ts';
import { assertNotProduction, DEMO_EMAIL_DOMAIN, DEMO_MARK } from './dev.ts';
import { ensureAllGiftResources, type GiftEnsureSummary } from './gift-resources.ts';
import { DEMO_CLIENTS } from './resources.ts';

const LOCK_KEY = 7_204_513_058;
const mark = (n: string): string => `${DEMO_MARK} #${n}`;

const WORKERS = [
  { staff: 'director', branch: 'demo-nsk-krasny', hourlyKop: 70_000, attendanceFeeKop: 0 },
  { staff: 'admin', branch: 'demo-msk-arbat', hourlyKop: 40_000, attendanceFeeKop: 15_000 },
] as const;
const BRANCHES = ['demo-nsk-krasny', 'demo-msk-arbat'] as const;
const HOLIDAYS = [
  { monthDay: '01-01', name: 'Новый год (демо)' },
  { monthDay: '03-08', name: 'Международный женский день (демо)' },
] as const;

export interface ClubSeedReport {
  created: { rates: number; shifts: number; categories: number; equipment: number; repairs: number; holidays: number; events: number; gifts: number };
  gifts: GiftEnsureSummary;
  equipmentIds: Record<string, string>;
}

type BranchRow = { id: string; code: string; timezone: TimeZone };

export async function seedClub(pool: pg.Pool, opts: { env: { APP_ENV?: string | undefined; NODE_ENV?: string | undefined } }, clock: Clock = systemClock): Promise<ClubSeedReport> {
  assertNotProduction(opts.env);
  const lockConn = await pool.connect();
  try {
    await lockConn.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]); // два параллельных засева не создадут дублей
    return await run(pool, clock);
  } finally {
    await lockConn.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    lockConn.release();
  }
}

async function run(pool: pg.Pool, clock: Clock): Promise<ClubSeedReport> {
  const db: Pool = pool;
  const branches = new Map(
    (await pool.query<BranchRow>(`SELECT id, code, timezone FROM app.branches WHERE code = ANY($1::text[]) AND status = 'active'`, [[...BRANCHES]])).rows.map((b) => [b.code, b]),
  );
  const owner = (await pool.query<{ id: string }>(`SELECT id FROM app.staff WHERE role = 'owner' AND status = 'active'`)).rows[0];
  const staffRows = await pool.query<{ id: string; email: string }>(`SELECT id, email FROM app.staff WHERE email LIKE $1`, [`%@${DEMO_EMAIL_DOMAIN}`]);
  const staffId = (key: string): string | undefined => staffRows.rows.find((s) => s.email === `${key}@${DEMO_EMAIL_DOMAIN}`)?.id;
  const clients = new Map(
    (await pool.query<{ id: string; phone_e164: string }>(`SELECT id, phone_e164 FROM app.clients WHERE phone_e164 = ANY($1::text[])`, [DEMO_CLIENTS.map((c) => c.phone)])).rows.map((r) => [r.phone_e164, r.id]),
  );
  if (branches.size !== BRANCHES.length || !owner || !staffId('director') || !staffId('admin') || clients.size !== DEMO_CLIENTS.length) {
    throw new Error('Нет демо-филиалов, сотрудников или клиентов: сначала засев Э0 и Э1 (db/seed/dev.ts)');
  }
  const { ctx, meta } = systemGiftContext(owner.id, clock.now());
  const created: ClubSeedReport['created'] = { rates: 0, shifts: 0, categories: 0, equipment: 0, repairs: 0, holidays: 0, events: 0, gifts: 0 };
  const equipmentIds: Record<string, string> = {};

  // ставки и смены
  for (const w of WORKERS) {
    const id = staffId(w.staff)!;
    const branch = branches.get(w.branch)!;
    const rateMark = mark(`rate-${w.staff}`);
    if ((await pool.query(`SELECT 1 FROM journal.staff_rates WHERE staff_id = $1 AND reason = $2`, [id, rateMark])).rowCount === 0) {
      await withTx(db, (tx) => setRate(tx, ctx, { staffId: id, validFrom: '2026-01-01', hourlyKop: w.hourlyKop, attendanceFeeKop: w.attendanceFeeKop, reason: rateMark }, meta, clock));
      created.rates++;
    }
    const today = todayIn(clock, branch.timezone);
    const at = (date: LocalDate, time: string): string => localToInstant(date, time as LocalTime, branch.timezone).toISOString();
    const shift = async (n: string, date: LocalDate, worked: boolean): Promise<void> => {
      const comment = mark(`shift-${n}-${w.staff}`);
      if ((await pool.query(`SELECT 1 FROM app.staff_shifts WHERE staff_id = $1 AND comment = $2`, [id, comment])).rowCount) return;
      await withTx(db, async (tx) => {
        const s = await createShift(tx, ctx, { staffId: id, branchId: branch.id, start: at(date, '11:00'), end: at(date, '17:00'), comment }, meta, clock);
        if (worked) await setAttendance(tx, ctx, s.id, { rowVersion: s.rowVersion, status: 'worked', paidMinutes: 360, reason: comment }, meta, clock);
      });
      created.shifts++;
    };
    await shift('past', addDays(today, -1), true);
    await shift('future', addDays(today, 3), false);
  }

  // оборудование: шлемы на VR1 и VR2 каждого филиала, контроллер в резерве
  const categoryName = 'VR-шлемы (демо)';
  let categoryId = (await pool.query<{ id: string }>(`SELECT id FROM app.equipment_categories WHERE name = $1`, [categoryName])).rows[0]?.id;
  if (!categoryId) {
    categoryId = (await withTx(db, (tx) => createCategory(tx, ctx, { name: categoryName }, meta, clock))).id;
    created.categories++;
  }
  for (const code of BRANCHES) {
    const branch = branches.get(code)!;
    const units = await pool.query<{ id: string; code: string; room_id: string }>(`SELECT id, code, room_id FROM app.occupancy_units WHERE branch_id = $1 AND code IN ('VR1','VR2') ORDER BY code`, [branch.id]);
    if (units.rows.length !== 2) throw new Error(`В филиале ${code} нет VR1/VR2: сначала засев Э1 (db/seed/resources.ts)`);
    const item = async (key: string, body: Record<string, unknown>): Promise<void> => {
      const comment = mark(`equipment-${code}-${key}`);
      const found = await pool.query<{ id: string }>(`SELECT id FROM app.equipment_items WHERE comment = $1`, [comment]);
      if (found.rows[0]) {
        equipmentIds[`${code}/${key}`] = found.rows[0].id;
        return;
      }
      const dto = await withTx(db, (tx) => createEquipment(tx, ctx, { categoryId, branchId: branch.id, comment, ...body }, meta, clock));
      equipmentIds[`${code}/${key}`] = dto.id;
      created.equipment++;
    };
    for (const u of units.rows) {
      await item(u.code, { name: `Meta Quest 3S ${u.code} (демо)`, manufacturer: 'Meta', model: 'Quest 3S', serialNumber: `DEMO-${code}-${u.code}`, roomId: u.room_id, unitId: u.id });
    }
    await item('reserve', { name: 'Контроллер в резерве (демо)', status: 'reserve', serialNumber: `DEMO-${code}-RESERVE` });
  }

  // один открытый ремонт: VR2 на Красном
  const repairMark = mark('repair');
  if ((await pool.query(`SELECT 1 FROM app.repairs WHERE symptoms = $1`, [repairMark])).rowCount === 0) {
    const detectedAt = new Date(clock.now().getTime() - 2 * 3_600_000).toISOString();
    await withTx(db, (tx) => registerRepair(tx, ctx, { equipmentId: equipmentIds['demo-nsk-krasny/VR2'], detectedAt, brokenAtUnknown: true, symptoms: repairMark, priority: 'high', impact: 'partial' }, meta, clock));
    created.repairs++;
  }

  // подарочный ресурс и тариф 0 ₽ – боевой процедурой S3-62, а не своей копией
  const gifts = await ensureAllGiftResources(pool, clock);

  // праздники сети на ближайшие даты
  const krasny = branches.get('demo-nsk-krasny')!;
  const today = todayIn(clock, krasny.timezone);
  const year = Number(today.slice(0, 4));
  for (const h of HOLIDAYS) {
    const first = `${year}-${h.monthDay}`;
    const date = first >= today ? first : `${year + 1}-${h.monthDay}`;
    const has = await pool.query(`SELECT 1 FROM app.holiday_dates WHERE scope = 'network' AND local_date = $1 AND status = 'active'`, [date]);
    await withTx(db, (tx) => setHoliday(tx, ctx, { scope: 'network', date, name: h.name }, meta, clock));
    if (!has.rowCount) created.holidays++;
  }

  // платный праздник через 10 дней и подарок имениннику
  const birthday = DEMO_CLIENTS[1];
  const birthdayClientId = clients.get(birthday.phone)!;
  const eventMark = mark('event');
  if ((await pool.query(`SELECT 1 FROM app.events WHERE wishes = $1`, [eventMark])).rowCount === 0) {
    const type = await pool.query<{ id: string }>(`SELECT id FROM app.event_types WHERE code = 'birthday_party'`);
    const on = addDays(today, 10);
    const at = (time: string): string => localToInstant(on, time as LocalTime, krasny.timezone).toISOString();
    await withTx(db, (tx) =>
      createEvent(
        tx,
        ctx,
        {
          typeId: type.rows[0]!.id,
          branchId: krasny.id,
          title: 'День рождения (демо)',
          plannedStart: at('12:00'),
          plannedEnd: at('14:00'),
          customer: { clientId: birthdayClientId, name: `${birthday.firstName} ${birthday.lastName}`, phone: birthday.phone },
          birthdayPerson: { clientId: birthdayClientId },
          participantsCount: 6,
          wishes: eventMark,
          party: { format: 'h2', guests: 6, catering: false },
        },
        meta,
        clock,
      ),
    );
    created.events++;
  }
  const giftMark = mark('gift');
  if ((await pool.query(`SELECT 1 FROM app.birthday_gifts WHERE manual_reason = $1`, [giftMark])).rowCount === 0) {
    await withTx(db, (tx) => issueGift(tx, ctx, { clientId: birthdayClientId, branchId: krasny.id, reason: giftMark }, meta, clock));
    created.gifts++;
  }
  return { created, gifts, equipmentIds };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assertNotProduction(process.env);
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Нужен DATABASE_URL (рантайм-учётка yu_app)');
  const pool = new pg.Pool({ connectionString: url, options: '-c search_path=app,journal', max: 3 });
  seedClub(pool, { env: process.env }).then(
    async (r) => {
      console.log(`Засев Э3: создано ${JSON.stringify(r.created)}`);
      await pool.end();
    },
    async (err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      await pool.end();
      process.exit(1);
    },
  );
}

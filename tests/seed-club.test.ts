// S3-96: засев Э3 поверх Э0 и Э1 – смены и ставки в двух филиалах, оборудование на VR1/VR2, открытый ремонт, подарочный ресурс с тарифом 0 ₽
// боевой процедурой, праздники, мероприятие и подарок. Повтор без дублей; демо помечено; на проде – отказ; ночная сверка на засеянных данных – ноль.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearSubscriptions, processEvent } from '../apps/api/src/core/outbox.ts';
import { fixedClock } from '../apps/api/src/core/time.ts';
import { runReconcile } from '../apps/api/src/modules/reports/reconcile.ts';
import { HANDLER_ATTENDANCE, HANDLER_RATE, registerPayrollHandlers } from '../apps/api/src/modules/shifts/accrual.ts';
import { seedClub, type ClubSeedReport } from '../db/seed/club.ts';
import { DEMO_MARK, seedDev } from '../db/seed/dev.ts';
import { seedResources } from '../db/seed/resources.ts';
import { createTestDatabase, type TestDatabase } from './helpers/pg.ts';

const early = fixedClock('2026-11-12T05:00:00Z'); // Э0 и Э1 – за два дня: вчерашняя смена попадает в график
const clock = fixedClock('2026-11-14T05:00:00Z');
let db: TestDatabase;
let pool: pg.Pool;
let first: ClubSeedReport;

async function counts(): Promise<Record<string, number>> {
  const r = await db.client.query(`SELECT
    (SELECT count(*)::int FROM journal.staff_rates) rates, (SELECT count(*)::int FROM app.staff_shifts) shifts,
    (SELECT count(*)::int FROM app.equipment_items) equipment, (SELECT count(*)::int FROM app.equipment_categories) categories,
    (SELECT count(*)::int FROM app.repairs) repairs, (SELECT count(*)::int FROM app.holiday_dates) holidays,
    (SELECT count(*)::int FROM app.events) events, (SELECT count(*)::int FROM app.birthday_gifts) gifts,
    (SELECT count(*)::int FROM app.resources WHERE resource_type = 'gift_vr') gift_resources, (SELECT count(*)::int FROM app.tariffs) tariffs,
    (SELECT count(*)::int FROM journal.audit_events) audit`);
  return r.rows[0];
}
async function settle(): Promise<void> {
  const r = await db.client.query<{ id: string; event_type: string }>(
    `SELECT e.id, e.event_type FROM app.outbox_events e WHERE e.event_type IN ('shift.attendance_changed','staff.rate_set') AND NOT EXISTS (SELECT 1 FROM app.processed_events p WHERE p.event_id = e.id) ORDER BY e.occurred_at, e.id`,
  );
  for (const e of r.rows) await processEvent(pool, e.event_type === 'staff.rate_set' ? HANDLER_RATE : HANDLER_ATTENDANCE, e.id, clock.now());
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
  clearSubscriptions();
  registerPayrollHandlers({ clock });
});
afterAll(async () => {
  clearSubscriptions();
  await pool.end();
  await db.drop();
});

describe('S3-96: засев Э3', () => {
  it('на проде – отказ до записи; без Э0/Э1 – понятная ошибка', async () => {
    const before = await counts();
    await expect(seedClub(pool, { env: { APP_ENV: 'prod' } }, clock)).rejects.toThrow(/только для dev\/stage\/test/);
    await expect(seedClub(pool, { env: { NODE_ENV: 'production' } }, clock)).rejects.toThrow(/только для dev\/stage\/test/);
    await expect(seedClub(pool, { env: { APP_ENV: 'test' } }, clock)).rejects.toThrow(/засев Э0 и Э1/);
    expect(await counts()).toEqual(before);
  });

  it('создаёт смены и ставки в двух филиалах, отработанная начислена', async () => {
    await seedDev(pool, { env: { APP_ENV: 'test' }, password: 'Демо-пароль-засева-3' }, early);
    await seedResources(pool, { env: { APP_ENV: 'test' } }, early);
    first = await seedClub(pool, { env: { APP_ENV: 'test' } }, clock);
    await settle();
    expect(first.created).toEqual({ rates: 2, shifts: 4, categories: 1, equipment: 6, repairs: 1, holidays: 2, events: 1, gifts: 1 });

    const shifts = await db.client.query<{ code: string; role: string; status: string; n: number }>(
      `SELECT b.code, st.role, s.status, count(*)::int AS n FROM app.staff_shifts s JOIN app.branches b ON b.id = s.branch_id JOIN app.staff st ON st.id = s.staff_id GROUP BY 1, 2, 3 ORDER BY 1, 3`,
    );
    expect(shifts.rows).toEqual([
      { code: 'demo-msk-arbat', role: 'admin', status: 'planned', n: 1 },
      { code: 'demo-msk-arbat', role: 'admin', status: 'worked', n: 1 },
      { code: 'demo-nsk-krasny', role: 'director', status: 'planned', n: 1 },
      { code: 'demo-nsk-krasny', role: 'director', status: 'worked', n: 1 },
    ]);
    const accrued = await db.client.query<{ owner: string; balance: string }>(
      `SELECT s.role AS owner, a.balance FROM app.ledger_accounts a JOIN app.staff s ON s.id = a.owner_id WHERE a.kind = 'staff_payroll' ORDER BY 1`,
    );
    expect(accrued.rows).toEqual([{ owner: 'admin', balance: String(6 * 40_000 + 15_000) }, { owner: 'director', balance: String(6 * 70_000) }]);
  });

  it('оборудование привязано к VR1 и VR2, ремонт открыт', async () => {
    const placed = await db.client.query<{ code: string; unit: string | null; status: string }>(
      `SELECT b.code, u.code AS unit, i.status FROM app.equipment_items i JOIN app.equipment_placements p ON p.item_id = i.id AND p.removed_at IS NULL
       JOIN app.branches b ON b.id = i.branch_id LEFT JOIN app.occupancy_units u ON u.id = p.unit_id ORDER BY 1, 2`,
    );
    expect(placed.rows.map((r) => [r.code, r.unit])).toEqual([
      ['demo-msk-arbat', 'VR1'], ['demo-msk-arbat', 'VR2'], ['demo-msk-arbat', null],
      ['demo-nsk-krasny', 'VR1'], ['demo-nsk-krasny', 'VR2'], ['demo-nsk-krasny', null],
    ]);
    const repair = await db.client.query<{ status: string; unit: string; code: string }>(
      `SELECT r.status, u.code AS unit, b.code FROM app.repairs r JOIN app.branches b ON b.id = r.branch_id LEFT JOIN app.occupancy_units u ON u.id = r.unit_id`,
    );
    expect(repair.rows).toEqual([{ status: 'new', unit: 'VR2', code: 'demo-nsk-krasny' }]);
    // Часы засева – в будущем относительно now() базы: состав ресурсов для представления сдвигаем в прошлое.
    await db.client.query(`UPDATE app.resource_units SET valid_from = '2026-01-01' WHERE valid_from > now()`);
    const rpt = await db.client.query(`SELECT cardinality(resource_ids) AS n FROM app.rpt_equipment WHERE equipment_id = $1`, [first.equipmentIds['demo-nsk-krasny/VR1']]);
    expect(rpt.rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it('подарочный ресурс и тариф 0 ₽ – в каждом филиале с VR-комнатой, без лишних', async () => {
    const r = await db.client.query<{ code: string; self_bookable: boolean; zero: boolean }>(
      `SELECT b.code, x.self_bookable,
              EXISTS (SELECT 1 FROM app.tariffs t WHERE t.branch_id = b.id AND t.resource_type = x.resource_type AND t.price_per_unit_kop = 0) AS zero
       FROM app.resources x JOIN app.branches b ON b.id = x.branch_id WHERE x.resource_type = 'gift_vr' ORDER BY b.code`,
    );
    const vrRooms = await db.client.query<{ code: string }>(`SELECT DISTINCT b.code FROM app.occupancy_units u JOIN app.branches b ON b.id = u.branch_id WHERE u.code = 'VR1' ORDER BY b.code`);
    expect(r.rows.map((x) => x.code)).toEqual(vrRooms.rows.map((x) => x.code));
    for (const x of r.rows) expect(x).toMatchObject({ self_bookable: false, zero: true });
    expect(first.gifts.branches).toBeGreaterThanOrEqual(2);
  });

  it('праздники сети, платный праздник и подарок имениннику – с демо-меткой', async () => {
    const hol = await db.client.query<{ scope: string; d: string; name: string }>(`SELECT scope, local_date::text AS d, name FROM app.holiday_dates ORDER BY local_date`);
    expect(hol.rows).toEqual([
      { scope: 'network', d: '2027-01-01', name: 'Новый год (демо)' },
      { scope: 'network', d: '2027-03-08', name: 'Международный женский день (демо)' },
    ]);
    const ev = await db.client.query(`SELECT status, title, wishes, party_format, source FROM app.events`);
    expect(ev.rows).toEqual([{ status: 'new_request', title: 'День рождения (демо)', wishes: `${DEMO_MARK} #event`, party_format: 'h2', source: 'crm' }]);
    const gift = await db.client.query(`SELECT status, manual_reason FROM app.birthday_gifts`);
    expect(gift.rows).toEqual([{ status: 'issued', manual_reason: `${DEMO_MARK} #gift` }]);
    const marked = await db.client.query<{ n: number }>(`SELECT count(*)::int AS n FROM app.staff_shifts WHERE comment NOT LIKE $1 OR comment IS NULL`, [`${DEMO_MARK}%`]);
    expect(marked.rows[0]!.n).toBe(0);
    const items = await db.client.query<{ n: number }>(`SELECT count(*)::int AS n FROM app.equipment_items WHERE comment NOT LIKE $1 OR comment IS NULL`, [`${DEMO_MARK}%`]);
    expect(items.rows[0]!.n).toBe(0);
  });

  it('повтор не плодит дубли ни строк, ни аудита – и в другой день тоже', async () => {
    const before = await counts();
    const again = await seedClub(pool, { env: { APP_ENV: 'stage' } }, clock);
    expect(again.created).toEqual({ rates: 0, shifts: 0, categories: 0, equipment: 0, repairs: 0, holidays: 0, events: 0, gifts: 0 });
    expect(await counts()).toEqual(before);
    const later = await seedClub(pool, { env: { APP_ENV: 'dev' } }, fixedClock('2026-11-20T05:00:00Z'));
    expect(later.created.shifts).toBe(0);
    expect(await counts()).toEqual(before);
  });

  it('ночная сверка на засеянных данных – ноль расхождений', async () => {
    await settle();
    const r = (await runReconcile(pool, { trigger: 'manual', clock, logger: { info: () => undefined, error: () => undefined } }))!;
    expect(r.discrepancies).toEqual([]);
    expect(r.checked.payroll_accrual).toBeGreaterThanOrEqual(4);
    expect(r.checked.payroll_balance).toBe(2);
  });
});

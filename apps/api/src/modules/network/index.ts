// K13. Публичный вход модуля network: города, филиалы, график. Другие модули читают сеть только отсюда
// (ADR 0002 п.1–2). Таблицы – 0008_network.sql. Время – только через core/time.ts (K8).
// Исключения графика (calendar_exceptions, 0103) появятся в S1-03: пока openIntervals = недельный график;
// roomId/resourceId принимаются по контракту и учитываются, когда будут исключения комнат и ресурсов.
import type { Db, Tx } from '../../core/audit.ts';
import { hoursToInterval, isValidTimeZone, type Interval, type LocalDate, type LocalTime, type TimeZone } from '../../core/time.ts';

export type BranchStatus = 'preparing' | 'active' | 'temporarily_closed' | 'archived';

export interface BranchInfo {
  id: string;
  cityId: string;
  citySlug: string;
  cityName: string;
  slug: string;
  name: string;
  address: string;
  timezone: TimeZone;
  status: BranchStatus;
  tempClosed: { from: Date; to: Date | null; reason: string } | null;
}

interface BranchRow {
  id: string;
  city_id: string;
  city_slug: string;
  city_name: string;
  slug: string;
  name: string;
  address: string;
  timezone: string;
  status: BranchStatus;
  temp_closed_from: Date | null;
  temp_closed_to: Date | null;
  temp_close_reason: string | null;
}

export const BRANCH_COLUMNS = `b.id, b.city_id, c.slug AS city_slug, c.name AS city_name, b.slug, b.name, b.address,
  b.timezone, b.status, b.temp_closed_from, b.temp_closed_to, b.temp_close_reason`;
export const BRANCH_FROM = 'app.branches b JOIN app.cities c ON c.id = b.city_id';
const BRANCH_SELECT = `${BRANCH_COLUMNS} FROM ${BRANCH_FROM}`;

function zone(tz: string): TimeZone {
  // Зону проверяет команда при сохранении; неверная в базе – ошибка данных, не пользователя.
  if (!isValidTimeZone(tz)) throw new Error(`network: неверная зона в базе: ${tz}`);
  return tz;
}

export type { BranchRow };

export function toBranchInfo(r: BranchRow): BranchInfo {
  return {
    id: r.id,
    cityId: r.city_id,
    citySlug: r.city_slug,
    cityName: r.city_name,
    slug: r.slug,
    name: r.name,
    address: r.address,
    timezone: zone(r.timezone),
    status: r.status,
    tempClosed:
      r.temp_closed_from && r.temp_close_reason !== null
        ? { from: r.temp_closed_from, to: r.temp_closed_to, reason: r.temp_close_reason }
        : null,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string): boolean => UUID_RE.test(s);

/** Один филиал. Нет (или id не uuid) → null. */
export async function getBranch(db: Db | Tx, branchId: string): Promise<BranchInfo | null> {
  if (!isUuid(branchId)) return null;
  const r = await db.query<BranchRow>(`SELECT ${BRANCH_SELECT} WHERE b.id = $1`, [branchId]);
  return r.rows[0] ? toBranchInfo(r.rows[0]) : null;
}

export async function getBranches(db: Db | Tx, branchIds: string[]): Promise<Map<string, BranchInfo>> {
  const ids = branchIds.filter(isUuid);
  const out = new Map<string, BranchInfo>();
  if (ids.length === 0) return out;
  const r = await db.query<BranchRow>(`SELECT ${BRANCH_SELECT} WHERE b.id = ANY($1::uuid[])`, [ids]);
  for (const row of r.rows) out.set(row.id, toBranchInfo(row));
  return out;
}

/** Принимает ли филиал НОВЫЕ записи на момент `at`: status='active' и не во временном закрытии. */
export function isAcceptingBookings(b: BranchInfo, at: Date): boolean {
  if (b.status !== 'active') return false;
  if (!b.tempClosed) return true;
  const t = at.getTime();
  const inClosure = b.tempClosed.from.getTime() <= t && (b.tempClosed.to === null || t < b.tempClosed.to.getTime());
  return !inClosure;
}

/** Филиалы городов (включая архивные – история видна в зоне) – для K1 loadAccess (city → branches). */
export async function branchIdsOfCities(db: Db | Tx, cityIds: string[]): Promise<string[]> {
  const ids = cityIds.filter(isUuid);
  if (ids.length === 0) return [];
  const r = await db.query<{ id: string }>('SELECT id FROM app.branches WHERE city_id = ANY($1::uuid[]) ORDER BY id', [ids]);
  return r.rows.map((x) => x.id);
}

/** Зоны городов и филиалов по id – для даты назначения сотрудника (K1: «по зоне филиала/города»). */
export async function timezonesOf(db: Db | Tx, input: { cityIds: string[]; branchIds: string[] }): Promise<Map<string, TimeZone>> {
  const out = new Map<string, TimeZone>();
  const cities = input.cityIds.filter(isUuid);
  const branches = input.branchIds.filter(isUuid);
  if (cities.length === 0 && branches.length === 0) return out;
  const r = await db.query<{ id: string; timezone: string }>(
    `SELECT id, timezone FROM app.cities WHERE id = ANY($1::uuid[])
     UNION ALL SELECT id, timezone FROM app.branches WHERE id = ANY($2::uuid[])`,
    [cities, branches],
  );
  for (const row of r.rows) out.set(row.id, zone(row.timezone));
  return out;
}

// ---- график

interface HoursRow {
  open_time: string | null;
  close_time: string | null;
  is_closed: boolean;
}

/** Строка недельного графика, действующая на локальную дату филиала (valid_to включительно). */
async function weeklyFor(db: Db | Tx, branchId: string, date: LocalDate): Promise<{ tz: TimeZone; row: HoursRow | null } | null> {
  if (!isUuid(branchId)) return null;
  const r = await db.query<HoursRow & { timezone: string; has_row: boolean }>(
    `SELECT b.timezone, h.id IS NOT NULL AS has_row,
            to_char(h.open_time, 'HH24:MI') AS open_time, to_char(h.close_time, 'HH24:MI') AS close_time, h.is_closed
     FROM app.branches b
     LEFT JOIN app.branch_weekly_hours h ON h.branch_id = b.id
       AND h.weekday = extract(isodow FROM $2::date)
       AND h.valid_from <= $2::date AND (h.valid_to IS NULL OR h.valid_to >= $2::date)
     WHERE b.id = $1`,
    [branchId, date],
  );
  const row = r.rows[0];
  if (!row) return null;
  return { tz: zone(row.timezone), row: row.has_row ? row : null };
}

function toIntervals(date: LocalDate, tz: TimeZone, row: HoursRow | null): Interval[] {
  if (!row || row.is_closed || row.open_time === null || row.close_time === null) return [];
  return [hoursToInterval(date, row.open_time as LocalTime, row.close_time as LocalTime, tz)];
}

/** Открытые интервалы дня (UTC) по зоне филиала. Нет филиала или строки графика → []. */
export async function openIntervals(
  db: Db | Tx,
  input: { branchId: string; date: LocalDate; roomId?: string | null; resourceId?: string },
): Promise<Interval[]> {
  const w = await weeklyFor(db, input.branchId, input.date);
  return w ? toIntervals(input.date, w.tz, w.row) : [];
}

/** Для сетки сразу по многим ресурсам одного дня – один запрос. */
export async function openIntervalsBulk(
  db: Db | Tx,
  input: { branchId: string; date: LocalDate; resources: Array<{ resourceId: string; roomId: string | null }> },
): Promise<Map<string, Interval[]>> {
  const w = await weeklyFor(db, input.branchId, input.date);
  const base = w ? toIntervals(input.date, w.tz, w.row) : [];
  return new Map(input.resources.map((r) => [r.resourceId, base.map((i) => ({ ...i }))]));
}

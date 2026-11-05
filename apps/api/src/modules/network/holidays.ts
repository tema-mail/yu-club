// S3-56. Праздничный календарь (K20 §9, 15 §6.4; R-10, Q-73): один календарь сети плюс праздники отдельных городов, ведёт
// Владелец вручную, внешнего источника нет. Влияет только на подарок имениннику: график филиала не меняется. Дата сверяется
// в зоне филиала (K8). Коды аудита holiday.* – в реестре events (решение D3-05): календарь описан в K20.
import { z } from 'zod';
import { writeAudit, type AuditRequestMeta, type Db, type Tx } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { assertCan, type AccessContext } from '../../core/permissions.ts';
import { instantToLocal, parseLocalDate, systemClock, type Clock, type LocalDate } from '../../core/time.ts';
import { getBranch } from './index.ts';

export interface HolidayDto {
  id: string;
  scope: 'network' | 'city';
  cityId: string | null;
  date: string;
  name: string;
  status: 'active' | 'cancelled';
}

interface HolidayRow {
  id: string;
  scope: 'network' | 'city';
  city_id: string | null;
  local_date: string;
  name: string;
  status: 'active' | 'cancelled';
}

const COLS = `id, scope, city_id, local_date::text AS local_date, name, status`;
const RET = `RETURNING id, scope, city_id, local_date::text AS local_date, name, status`;
const toDto = (r: HolidayRow): HolidayDto => ({ id: r.id, scope: r.scope, cityId: r.city_id, date: r.local_date, name: r.name, status: r.status });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const Uuid = z.string().regex(UUID_RE);

function parseInput<T>(schema: z.ZodType<T>, raw: unknown): T {
  const r = schema.safeParse(raw ?? {});
  if (!r.success) throw new AppError('VALIDATION_FAILED', 400, 'Неверные данные запроса', { issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  return r.data;
}

const setSchema = z.object({ scope: z.enum(['network', 'city']), cityId: Uuid.nullish(), date: z.string(), name: z.string().trim().min(1).max(200) });
const cancelSchema = z.object({ reason: z.string().max(2000).optional() });
const listSchema = z.object({ from: z.string().optional(), to: z.string().optional(), cityId: Uuid.optional(), includeCancelled: z.enum(['true', 'false']).optional() });

/** Праздник ли дата филиала: сеть ∪ город филиала; филиала нет – false (проверку существования делает вызывающий). */
export async function isHoliday(db: Db, input: { branchId: string; date: LocalDate }): Promise<boolean> {
  const r = await db.query(
    `SELECT 1 FROM app.holiday_dates h WHERE h.status = 'active' AND h.local_date = $2
       AND (h.scope = 'network' OR h.city_id = (SELECT city_id FROM app.branches WHERE id = $1)) LIMIT 1`,
    [input.branchId, input.date],
  );
  return r.rowCount === 1;
}

/** То же по моменту: дата – по зоне филиала (K8). */
export async function isHolidayAt(db: Db, input: { branchId: string; at: Date }): Promise<boolean> {
  const b = await getBranch(db, input.branchId);
  if (!b) return false;
  return isHoliday(db, { branchId: b.id, date: instantToLocal(input.at, b.timezone).date });
}

/** Праздники за период в области: сеть ∪ город филиала; для слотов подарка (K20 №377). */
export async function holidaysOfBranch(db: Db, input: { branchId: string; from: LocalDate; to: LocalDate }): Promise<Set<string>> {
  const r = await db.query<{ d: string }>(
    `SELECT h.local_date::text AS d FROM app.holiday_dates h WHERE h.status = 'active' AND h.local_date BETWEEN $2 AND $3
       AND (h.scope = 'network' OR h.city_id = (SELECT city_id FROM app.branches WHERE id = $1))`,
    [input.branchId, input.from, input.to],
  );
  return new Set(r.rows.map((x) => x.d));
}

/** Повтор той же даты в той же области – та же активная строка (название не перезаписывается: сначала отмена). */
export async function setHoliday(tx: Tx, ctx: AccessContext, raw: unknown, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<HolidayDto> {
  assertCan(ctx, 'holiday.manage', { network: true });
  const input = parseInput(setSchema, raw);
  const date = parseLocalDate(input.date);
  const cityId = input.scope === 'city' ? (input.cityId ?? null) : null;
  if (input.scope === 'city') {
    if (!cityId) throw new AppError('VALIDATION_FAILED', 400, 'Укажите город', { field: 'cityId' });
    const c = await tx.query('SELECT 1 FROM app.cities WHERE id = $1', [cityId]);
    if (c.rowCount !== 1) throw new AppError('VALIDATION_FAILED', 400, 'Город не найден', { field: 'cityId' });
  } else if (input.cityId) {
    throw new AppError('VALIDATION_FAILED', 400, 'Праздник сети – без города', { field: 'cityId' });
  }
  const r = await tx.query<HolidayRow>(
    `INSERT INTO app.holiday_dates (scope, city_id, local_date, name, created_by, created_at) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (scope, coalesce(city_id, '00000000-0000-0000-0000-000000000000'), local_date) WHERE status = 'active' DO NOTHING ${RET}`,
    [input.scope, cityId, date, input.name, ctx.actor.staffId, clock.now()],
  );
  if (!r.rows[0]) {
    const same = await tx.query<HolidayRow>(
      `SELECT ${COLS} FROM app.holiday_dates WHERE status = 'active' AND scope = $1 AND city_id IS NOT DISTINCT FROM $2 AND local_date = $3`,
      [input.scope, cityId, date],
    );
    return toDto(same.rows[0]!);
  }
  const dto = toDto(r.rows[0]);
  await writeAudit(tx, meta, { action: 'holiday.set', object: { type: 'holiday', id: dto.id }, cityId, after: { scope: dto.scope, date: dto.date, name: dto.name } }, clock);
  return dto;
}

export async function cancelHoliday(tx: Tx, ctx: AccessContext, id: string, raw: unknown, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<HolidayDto> {
  assertCan(ctx, 'holiday.manage', { network: true });
  const input = parseInput(cancelSchema, raw);
  const reason = (input.reason ?? '').trim();
  if (reason === '') throw new AppError('COMMENT_REQUIRED', 422, 'Укажите причину', { field: 'reason' });
  if (!UUID_RE.test(id)) throw new AppError('NOT_FOUND', 404, 'Не найдено');
  const r = await tx.query<HolidayRow>(`UPDATE app.holiday_dates SET status = 'cancelled', cancel_reason = $2 WHERE id = $1 AND status = 'active' ${RET}`, [id, reason]);
  if (!r.rows[0]) {
    const cur = await tx.query<HolidayRow>(`SELECT ${COLS} FROM app.holiday_dates WHERE id = $1`, [id]);
    if (!cur.rows[0]) throw new AppError('NOT_FOUND', 404, 'Не найдено');
    return toDto(cur.rows[0]); // уже отменён
  }
  const dto = toDto(r.rows[0]);
  await writeAudit(tx, meta, { action: 'holiday.cancelled', object: { type: 'holiday', id: dto.id }, cityId: dto.cityId, before: { status: 'active' }, after: { status: 'cancelled', date: dto.date }, reason }, clock);
  return dto;
}

/** Список по датам; права проверяет маршрут (event.view). */
export async function listHolidays(db: Db, raw: unknown): Promise<HolidayDto[]> {
  const q = parseInput(listSchema, raw);
  const r = await db.query<HolidayRow>(
    `SELECT ${COLS} FROM app.holiday_dates
      WHERE ($1::date IS NULL OR local_date >= $1) AND ($2::date IS NULL OR local_date <= $2) AND ($3::uuid IS NULL OR scope = 'network' OR city_id = $3) AND ($4 OR status = 'active')
      ORDER BY local_date, scope, id LIMIT 500`,
    [q.from ? parseLocalDate(q.from) : null, q.to ? parseLocalDate(q.to) : null, q.cityId ?? null, q.includeCancelled === 'true'],
  );
  return r.rows.map(toDto);
}

// K5 №1–4: публичная сеть для сайта – города, филиалы, филиал, ресурсы филиала. Без входа.
// Наружу – только 'active' и 'temporarily_closed' (K5, 15 §5.3; карта сайта: «готовится» не показываем);
// 'preparing'/'archived' и несуществующий id – одинаковый 404. Внутренние поля (код, комментарии, версии,
// статусы комнат, признаки ресурса) не отдаются: DTO собираются явным списком полей, не из строки базы.
// Ответы общие для всех посетителей – короткий публичный кэш (данные сети меняются редко, но не «навсегда»).
// GET /branches/{id} дополнительно отдаёт hoursToday – часы сегодняшнего дня по местному времени филиала
// (openIntervals с исключениями календаря; пусто – сегодня закрыт). Слоты и кука yu_visitor – K5 №5, booking.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Db } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { resolveSettings } from '../../core/settings.ts';
import { instantToLocal, systemClock, todayIn, type Clock } from '../../core/time.ts';
import { listBookableResources } from '../resources/index.ts';
import { BRANCH_COLUMNS, BRANCH_FROM, isUuid, openIntervals, toBranchInfo, type BranchRow } from './index.ts';

export interface NetworkPublicDeps {
  pool: Db;
  clock?: Clock;
}

export const PUBLIC_CACHE = 'public, max-age=60, stale-while-revalidate=60';
const PUBLIC_STATUSES = `('active','temporarily_closed')`;

export interface CityDto {
  id: string;
  slug: string;
  name: string;
  timezone: string;
}
export interface BranchDto {
  id: string;
  cityId: string;
  slug: string;
  name: string;
  address: string;
  timezone: string;
  status: 'active' | 'temporarily_closed';
  phone: string | null;
  publicContacts: Record<string, string>;
  bookingWindow: { defaultDays: number; maxDays: number };
  holdMinutes: number;
}
/** K5 №3 + расширение: часы сегодня, 'HH:mm' по зоне филиала. */
export interface BranchDetailDto extends BranchDto {
  hoursToday: Array<{ start: string; end: string }>;
  /** Действующий недельный график без исключений календаря – только для разметки openingHoursSpecification (K23 §6). Выходных дней в списке нет. */
  weeklyHours: Array<{ weekday: number; open: string; close: string }>;
}

export interface ResourceDto {
  id: string;
  branchId: string;
  roomId: string | null;
  roomName: string | null;
  roomSlug: string | null;
  type: string;
  zone: 'pc' | 'vr' | 'ps';
  name: string;
  stepMinutes: number;
  selfBookable: true;
}

type PublicRow = BranchRow & { phone_public: string | null; public_contacts: Record<string, unknown> };
const SELECT = `SELECT ${BRANCH_COLUMNS}, b.phone_public, b.public_contacts FROM ${BRANCH_FROM}
  WHERE b.status IN ${PUBLIC_STATUSES} AND c.status = 'active'`;
const ORDER = 'ORDER BY c.name, b.sort_order, b.name, b.id';

const notFound = () => new AppError('NOT_FOUND', 404, 'Не найдено');
const WINDOW_KEYS = ['booking.window_default_days', 'booking.window_max_days', 'booking.hold_minutes'] as const;

/** Только строковые контакты (K5 Record<string,string>): прочее в jsonb – не публичный контракт. */
function contacts(v: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(v ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string'));
}

async function toDto(db: Db, r: PublicRow, at: Date): Promise<BranchDto> {
  const b = toBranchInfo(r);
  const s = await resolveSettings(db, WINDOW_KEYS, { branchId: b.id }, at);
  return {
    id: b.id,
    cityId: b.cityId,
    slug: b.slug,
    name: b.name,
    address: b.address,
    timezone: b.timezone,
    status: b.status as BranchDto['status'],
    phone: r.phone_public,
    publicContacts: contacts(r.public_contacts),
    bookingWindow: { defaultDays: s['booking.window_default_days'].value, maxDays: s['booking.window_max_days'].value },
    holdMinutes: s['booking.hold_minutes'].value,
  };
}

async function publicBranch(db: Db, id: string): Promise<PublicRow> {
  if (!isUuid(id)) throw notFound();
  const r = await db.query<PublicRow>(`${SELECT} AND b.id = $1`, [id]);
  if (!r.rows[0]) throw notFound();
  return r.rows[0];
}

const branchesQuery = z.object({ city: z.string().max(64).optional() });
const resourcesQuery = z.object({ zone: z.enum(['pc', 'vr', 'ps']).optional() });

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value ?? {});
  if (!r.success) {
    throw new AppError('VALIDATION_FAILED', 400, 'Неверные данные запроса', {
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}

const cached = (reply: FastifyReply) => reply.header('cache-control', PUBLIC_CACHE);

export async function networkPublicRoutes(app: FastifyInstance, deps: NetworkPublicDeps): Promise<void> {
  const clock = deps.clock ?? systemClock;

  // №1: города, где есть хотя бы один публичный филиал.
  app.get('/cities', async (_request, reply) => {
    const r = await deps.pool.query<CityDto>(
      `SELECT c.id, c.slug, c.name, c.timezone FROM app.cities c
       WHERE c.status = 'active' AND EXISTS (SELECT 1 FROM app.branches b WHERE b.city_id = c.id AND b.status IN ${PUBLIC_STATUSES})
       ORDER BY c.name, c.id`,
    );
    cached(reply);
    return { items: r.rows.map(({ id, slug, name, timezone }) => ({ id, slug, name, timezone })) };
  });

  // №2: филиалы, по городу (slug) или все. Неизвестный город – пустой список (как мок сайта).
  app.get('/branches', async (request, reply) => {
    const q = parse(branchesQuery, request.query);
    const r = q.city === undefined
      ? await deps.pool.query<PublicRow>(`${SELECT} ${ORDER}`)
      : await deps.pool.query<PublicRow>(`${SELECT} AND c.slug = $1 ${ORDER}`, [q.city]);
    const at = clock.now();
    const items = await Promise.all(r.rows.map((row) => toDto(deps.pool, row, at)));
    cached(reply);
    return { items };
  });

  // №3: один филиал; 'preparing'/'archived'/нет – 404 одинаково.
  app.get('/branches/:branchId', async (request, reply) => {
    const row = await publicBranch(deps.pool, (request.params as { branchId: string }).branchId);
    const now = clock.now();
    const dto = await toDto(deps.pool, row, now);
    const info = toBranchInfo(row);
    const closedNow =
      info.tempClosed !== null && info.tempClosed.from <= now && (info.tempClosed.to === null || now < info.tempClosed.to);
    const today = todayIn(clock, info.timezone);
    const intervals = closedNow ? [] : await openIntervals(deps.pool, { branchId: row.id, date: today });
    const weekly = await deps.pool.query<{ weekday: number; open: string; close: string }>(
      `SELECT weekday, to_char(open_time, 'HH24:MI') AS open, to_char(close_time, 'HH24:MI') AS close FROM app.branch_weekly_hours
        WHERE branch_id = $1 AND NOT is_closed AND valid_from <= $2::date AND (valid_to IS NULL OR valid_to >= $2::date) ORDER BY weekday`,
      [row.id, today],
    );
    const out: BranchDetailDto = {
      ...dto,
      hoursToday: intervals.map((i) => ({ start: instantToLocal(i.start, info.timezone).time, end: instantToLocal(i.end, info.timezone).time })),
      weeklyHours: weekly.rows,
    };
    cached(reply);
    return out;
  });

  // №4: ресурсы для самостоятельной записи – публичный вид из modules/resources.
  app.get('/branches/:branchId/resources', async (request, reply) => {
    const row = await publicBranch(deps.pool, (request.params as { branchId: string }).branchId);
    const q = parse(resourcesQuery, request.query);
    const list = await listBookableResources(deps.pool, row.id, q.zone);
    const items: ResourceDto[] = list.map((x) => ({
      id: x.id,
      branchId: x.branchId,
      roomId: x.roomId,
      roomName: x.roomName,
      roomSlug: x.roomSlug,
      type: x.type,
      zone: x.zone,
      name: x.name,
      stepMinutes: x.stepMinutes,
      selfBookable: true,
    }));
    cached(reply);
    return { items };
  });
}

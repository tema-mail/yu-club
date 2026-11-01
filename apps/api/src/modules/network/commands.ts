// S0-11. Команды и списки сети для CRM и засева: города и филиалы (02 §5–6, 15 §5, K1, K2, K13).
// Транзакцию открывает вызывающий (routes – withTx, засев – свою); здесь – проверка прав, правило, запись, аудит.
// Права: отказ бросает AppError и помечается denialOf(err) – HTTP-слой пишет его в аудит отдельной транзакцией
// (ADR 0005 п.8). Чужой объект – NOT_FOUND, как несуществующий; в зоне без права – FORBIDDEN.
// Удаления нет – архив. Смена зоны филиала не трогает прошлые моменты (timestamptz, ADR 0003 п.8).
import { z } from 'zod';
import { diffFields, writeAudit, type AuditAction, type AuditObjectType, type AuditRequestMeta, type Db, type Tx } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { resolveSetting } from '../../core/settings.ts';
import { branchScopeSql, can, roleAllows, scopeFilter, type AccessContext, type Action } from '../../core/permissions.ts';
import { isValidTimeZone, systemClock, todayIn, type Clock, type TimeZone } from '../../core/time.ts';
import { BRANCH_COLUMNS, BRANCH_FROM, isUuid, toBranchInfo, type BranchInfo, type BranchRow, type BranchStatus } from './index.ts';

// ---- отказы

export interface Denial {
  action: AuditAction;
  object: { type: AuditObjectType; id: string | null };
  branchId: string | null;
  cityId: string | null;
  reason: string;
}
const DENIALS = new WeakMap<AppError, Denial>();
/** Отказ по правам (для writeDenied в HTTP-слое) или undefined, если ошибка другая. */
export const denialOf = (err: unknown): Denial | undefined => (err instanceof AppError ? DENIALS.get(err) : undefined);

const notFound = () => new AppError('NOT_FOUND', 404, 'Не найдено');

function deny(code: 'NOT_FOUND' | 'FORBIDDEN', perm: string, d: Omit<Denial, 'reason'>): never {
  const err = code === 'NOT_FOUND' ? notFound() : new AppError('FORBIDDEN', 403, 'Недостаточно прав', { action: perm });
  DENIALS.set(err, { ...d, reason: `${code}: ${perm}` });
  throw err;
}

/** Сеть (города): только роль; цель – сеть (K1 network.city.manage). */
function guardNetwork(ctx: AccessContext, perm: Action, auditAction: AuditAction, cityId: string | null): void {
  if (!(ctx.network && roleAllows(ctx.role, perm))) {
    deny('FORBIDDEN', perm, { action: auditAction, object: { type: 'city', id: cityId }, branchId: null, cityId });
  }
}

/** Филиал: сначала видимость (вне зоны – 404 как у несуществующего), потом право роли. */
function guardBranch(ctx: AccessContext, perm: Action, auditAction: AuditAction, b: { id: string; cityId: string }): void {
  const d = { action: auditAction, object: { type: 'branch' as const, id: b.id }, branchId: b.id, cityId: b.cityId };
  if (!can(ctx, 'network.view', { branchId: b.id })) deny('NOT_FOUND', perm, d);
  const target = perm === 'network.branch.create' || perm === 'network.branch.archive' ? { cityId: b.cityId } : { branchId: b.id };
  if (!can(ctx, perm, target)) deny('FORBIDDEN', perm, d);
}

// ---- разбор

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value ?? {});
  if (!r.success) {
    throw new AppError('VALIDATION_FAILED', 400, 'Неверные данные запроса', {
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}

function tzOf(s: string): TimeZone {
  if (!isValidTimeZone(s)) throw new AppError('INVALID_TIMEZONE', 422, 'Неизвестный часовой пояс', { timezone: s });
  return s;
}

const SLUG = z.string().regex(/^[a-z0-9-]{1,64}$/);
const CODE = z.string().trim().min(1).max(64);
const NAME = z.string().trim().min(1).max(200);
const TEXT = z.string().max(4000).nullable();
const ROW_VERSION = z.number().int().min(1);

const cityCreate = z.object({ code: CODE.optional(), slug: SLUG, name: NAME, region: TEXT.optional(), timezone: z.string(), comment: TEXT.optional() });
const cityPatch = z.object({ rowVersion: ROW_VERSION, slug: SLUG.optional(), name: NAME.optional(), region: TEXT.optional(), timezone: z.string().optional(), comment: TEXT.optional() });
const branchFields = {
  name: NAME,
  address: z.string().trim().min(1).max(500),
  phonePublic: z.string().max(32).nullable(),
  publicContacts: z.record(z.string(), z.unknown()),
  description: TEXT,
  directions: TEXT,
  internalComment: TEXT,
  sortOrder: z.number().int().min(-1_000_000).max(1_000_000),
};
const branchCreate = z.object({
  cityId: z.string(),
  code: CODE.optional(),
  slug: SLUG,
  timezone: z.string().optional(),
  ...branchFields,
  phonePublic: branchFields.phonePublic.optional(),
  publicContacts: branchFields.publicContacts.optional(),
  description: TEXT.optional(),
  directions: TEXT.optional(),
  internalComment: TEXT.optional(),
  sortOrder: branchFields.sortOrder.optional(),
});
const branchPatch = z
  .object({ rowVersion: ROW_VERSION, slug: SLUG.optional() })
  .extend(Object.fromEntries(Object.entries(branchFields).map(([k, v]) => [k, v.optional()])) as { [K in keyof typeof branchFields]: z.ZodOptional<(typeof branchFields)[K]> });
const statusInput = z.discriminatedUnion('status', [
  z.object({ rowVersion: ROW_VERSION, status: z.enum(['preparing', 'active']) }),
  z.object({
    rowVersion: ROW_VERSION,
    status: z.literal('temporarily_closed'),
    from: z.coerce.date(),
    to: z.coerce.date().nullable().optional(),
    reason: z.string().trim().min(1).max(500),
  }),
]);

// ---- города

export interface CityInfo {
  id: string;
  code: string;
  slug: string;
  name: string;
  region: string | null;
  timezone: TimeZone;
  status: 'active' | 'archived';
  comment: string | null;
  archivedAt: Date | null;
  rowVersion: number;
}

const CITY_SELECT = `id, code, slug, name, region, timezone, status, comment, archived_at AS "archivedAt", row_version AS "rowVersion" FROM app.cities`;

async function lockCity(tx: Tx, cityId: string): Promise<CityInfo | null> {
  if (!isUuid(cityId)) return null;
  const r = await tx.query<CityInfo>(`SELECT ${CITY_SELECT} WHERE id = $1 FOR UPDATE`, [cityId]);
  return r.rows[0] ?? null;
}

function taken(err: unknown): never {
  if ((err as { code?: string }).code === '23505') throw new AppError('NETWORK_SLUG_TAKEN', 409, 'Код или адрес (slug) уже занят');
  throw err;
}

function checkVersion(current: number, sent: number): void {
  if (current !== sent) throw new AppError('VERSION_CONFLICT', 409, 'Запись изменилась – обновите форму', { current });
}

export async function getCity(db: Db, ctx: AccessContext, cityId: string): Promise<CityInfo> {
  if (!isUuid(cityId)) throw notFound();
  const r = await db.query<CityInfo>(`SELECT ${CITY_SELECT} WHERE id = $1`, [cityId]);
  const c = r.rows[0];
  if (!c || !(await cityVisible(db, ctx, c.id))) throw notFound();
  return c;
}

/** Город виден: Владельцу, назначенным на город и тем, у кого есть филиал этого города. */
async function cityVisible(db: Db, ctx: AccessContext, cityId: string): Promise<boolean> {
  if (!roleAllows(ctx.role, 'network.view')) return false;
  if (ctx.network || ctx.cityIds.has(cityId)) return true;
  if (ctx.branchIds.size === 0) return false;
  const r = await db.query('SELECT 1 FROM app.branches WHERE city_id = $1 AND id = ANY($2::uuid[]) LIMIT 1', [cityId, [...ctx.branchIds]]);
  return r.rowCount === 1;
}

export async function createCity(tx: Tx, ctx: AccessContext, raw: unknown, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<CityInfo> {
  guardNetwork(ctx, 'network.city.manage', 'city.created', null);
  const input = parse(cityCreate, raw);
  const tz = tzOf(input.timezone);
  const r = await tx
    .query<CityInfo>(
      `INSERT INTO app.cities (code, slug, name, region, timezone, comment) VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${CITY_SELECT.replace(' FROM app.cities', '')}`,
      [input.code ?? input.slug, input.slug, input.name, input.region ?? null, tz, input.comment ?? null],
    )
    .catch(taken);
  const city = r.rows[0]!;
  await writeAudit(tx, meta, { action: 'city.created', object: { type: 'city', id: city.id }, cityId: city.id, ...diffFields({}, { ...city }) }, clock);
  return city;
}

export async function updateCity(tx: Tx, ctx: AccessContext, cityId: string, raw: unknown, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<CityInfo> {
  guardNetwork(ctx, 'network.city.manage', 'city.updated', isUuid(cityId) ? cityId : null);
  const input = parse(cityPatch, raw);
  const cur = await lockCity(tx, cityId);
  if (!cur) throw notFound();
  checkVersion(cur.rowVersion, input.rowVersion);
  const next = {
    slug: input.slug ?? cur.slug,
    name: input.name ?? cur.name,
    region: input.region === undefined ? cur.region : input.region,
    timezone: input.timezone === undefined ? cur.timezone : tzOf(input.timezone),
    comment: input.comment === undefined ? cur.comment : input.comment,
  };
  const r = await tx
    .query<CityInfo>(
      `UPDATE app.cities SET slug = $2, name = $3, region = $4, timezone = $5, comment = $6, row_version = row_version + 1
       WHERE id = $1 RETURNING ${CITY_SELECT.replace(' FROM app.cities', '')}`,
      [cityId, next.slug, next.name, next.region, next.timezone, next.comment],
    )
    .catch(taken);
  const city = r.rows[0]!;
  const d = diffFields({ ...cur, rowVersion: 0 }, { ...city, rowVersion: 0 });
  if (Object.keys(d.after).length > 0) await writeAudit(tx, meta, { action: 'city.updated', object: { type: 'city', id: city.id }, cityId: city.id, ...d }, clock);
  return city;
}

/** Архив города – только без неархивных филиалов (02 §5.2). */
export async function archiveCity(
  tx: Tx,
  ctx: AccessContext,
  cityId: string,
  raw: unknown,
  meta: AuditRequestMeta,
  clock: Clock = systemClock,
): Promise<CityInfo> {
  guardNetwork(ctx, 'network.city.manage', 'city.archived', isUuid(cityId) ? cityId : null);
  const input = parse(z.object({ rowVersion: ROW_VERSION }), raw);
  const cur = await lockCity(tx, cityId);
  if (!cur) throw notFound();
  if (cur.status === 'archived') return cur;
  checkVersion(cur.rowVersion, input.rowVersion);
  const active = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM app.branches WHERE city_id = $1 AND status <> 'archived'`, [cityId]);
  if (active.rows[0]!.n > 0) {
    throw new AppError('CITY_HAS_ACTIVE_BRANCHES', 409, 'В городе есть неархивные филиалы', { count: active.rows[0]!.n });
  }
  const r = await tx.query<CityInfo>(
    `UPDATE app.cities SET status = 'archived', archived_at = $2, row_version = row_version + 1 WHERE id = $1 RETURNING ${CITY_SELECT.replace(' FROM app.cities', '')}`,
    [cityId, clock.now()],
  );
  const city = r.rows[0]!;
  await writeAudit(tx, meta, { action: 'city.archived', object: { type: 'city', id: city.id }, cityId: city.id, before: { status: cur.status }, after: { status: city.status } }, clock);
  return city;
}

// ---- филиалы

export interface BranchCard extends BranchInfo {
  code: string;
  phonePublic: string | null;
  publicContacts: Record<string, unknown>;
  description: string | null;
  directions: string | null;
  internalComment: string | null;
  sortOrder: number;
  archivedAt: Date | null;
  rowVersion: number;
}

const CARD_EXTRA = `, b.code, b.phone_public, b.public_contacts, b.description, b.directions, b.internal_comment,
  b.sort_order, b.archived_at, b.row_version`;
type CardRow = BranchRow & {
  code: string;
  phone_public: string | null;
  public_contacts: Record<string, unknown>;
  description: string | null;
  directions: string | null;
  internal_comment: string | null;
  sort_order: number;
  archived_at: Date | null;
  row_version: number;
};

function toCard(r: CardRow): BranchCard {
  return {
    ...toBranchInfo(r),
    code: r.code,
    phonePublic: r.phone_public,
    publicContacts: r.public_contacts,
    description: r.description,
    directions: r.directions,
    internalComment: r.internal_comment,
    sortOrder: r.sort_order,
    archivedAt: r.archived_at,
    rowVersion: r.row_version,
  };
}

const CARD_SQL = `SELECT ${BRANCH_COLUMNS}${CARD_EXTRA} FROM ${BRANCH_FROM}`;

async function loadCard(db: Db, branchId: string, lock: boolean): Promise<BranchCard | null> {
  if (!isUuid(branchId)) return null;
  const r = await db.query<CardRow>(`${CARD_SQL} WHERE b.id = $1${lock ? ' FOR UPDATE OF b' : ''}`, [branchId]);
  return r.rows[0] ? toCard(r.rows[0]) : null;
}

/** Карточка филиала в зоне (K11 №18). Вне зоны – NOT_FOUND с тем же телом. */
export async function getBranchCard(db: Db, ctx: AccessContext, branchId: string): Promise<BranchCard> {
  const b = await loadCard(db, branchId, false);
  if (!b || !can(ctx, 'network.view', { branchId: b.id })) throw notFound();
  return b;
}

/** Карточка для команды: блокировка строки, видимость, право; архивный – не редактируется. */
async function lockForCommand(tx: Tx, ctx: AccessContext, branchId: string, perm: Action, action: AuditAction): Promise<BranchCard> {
  const b = await loadCard(tx, branchId, true);
  // Нет объекта – всегда NOT_FOUND до проверки роли: ответ как у чужого, существование не раскрывается.
  if (!b) deny('NOT_FOUND', perm, { action, object: { type: 'branch', id: isUuid(branchId) ? branchId : null }, branchId: null, cityId: null });
  guardBranch(ctx, perm, action, b);
  return b;
}


async function auditBranch(tx: Tx, meta: AuditRequestMeta, clock: Clock, action: AuditAction, before: BranchCard | null, after: BranchCard): Promise<void> {
  const strip = (b: BranchCard | null) => (b ? { ...b, rowVersion: 0, cityName: '', citySlug: '' } : {});
  const d = diffFields(strip(before), strip(after));
  if (before && Object.keys(d.after).length === 0) return;
  await writeAudit(tx, meta, { action, object: { type: 'branch', id: after.id }, branchId: after.id, cityId: after.cityId, ...d }, clock);
}

/** Новый филиал: статус «готовится», зона – город по умолчанию (15 §5.2), 7 строк графика из настройки K7
 *  branch.default_hours города (система – 10:00–22:00, 01 §4 п.1) с сегодняшней даты филиала. */
export async function createBranch(tx: Tx, ctx: AccessContext, raw: unknown, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<BranchCard> {
  const input = parse(branchCreate, raw);
  const city = await lockCity(tx, input.cityId);
  const d = { action: 'branch.created' as const, object: { type: 'branch' as const, id: null }, branchId: null, cityId: city?.id ?? null };
  if (!city) deny('NOT_FOUND', 'network.branch.create', d); // как чужой город – до проверки роли
  if (!can(ctx, 'network.branch.create', { cityId: city.id })) {
    deny((await cityVisible(tx, ctx, city.id)) ? 'FORBIDDEN' : 'NOT_FOUND', 'network.branch.create', d);
  }
  if (city.status === 'archived') throw new AppError('CITY_ARCHIVED', 409, 'Город в архиве');
  const tz = input.timezone === undefined ? city.timezone : tzOf(input.timezone);
  const r = await tx
    .query<{ id: string }>(
      `INSERT INTO app.branches (city_id, code, slug, name, address, timezone, phone_public, public_contacts, description, directions, internal_comment, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [
        city.id,
        input.code ?? `${city.code}-${input.slug}`,
        input.slug,
        input.name,
        input.address,
        tz,
        input.phonePublic ?? null,
        JSON.stringify(input.publicContacts ?? {}),
        input.description ?? null,
        input.directions ?? null,
        input.internalComment ?? null,
        input.sortOrder ?? 0,
      ],
    )
    .catch(taken);
  const id = r.rows[0]!.id;
  const hours = (await resolveSetting(tx, 'branch.default_hours', { cityId: city.id }, clock.now())).value;
  await tx.query(
    `INSERT INTO app.branch_weekly_hours (branch_id, weekday, open_time, close_time, valid_from, created_by)
     SELECT $1, wd, $2::time, $3::time, $4::date, $5 FROM generate_series(1, 7) AS wd`,
    [id, hours.open, hours.close, todayIn(clock, tz), ctx.actor.staffId],
  );
  const card = (await loadCard(tx, id, false))!;
  await auditBranch(tx, meta, clock, 'branch.created', null, card);
  return card;
}

export async function updateBranch(tx: Tx, ctx: AccessContext, branchId: string, raw: unknown, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<BranchCard> {
  const cur = await lockForCommand(tx, ctx, branchId, 'network.branch.update', 'branch.updated');
  const input = parse(branchPatch, raw);
  if (cur.status === 'archived') throw new AppError('BRANCH_ARCHIVED', 409, 'Филиал в архиве');
  checkVersion(cur.rowVersion, input.rowVersion);
  const pick = <K extends keyof typeof input & keyof BranchCard>(k: K) => (input[k] === undefined ? cur[k] : input[k]);
  await tx
    .query(
      `UPDATE app.branches SET slug = $2, name = $3, address = $4, phone_public = $5, public_contacts = $6, description = $7,
         directions = $8, internal_comment = $9, sort_order = $10, row_version = row_version + 1 WHERE id = $1`,
      [cur.id, pick('slug'), pick('name'), pick('address'), pick('phonePublic'), JSON.stringify(pick('publicContacts')), pick('description'), pick('directions'), pick('internalComment'), pick('sortOrder')],
    )
    .catch(taken);
  const next = (await loadCard(tx, cur.id, false))!;
  await auditBranch(tx, meta, clock, 'branch.updated', cur, next);
  return next;
}

/** Статус: готовится / работает / временно закрыт (с датами и причиной). Архив – archiveBranch. */
export async function setBranchStatus(tx: Tx, ctx: AccessContext, branchId: string, raw: unknown, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<BranchCard> {
  const cur = await lockForCommand(tx, ctx, branchId, 'network.branch.update', 'branch.status_changed');
  const input = parse(statusInput, raw);
  if (cur.status === 'archived') throw new AppError('BRANCH_ARCHIVED', 409, 'Филиал в архиве');
  checkVersion(cur.rowVersion, input.rowVersion);
  const closed = input.status === 'temporarily_closed' ? input : null;
  if (closed?.to && closed.to <= closed.from) throw new AppError('VALIDATION_FAILED', 400, 'Конец закрытия раньше начала', { field: 'to' });
  await tx.query(
    `UPDATE app.branches SET status = $2, temp_closed_from = $3, temp_closed_to = $4, temp_close_reason = $5, row_version = row_version + 1 WHERE id = $1`,
    [cur.id, input.status, closed?.from ?? null, closed?.to ?? null, closed?.reason ?? null],
  );
  const next = (await loadCard(tx, cur.id, false))!;
  await auditBranch(tx, meta, clock, 'branch.status_changed', cur, next);
  return next;
}

/** Архив вместо удаления (02 §12). Строка и история остаются. */
export async function archiveBranch(tx: Tx, ctx: AccessContext, branchId: string, raw: unknown, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<BranchCard> {
  const cur = await lockForCommand(tx, ctx, branchId, 'network.branch.archive', 'branch.archived');
  const input = parse(z.object({ rowVersion: ROW_VERSION }), raw);
  if (cur.status === 'archived') return cur;
  checkVersion(cur.rowVersion, input.rowVersion);
  await tx.query(
    `UPDATE app.branches SET status = 'archived', archived_at = $2, temp_closed_from = NULL, temp_closed_to = NULL, temp_close_reason = NULL,
       row_version = row_version + 1 WHERE id = $1`,
    [cur.id, clock.now()],
  );
  const next = (await loadCard(tx, cur.id, false))!;
  await auditBranch(tx, meta, clock, 'branch.archived', cur, next);
  return next;
}

/** Смена зоны (K13 changeBranchTimezone): прошлые моменты не сдвигаются, график остаётся «настенным» временем.
 *  affectedBookingIds – будущие брони; модуля броней ещё нет (S1-08), пока пусто. */
export async function changeBranchTimezone(
  tx: Tx,
  ctx: AccessContext,
  branchId: string,
  raw: unknown,
  meta: AuditRequestMeta,
  clock: Clock = systemClock,
): Promise<{ branch: BranchCard; affectedBookingIds: string[] }> {
  const cur = await lockForCommand(tx, ctx, branchId, 'network.branch.update', 'branch.updated');
  const input = parse(z.object({ rowVersion: ROW_VERSION, timezone: z.string() }), raw);
  if (cur.status === 'archived') throw new AppError('BRANCH_ARCHIVED', 409, 'Филиал в архиве');
  checkVersion(cur.rowVersion, input.rowVersion);
  const tz = tzOf(input.timezone);
  await tx.query('UPDATE app.branches SET timezone = $2, row_version = row_version + 1 WHERE id = $1', [cur.id, tz]);
  const next = (await loadCard(tx, cur.id, false))!;
  await auditBranch(tx, meta, clock, 'branch.updated', cur, next);
  return { branch: next, affectedBookingIds: [] };
}

// ---- списки (K11: курсор, limit 1..100, порядок фиксирован)

const listQuery = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cityId: z.string().optional(),
  status: z.enum(['preparing', 'active', 'temporarily_closed', 'archived']).optional(),
  includeArchived: z.enum(['true', 'false']).optional(),
});

const SORT_INT = z.number().int().min(-2_147_483_648).max(2_147_483_647);
const BRANCH_CURSOR = z.tuple([z.string().max(200), SORT_INT, z.string().max(200), z.uuid()]);
const CITY_CURSOR = z.tuple([z.string().max(200), z.uuid()]);

/** Курсор – base64url(JSON) по схеме ключа сортировки; любой мусор – 400, до SQL. */
function decodeCursor<T>(s: string | undefined, schema: z.ZodType<T>): T | null {
  if (s === undefined) return null;
  let v: unknown;
  try {
    v = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
  } catch {
    v = undefined;
  }
  const r = schema.safeParse(v);
  if (!r.success) throw new AppError('VALIDATION_FAILED', 400, 'Неверный курсор', { field: 'cursor' });
  return r.data;
}
const encodeCursor = (v: unknown[]) => Buffer.from(JSON.stringify(v)).toString('base64url');

/** Филиалы зоны – порядок (город, sort_order, название, id). Архивные – только по запросу. */
export async function listBranches(db: Db, ctx: AccessContext, raw: unknown): Promise<{ items: BranchInfo[]; nextCursor: string | null }> {
  const q = parse(listQuery, raw);
  const params: unknown[] = [];
  const where = [branchScopeSql('b.id', scopeFilter(ctx, 'network.view'), params)];
  if (q.cityId !== undefined) {
    if (!isUuid(q.cityId)) return { items: [], nextCursor: null };
    params.push(q.cityId);
    where.push(`b.city_id = $${params.length}`);
  }
  if (q.status !== undefined) {
    params.push(q.status);
    where.push(`b.status = $${params.length}`);
  } else if (q.includeArchived !== 'true') where.push(`b.status <> 'archived'`);
  const c = decodeCursor(q.cursor, BRANCH_CURSOR);
  if (c) {
    params.push(...c);
    const n = params.length;
    where.push(`(c.name, b.sort_order, b.name, b.id) > ($${n - 3}::text, $${n - 2}::int, $${n - 1}::text, $${n}::uuid)`);
  }
  params.push(q.limit + 1);
  const r = await db.query<BranchRow & { sort_order: number }>(
    `SELECT ${BRANCH_COLUMNS}, b.sort_order FROM ${BRANCH_FROM} WHERE ${where.join(' AND ')}
     ORDER BY c.name, b.sort_order, b.name, b.id LIMIT $${params.length}`,
    params,
  );
  const rows = r.rows.slice(0, q.limit);
  const last = rows.at(-1);
  const nextCursor = r.rows.length > q.limit && last ? encodeCursor([last.city_name, last.sort_order, last.name, last.id]) : null;
  return { items: rows.map(toBranchInfo), nextCursor };
}

/** Города зоны – порядок (название, id). */
export async function listCities(db: Db, ctx: AccessContext, raw: unknown): Promise<{ items: CityInfo[]; nextCursor: string | null }> {
  const q = parse(listQuery.pick({ cursor: true, limit: true, includeArchived: true }), raw);
  const params: unknown[] = [];
  const where: string[] = [];
  if (!roleAllows(ctx.role, 'network.view')) where.push('FALSE');
  else if (!ctx.network) {
    params.push([...ctx.cityIds], [...ctx.branchIds]);
    where.push(`(id = ANY($1::uuid[]) OR id IN (SELECT city_id FROM app.branches WHERE id = ANY($2::uuid[])))`);
  }
  if (q.includeArchived !== 'true') where.push(`status <> 'archived'`);
  const c = decodeCursor(q.cursor, CITY_CURSOR);
  if (c) {
    params.push(...c);
    where.push(`(name, id) > ($${params.length - 1}::text, $${params.length}::uuid)`);
  }
  params.push(q.limit + 1);
  const r = await db.query<CityInfo>(
    `SELECT ${CITY_SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY name, id LIMIT $${params.length}`,
    params,
  );
  const rows = r.rows.slice(0, q.limit);
  const last = rows.at(-1);
  return { items: rows, nextCursor: r.rows.length > q.limit && last ? encodeCursor([last.name, last.id]) : null };
}

export type { BranchStatus };

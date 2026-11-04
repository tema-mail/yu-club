// K2. Событие аудита: запись в journal.audit_events (только вставка, 0003_audit.sql).
// writeAudit – в транзакции команды; writeDenied – отдельно, её сбой только логируется.
// Секреты и ПДн маскируются ДО записи по явному списку ключей (redact), не по угадыванию содержимого.
import type pg from 'pg';
import { systemClock, type Clock } from './time.ts';

/** Минимальный интерфейс подключения: pg.Pool, pg.PoolClient, pg.Client. */
export interface Db {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>;
}
/** Подключение внутри открытой транзакции команды (тот же интерфейс, другой смысл). */
export type Tx = Db;

// ---- акторы (K1; здесь – потому что аудит раньше прав, permissions.ts реэкспортирует)

export type StaffRole = 'owner' | 'director' | 'admin';

export type Actor =
  | { kind: 'staff'; staffId: string; sessionId: string }
  | { kind: 'client'; clientId: string; sessionId: string }
  | { kind: 'visitor'; visitorId: string }
  | { kind: 'system'; process: string };

/** Снимок зоны – структурно совместим с K1 AccessContext. */
export interface AuditAccessSnapshot {
  role: StaffRole;
  network: boolean;
  cityIds: ReadonlySet<string>;
  branchIds: ReadonlySet<string>;
}

// ---- реестр (K2 §Реестр действий): код действия – 'группа.действие', объект – из списка

export type AuditAction = `${string}.${string}`;
const ACTION_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

export const AUDIT_OBJECT_TYPES = [
  'staff',
  'client',
  'city',
  'branch',
  'calendar_exception',
  'staff_assignment',
  'space',
  'room',
  'resource',
  'booking',
  'hold',
  'resource_block',
  'setting',
  'dictionary',
  'tariff',
  'notification',
  'export',
  'finance_category', // Э2, K17 §5 (K2 «Деньги»)
  'finance_operation', // Э2, K17 §3–§4
  'certificate', // Э2, K16 (K2 «Сертификаты»)
  'payment', // Э2, K10 (K2 «Деньги»)
  'cash_shift', // Э2, K17 §7 (K2 «Деньги»)
  // Э4 (K2 «Типы объектов Э4»; K21 §14, K22 §16)
  'notification_campaign',
  'notification_template',
  'publication',
  'game',
  'room_page',
  'branch_page',
  'content_page',
  'home_block',
  'media',
] as const;
export type AuditObjectType = (typeof AUDIT_OBJECT_TYPES)[number];

export type AuditSource = 'crm' | 'site' | 'account' | 'system' | 'cli';
export type AuditResult = 'success' | 'denied' | 'error';

export interface AuditInput {
  action: AuditAction;
  object: { type: AuditObjectType; id: string | null };
  branchId?: string | null;
  cityId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  result?: AuditResult;
}

export interface AuditRequestMeta {
  actor: Actor;
  access?: AuditAccessSnapshot;
  source: AuditSource;
  requestId: string;
  ip?: string;
}

// ---- маскирование

export const PD_KEYS: Readonly<Record<string, 'phone' | 'email' | 'name' | 'date'>> = {
  phone: 'phone',
  phoneE164: 'phone',
  guestPhone: 'phone',
  email: 'email',
  firstName: 'name',
  lastName: 'name',
  guestName: 'name',
  birthDate: 'date',
};
// Новое поле с ПДн в карточке = строка в PD_KEYS того же коммита (ревью проверяет).
export const SECRET_KEYS: readonly string[] = [
  'password',
  'passwordHash',
  'otp',
  'otpCode',
  'codeHash',
  'token',
  'tokenHash',
  'secret',
  'totpSecret',
  'p256dh',
  'auth',
  'apiKey',
  'authorization',
  'cookie',
  'pin', // код сертификата K16 §3: в аудит не попадает даже по ошибке вызывающего
  'pinHash',
];
// 'code' в список НЕ входит: это обычное поле (branch.code, city.code).

/** Имя ключа без регистра и разделителей: phone_e164 = phoneE164 = PHONE_E164 (решение: snake_case из SQL тоже ловится). */
function normKey(k: string): string {
  return k.toLowerCase().replace(/[_-]/g, '');
}
const SECRET_SET = new Set(SECRET_KEYS.map(normKey));
const PD_MAP = new Map(Object.entries(PD_KEYS).map(([k, v]) => [normKey(k), v]));
const MASK = '***';
const MAX_DEPTH = 32;

function maskPd(kind: 'phone' | 'email' | 'name' | 'date', value: unknown): unknown {
  if (value === null || value === undefined) return value; // факт «пусто» не секрет
  if (typeof value !== 'string') return MASK;
  if (value === '') return '';
  switch (kind) {
    case 'phone': {
      const head = value.startsWith('+') ? 2 : 1;
      if (value.length <= head + 4) return MASK;
      return value.slice(0, head) + '*'.repeat(value.length - head - 4) + value.slice(-4);
    }
    case 'email': {
      const at = value.lastIndexOf('@');
      if (at < 1) return MASK;
      return `${value[0]}***${value.slice(at)}`;
    }
    case 'name':
      return `${[...value][0]}***`;
    case 'date':
      return '****-**-**';
  }
}

function redactAt(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return MASK; // защита от циклов и бездонных структур
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((v) => redactAt(v, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const n = normKey(k);
      if (SECRET_SET.has(n)) out[k] = MASK;
      else if (PD_MAP.has(n)) out[k] = maskPd(PD_MAP.get(n)!, v);
      else out[k] = redactAt(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'bigint') return value.toString();
  return value;
}

/** Маскирование на любой глубине по именам ключей (K2). Значение секрета не сохраняется вовсе. */
export function redact(value: unknown): unknown {
  return redactAt(value, 0);
}

/** Только изменённые поля верхнего уровня (K2: «before/after – diff, не весь объект»). */
export function diffFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null)) {
      b[k] = before[k] ?? null;
      a[k] = after[k] ?? null;
    }
  }
  return { before: b, after: a };
}

// ---- запись

function actorColumns(actor: Actor): { type: string; id: string | null } {
  switch (actor.kind) {
    case 'staff':
      return { type: 'staff', id: actor.staffId };
    case 'client':
      return { type: 'client', id: actor.clientId };
    case 'visitor':
      return { type: 'anonymous', id: null };
    case 'system':
      return { type: 'system', id: null };
  }
}

function scopeSnapshot(access: AuditAccessSnapshot): object {
  if (access.network) return { network: true };
  return { cityIds: [...access.cityIds].sort(), branchIds: [...access.branchIds].sort() };
}

function toJson(v: unknown): string | null {
  return v === undefined ? null : JSON.stringify(redact(v));
}

const INSERT_SQL = `INSERT INTO journal.audit_events
  (occurred_at, actor_type, actor_id, actor_role, actor_scope, action, object_type, object_id,
   branch_id, city_id, before, after, result, reason, source, request_id, ip)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`;

async function insert(db: Db, meta: AuditRequestMeta, input: AuditInput, clock: Clock): Promise<void> {
  if (!ACTION_RE.test(input.action)) throw new Error(`audit: код действия не по формату реестра K2: ${input.action}`);
  if (!(AUDIT_OBJECT_TYPES as readonly string[]).includes(input.object.type)) {
    throw new Error(`audit: неизвестный тип объекта ${input.object.type}`);
  }
  const actor = actorColumns(meta.actor);
  const staffAccess = meta.actor.kind === 'staff' ? meta.access : undefined;
  await db.query(INSERT_SQL, [
    clock.now(),
    actor.type,
    actor.id,
    staffAccess?.role ?? null,
    staffAccess ? JSON.stringify(scopeSnapshot(staffAccess)) : null,
    input.action,
    input.object.type,
    input.object.id,
    input.branchId ?? null,
    input.cityId ?? null,
    toJson(input.before),
    toJson(input.after),
    input.result ?? 'success',
    input.reason ?? null,
    meta.source,
    meta.requestId,
    meta.ip ?? null,
  ]);
}

/** В ТОЙ ЖЕ транзакции, что и изменение. Сбой записи роняет команду (K2 §Ошибки). */
export async function writeAudit(tx: Tx, meta: AuditRequestMeta, input: AuditInput, clock: Clock = systemClock): Promise<void> {
  await insert(tx, meta, input, clock);
}

/** Отдельной транзакцией (основная откатилась): отказ или ошибка. Без before/after. Не бросает. */
export async function writeDenied(
  db: Db,
  meta: AuditRequestMeta,
  input: Omit<AuditInput, 'before' | 'after'> & { result: 'denied' | 'error' },
  clock: Clock = systemClock,
  log: (err: unknown) => void = (err) => console.error('audit: writeDenied не записан', err),
): Promise<void> {
  try {
    const { action, object, branchId, cityId, reason, result } = input;
    await insert(db, meta, { action, object, branchId, cityId, reason, result }, clock);
  } catch (err) {
    log(err);
  }
}

// ---- хронология объекта (K2 objectTimeline, 16 §16)

export interface AuditEventRow {
  id: string; // bigint строкой – он же курсор
  at: Date;
  action: string;
  objectType: string;
  objectId: string | null;
  actorType: 'staff' | 'client' | 'system' | 'anonymous';
  actorId: string | null;
  actorRole: StaffRole | null;
  before: unknown;
  after: unknown;
  reason: string | null;
  result: AuditResult;
}

/** События объекта, новые сверху, порциями по курсору (id < cursor). Право на объект проверяет вызывающий
 *  (K1 assertCan c audit.view); onlyActorId – для audit.view.own (Администратор видит только свои действия).
 *  before/after уже маскированы при записи (redact); ip наружу не отдаётся (K2 правило 4). */
export async function objectTimeline(
  db: Db,
  filter: { objectType: AuditObjectType; objectId: string; onlyActorId?: string },
  page: { cursor?: string; limit: number },
): Promise<{ items: AuditEventRow[]; nextCursor: string | null }> {
  if (page.cursor !== undefined && !/^\d{1,18}$/.test(page.cursor)) throw new Error('objectTimeline: неверный курсор');
  const values: unknown[] = [filter.objectType, filter.objectId];
  let where = 'object_type = $1 AND object_id = $2';
  if (filter.onlyActorId !== undefined) {
    values.push(filter.onlyActorId);
    where += ` AND actor_type = 'staff' AND actor_id = $${values.length}`;
  }
  if (page.cursor !== undefined) {
    values.push(page.cursor);
    where += ` AND id < $${values.length}::bigint`;
  }
  values.push(page.limit + 1);
  const r = await db.query<{
    id: string;
    occurred_at: Date;
    action: string;
    object_type: string;
    object_id: string | null;
    actor_type: AuditEventRow['actorType'];
    actor_id: string | null;
    actor_role: StaffRole | null;
    before: unknown;
    after: unknown;
    reason: string | null;
    result: AuditResult;
  }>(
    `SELECT id::text AS id, occurred_at, action, object_type, object_id, actor_type, actor_id, actor_role, before, after, reason, result
     FROM journal.audit_events WHERE ${where} ORDER BY id DESC LIMIT $${values.length}`,
    values,
  );
  const rows = r.rows.slice(0, page.limit);
  return {
    items: rows.map((x) => ({
      id: x.id,
      at: x.occurred_at,
      action: x.action,
      objectType: x.object_type,
      objectId: x.object_id,
      actorType: x.actor_type,
      actorId: x.actor_id,
      actorRole: x.actor_role,
      before: x.before,
      after: x.after,
      reason: x.reason,
      result: x.result,
    })),
    nextCursor: r.rows.length > page.limit ? rows.at(-1)!.id : null,
  };
}

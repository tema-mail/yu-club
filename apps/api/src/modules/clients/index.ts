// K9. Клиент (S1-11): телефон в E.164, статусы, бронь без профиля (guest), проверка «можно бронировать»,
// поиск и карточка в CRM. Одна карточка на телефон держит база (UNIQUE), здесь – понятные ошибки и аудит.
// Видимость (04 §8.3, решение K9): Владелец – вся сеть; остальные – клиенты, связанные с их филиалами
// (бронь – модуль booking даёт ClientBranchLinks), плюс точное совпадение телефона (для новой записи).
// Администратор видит минимум: без полного телефона, email, даты рождения (client.view.full – О/Д).
import type pg from 'pg';
import { writeAudit, type AuditRequestMeta, type Db, type Tx } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { roleAllows, scopeFilter, type AccessContext } from '../../core/permissions.ts';
import { systemClock, type Clock } from '../../core/time.ts';

export const CLIENT_STATUSES = ['guest', 'active', 'restricted', 'blocked', 'deletion_requested', 'anonymized'] as const;
export type ClientStatus = (typeof CLIENT_STATUSES)[number];

export interface ClientRef {
  id: string;
  status: ClientStatus;
  firstName: string | null;
  lastName: string | null;
  phoneMasked: string;
}

export interface Pool extends Db {
  connect(): Promise<pg.PoolClient>;
}

export async function withTx<T>(pool: Pool, fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// ---- телефон

const E164_RE = /^\+[1-9][0-9]{7,14}$/;
const SEPARATORS_RE = /[\s().-]/g;
const badPhone = () => new AppError('VALIDATION_FAILED', 400, 'Неверный номер телефона', { field: 'phone' });

/** '+7 (913) 123-45-67', '8913…', '9131234567' → '+79131234567'. РФ по умолчанию. Неверный → VALIDATION_FAILED. */
export function normalizePhone(input: string): string {
  if (typeof input !== 'string' || input.length > 32) throw badPhone();
  const raw = input.trim().replace(SEPARATORS_RE, '');
  const plus = raw.startsWith('+');
  const digits = plus ? raw.slice(1) : raw;
  if (!/^\d+$/.test(digits)) throw badPhone();
  let e164: string;
  if (plus) e164 = `+${digits}`;
  else if (digits.length === 11 && (digits[0] === '8' || digits[0] === '7')) e164 = `+7${digits.slice(1)}`;
  else if (digits.length === 10) e164 = `+7${digits}`;
  else throw badPhone();
  if (!E164_RE.test(e164) || (e164.startsWith('+7') && e164.length !== 12)) throw badPhone();
  return e164;
}

/** '+7 ••• ••• ••-67' (17 §8.2). Обезличенный (NULL) – пустая строка. */
export function maskPhone(e164: string | null): string {
  if (!e164) return '';
  if (e164.startsWith('+7') && e164.length === 12) return `+7 ••• ••• ••-${e164.slice(-2)}`;
  return `${e164.slice(0, 2)} ••• ${e164.slice(-2)}`;
}

// ---- строки

interface ClientRow {
  id: string;
  status: ClientStatus;
  first_name: string | null;
  last_name: string | null;
  phone_e164: string | null;
}
const REF_COLS = 'c.id, c.status, c.first_name, c.last_name, c.phone_e164';

function toRef(r: ClientRow): ClientRef {
  return { id: r.id, status: r.status, firstName: r.first_name, lastName: r.last_name, phoneMasked: maskPhone(r.phone_e164) };
}

function cleanName(v: string | undefined | null, field: string, required: boolean): string | null {
  const s = (v ?? '').trim().replace(/\s+/g, ' ');
  if (s === '') {
    if (required) throw new AppError('VALIDATION_FAILED', 400, 'Нужно имя', { field });
    return null;
  }
  if (s.length > 100) throw new AppError('VALIDATION_FAILED', 400, 'Слишком длинное имя', { field });
  return s;
}

export function creatorOf(meta: AuditRequestMeta): { type: 'staff' | 'client' | 'system'; id: string | null } {
  if (meta.actor.kind === 'staff') return { type: 'staff', id: meta.actor.staffId };
  if (meta.actor.kind === 'client') return { type: 'client', id: meta.actor.clientId };
  return { type: 'system', id: null };
}

// ---- бронь без профиля

/** Найти по телефону или создать карточку 'guest' (01 §10.2, Q-09). Существующая карточка не переписывается;
 *  имя заполняется, только если было пустым. Параллельные вызовы с одним телефоном дают одну строку (UNIQUE). */
export async function findOrCreateGuest(
  tx: Tx,
  input: { phone: string; firstName: string; lastName?: string },
  meta: AuditRequestMeta,
  clock: Clock = systemClock,
): Promise<ClientRef> {
  const phone = normalizePhone(input.phone);
  const firstName = cleanName(input.firstName, 'firstName', true);
  const lastName = cleanName(input.lastName, 'lastName', false);
  const now = clock.now();
  const by = creatorOf(meta);
  const inserted = await tx.query<ClientRow>(
    `INSERT INTO app.clients AS c (phone_e164, first_name, last_name, status, registration_source, created_at, created_by_type, created_by_id)
     VALUES ($1, $2, $3, 'guest', $4, $5, $6, $7)
     ON CONFLICT (phone_e164) DO NOTHING
     RETURNING ${REF_COLS}`,
    [phone, firstName, lastName, meta.source === 'crm' ? 'crm' : 'site', now, by.type, by.id],
  );
  if (inserted.rows[0]) {
    const row = inserted.rows[0];
    await writeAudit(
      tx,
      meta,
      { action: 'client.created', object: { type: 'client', id: row.id }, after: { status: 'guest', phoneE164: phone, firstName, lastName } },
      clock,
    );
    return toRef(row);
  }
  const cur = await tx.query<ClientRow>(`SELECT ${REF_COLS} FROM app.clients c WHERE c.phone_e164 = $1 FOR UPDATE`, [phone]);
  const row = cur.rows[0];
  if (!row) throw new Error('findOrCreateGuest: карточка с телефоном пропала между вставкой и чтением');
  const fill: Record<string, string> = {};
  if (row.first_name === null && firstName !== null) fill.firstName = firstName;
  if (row.last_name === null && lastName !== null) fill.lastName = lastName;
  if (Object.keys(fill).length === 0) return toRef(row);
  const upd = await tx.query<ClientRow>(
    `UPDATE app.clients c SET first_name = coalesce(c.first_name, $2), last_name = coalesce(c.last_name, $3),
       row_version = c.row_version + 1
     WHERE c.id = $1 RETURNING ${REF_COLS}`,
    [row.id, fill.firstName ?? null, fill.lastName ?? null],
  );
  await writeAudit(
    tx,
    meta,
    {
      action: 'client.updated',
      object: { type: 'client', id: row.id },
      before: Object.fromEntries(Object.keys(fill).map((k) => [k, null])),
      after: fill,
    },
    clock,
  );
  return toRef(upd.rows[0]!);
}

/** Можно ли клиенту бронировать (K5 confirm, S1-13). blocked / restricted (пока не истёк срок) /
 *  deletion_requested / anonymized → CLIENT_RESTRICTED. С Э2 loyalty добавит проверку баланса сюда же. */
export async function assertCanBook(tx: Tx, clientId: string, at: Date): Promise<void> {
  const r = await tx.query<{ status: ClientStatus; status_until: Date | null }>(
    'SELECT status, status_until FROM app.clients WHERE id = $1',
    [clientId],
  );
  const row = r.rows[0];
  if (!row) throw new AppError('NOT_FOUND', 404, 'Не найдено');
  const ok =
    row.status === 'active' ||
    row.status === 'guest' ||
    (row.status === 'restricted' && row.status_until !== null && row.status_until <= at);
  if (!ok) throw new AppError('CLIENT_RESTRICTED', 403, 'Запись для этого клиента ограничена', { status: row.status });
}

/** Для уведомлений (П7). Нет строки – значения по умолчанию (напоминания вкл., реклама выкл., 09 §5.1). */
export async function getNotificationPrefs(db: Db, clientId: string): Promise<{ remindersEnabled: boolean; marketingEnabled: boolean }> {
  const r = await db.query<{ reminders_enabled: boolean; marketing_enabled: boolean }>(
    'SELECT reminders_enabled, marketing_enabled FROM app.client_notification_prefs WHERE client_id = $1',
    [clientId],
  );
  const row = r.rows[0];
  return { remindersEnabled: row?.reminders_enabled ?? true, marketingEnabled: row?.marketing_enabled ?? false };
}

// ---- поиск в CRM (03 §14)

/** Связь клиента с филиалами (брони). Таблицы броней – модуль booking (S1-07): он и даёт реализацию. */
export interface ClientBranchLinks {
  /** SQL-условие: у клиента (столбец clientIdColumn) есть бронь в филиалах параметра branchIdsParam (uuid[]). */
  existsSql(clientIdColumn: string, branchIdsParam: string): string;
}
/** До S1-07 броней нет – связи нет ни у кого: не-Владелец находит только по точному телефону. */
export const noBranchLinks: ClientBranchLinks = {
  // Параметр упомянут, чтобы Postgres вывел его тип (иначе «could not determine data type»).
  existsSql: (_col, param) => `(FALSE AND ${param} IS NOT NULL)`,
};

export interface Cursor {
  cursor?: string | undefined;
  limit?: number | undefined;
}
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
export type ClientSearchRow = ClientRef & { lastVisitAt: Date | null; lastBranchId: string | null };

type Match =
  | { kind: 'all' }
  | { kind: 'id'; id: string }
  | { kind: 'phone'; e164: string }
  | { kind: 'last4'; digits: string }
  | { kind: 'phonePart'; digits: string }
  | { kind: 'email'; email: string }
  | { kind: 'name'; words: string[] };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PHONE_LIKE_RE = /^[+\d\s().-]+$/;

function parseQuery(text: string): Match {
  const t = text.trim();
  if (t.length > 100) throw new AppError('VALIDATION_FAILED', 400, 'Слишком длинный запрос', { field: 'q' });
  if (t === '') return { kind: 'all' };
  if (UUID_RE.test(t)) return { kind: 'id', id: t.toLowerCase() };
  if (PHONE_LIKE_RE.test(t)) {
    const digits = t.replace(/\D/g, '');
    if (digits.length < 4) throw new AppError('VALIDATION_FAILED', 400, 'Для поиска по телефону нужно от 4 цифр', { field: 'q' });
    if (digits.length === 4) return { kind: 'last4', digits };
    try {
      return { kind: 'phone', e164: normalizePhone(t) };
    } catch {
      return { kind: 'phonePart', digits };
    }
  }
  if (t.includes('@')) return { kind: 'email', email: t.toLowerCase() };
  const words = t.toLowerCase().split(/\s+/).slice(0, 3);
  return { kind: 'name', words };
}

const likePrefix = (w: string) => `${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

function matchSql(m: Match, params: unknown[]): string {
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  switch (m.kind) {
    case 'all':
      return 'TRUE';
    case 'id':
      return `c.id = ${p(m.id)}::uuid`;
    case 'phone':
      return `c.phone_e164 = ${p(m.e164)}`;
    case 'last4':
      return `right(c.phone_e164, 4) = ${p(m.digits)}`;
    case 'phonePart':
      return `c.phone_e164 LIKE ${p(`%${m.digits}%`)}`;
    case 'email':
      return `c.email = ${p(m.email)}`;
    case 'name':
      return m.words
        .map((w) => {
          const x = p(likePrefix(w));
          return `(lower(c.last_name) LIKE ${x} OR lower(c.first_name) LIKE ${x})`;
        })
        .join(' AND ');
  }
}

function encodeCursor(row: { ln: string; fn: string; id: string }): string {
  return Buffer.from(JSON.stringify([row.ln, row.fn, row.id])).toString('base64url');
}

function decodeCursor(s: string): [string, string, string] {
  try {
    const v: unknown = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
    if (Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'string') && UUID_RE.test(v[2] as string)) {
      return v as [string, string, string];
    }
  } catch {
    // ниже
  }
  throw new AppError('VALIDATION_FAILED', 400, 'Неверный курсор', { field: 'cursor' });
}

/** Поиск в CRM (03 §14): телефон (точно, по последним 4 цифрам, по части), ФИО (начало слов), email, id.
 *  Фильтр зоны – в SQL (K1 scopeFilter 'client.view.basic'). Обезличенные – только по явному фильтру статуса.
 *  Порядок – фамилия, имя, id; курсор стабилен. lastVisitAt/lastBranchId – после модуля visits (S1-10). */
export async function searchClients(
  db: Db,
  ctx: AccessContext,
  q: { text: string; branchId?: string | undefined; status?: ClientStatus[] | undefined },
  page: Cursor = {},
  links: ClientBranchLinks = noBranchLinks,
): Promise<Page<ClientSearchRow>> {
  const scope = scopeFilter(ctx, 'client.view.basic');
  if (scope.kind === 'none') return { items: [], nextCursor: null };
  const match = parseQuery(q.text);
  const limit = Math.min(Math.max(Math.trunc(page.limit ?? 50), 1), 100);
  const params: unknown[] = [];
  const where: string[] = [matchSql(match, params)];

  if (scope.kind === 'branches' && match.kind !== 'phone') {
    params.push(scope.branchIds);
    where.push(links.existsSql('c.id', `$${params.length}::uuid[]`));
  }
  if (q.branchId !== undefined) {
    if (scope.kind === 'branches' && !scope.branchIds.includes(q.branchId)) throw new AppError('NOT_FOUND', 404, 'Не найдено');
    params.push([q.branchId]);
    where.push(links.existsSql('c.id', `$${params.length}::uuid[]`));
  }
  if (q.status && q.status.length > 0) {
    params.push(q.status);
    where.push(`c.status = ANY($${params.length}::text[])`);
  } else {
    where.push("c.status <> 'anonymized'");
  }
  if (page.cursor) {
    const [ln, fn, id] = decodeCursor(page.cursor);
    params.push(ln, fn, id);
    const n = params.length;
    where.push(`(lower(coalesce(c.last_name, '')), lower(coalesce(c.first_name, '')), c.id) > ($${n - 2}, $${n - 1}, $${n}::uuid)`);
  }
  params.push(limit + 1);
  const r = await db.query<ClientRow & { ln: string; fn: string }>(
    `SELECT ${REF_COLS}, lower(coalesce(c.last_name, '')) AS ln, lower(coalesce(c.first_name, '')) AS fn
     FROM app.clients c
     WHERE ${where.join(' AND ')}
     ORDER BY lower(coalesce(c.last_name, '')), lower(coalesce(c.first_name, '')), c.id
     LIMIT $${params.length}`,
    params,
  );
  const rows = r.rows.slice(0, limit);
  const last = rows.at(-1);
  return {
    items: rows.map((row) => ({ ...toRef(row), lastVisitAt: null, lastBranchId: null })),
    nextCursor: r.rows.length > limit && last ? encodeCursor(last) : null,
  };
}

// ---- карточка в CRM (K11 №16)

export interface ClientCard extends ClientRef {
  isGuest: boolean;
  phoneVerified: boolean;
  registeredAt: Date | null;
  /** Только с правом client.view.full (Владелец, Директор в зоне). Администратору – null (04 §8.3). */
  full: {
    phoneE164: string | null;
    email: string | null;
    birthDate: string | null;
    statusReason: string | null;
    statusUntil: Date | null;
    registrationSource: string | null;
    createdAt: Date;
    lastLoginAt: Date | null;
  } | null;
  rowVersion: number;
}

/** Карточка: не-Владельцу – только клиент, связанный с его зоной (иначе NOT_FOUND, как несуществующий). */
export async function getClientCard(
  db: Db,
  ctx: AccessContext,
  clientId: string,
  links: ClientBranchLinks = noBranchLinks,
): Promise<ClientCard> {
  const notFound = () => new AppError('NOT_FOUND', 404, 'Не найдено');
  const scope = scopeFilter(ctx, 'client.view.basic');
  if (scope.kind === 'none' || !UUID_RE.test(clientId)) throw notFound();
  const params: unknown[] = [clientId];
  let visible = 'TRUE';
  if (scope.kind === 'branches') {
    params.push(scope.branchIds);
    visible = links.existsSql('c.id', '$2::uuid[]');
  }
  const r = await db.query<
    ClientRow & {
      phone_verified_at: Date | null;
      registered_at: Date | null;
      email: string | null;
      birth_date: string | null;
      status_reason: string | null;
      status_until: Date | null;
      registration_source: string | null;
      created_at: Date;
      last_login_at: Date | null;
      row_version: number;
    }
  >(
    `SELECT ${REF_COLS}, c.phone_verified_at, c.registered_at, c.email, to_char(c.birth_date, 'YYYY-MM-DD') AS birth_date,
            c.status_reason, c.status_until, c.registration_source, c.created_at, c.last_login_at, c.row_version
     FROM app.clients c WHERE c.id = $1::uuid AND ${visible}`,
    params,
  );
  const row = r.rows[0];
  if (!row) throw notFound();
  const full = roleAllows(ctx.role, 'client.view.full')
    ? {
        phoneE164: row.phone_e164,
        email: row.email,
        birthDate: row.birth_date,
        statusReason: row.status_reason,
        statusUntil: row.status_until,
        registrationSource: row.registration_source,
        createdAt: row.created_at,
        lastLoginAt: row.last_login_at,
      }
    : null;
  return {
    ...toRef(row),
    isGuest: row.status === 'guest',
    phoneVerified: row.phone_verified_at !== null,
    registeredAt: row.registered_at,
    full,
    rowVersion: row.row_version,
  };
}

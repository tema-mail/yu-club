// K7. Настройки с наследованием и датами: system (код) → network → city → branch (15 §3).
// Таблица – 0009_settings.sql. Более конкретный уровень перекрывает общий, если уровень разрешён для ключа.
// Цепочка фиксирована (филиал → его город → сеть), поэтому циклическое наследование невозможно по построению.
// Шаг слота и часы работы – не настройки (K7): dict_resource_types.step_minutes и branch_weekly_hours.
import { z } from 'zod';
import { writeAudit, type AuditRequestMeta, type Db, type Tx } from './audit.ts';
import { AppError, type HttpStatus } from './errors.ts';
import { assertCan, type AccessContext, type Action, type Target } from './permissions.ts';
import { systemClock, type Clock } from './time.ts';

// ---- реестры ядра для core/registry.ts (ADR 0002)

export const settingsErrors = {
  SETTING_INVALID: 422, // значение вне схемы/пределов (details.issues)
  SETTING_LEVEL_NOT_ALLOWED: 422, // уровень не разрешён для ключа
  SETTING_PERIOD_OVERLAP: 409, // пересечение дат на том же уровне (details.conflictValueId)
} as const satisfies Record<string, HttpStatus>;
export const settingsAudit = ['setting.changed', 'setting.reset_to_inherited'] as const;

export type SettingLevel = 'system' | 'network' | 'city' | 'branch';
export type SettingScope = { network: true } | { cityId: string } | { branchId: string };
type StoredLevel = Exclude<SettingLevel, 'system'>;

export interface SettingDef<T> {
  schema: z.ZodType<T>;
  systemDefault: T;
  levels: readonly StoredLevel[];
  editAction: Action;
  affectsExisting: false;
}

const int = (min: number, max: number) => z.number().int().min(min).max(max);
const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'время HH:mm');
const NB = ['network', 'branch'] as const;
const N = ['network'] as const;
const BRANCH = 'settings.branch.manage' as const;
const NET = 'settings.network.manage' as const;

function def<T>(schema: z.ZodType<T>, systemDefault: T, levels: readonly StoredLevel[], editAction: Action): SettingDef<T> {
  return { schema, systemDefault, levels, editAction, affectsExisting: false };
}

/** Реестр ключей Э0–Э1 (K7 §Реестр). Новый ключ = строка K7 + запись здесь. */
export const SETTINGS = {
  'booking.window_default_days': def(int(1, 30), 7, NB, BRANCH),
  'booking.window_max_days': def(int(1, 90), 30, NB, BRANCH),
  'booking.hold_minutes': def(int(5, 60), 15, N, NET),
  'booking.buffer_minutes': def(int(0, 60), 0, NB, BRANCH),
  'booking.max_hold_items': def(int(1, 20), 10, N, NET),
  'booking.max_anonymous_holds_per_branch': def(int(0, 500), 30, NB, BRANCH),
  'booking.client_cancel_enabled': def(z.boolean(), true, N, NET),
  'notifications.reminder_day_before_time': def(HHMM, '21:00', N, NET),
  'notifications.reminder_before_minutes': def(int(5, 120), 15, N, NET),
  'notifications.push_retry_limit': def(int(0, 5), 3, N, NET),
  'staff.session_idle_minutes': def(int(15, 1440), 480, N, NET),
  'staff.session_absolute_hours': def(int(1, 720), 72, N, NET),
  'staff.login_max_failures': def(int(3, 20), 10, N, NET),
  'staff.login_lock_minutes': def(int(1, 60), 15, N, NET),
  'client.otp_ttl_seconds': def(int(60, 900), 300, N, NET),
  'client.otp_max_attempts': def(int(3, 10), 5, N, NET),
  'client.otp_resend_cooldown_seconds': def(int(30, 600), 60, N, NET),
  'client.otp_max_per_phone_per_hour': def(int(1, 20), 5, N, NET),
  'client.session_days': def(int(1, 365), 30, N, NET),
  'branch.default_hours': def(
    z.object({ open: HHMM, close: HHMM }).refine((h) => h.close > h.open, 'close позже open, без полуночи'),
    { open: '10:00', close: '22:00' },
    ['network', 'city'],
    NET,
  ),
} as const;

export type SettingKey = keyof typeof SETTINGS;
export type SettingValue<K extends SettingKey> = (typeof SETTINGS)[K] extends SettingDef<infer T> ? T : never;

export interface Resolved<T> {
  value: T;
  source: { level: SettingLevel; valueId: string | null; validFrom: Date | null };
}

/** Определение ключа. Неизвестный ключ – ошибка программиста (throw), не AppError (K7). */
export function settingDef(key: string): SettingDef<unknown> {
  const d = (SETTINGS as Record<string, SettingDef<unknown>>)[key];
  if (!d) throw new Error(`settings: неизвестный ключ ${key}`);
  return d;
}

const RANK: Record<StoredLevel, number> = { branch: 3, city: 2, network: 1 };

interface ValueRow {
  id: string;
  key: string;
  level: StoredLevel;
  value: unknown;
  valid_from: Date;
  valid_to: Date | null;
}

/** Условие цепочки области: для филиала – филиал, его город и сеть; для города – город и сеть; сеть – сеть. */
export function chainSql(scope: SettingScope, params: unknown[]): string {
  if ('network' in scope) return `level = 'network'`;
  if ('cityId' in scope) {
    params.push(scope.cityId);
    return `(level = 'network' OR (level = 'city' AND city_id = $${params.length}::uuid))`;
  }
  params.push(scope.branchId);
  const n = params.length;
  return `(level = 'network' OR (level = 'branch' AND branch_id = $${n}::uuid)
    OR (level = 'city' AND city_id = (SELECT city_id FROM app.branches WHERE id = $${n}::uuid)))`;
}

/** Пакетно: один запрос на набор ключей (K7 resolveSettings). */
export async function resolveSettings<K extends SettingKey>(
  db: Db | Tx,
  keys: readonly K[],
  scope: SettingScope,
  at: Date,
): Promise<{ [P in K]: Resolved<SettingValue<P>> }> {
  const defs = new Map(keys.map((k) => [k, settingDef(k)]));
  const params: unknown[] = [[...defs.keys()], at];
  const r = await db.query<ValueRow>(
    `SELECT id, key, level, value, valid_from, valid_to FROM app.settings_values
     WHERE key = ANY($1::text[]) AND valid_from <= $2 AND (valid_to IS NULL OR valid_to > $2) AND ${chainSql(scope, params)}`,
    params,
  );
  const out: Record<string, Resolved<unknown>> = {};
  for (const [key, d] of defs) {
    let best: ValueRow | undefined;
    for (const row of r.rows) {
      if (row.key !== key || !d.levels.includes(row.level)) continue; // уровень не разрешён – не перекрывает (15 §3.3)
      if (!best || RANK[row.level] > RANK[best.level]) best = row;
    }
    out[key] = best
      ? { value: best.value, source: { level: best.level, valueId: best.id, validFrom: best.valid_from } }
      : { value: d.systemDefault, source: { level: 'system', valueId: null, validFrom: null } };
  }
  return out as { [P in K]: Resolved<SettingValue<P>> };
}

/** Значение на момент `at` для области: branch → city (город филиала) → network → system. */
export async function resolveSetting<K extends SettingKey>(db: Db | Tx, key: K, scope: SettingScope, at: Date): Promise<Resolved<SettingValue<K>>> {
  const r = await resolveSettings(db, [key], scope, at);
  return r[key];
}

/** История значений ключа по цепочке области, новые сверху (CRM «на дату»). */
export async function settingHistory(
  db: Db,
  key: SettingKey,
  scope: SettingScope,
): Promise<Array<{ valueId: string; level: SettingLevel; value: unknown; validFrom: Date; validTo: Date | null; createdBy: string; reason: string | null }>> {
  settingDef(key);
  const params: unknown[] = [key];
  const r = await db.query<ValueRow & { created_by: string; reason: string | null }>(
    `SELECT id, key, level, value, valid_from, valid_to, created_by, reason FROM app.settings_values
     WHERE key = $1 AND ${chainSql(scope, params)} ORDER BY valid_from DESC, level`,
    params,
  );
  return r.rows.map((x) => ({
    valueId: x.id,
    level: x.level,
    value: x.value,
    validFrom: x.valid_from,
    validTo: x.valid_to,
    createdBy: x.created_by,
    reason: x.reason,
  }));
}

// ---- изменение (K7 setSetting / resetToInherited)

function levelOf(scope: SettingScope): StoredLevel {
  return 'network' in scope ? 'network' : 'cityId' in scope ? 'city' : 'branch';
}

/** Проверки до сохранения: уровень разрешён, право в зоне, область существует. */
async function prepare(tx: Tx, ctx: AccessContext, key: SettingKey, scope: SettingScope): Promise<{ d: SettingDef<unknown>; level: StoredLevel; scopeId: string | null }> {
  const d = settingDef(key);
  const level = levelOf(scope);
  if (!d.levels.includes(level)) {
    throw new AppError('SETTING_LEVEL_NOT_ALLOWED', 422, 'Для этой настройки такой уровень не предусмотрен', { key, level, allowed: d.levels });
  }
  assertCan(ctx, d.editAction, scope as Target);
  const scopeId = 'network' in scope ? null : 'cityId' in scope ? scope.cityId : scope.branchId;
  if (scopeId !== null) {
    const table = level === 'city' ? 'app.cities' : 'app.branches';
    const ok = /^[0-9a-f-]{36}$/i.test(scopeId) && (await tx.query(`SELECT 1 FROM ${table} WHERE id = $1`, [scopeId])).rowCount === 1;
    if (!ok) throw new AppError('NOT_FOUND', 404, 'Не найдено');
  }
  return { d, level, scopeId };
}

interface OwnRow {
  id: string;
  value: unknown;
  valid_from: Date;
  valid_to: Date | null;
}

/** Строки ключа на своём уровне своей области, действующие на `at` или позже – под блокировкой. */
async function ownRows(tx: Tx, key: SettingKey, level: StoredLevel, scopeId: string | null, at: Date): Promise<OwnRow[]> {
  const r = await tx.query<OwnRow>(
    `SELECT id, value, valid_from, valid_to FROM app.settings_values
     WHERE key = $1 AND level = $2 AND coalesce(city_id, branch_id) IS NOT DISTINCT FROM $3::uuid
       AND (valid_to IS NULL OR valid_to > $4) ORDER BY valid_from FOR UPDATE`,
    [key, level, scopeId, at],
  );
  return r.rows;
}

function overlap(conflictValueId: string): AppError {
  return new AppError('SETTING_PERIOD_OVERLAP', 409, 'На эти даты уже есть значение этого уровня', { conflictValueId });
}

function notPast(at: Date, clock: Clock, field: string): void {
  if (at.getTime() < clock.now().getTime()) {
    throw new AppError('VALIDATION_FAILED', 400, 'Дата в прошлом: история настроек не переписывается', { field });
  }
}

const scopeCols = (level: StoredLevel, scopeId: string | null) => ({
  cityId: level === 'city' ? scopeId : null,
  branchId: level === 'branch' ? scopeId : null,
});

/** Установить значение с даты: закрыть текущую строку того же уровня (valid_to = validFrom) и вставить новую.
 *  Будущая строка того же уровня – SETTING_PERIOD_OVERLAP до сохранения. Аудит setting.changed. */
export async function setSetting<K extends SettingKey>(
  tx: Tx,
  ctx: AccessContext,
  input: { key: K; scope: SettingScope; value: SettingValue<K>; validFrom: Date; reason?: string },
  meta: AuditRequestMeta,
  clock: Clock = systemClock,
): Promise<{ valueId: string }> {
  const { d, level, scopeId } = await prepare(tx, ctx, input.key, input.scope);
  const parsed = d.schema.safeParse(input.value);
  if (!parsed.success) {
    throw new AppError('SETTING_INVALID', 422, 'Значение настройки вне допустимого', {
      key: input.key,
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  notPast(input.validFrom, clock, 'validFrom');
  await assertWindowPair(tx, input.key, input.scope, parsed.data, input.validFrom);
  const rows = await ownRows(tx, input.key, level, scopeId, input.validFrom);
  const current = rows.find((r) => r.valid_from.getTime() < input.validFrom.getTime());
  const conflict = rows.find((r) => r !== current);
  if (conflict) throw overlap(conflict.id);
  const before = await resolveSetting(tx, input.key, input.scope, input.validFrom);
  if (current) await tx.query('UPDATE app.settings_values SET valid_to = $2 WHERE id = $1', [current.id, input.validFrom]);
  const cols = scopeCols(level, scopeId);
  const ins = await tx
    .query<{ id: string }>(
      `INSERT INTO app.settings_values (key, level, city_id, branch_id, value, valid_from, reason, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [input.key, level, cols.cityId, cols.branchId, JSON.stringify(parsed.data), input.validFrom, input.reason ?? null, ctx.actor.staffId],
    )
    .catch((err: { code?: string }) => {
      if (err.code === '23P01') throw overlap(current?.id ?? 'unknown');
      throw err;
    });
  const valueId = ins.rows[0]!.id;
  await writeAudit(
    tx,
    meta,
    {
      action: 'setting.changed',
      object: { type: 'setting', id: valueId },
      ...cols,
      before: { key: input.key, value: before.value, level: before.source.level },
      after: { key: input.key, value: parsed.data, level, validFrom: input.validFrom },
      reason: input.reason ?? null,
    },
    clock,
  );
  return { valueId };
}

/** Окно записи: максимум не меньше окна по умолчанию в той же области на ту же дату (K7 «≥ default»). */
async function assertWindowPair(tx: Tx, key: SettingKey, scope: SettingScope, value: unknown, at: Date): Promise<void> {
  if (key !== 'booking.window_default_days' && key !== 'booking.window_max_days') return;
  const other = key === 'booking.window_default_days' ? 'booking.window_max_days' : 'booking.window_default_days';
  const o = (await resolveSetting(tx, other, scope, at)).value;
  const [def, max] = key === 'booking.window_default_days' ? [value as number, o] : [o, value as number];
  if (max < def) {
    throw new AppError('SETTING_INVALID', 422, 'Максимальное окно записи меньше окна по умолчанию', {
      key,
      issues: [{ path: '', message: `window_max_days (${max}) < window_default_days (${def})` }],
    });
  }
}

/** Вернуть к наследованию: закрыть локальное значение (valid_to = at). Строка остаётся в истории (15 §3.3).
 *  Локального значения нет – ничего не делает. Запланированное на будущее – SETTING_PERIOD_OVERLAP. */
export async function resetToInherited(
  tx: Tx,
  ctx: AccessContext,
  input: { key: SettingKey; scope: SettingScope; at: Date; reason?: string },
  meta: AuditRequestMeta,
  clock: Clock = systemClock,
): Promise<void> {
  const { level, scopeId } = await prepare(tx, ctx, input.key, input.scope);
  notPast(input.at, clock, 'at');
  const rows = await ownRows(tx, input.key, level, scopeId, input.at);
  const current = rows.find((r) => r.valid_from.getTime() < input.at.getTime());
  const future = rows.find((r) => r !== current);
  if (future) throw overlap(future.id);
  if (!current) return;
  await tx.query('UPDATE app.settings_values SET valid_to = $2 WHERE id = $1', [current.id, input.at]);
  const inherited = await resolveSetting(tx, input.key, input.scope, input.at);
  await writeAudit(
    tx,
    meta,
    {
      action: 'setting.reset_to_inherited',
      object: { type: 'setting', id: current.id },
      ...scopeCols(level, scopeId),
      before: { key: input.key, value: current.value, level },
      after: { key: input.key, value: inherited.value, level: inherited.source.level },
      reason: input.reason ?? null,
    },
    clock,
  );
}

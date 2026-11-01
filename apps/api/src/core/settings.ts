// K7. Настройки с наследованием и датами: system (код) → network → city → branch (15 §3).
// Таблица – 0009_settings.sql. Более конкретный уровень перекрывает общий, если уровень разрешён для ключа.
// Цепочка фиксирована (филиал → его город → сеть), поэтому циклическое наследование невозможно по построению.
// Шаг слота и часы работы – не настройки (K7): dict_resource_types.step_minutes и branch_weekly_hours.
import { z } from 'zod';
import type { Db, Tx } from './audit.ts';
import type { Action } from './permissions.ts';

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

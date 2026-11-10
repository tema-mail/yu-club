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
/** Свободный текст до `max` знаков; пустая строка – «не задано» (ключ без null: сайт и CRM проверяют на пустоту). */
const text = (max: number) => z.string().max(max);
const NB = ['network', 'branch'] as const;
const N = ['network'] as const;
const BRANCH = 'settings.branch.manage' as const;
const NET = 'settings.network.manage' as const;

function def<T>(schema: z.ZodType<T>, systemDefault: T, levels: readonly StoredLevel[], editAction: Action): SettingDef<T> {
  return { schema, systemDefault, levels, editAction, affectsExisting: false };
}

/** Реестр ключей Э0–Э3 (K7 §Реестр, «Реестр ключей Э2», «Реестр ключей Э3»). Новый ключ = строка K7 + запись здесь. */
export const SETTINGS = {
  'booking.window_default_days': def(int(1, 30), 7, NB, BRANCH),
  'booking.window_max_days': def(int(1, 90), 30, NB, BRANCH),
  'booking.hold_minutes': def(int(5, 60), 15, N, NET),
  'booking.buffer_minutes': def(int(0, 60), 0, NB, BRANCH),
  'booking.max_hold_items': def(int(1, 20), 10, N, NET),
  'booking.max_anonymous_holds_per_branch': def(int(0, 500), 30, NB, BRANCH),
  'booking.client_cancel_enabled': def(z.boolean(), true, N, NET),
  'visit.arrive_early_min': def(int(0, 1440), 30, ['network', 'city', 'branch'], BRANCH), // Q-101: приход не раньше чем за N мин
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
  // ---- Э2 (K7 «Реестр ключей Э2»; K10 §2, K15 §13, K17 §12). Менять – только Владелец (решение D2-02).
  'payment.certificate_topup_enabled': def(z.boolean(), false, N, NET), // Q-24 / R-03
  'finance.negative_balance_allowed': def(z.boolean(), false, NB, NET), // Q-28
  'finance.cash_shift_enabled': def(z.boolean(), false, NB, NET), // Q-22
  'certificate.sale_methods': def(
    z.array(z.enum(['cash', 'card', 'transfer'])).min(1).refine((a) => new Set(a).size === a.length, 'без повторов'),
    ['cash', 'card', 'transfer'] as ('cash' | 'card' | 'transfer')[],
    N,
    NET,
  ), // Q-26
  'certificate.nominal_min_kop': def(int(1, 100_000_000).nullable(), null as number | null, N, NET), // 08 §4.5
  'certificate.nominal_max_kop': def(int(1, 100_000_000).nullable(), null as number | null, N, NET),
  'loyalty.batch_ttl_days': def(int(1, 3650).nullable(), null as number | null, N, NET), // Q-43 / R-05: бессрочно
  'loyalty.penalty_scope': def(z.enum(['visit', 'booking']), 'visit' as 'visit' | 'booking', N, NET), // Q-44 / R-07
  // null – штрафы выключены до даты запуска Э2, её ставит Владелец (решение D2-03, план 4.3 п.10)
  'loyalty.penalties_from': def(z.iso.datetime().nullable(), null as string | null, N, NET),
  'loyalty.points_resource_types': def(
    z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).refine((a) => new Set(a).size === a.length, 'без повторов'),
    ['pc', 'vr_seat', 'ps_room'] as string[],
    N,
    NET,
  ), // Q-42: комната целиком баллами не оплачивается
  'loyalty.accrue_for_points': def(z.boolean(), false, N, NET), // Q-40 / R-06
  'loyalty.accrue_for_certificate': def(z.boolean(), true, N, NET),
  // ---- Э3 (K7 «Реестр ключей Э3»; K18 §16, K19 §16, K20 §17). Только сеть, менять – только Владелец (D3-01).
  'shift.min_minutes': def(int(15, 720).nullable(), null as number | null, N, NET), // 05 §5.5: без минимума
  'shift.self_edit_deadline_hours': def(int(0, 168), 24, N, NET), // Q-65
  'shift.checkin_early_minutes': def(int(0, 240), 30, N, NET), // Q-110
  'shift.review_grace_minutes': def(int(0, 720), 60, N, NET),
  'payroll.attendance_fee_min_minutes': def(int(0, 720), 120, N, NET), // Q-61
  'payroll.bonus_enabled': def(z.boolean(), false, N, NET), // Q-107
  'payroll.penalties_enabled': def(z.boolean(), false, N, NET), // Q-121, Q-153
  'payroll.negative_carry': def(z.enum(['carry', 'write_off']), 'carry' as 'carry' | 'write_off', N, NET), // Q-154
  'payroll.period_kind': def(z.enum(['month', 'half_month', 'week']), 'month' as 'month' | 'half_month' | 'week', N, NET), // Q-62
  'equipment.critical_auto_block': def(z.boolean(), false, N, NET), // Q-111
  'equipment.critical_block_hours': def(int(1, 720), 24, N, NET),
  'repair.approval_threshold_kop': def(int(0, 100_000_000).nullable(), 1_000_000 as number | null, N, NET), // Q-52: null – без согласования
  'attachments.max_bytes': def(int(1, 52_428_800), 10_485_760, N, NET), // Q-96
  'attachments.mime_types': def(
    z.array(z.enum(['image/jpeg', 'image/png', 'application/pdf'])).min(1).refine((a) => new Set(a).size === a.length, 'без повторов'),
    ['image/jpeg', 'image/png', 'application/pdf'] as ('image/jpeg' | 'image/png' | 'application/pdf')[],
    N,
    NET,
  ), // Q-96: только типы, которые core/files.ts распознаёт по сигнатуре
  'event.party.min_minutes': def(int(30, 720), 120, N, NET), // 20 §4.10 (R-22)
  'event.party.max_guests': def(int(1, 100), 10, N, NET),
  'event.party.price_confirmed': def(z.boolean(), false, N, NET), // R-11 / Q-70
  'event.prepayment_required': def(z.boolean(), false, N, NET), // Q-74, зарезервирован
  'event.requests_enabled': def(z.boolean(), true, N, NET),
  'event.request_hold_hours': def(int(1, 336), 48, N, NET),
  'event.request_hold_remind_hours': def(int(0, 168), 24, N, NET),
  'gift.valid_days': def(int(1, 365), 60, N, NET), // 11 §9.1
  'gift.room_minutes': def(int(30, 120), 40, N, NET),
  'gift.start_align_minutes': def(int(5, 60), 15, N, NET), // Q-118
  'gift.per_client_days': def(int(1, 3650), 365, N, NET), // R-09 / Q-71: копия в EXCLUDE 0309
  'gift.no_show_returns': def(z.boolean(), true, N, NET), // Q-114
  // ---- Э4 (K7 «Реестр ключей Э4»; K21 §13, K22 §15, K24 §11). Только сеть, меняет Владелец (D4-01).
  'notifications.marketing_min_interval_hours': def(int(0, 720), 168, N, NET), // Q-39
  'notifications.marketing_window_from': def(HHMM, '10:00', N, NET), // Q-39; from < to проверяет сохранение (assertMarketingWindowPair)
  'notifications.marketing_window_to': def(HHMM, '21:00', N, NET),
  'notifications.inbox_retention_days': def(int(30, 1095), 365, N, NET), // Q-132
  'notifications.campaign_max_plan_days': def(int(0, 90), 30, N, NET), // Q-133
  'notifications.marketing_title_prefix': def(z.string().max(20), 'Реклама.', N, NET), // Q-130
  'notifications.marketing_require_erid': def(z.boolean(), true, N, NET), // Q-130, Q-148
  'content.ended_promotion_mode': def(
    z.enum(['banner_noindex', 'not_found']),
    'banner_noindex' as 'banner_noindex' | 'not_found',
    N,
    NET,
  ), // вопрос карты сайта 9
  'reports.interactive_max_days': def(int(7, 366), 92, N, NET),
  'reports.export_ttl_hours': def(int(1, 168), 24, N, NET), // Q-145
  'reports.loyalty_threshold_warn_centi': def(int(-1_000_000, 0), -4500, N, NET), // Q-80; пределы – решение S4-00
  'reports.repeat_breakdown_days': def(int(7, 365), 90, N, NET),
  // ---- Реквизиты оператора (K7 «Реквизиты оператора»; карта сайта 3.3 и вопрос 12, 19 §4.10, 152-ФЗ ст. 18.1): один набор на сеть,
  // меняет Владелец. Пусто – сайт блок не показывает (выдуманных реквизитов нет, N-01). Те же ключи – оператор ПДн и адрес для юридических текстов.
  'legal.operator_name': def(text(200), '', N, NET), // юридическое лицо или ИП – оператор персональных данных
  'legal.inn': def(z.string().regex(/^(\d{10}|\d{12})?$/, 'ИНН – 10 или 12 цифр').max(12), '', N, NET),
  'legal.ogrn': def(z.string().regex(/^(\d{13}|\d{15})?$/, 'ОГРН – 13 цифр, ОГРНИП – 15').max(15), '', N, NET),
  'legal.address': def(text(300), '', N, NET), // юридический адрес
  'legal.phone': def(text(30), '', N, NET),
  'legal.email': def(z.string().regex(/^$|^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'адрес почты').max(120), '', N, NET),
  // ---- лента событий CRM (13 §11; S4-28/S4-97, D4-46): пороги таймерных событий staff-feed-events.ts (K7 «Лента событий CRM»).
  'notifications.feed_shift_unfilled_hours': def(int(1, 168), 24, N, NET), // пустая смена: за N часов до открытия филиала
  'notifications.feed_event_prepare_days': def(int(0, 30), 3, N, NET), // подготовка мероприятия: за N дней до начала; 0 – выключено
  'notifications.feed_warranty_days': def(int(1, 365), 30, N, NET), // окончание гарантии: за N дней до ends_on
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
  return savepoint(tx, async () => {
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
    await assertWindowPair(tx, input.key, input.scope, input.validFrom);
    await assertMarketingWindowPair(tx, input.key, input.scope, input.validFrom);
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
  });
}

const WINDOW_KEYS = ['booking.window_default_days', 'booking.window_max_days'] as const;

/** Окно записи (K7 «max ≥ default»): после записи – в той же транзакции под SAVEPOINT – проверяются
 *  действующие значения во всех затронутых областях (для сети – сеть и каждый филиал, ключи без уровня city)
 *  на дату изменения и на каждую дату начала/конца будущих строк обоих ключей. Нарушение – откат к SAVEPOINT
 *  и SETTING_INVALID: в базе ничего не остаётся, даже если вызывающий зафиксирует транзакцию. */
async function assertWindowPair(tx: Tx, key: SettingKey, scope: SettingScope, from: Date): Promise<void> {
  if (!(WINDOW_KEYS as readonly string[]).includes(key)) return;
  const scopes: SettingScope[] = [scope];
  if ('network' in scope) {
    const b = await tx.query<{ id: string }>('SELECT id FROM app.branches ORDER BY id');
    scopes.push(...b.rows.map((r) => ({ branchId: r.id })));
  }
  const pts = await tx.query<{ t: Date }>(
    `SELECT DISTINCT t FROM (SELECT valid_from AS t FROM app.settings_values WHERE key = ANY($1::text[])
       UNION SELECT valid_to FROM app.settings_values WHERE key = ANY($1::text[]) AND valid_to IS NOT NULL) x
     WHERE t > $2 ORDER BY t`,
    [WINDOW_KEYS, from],
  );
  const points = [from, ...pts.rows.map((r) => r.t)];
  for (const sc of scopes) {
    for (const at of points) {
      const r = await resolveSettings(tx, WINDOW_KEYS, sc, at);
      const def = r['booking.window_default_days'].value;
      const max = r['booking.window_max_days'].value;
      if (max < def) {
        throw new AppError('SETTING_INVALID', 422, 'Максимальное окно записи меньше окна по умолчанию', {
          key,
          scope: sc,
          at: at.toISOString(),
          issues: [{ path: '', message: `window_max_days (${max}) < window_default_days (${def})` }],
        });
      }
    }
  }
}

const MARKETING_WINDOW_KEYS = ['notifications.marketing_window_from', 'notifications.marketing_window_to'] as const;

/** Окно рекламы (K21 §13): from < to на дату изменения и на каждую дату будущих строк пары. Ночного окна через полночь нет:
 *  from ≥ to отключило бы тихие часы. Ключи только сетевые. Откат и SETTING_INVALID – как у assertWindowPair. */
async function assertMarketingWindowPair(tx: Tx, key: SettingKey, scope: SettingScope, from: Date): Promise<void> {
  if (!(MARKETING_WINDOW_KEYS as readonly string[]).includes(key)) return;
  const pts = await tx.query<{ t: Date }>(
    `SELECT DISTINCT t FROM (SELECT valid_from AS t FROM app.settings_values WHERE key = ANY($1::text[])
       UNION SELECT valid_to FROM app.settings_values WHERE key = ANY($1::text[]) AND valid_to IS NOT NULL) x
     WHERE t > $2 ORDER BY t`,
    [MARKETING_WINDOW_KEYS, from],
  );
  for (const at of [from, ...pts.rows.map((r) => r.t)]) {
    const r = await resolveSettings(tx, MARKETING_WINDOW_KEYS, scope, at);
    const start = r['notifications.marketing_window_from'].value;
    const end = r['notifications.marketing_window_to'].value;
    if (start >= end) {
      throw new AppError('SETTING_INVALID', 422, 'Начало окна рекламы должно быть раньше конца', {
        key,
        at: at.toISOString(),
        issues: [{ path: '', message: `marketing_window_from (${start}) >= marketing_window_to (${end})` }],
      });
    }
  }
}

/** Запись под SAVEPOINT: исключение – откат только этих изменений и проброс. */
async function savepoint<T>(tx: Tx, fn: () => Promise<T>): Promise<T> {
  await tx.query('SAVEPOINT settings_write');
  try {
    const r = await fn();
    await tx.query('RELEASE SAVEPOINT settings_write');
    return r;
  } catch (err) {
    await tx.query('ROLLBACK TO SAVEPOINT settings_write').catch(() => undefined);
    throw err;
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
  await savepoint(tx, async () => {
    const rows = await ownRows(tx, input.key, level, scopeId, input.at);
    const current = rows.find((r) => r.valid_from.getTime() < input.at.getTime());
    const future = rows.find((r) => r !== current);
    if (future) throw overlap(future.id);
    if (!current) return;
    await tx.query('UPDATE app.settings_values SET valid_to = $2 WHERE id = $1', [current.id, input.at]);
    await assertWindowPair(tx, input.key, input.scope, input.at);
    await assertMarketingWindowPair(tx, input.key, input.scope, input.at);
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
  });
}

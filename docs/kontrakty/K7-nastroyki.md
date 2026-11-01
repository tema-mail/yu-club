# K7. Настройки: `resolveSetting` и ключи этапов 0–1

Модуль: `apps/api/src/core/settings.ts`. Таблица: `settings_values` (model-dannyh 0009). Шаг: S0-12. Потребители: все модули.
Основа: 15 §3 (наследование, даты, история), §7, §13, §20; 17 §7.4; 03 §5.2; план 3.3.

## Уровни

`system` (значение по умолчанию в реестре кода, не в базе) → `network` → `city` → `branch`. Более конкретный уровень перекрывает общий, **если уровень разрешён для ключа** (15 §3.3). Одна сеть на установку, поэтому у `network` нет id (решение).

## Типы и функции

```ts
export type SettingLevel = 'system' | 'network' | 'city' | 'branch';
export type SettingScope = { network: true } | { cityId: string } | { branchId: string };

export interface SettingDef<T> {
  key: SettingKey;
  schema: z.ZodType<T>;               // валидация значения и системные пределы
  systemDefault: T;
  levels: readonly Exclude<SettingLevel, 'system'>[];   // где можно переопределять
  editAction: Action;                 // K1: какое право нужно для изменения
  affectsExisting: false;             // 15 §3.4: все ключи Э0–Э1 действуют на новые операции
}

export interface Resolved<T> {
  value: T;
  source: { level: SettingLevel; valueId: string | null; validFrom: Date | null };   // «откуда значение» (15 §3.2)
}

/** Значение на момент `at` для области. Для { branchId } поднимается branch → city (город филиала) → network → system.
 *  Неизвестный ключ – ошибка программиста (throw), не AppError. */
export function resolveSetting<K extends SettingKey>(db: Db | Tx, key: K, scope: SettingScope, at: Date): Promise<Resolved<SettingValue<K>>>;

/** Пакетно для экрана/расчёта: один запрос на набор ключей. */
export function resolveSettings<K extends SettingKey>(db: Db | Tx, keys: readonly K[], scope: SettingScope, at: Date): Promise<{ [P in K]: Resolved<SettingValue<P>> }>;

/** Установить значение с даты. Закрывает текущую строку того же уровня (valid_to = validFrom) и вставляет новую.
 *  Проверки до сохранения (15 §20): уровень разрешён (SETTING_LEVEL_NOT_ALLOWED), значение по схеме (SETTING_INVALID),
 *  пересечение дат (EXCLUDE → SETTING_PERIOD_OVERLAP). Аудит setting.changed с before/after. */
export function setSetting<K extends SettingKey>(tx: Tx, ctx: AccessContext, input: {
  key: K; scope: Exclude<SettingScope, never>; value: SettingValue<K>; validFrom: Date; reason?: string;
}, meta: AuditRequestMeta): Promise<{ valueId: string }>;

/** Вернуть к наследованию: закрыть локальное значение (valid_to = at). Строка остаётся в истории (15 §3.3). */
export function resetToInherited(tx: Tx, ctx: AccessContext, input: { key: SettingKey; scope: SettingScope; at: Date; reason?: string }, meta: AuditRequestMeta): Promise<void>;

/** История значений ключа для области (CRM «на дату», полная выдача – Э3). */
export function settingHistory(db: Db, key: SettingKey, scope: SettingScope): Promise<Array<{ valueId: string; level: SettingLevel; value: unknown; validFrom: Date; validTo: Date | null; createdBy: string; reason: string | null }>>;
```

**Снимки.** Операция, которой важно значение на момент создания, копирует его к себе: удержание – `holds.ttl_minutes`, бронь – цену и состав (`booking_versions`). Изменение настройки не трогает созданные операции (15 §3.4, 15 §7.3 «уже начатый резерв не меняет срок»).

**Циклическое наследование** (15 §20) невозможно по построению: цепочка фиксирована (филиал → его город → сеть).

## Реестр ключей Э0–Э1

| Ключ | Тип, пределы (`schema`) | `systemDefault` | Уровни | Право (K1) | Основание |
|---|---|---|---|---|---|
| `booking.window_default_days` | int 1..30 | 7 | network, branch | `settings.branch.manage` | 01 §4, 15 §7.1 |
| `booking.window_max_days` | int 1..90, ≥ default | 30 | network, branch | `settings.branch.manage` | 01 §4, 15 §7.1 |
| `booking.hold_minutes` | int 5..60 | 15 | network | `settings.network.manage` | 01 §4; 15 §7.3 «доступно владельцу» |
| `booking.buffer_minutes` | int 0..60 | 0 | network, branch | `settings.branch.manage` | 15 §7.6, Q-19 – выключено |
| `booking.max_hold_items` | int 1..20 | 10 | network | `settings.network.manage` | решение (K5 `HOLD_LIMIT_REACHED`) |
| `booking.client_cancel_enabled` | boolean | true | network | `settings.network.manage` | R-12 по умолчанию |
| `notifications.reminder_day_before_time` | `HH:mm` | `"21:00"` | network | `settings.network.manage` | 01 §14, 09 §6.1 |
| `notifications.reminder_before_minutes` | int 5..120 | 15 | network | `settings.network.manage` | 01 §14, 09 §6.2 |
| `notifications.push_retry_limit` | int 0..5 | 3 | network | `settings.network.manage` | 09 §10 (технический, решение) |
| `staff.session_idle_minutes` | int 15..1440 | 480 | network | `settings.network.manage` | 17 §7.4 – значение до утверждения (решение) |
| `staff.session_absolute_hours` | int 1..720 | 72 | network | `settings.network.manage` | 17 §7.4 (решение) |
| `staff.login_max_failures` | int 3..20 | 10 | network | `settings.network.manage` | план S0-09 |
| `staff.login_lock_minutes` | int 1..60 | 15 | network | `settings.network.manage` | план S0-09 (решение) |
| `client.otp_ttl_seconds` | int 60..900 | 300 | network | `settings.network.manage` | 03 §5.2 (значение – решение) |
| `client.otp_max_attempts` | int 3..10 | 5 | network | `settings.network.manage` | 03 §5.2 |
| `client.otp_resend_cooldown_seconds` | int 30..600 | 60 | network | `settings.network.manage` | 03 §5.2 |
| `client.otp_max_per_phone_per_hour` | int 1..20 | 5 | network | `settings.network.manage` | 03 §5.2 «защита от массового подбора» |
| `client.session_days` | int 1..365 | 30 | network | `settings.network.manage` | 03 §6.1 (решение) |
| `branch.default_hours` | `{open:'HH:mm', close:'HH:mm'}` | `{"open":"10:00","close":"22:00"}` | network, city | `settings.network.manage` | 01 §4.1 п.1 – только для создания 7 строк нового филиала |

Шаг слота **не** настройка: единственный источник – `dict_resource_types.step_minutes` (+ `resources.step_minutes_override`), 15 §3.1 «один источник значения», 15 §7.2.
Часы работы **не** настройка: `branch_weekly_hours` + `calendar_exceptions` (15 §3.1 «часы работы задаются в карточке филиала»).

Новый ключ = строка этой таблицы + `SettingDef` в коде.

## Ошибки

| Код | HTTP | Когда |
|---|---|---|
| `SETTING_INVALID` | 422 | значение вне схемы/пределов (`details.issues`) |
| `SETTING_LEVEL_NOT_ALLOWED` | 422 | уровень не разрешён для ключа |
| `SETTING_PERIOD_OVERLAP` | 409 | пересечение дат на том же уровне (`details.conflictValueId`) |
| `FORBIDDEN` / `NOT_FOUND` | 403 / 404 | K1 |

## Проверка (S0-12)

значения филиала, города, сети по очереди закрываются `resetToInherited` – результат «поднимается» до системного; значение на прошлую дату; `resetToInherited` – старая строка видна в истории; пересечение дат → `SETTING_PERIOD_OVERLAP` (от базы).

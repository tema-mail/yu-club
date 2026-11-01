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
| `booking.max_anonymous_holds_per_branch` | int 0..500 | 30 | network, branch | `settings.branch.manage` | решение по ревью (K5, защита от бота) |
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

## Реестр ключей Э2 (S2-01; основание – K10 §2, K15 §13, K17 §12; внесено S2-00 02.11.2026)

Все ключи денег и баллов меняет только Владелец (`settings.network.manage`, решение: уровень «филиал» у двух ключей кассы – для разной настройки филиалов, но Директор их не меняет – иначе запрет минуса кассы снимался бы в обход Q-28). `affectsExisting: false`: платёж хранит снимок флага R-03 (`topup_rule_snapshot`), партия – свой срок (K15 §2).

| Ключ | Тип, пределы (`schema`) | `systemDefault` | Уровни | Право (K1) | Основание |
|---|---|---|---|---|---|
| `payment.certificate_topup_enabled` | boolean | false | network | `settings.network.manage` | K10 §2, Q-24 / R-03 |
| `finance.negative_balance_allowed` | boolean | false | network, branch | `settings.network.manage` | K17 §6, Q-28 |
| `finance.cash_shift_enabled` | boolean | false | network, branch | `settings.network.manage` | K17 §7, Q-22 |
| `certificate.sale_methods` | непустой массив без повторов из `cash`, `card`, `transfer` | `["cash","card","transfer"]` | network | `settings.network.manage` | K16 §2, Q-26 |
| `certificate.nominal_min_kop` | int 1..100 000 000 или null | null | network | `settings.network.manage` | K16 §2, 08 §4.5 |
| `certificate.nominal_max_kop` | int 1..100 000 000 или null | null | network | `settings.network.manage` | K16 §2, 08 §4.5 |
| `loyalty.batch_ttl_days` | int 1..3650 или null | null (бессрочно) | network | `settings.network.manage` | K15 §2, Q-43 / R-05 |
| `loyalty.penalty_scope` | `'visit'` \| `'booking'` | `'visit'` | network | `settings.network.manage` | K15 §5, Q-44 / R-07 |
| `loyalty.penalties_from` | ISO-время UTC или null | null | network | `settings.network.manage` | K15 §5, план 4.3 п.10 |
| `loyalty.points_resource_types` | массив кодов `dict_resource_types` без повторов (может быть пустым) | `["pc","vr_seat","ps_room"]` | network | `settings.network.manage` | K15 §3, Q-42 |
| `loyalty.accrue_for_points` | boolean | false | network | `settings.network.manage` | K15 §4, Q-40 / R-06 |
| `loyalty.accrue_for_certificate` | boolean | true | network | `settings.network.manage` | K15 §4, Q-40 / R-06 |

- `loyalty.penalties_from = null` (решение S2-00): «дата запуска Э2» заранее неизвестна, поэтому системное значение – «штрафы не начисляются»; Владелец ставит дату при выпуске Э2 в бой (6.4.3 плана). Так ни одна неявка Э1 не получит штраф задним числом.
- Сверка `nominal_min_kop ≤ nominal_max_kop` и существования кодов типов ресурсов – в модуле-потребителе при чтении (K16, K15), а не в схеме ключа: схема не видит второго ключа и справочника.

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

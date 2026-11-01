# K1. Права: `can`, `assertCan`, `scopeFilter`

Модуль: `apps/api/src/core/permissions.ts`. Шаг: S0-10. Потребители: все модули, CRM-маршруты, CRM-меню.
Основа: 04 §2, §3, §5, §8, §12; 17 §7; ADR 0005; план 2.1 (N-06, R-14).

## Типы

```ts
export type StaffRole = 'owner' | 'director' | 'admin';

export type Actor =
  | { kind: 'staff'; staffId: string; sessionId: string }
  | { kind: 'client'; clientId: string; sessionId: string }
  | { kind: 'visitor'; visitorId: string }             // посетитель сайта без входа (K5)
  | { kind: 'system'; process: string };               // 'hold-expiry', 'reminders', 'outbox:<handler>'

/** Загружается из БД на КАЖДЫЙ запрос (04 §12), между запросами не кэшируется. */
export interface AccessContext {
  actor: Extract<Actor, { kind: 'staff' }>;
  role: StaffRole;
  network: boolean;                    // true только у owner
  cityIds: ReadonlySet<string>;        // назначения city, действующие на дату `at`
  branchIds: ReadonlySet<string>;      // все доступные филиалы: branch-назначения + все филиалы city-назначений
  at: Date;
}

export type Target =
  | { network: true }                  // действие над сетью целиком (создать город, сетевые настройки)
  | { cityId: string }
  | { branchId: string };

export type BranchScope =
  | { kind: 'all' }
  | { kind: 'branches'; branchIds: string[] }   // непустой
  | { kind: 'none' };
```

## Функции

```ts
/** Читает staff + staff_assignments (valid_from ≤ дата ≤ valid_to, revoked_at IS NULL), раскрывает city → branches.
 *  Сотрудник не active → AppError('SESSION_REVOKED', 401). */
export function loadAccess(db: Db, actor: Extract<Actor, {kind:'staff'}>, at: Date): Promise<AccessContext>;

/** Чистая функция, без БД. true ⇔ действие есть в наборе роли И цель в зоне. */
export function can(ctx: AccessContext, action: Action, target: Target): boolean;

/** Бросает:
 *  - NOT_FOUND (404), если цель вне зоны (не раскрываем существование, ADR 0005 п.7);
 *  - FORBIDDEN (403), если цель в зоне, но действие роли не разрешено.
 *  В обоих случаях пишет audit result='denied' отдельной транзакцией (K2 `writeDenied`). */
export function assertCan(ctx: AccessContext, action: Action, target: Target, objectRef?: { type: string; id: string }): void;

/** Условие для списков и поиска. Применяется в SQL, не после выборки. */
export function scopeFilter(ctx: AccessContext, action: Action): BranchScope;

/** Kysely-помощник: добавляет WHERE <column> IN (...) / FALSE / ничего. */
export function applyBranchScope<QB extends SelectQueryBuilder<any, any, any>>(qb: QB, column: string, scope: BranchScope): QB;

/** Дополнительные запреты при работе с сотрудниками (04 §2 п.6, §4.2–4.3). */
export function assertCanManageStaff(
  ctx: AccessContext,
  op: 'create' | 'update_profile' | 'change_role' | 'change_scope' | 'block' | 'unblock' | 'end_sessions',
  target: { staffId?: string; role: StaffRole; branchIds: string[]; cityIds: string[] },
): void;

/** Клиент работает только со своим (03 §3 п.4). Чужой → NOT_FOUND. */
export function assertOwnClient(actor: Actor, clientId: string): void;
```

Правила `can` для цели:
- `{ network: true }` – только `ctx.network`;
- `{ cityId }` – `ctx.network` или `cityIds.has(cityId)`;
- `{ branchId }` – `ctx.network` или `branchIds.has(branchId)`.

`assertCanManageStaff` (бросает `FORBIDDEN`):
1. `target.staffId === ctx.actor.staffId` и op ∈ {`change_role`, `change_scope`} – запрещено всем (04 §3.2, §5).
2. `target.role ∈ {owner, director}` и `ctx.role !== 'owner'` – запрещено (Директор не трогает директоров, 04 §4.2).
3. `target.role === 'owner'` при `create`/`change_role` – запрещено всем (Владелец – только CLI установки, ADR 0005 п.9).
4. Директор: каждый `target.branchIds`/`cityIds` ⊆ своей зоны, иначе `NOT_FOUND`.

## Реестр действий и набор ролей до Э3

`О` – Владелец (вся сеть), `Д` – Директор (своя зона), `А` – Администратор (назначенные филиалы). Пусто – запрещено.
Набор фиксирован кодом (N-06, R-14 по умолчанию); источник каждой строки – 04 §5, если не помечено «решение».

| Действие (`Action`) | О | Д | А | Цель | Основание |
|---|:-:|:-:|:-:|---|---|
| `network.view` | ✓ | ✓ | ✓ | branch/city | 04 §5 «Просмотр городов и филиалов» |
| `network.city.manage` (создать, изменить, архив) | ✓ | | | network | 04 §5 |
| `network.branch.create` / `network.branch.archive` | ✓ | | | city | 04 §5 (делегирование – Э3) |
| `network.branch.update` (карточка, контакты, статус «временно закрыт») | ✓ | ✓ | | branch | 04 §4.2 «если разрешено», N-06 |
| `network.hours.manage` (график, исключения) | ✓ | ✓ | | branch | 04 §9 пример; N-06 |
| `staff.view` | ✓ | ✓ | | branch | 04 §4.2 |
| `staff.director.assign` | ✓ | | | city/branch | 04 §5 |
| `staff.admin.assign` (создать администратора, назначить на филиал) | ✓ | ✓ | | branch | 04 §5; N-06 «назначать Администраторов – да» |
| `staff.block` (блокировка, завершение сессий) | ✓ | ✓ | | branch | 04 §4.1; Д – только администраторов (`assertCanManageStaff`) |
| `resources.view` | ✓ | ✓ | ✓ | branch | 04 §5 |
| `resources.manage` (помещения, комнаты, ресурсы, состав) | ✓ | ✓ | | branch | 04 §5; N-06 |
| `schedule.view` | ✓ | ✓ | ✓ | branch | 04 §5 |
| `booking.create` | ✓ | ✓ | ✓ | branch | 04 §5 |
| `booking.cancel` (комментарий обязателен) | ✓ | ✓ | ✓ | branch | 04 §5, 01 §12 |
| `booking.reschedule` | ✓ | ✓ | ✓ | branch | 01 §11 «при наличии права» → решение: всем трём, как отмена |
| `booking.visit.mark` (приход, завершение, неявка) | ✓ | ✓ | ✓ | branch | 04 §5 |
| `booking.visit.correct` (исправление прихода/неявки с причиной) | ✓ | ✓ | | branch | решение: исправление факта – руководитель |
| `block.manage` (создать, снять блокировку) | ✓ | ✓ | ✓ | branch | 04 §4.3 «если право предоставлено»; R-14: «блокировка ресурса – Администратор по праву» → решение: выдано по умолчанию |
| `client.view.basic` (имя, маскированный телефон, записи своего филиала) | ✓ | ✓ | ✓ | branch | 04 §8.3, 03 §15 |
| `client.view.full` (полный телефон, сетевая история) | ✓ | ✓ | | branch | 04 §8.3; Д – в зоне |
| `client.update.limited` (имя, комментарий) | ✓ | ✓ | ✓ | branch | 04 §5 «Ограниченные поля» |
| `client.update` (телефон, статус) | ✓ | ✓ | | branch | 03 §12, решение |
| `client.merge` | ✓ | | | network | R-14: «объединение клиентов – Владелец» |
| `client.export` / `export.pd` | ✓ | | | network | 04 §5 «по отдельным правам»; N-06: Директору экспорт ПДн нельзя |
| `tariff.manage` | ✓ | | | branch | 17 §7.3, решение |
| `settings.network.manage` | ✓ | | | network | 04 §4.3 |
| `settings.branch.manage` | ✓ | ✓ | | branch | 04 §4.2 «операционные настройки, если разрешено» |
| `dictionary.manage` | ✓ | | | network | план S0-13 |
| `audit.view` | ✓ | ✓ | | branch | 04 §5; Администратору – только свои события (`audit.view.own`) |
| `audit.view.own` | ✓ | ✓ | ✓ | branch | 04 §5 |
| `audit.export` | ✓ | | | network | 04 §11.4 |
| `notifications.view` (журнал отправок) | ✓ | ✓ | ✓ | branch | 01 §14 п.6 |
| `finance.view` | ✓ | ✓ | ✓* | branch | 04 §5; * Администратор – только кассу своего филиала за смену (R-14) – Э2 |
| `finance.operation.create` (оплата сеанса, расход своего филиала) | ✓ | ✓ | ✓ | branch | R-14 – Э2 |
| `finance.correct` / `finance.refund` | ✓ | ✓ | | branch | R-14, N-06 «кроме финкорректировок» → решение: Директору – да по регламенту зоны (04 §5), N-06 читаем как «без делегирования Владельцу» |
| `payroll.view`, `loyalty.adjust`, `certificate.sell`, `certificate.redeem`, `shift.manage` | – | – | – | – | Э2–Э3, набор задаётся в своём контракте; до этого действия в реестре нет = запрещено |

Строка `finance.correct` для Директора – спорная (N-06 против 04 §5), вынесена в итоговый список.

## Ошибки

| Код | HTTP | Когда |
|---|---|---|
| `AUTH_REQUIRED` | 401 | нет сессии |
| `SESSION_REVOKED` | 401 | сессия отозвана / сотрудник заблокирован |
| `FORBIDDEN` | 403 | объект в зоне, действие не разрешено роли |
| `NOT_FOUND` | 404 | объект не существует **или** вне зоны – тело одинаковое |

## Проверка (S0-10)

- Табличный тест: каждая строка реестра × 3 роли × (своя цель / чужая цель) → ожидаемый `true/false`.
- Директор: назначить директора → `FORBIDDEN`; изменить свою зону → `FORBIDDEN`; назначить администратора в чужой филиал → `NOT_FOUND`.
- Назначение `branch` в городе не открывает второй филиал того же города.
- Отзыв назначения → следующий `loadAccess` не видит филиал.
- Действие не из реестра → `can` = false.

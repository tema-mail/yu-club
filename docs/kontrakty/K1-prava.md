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
  | { branchId: string }
  | { clientId: string };              // клиент один на сеть (03 §3): зона проверяется через его брони (ниже)

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
 *  - FORBIDDEN (403), если цель в зоне, но действие роли не разрешено;
 *  - FORBIDDEN (403) для сетевой цели (network) у не-Владельца: о существовании сети знают все, скрывать нечего (решение 01.11 по ревизии S0-10).
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

/** Сотрудник и карточка клиента (цель { clientId }). */
export function assertCanClient(db: Db | Tx, ctx: AccessContext, action: Action, clientId: string): Promise<void>;
```

Правила `can` для цели:
- `{ network: true }` – только `ctx.network`;
- `{ cityId }` – `ctx.network` или `cityIds.has(cityId)`;
- `{ branchId }` – `ctx.network` или `branchIds.has(branchId)`.
- `{ clientId }` – `ctx.network`, или у клиента есть бронь (любого статуса) в филиале из `branchIds`, или клиент создан сотрудником этой зоны (04 §8.3: минимум для обслуживания). Это не чистая проверка – поэтому для клиента `can` не используется, вызывается асинхронная `assertCanClient(db, ctx, action, clientId)` с тем же результатом `NOT_FOUND`/`FORBIDDEN`. Поиск по точному телефону для новой записи – отдельное правило K9 `searchClients`.

`assertCanManageStaff` (бросает `FORBIDDEN`):
1. `target.staffId === ctx.actor.staffId` и op ∈ {`change_role`, `change_scope`} – запрещено всем (04 §3.2, §5).
2. `target.role ∈ {owner, director}` и `ctx.role !== 'owner'` – запрещено (Директор не трогает директоров, 04 §4.2).
3. `target.role === 'owner'` при `create`/`change_role` – запрещено всем (Владелец – только CLI установки, ADR 0005 п.9).
4. Директор: каждый `target.branchIds`/`cityIds` ⊆ своей зоны, иначе `NOT_FOUND`.

## Реестр действий и набор ролей до Э3

Э0–Э1 – таблица ниже; Э2 – подраздел «Действия Э2».

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
| `client.view.basic` (имя, маскированный телефон, записи своего филиала) | ✓ | ✓ | ✓ | client | 04 §8.3, 03 §15 |
| `client.view.full` (полный телефон, сетевая история) | ✓ | ✓ | | client | 04 §8.3; Д – в зоне |
| `client.update.limited` (имя, комментарий) | ✓ | ✓ | ✓ | client | 04 §5 «Ограниченные поля» |
| `client.update` (телефон, статус) | ✓ | ✓ | | client | 03 §12, решение |
| `client.merge` | ✓ | | | network | R-14: «объединение клиентов – Владелец» |
| `client.export` / `export.pd` | ✓ | | | network | 04 §5 «по отдельным правам»; N-06: Директору экспорт ПДн нельзя |
| `client.anonymize` (обезличивание, K9, K11 №249) | ✓ | | | network | 03 §13, Q-91; решение D4-60: необратимо, как экспорт ПДн – только Владелец; не делегируется |
| `tariff.manage` | ✓ | | | branch | 17 §7.3, решение |
| `settings.network.manage` | ✓ | | | network | 04 §4.3 |
| `settings.branch.manage` | ✓ | ✓ | | branch | 04 §4.2 «операционные настройки, если разрешено» |
| `dictionary.manage` | ✓ | | | network | план S0-13 |
| `audit.view` | ✓ | ✓ | | branch | 04 §5; Администратору – только свои события (`audit.view.own`) |
| `audit.view.own` | ✓ | ✓ | ✓ | branch | 04 §5 |
| `audit.export` | ✓ | | | network | 04 §11.4 |
| `notifications.view` (журнал отправок) | ✓ | ✓ | ✓ | branch | 01 §14 п.6 |

### Действия Э2 (S2-01; основание – K10 §8, K15 §10, K16 §9, K17 §8)

Решение (план 6.4, S2-01): действия Э2 – строки той же таблицы `MATRIX` в `core/permissions.ts`, а не `modules/<x>/actions.ts`: одно место до развилки потоков, без конфликтов слияния. Набор – умолчания Q-29 / R-14, Q-45 / R-13, Q-48 (ждут заказчика, 6.4.3 плана); меняется правкой `MATRIX`, механизм прав с датами – Э3 (N-06).

| Действие (`Action`) | О | Д | А | Цель | Основание |
|---|:-:|:-:|:-:|---|---|
| `finance.payment.record` (оплата сеанса, проверка сертификата K16 №36) | ✓ | ✓ | ✓ | branch | K10 §8, R-14 / Q-29 |
| `finance.payment.view` | ✓ | ✓ | ✓ | branch | K10 §8 |
| `finance.refund` | ✓ | ✓ | | branch | K10 §8; решение Э1 |
| `finance.view` (остатки, журнал, сводка) | ✓ | ✓ | | branch | K17 §8, 06 §14 |
| `finance.view.day` (сутки своего филиала без остатков; дерево категорий) | ✓ | ✓ | ✓ | branch | K17 §8 |
| `finance.expense.create` | ✓ | ✓ | ✓ | branch | K17 §8, Q-29 |
| `finance.income.create` (ручной доход) | ✓ | ✓ | | branch | K17 §8 |
| `finance.opening_balance` | ✓ | | | branch | K17 §8, 06 §14 |
| `finance.withdrawal`, `finance.place_transfer` | ✓ | ✓ | | branch | K17 §8 |
| `finance.correct` (сторно, исправление) | ✓ | | | branch | решение Э1: N-06 «кроме финкорректировок» до ответа заказчика |
| `finance.category.manage` | ✓ | | | network | K17 §8, 06 §7.2 (справочник сети) |
| `finance.period.close` | ✓ | | | branch | K17 §8, Q-28 |
| `finance.shift.operate` | ✓ | ✓ | ✓ | branch | K17 §8 |
| `finance.shift.resolve` | ✓ | ✓ | | branch | K17 §7 п.4 |
| `loyalty.view` | ✓ | ✓ | ✓ | client | K15 §10 |
| `loyalty.adjust` | ✓ | ✓ | | client | K15 §10, Q-48 |
| `loyalty.adjust_below_limit` (K3 `allowBelowLimit` для баллов) | ✓ | | | client | K15 §10, 07 §3.1, §10.3 |
| `loyalty.book_below_limit` (бронь в CRM при −50, с причиной) | ✓ | ✓ | | branch | K15 §8, Q-45 / R-13 |
| `loyalty.goods.manage` | ✓ | ✓ | | branch | K15 §10 |
| `loyalty.goods.issue` | ✓ | ✓ | ✓ | branch | K15 §10, 07 §7.2 |
| `certificate.view` | ✓ | ✓ | ✓ | branch | K16 §9 |
| `certificate.sell` | ✓ | ✓ | | branch | K16 §9, 08 §4.1 |
| `certificate.cancel` | ✓ | ✓ | | branch | K16 §9 |
| `certificate.correct` (корректировка остатка, перевыпуск кода) | ✓ | | | branch | K16 §9 |
| `certificate.review` | ✓ | ✓ | | branch | K16 §9 |
| `certificate.link` | ✓ | ✓ | ✓ | branch | K16 §9 |

`ledger.override_limit` из черновика K3 не вводится: режим «ниже предела» у баллов – право `loyalty.adjust_below_limit`; у кассы и сертификатов его нет (касса проверяет минус кодом K17 §6, сертификат – `min 0` без обхода). Зарплата (`payroll.*`) и смены сотрудников (`shift.*`) – Э3, подраздел «Действия Э3» ниже.

### Действия Э3 (S3-01; основание – K18 §12, K19 §12, K20 §13; внесено S3-00 04.11.2026)

Как в Э2 – строки общей `MATRIX` (решение D2-01). Набор – умолчания Q-52, Q-54, Q-60, Q-62 / R-14, Q-64 / R-15, Q-107, Q-108, Q-115, Q-151 (ждут заказчика, 6.5.3 плана); меняется правкой `MATRIX`.

| Действие (`Action`) | О | Д | А | Цель | Основание |
|---|:-:|:-:|:-:|---|---|
| `shift.view.own` | ✓ | ✓ | ✓ | branch | K18 §12, 05 §5.2 |
| `shift.plan.own` (своя будущая смена) | ✓ | ✓ | ✓ | branch | K18 §12, 05 §5.1–5.2 |
| `shift.attendance.self` | ✓ | ✓ | ✓ | branch | K18 §12, Q-60 |
| `shift.view` (график, покрытие, чужие смены без сумм) | ✓ | ✓ | ✓ | branch | K18 §12, 05 §6.1 |
| `shift.manage` (чужие смены) | ✓ | ✓ | | branch | K18 §12, 05 §5.6 |
| `shift.outside_hours` | ✓ | ✓ | | branch | K18 §12, 05 §5.3 |
| `shift.attendance.correct` | ✓ | ✓ | | branch | K18 §12, Q-60 |
| `staff.planning_status` | ✓ | ✓ | | branch | K18 §12, 05 §3.2 |
| `payroll.view` | ✓ | ✓ | | branch | K18 §12, 05 §10.1, Q-151 |
| `payroll.rate.manage` | ✓ | | | network | K18 §12, Q-62 / R-14 |
| `payroll.penalty.manage` | ✓ | ✓ | | branch | K18 §12, Q-62 / R-14 |
| `payroll.bonus.manage` | ✓ | | | network | K18 §12, Q-107 |
| `payroll.statement.review` | ✓ | ✓ | | branch | K18 §12, 05 §11 |
| `payroll.period.manage`, `payroll.statement.ready`, `payroll.payout.mark`, `payroll.correct` | ✓ | | | network | K18 §12, 05 §5.1 |
| `payroll.payout.expense` | ✓ | | | branch | K18 §12, Q-64 / R-15 |
| `equipment.view` | ✓ | ✓ | ✓ | branch | K19 §12, 10 §14 |
| `equipment.view.accounts` | ✓ | ✓ | | branch | K19 §12, Q-54 |
| `equipment.manage` | ✓ | ✓ | | branch | K19 §12 |
| `equipment.move` | ✓ | ✓ | | branch | K19 §12 |
| `equipment.financial.edit` | ✓ | | | network | K19 §12 |
| `equipment.write_off` | ✓ | | | network | K19 §12 |
| `equipment.category.manage` | ✓ | | | network | K19 §12, 10 §3.2 |
| `repair.register`, `repair.attach` | ✓ | ✓ | ✓ | branch | K19 §12 |
| `repair.manage` | ✓ | ✓ | | branch | K19 §12 |
| `repair.approve` | ✓ | | | network | K19 §12, Q-52 |
| `repair.accept` | ✓ | ✓ | ✓ | branch | K19 §12, Q-52 |
| `repair.close` | ✓ | ✓ | | branch | K19 §12, Q-52 |
| `repair.expense.create` | ✓ | ✓ | | branch | K19 §12 (плюс `finance.expense.create` в филиале-плательщике) |
| `repair.executor.manage` | ✓ | ✓ | | network | K19 §12, 10 §8.3 |
| `event.view` | ✓ | ✓ | ✓ | branch | K20 §13 |
| `event.manage` | ✓ | ✓ | ✓ | branch | K20 §13 |
| `event.price.manage` | ✓ | ✓ | | branch | K20 §13 |
| `event.money.view` | ✓ | ✓ | | branch | K20 §13 |
| `event.money.record` | ✓ | ✓ | ✓ | branch | K20 §13 (плюс K17 `finance.income.create` / `finance.expense.create`) |
| `event.package.manage`, `event.type.manage` | ✓ | | | network | K20 §13 |
| `gift.issue` | ✓ | ✓ | ✓ | branch | K20 §13 |
| `gift.issue.manual`, `gift.cancel` | ✓ | | | network | K20 §13, Q-115 |
| `gift.book` | ✓ | ✓ | ✓ | branch | K20 §13 |
| `holiday.manage` | ✓ | | | network | K20 §13, Q-73 |

Цель `network` у Директора: строка с пустым «Д» – ему запрещено; строка `repair.executor.manage` (Д ✓, цель network) – справочник сети, Директор правит его без сетевой зоны: команда проверяет `roleAllows`, а не `assertCan({ network: true })` (решение: исполнитель не принадлежит филиалу; иначе Директору всегда `FORBIDDEN`). Экспорт зарплаты `payroll.export` – Э4. `payroll.view.own` не вводится (Q-108).

### Делегирование (Э3.4, 04 §9; шаги S3-88, S3-89)

Право с датами `staff_grants (staff_id, action, scope: city|branch, valid_from, valid_to, granted_by, revoked_at)` (`0310_staff_grants.sql`). Выдаёт и отзывает только Владелец; выдача – конкретному сотруднику, не роли (по умолчанию, Q-156); себе – нельзя.

```ts
/** Закрытый список делегируемых действий (04 §9). Остальные не делегируются: выдача → GRANT_ACTION_NOT_DELEGABLE. */
export const DELEGABLE = ['block.manage', 'network.hours.manage', 'finance.income.create', 'finance.expense.create',
  'equipment.view.accounts', 'client.merge', 'shift.manage', 'payroll.view', 'network.branch.create'] as const;
```

- `network.branch.create` (04 §5) делегируется отдельно от прочих прав сети; цель права – город (`cityId`).
- `loadAccess` добавляет действующие на дату права (`valid_from ≤ дата ≤ valid_to`, `revoked_at IS NULL`) в `ctx.grants: Map<Action, { cityIds, branchIds }>`; `can` = роль ∪ право в зоне права; `scopeFilter(ctx, action)` = зона роли ∪ зона права **на это действие**.
- Зона права ⊆ действующих `staff_assignments` получателя на дату начала права, иначе `GRANT_SCOPE_INVALID`. И после выдачи: `loadAccess` отбрасывает право вне назначений на дату – снятое назначение закрывает и право (решение S3-88). Истёкшее и отозванное право не действует со следующего запроса (без кэша, 04 §12).
- Вход в раздел по праву – `hasAction(ctx, action)`, не `roleAllows`; зона – `can`/`scopeFilter`, не `ctx.branchIds`: право на филиал А не открывает другой филиал зоны роли. `client.merge` выдаётся, но своего API слияния пока нет – право начнёт действовать с ним.
- API (K11 №380–382, S3-89): `POST /staff/:staffId/grants`, `POST /staff/grants/:grantId/revoke`, `GET /staff/grants?staffId=` (вместе с `delegable` для экрана S3-87); задним числом не выдаётся.
- Делегированный `payroll.view` открывает все суммы зоны права, включая коллег получателя (Q-156).
- Аудит: `staff.grant.created`, `staff.grant.revoked` (K2 «Э3»).

| Код | HTTP | Когда |
|---|---|---|
| `GRANT_ACTION_NOT_DELEGABLE` | 422 | действие вне `DELEGABLE` |
| `GRANT_SCOPE_INVALID` | 422 | зона права вне назначений получателя |
| `GRANT_ALREADY_ACTIVE` | 409 | то же действие и зона на пересекающиеся даты |

### Действия Э4 (S4-01; основание – K21 §10, K22 §10, K24 §8; внесено S4-00 04.11.2026)

Как в Э2 – строки общей `MATRIX` (D2-01). Набор – умолчания Q-39, Q-80, Q-134, Q-139, Q-151, Q-152 (ждут заказчика, план 6.6.3); меняется правкой `MATRIX`. `notifications.view` и `export.pd` – есть с Э0–Э1, не меняются.

| Действие (`Action`) | О | Д | А | Цель | Основание |
|---|:-:|:-:|:-:|---|---|
| `notifications.send.service` (личное и по записи) | ✓ | ✓ | ✓ | branch | K21 §10 |
| `notifications.send.marketing` | ✓ | ✓ | | branch / city / network | K21 §10, Q-39 |
| `notifications.send.mass` (аудитория `segment`) | ✓ | ✓ | | branch / city / network | K21 §10 |
| `notifications.retry` | ✓ | ✓ | | branch | K21 §10 |
| `notifications.templates.manage` | ✓ | | | network | K21 §10 |
| `content.view` | ✓ | ✓ | ✓ | branch / роль (сетевое) | K22 §10 |
| `content.draft.edit` | ✓ | ✓ | ✓ | по охвату (K22 §4) | K22 §10, Q-134, Q-152 |
| `content.publish` (город, филиал) | ✓ | ✓ | | по охвату | K22 §10, Q-134 |
| `content.network.manage` | ✓ | | | network | K22 §10 |
| `content.catalog.availability` | ✓ | ✓ | | branch | K22 §10 |
| `content.legal.publish` | ✓ | | | network | K22 §7, §10 |
| `content.media.upload` | ✓ | ✓ | ✓ | роль | K22 §10 |
| `content.media.archive` | ✓ | ✓ | | роль | K22 §10 |
| `content.media.purge` | ✓ | | | network | K22 §8, §10 |
| `content.preview` | ✓ | ✓ | ✓ | как `content.view` | K22 §10 |
| `reports.ops.view` (3.2, 3.3, рабочий стол) | ✓ | ✓ | ✓ | branch | K24 §8, Q-80 |
| `reports.finance.view` | ✓ | ✓ | | branch | K24 §8 |
| `reports.clients.view` | ✓ | ✓ | | branch | K24 §8 |
| `reports.loyalty.view` | ✓ | ✓ | | branch | K24 §8 |
| `reports.events.view` | ✓ | ✓ | | branch | K24 §8 (данные – после Э3) |
| `reports.staff.view` | ✓ | ✓ | | branch | K24 §8 (данные – после Э3) |
| `reports.payroll.view` (деньги 3.9) | ✓ | ✓ | | branch | K24 §8; Директор – суммы своей зоны (решение техлида 04.11, Q-151) |
| `reports.equipment.view` | ✓ | ✓ | ✓ | branch | K24 §8 |
| `reports.comms.view` | ✓ | ✓ | | branch | K24 §8 |
| `reports.export` | ✓ | ✓ | | branch | K24 §8 |
| `reports.export.detail` | ✓ | ✓ | | branch | K24 §8 |
| `reports.export.payroll` | ✓ | | | network | K24 §8 |
| `search.global` | ✓ | ✓ | ✓ | роль (типы режет право типа, K24 §5) | K24 §8 |

**Цель «роль»** (решение S4-00): медиатека и чтение сетевого контента – общие для сети, а сетевая зона (`{ network: true }`) по построению есть только у Владельца (ADR 0005 п.2). Поэтому для `content.media.upload`, `content.media.archive`, `search.global` и чтения сетевых сущностей по `content.view`/`content.preview` проверяется только набор роли (`roleAllows`), без зоны; контракты K22 §10 и K24 §8, где у этих строк записано `network`, читать так. Изменяющие сетевые действия (`content.network.manage`, `content.legal.publish`, `content.media.purge`, `notifications.templates.manage`, `reports.export.payroll`) – с целью `{ network: true }`, то есть только Владелец.

Администратор в Э4 получает ровно: `notifications.send.service`, `content.view`, `content.draft.edit`, `content.media.upload`, `content.preview`, `reports.ops.view`, `reports.equipment.view`, `search.global` – и ничего из рекламы, массовых рассылок, публикации, финансовых отчётов и экспорта. Директор – всё, кроме `notifications.templates.manage`, `content.network.manage`, `content.legal.publish`, `content.media.purge`, `reports.export.payroll`, `export.pd`.

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

# Модель данных этапов 0 и 1

Версия 2 от 01.11.2026 (шаг S0-00, правки по architecture-reviewer; сверено с закоммиченными `db/migrations/0001_init.sql`, `db/migrate.ts`, `tests/helpers/pg.ts`). Основа: план 3.3–3.4, 6.1–6.2; ADR 0001–0005.
Факты ТЗ – со ссылкой «файл §пункт». Мои решения помечены «решение».
DDL ниже – нормативный: имена таблиц, столбцов, ограничений и их смысл – контракт для миграций. Порядок столбцов и индексы для скорости исполнитель может дополнять.

## 0. Общие соглашения

| Правило | Как |
|---|---|
| Ключи | `uuid PRIMARY KEY DEFAULT gen_random_uuid()`; журналы с порядком – `bigint GENERATED ALWAYS AS IDENTITY` |
| Время | `timestamptz`, UTC (ADR 0003); интервал – `tstzrange` `[)`, CHECK `NOT isempty(period) AND lower_inc(period) AND NOT upper_inc(period)` и конечные границы |
| Деньги / баллы | `bigint` в минорных единицах: копейки, сотые балла (ADR 0004, решение) |
| Удаление | не удаляем: `status` / `archived_at` (02 §12, 15 §3.5); `DELETE` – только для служебного (сессии, коды, ключи идемпотентности) |
| Оптимистичная блокировка | у редактируемых карточек `row_version int NOT NULL DEFAULT 1`; `UPDATE ... WHERE row_version = $v` (16 §15.4) |
| Автор | `created_by_type text, created_by_id uuid` – без FK (решение: журналы не зависят от порядка миграций и живут дольше актора) |
| Коды статусов | `text` + CHECK со списком системных кодов; подписи – в словаре `dict_statuses` (15 §16: системный код неизменен) |
| Филиальная привязка | у операционных таблиц `branch_id uuid NOT NULL` (04 §8.1) – по нему работает `scopeFilter` (K1) |
| Схемы | `app` – рабочие таблицы (у `yu_app` SELECT/INSERT/UPDATE/DELETE), `journal` – журнальные: `audit_events`, `ledger_entries`, `booking_versions`, `client_consents` (у `yu_app` только SELECT/INSERT) – права выдают default privileges из `0001_init.sql`. Каждая таблица в DDL – с именем схемы. `public` – только `schema_migrations` раннера |
| search_path рантайма | пул `yu_app` открывает соединения с `options: '-c search_path=app,journal'` (`apps/api/src/core/db.ts`, решение: не `ALTER ROLE` – миграции не должны требовать CREATEROLE от мигратора). SQL в коде модулей может писать имена без схемы |
| Формат миграции | один файл `NNNN_name.sql` с секциями `-- migrate:up` / `-- migrate:down`, каждая – в своей транзакции (`db/migrate.ts`); имя строго `^\d{4}_[a-z0-9_]+\.sql$` – суффиксов вроде `0002a` нет |
| Регистр email | без `citext` (решение: расширение не ставим ради двух столбцов): `email text` + `CHECK (email = lower(email))`, приложение приводит к нижнему регистру, уникальность – по столбцу |
| «Сейчас» | бизнес-моменты (`expires_at`, `hold_expires_at`, `occurred_at`, `released_at`, `planned_at`, `arrived_at` …) команда передаёт явно из `Clock` (`$now`, ADR 0003 п.10); `DEFAULT now()` оставлен только у технических `created_at`/`recorded_at`. `now()` в WHERE команд не используется |

**Владельцы таблиц** (ADR 0002): столбец «Модуль» в каждом разделе. Чужие таблицы – только через `modules/<x>/index.ts`.

## 1. Порядок миграций и зависимости FK

FK, которые смотрят «вперёд» (на таблицу из более поздней миграции), не создаются в ранней миграции, а добавляются `ALTER TABLE` в той миграции, где появляется цель. Так ни одна миграция не ссылается на несуществующую таблицу.

| № | Файл | Таблицы | FK наружу (на что) | Отложенные FK, добавляемые здесь |
|---|---|---|---|---|
| 0001 | `0001_init.sql` (закоммичен) | – (`btree_gist`; проверка роли `yu_app`; схемы `app`, `journal`; default privileges; `journal.make_append_only`, `journal.append_only_violations`) | – | – |
| 0002 | `0002_idempotency.sql` | `idempotency_keys` | – | – |
| 0003 | `0003_audit.sql` | `audit_events` | – (без FK, решение) | – |
| 0004 | `0004_ledger.sql` | `ledger_accounts`, `ledger_entries` | `ledger_entries → ledger_accounts`, `→ ledger_entries` (сторно) | – |
| 0005 | `0005_outbox.sql` | `outbox_events`, `processed_events` | `processed_events → outbox_events` | – |
| 0006 | `0006_staff.sql` | `staff`, `staff_sessions`, `staff_login_attempts` | `staff_sessions → staff` | – |
| 0007 | `0007_access.sql` | `staff_assignments` | `→ staff` | – |
| 0008 | `0008_network.sql` | `cities`, `branches`, `branch_weekly_hours` | `branches → cities` | `staff_assignments.city_id → cities`, `staff_assignments.branch_id → branches`, `ledger_accounts.branch_id → branches`, `ledger_entries.branch_id → branches` |
| 0009 | `0009_settings.sql` | `settings_values` | `→ cities`, `→ branches` | – |
| 0010 | `0010_dictionaries.sql` | `dict_resource_types`, `dict_space_types`, `dict_statuses`, `dict_status_transitions`, `dict_reasons` | – | – |
| 0101 | `0101_resources.sql` | `spaces`, `rooms`, `resources` | `→ branches`, `→ dict_space_types`, `→ dict_resource_types` | – |
| 0102 | `0102_occupancy.sql` | `occupancy_units`, `resource_units`, `occupancy` | `→ branches`, `→ rooms`, `→ resources`, `→ occupancy_units` | – |
| 0103 | `0103_calendar.sql` | `calendar_exceptions` | `→ branches`, `→ rooms`, `→ resources` | – |
| 0104 | `0104_blocks.sql` | `resource_blocks`, `resource_block_units` | `→ branches`, `→ occupancy_units`, `→ dict_reasons` | – |
| 0105 | `0105_clients.sql` | `clients`, `client_consents`, `client_notification_prefs` | `→ clients` | – |
| 0106 | `0106_client_auth.sql` | `client_otp_challenges`, `client_sessions` | `→ clients` | – |
| 0107 | `0107_tariffs.sql` | `tariffs` | `→ branches`, `→ dict_resource_types` | – |
| 0108 | `0108_holds.sql` | `holds`, `hold_items`, `client_time` | `→ branches`, `→ clients`, `→ resources` | – |
| 0109 | `0109_bookings.sql` | `bookings`, `booking_versions` | `→ branches`, `→ clients`, `→ resources`, `→ holds`, `→ tariffs`, `→ dict_reasons` | – |
| 0110 | `0110_visits.sql` | `visits`, `no_shows` | `→ bookings` | – |
| 0111 | `0111_notifications.sql` | `push_subscriptions`, `notifications` | `→ clients`, `→ branches`, `→ bookings` | – |

Проверка порядка (для S0-02 и далее): каждая миграция вверх на чистой базе после всех предыдущих, затем вниз в обратном порядке, затем снова вверх – без ошибок.

Полиморфные ссылки без FK (решение, с проверкой в коде модуля): `occupancy.source_id` (удержание / бронь / мероприятие Э3), `client_time.source_id`, `audit_events.object_id`, `outbox_events.aggregate_id`, `ledger_entries.ref_id`.

---

## 2. Этап 0

### 0001 – init

Файл уже в репозитории – источник истины он, а не этот документ. Кратко: `btree_gist`, проверка роли `yu_app` (создаёт initdb / globalSetup тестов), `CREATE SCHEMA app, journal`, default privileges (app – SELECT/INSERT/UPDATE/DELETE; journal – SELECT/INSERT), функции `journal.make_append_only(regclass)` и `journal.append_only_violations()`. Таблица учёта – `public.schema_migrations` (создаёт раннер).
Каждая следующая миграция, создающая журнальную таблицу, в тесте проверяет `SELECT * FROM journal.append_only_violations()` – пусто.

### 0002 – idempotency_keys (core)

```sql
CREATE TABLE app.idempotency_keys (
  scope           text        NOT NULL,          -- '<actorType>:<actorId>:<operation>'
  key             uuid        NOT NULL,
  request_hash    text        NOT NULL,          -- sha256 hex
  response_status smallint,                      -- NULL до фиксации не бывает: пишется в той же транзакции
  response_body   jsonb,
  created_at      timestamptz NOT NULL,              -- $now из Clock
  expires_at      timestamptz NOT NULL,              -- $now + 72 ч
  PRIMARY KEY (scope, key)
);
CREATE INDEX idempotency_keys_expires_idx ON app.idempotency_keys (expires_at);
```
Правила – ADR 0004 §2 (16 §2.2, §15.2).

### 0003 – audit_events (core)

Поля – ровно 04 §11.2.

```sql
CREATE TABLE journal.audit_events (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at   timestamptz NOT NULL,                   -- $now из Clock
  actor_type    text NOT NULL CHECK (actor_type IN ('staff','client','system','anonymous')),
  actor_id      uuid,                                   -- NULL для system/anonymous
  actor_role    text CHECK (actor_role IN ('owner','director','admin')),  -- на момент действия
  actor_scope   jsonb,                                  -- снимок зоны: {"network":true} | {"cityIds":[],"branchIds":[]}
  action        text NOT NULL,                          -- код из K2
  object_type   text NOT NULL,
  object_id     text,                                   -- text: бывают и uuid, и номера
  branch_id     uuid,                                   -- без FK (решение)
  city_id       uuid,
  before        jsonb,                                  -- после маскирования секретов
  after         jsonb,
  result        text NOT NULL CHECK (result IN ('success','denied','error')),
  reason        text,
  source        text NOT NULL CHECK (source IN ('crm','site','account','system','cli')),
  request_id    text,
  ip            inet,
  CHECK ((actor_type IN ('staff','client')) = (actor_id IS NOT NULL))
);
CREATE INDEX audit_object_idx ON journal.audit_events (object_type, object_id, occurred_at);
CREATE INDEX audit_branch_time_idx ON journal.audit_events (branch_id, occurred_at);
CREATE INDEX audit_actor_idx ON journal.audit_events (actor_type, actor_id, occurred_at);
-- journal.audit_events: yu_app только SELECT/INSERT (default privileges 0001); тест – journal.append_only_violations() пуст
```

### 0004 – ledger (core)

```sql
CREATE TABLE app.ledger_accounts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         text NOT NULL CHECK (kind IN ('cash_branch','loyalty_client','certificate','staff_payroll')),
  unit         text NOT NULL CHECK (unit IN ('RUB_KOP','POINT_CENTI')),
  branch_id    uuid,                   -- FK → branches добавляется в 0008; NULL у loyalty_client (счёт на сеть, 07 §3.1)
  owner_type   text NOT NULL CHECK (owner_type IN ('branch','client','certificate','staff')),
  owner_id     uuid NOT NULL,
  balance      bigint NOT NULL DEFAULT 0,
  min_balance  bigint,                 -- NULL = без нижней границы
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- нижняя граница проверяется триггером проводки (ниже), а не CHECK: нужен явный режим «ниже предела»
  CHECK ((kind = 'loyalty_client') = (unit = 'POINT_CENTI')),
  UNIQUE (kind, owner_type, owner_id)
);

CREATE TABLE journal.ledger_entries (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  posting_id       uuid NOT NULL,                 -- общий у записей одной проводки
  account_id       uuid NOT NULL REFERENCES app.ledger_accounts(id),
  amount           bigint NOT NULL CHECK (amount <> 0),
  balance_after    bigint NOT NULL,               -- ставит триггер, значение из INSERT игнорируется
  entry_type       text NOT NULL,                 -- реестр K3
  basis            text,                          -- основание/комментарий (06 §8: обязателен у расхода)
  branch_id        uuid,                          -- филиал операции; FK → branches в 0008
  ref_type         text,                          -- 'booking' | 'visit' | 'event' | 'repair' | 'certificate' | ...
  ref_id           uuid,
  refs             jsonb NOT NULL DEFAULT '{}',   -- дополнительные ссылки {bookingId, eventId, ...}
  reversal_of      bigint UNIQUE REFERENCES journal.ledger_entries(id),  -- второе сторно невозможно
  idempotency_key  text UNIQUE,                   -- навсегда, ADR 0004
  occurred_at      timestamptz NOT NULL,          -- дата факта (может быть ≤ recorded_at)
  recorded_at      timestamptz NOT NULL DEFAULT now(),
  author_type      text NOT NULL CHECK (author_type IN ('staff','client','system')),
  author_id        uuid,
  limit_override   boolean NOT NULL DEFAULT false,  -- явный режим «ниже предела» (K3 post({ allowBelowLimit }))
  CHECK (reversal_of IS NULL OR basis IS NOT NULL),         -- сторно с причиной (16 §2.7)
  CHECK (NOT limit_override OR (basis IS NOT NULL AND author_type = 'staff'))
);
CREATE INDEX ledger_entries_account_idx ON journal.ledger_entries (account_id, occurred_at, id);  -- стабильный порядок (06 §10)
CREATE INDEX ledger_entries_ref_idx ON journal.ledger_entries (ref_type, ref_id);
-- journal.ledger_entries: yu_app только SELECT/INSERT (default privileges 0001)

-- Баланс меняет ТОЛЬКО триггер проводки: у yu_app нет UPDATE на ledger_accounts, кроме столбца status.
REVOKE UPDATE ON app.ledger_accounts FROM yu_app;
GRANT UPDATE (status) ON app.ledger_accounts TO yu_app;

-- Два BEFORE INSERT триггера; порядок срабатывания – по имени.
-- ledger_entries_10_check_reversal (единственное имя триггера сторно; так же в ADR 0004 и K3):
--   если reversal_of задан – исходная того же account_id, amount = −исходной, исходная сама не сторно.
-- ledger_entries_20_apply_balance (функция SECURITY DEFINER владельца, search_path зафиксирован):
--   SELECT balance, min_balance, status FROM app.ledger_accounts WHERE id = NEW.account_id FOR UPDATE;
--   status = 'closed' → RAISE 'ACCOUNT_CLOSED';
--   new := balance + NEW.amount;
--   min_balance IS NOT NULL AND new < min_balance AND NOT NEW.limit_override
--     → RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ledger_balance_below_limit';
--   NEW.balance_after := new; UPDATE app.ledger_accounts SET balance = new WHERE id = NEW.account_id;
```

### 0005 – outbox (core)

```sql
CREATE TABLE app.outbox_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),   -- = eventId в K4
  event_type     text NOT NULL,           -- 'booking.confirmed'
  event_version  smallint NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id   uuid NOT NULL,
  branch_id      uuid,
  payload        jsonb NOT NULL,
  dedupe_key     text NOT NULL UNIQUE,    -- '<event_type>:<aggregate_id>:<aggregate_version>'
  occurred_at    timestamptz NOT NULL,    -- $now из Clock
  dispatched_at  timestamptz              -- поставлено в pg-boss
);
CREATE INDEX outbox_undispatched_idx ON app.outbox_events (occurred_at) WHERE dispatched_at IS NULL;

CREATE TABLE app.processed_events (
  handler      text NOT NULL,             -- 'notifications.onBookingConfirmed'
  event_id     uuid NOT NULL REFERENCES app.outbox_events(id),
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (handler, event_id)
);
```

### 0006 – staff (staff)

```sql
CREATE TABLE app.staff (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name         text NOT NULL,
  last_name          text NOT NULL,
  email              text NOT NULL UNIQUE CHECK (email = lower(email)),   -- логин (N-05)
  phone_e164         text,
  role               text NOT NULL CHECK (role IN ('owner','director','admin')),   -- 04 §3.2
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked','archived')),
  password_hash      text NOT NULL,                   -- argon2id (17 §7.5)
  must_change_password boolean NOT NULL DEFAULT false, -- после сброса (K12)
  totp_secret_enc    text,                            -- 2FA по желанию (N-05), шифр AES-GCM ключом из окружения
  last_login_at      timestamptz,
  rights_changed_at  timestamptz,                     -- 04 §3.1
  rights_changed_by  uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  row_version        int NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX staff_single_owner_idx ON app.staff ((true)) WHERE role = 'owner' AND status = 'active';  -- решение: один активный Владелец

CREATE TABLE app.staff_sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id       uuid NOT NULL REFERENCES app.staff(id),
  token_hash     text NOT NULL UNIQUE,                -- HMAC-SHA256(token, SESSION_PEPPER)
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,                -- абсолютный предел
  revoked_at     timestamptz,
  revoke_reason  text CHECK (revoke_reason IN ('logout','idle','blocked','admin','password_changed')),
  ip             inet,
  user_agent     text
);
CREATE INDEX staff_sessions_active_idx ON app.staff_sessions (staff_id) WHERE revoked_at IS NULL;

CREATE TABLE app.staff_login_attempts (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email_norm  text NOT NULL CHECK (email_norm = lower(email_norm)),
  staff_id    uuid,
  ip          inet,
  success     boolean NOT NULL,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX staff_login_attempts_idx ON app.staff_login_attempts (email_norm, at);
```
Блокировка сотрудника завершает все его сессии в той же транзакции (`revoke_reason = 'blocked'`, 04 §6.3, 17 §7.4).

### 0007 – staff_assignments (core/permissions)

```sql
CREATE TABLE app.staff_assignments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id     uuid NOT NULL REFERENCES app.staff(id),
  scope_type   text NOT NULL CHECK (scope_type IN ('network','city','branch')),
  city_id      uuid,          -- FK → cities в 0008
  branch_id    uuid,          -- FK → branches в 0008
  valid_from   date NOT NULL,
  valid_to     date,          -- включительно; NULL = бессрочно
  created_by   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz,
  revoked_by   uuid,
  CHECK (
    (scope_type = 'network' AND city_id IS NULL AND branch_id IS NULL) OR
    (scope_type = 'city'    AND city_id IS NOT NULL AND branch_id IS NULL) OR
    (scope_type = 'branch'  AND branch_id IS NOT NULL AND city_id IS NULL)),
  CHECK (valid_to IS NULL OR valid_to >= valid_from),
  EXCLUDE USING gist (
    staff_id WITH =, scope_type WITH =,
    (coalesce(city_id, branch_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
    daterange(valid_from, valid_to, '[]') WITH &&) WHERE (revoked_at IS NULL)
);
```
Изменение срока назначения – отзыв (`revoked_at`) + новая строка; в аудите `staff.assignment.changed` (04 §11.3). Даты назначения – по зоне филиала/города (решение).

### 0008 – network (network)

```sql
CREATE TABLE app.cities (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,                    -- внутренний идентификатор (02 §5.1)
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]+$'),   -- ЧПУ /{city}/ (решение)
  name        text NOT NULL,
  region      text,
  timezone    text NOT NULL,                           -- зона по умолчанию (15 §5.1)
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  comment     text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  row_version int NOT NULL DEFAULT 1
);

CREATE TABLE app.branches (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  city_id            uuid NOT NULL REFERENCES app.cities(id),
  code               text NOT NULL UNIQUE,
  slug               text NOT NULL CHECK (slug ~ '^[a-z0-9-]+$'),
  name               text NOT NULL,
  address            text NOT NULL,
  timezone           text NOT NULL,                     -- по умолчанию копия зоны города при создании (15 §5.2)
  status             text NOT NULL DEFAULT 'preparing'
                     CHECK (status IN ('preparing','active','temporarily_closed','archived')),   -- 02 §6.2, 15 §5.3
  temp_closed_from   timestamptz,
  temp_closed_to     timestamptz,
  temp_close_reason  text,
  phone_public       text,
  public_contacts    jsonb NOT NULL DEFAULT '{}',
  description        text,
  directions         text,                              -- схема прохода
  internal_comment   text,
  opened_on          date,
  closed_on          date,
  sort_order         int NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  archived_at        timestamptz,
  row_version        int NOT NULL DEFAULT 1,
  UNIQUE (city_id, slug),
  CHECK (status <> 'temporarily_closed' OR (temp_closed_from IS NOT NULL AND temp_close_reason IS NOT NULL))
);

CREATE TABLE app.branch_weekly_hours (            -- регулярный график (01 §4.1, 15 §6.1)
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id   uuid NOT NULL REFERENCES app.branches(id),
  weekday     smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),   -- ISO: 1 = Пн
  open_time   time,                                                -- NULL + is_closed = выходной
  close_time  time,
  is_closed   boolean NOT NULL DEFAULT false,
  valid_from  date NOT NULL,                                       -- локальная дата филиала
  valid_to    date,
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (is_closed OR (open_time IS NOT NULL AND close_time IS NOT NULL AND close_time > open_time)),  -- без полуночи (01 §4.1)
  EXCLUDE USING gist (branch_id WITH =, weekday WITH =, daterange(valid_from, valid_to, '[]') WITH &&)
);
-- новый филиал: 7 строк 10:00–22:00 (01 §4 п.1)

ALTER TABLE app.staff_assignments ADD FOREIGN KEY (city_id) REFERENCES app.cities(id);
ALTER TABLE app.staff_assignments ADD FOREIGN KEY (branch_id) REFERENCES app.branches(id);
ALTER TABLE app.ledger_accounts  ADD FOREIGN KEY (branch_id) REFERENCES app.branches(id);
ALTER TABLE journal.ledger_entries   ADD FOREIGN KEY (branch_id) REFERENCES app.branches(id);
```
Смена графика – новая строка с `valid_from` и закрытие старой (`valid_to`), прошлое не переписывается. Сокращение часов – до сохранения список затронутых броней (15 §6.5), с Э1.
Архив города запрещён, пока есть неархивные филиалы (02 §5.2) – проверка в коде + аудит.

### 0009 – settings_values (core/settings)

```sql
CREATE TABLE app.settings_values (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text NOT NULL,                                     -- реестр K7
  level       text NOT NULL CHECK (level IN ('network','city','branch')),   -- 'system' – значение в коде (K7)
  city_id     uuid REFERENCES app.cities(id),
  branch_id   uuid REFERENCES app.branches(id),
  value       jsonb NOT NULL,
  valid_from  timestamptz NOT NULL,
  valid_to    timestamptz,                                       -- NULL = бессрочно; закрытие = возврат к наследованию
  reason      text,
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((level = 'network' AND city_id IS NULL AND branch_id IS NULL) OR
         (level = 'city' AND city_id IS NOT NULL AND branch_id IS NULL) OR
         (level = 'branch' AND branch_id IS NOT NULL AND city_id IS NULL)),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  EXCLUDE USING gist (key WITH =, level WITH =,
    (coalesce(city_id, branch_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
    tstzrange(valid_from, valid_to, '[)') WITH &&)              -- пересечение дат одного уровня (15 §20)
);
```
Строки не удаляются; изменение значения = закрыть текущую (`valid_to = момент`) + вставить новую. История «на дату» – выборка по `valid_from/valid_to` (15 §3.2–3.3).

### 0010 – dictionaries (dictionaries)

```sql
CREATE TABLE app.dict_resource_types (           -- 02 §8.2, 15 §8.1
  code          text PRIMARY KEY,           -- системный код неизменен: 'pc','vr_seat','ps_room','room_whole','composite'
  name          text NOT NULL,
  step_minutes  smallint NOT NULL CHECK (step_minutes > 0 AND 1440 % step_minutes = 0),   -- VR 15, ПК/PS 30 (01 §4)
  bookable      boolean NOT NULL DEFAULT true,
  is_system     boolean NOT NULL DEFAULT false,
  archived_at   timestamptz,
  sort_order    int NOT NULL DEFAULT 0
);
CREATE TABLE app.dict_space_types (             -- 02 §7.1
  code text PRIMARY KEY, name text NOT NULL, is_system boolean NOT NULL DEFAULT false,
  archived_at timestamptz, sort_order int NOT NULL DEFAULT 0
);
CREATE TABLE app.dict_statuses (                -- 15 §16: подписи системных статусов
  domain     text NOT NULL,                 -- 'booking','branch','room','client','hold','notification',...
  code       text NOT NULL,
  name       text NOT NULL,
  PRIMARY KEY (domain, code)
);
CREATE TABLE app.dict_status_transitions (      -- допустимые переходы (15 §16)
  domain text NOT NULL, from_code text NOT NULL, to_code text NOT NULL,
  PRIMARY KEY (domain, from_code, to_code),
  FOREIGN KEY (domain, from_code) REFERENCES app.dict_statuses(domain, code),
  FOREIGN KEY (domain, to_code)   REFERENCES app.dict_statuses(domain, code)
);
CREATE TABLE app.dict_reasons (                 -- причины: отмена, неявка, блокировка, корректировка ...
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain      text NOT NULL CHECK (domain IN ('booking_cancel_club','booking_cancel_client','no_show','visit_correction',
                                              'resource_block','ledger_correction')),
  code        text NOT NULL,
  name        text NOT NULL,
  is_system   boolean NOT NULL DEFAULT false,
  requires_comment boolean NOT NULL DEFAULT false,
  archived_at timestamptz,
  sort_order  int NOT NULL DEFAULT 0,
  UNIQUE (domain, code)
);
```
Системные строки (`is_system = true`) – из сида миграции; изменение `code`/удаление запрещены триггером `dict_protect_system` (S0-13). Пользовательские причины – только архив (15 §3.5).

---

## 3. Этап 1

### 0101 – resources (resources)

```sql
CREATE TABLE app.spaces (                        -- помещение (02 §3.3, §7.1)
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES app.branches(id),
  space_type text NOT NULL REFERENCES app.dict_space_types(code),
  name text NOT NULL, description text, internal_comment text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','unavailable','repair','closed','archived')),
  sort_order int NOT NULL DEFAULT 0, archived_at timestamptz, row_version int NOT NULL DEFAULT 1
);
CREATE TABLE app.rooms (                         -- 02 §7.2
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES app.branches(id),
  space_id uuid REFERENCES app.spaces(id),
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9-]+$'),
  name text NOT NULL, capacity smallint CHECK (capacity > 0),
  public_description text, internal_description text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','unavailable','repair','closed','archived')),  -- 02 §7.3
  is_published boolean NOT NULL DEFAULT false,      -- 02 §7.4
  whole_rent_allowed boolean NOT NULL DEFAULT false,
  sort_order int NOT NULL DEFAULT 0, archived_at timestamptz, row_version int NOT NULL DEFAULT 1,
  UNIQUE (branch_id, slug)
);
CREATE TABLE app.resources (                     -- ресурс бронирования (02 §8.1): то, что выбирает клиент
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES app.branches(id),
  room_id uuid REFERENCES app.rooms(id),
  resource_type text NOT NULL REFERENCES app.dict_resource_types(code),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','unavailable','archived')),
  self_bookable boolean NOT NULL DEFAULT true,      -- «признак самостоятельной брони» (02 §8.1)
  step_minutes_override smallint,                   -- локальное исключение шага (15 §7.2), NULL = шаг типа
  sort_order int NOT NULL DEFAULT 0, internal_comment text,
  archived_at timestamptz, row_version int NOT NULL DEFAULT 1,
  UNIQUE (id, branch_id)                            -- для составных FK
);
```
Закрытие комнаты (`status <> 'active'`) делает недоступными все её ресурсы – проверка в K6 `expandToUnits` (02 §7.3). Число ПК/VR – данные (01 §5.1).

### 0102 – occupancy (resources: единицы и состав; booking: строки занятости)

```sql
CREATE TABLE app.occupancy_units (               -- физическая единица занятости (K6): VR1, VR2, PS4, ПК-3
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES app.branches(id),
  room_id uuid REFERENCES app.rooms(id),
  code text NOT NULL,                       -- 'VR1'
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  UNIQUE (branch_id, code)
);
CREATE TABLE app.resource_units (                -- состав: ресурс → единицы, с периодом действия (02 §8.4)
  resource_id uuid NOT NULL REFERENCES app.resources(id),
  unit_id uuid NOT NULL REFERENCES app.occupancy_units(id),
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  PRIMARY KEY (resource_id, unit_id, valid_from),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  EXCLUDE USING gist (resource_id WITH =, unit_id WITH =, tstzrange(valid_from, valid_to, '[)') WITH &&)
);
CREATE TABLE app.occupancy (                     -- кто занимает единицу на интервал
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id uuid NOT NULL REFERENCES app.occupancy_units(id),
  branch_id uuid NOT NULL REFERENCES app.branches(id),
  period tstzrange NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('hold_item','booking','event')),   -- 'event' – Э3
  source_id uuid NOT NULL,                   -- hold_items.id | bookings.id | events.id
  booking_version int,                       -- для source_type = 'booking'
  hold_expires_at timestamptz,               -- только у hold_item; копия holds.expires_at
  active boolean NOT NULL DEFAULT true,
  released_at timestamptz,
  release_reason text CHECK (release_reason IN ('expired','released','converted','cancelled','rescheduled')),
  CHECK ((source_type = 'hold_item') = (hold_expires_at IS NOT NULL)),
  CHECK (active OR released_at IS NOT NULL),
  CONSTRAINT occupancy_no_overlap
    EXCLUDE USING gist (unit_id WITH =, period WITH &&) WHERE (active)            -- 01 §8, 17 §10
);
CREATE INDEX occupancy_source_idx ON app.occupancy (source_type, source_id) WHERE active;
CREATE INDEX occupancy_branch_period_idx ON app.occupancy USING gist (branch_id, period) WHERE active;
CREATE INDEX occupancy_hold_expiry_idx ON app.occupancy (hold_expires_at) WHERE active AND source_type = 'hold_item';
```
Ключевое правило (01 §5.2, 17 §10; R-01 по умолчанию): бронь «комната целиком» пишет строки на VR1, VR2, PS4; место VR – на свою единицу. Любые две активные строки одной единицы с пересечением отвергает `occupancy_no_overlap` – TC-01…TC-03 гарантирует база.
Истёкшее удержание: `EXCLUDE` не умеет время, поэтому каждая команда занятия **в начале своей транзакции** гасит истёкшие строки на нужных единицах (K6 `releaseExpiredHolds`, с `$now` из Clock), а задача pg-boss гасит остальные раз в 15 с. Все строки команды вставляются одним INSERT в порядке `unit_id` (K6, ADR 0004 §3).

### 0103 – calendar_exceptions (network)

```sql
CREATE TABLE app.calendar_exceptions (           -- 15 §6.2–6.3, 01 §4.1 п.3
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES app.branches(id),
  scope_type text NOT NULL CHECK (scope_type IN ('branch','room','resource')),
  room_id uuid REFERENCES app.rooms(id),
  resource_id uuid REFERENCES app.resources(id),
  local_date date NOT NULL,                   -- дата филиала
  kind text NOT NULL CHECK (kind IN ('closed','short_day','special_hours','holiday','technical')),
  open_time time, close_time time,            -- для short_day / special_hours
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope_type = 'branch' AND room_id IS NULL AND resource_id IS NULL) OR
         (scope_type = 'room' AND room_id IS NOT NULL AND resource_id IS NULL) OR
         (scope_type = 'resource' AND resource_id IS NOT NULL AND room_id IS NULL)),
  CHECK (kind IN ('closed','holiday','technical') OR (open_time IS NOT NULL AND close_time > open_time)),
  EXCLUDE USING gist (branch_id WITH =, scope_type WITH =,
    (coalesce(room_id, resource_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
    local_date WITH =) WHERE (status = 'active')          -- одно исключение на объект и дату: противоречие ловится до сохранения (15 §6.3)
);
```
Приоритет открытых интервалов на дату: ресурс → комната → филиал → `branch_weekly_hours` (15 §6.3). Наследование графика от города/сети – вне Э1 (решение: у филиала всегда свои 7 строк).

### 0104 – resource_blocks (booking)

```sql
CREATE TABLE app.resource_blocks (               -- 01 §13
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES app.branches(id),
  target_type text NOT NULL CHECK (target_type IN ('unit','resource','room','resources')),
  target_ids uuid[] NOT NULL,                   -- что выбрал сотрудник (для показа)
  period tstzrange NOT NULL,
  reason_id uuid NOT NULL REFERENCES app.dict_reasons(id),   -- domain 'resource_block'
  comment text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','lifted')),
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  lifted_at timestamptz, lifted_by uuid, lift_comment text,
  row_version int NOT NULL DEFAULT 1
);
CREATE TABLE app.resource_block_units (          -- развёрнутые единицы на момент создания
  block_id uuid NOT NULL REFERENCES app.resource_blocks(id),
  unit_id uuid NOT NULL REFERENCES app.occupancy_units(id),
  period tstzrange NOT NULL,
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (block_id, unit_id)
);
CREATE INDEX resource_block_units_gist ON app.resource_block_units USING gist (unit_id, period) WHERE active;
```
Блокировка **не** входит в `occupancy` и не конфликтует с бронями: ложится поверх и возвращает список затронутых (01 §13). Новые удержания/брони на заблокированную единицу отвергает проверка K6 в той же транзакции. Гонку «блокировка ↔ удержание» сериализует строка единицы: `occupy` берёт `occupancy_units ... FOR SHARE`, создание блокировки – `FOR UPDATE` (K6 `createBlock`).

### 0105 – clients (clients)

```sql
CREATE TABLE app.clients (                       -- 03 §4.1
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164 text UNIQUE CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),   -- одна карточка на телефон (03 §3 п.1); NULL только после обезличивания
  phone_verified_at timestamptz,               -- до подтверждения – неподтверждённый (03 §5.2)
  first_name text, last_name text,
  email text CHECK (email = lower(email)),
  birth_date date,
  status text NOT NULL DEFAULT 'guest'
    CHECK (status IN ('guest','active','restricted','blocked','deletion_requested','anonymized')),   -- 03 §4.2 + 'guest' (решение, Q-09)
  status_reason text, status_until timestamptz,
  registration_source text CHECK (registration_source IN ('site','crm')),
  registered_at timestamptz,                   -- NULL у guest
  last_login_at timestamptz, last_activity_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by_type text NOT NULL, created_by_id uuid,
  row_version int NOT NULL DEFAULT 1,
  CHECK (phone_e164 IS NOT NULL OR status = 'anonymized')      -- 03 §13, 152-ФЗ (ревью п.11)
);
CREATE INDEX clients_name_idx ON app.clients (lower(last_name), lower(first_name));
CREATE TABLE journal.client_consents (               -- согласия и отказы, только вставка (03 §10, N-01)
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_id uuid NOT NULL REFERENCES app.clients(id),
  kind text NOT NULL CHECK (kind IN ('pd_processing','marketing','reminders')),
  granted boolean NOT NULL,
  document_version text,                      -- версия текста согласия/политики
  source text NOT NULL CHECK (source IN ('site','account','crm')),
  at timestamptz NOT NULL DEFAULT now(),
  actor_type text NOT NULL, actor_id uuid
);
-- journal.client_consents: yu_app только SELECT/INSERT (default privileges 0001); тест – journal.append_only_violations() пуст
CREATE TABLE app.client_notification_prefs (     -- текущее состояние (09 §5)
  client_id uuid PRIMARY KEY REFERENCES app.clients(id),
  reminders_enabled boolean NOT NULL DEFAULT true,
  marketing_enabled boolean NOT NULL DEFAULT false,      -- без подтверждения согласия реклама выключена (09 §5.1)
  updated_at timestamptz NOT NULL DEFAULT now()
);
```
«Бронь без профиля» (10.2, Q-09 по умолчанию): Администратор вводит телефон и имя → находится или создаётся карточка `guest`. Пересечения клиента проверяются по ней же. Вход по коду с этим телефоном переводит карточку в `active` – дубля нет (решение).

### 0106 – client_auth (clients)

```sql
CREATE TABLE app.client_otp_challenges (         -- 03 §5.2
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164 text NOT NULL,
  code_hash text NOT NULL,                     -- HMAC-SHA256(code, SESSION_PEPPER); код в базе и логах не хранится
  expires_at timestamptz NOT NULL,
  attempts smallint NOT NULL DEFAULT 0,
  max_attempts smallint NOT NULL,
  consumed_at timestamptz,
  superseded_at timestamptz,                   -- новый код аннулирует старый
  ip inet,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX client_otp_one_live_idx ON app.client_otp_challenges (phone_e164)
  WHERE consumed_at IS NULL AND superseded_at IS NULL;
CREATE INDEX client_otp_rate_idx ON app.client_otp_challenges (phone_e164, created_at);
CREATE TABLE app.client_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES app.clients(id),
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoke_reason text CHECK (revoke_reason IN ('logout','expired','blocked','compromised')),
  user_agent text
);
```

### 0107 – tariffs (pricing)

```sql
CREATE TABLE app.tariffs (                       -- 15 §9.1–9.3, база Э1: филиал × тип ресурса × длительность
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES app.branches(id),
  resource_type text NOT NULL REFERENCES app.dict_resource_types(code),
  name text NOT NULL,
  unit_minutes smallint NOT NULL CHECK (unit_minutes > 0),     -- единица расчёта
  price_per_unit_kop bigint NOT NULL CHECK (price_per_unit_kop >= 0),
  duration_from_min smallint NOT NULL DEFAULT 0,
  duration_to_min smallint,                                    -- NULL = без верха; диапазон [from, to)
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  priority smallint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','archived')),
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (duration_to_min IS NULL OR duration_to_min > duration_from_min),
  CONSTRAINT tariffs_same_priority_overlap EXCLUDE USING gist (
    branch_id WITH =, resource_type WITH =, priority WITH =,
    int4range(duration_from_min, duration_to_min, '[)') WITH &&,
    tstzrange(valid_from, valid_to, '[)') WITH &&) WHERE (status = 'active')   -- 15 §20: одинаковый приоритет – ошибка до сохранения
);
```
Цена = `ceil(duration / unit_minutes) × price_per_unit_kop` (решение; длительность кратна шагу, у базовых тарифов `unit_minutes = шаг`). Нет тарифа → `TARIFF_NOT_CONFIGURED`, не 0 ₽ (15 §9.3).

### 0108 – holds (booking)

```sql
CREATE TABLE app.holds (                         -- предварительное удержание (01 §7)
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES app.branches(id),
  client_id uuid REFERENCES app.clients(id),       -- NULL, пока посетитель не вошёл
  visitor_id uuid,                             -- кука посетителя сайта (K5)
  created_by_type text NOT NULL CHECK (created_by_type IN ('client','visitor','staff')),
  created_by_id uuid,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','converted','expired','released')),
  ttl_minutes smallint NOT NULL,               -- снимок настройки на момент создания (15 §7.3)
  expires_at timestamptz NOT NULL,             -- общий таймер (01 §7.2)
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  CHECK (client_id IS NOT NULL OR visitor_id IS NOT NULL)
);
CREATE INDEX holds_active_expiry_idx ON app.holds (expires_at) WHERE status = 'active';
CREATE TABLE app.hold_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hold_id uuid NOT NULL REFERENCES app.holds(id),
  resource_id uuid NOT NULL REFERENCES app.resources(id),
  period tstzrange NOT NULL,
  unit_ids uuid[] NOT NULL,                    -- развёрнутый состав на момент удержания
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed','converted','expired')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app.client_time (                   -- время клиента: запрет пересечений по сети (01 §9, 15 §7.4)
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES app.clients(id),
  period tstzrange NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('hold_item','booking')),
  source_id uuid NOT NULL,
  hold_expires_at timestamptz,
  active boolean NOT NULL DEFAULT true,
  released_at timestamptz,
  CONSTRAINT client_time_no_overlap
    EXCLUDE USING gist (client_id WITH =, period WITH &&) WHERE (active)
);
CREATE INDEX client_time_source_idx ON app.client_time (source_type, source_id) WHERE active;
```
Почему отдельная `client_time`, а не `EXCLUDE` по `client_id` в `occupancy` (решение, уточнение плана 3.3): бронь комнаты пишет три строки занятости одного клиента на один интервал – такое ограничение конфликтовало бы с самим собой. Одна строка `client_time` на позицию удержания / бронь. Свои позиции одного удержания идут встык или раздельно (01 §6.4 п.4) и не пересекаются – иначе `CLIENT_OVERLAP`.

### 0109 – bookings (booking)

```sql
CREATE SEQUENCE app.booking_number_seq;
CREATE TABLE app.bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number bigint NOT NULL UNIQUE DEFAULT nextval('app.booking_number_seq'),   -- номер для показа (01 §10.1)
  checkout_id uuid NOT NULL,                  -- общий у броней одного подтверждения (одно намерение)
  branch_id uuid NOT NULL REFERENCES app.branches(id),
  client_id uuid NOT NULL REFERENCES app.clients(id),
  hold_id uuid REFERENCES app.holds(id),          -- NULL у созданной администратором без удержания
  status text NOT NULL DEFAULT 'confirmed'
    CHECK (status IN ('confirmed','arrived','completed','no_show','cancelled_by_client','cancelled_by_club')),   -- Q-07
  current_version int NOT NULL DEFAULT 1,
  -- денормализация текущей версии для списков и календаря:
  resource_id uuid NOT NULL REFERENCES app.resources(id),
  period tstzrange NOT NULL,
  price_kop bigint NOT NULL,
  source text NOT NULL CHECK (source IN ('site','crm')),
  internal_comment text,                       -- клиенту не показывается (03 §8.3)
  created_by_type text NOT NULL, created_by_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz, cancelled_by_type text, cancelled_by_id uuid,
  cancel_reason_id uuid REFERENCES app.dict_reasons(id), cancel_comment text,
  row_version int NOT NULL DEFAULT 1,
  CHECK (status NOT IN ('cancelled_by_club') OR cancel_comment IS NOT NULL),   -- комментарий Администратора обязателен (01 §12)
  CHECK (status NOT LIKE 'cancelled%' OR cancelled_at IS NOT NULL)
);
CREATE INDEX bookings_branch_period_idx ON app.bookings USING gist (branch_id, period);
CREATE INDEX bookings_client_idx ON app.bookings (client_id, created_at);
CREATE INDEX bookings_checkout_idx ON app.bookings (checkout_id);

CREATE TABLE journal.booking_versions (              -- версии: перенос не меняет старую (01 §11, 16 §9); только вставка
  booking_id uuid NOT NULL REFERENCES app.bookings(id),
  version int NOT NULL,
  resource_id uuid NOT NULL REFERENCES app.resources(id),
  period tstzrange NOT NULL,
  branch_timezone text NOT NULL,               -- снимок зоны (ADR 0003 п.8)
  unit_ids uuid[] NOT NULL,                    -- снимок состава конфигурации (02 §8.4, K6)
  resource_snapshot jsonb NOT NULL,            -- {name, type, roomName, branchName, branchAddress} на дату (15 §5.4)
  tariff_id uuid REFERENCES app.tariffs(id),
  price_kop bigint NOT NULL CHECK (price_kop >= 0),
  price_snapshot jsonb NOT NULL,               -- {tariffName, unitMinutes, pricePerUnitKop, units}
  reason text,                                 -- причина переноса
  created_by_type text NOT NULL, created_by_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (booking_id, version)
);
-- journal.booking_versions: yu_app только SELECT/INSERT (default privileges 0001); тест – journal.append_only_violations() пуст
```
Перенос в одной транзакции: гасит `occupancy`/`client_time` старой версии (`release_reason = 'rescheduled'`) → вставляет строки новой → вставляет `booking_versions(v+1)` → обновляет денормализацию `bookings`. Ошибка любой вставки откатывает всё – старая версия остаётся действующей (01 §11 п.2–3).
Переходы статусов (`dict_status_transitions`, domain `booking`): `confirmed → arrived | no_show | cancelled_by_client | cancelled_by_club`; `arrived → completed`; исправления с причиной: `arrived → confirmed`, `no_show → confirmed` (S1-10).

### 0110 – visits (booking)

```sql
CREATE TABLE app.visits (                         -- посещение (16 §5)
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES app.bookings(id),
  branch_id uuid NOT NULL REFERENCES app.branches(id),
  client_id uuid NOT NULL REFERENCES app.clients(id),
  arrived_at timestamptz NOT NULL,
  completed_at timestamptz,
  marked_by uuid NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','reverted')),
  reverted_at timestamptz, reverted_by uuid, revert_reason text,
  CHECK (status = 'active' OR (reverted_at IS NOT NULL AND revert_reason IS NOT NULL))
);
CREATE UNIQUE INDEX visits_one_active_idx ON app.visits (booking_id) WHERE status = 'active';   -- повторная отметка не плодит (S1-10)
CREATE TABLE app.no_shows (                       -- неявка вручную (R-08, 16 §6)
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES app.bookings(id),
  branch_id uuid NOT NULL REFERENCES app.branches(id),
  client_id uuid NOT NULL REFERENCES app.clients(id),
  marked_at timestamptz NOT NULL, marked_by uuid NOT NULL,
  reason_id uuid REFERENCES app.dict_reasons(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','reverted')),
  reverted_at timestamptz, reverted_by uuid, revert_reason text
);
CREATE UNIQUE INDEX no_shows_one_active_idx ON app.no_shows (booking_id) WHERE status = 'active';   -- один штраф на бронь (07 §8.4)
```
Взаимоисключение «посещение / неявка» держит статус брони (переход только из `confirmed`) под `SELECT ... FOR UPDATE` строки `bookings`.

### 0111 – notifications (notifications)

```sql
CREATE TABLE app.push_subscriptions (            -- Web Push (Q-30)
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES app.clients(id),
  endpoint text NOT NULL UNIQUE,
  p256dh text NOT NULL, auth text NOT NULL,    -- ключи подписки: в аудит и логи не попадают
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz, revoke_reason text CHECK (revoke_reason IN ('unsubscribed','gone','logout')),
  last_success_at timestamptz, last_error text
);
CREATE INDEX push_subscriptions_client_idx ON app.push_subscriptions (client_id) WHERE revoked_at IS NULL;
CREATE TABLE app.notifications (                 -- 09 §9
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES app.clients(id),
  branch_id uuid REFERENCES app.branches(id),
  category text NOT NULL CHECK (category IN ('service','reminder','marketing','event_cancel','personal')),   -- 09 §3
  kind text NOT NULL CHECK (kind IN ('booking_confirmed','booking_cancelled','booking_rescheduled',
                                     'reminder_day_before','reminder_before_start')),
  booking_id uuid REFERENCES app.bookings(id),
  booking_version int,
  source text NOT NULL CHECK (source IN ('system','staff')),
  initiator_id uuid,
  title text NOT NULL, body text NOT NULL, url text,
  planned_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'planned' CHECK (status IN (
    'planned','queued','sending','sent_to_provider','delivered','error','cancelled',
    'skipped_by_prefs','skipped_booking_changed','no_channel')),       -- 09 §9; 'delivered' не ставим без подтверждения
  attempts smallint NOT NULL DEFAULT 0,
  sent_at timestamptz, error text, skip_reason text,
  dedupe_key text NOT NULL UNIQUE,             -- '<kind>:<booking_id>:<booking_version>' – один этап на версию (09 §6.4 п.7)
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_due_idx ON app.notifications (planned_at) WHERE status = 'planned';
CREATE INDEX notifications_booking_idx ON app.notifications (booking_id);
```

---

## 4. Ключевые правила → где гарантия

| Правило | ТЗ | Гарантия |
|---|---|---|
| Один слот – одна бронь, комната против места | 01 §8, §5.2; 17 §10 | `occupancy_no_overlap` |
| Клиент без пересечений по сети | 01 §9, 15 §7.4 | `client_time_no_overlap` |
| Истёкшее удержание не держит слот | 01 §7.3–7.4 | гашение в транзакции + задача (K6) |
| Аудит и журналы не правятся | 04 §11.4 | схема `journal` + default privileges 0001, тест `journal.append_only_violations()` |
| Сторно ровно одно | 06 §4.4, 16 §2.7 | `UNIQUE(reversal_of)` + триггер |
| Повтор не создаёт дубль | 16 §2.2 | `idempotency_keys` PK, `ledger_entries.idempotency_key`, `notifications.dedupe_key`, `visits_one_active_idx` |
| Остаток не уходит ниже границы | 07 §3.1, 08 §6.3 | триггер `ledger_entries_20_apply_balance` под `FOR UPDATE` счёта; обход – только `limit_override` с причиной от сотрудника; `yu_app` не может писать `balance` напрямую |
| Два тарифа одного приоритета | 15 §20 | `tariffs_same_priority_overlap` |
| Пересечение дат настройки | 15 §20 | EXCLUDE в `settings_values` |
| Перенос не трогает старую версию | 01 §11 | одна транзакция + `booking_versions` только вставка |
| Смена состава не меняет старые брони | 02 §8.4 | `booking_versions.unit_ids` снимок |
| Комментарий при отмене клубом | 01 §12 | CHECK в `bookings` |
| Один активный Владелец | 04 §4.1 (вывод) | `staff_single_owner_idx` (решение) |

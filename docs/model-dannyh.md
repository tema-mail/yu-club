# Модель данных этапов 0–4

Версия 5 от 04.11.2026: добавлены раздел 4а «Этап 3» (шаг S3-00, миграции 0301–0311) и раздел «Этап 4» в конце файла (шаг S4-00, миграции 0401–0411). Версия 3 от 02.11.2026: добавлен раздел 4 «Этап 2» (шаг S2-00, миграции 0201–0207). Версия 2 от 01.11.2026 (шаг S0-00, правки по architecture-reviewer; сверено с закоммиченными `db/migrations/0001_init.sql`, `db/migrate.ts`, `tests/helpers/pg.ts`). Основа: план 3.3–3.4, 6.1–6.2; ADR 0001–0005.
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

Полиморфные ссылки без FK (решение, с проверкой в коде модуля): `occupancy.source_id` (удержание / бронь / строка `event_resources` Э3), `client_time.source_id`, `audit_events.object_id`, `outbox_events.aggregate_id`, `ledger_entries.ref_id`.

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
  source_id uuid NOT NULL,                   -- hold_items.id | bookings.id | event_resources.id (Э3, K6, правка S3-00)
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
Блокировка **не** входит в `occupancy` и не конфликтует с бронями: ложится поверх и возвращает список затронутых (01 §13). Новые удержания/брони на заблокированную единицу отвергает проверка K6 в той же транзакции. Гонку «блокировка ↔ удержание» сериализует строка единицы: `occupy` берёт `occupancy_units ... FOR NO KEY UPDATE` (решение 01.11), создание блокировки – `FOR UPDATE` (K6 `createBlock`).

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

## 4. Этап 2 – коммерческий контур

Версия от 02.11.2026 (шаг S2-00). Основа: контракты K10 (оплата), K15 (баллы), K16 (сертификаты), K17 (касса), план 6.4.1. Порядок номеров = порядок слияния (план 6.4.1, правило раннера «порядок нарушен»): до первого применения на стенде номера можно переставить – решение техлида при слиянии с правкой этой таблицы и 6.4.1.

| № | Файл | Таблицы | FK наружу (на что) | Отложенные FK, добавляемые здесь | Шаг |
|---|---|---|---|---|---|
| 0201 | `0201_ledger_limit.sql` | – (замена функции `journal.ledger_apply_balance`) | – | – | S2-07 |
| 0202 | `0202_finance.sql` | `finance_categories`, `journal.finance_operations`, `finance_opening_balances`, `finance_periods`; `ledger_accounts.kind` + `cash_branch_noncash`; посев категорий 06 §7.3 | `→ branches`, `→ finance_categories` | – | S2-10 |
| 0203 | `0203_loyalty.sql` | `loyalty_batches`, `journal.loyalty_batch_moves`, `loyalty_accruals`, `loyalty_penalties`, `loyalty_reserves`, `loyalty_issues` | `→ clients`, `→ ledger_entries`, `→ bookings`, `→ holds`, `→ visits`, `→ no_shows`, `→ branches` | – | S2-30 |
| 0204 | `0204_certificates.sql` | `certificates`, `certificate_redemptions`, `journal.certificate_holder_history` | `→ branches`, `→ staff`, `→ clients`, `→ ledger_accounts`, `→ ledger_entries`, `→ finance_operations`, `→ bookings` | – | S2-50 |
| 0205 | `0205_payments.sql` | `payment_sessions`, `payments`, `payment_lines`, `payment_refunds` | `→ bookings`, `→ branches`, `→ clients`, `→ finance_operations`, `→ certificates` | `certificate_redemptions.payment_id → payments`, `loyalty_accruals.payment_id → payments` | S2-20 |
| 0206 | `0206_cash_shifts.sql` | `cash_shifts` | `→ branches`, `→ staff`, `→ finance_operations` | `finance_operations.shift_id → cash_shifts` | S2-16 |
| 0207 | `0207_loyalty_goods.sql` | `loyalty_goods`, `loyalty_goods_branches`, `loyalty_goods_orders` | `→ branches`, `→ clients`, `→ ledger_entries` | – | S2-39 |
| 0208 | `0208_booking_hold_points.sql` | представления booking `booking_hold_points` (удержание + подпись позиций), `booking_hold_point_items` (минуты, тип ресурса) – для резерва баллов K15 §3 (ADR 0002) | – | – | ревизия П8b 02.11 |
| 0209 | `0209_loyalty_reserve_insufficient.sql` | – (CHECK `loyalty_reserves.release_reason` + `insufficient`) | – | – | ревизия П8b 02.11 |
| 0211 | `0211_reports_reconcile.sql` | `reconcile_runs`, `journal.reconcile_discrepancies` (reports); представления владельцев для сверки 16 §14: `rpt_ledger_balances` (core K3), `rpt_loyalty_points`, `rpt_loyalty_batches` (loyalty), `rpt_certificate_balances` (certificates), `rpt_cash_places` (finance) | `→ reconcile_runs` | – | S2-80 |

Общие правила Э2 (решение, продолжают раздел 0):
- Деньги – `bigint` копейки, баллы – `bigint` сотые (`*_kop`, `*_centi`); суммы операций > 0, знак – в `direction` или в записи K3.
- Баланс и остаток считает только K3 (`ledger_entries`): таблицы модулей хранят бизнес-смысл и ссылку на запись (`ledger_entry_id`, `posting_id`); кэши (`remaining_centi` партий) сверяет ночная задача S2-80.
- Журнальные таблицы (`journal.*`) – только вставка; изменяемые статусы живут в `app.*`.
- `payment_id` в 0203/0204 – `uuid` без FK до 0205 (FK вперёд – в миграции цели, раздел 1).
- Каждая миграция – вверх, вниз, вверх на чистой базе; `down` удаляет ровно то, что создал `up` (0201 – возвращает функцию 0004).
- DDL ниже нормативен так же, как разделы 2–3: имена и смысл – контракт; шаг-исполнитель может добавить индексы и уточнить `CHECK`, расхождение с контрактом K10/K15–K17 – правкой этого раздела в том же коммите.

### 0201 – ledger_limit (core)

```sql
-- migrate:up
CREATE OR REPLACE FUNCTION journal.ledger_apply_balance() ...  -- тело 0004, одно изменение:
--   IF acc.min_balance IS NOT NULL AND NEW.amount < 0 AND next_balance < acc.min_balance AND NOT NEW.limit_override THEN
--     RAISE ... CONSTRAINT = 'ledger_balance_below_limit' ...
-- migrate:down
CREATE OR REPLACE FUNCTION journal.ledger_apply_balance() ...  -- тело 0004 без изменения
```
Почему (K15 §1, ревью 02.11): ниже предела счёт попадает только записью с `limit_override` (Владелец); при таком балансе любая запись, после которой баланс всё ещё ниже предела, отклонялась – не проходили начисление, возврат, сторно штрафа. Предел защищает от списаний, приход его не нарушает. `SECURITY DEFINER`, `search_path` и `REVOKE ALL … FROM PUBLIC` – как в 0004.

### 0202 – finance (finance)

```sql
ALTER TABLE app.ledger_accounts DROP CONSTRAINT ledger_accounts_kind_check;
ALTER TABLE app.ledger_accounts ADD CONSTRAINT ledger_accounts_kind_check
  CHECK (kind IN ('cash_branch','cash_branch_noncash','loyalty_client','certificate','staff_payroll'));   -- K17 §2

CREATE TABLE app.finance_categories (            -- справочник сети (06 §7, K17 §5)
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('income','expense')),
  parent_id uuid REFERENCES app.finance_categories(id),   -- два уровня; третий запрещает триггер finance_categories_depth
  name text NOT NULL,
  sort_order int NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  row_version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (kind, parent_id, name)
);

CREATE SEQUENCE app.finance_operation_number_seq;
CREATE TABLE journal.finance_operations (         -- операция кассы = заголовок одной проводки K3; только вставка (K17 §3)
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number bigint NOT NULL UNIQUE DEFAULT nextval('app.finance_operation_number_seq'),
  branch_id uuid NOT NULL REFERENCES app.branches(id),
  kind text NOT NULL CHECK (kind IN ('opening_balance','income','expense','withdrawal','place_transfer','refund','correction','reversal')),
  place text NOT NULL CHECK (place IN ('cash','noncash')),   -- для place_transfer – место-источник
  method text CHECK (method IN ('cash','card','transfer')),
  direction text NOT NULL CHECK (direction IN ('in','out')),
  amount_kop bigint NOT NULL CHECK (amount_kop > 0),
  source text CHECK (source IN ('session','certificate_sale','event','extra_service','other')),
  category_id uuid REFERENCES app.finance_categories(id),
  subcategory_id uuid REFERENCES app.finance_categories(id),
  comment text,
  ref_type text CHECK (ref_type IN ('booking','payment','certificate','event','repair','staff','operation','shift')),
  ref_id uuid,
  receipt_issued boolean,                            -- Q-23 «чек пробит»
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  author_type text NOT NULL CHECK (author_type IN ('staff','system')),
  author_id uuid,
  posting_id uuid NOT NULL UNIQUE,                   -- 1 операция = 1 проводка K3
  reversal_of uuid UNIQUE REFERENCES journal.finance_operations(id),   -- второе сторно невозможно
  shift_id uuid,                                     -- FK → cash_shifts добавит 0206
  CHECK ((kind = 'income') = (source IS NOT NULL)),
  CHECK (kind <> 'expense' OR category_id IS NOT NULL),
  CHECK (kind NOT IN ('expense','withdrawal','correction','reversal','refund') OR comment IS NOT NULL),   -- 06 §8, K17 §3
  CHECK ((kind = 'reversal') = (reversal_of IS NOT NULL)),
  CHECK (kind <> 'withdrawal' OR place = 'cash'),
  CHECK (method IS NULL OR (method = 'cash') = (place = 'cash'))   -- наличные – только место cash; карта и перевод – только noncash
);
CREATE INDEX finance_operations_branch_idx ON journal.finance_operations (branch_id, occurred_at, number);   -- порядок журнала (06 §10)
CREATE INDEX finance_operations_ref_idx ON journal.finance_operations (ref_type, ref_id);

CREATE TABLE app.finance_opening_balances (       -- один начальный остаток на место (06 §3.1, K17 §4)
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES app.branches(id),
  place text NOT NULL CHECK (place IN ('cash','noncash')),
  operation_id uuid NOT NULL UNIQUE REFERENCES journal.finance_operations(id),
  balance_date date NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','reversed')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX finance_opening_balances_one_active ON app.finance_opening_balances (branch_id, place) WHERE status = 'active';

CREATE TABLE app.finance_periods (                -- закрытые месяцы (06 §8, §14; K17 §6); открыть нельзя – нет UPDATE/DELETE у yu_app
  branch_id uuid NOT NULL REFERENCES app.branches(id),
  month date NOT NULL CHECK (extract(day FROM month) = 1),   -- первое число месяца по зоне филиала
  closed_at timestamptz NOT NULL,
  closed_by uuid NOT NULL,
  PRIMARY KEY (branch_id, month)
);
REVOKE UPDATE, DELETE ON app.finance_periods FROM yu_app;
-- посев: категории расходов 06 §7.3 (8 категорий с подкатегориями по списку) – предложение, не закрытый перечень (6.4.3 п.13)
```
Места денег – счета K3 `cash_branch` (наличные) и `cash_branch_noncash` (безнал), `owner_type='branch'`, `owner_id = branch_id`, `min_balance NULL`: третье место того же вида невозможно – `UNIQUE (kind, owner_type, owner_id)` из 0004. Отрицательный остаток проверяет код под `lockAccounts` по `finance.negative_balance_allowed` (K17 §6). Тест S2-10: `UPDATE`/`DELETE journal.finance_operations` от `yu_app` → `42501`.

### 0203 – loyalty (loyalty)

```sql
CREATE TABLE app.loyalty_batches (                -- партии баллов поверх K3 (K15 §2)
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES app.clients(id),
  source text NOT NULL CHECK (source IN ('visit','manual')),
  accrual_entry_id bigint NOT NULL UNIQUE REFERENCES journal.ledger_entries(id),
  branch_id uuid REFERENCES app.branches(id),
  booking_id uuid REFERENCES app.bookings(id),
  visit_id uuid REFERENCES app.visits(id),
  amount_centi bigint NOT NULL CHECK (amount_centi > 0),
  remaining_centi bigint NOT NULL CHECK (remaining_centi >= 0 AND remaining_centi <= amount_centi),   -- кэш, сверка 16 §14
  expires_at timestamptz,                            -- NULL – бессрочно (Q-43)
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','depleted','expired')),
  accrued_at timestamptz NOT NULL
);
CREATE INDEX loyalty_batches_fefo_idx ON app.loyalty_batches (client_id, expires_at NULLS LAST, accrued_at, id) WHERE status = 'active';

CREATE TABLE journal.loyalty_batch_moves (         -- движения партий; только вставка
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES app.loyalty_batches(id),
  ledger_entry_id bigint NOT NULL REFERENCES journal.ledger_entries(id),
  kind text NOT NULL CHECK (kind IN ('spend_time','spend_goods','penalty','expire','return','debt_cover','manual','accrual_reversal')),
  delta_centi bigint NOT NULL CHECK (delta_centi <> 0),
  ref_type text, ref_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX loyalty_batch_moves_entry_idx ON journal.loyalty_batch_moves (ledger_entry_id);

CREATE TABLE app.loyalty_accruals (               -- одно начисление на бронь (K15 §4)
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES app.clients(id),
  booking_id uuid NOT NULL REFERENCES app.bookings(id),
  visit_id uuid NOT NULL REFERENCES app.visits(id),
  payment_id uuid NOT NULL,                          -- FK → payments добавит 0205
  ledger_entry_id bigint NOT NULL UNIQUE REFERENCES journal.ledger_entries(id),
  amount_centi bigint NOT NULL CHECK (amount_centi > 0),
  planned_minutes int NOT NULL CHECK (planned_minutes > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','reversed')),
  reversal_entry_id bigint REFERENCES journal.ledger_entries(id),
  reversal_reason text CHECK (reversal_reason IN ('visit_reverted','payment_refunded')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX loyalty_accruals_one_active ON app.loyalty_accruals (booking_id) WHERE status = 'active';

CREATE TABLE app.loyalty_penalties (              -- штраф за неявку, в том числе applied = 0 (K15 §5)
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES app.clients(id),
  booking_id uuid NOT NULL REFERENCES app.bookings(id),
  no_show_id uuid NOT NULL UNIQUE REFERENCES app.no_shows(id),
  branch_id uuid NOT NULL REFERENCES app.branches(id),
  applied_centi bigint NOT NULL CHECK (applied_centi BETWEEN -500 AND 0),
  ledger_entry_id bigint REFERENCES journal.ledger_entries(id),   -- NULL при applied = 0 (K3 запрещает нулевую запись)
  group_booking_id uuid REFERENCES app.bookings(id),  -- merged: бронь, на которой стоит штраф цепочки (scope 'visit')
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','merged','reversed','skipped')),   -- skipped – неявка раньше penalties_from
  reversal_entry_id bigint REFERENCES journal.ledger_entries(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((applied_centi = 0) = (ledger_entry_id IS NULL))
);
CREATE UNIQUE INDEX loyalty_penalties_one_active ON app.loyalty_penalties (booking_id) WHERE status = 'active';

CREATE TABLE app.loyalty_reserves (               -- резерв на время удержания и брони (K15 §3)
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES app.clients(id),
  amount_centi bigint NOT NULL CHECK (amount_centi > 0),
  hold_id uuid REFERENCES app.holds(id),
  booking_id uuid REFERENCES app.bookings(id),
  hold_signature text,                               -- sha256 отсортированных hold_item.id
  status text NOT NULL CHECK (status IN ('hold','booking','spent','released','converted')),
  release_reason text CHECK (release_reason IN ('hold_expired','hold_released','hold_changed','booking_cancelled','no_show',
                                                'rescheduled_short','replaced','paid_other')),
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  CHECK (status <> 'hold' OR (hold_id IS NOT NULL AND hold_signature IS NOT NULL)),
  CHECK (status <> 'booking' OR booking_id IS NOT NULL),
  CHECK ((status = 'released') = (release_reason IS NOT NULL))
);
CREATE UNIQUE INDEX loyalty_reserves_one_per_hold ON app.loyalty_reserves (hold_id) WHERE status = 'hold';
CREATE UNIQUE INDEX loyalty_reserves_one_per_booking ON app.loyalty_reserves (booking_id) WHERE status = 'booking';
CREATE INDEX loyalty_reserves_client_idx ON app.loyalty_reserves (client_id) WHERE status IN ('hold','booking');

CREATE TABLE app.loyalty_issues (                 -- «требует решения»: сторно ниже −50 (K15 §4)
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES app.clients(id),
  kind text NOT NULL CHECK (kind IN ('accrual_reversal_below_limit')),
  ref_type text NOT NULL CHECK (ref_type IN ('visit','payment_refund')),
  ref_id uuid NOT NULL,
  amount_centi bigint NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  resolved_entry_id bigint REFERENCES journal.ledger_entries(id),
  resolved_by uuid, resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, ref_type, ref_id)
);
```
Инвариант (K15 §2): `Σ remaining_centi активных партий = max(0, баланс K3)` – проверяют property-based тест S2-30 и ночная сверка S2-80. Счёт баллов – K3 `loyalty_client`, `min_balance = −5000`, `branch_id NULL` (счёт на сеть).

### 0204 – certificates (certificates)

```sql
CREATE TABLE app.certificates (                   -- K16 §10
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE CHECK (number ~ '^YC-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$'),   -- 8 символов Crockford Base32 (K16 §3), вид 'YC-7K2M-9QXD' (K16 §1)
  pin_hash text NOT NULL,                            -- HMAC-SHA256(id || ':' || pin, CERT_PEPPER), hex (K16 §3, правка 03.11)
  pin_failed_count smallint NOT NULL DEFAULT 0,
  pin_locked_until timestamptz,
  nominal_kop bigint NOT NULL CHECK (nominal_kop > 0),
  sale_branch_id uuid NOT NULL REFERENCES app.branches(id),
  sale_method text NOT NULL CHECK (sale_method IN ('cash','card','transfer')),
  sale_operation_id uuid NOT NULL UNIQUE REFERENCES journal.finance_operations(id),
  ledger_account_id uuid NOT NULL UNIQUE REFERENCES app.ledger_accounts(id),
  sold_at timestamptz NOT NULL,
  sold_by uuid NOT NULL REFERENCES app.staff(id),
  expires_on date NOT NULL,                          -- последний день по зоне филиала продажи
  expires_at timestamptz NOT NULL,                   -- начало следующих суток там же
  expired_entry_id bigint REFERENCES journal.ledger_entries(id),
  cancelled_at timestamptz, cancel_reason text,
  review_reason text,                                -- не NULL – «требует проверки»
  buyer_client_id uuid REFERENCES app.clients(id),
  recipient_client_id uuid REFERENCES app.clients(id),
  comment text,
  row_version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((cancelled_at IS NULL) = (cancel_reason IS NULL))
);
CREATE INDEX certificates_expiry_idx ON app.certificates (expires_at) WHERE expired_entry_id IS NULL AND cancelled_at IS NULL;
-- неизменяемые поля (08 §15): как у tariffs (0107)
REVOKE UPDATE ON app.certificates FROM yu_app;
GRANT UPDATE (pin_hash, pin_failed_count, pin_locked_until, expired_entry_id, cancelled_at, cancel_reason, review_reason,
              recipient_client_id, comment, row_version) ON app.certificates TO yu_app;

CREATE TABLE app.certificate_redemptions (        -- погашение = строка оплаты K10
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  certificate_id uuid NOT NULL REFERENCES app.certificates(id),
  booking_id uuid NOT NULL REFERENCES app.bookings(id),
  payment_id uuid NOT NULL,                          -- FK → payments добавит 0205
  branch_id uuid NOT NULL REFERENCES app.branches(id),   -- филиал сеанса
  client_id uuid REFERENCES app.clients(id),
  amount_kop bigint NOT NULL CHECK (amount_kop > 0),
  ledger_entry_id bigint NOT NULL UNIQUE REFERENCES journal.ledger_entries(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','returned','not_restored')),
  return_entry_id bigint REFERENCES journal.ledger_entries(id),
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'returned' OR return_entry_id IS NOT NULL)
);
CREATE INDEX certificate_redemptions_cert_idx ON app.certificate_redemptions (certificate_id);

CREATE TABLE journal.certificate_holder_history ( -- смена получателя (08 §7); только вставка
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  certificate_id uuid NOT NULL REFERENCES app.certificates(id),
  old_client_id uuid, new_client_id uuid,
  changed_by uuid NOT NULL,
  changed_at timestamptz NOT NULL
);
```
Остаток – только счёт K3 `kind='certificate'`, `min_balance = 0` (K16 §1): столбца остатка нет. Код (`pin`) и его хэш не попадают в `idempotency_keys`, аудит и логи (K16 §3, S2-08). Тест S2-50: `UPDATE certificates SET nominal_kop` от `yu_app` → `42501`.

### 0205 – payments (finance)

```sql
CREATE TABLE app.payment_sessions (               -- сеанс оплаты = бронь (K10 §1, §3)
  booking_id uuid PRIMARY KEY REFERENCES app.bookings(id),
  branch_id uuid NOT NULL REFERENCES app.branches(id),
  client_id uuid NOT NULL REFERENCES app.clients(id),
  amount_due_kop bigint NOT NULL CHECK (amount_due_kop >= 0),
  booking_version int NOT NULL,
  status text NOT NULL DEFAULT 'unpaid' CHECK (status IN ('unpaid','paid','partially_refunded','refunded')),
  row_version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app.payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES app.payment_sessions(booking_id),
  attempt int NOT NULL CHECK (attempt >= 1),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','partially_refunded','refunded')),
  total_kop bigint NOT NULL CHECK (total_kop >= 0),
  topup_rule_snapshot boolean NOT NULL,              -- флаг R-03 на момент проведения (K10 §2)
  recorded_by uuid NOT NULL, recorded_at timestamptz NOT NULL,
  comment text,
  UNIQUE (session_id, attempt)
);
CREATE UNIQUE INDEX payments_one_live_per_session ON app.payments (session_id) WHERE status IN ('active','partially_refunded');   -- TC-07
CREATE TABLE app.payment_lines (
  payment_id uuid NOT NULL REFERENCES app.payments(id),
  line_no smallint NOT NULL CHECK (line_no IN (1, 2)),
  method text NOT NULL CHECK (method IN ('cash','card','transfer','points','certificate')),
  amount_kop bigint NOT NULL CHECK (amount_kop > 0),
  points_centi bigint CHECK (points_centi > 0),
  certificate_id uuid REFERENCES app.certificates(id),
  ledger_posting_id uuid NOT NULL,
  finance_operation_id uuid REFERENCES journal.finance_operations(id),
  PRIMARY KEY (payment_id, line_no),
  CHECK ((method = 'points') = (points_centi IS NOT NULL)),
  CHECK ((method = 'certificate') = (certificate_id IS NOT NULL)),
  CHECK ((method IN ('cash','card','transfer')) = (finance_operation_id IS NOT NULL))
);
-- триггер payment_lines_pair (BEFORE INSERT): строка 2 допустима, только если строка 1 – certificate, а строка 2 – cash|card|transfer (K10 §3)
CREATE TABLE app.payment_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL REFERENCES app.payments(id),
  line_no smallint NOT NULL,
  seq int NOT NULL,                                  -- n в ключе K3 refund:<paymentId>:<lineNo>:<n>
  amount_kop bigint NOT NULL CHECK (amount_kop >= 0),
  points_centi bigint,
  reason text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('returned','not_restored')),
  ledger_posting_id uuid,                            -- NULL при not_restored
  created_by uuid NOT NULL, created_at timestamptz NOT NULL,
  FOREIGN KEY (payment_id, line_no) REFERENCES app.payment_lines(payment_id, line_no),
  UNIQUE (payment_id, line_no, seq),
  CHECK ((outcome = 'returned') = (ledger_posting_id IS NOT NULL))
);
-- отложенные FK (раздел 1): payments появились здесь
ALTER TABLE app.certificate_redemptions ADD CONSTRAINT certificate_redemptions_payment_fk FOREIGN KEY (payment_id) REFERENCES app.payments(id);
ALTER TABLE app.loyalty_accruals ADD CONSTRAINT loyalty_accruals_payment_fk FOREIGN KEY (payment_id) REFERENCES app.payments(id);
```
Способ `none` (сумма 0) – платёж без строк (`total_kop = 0`) и без проводки (K10 §2). Статус оплаты брони живёт здесь, в `bookings` столбцов оплаты нет (ADR 0002 п.1).

### 0206 – cash_shifts (finance)

```sql
CREATE TABLE app.cash_shifts (                    -- кассовая смена за флагом finance.cash_shift_enabled (K17 §7)
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES app.branches(id),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','needs_resolution','resolved')),
  opened_by uuid NOT NULL REFERENCES app.staff(id), opened_at timestamptz NOT NULL,
  opening_counted_kop bigint NOT NULL CHECK (opening_counted_kop >= 0),
  opening_expected_kop bigint NOT NULL,              -- Администратору не показывается
  closed_by uuid REFERENCES app.staff(id), closed_at timestamptz,
  closing_counted_kop bigint CHECK (closing_counted_kop >= 0),
  closing_expected_kop bigint,
  resolution text CHECK (resolution IN ('correct','accept')),
  resolution_reason text,
  resolution_operation_id uuid REFERENCES journal.finance_operations(id),
  resolved_by uuid REFERENCES app.staff(id), resolved_at timestamptz,
  row_version int NOT NULL DEFAULT 1,
  CHECK (status = 'open' OR (closed_at IS NOT NULL AND closing_counted_kop IS NOT NULL)),
  CHECK (resolution IS NULL OR resolution_reason IS NOT NULL)
);
CREATE UNIQUE INDEX cash_shifts_one_open ON app.cash_shifts (branch_id) WHERE status = 'open';
ALTER TABLE journal.finance_operations ADD CONSTRAINT finance_operations_shift_fk FOREIGN KEY (shift_id) REFERENCES app.cash_shifts(id);
```

### 0207 – loyalty_goods (loyalty)

```sql
CREATE TABLE app.loyalty_goods (                  -- товары за баллы (07 §7, K15 §6)
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL, description text, image_url text,
  price_rub_kop bigint CHECK (price_rub_kop >= 0),   -- цены в рублях и в баллах – раздельно, без пересчёта (07 §7.1)
  price_points_centi bigint NOT NULL CHECK (price_points_centi > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  row_version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app.loyalty_goods_branches (         -- где выдаётся и остаток
  goods_id uuid NOT NULL REFERENCES app.loyalty_goods(id),
  branch_id uuid NOT NULL REFERENCES app.branches(id),
  stock int CHECK (stock >= 0),                      -- NULL – остаток не ведётся
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (goods_id, branch_id)
);
CREATE TABLE app.loyalty_goods_orders (           -- выдача только целиком (Q-47)
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  goods_id uuid NOT NULL REFERENCES app.loyalty_goods(id),
  branch_id uuid NOT NULL REFERENCES app.branches(id),
  client_id uuid NOT NULL REFERENCES app.clients(id),
  price_points_centi bigint NOT NULL CHECK (price_points_centi > 0),   -- снимок цены
  spend_entry_id bigint NOT NULL UNIQUE REFERENCES journal.ledger_entries(id),
  status text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','returned')),
  return_entry_id bigint REFERENCES journal.ledger_entries(id),
  return_reason text,
  issued_by uuid NOT NULL, issued_at timestamptz NOT NULL,
  CHECK (status <> 'returned' OR return_reason IS NOT NULL)
);
```

### Ключевые правила Э2 → где гарантия

| Правило | ТЗ / контракт | Гарантия |
|---|---|---|
| Один живой платёж на сеанс | 06 §5.1, TC-07; K10 §3 | `payments_one_live_per_session` |
| Только пара «сертификат + деньги» | K10 §2–3 | триггер `payment_lines_pair` + код правила способа |
| Одно начисление на бронь | 07 §4.4, TC-09; K15 §4 | `loyalty_accruals_one_active` + ключ K3 `loyalty-accrual:<visitId>:<paymentId>` |
| Один штраф на бронь | 07 §8.4; K15 §5 | `loyalty_penalties_one_active`, `UNIQUE (no_show_id)`, ключ `loyalty-penalty:<noShowId>` |
| Резерв один на удержание и на бронь | K15 §3 | `loyalty_reserves_one_per_hold`, `loyalty_reserves_one_per_booking` |
| Остаток сертификата ≥ 0 | 08 §6.3, 16 §8.2 | счёт K3 `min_balance = 0` + триггер под `FOR UPDATE` |
| Начисление и возврат проходят ниже предела | K15 §1 | 0201: предел – только у `amount < 0` |
| Номинал, срок, номер сертификата не меняются | 08 §15 | `REVOKE UPDATE` + список разрешённых столбцов |
| Операции кассы не правятся, сторно одно | 06 §4.4, §17 п.15 | `journal.finance_operations` только вставка, `UNIQUE (reversal_of)` |
| Начальный остаток один на место | 06 §3.1 | `finance_opening_balances_one_active` |
| Одна открытая смена | K17 §7 | `cash_shifts_one_open` |
| Закрытый месяц не открывается | K17 §6 | у `yu_app` нет `UPDATE`/`DELETE` на `finance_periods` |

---


## 4а. Этап 3 – управление клубом (внесено S3-00, 04.11.2026)

Порядок и FK – план 6.5.1 (таблица миграций 0301–0311); правило номеров 03xx/04xx – там же. Полный DDL таблиц смен, оборудования и мероприятий – в контрактах-владельцах (K18 §13, K19 §13, K20 §14): он нормативен так же, как DDL этого файла; здесь – владельцы, ключевые ограничения и то, что контракты не описывают. 0301 и 0302 даны целиком – их пишет подготовка (S3-05, S3-06).

| № | Модуль | Таблицы | Ключевые гарантии |
|---|---|---|---|
| 0301 | finance | `finance_operation_links` | `finance_operation_links_one_live` – одна живая связь на операцию (K17 §14) |
| 0302 | core (`core/files.ts`) | `attachments` | содержимое не меняется (`REVOKE UPDATE` + список столбцов), `DELETE` отозван, версия – новой строкой `supersedes` |
| 0303 | shifts (+ столбцы `staff` – модуль staff) | `staff.employment_start/_end`, `staff.planning_status`, `staff.manager_comment`, `journal.staff_rates`, `payroll_periods`, `staff_shifts`, `journal.staff_shift_changes`, `staff_shift_change_acks` | `staff_shifts_no_overlap` (EXCLUDE по сотруднику во всех филиалах, TC-15); периоды не пересекаются (EXCLUDE); ставки – только вставка |
| 0304 | equipment | `equipment_categories` (посев 10 §3.2), `equipment_items`, `equipment_placements`, `equipment_accounts`; `equipment_inventory_seq`, `repair_number_seq` | одно текущее размещение (`equipment_placements_current`); единица и комната – составным FK того же филиала |
| 0305 | events | `event_types` (посев), `event_packages`, `events`, `event_lines`, `event_checklist`, `event_resources`, `event_bookings`; `event_number_seq`, `gift_number_seq` | бронь связана не больше чем с одним мероприятием (`UNIQUE booking_id`); занятость – строками K6 `source_type='event'` |
| 0306 | shifts | `payroll_statements`, `payroll_penalties`, `journal.payroll_accruals`; CHECK `ledger_entry_type_known` пересоздаётся с `payroll.bonus` | одно начисление на версию факта (`UNIQUE (shift_id, fact_version)`), ведомость одна на период и сотрудника |
| 0307 | equipment | `repair_executors`, `repairs`, `journal.repair_status_history`, `repair_blocks`, `equipment_warranties` | блокировка принадлежит одному ремонту (`UNIQUE block_id`); закрытие требует суммы или «без затрат» (CHECK) |
| 0308 | network | `holiday_dates` | одна активная дата на (уровень, город, день) |
| 0309 | events | `birthday_gifts`, `gift_uses` | один подарок клиенту в 365 дней (`EXCLUDE`); одна живая запись по подарку (`gift_uses_one_live`) |
| 0310 | core/permissions | `staff_grants` | действие из закрытого списка `DELEGABLE` (CHECK), зона city/branch (CHECK как `staff_assignments`) |
| 0311 | модули Э3 + finance | представления `rpt_events`, `rpt_event_money`, `rpt_repair_money`, `rpt_shifts`, `rpt_shift_gaps`, `rpt_payroll`, `rpt_equipment`, `rpt_repairs` (поля – K20 §11); CHECK `reconcile_discrepancies.check_name` – полный список | читаются ролью отчётов, а не таблицы модулей (ADR 0002) |
| 0312 | finance | `finance_categories.code = 'salary'` у посева «Персонал» – «Зарплата» | код неизменен (триггер 0210); по нему расход выплаты и привязка ручного расхода, K18 §9 |

### 0301 – finance_links (finance)

```sql
CREATE TABLE app.finance_operation_links (       -- K17 §14: операция кассы ↔ объект Э3
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id  uuid NOT NULL REFERENCES journal.finance_operations(id),
  branch_id     uuid NOT NULL REFERENCES app.branches(id),   -- филиал операции (scopeFilter, отчёты)
  ref_type      text NOT NULL CHECK (ref_type IN ('event','repair','payroll_statement')),
  ref_id        uuid NOT NULL,                                -- полиморфная ссылка без FK (как occupancy.source_id)
  role          text NOT NULL CHECK (role IN ('income','refund','expense','payout_expense')),
  in_cost       boolean NOT NULL DEFAULT false,               -- расход мероприятия в себестоимость (K20 §6)
  line_id       uuid,                                         -- строка состава мероприятия; FK → event_lines добавит 0305
  linked_by     uuid NOT NULL, linked_at timestamptz NOT NULL,
  unlinked_at   timestamptz, unlinked_by uuid, unlink_reason text,
  CHECK ((unlinked_at IS NULL) = (unlink_reason IS NULL)),
  CHECK ((unlinked_at IS NULL) = (unlinked_by IS NULL))
);
CREATE UNIQUE INDEX finance_operation_links_one_live ON app.finance_operation_links (operation_id) WHERE unlinked_at IS NULL;
CREATE INDEX finance_operation_links_ref_idx ON app.finance_operation_links (ref_type, ref_id) WHERE unlinked_at IS NULL;
REVOKE UPDATE, DELETE, TRUNCATE ON app.finance_operation_links FROM yu_app;
GRANT UPDATE (unlinked_at, unlinked_by, unlink_reason) ON app.finance_operation_links TO yu_app;
```

Решение (D3-03): `line_id` без FK в 0301 – `event_lines` появляется в 0305; отложенный FK добавляет 0305 (смотрит назад, правило §1).

### 0302 – attachments (core)

```sql
CREATE TABLE app.attachments (                   -- закрытые вложения Э3 (K19 §9); файл – в ATTACHMENTS_DIR по sha256
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_type      text NOT NULL CHECK (owner_type ~ '^[a-z][a-z_]{1,30}$'),   -- реестр registerAttachmentOwner
  owner_id        uuid NOT NULL,                                               -- полиморфная ссылка без FK
  doc_type        text NOT NULL CHECK (doc_type IN ('photo','receipt','check','invoice','act','warranty_card','waybill','service_report','other')),
  storage_key     text NOT NULL CHECK (storage_key ~ '^[0-9a-f]{2}/[0-9a-f]{64}$'),
  sha256          text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes      bigint NOT NULL CHECK (size_bytes > 0),
  mime_type       text NOT NULL,                                               -- по сигнатуре, не по заявлению клиента
  original_name   text CHECK (char_length(original_name) <= 255),              -- только подпись; путь из него не строится
  comment         text,
  supersedes      uuid UNIQUE REFERENCES app.attachments(id),                  -- новая версия; у версии один наследник
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','invalid')),
  invalid_reason  text, invalidated_by uuid, invalidated_at timestamptz,
  created_by_type text NOT NULL, created_by_id uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'invalid') = (invalid_reason IS NOT NULL)),
  CHECK (invalid_reason IS NULL OR btrim(invalid_reason) <> '')
);
CREATE INDEX attachments_owner_idx ON app.attachments (owner_type, owner_id, created_at);
REVOKE UPDATE, DELETE, TRUNCATE ON app.attachments FROM yu_app;
GRANT UPDATE (status, invalid_reason, invalidated_by, invalidated_at) ON app.attachments TO yu_app;
```

Файл пишется до вставки строки (адрес по содержимому, повтор того же файла – тот же ключ); откат транзакции оставляет на диске файл без строки – безвреден и убирается уборкой Э4 (решение D3-06). Бэкап и проверка «каждый живой `storage_key` есть на диске» – S3-94.

### Ключевые правила Э3 → где гарантия

| Правило | ТЗ / контракт | Гарантия |
|---|---|---|
| Смены сотрудника не пересекаются ни в одном филиале | 05 §5.4, TC-15; K18 §4 | `staff_shifts_no_overlap` |
| Одна операция кассы – один объект | 10 §9.1, 11 §8.4; K17 §14 | `finance_operation_links_one_live` |
| Начисление за смену – одно на версию факта | 16 §2.6; K18 §6 | `UNIQUE (shift_id, fact_version)` + ключ K3 |
| Подарок – один в 365 дней, одна живая запись | R-09; K20 §8 | `birthday_gifts_one_per_year`, `gift_uses_one_live` |
| Мероприятие против брони VR-места | TC-13; K6 | `occupancy_no_overlap` (строки `source_type='event'`) |
| Вложение не заменяется | 10 §11 | `REVOKE UPDATE` содержимого, версия – `supersedes` |

---


## 5. Ключевые правила Э0–Э1 → где гарантия

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

---

## Этап 4 – коммуникации, контент, отчёты (0401–0411)

Версия от 04.11.2026 (шаг S4-00). Основа: контракты K21 (уведомления), K22 (CMS), K23 (SEO), K24 (отчёты), план 6.6.1. Номера 04xx пишутся параллельно с 03xx Э3 по общему правилу 6.5.1/6.6.1: CI каждой ветки – `migrate up` на чистой базе, стенд – `--reset-stage`, окончательный порядок – один раз перед первым выпуском в бой (Э5). Порядок по зависимостям: 0401 → 0402; 0403 → 0404 → 0405; 0406 → 0407 → 0408; 0409 – после 0402 и 0404; 0410 (если нужна) и 0411 – после 0311 и соответствующих 03xx.

| № | Файл | Таблицы и изменения | FK наружу (на что) | Отложенные FK, добавляемые здесь | Шаг |
|---|---|---|---|---|---|
| 0401 | `0401_notifications_center.sql` | `notifications`: `read_at`, `push`, `campaign_id`, `retry_of`, `purpose`; CHECK `category`, `kind`, `status`; индексы центра и частоты; CHECK согласия на рекламу с версией документа в `journal.client_consents` | `notifications.retry_of → notifications` | `notifications.booking_id → bookings` (обещан шапкой 0111, ни одна миграция не добавила) | S4-10 |
| 0402 | `0402_notification_campaigns.sql` | `notification_templates`, `notification_campaigns` (+ триггер неизменности), `journal.notification_campaign_recipients` | `→ branches`, `→ clients`, `→ notification_templates`, `→ staff` | `notifications.campaign_id → notification_campaigns` | S4-12 |
| 0403 | `0403_content_media.sql` | `content_media`, `content_media_usages` | `→ staff` | – | S4-30 |
| 0404 | `0404_content.sql` | `content_publications`, `content_publication_scopes`, `content_games`, `content_game_branches`, `content_room_pages`, `content_branch_pages`, `content_pages`, `content_home_blocks`, `journal.content_versions` | `→ cities`, `→ branches`, `→ rooms`, `→ content_media` | – | S4-32 |
| 0405 | `0405_seo.sql` | `seo_slug_history`; CHECK зарезервированных слагов `cities` (владелец ограничения – `network`) | – | – | S4-50 |
| 0406 | `0406_rpt_ops.sql` | представления `rpt_bookings`, `rpt_booking_reschedules`, `rpt_visits`, `rpt_no_shows`, `rpt_unit_booked`, `rpt_unit_blocks` (booking), `rpt_units` (resources), `rpt_clients` (clients); индексы владельцев; права роли `yu_reports` | – | – | S4-60 |
| 0407 | `0407_rpt_money.sql` | `rpt_finance_operations`, `rpt_payments` (finance), `rpt_loyalty_moves`, `rpt_loyalty_balances` (loyalty), `rpt_certificate_ops` (certificates) | – | – | S4-61 |
| 0408 | `0408_report_exports.sql` | `report_exports`; CHECK `journal.reconcile_discrepancies.check_name` и `object_type` – `DROP` + `ADD` с полным списком на момент 0408 | `→ staff` | – | S4-71 |
| 0409 | `0409_rpt_comms.sql` | `rpt_notifications` (notifications), `rpt_consent_changes` (clients), `rpt_content_versions` (content) | – | – | S4-74 |
| 0410 | `0410_rpt_e3.sql` | только недостающее по факту 0311 после сверки S4-76; расхождений нет – файла нет, номер свободен | – | – | S4-76 (ждёт Э3) |
| 0411 | `0411_staff_feed.sql` | `staff_feed_events` (лента событий CRM, 13 §11) | `→ branches`, `→ staff` | – | S4-28 (ждёт Э3 и Q-147) |
| 0444 | `0444_media_purge.sql` | `journal.media_purged` – только вставка: журнал принудительных очисток фото (K22 §8, K11 №227а, техдолг 4.1б): `media_id`, `sha256`, `reason_code` (`subject_request` / `consent_withdrawn` / `rights_claim` / `legal_order`), `purged_by`, `purged_at`, `files`, `affected jsonb`; свободного текста и ПДн нет, FK нет намеренно (читается без исходной базы, вход регламента восстановления) | – | – | S4-89 (остаток) |

Общие правила Э4 (решение, продолжают раздел 0 и правила Э2):
- Версии контента и получатели кампаний – журналы (`journal.*`, только вставка); черновики, статусы, связи – `app.*`.
- Публичные запросы контента читают только `journal.content_versions.snapshot` через `live_version_id` и столбцы живой версии; столбец `draft` в публичном SQL не выбирается (K22 §3).
- Представления `rpt_*` принадлежат модулю-владельцу данных (шапка миграции называет владельца каждого); у `yu_app` – только `SELECT` (`REVOKE INSERT, UPDATE, DELETE, TRUNCATE`, как 0211); у роли `yu_reports` – `SELECT` только на `rpt_*` и таблицы календаря `network` (`branches`, `branch_weekly_hours`, `calendar_exceptions`), `default_transaction_read_only = on` (K24 §9). Роль создаёт `deploy/initdb/01-roles.sh`, как `yu_app` (S4-60).
- Файлы медиа и экспорта – на диске, не в БД: `storage_key` / `file_key` – относительный путь внутри корня `MEDIA_DIR` / `EXPORT_DIR` (адаптер `core/files.ts`, S3-06 + S4-06).
- DDL ниже нормативен: имена и смысл – контракт; шаг-исполнитель может добавить индексы и уточнить `CHECK`, расхождение с K21–K24 – правкой этого раздела в том же коммите.

### 0401 – notifications_center (notifications)

```sql
-- migrate:up
-- перед сменой CHECK: строк с category IN ('event_cancel','personal') быть не должно – иначе миграция падает с понятным текстом
ALTER TABLE app.notifications
  ADD COLUMN read_at     timestamptz,
  ADD COLUMN push        boolean NOT NULL DEFAULT true,
  ADD COLUMN campaign_id uuid,                                   -- FK – в 0402
  ADD COLUMN retry_of    uuid REFERENCES app.notifications(id),  -- ручной повтор (K21 §9)
  ADD COLUMN purpose     text;                                    -- назначение личного (09 §3.5)
ALTER TABLE app.notifications DROP CONSTRAINT notifications_category_check,
  ADD CONSTRAINT notifications_category_check CHECK (category IN ('service','reminder','marketing'));
ALTER TABLE app.notifications DROP CONSTRAINT notifications_kind_check,
  ADD CONSTRAINT notifications_kind_check CHECK (kind IN ('booking_confirmed','booking_cancelled','booking_rescheduled',
    'reminder_day_before','reminder_before_start','personal','campaign','event_cancelled','event_rescheduled','account_event'));
ALTER TABLE app.notifications DROP CONSTRAINT notifications_status_check,
  ADD CONSTRAINT notifications_status_check CHECK (status IN ('planned','queued','sending','sent_to_provider','delivered','error',
    'cancelled','skipped_by_prefs','skipped_booking_changed','no_channel','skipped_by_frequency','inbox_only'));
ALTER TABLE app.notifications ADD CONSTRAINT notifications_push_or_inbox CHECK (push OR status IN ('inbox_only','cancelled'));
-- FK notifications_booking_fk (booking_id → app.bookings) вынесен в 0412_notifications_booking_fk.sql (D4-12)
CREATE INDEX notifications_inbox_idx ON app.notifications (client_id, (coalesce(sent_at, planned_at)) DESC)
  WHERE status IN ('sent_to_provider','no_channel','error','inbox_only');
CREATE INDEX notifications_marketing_recent_idx ON app.notifications (client_id, sent_at DESC)
  WHERE category = 'marketing' AND status = 'sent_to_provider';
-- 38-ФЗ ст. 18: согласие на рекламу – только с версией текста (K21 §4); NOT VALID, затем VALIDATE после проверки строк Э1
ALTER TABLE journal.client_consents ADD CONSTRAINT client_consents_marketing_version
  CHECK (kind <> 'marketing' OR NOT granted OR document_version IS NOT NULL) NOT VALID;
ALTER TABLE journal.client_consents VALIDATE CONSTRAINT client_consents_marketing_version;
-- migrate:down – обратные изменения; падает, если есть строки новых видов или статусов (откат только на пустом Э4, K21 §15)
```
Имена прежних CHECK – по факту 0111 (если автоматическое имя другое, миграция берёт его из `pg_constraint`). Согласия на рекламу Э1 писались с константой `MARKETING_DOCUMENT_VERSION`, поэтому `VALIDATE` проходит; найденная строка без версии – миграция падает, решение по данным принимает техлид (на стенде – `--reset-stage`).

### 0402 – notification_campaigns (notifications)

```sql
CREATE TABLE app.notification_templates (               -- K21 §8
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  category text NOT NULL CHECK (category IN ('service','marketing')),
  title text NOT NULL, body text NOT NULL,              -- плейсхолдеры – белый список K21 §8, проверка в коде
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  row_version int NOT NULL DEFAULT 1,
  created_by uuid NOT NULL REFERENCES app.staff(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app.notification_campaigns (                -- K21 §6; любое ручное сообщение – кампания
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','confirmed','expanding','sending','done','cancelled')),
  purpose text,
  category text NOT NULL CHECK (category IN ('service','marketing')),
  title text NOT NULL, body text NOT NULL,
  url text CHECK (url IS NULL OR url ~ '^/([^/\\]|$)'),  -- только путь своего сайта, как CHECK 0111
  push boolean NOT NULL DEFAULT true,
  audience jsonb NOT NULL,                               -- { kind: client|booking|event|segment, … }, segment.v1 (K21 §5)
  area_type text NOT NULL CHECK (area_type IN ('network','city','branch')),
  area_ids uuid[] NOT NULL DEFAULT '{}',
  planned_at timestamptz,
  advertiser_note text, erid text,                       -- 38-ФЗ ст. 18.1 (Q-130, Q-148)
  template_id uuid REFERENCES app.notification_templates(id),
  preview_snapshot jsonb, preview_at timestamptz,
  total int CHECK (total IS NULL OR total >= 0),
  created_by uuid NOT NULL REFERENCES app.staff(id), created_at timestamptz NOT NULL DEFAULT now(),
  confirmed_by uuid REFERENCES app.staff(id), confirmed_at timestamptz,
  cancelled_reason text,
  row_version int NOT NULL DEFAULT 1,
  CHECK (status IN ('draft','cancelled') OR confirmed_at IS NOT NULL),
  CHECK (status <> 'cancelled' OR cancelled_reason IS NOT NULL)
);
-- триггер notification_campaigns_frozen: при OLD.status <> 'draft' UPDATE title, body, url, category, audience, push → 42501 (09 §14)
CREATE TABLE journal.notification_campaign_recipients (  -- снимок аудитории при подтверждении (09 §14)
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  campaign_id uuid NOT NULL REFERENCES app.notification_campaigns(id),
  client_id uuid NOT NULL REFERENCES app.clients(id),
  home_branch_id uuid REFERENCES app.branches(id),       -- для тихих часов (K21 §5)
  decision text NOT NULL,                                -- решение decideSend на момент снимка
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, client_id)
);
SELECT journal.make_append_only('journal.notification_campaign_recipients');
ALTER TABLE app.notifications ADD CONSTRAINT notifications_campaign_fk FOREIGN KEY (campaign_id) REFERENCES app.notification_campaigns(id);
CREATE INDEX notification_campaigns_list_idx ON app.notification_campaigns (created_at DESC);
```
`dedupe_key` строк кампании – `'campaign:<campaignId>:<clientId>'`, ручного повтора – `'<старый>:retry:<n>'` (K21 §6, §9).

### 0403 – content_media (content)

```sql
CREATE TABLE app.content_media (                         -- K22 §8
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sha256 text NOT NULL UNIQUE CHECK (sha256 ~ '^[0-9a-f]{64}$'),   -- дедупликация повторной загрузки
  mime text NOT NULL CHECK (mime IN ('image/jpeg','image/png','image/webp','application/pdf')),
  bytes bigint NOT NULL CHECK (bytes > 0),
  width int, height int,                                 -- у PDF – NULL
  variants jsonb NOT NULL DEFAULT '[]',                  -- [{ w, format, key }] – WebP 480/960/1600 + JPEG 1600
  storage_key text NOT NULL,                             -- <aa>/<bb>/<sha256>… относительно MEDIA_DIR; адрес – /media/<storage_key> (Caddy, S4-07)
  alt text, title text, original_name text,              -- original_name очищен, только для показа в CRM
  purpose text NOT NULL CHECK (purpose IN ('image','document')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived','purged')),
  uploaded_by uuid NOT NULL REFERENCES app.staff(id),
  created_at timestamptz NOT NULL DEFAULT now(), archived_at timestamptz,
  row_version int NOT NULL DEFAULT 1,
  CHECK ((purpose = 'document') = (mime = 'application/pdf'))
);
CREATE TABLE app.content_media_usages (                  -- пересчёт при saveDraft и publish
  media_id uuid NOT NULL REFERENCES app.content_media(id),
  entity_type text NOT NULL, entity_id uuid NOT NULL, field text NOT NULL,
  live boolean NOT NULL,                                 -- по живой версии (true) или по черновику (false)
  PRIMARY KEY (media_id, entity_type, entity_id, field, live)
);
```

### 0404 – content (content)

Общие столбцы каждой версионируемой таблицы (K22 §3): `status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','unpublished','archived'))`, `draft jsonb NOT NULL`, `draft_updated_at`, `draft_updated_by uuid`, `live_version_id bigint REFERENCES journal.content_versions(id)`, `row_version int NOT NULL DEFAULT 1`, `created_by uuid NOT NULL`, `created_at`, `archived_at`. Поля поиска и фильтра живой версии пишет только `publish`.

```sql
CREATE TABLE journal.content_versions (                  -- только вставка (12 §9.5)
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_type text NOT NULL CHECK (entity_type IN ('publication','game','room_page','branch_page','content_page','home_block')),
  entity_id uuid NOT NULL, version_no int NOT NULL CHECK (version_no >= 1),
  snapshot jsonb NOT NULL,                               -- что видит посетитель; alt и размеры медиа заморожены (K22 §8 п.5)
  action text NOT NULL CHECK (action IN ('publish','rollback_publish')),
  published_by uuid NOT NULL, published_at timestamptz NOT NULL, reason text,
  source_version_id bigint REFERENCES journal.content_versions(id),
  UNIQUE (entity_type, entity_id, version_no),
  CHECK ((action = 'rollback_publish') = (source_version_id IS NOT NULL))
);
SELECT journal.make_append_only('journal.content_versions');
CREATE TABLE app.content_publications (                  -- + общие столбцы
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL CHECK (type IN ('news','promotion','giveaway','tournament')),
  slug text CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 90),   -- живая версия
  publish_from timestamptz, publish_to timestamptz,
  indexable boolean NOT NULL DEFAULT true,               -- K23 §9
  cover_media_id uuid REFERENCES app.content_media(id), rules_media_id uuid REFERENCES app.content_media(id),
  UNIQUE (type, slug)
);
CREATE INDEX content_publications_live_idx ON app.content_publications (type, publish_from DESC) WHERE status = 'published';
CREATE TABLE app.content_publication_scopes (            -- охват живой версии (K22 §4)
  publication_id uuid NOT NULL REFERENCES app.content_publications(id),
  scope_type text NOT NULL CHECK (scope_type IN ('network','city','branch')),
  city_id uuid REFERENCES app.cities(id), branch_id uuid REFERENCES app.branches(id),
  CHECK ((scope_type = 'network') = (city_id IS NULL AND branch_id IS NULL)),
  CHECK (scope_type <> 'city' OR (city_id IS NOT NULL AND branch_id IS NULL)),
  CHECK (scope_type <> 'branch' OR (branch_id IS NOT NULL AND city_id IS NULL))
);  -- «одна строка network или строки одного вида» – проверка publish (K22 §4)
CREATE TABLE app.content_games (                         -- + общие столбцы; каталог сети
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  direction text NOT NULL CHECK (direction IN ('pc','vr','playstation')),
  slug text CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 90),
  has_full boolean NOT NULL DEFAULT false,               -- живая версия с непустым full → есть карточка (K23 §2)
  cover_media_id uuid REFERENCES app.content_media(id), sort_order int NOT NULL DEFAULT 0,
  UNIQUE (direction, slug)
);
CREATE TABLE app.content_game_branches (                 -- оперативный факт, не версионируется; без строки = недоступна
  game_id uuid NOT NULL REFERENCES app.content_games(id), branch_id uuid NOT NULL REFERENCES app.branches(id),
  available boolean NOT NULL, note text CHECK (length(note) <= 120),
  updated_by uuid NOT NULL, updated_at timestamptz NOT NULL,
  PRIMARY KEY (game_id, branch_id)
);
CREATE TABLE app.content_room_pages (                    -- + общие столбцы
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), room_id uuid NOT NULL UNIQUE REFERENCES app.rooms(id)
);
CREATE TABLE app.content_branch_pages (                  -- + общие столбцы; postal и geo – в draft/snapshot (K22 §2)
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), branch_id uuid NOT NULL UNIQUE REFERENCES app.branches(id)
);
CREATE TABLE app.content_pages (                         -- + общие столбцы
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL CHECK (key IN ('about','contacts_intro','rules','privacy-policy','personal-data-consent','cookie-policy','advertising-consent')),
  city_id uuid REFERENCES app.cities(id),                -- подмена для города; юридические – только сеть (K22 §2)
  document_version text CHECK (document_version IS NULL OR document_version ~ '^[a-z-]+-\d{4}-\d{2}-\d{2}(-\d+)?$'),  -- живая версия
  CHECK (city_id IS NULL OR key IN ('about','rules','contacts_intro')),
  UNIQUE NULLS NOT DISTINCT (key, city_id)
);
CREATE TABLE app.content_home_blocks (                   -- + общие столбцы; главная одна на сеть, подмена города
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  block_type text NOT NULL CHECK (block_type IN ('hero','about','directions','advantages','promo_strip','cta')),
  city_id uuid REFERENCES app.cities(id), sort_order int NOT NULL DEFAULT 0,
  UNIQUE NULLS NOT DISTINCT (block_type, city_id)        -- S4-32: тип на уровне один, на этом держится подмена города (K22 §2)
);
```

### 0405 – seo (content; CHECK городов – network)

```sql
CREATE TABLE app.seo_slug_history (                      -- K23 §5
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL CHECK (entity_type IN ('city','branch','room','game','publication')),
  entity_id uuid NOT NULL,                               -- полиморфная ссылка без FK (решение, как outbox)
  parent_key text NOT NULL,                              -- city_id / branch_id / direction / type; у города – ''
  old_slug text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_type, parent_key, old_slug)
);
-- владелец ограничения – network; перед добавлением проверка существующих городов (иначе падение с понятным текстом)
ALTER TABLE app.cities ADD CONSTRAINT cities_slug_reserved CHECK (slug NOT IN ('rooms','games','schedule','birthday','news',
  'promotions','giveaways','tournaments','reviews','about','contacts','rules','privacy-policy','personal-data-consent',
  'cookie-policy','advertising-consent','login','account','sitemap','api','admin','crm','assets','media','preview','unsubscribe','info'));
```
Занятие старого слага новой сущностью удаляет строку истории в той же транзакции (K23 §5): таблица в `app`, не журнал, `DELETE` у `yu_app` есть (решение).

### 0406, 0407, 0409 – представления `rpt_*` (владельцы – по строкам K24 §1)

Состав столбцов – таблица K24 §1 (нормативна). Владельцы: `rpt_bookings`, `rpt_booking_reschedules`, `rpt_visits`, `rpt_no_shows`, `rpt_unit_booked`, `rpt_unit_blocks` – `booking`; `rpt_units` – `resources`; `rpt_clients` – `clients` (без телефона и имени); `rpt_finance_operations`, `rpt_payments` – `finance` (сторно – со знаком в строку исходного вида, `signed_kop`); `rpt_loyalty_moves`, `rpt_loyalty_balances` – `loyalty`; `rpt_certificate_ops` – `certificates`; `rpt_notifications` – `notifications`; `rpt_consent_changes` – `clients`; `rpt_content_versions` – `content`. `period` у `rpt_unit_booked` и `rpt_unit_blocks` – `tstzrange` для мультидиапазонов (`range_agg`, PostgreSQL 16). Индексы под отчёты – владельцами таблиц, если ещё нет: `bookings (branch_id, created_at)`, `visits (branch_id, arrived_at)`, `finance_operations (branch_id, occurred_at)`, `ledger_entries (account_id, created_at)` (сверка `EXPLAIN` – S4-131).

```sql
-- 0406, после CREATE VIEW: права (K24 §9)
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON app.rpt_bookings /* …каждое представление… */ FROM yu_app;
GRANT USAGE ON SCHEMA app TO yu_reports;
GRANT SELECT ON app.rpt_bookings /* …все rpt_* 0211 и 0406… */, app.branches, app.branch_weekly_hours, app.calendar_exceptions TO yu_reports;
-- роль создаёт deploy/initdb/01-roles.sh: CREATE ROLE yu_reports LOGIN …; ALTER ROLE yu_reports SET default_transaction_read_only = on
-- миграция проверяет, что роль есть (как 0001 для yu_app), иначе падает с понятным текстом; тестовая база создаёт её в helpers/pg.ts
```
0407 и 0409 выдают `SELECT` роли `yu_reports` на свои представления тем же способом.

### 0408 – report_exports (reports)

```sql
CREATE TABLE app.report_exports (                        -- K24 §7
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id uuid NOT NULL REFERENCES app.staff(id),
  report text NOT NULL CHECK (report IN ('dashboard','bookings','utilization','finance','events','clients','loyalty','certificates','staff','equipment','comms')),
  format text NOT NULL CHECK (format IN ('xlsx','csv')),
  params jsonb NOT NULL, params_hash text NOT NULL,      -- SHA-256 нормализованных параметров + staff_id + format
  detail boolean NOT NULL, masked boolean NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','ready','expired','failed','cancelled')),
  error_code text, rows int, bytes bigint, file_key text,  -- случайный UUID внутри EXPORT_DIR
  created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz,
  expires_at timestamptz, downloaded_at timestamptz,
  CHECK (status <> 'ready' OR (file_key IS NOT NULL AND expires_at IS NOT NULL)),
  CHECK (status <> 'failed' OR error_code IS NOT NULL)
);
CREATE UNIQUE INDEX report_exports_same_request ON app.report_exports (staff_id, params_hash) WHERE status IN ('queued','running','ready');
-- 0408 и 0311 пересоздают CHECK полным списком на свой момент – применённая позже содержит всё (K24 §12)
ALTER TABLE journal.reconcile_discrepancies DROP CONSTRAINT reconcile_discrepancies_check_name_check,
  ADD CONSTRAINT reconcile_discrepancies_check_name_check CHECK (check_name IN ('ledger_balance','loyalty_points','loyalty_batch',
    'certificate_balance','cash_place', /* значения 0311 – по факту S3-95 */ 'utilization_over_capacity'));
ALTER TABLE journal.reconcile_discrepancies DROP CONSTRAINT reconcile_discrepancies_object_type_check,
  ADD CONSTRAINT reconcile_discrepancies_object_type_check CHECK (object_type IN ('ledger_account','client','loyalty_batch',
    'certificate','branch', /* значения 0311 */ 'occupancy_unit'));
```
Решения S4-00: (1) K24 §12 расширяет только `check_name`, но расхождение загрузки ссылается на единицу занятости – без `occupancy_unit` в CHECK `object_type` его не записать; бронь вне расписания – `details.bookingId`, уровень – `details.level = 'warning'` (столбца уровня в 0211 нет). (2) `status = 'cancelled'` – отмена задачи автором (K11 №247); в K24 §7 такого статуса не было.

### 0411 – staff_feed (notifications; ждёт Э3 и Q-147)

```sql
CREATE TABLE app.staff_feed_events (                     -- лента событий CRM (13 §11), без push сотрудникам
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES app.branches(id),
  staff_id uuid REFERENCES app.staff(id),                -- адресат; NULL – все сотрудники зоны филиала
  kind text NOT NULL CHECK (kind IN ('shift_changed','repair_registered','repair_closed','service_notification_failed')),
  ref_type text NOT NULL, ref_id uuid NOT NULL,          -- объект для перехода в карточку
  title text NOT NULL,
  dedupe_key text NOT NULL UNIQUE,                       -- '<kind>:<eventId>' – двойная доставка события → одна строка
  created_at timestamptz NOT NULL DEFAULT now(), read_at timestamptz
);
CREATE INDEX staff_feed_events_branch_idx ON app.staff_feed_events (branch_id, created_at DESC);
```

### Ключевые правила Э4 → где гарантия

| Правило | ТЗ / контракт | Гарантия |
|---|---|---|
| Реклама только по согласию с версией текста | 38-ФЗ ст. 18; K21 §4 | CHECK `client_consents_marketing_version` (0401) + `decideSend` при постановке и в `send` |
| Подтверждённая кампания не меняется | 09 §14; K21 §6 | триггер `notification_campaigns_frozen` (0402), `42501` |
| Повтор разворачивания не дублирует | 16 §15.2 | `notifications.dedupe_key` UNIQUE + `UNIQUE (campaign_id, client_id)` получателей |
| Черновик не виден посетителю | 12 §9.2; K22 §3 | публичный SQL читает только `content_versions.snapshot` через `live_version_id` |
| Версии контента не правятся | 12 §9.5 | `journal.content_versions` только вставка |
| Медиа не дублируются | K22 §8 | `content_media.sha256` UNIQUE |
| Зарезервированные слова не становятся городом | карта сайта п.2.8; K23 §9 | CHECK `cities_slug_reserved` (0405) |
| Отчёт не пишет и не читает в обход `rpt_*` | 17 §6; K24 §9 | роль `yu_reports` (только `SELECT` на `rpt_*`, read only) |
| Одинаковый экспорт – одна задача | K24 §7 | `report_exports_same_request` |

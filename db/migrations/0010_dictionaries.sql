-- 0010_dictionaries: справочники (model-dannyh §0010, 15 §16, 02 §7.1, §8.2). Модуль-владелец – dictionaries.
-- Защита системных кодов в два слоя:
--   1) права столбцов yu_app: code, domain, is_system не меняются, DELETE нет, is_system при вставке не задать;
--   2) триггер dict_protect_system – на всех (и для владельца объектов): код неизменен, удаления нет,
--      системное значение не архивируется и не теряет признак is_system.
-- Подписи (name) меняются – с аудитом в модуле. Системные статусы и переходы приложение не создаёт и не удаляет.
-- Сид: коды – из CHECK-ограничений model-dannyh; шаги – 01 §4 (VR 15, ПК/PS 30); подписи и стартовые
-- пользовательские причины – решение исполнителя, правятся в CRM.

-- migrate:up
CREATE TABLE app.dict_resource_types (
  code          text PRIMARY KEY,
  name          text NOT NULL,
  step_minutes  smallint NOT NULL CHECK (step_minutes > 0 AND 1440 % step_minutes = 0),
  bookable      boolean NOT NULL DEFAULT true,
  is_system     boolean NOT NULL DEFAULT false,
  archived_at   timestamptz,
  sort_order    int NOT NULL DEFAULT 0
);
CREATE TABLE app.dict_space_types (
  code text PRIMARY KEY, name text NOT NULL, is_system boolean NOT NULL DEFAULT false,
  archived_at timestamptz, sort_order int NOT NULL DEFAULT 0
);
CREATE TABLE app.dict_statuses (
  domain     text NOT NULL,
  code       text NOT NULL,
  name       text NOT NULL,
  PRIMARY KEY (domain, code)
);
CREATE TABLE app.dict_status_transitions (
  domain text NOT NULL, from_code text NOT NULL, to_code text NOT NULL,
  PRIMARY KEY (domain, from_code, to_code),
  FOREIGN KEY (domain, from_code) REFERENCES app.dict_statuses(domain, code),
  FOREIGN KEY (domain, to_code)   REFERENCES app.dict_statuses(domain, code)
);
CREATE TABLE app.dict_reasons (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain      text NOT NULL CHECK (domain IN ('booking_cancel_club','booking_cancel_client','no_show','visit_correction',
                                              'resource_block','ledger_correction')),
  code        text NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]*$'),
  name        text NOT NULL,
  is_system   boolean NOT NULL DEFAULT false,
  requires_comment boolean NOT NULL DEFAULT false,
  archived_at timestamptz,
  sort_order  int NOT NULL DEFAULT 0,
  UNIQUE (domain, code)
);
ALTER TABLE app.dict_space_types ADD CHECK (code ~ '^[a-z][a-z0-9_]*$');

-- ---- сид (до триггеров)
INSERT INTO app.dict_resource_types (code, name, step_minutes, is_system, sort_order) VALUES
  ('pc',         'ПК',                      30, true, 10),
  ('vr_seat',    'VR-место',                15, true, 20),
  ('room_whole', 'Комната целиком',         15, true, 30),
  ('ps_room',    'PlayStation-комната',     30, true, 40),
  ('composite',  'Составная конфигурация',  15, true, 50);

INSERT INTO app.dict_space_types (code, name, sort_order) VALUES
  ('hall', 'Общий зал', 10), ('vr_zone', 'VR-зона', 20), ('game_room', 'Отдельная игровая комната', 30),
  ('vip_room', 'VIP-комната', 40), ('technical', 'Техническое помещение', 50);

INSERT INTO app.dict_statuses (domain, code, name) VALUES
  ('booking', 'confirmed', 'Подтверждена'), ('booking', 'arrived', 'Клиент пришёл'),
  ('booking', 'completed', 'Завершена'), ('booking', 'no_show', 'Неявка'),
  ('booking', 'cancelled_by_client', 'Отменена клиентом'), ('booking', 'cancelled_by_club', 'Отменена клубом'),
  ('branch', 'preparing', 'Готовится к открытию'), ('branch', 'active', 'Работает'),
  ('branch', 'temporarily_closed', 'Временно закрыт'), ('branch', 'archived', 'В архиве'),
  ('hold', 'active', 'Удерживается'), ('hold', 'converted', 'Оформлено в бронь'),
  ('hold', 'expired', 'Истекло'), ('hold', 'released', 'Отпущено');

INSERT INTO app.dict_status_transitions (domain, from_code, to_code) VALUES
  ('booking', 'confirmed', 'arrived'), ('booking', 'confirmed', 'no_show'),
  ('booking', 'confirmed', 'cancelled_by_client'), ('booking', 'confirmed', 'cancelled_by_club'),
  ('booking', 'arrived', 'completed'), ('booking', 'arrived', 'confirmed'), ('booking', 'no_show', 'confirmed'),
  ('branch', 'preparing', 'active'), ('branch', 'active', 'temporarily_closed'),
  ('branch', 'temporarily_closed', 'active'), ('branch', 'preparing', 'archived'),
  ('branch', 'active', 'archived'), ('branch', 'temporarily_closed', 'archived'),
  ('hold', 'active', 'converted'), ('hold', 'active', 'expired'), ('hold', 'active', 'released');

INSERT INTO app.dict_reasons (domain, code, name, is_system, requires_comment, sort_order) VALUES
  ('booking_cancel_club',   'other', 'Другое', true, true, 1000),
  ('booking_cancel_client', 'other', 'Другое', true, true, 1000),
  ('no_show',               'other', 'Другое', true, true, 1000),
  ('visit_correction',      'other', 'Другое', true, true, 1000),
  ('resource_block',        'other', 'Другое', true, true, 1000),
  ('ledger_correction',     'other', 'Другое', true, true, 1000),
  ('booking_cancel_club',   'equipment_failure', 'Неисправность оборудования', false, false, 10),
  ('booking_cancel_client', 'changed_plans', 'Изменились планы', false, false, 10),
  ('resource_block',        'repair', 'Ремонт', false, false, 10),
  ('resource_block',        'maintenance', 'Обслуживание', false, false, 20);

-- ---- триггер защиты
CREATE FUNCTION app.dict_protect_system() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  old_row jsonb := to_jsonb(OLD);
  new_row jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'dict_no_delete: значения справочника % не удаляются – только архив', TG_TABLE_NAME
      USING ERRCODE = 'P0001';
  END IF;
  new_row := to_jsonb(NEW);
  IF new_row->'code' IS DISTINCT FROM old_row->'code' OR new_row->'domain' IS DISTINCT FROM old_row->'domain' THEN
    RAISE EXCEPTION 'dict_code_immutable: код значения справочника % неизменен', TG_TABLE_NAME USING ERRCODE = 'P0001';
  END IF;
  IF (old_row->>'is_system')::boolean IS TRUE THEN
    IF (new_row->>'is_system')::boolean IS NOT TRUE THEN
      RAISE EXCEPTION 'dict_system_immutable: признак системного значения не снимается' USING ERRCODE = 'P0001';
    END IF;
    IF new_row->'archived_at' IS DISTINCT FROM old_row->'archived_at' THEN
      RAISE EXCEPTION 'dict_system_immutable: системное значение не архивируется' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER dict_protect_system BEFORE UPDATE OR DELETE ON app.dict_resource_types
  FOR EACH ROW EXECUTE FUNCTION app.dict_protect_system();
CREATE TRIGGER dict_protect_system BEFORE UPDATE OR DELETE ON app.dict_space_types
  FOR EACH ROW EXECUTE FUNCTION app.dict_protect_system();
CREATE TRIGGER dict_protect_system BEFORE UPDATE OR DELETE ON app.dict_statuses
  FOR EACH ROW EXECUTE FUNCTION app.dict_protect_system();
CREATE TRIGGER dict_protect_system BEFORE UPDATE OR DELETE ON app.dict_status_transitions
  FOR EACH ROW EXECUTE FUNCTION app.dict_protect_system();
CREATE TRIGGER dict_protect_system BEFORE UPDATE OR DELETE ON app.dict_reasons
  FOR EACH ROW EXECUTE FUNCTION app.dict_protect_system();

-- ---- права столбцов yu_app (поверх default privileges 0001)
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON app.dict_resource_types, app.dict_space_types, app.dict_statuses,
  app.dict_status_transitions, app.dict_reasons FROM yu_app;
GRANT UPDATE (name, step_minutes, bookable, sort_order) ON app.dict_resource_types TO yu_app;
GRANT INSERT (code, name, sort_order), UPDATE (name, sort_order, archived_at) ON app.dict_space_types TO yu_app;
GRANT UPDATE (name) ON app.dict_statuses TO yu_app;
GRANT INSERT (domain, code, name, requires_comment, sort_order),
      UPDATE (name, requires_comment, sort_order, archived_at) ON app.dict_reasons TO yu_app;

-- migrate:down
DROP TABLE app.dict_reasons;
DROP TABLE app.dict_status_transitions;
DROP TABLE app.dict_statuses;
DROP TABLE app.dict_space_types;
DROP TABLE app.dict_resource_types;
DROP FUNCTION app.dict_protect_system();

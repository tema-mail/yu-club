-- 0110_visits: посещения и неявки (model-dannyh §0110, K11 №8–11, 16 §5–6, R-08).
-- Модуль-владелец – booking. Приход – строка visits (одна активная на бронь: visits_one_active_idx гасит повторную
-- отметку); неявка – строка no_shows (одна активная на бронь – один штраф в Э2, 07 §8.4) и посещения не создаёт.
-- Ошибочная отметка не удаляется: status 'reverted' с причиной, автором и временем (обратная запись) + событие K4.
-- Взаимоисключение «посещение / неявка» держит статус брони под SELECT ... FOR UPDATE (переход только из confirmed).
-- Сверх нормативного DDL (решение): CHECK согласованности reverted у no_shows (как у visits); завершение не раньше
-- прихода; индексы по филиалу для списков CRM. Удаления нет: у yu_app отозван DELETE.

-- migrate:up
CREATE TABLE app.visits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES app.bookings(id),
  branch_id uuid NOT NULL REFERENCES app.branches(id),
  client_id uuid NOT NULL REFERENCES app.clients(id),
  arrived_at timestamptz NOT NULL,
  completed_at timestamptz,
  marked_by uuid NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','reverted')),
  reverted_at timestamptz, reverted_by uuid, revert_reason text,
  CHECK (status = 'active' OR (reverted_at IS NOT NULL AND revert_reason IS NOT NULL)),
  CHECK (completed_at IS NULL OR completed_at >= arrived_at)
);
CREATE UNIQUE INDEX visits_one_active_idx ON app.visits (booking_id) WHERE status = 'active';
CREATE INDEX visits_client_idx ON app.visits (client_id, arrived_at) WHERE status = 'active';

CREATE TABLE app.no_shows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES app.bookings(id),
  branch_id uuid NOT NULL REFERENCES app.branches(id),
  client_id uuid NOT NULL REFERENCES app.clients(id),
  marked_at timestamptz NOT NULL, marked_by uuid NOT NULL,
  reason_id uuid REFERENCES app.dict_reasons(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','reverted')),
  reverted_at timestamptz, reverted_by uuid, revert_reason text,
  CHECK (status = 'active' OR (reverted_at IS NOT NULL AND revert_reason IS NOT NULL))
);
CREATE UNIQUE INDEX no_shows_one_active_idx ON app.no_shows (booking_id) WHERE status = 'active';
CREATE INDEX no_shows_client_idx ON app.no_shows (client_id, marked_at) WHERE status = 'active';

REVOKE DELETE, TRUNCATE ON app.visits, app.no_shows FROM yu_app;

-- migrate:down
DROP TABLE app.no_shows;
DROP TABLE app.visits;

-- 0309_gifts: подарок имениннику (K20 §8, §14, шаг S3-57). Право, не сертификат K16 и не баллы: свой номер GF-, без номинала.
--   app.birthday_gifts – подарок: состав – снимок terms на выдаче; один на именинника в 365 дней (EXCLUDE; константа 365 – копия
--                        умолчания gift.per_client_days: ограничение базы настройку не читает, смена срока – миграцией, Q-71).
--   app.gift_uses      – запись по подарку: удержание → бронь → использован; одна живая на подарок (gift_uses_one_live).
--   dict_resource_types.gift_vr – служебный тип «Подарок: 2 VR» (шаг 5 минут, K20 §8); сам ресурс создаёт ensureGiftResource (S3-62).

-- migrate:up
INSERT INTO app.dict_resource_types (code, name, step_minutes, is_system, sort_order) VALUES ('gift_vr', 'Подарок: 2 VR', 5, true, 60);

CREATE TABLE app.birthday_gifts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number          text NOT NULL UNIQUE,
  client_id       uuid NOT NULL REFERENCES app.clients(id),
  basis_event_id  uuid REFERENCES app.events(id),
  issue_branch_id uuid NOT NULL REFERENCES app.branches(id),
  issued_on       date NOT NULL,
  valid_until     date NOT NULL,
  terms           jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','reserved','used','expired','cancelled')),
  cancel_reason   text,
  manual_reason   text,                                 -- причина выдачи без мероприятия (Q-115)
  issued_by       uuid NOT NULL,
  issued_at       timestamptz NOT NULL,
  row_version     int NOT NULL DEFAULT 1,
  CHECK (valid_until > issued_on),
  CHECK (basis_event_id IS NOT NULL OR manual_reason IS NOT NULL),
  CHECK (status <> 'cancelled' OR cancel_reason IS NOT NULL),
  CONSTRAINT birthday_gifts_one_per_year EXCLUDE USING gist (client_id WITH =, daterange(issued_on, (issued_on + 365)) WITH &&) WHERE (status <> 'cancelled')
);
CREATE INDEX birthday_gifts_client_idx ON app.birthday_gifts (client_id, issued_on);
CREATE INDEX birthday_gifts_event_idx ON app.birthday_gifts (basis_event_id) WHERE basis_event_id IS NOT NULL;
CREATE INDEX birthday_gifts_expiry_idx ON app.birthday_gifts (valid_until) WHERE status = 'issued';

CREATE TABLE app.gift_uses (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gift_id    uuid NOT NULL REFERENCES app.birthday_gifts(id),
  hold_id    uuid REFERENCES app.holds(id),
  booking_id uuid REFERENCES app.bookings(id),
  status     text NOT NULL CHECK (status IN ('held','booked','used','released')),
  changed_at timestamptz NOT NULL,
  CHECK (hold_id IS NOT NULL OR booking_id IS NOT NULL)
);
CREATE UNIQUE INDEX gift_uses_one_live ON app.gift_uses (gift_id) WHERE status IN ('held','booked','used');
CREATE INDEX gift_uses_hold_idx ON app.gift_uses (hold_id) WHERE hold_id IS NOT NULL;
CREATE INDEX gift_uses_booking_idx ON app.gift_uses (booking_id) WHERE booking_id IS NOT NULL;

REVOKE DELETE, TRUNCATE ON app.birthday_gifts, app.gift_uses FROM yu_app;

-- migrate:down
DROP TABLE app.gift_uses;
DROP TABLE app.birthday_gifts;
ALTER TABLE app.dict_resource_types DISABLE TRIGGER dict_protect_system;
DELETE FROM app.dict_resource_types WHERE code = 'gift_vr';
ALTER TABLE app.dict_resource_types ENABLE TRIGGER dict_protect_system;

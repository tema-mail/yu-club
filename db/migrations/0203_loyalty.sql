-- 0203_loyalty: баллы поверх журнала K3 – партии, движения партий, начисления, штрафы, резервы, «требует решения»
-- (model-dannyh §0203, K15 §2–§5, шаг S2-30). Модуль-владелец – loyalty.
-- Баланс считает только K3 (счёт loyalty_client, min_balance = −5000); здесь – бизнес-смысл и кэш remaining_centi,
-- инвариант Σ remaining активных партий = max(0, баланс K3) держит код модуля (lock → перечитать → проверить),
-- сверяет ночная задача S2-80. payment_id – uuid без FK до 0205 (FK вперёд – в миграции цели).
-- Сверх нормативного DDL (решение): индексы движений по партии (возврат в исходную партию, §7) и начислений
-- по посещению; закрытый резерв обязан иметь closed_at; удаления нет – у yu_app отозван DELETE.

-- migrate:up
CREATE TABLE app.loyalty_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES app.clients(id),
  source text NOT NULL CHECK (source IN ('visit','manual')),
  accrual_entry_id bigint NOT NULL UNIQUE REFERENCES journal.ledger_entries(id),
  branch_id uuid REFERENCES app.branches(id),
  booking_id uuid REFERENCES app.bookings(id),
  visit_id uuid REFERENCES app.visits(id),
  amount_centi bigint NOT NULL CHECK (amount_centi > 0),
  remaining_centi bigint NOT NULL CHECK (remaining_centi >= 0 AND remaining_centi <= amount_centi),
  expires_at timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','depleted','expired')),
  accrued_at timestamptz NOT NULL,
  CHECK (status <> 'expired' OR remaining_centi = 0)
);
CREATE INDEX loyalty_batches_fefo_idx ON app.loyalty_batches (client_id, expires_at NULLS LAST, accrued_at, id) WHERE status = 'active';
CREATE INDEX loyalty_batches_expiry_idx ON app.loyalty_batches (expires_at) WHERE status = 'active' AND expires_at IS NOT NULL;

CREATE TABLE journal.loyalty_batch_moves (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES app.loyalty_batches(id),
  ledger_entry_id bigint NOT NULL REFERENCES journal.ledger_entries(id),
  kind text NOT NULL CHECK (kind IN ('spend_time','spend_goods','penalty','expire','return','debt_cover','manual','accrual_reversal')),
  delta_centi bigint NOT NULL CHECK (delta_centi <> 0),
  ref_type text, ref_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX loyalty_batch_moves_entry_idx ON journal.loyalty_batch_moves (ledger_entry_id);
CREATE INDEX loyalty_batch_moves_batch_idx ON journal.loyalty_batch_moves (batch_id, id);
SELECT journal.make_append_only('journal.loyalty_batch_moves');

CREATE TABLE app.loyalty_accruals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES app.clients(id),
  booking_id uuid NOT NULL REFERENCES app.bookings(id),
  visit_id uuid NOT NULL REFERENCES app.visits(id),
  payment_id uuid NOT NULL,
  ledger_entry_id bigint NOT NULL UNIQUE REFERENCES journal.ledger_entries(id),
  amount_centi bigint NOT NULL CHECK (amount_centi > 0),
  planned_minutes int NOT NULL CHECK (planned_minutes > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','reversed')),
  reversal_entry_id bigint REFERENCES journal.ledger_entries(id),
  reversal_reason text CHECK (reversal_reason IN ('visit_reverted','payment_refunded')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'reversed') = (reversal_reason IS NOT NULL))
);
CREATE UNIQUE INDEX loyalty_accruals_one_active ON app.loyalty_accruals (booking_id) WHERE status = 'active';
CREATE INDEX loyalty_accruals_visit_idx ON app.loyalty_accruals (visit_id);

CREATE TABLE app.loyalty_penalties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES app.clients(id),
  booking_id uuid NOT NULL REFERENCES app.bookings(id),
  no_show_id uuid NOT NULL UNIQUE REFERENCES app.no_shows(id),
  branch_id uuid NOT NULL REFERENCES app.branches(id),
  applied_centi bigint NOT NULL CHECK (applied_centi BETWEEN -500 AND 0),
  ledger_entry_id bigint REFERENCES journal.ledger_entries(id),
  group_booking_id uuid REFERENCES app.bookings(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','merged','reversed','skipped')),
  reversal_entry_id bigint REFERENCES journal.ledger_entries(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((applied_centi = 0) = (ledger_entry_id IS NULL))
);
CREATE UNIQUE INDEX loyalty_penalties_one_active ON app.loyalty_penalties (booking_id) WHERE status = 'active';
CREATE INDEX loyalty_penalties_group_idx ON app.loyalty_penalties (group_booking_id) WHERE status = 'merged';

CREATE TABLE app.loyalty_reserves (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES app.clients(id),
  amount_centi bigint NOT NULL CHECK (amount_centi > 0),
  hold_id uuid REFERENCES app.holds(id),
  booking_id uuid REFERENCES app.bookings(id),
  hold_signature text,
  status text NOT NULL CHECK (status IN ('hold','booking','spent','released','converted')),
  release_reason text CHECK (release_reason IN ('hold_expired','hold_released','hold_changed','booking_cancelled','no_show',
                                                'rescheduled_short','replaced','paid_other')),
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  CHECK (status <> 'hold' OR (hold_id IS NOT NULL AND hold_signature IS NOT NULL)),
  CHECK (status <> 'booking' OR booking_id IS NOT NULL),
  CHECK ((status = 'released') = (release_reason IS NOT NULL)),
  CHECK ((status IN ('hold','booking')) = (closed_at IS NULL))
);
CREATE UNIQUE INDEX loyalty_reserves_one_per_hold ON app.loyalty_reserves (hold_id) WHERE status = 'hold';
CREATE UNIQUE INDEX loyalty_reserves_one_per_booking ON app.loyalty_reserves (booking_id) WHERE status = 'booking';
CREATE INDEX loyalty_reserves_client_idx ON app.loyalty_reserves (client_id) WHERE status IN ('hold','booking');

CREATE TABLE app.loyalty_issues (
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
CREATE INDEX loyalty_issues_open_idx ON app.loyalty_issues (client_id) WHERE status = 'open';

REVOKE DELETE, TRUNCATE ON app.loyalty_batches, app.loyalty_accruals, app.loyalty_penalties, app.loyalty_reserves,
  app.loyalty_issues FROM yu_app;

-- migrate:down
DROP TABLE app.loyalty_issues;
DROP TABLE app.loyalty_reserves;
DROP TABLE app.loyalty_penalties;
DROP TABLE app.loyalty_accruals;
DROP TABLE journal.loyalty_batch_moves;
DROP TABLE app.loyalty_batches;

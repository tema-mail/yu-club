-- 0440_client_merge: слияние дублей клиентов (03 §11.2, §12; K9 «Слияние»; право client.merge K1; техдолг 5.15).
-- Вторая карточка после объединения – статус merged со ссылкой merged_into_id на основную; её телефон, имя, почта и дата
-- рождения очищаются как при обезличивании, поэтому телефон у merged, как у anonymized, может быть NULL (освобождается
-- для новой карточки). merged_into_id – ровно у merged. journal.client_merges – журнал объединений только на вставку
-- (кто, когда, из какой в какую, основание кодом, итоги по модулям); вторая карточка объединяется один раз (UNIQUE).
-- Движение партий баллов при переносе остатка (K15 §2, модуль loyalty) – новый вид merge в journal.loyalty_batch_moves.
-- Имена CHECK 0105/0203 не задавались – ищем по определению, чтобы не зависеть от автоимён Postgres.

-- migrate:up
ALTER TABLE app.clients ADD COLUMN merged_into_id uuid REFERENCES app.clients(id);

DO $$
DECLARE c text;
BEGIN
  SELECT conname INTO c FROM pg_constraint
   WHERE conrelid = 'app.clients'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%deletion_requested%';
  IF c IS NULL THEN RAISE EXCEPTION '0440: CHECK статуса клиента не найден'; END IF;
  EXECUTE format('ALTER TABLE app.clients DROP CONSTRAINT %I', c);
  SELECT conname INTO c FROM pg_constraint
   WHERE conrelid = 'app.clients'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%phone_e164 IS NOT NULL%';
  IF c IS NULL THEN RAISE EXCEPTION '0440: CHECK телефона клиента не найден'; END IF;
  EXECUTE format('ALTER TABLE app.clients DROP CONSTRAINT %I', c);
  SELECT conname INTO c FROM pg_constraint
   WHERE conrelid = 'journal.loyalty_batch_moves'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%accrual_reversal%';
  IF c IS NULL THEN RAISE EXCEPTION '0440: CHECK вида движения партии не найден'; END IF;
  EXECUTE format('ALTER TABLE journal.loyalty_batch_moves DROP CONSTRAINT %I', c);
END $$;

ALTER TABLE app.clients ADD CONSTRAINT clients_status_check
  CHECK (status IN ('guest','active','restricted','blocked','deletion_requested','anonymized','merged'));
ALTER TABLE app.clients ADD CONSTRAINT clients_phone_or_closed_check
  CHECK (phone_e164 IS NOT NULL OR status IN ('anonymized','merged'));
ALTER TABLE app.clients ADD CONSTRAINT clients_merged_into_check
  CHECK ((status = 'merged') = (merged_into_id IS NOT NULL));
CREATE INDEX clients_merged_into_idx ON app.clients (merged_into_id) WHERE merged_into_id IS NOT NULL;

ALTER TABLE journal.loyalty_batch_moves ADD CONSTRAINT loyalty_batch_moves_kind_check
  CHECK (kind IN ('spend_time','spend_goods','penalty','expire','return','debt_cover','manual','accrual_reversal','merge'));

CREATE TABLE journal.client_merges (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  primary_client_id   uuid NOT NULL REFERENCES app.clients(id),
  secondary_client_id uuid NOT NULL REFERENCES app.clients(id),
  reason              text NOT NULL CHECK (reason IN ('same_person_confirmed','duplicate_registration','phone_changed')),
  staff_id            uuid NOT NULL,
  merged_at           timestamptz NOT NULL,
  results             jsonb NOT NULL,   -- итоги по модулям: {"booking": {"bookings": 2, …}, "loyalty": {…}, …}, без ПДн
  CHECK (primary_client_id <> secondary_client_id)
);
CREATE UNIQUE INDEX client_merges_secondary_idx ON journal.client_merges (secondary_client_id);
CREATE INDEX client_merges_primary_idx ON journal.client_merges (primary_client_id, merged_at);
SELECT journal.make_append_only('journal.client_merges');

-- migrate:down
DROP TABLE journal.client_merges;
ALTER TABLE journal.loyalty_batch_moves DROP CONSTRAINT loyalty_batch_moves_kind_check;
ALTER TABLE journal.loyalty_batch_moves ADD CONSTRAINT loyalty_batch_moves_kind_check
  CHECK (kind IN ('spend_time','spend_goods','penalty','expire','return','debt_cover','manual','accrual_reversal'));
DROP INDEX app.clients_merged_into_idx;
ALTER TABLE app.clients DROP CONSTRAINT clients_merged_into_check;
ALTER TABLE app.clients DROP CONSTRAINT clients_phone_or_closed_check;
ALTER TABLE app.clients DROP CONSTRAINT clients_status_check;
ALTER TABLE app.clients ADD CONSTRAINT clients_status_check
  CHECK (status IN ('guest','active','restricted','blocked','deletion_requested','anonymized'));
ALTER TABLE app.clients ADD CHECK (phone_e164 IS NOT NULL OR status = 'anonymized');
ALTER TABLE app.clients DROP COLUMN merged_into_id;

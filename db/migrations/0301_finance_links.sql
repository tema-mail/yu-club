-- 0301_finance_links: связь операции кассы с объектом Э3 (K17 §14, model-dannyh 0301, шаг S3-05).
--   app.finance_operation_links – операция ↔ мероприятие / ремонт / ведомость зарплаты. Одна живая связь на операцию –
--   частичный уникальный индекс (одна операция не учитывается двумя объектами: 10 §9.1, 11 §8.4, TC-19).
--   Отвязка – unlinked_at с причиной (право finance.correct), строки не удаляются; у yu_app меняются только поля отвязки.
--   ref_id – полиморфная ссылка без FK (как occupancy.source_id); line_id – FK на event_lines добавит 0305 (D3-03).

-- migrate:up
CREATE TABLE app.finance_operation_links (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id  uuid NOT NULL REFERENCES journal.finance_operations(id),
  branch_id     uuid NOT NULL REFERENCES app.branches(id),
  ref_type      text NOT NULL CHECK (ref_type IN ('event','repair','payroll_statement')),
  ref_id        uuid NOT NULL,
  role          text NOT NULL CHECK (role IN ('income','refund','expense','payout_expense')),
  in_cost       boolean NOT NULL DEFAULT false,
  line_id       uuid,
  linked_by     uuid NOT NULL,
  linked_at     timestamptz NOT NULL,
  unlinked_at   timestamptz,
  unlinked_by   uuid,
  unlink_reason text,
  CHECK ((unlinked_at IS NULL) = (unlink_reason IS NULL)),
  CHECK ((unlinked_at IS NULL) = (unlinked_by IS NULL)),
  CHECK (unlink_reason IS NULL OR btrim(unlink_reason) <> ''),
  CHECK (unlinked_at IS NULL OR unlinked_at >= linked_at)
);
CREATE UNIQUE INDEX finance_operation_links_one_live ON app.finance_operation_links (operation_id) WHERE unlinked_at IS NULL;
CREATE INDEX finance_operation_links_ref_idx ON app.finance_operation_links (ref_type, ref_id) WHERE unlinked_at IS NULL;
CREATE INDEX finance_operation_links_operation_idx ON app.finance_operation_links (operation_id);
REVOKE UPDATE, DELETE, TRUNCATE ON app.finance_operation_links FROM yu_app;
GRANT UPDATE (unlinked_at, unlinked_by, unlink_reason) ON app.finance_operation_links TO yu_app;

-- migrate:down
DROP TABLE app.finance_operation_links;

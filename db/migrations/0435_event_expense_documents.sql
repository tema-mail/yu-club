-- 0435_event_expense_documents: документ к расходу мероприятия (11 §11.4, K20 §6, K19 §9). Владелец – модуль events.
--   app.event_expense_documents – вложение (owner_type 'event', этого мероприятия) ↔ операция расхода, связанная с мероприятием
--   ролью expense. Одна живая строка на операцию – частичный уникальный индекс; новый документ заменяет прежний: прежняя строка
--   получает replaced_at/replaced_by, строки не удаляются. У yu_app меняются только поля замены.
--   operation_id – FK на журнал кассы, attachment_id – FK на вложения; что вложение этого мероприятия и активно, а операция –
--   живая связь expense этого мероприятия, проверяет events/attachments.ts (связи и вложения – чужие таблицы).

-- migrate:up
CREATE TABLE app.event_expense_documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      uuid NOT NULL REFERENCES app.events(id),
  operation_id  uuid NOT NULL REFERENCES journal.finance_operations(id),
  attachment_id uuid NOT NULL REFERENCES app.attachments(id),
  created_by    uuid NOT NULL,
  created_at    timestamptz NOT NULL,
  replaced_at   timestamptz,
  replaced_by   uuid,
  CHECK ((replaced_at IS NULL) = (replaced_by IS NULL)),
  CHECK (replaced_at IS NULL OR replaced_at >= created_at)
);
CREATE UNIQUE INDEX event_expense_documents_one_live ON app.event_expense_documents (operation_id) WHERE replaced_at IS NULL;
CREATE INDEX event_expense_documents_event_idx ON app.event_expense_documents (event_id) WHERE replaced_at IS NULL;
REVOKE UPDATE, DELETE, TRUNCATE ON app.event_expense_documents FROM yu_app;
GRANT UPDATE (replaced_at, replaced_by) ON app.event_expense_documents TO yu_app;

-- migrate:down
DROP TABLE app.event_expense_documents;

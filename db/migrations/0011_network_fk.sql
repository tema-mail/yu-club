-- 0011_network_fk: связи таблиц Э0 с сетью (model-dannyh §0008), отложенные из 0008_network.
-- Назначения сотрудников – на существующие город/филиал; счета и проводки журнала – на существующий филиал.
-- Удаления городов и филиалов нет (у yu_app отозван DELETE, 0008), поэтому ON DELETE не задаём.
-- outbox и audit_events намеренно без FK: это журналы, событие пишется и о филиале, которого уже нет в зоне.

-- migrate:up
ALTER TABLE app.staff_assignments
  ADD CONSTRAINT staff_assignments_city_fk FOREIGN KEY (city_id) REFERENCES app.cities(id),
  ADD CONSTRAINT staff_assignments_branch_fk FOREIGN KEY (branch_id) REFERENCES app.branches(id);
ALTER TABLE app.ledger_accounts
  ADD CONSTRAINT ledger_accounts_branch_fk FOREIGN KEY (branch_id) REFERENCES app.branches(id);
ALTER TABLE journal.ledger_entries
  ADD CONSTRAINT ledger_entries_branch_fk FOREIGN KEY (branch_id) REFERENCES app.branches(id);

-- migrate:down
ALTER TABLE journal.ledger_entries DROP CONSTRAINT ledger_entries_branch_fk;
ALTER TABLE app.ledger_accounts DROP CONSTRAINT ledger_accounts_branch_fk;
ALTER TABLE app.staff_assignments DROP CONSTRAINT staff_assignments_branch_fk, DROP CONSTRAINT staff_assignments_city_fk;

-- 0449_report_exports_same_request_active: «тот же запрос – та же задача» только пока задача в работе (K24 §7, D5-13).
-- Владелец – reports (0408). Прежний частичный UNIQUE держал и ready: повтор запроса до конца срока файла (24 ч) возвращал
-- файл, рассчитанный раньше, – нарушение K24 §2 «Актуальность» (отчёт считается по живой базе в момент запроса). На стенде
-- 10.11 файл «Финансы и касса» 15:05 (1700 ₽) отдался запросу 16:00, когда экран уже показывал 1800 ₽ (e4.spec.ts, сценарий 3).
-- Теперь повтор, пока задача queued/running, – та же задача (двойной клик, повтор сети); после ready – новая задача и новый
-- расчёт, прежний файл скачивается до своего срока.

-- migrate:up
DROP INDEX app.report_exports_same_request;
CREATE UNIQUE INDEX report_exports_same_request ON app.report_exports (staff_id, params_hash) WHERE status IN ('queued','running');

-- migrate:down
-- у прежнего индекса одна ready на запрос: из повторов остаётся самая новая, старые – expired (файлы заберёт уборка как осиротевшие)
UPDATE app.report_exports r SET status = 'expired', file_key = NULL
WHERE r.status = 'ready' AND EXISTS (
  SELECT 1 FROM app.report_exports n
  WHERE n.staff_id = r.staff_id AND n.params_hash = r.params_hash AND n.status IN ('queued','running','ready') AND (n.created_at, n.id) > (r.created_at, r.id)
);
DROP INDEX app.report_exports_same_request;
CREATE UNIQUE INDEX report_exports_same_request ON app.report_exports (staff_id, params_hash) WHERE status IN ('queued','running','ready');

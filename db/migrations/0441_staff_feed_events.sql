-- 0441_staff_feed_events: остальные события ленты CRM (13 §11; S4-28/S4-97, Q-147/D4-46: лента без push). Таблицы – 0420,
-- здесь только списки CHECK. Новые виды: брони (booking.confirmed / rescheduled / cancelled → зона schedule.view), блокировка
-- ресурса (resource_block.created → block.manage), и три по таймеру раз в час (staff-feed-events.ts, пороги – K7
-- notifications.feed_*): незаполненная смена (shift.manage, ссылка на филиал), подготовка мероприятия (event.view),
-- окончание гарантии (equipment.view, ссылка на оборудование). «Операция ожидает согласования» не вводится: в finance
-- механизма согласования нет (06 ТЗ его не задаёт); согласование ремонта (Q-52) – без события outbox, отдельным решением.
-- Таймерные строки идемпотентны ключом '<kind>:<сущность>:<порог>' – одна строка на сущность и порог при повторных проходах.

-- migrate:up
ALTER TABLE app.staff_feed_events DROP CONSTRAINT staff_feed_events_action_check;
ALTER TABLE app.staff_feed_events ADD CONSTRAINT staff_feed_events_action_check
  CHECK (action IN ('equipment.view','notifications.view','schedule.view','block.manage','event.view','shift.manage'));
ALTER TABLE app.staff_feed_events DROP CONSTRAINT staff_feed_events_kind_check;
ALTER TABLE app.staff_feed_events ADD CONSTRAINT staff_feed_events_kind_check
  CHECK (kind IN ('shift_changed','repair_registered','repair_closed','service_notification_failed',
                  'booking_created','booking_rescheduled','booking_cancelled','block_created',
                  'shift_unfilled','event_preparation','warranty_ending'));
ALTER TABLE app.staff_feed_events DROP CONSTRAINT staff_feed_events_ref_type_check;
ALTER TABLE app.staff_feed_events ADD CONSTRAINT staff_feed_events_ref_type_check
  CHECK (ref_type IN ('shift','repair','client','booking','resource_block','event','equipment','branch'));

-- migrate:down
ALTER TABLE app.staff_feed_events DROP CONSTRAINT staff_feed_events_ref_type_check;
ALTER TABLE app.staff_feed_events ADD CONSTRAINT staff_feed_events_ref_type_check CHECK (ref_type IN ('shift','repair','client'));
ALTER TABLE app.staff_feed_events DROP CONSTRAINT staff_feed_events_kind_check;
ALTER TABLE app.staff_feed_events ADD CONSTRAINT staff_feed_events_kind_check
  CHECK (kind IN ('shift_changed','repair_registered','repair_closed','service_notification_failed'));
ALTER TABLE app.staff_feed_events DROP CONSTRAINT staff_feed_events_action_check;
ALTER TABLE app.staff_feed_events ADD CONSTRAINT staff_feed_events_action_check CHECK (action IN ('equipment.view','notifications.view'));

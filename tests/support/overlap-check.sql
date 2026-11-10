-- Проверка «ни одной пары пересечений по активным единицам» (план §8; запрос тот же, что в tests/load/booking-race.ts
-- и tests/resources/composite.test.ts). Две строки «имя|число», ждём 0 и 0:
--   occupancy_overlaps – две живые строки занятости одной единицы на пересекающиеся интервалы (EXCLUDE должен не пускать);
--   double_bookings    – две живые брони одного ресурса на пересекающееся время.
-- Гоняется через psql -At (стенд по ssh, .github/workflows/stand-e2e.yml) и tests/support/overlap-check.ts (кластер CI,
-- .github/workflows/races-nightly.yml).
SELECT 'occupancy_overlaps' AS name, count(*)::int AS n
  FROM app.occupancy a
  JOIN app.occupancy b ON a.unit_id = b.unit_id AND a.id < b.id AND a.period && b.period
 WHERE a.active AND b.active
UNION ALL
SELECT 'double_bookings', count(*)::int
  FROM app.bookings b1
  JOIN app.bookings b2 ON b1.resource_id = b2.resource_id AND b1.id < b2.id AND b1.period && b2.period
 WHERE b1.status NOT LIKE 'cancelled%' AND b2.status NOT LIKE 'cancelled%';

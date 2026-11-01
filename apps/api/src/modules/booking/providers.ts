// Реализации зависимостей других модулей по таблицам броней (после S1-07). Подключает server.ts:
// network (K13) – список затронутых броней при изменении графика; clients (K9) – связь клиента с филиалами для
// поиска в CRM. Модули network и clients booking не импортируют – получают эти объекты извне (ADR 0002).
import type { Db, Tx } from '../../core/audit.ts';

/** Действующие брони (confirmed / arrived) – они и считаются «затронутыми» при сокращении часов и блокировках. */
export const LIVE_BOOKING = `status IN ('confirmed','arrived')`;

export interface FutureBookingRow {
  id: string;
  resourceId: string;
  roomId: string | null;
  start: Date;
  end: Date;
}

/** network AffectedBookingsProvider: брони филиала, пересекающие [from, to) (to = null – без верха). */
export const bookingsProvider = {
  async futureBookings(db: Db | Tx, input: { branchId: string; from: Date; to: Date | null }): Promise<FutureBookingRow[]> {
    const r = await db.query<FutureBookingRow>(
      `SELECT b.id, b.resource_id AS "resourceId", r.room_id AS "roomId", lower(b.period) AS start, upper(b.period) AS "end"
       FROM app.bookings b JOIN app.resources r ON r.id = b.resource_id
       WHERE b.branch_id = $1 AND b.${LIVE_BOOKING} AND b.period && tstzrange($2, $3, '[)')
       ORDER BY lower(b.period), b.number`,
      [input.branchId, input.from, input.to],
    );
    return r.rows;
  },
};

/** clients ClientBranchLinks: у клиента есть бронь в одном из филиалов параметра (любого статуса – история). */
export const clientBranchLinks = {
  existsSql: (clientIdColumn: string, branchIdsParam: string): string =>
    `EXISTS (SELECT 1 FROM app.bookings bk WHERE bk.client_id = ${clientIdColumn} AND bk.branch_id = ANY(${branchIdsParam}))`,
};

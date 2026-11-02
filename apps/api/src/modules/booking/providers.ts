// Реализации зависимостей других модулей по таблицам броней (после S1-07). Подключает server.ts:
// network (K13) – список затронутых броней при изменении графика; resources – будущие брони и удержания ресурса
// при смене состава (futureUsage); clients (K9) – связь клиента с филиалами для
// поиска в CRM; notifications (K14) – состояние брони для проверок перед отправкой и обработчиков событий.
// Модули network, clients и notifications booking не импортируют – получают эти объекты извне (ADR 0002).
import type { Db, Tx } from '../../core/audit.ts';
import type { TimeZone } from '../../core/time.ts';

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

  /** resources ResourceUsageProvider (changeComposition): действующие брони ресурса и живые удержания с концом позже from. */
  async futureUsage(tx: Db | Tx, resourceId: string, from: Date, now: Date): Promise<{ bookingIds: string[]; holdIds: string[] }> {
    const b = await tx.query<{ id: string }>(
      `SELECT id FROM app.bookings WHERE resource_id = $1 AND ${LIVE_BOOKING} AND upper(period) > $2 ORDER BY id`,
      [resourceId, from],
    );
    const h = await tx.query<{ id: string }>(
      `SELECT DISTINCT h.id FROM app.hold_items hi JOIN app.holds h ON h.id = hi.hold_id
       WHERE hi.resource_id = $1 AND hi.status = 'active' AND upper(hi.period) > $2 AND h.status = 'active' AND h.expires_at > $3 ORDER BY h.id`,
      [resourceId, from, now],
    );
    return { bookingIds: b.rows.map((x) => x.id), holdIds: h.rows.map((x) => x.id) };
  },
};

/** clients ClientBranchLinks: у клиента есть бронь в одном из филиалов параметра (любого статуса – история). */
export const clientBranchLinks = {
  existsSql: (clientIdColumn: string, branchIdsParam: string): string =>
    `EXISTS (SELECT 1 FROM app.bookings bk WHERE bk.client_id = ${clientIdColumn} AND bk.branch_id = ANY(${branchIdsParam}))`,
};

/** notifications BookingLookup / BookingFactsLookup (K14, проверки 1–4 перед отправкой и обработчики событий):
 *  состояние и версия брони. arrived считается «завершённой» для напоминаний: клиент уже в клубе. */
export const bookingLookup = {
  async snapshot(tx: Db | Tx, bookingId: string): Promise<{ version: number; clientId: string; state: 'active' | 'cancelled' | 'finished' } | null> {
    const r = await tx.query<{ current_version: number; client_id: string; status: string }>('SELECT current_version, client_id, status FROM app.bookings WHERE id = $1', [bookingId]);
    const b = r.rows[0];
    if (!b) return null;
    const state = b.status === 'confirmed' ? 'active' : b.status.startsWith('cancelled') ? 'cancelled' : 'finished';
    return { version: b.current_version, clientId: b.client_id, state };
  },
  async facts(tx: Db | Tx, bookingId: string) {
    const r = await tx.query<{ current_version: number; client_id: string; branch_id: string; branch_timezone: string; name: string; s: Date; e: Date }>(
      `SELECT b.current_version, b.client_id, b.branch_id, v.branch_timezone, v.resource_snapshot ->> 'name' AS name, lower(b.period) AS s, upper(b.period) AS e
       FROM app.bookings b JOIN journal.booking_versions v ON v.booking_id = b.id AND v.version = b.current_version WHERE b.id = $1`,
      [bookingId],
    );
    const b = r.rows[0];
    if (!b) return null;
    return {
      bookingId, bookingVersion: b.current_version, clientId: b.client_id, branchId: b.branch_id, branchTimezone: b.branch_timezone as TimeZone,
      resourceName: b.name, start: b.s, end: b.e,
    };
  },
};

// ---- Э2 (S2-05): провайдеры для finance (K10 §4 payableBooking) и loyalty (K15 §3–5). Модули Э2 booking не импортируют –
// server.ts передаёт им этот объект (ADR 0002). Всё читается по текущей версии брони (booking_versions): перенос меняет цену и минуты.

export type BookingStatus = 'confirmed' | 'arrived' | 'completed' | 'no_show' | 'cancelled_by_client' | 'cancelled_by_club';

export interface PayableBookingRow {
  bookingId: string;
  branchId: string;
  branchTimezone: TimeZone;
  clientId: string;
  status: BookingStatus;
  /** K10 §1: к оплате только arrived | completed. */
  payable: boolean;
  version: number;
  priceKop: number;
  /** Минуты по расписанию текущей версии (07 §4.3, Q-40). */
  minutes: number;
  resourceId: string;
  resourceType: string;
  start: Date;
  end: Date;
}

export interface HoldBookingRow {
  bookingId: string;
  clientId: string;
  status: BookingStatus;
  minutes: number;
  resourceType: string;
}

const PAYABLE = new Set<BookingStatus>(['arrived', 'completed']);
const minutesSql = (period: string) => `(extract(epoch FROM upper(${period}) - lower(${period})) / 60)::int`;

export const paymentBookingProvider = {
  /** K10 §4 п.1: бронь для оплаты под FOR SHARE строки bookings (статус не сменится до конца транзакции оплаты). Нет брони – null. */
  async payableBooking(tx: Db | Tx, bookingId: string): Promise<PayableBookingRow | null> {
    const r = await tx.query<Omit<PayableBookingRow, 'payable' | 'priceKop'> & { priceKop: string }>(
      `SELECT b.id AS "bookingId", b.branch_id AS "branchId", v.branch_timezone AS "branchTimezone", b.client_id AS "clientId",
              b.status, b.current_version AS version, v.price_kop AS "priceKop", ${minutesSql('v.period')} AS minutes,
              v.resource_id AS "resourceId", r.resource_type AS "resourceType", lower(v.period) AS start, upper(v.period) AS "end"
       FROM app.bookings b
       JOIN journal.booking_versions v ON v.booking_id = b.id AND v.version = b.current_version
       JOIN app.resources r ON r.id = v.resource_id
       WHERE b.id = $1
       FOR SHARE OF b`,
      [bookingId],
    );
    const row = r.rows[0];
    if (!row) return null;
    return { ...row, priceKop: Number(row.priceKop), payable: PAYABLE.has(row.status) };
  },

  /** K15 §4: активное посещение брони (начисление – только при нём). */
  async activeVisit(tx: Db | Tx, bookingId: string): Promise<{ visitId: string; branchId: string; clientId: string; arrivedAt: Date } | null> {
    const r = await tx.query<{ visitId: string; branchId: string; clientId: string; arrivedAt: Date }>(
      `SELECT id AS "visitId", branch_id AS "branchId", client_id AS "clientId", arrived_at AS "arrivedAt"
       FROM app.visits WHERE booking_id = $1 AND status = 'active'`,
      [bookingId],
    );
    return r.rows[0] ?? null;
  },

  /** K15 §5 (penalty_scope 'visit', Q-44): брони того же клиента в том же филиале, идущие подряд без перерыва
   *  (конец одной = начало следующей), включая саму бронь; отменённые разрывают цепочку. Порядок – по началу. */
  async adjacentChain(tx: Db | Tx, bookingId: string): Promise<string[]> {
    const r = await tx.query<{ id: string }>(
      `WITH RECURSIVE live AS (
         SELECT b.id, b.period FROM app.bookings b
         JOIN app.bookings me ON me.id = $1 AND b.client_id = me.client_id AND b.branch_id = me.branch_id
         WHERE b.status NOT LIKE 'cancelled%'
       ),
       chain AS (
         SELECT id, period FROM live WHERE id = $1
         UNION
         SELECT l.id, l.period FROM live l JOIN chain c ON upper(l.period) = lower(c.period) OR lower(l.period) = upper(c.period)
       )
       SELECT id FROM chain ORDER BY lower(period), id`,
      [bookingId],
    );
    return r.rows.map((x) => x.id);
  },

  /** K15 §3: брони, созданные подтверждением удержания (резерв удержания → резерв каждой брони). */
  async holdBookings(tx: Db | Tx, holdId: string): Promise<HoldBookingRow[]> {
    const r = await tx.query<HoldBookingRow>(
      `SELECT b.id AS "bookingId", b.client_id AS "clientId", b.status, ${minutesSql('v.period')} AS minutes, r.resource_type AS "resourceType"
       FROM app.bookings b
       JOIN journal.booking_versions v ON v.booking_id = b.id AND v.version = b.current_version
       JOIN app.resources r ON r.id = v.resource_id
       WHERE b.hold_id = $1
       ORDER BY lower(v.period), b.id`,
      [holdId],
    );
    return r.rows;
  },

  /** K10 §4 listUnpaid: брони филиала к оплате (arrived | completed), начало которых в [from, to) – по текущей версии. */
  async payableInPeriod(db: Db | Tx, input: { branchId: string; from: Date; to: Date }): Promise<PayableInPeriodRow[]> {
    const r = await db.query<Omit<PayableInPeriodRow, 'number' | 'priceKop'> & { number: string; priceKop: string }>(
      `SELECT b.id AS "bookingId", b.number, b.status, b.client_id AS "clientId", v.resource_snapshot ->> 'name' AS "resourceName",
              lower(v.period) AS start, upper(v.period) AS "end", v.price_kop AS "priceKop"
       FROM app.bookings b JOIN journal.booking_versions v ON v.booking_id = b.id AND v.version = b.current_version
       WHERE b.branch_id = $1 AND b.status IN ('arrived','completed') AND lower(v.period) >= $2 AND lower(v.period) < $3
       ORDER BY lower(v.period), b.number`,
      [input.branchId, input.from, input.to],
    );
    return r.rows.map((x) => ({ ...x, number: Number(x.number), priceKop: Number(x.priceKop) }));
  },
};

export interface PayableInPeriodRow {
  bookingId: string;
  number: number;
  status: BookingStatus;
  clientId: string;
  resourceName: string | null;
  start: Date;
  end: Date;
  priceKop: number;
}

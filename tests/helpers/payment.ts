// Платёж-заглушка для тестов модулей, которые пишут payment_id (погашение сертификата, начисление баллов):
// с 0205 у certificate_redemptions.payment_id и loyalty_accruals.payment_id есть FK → payments.
// Строка создаётся со статусом refunded – живым платежом не считается и не мешает payments_one_live_per_session.
import { randomUUID } from 'node:crypto';

interface Q {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

/** Сеанс брони (если нет) и платёж с id; возвращает id. Владельцем базы, без кода finance. */
export async function createTestPayment(db: Q, bookingId: string, id: string = randomUUID()): Promise<string> {
  await db.query(
    `INSERT INTO app.payment_sessions (booking_id, branch_id, client_id, amount_due_kop, booking_version)
     SELECT id, branch_id, client_id, price_kop, current_version FROM app.bookings WHERE id = $1 ON CONFLICT (booking_id) DO NOTHING`,
    [bookingId],
  );
  await db.query(
    `INSERT INTO app.payments (id, session_id, attempt, status, total_kop, topup_rule_snapshot, recorded_by, recorded_at)
     SELECT $2::uuid, $1::uuid, coalesce(max(attempt), 0) + 1, 'refunded', 0, false, gen_random_uuid(), now() FROM app.payments WHERE session_id = $1`,
    [bookingId, id],
  );
  return id;
}

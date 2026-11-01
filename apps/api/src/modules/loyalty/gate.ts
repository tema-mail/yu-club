// K15 §8 (07 §9.2–9.4): ворота записи на −50. Регистрирует server.ts в clients.assertCanBook (K9, S2-33):
// createHold и attachHold известного клиента, confirmHold, бронь администратором. Баланс ≤ −5000 →
// LOYALTY_LIMIT_REACHED 403 с текстом 07 §9.2. Снимается само, когда баланс выше −50 (флага нет – только вычисление).
// Обход (override) ворота принимают как есть: право loyalty.book_below_limit и причину проверяет маршрут CRM (S2-35).
import { AppError } from '../../core/errors.ts';
import type { Db } from '../../core/audit.ts';
import type { BookingGate } from '../clients/index.ts';
import { POINTS_MIN_BALANCE } from './account.ts';

/** Текст 07 §9.2 – причину не скрываем: клиент и так видит баланс в ЛК. */
export const LIMIT_MESSAGE =
  'Предварительная запись временно недоступна: баланс бонусных баллов достиг минимального значения −50. Обратитесь к администратору клуба';

export async function balanceCentiOf(tx: Db, clientId: string): Promise<number> {
  const r = await tx.query<{ balance: string }>(
    `SELECT balance FROM app.ledger_accounts WHERE kind = 'loyalty_client' AND owner_type = 'client' AND owner_id = $1`,
    [clientId],
  );
  return Number(r.rows[0]?.balance ?? 0);
}

export const loyaltyGate: BookingGate = {
  name: 'loyalty',
  async check(tx, input) {
    if (input.override) return;
    const balance = await balanceCentiOf(tx, input.clientId);
    if (balance <= POINTS_MIN_BALANCE) throw new AppError('LOYALTY_LIMIT_REACHED', 403, LIMIT_MESSAGE, { balanceCenti: balance });
  },
};

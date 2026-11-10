// K9 «Обезличивание», обработчик модуля booking. ПДн в бронях нет (клиент – по client_id, имя и телефон – в clients),
// поэтому run ничего не меняет: брони, версии и деньги остаются как есть (03 §13). Мешает обезличиванию живая бронь:
// подтверждённая, которая ещё не закончилась, или клиент сейчас в клубе (arrived) – сначала отмена или завершение (решение D4-63).
// Свободный текст сотрудника (internal_comment, cancel_comment) не затирается: журнал версий брони – только вставка (D4-65).
import type { Tx } from '../../core/audit.ts';
import type { ClientAnonymizer } from '../clients/anonymize.ts';

export const bookingClientAnonymizer: ClientAnonymizer = {
  name: 'booking',
  async blockers(tx: Tx, clientId: string, now: Date): Promise<number> {
    const r = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM app.bookings
       WHERE client_id = $1 AND (status = 'arrived' OR (status = 'confirmed' AND upper(period) > $2))`,
      [clientId, now],
    );
    return r.rows[0]?.n ?? 0;
  },
  async run(): Promise<number> {
    return 0;
  },
};

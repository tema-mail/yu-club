// K9 «Слияние», обработчик модуля finance: сеансы оплаты (payment_sessions.client_id) второй карточки переезжают на
// основную вместе с бронями. Платежи, строки и возвраты на клиента не ссылаются – они остаются как есть, суммы по
// журналу K3 не меняются (03 §11.2 «нельзя просто складывать платежи»: ничего не складывается, меняется владелец сеанса).
import type { Db, Tx } from '../../core/audit.ts';
import type { ClientMerger } from '../clients/merge.ts';

export interface FinanceMergePreview {
  /** Живые платежи (active, partially_refunded) и их сумма в копейках. */
  payments: number;
  paidKop: number;
  refundedKop: number;
  /** Неоплаченные сеансы. */
  unpaidSessions: number;
}

const n = (v: unknown): number => Number(v ?? 0);

export const financeClientMerger: ClientMerger = {
  name: 'finance',
  async preview(db: Db, clientId: string): Promise<FinanceMergePreview> {
    const r = await db.query<{ payments: string; paid: string; refunded: string; unpaid: string }>(
      `SELECT (SELECT count(*) FROM app.payments p JOIN app.payment_sessions s ON s.booking_id = p.session_id
               WHERE s.client_id = $1 AND p.status IN ('active','partially_refunded')) AS payments,
              (SELECT coalesce(sum(p.total_kop), 0) FROM app.payments p JOIN app.payment_sessions s ON s.booking_id = p.session_id
               WHERE s.client_id = $1 AND p.status IN ('active','partially_refunded')) AS paid,
              (SELECT coalesce(sum(r.amount_kop), 0) FROM app.payment_refunds r JOIN app.payments p ON p.id = r.payment_id
               JOIN app.payment_sessions s ON s.booking_id = p.session_id WHERE s.client_id = $1 AND r.outcome = 'returned') AS refunded,
              (SELECT count(*) FROM app.payment_sessions WHERE client_id = $1 AND status = 'unpaid') AS unpaid`,
      [clientId],
    );
    const row = r.rows[0]!;
    return { payments: n(row.payments), paidKop: n(row.paid), refundedKop: n(row.refunded), unpaidSessions: n(row.unpaid) };
  },
  async reassign(tx: Tx, from: string, to: string): Promise<Record<string, number>> {
    const sessions = (await tx.query('UPDATE app.payment_sessions SET client_id = $2 WHERE client_id = $1', [from, to])).rowCount ?? 0;
    return { sessions };
  },
};

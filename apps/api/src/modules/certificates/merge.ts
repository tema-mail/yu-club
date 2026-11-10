// K9 «Слияние», обработчик модуля certificates (K16, 08 §7): сертификат на предъявителя, его остаток – счёт K3 самого
// сертификата, поэтому деньги не двигаются – меняется только держатель. Получатель вторая карточка → основная;
// куплен второй карточкой без получателя → получателем становится основная (иначе пропал бы из ЛК, routes.public MINE).
// Каждая смена – строка journal.certificate_holder_history (старый, новый, автор, время), как linkRecipient.
// Покупатель (buyer_client_id) и клиент погашения – история продажи и оплаты, у yu_app нет UPDATE этих столбцов (08 §15):
// остаются по id второй карточки (решение D5-07).
import type { Db, Tx } from '../../core/audit.ts';
import type { ClientMerger, MergeContext } from '../clients/merge.ts';

const MINE = '(c.recipient_client_id = $1 OR (c.recipient_client_id IS NULL AND c.buyer_client_id = $1))';

export const certificatesClientMerger: ClientMerger = {
  name: 'certificates',
  async preview(db: Db, clientId: string, now: Date) {
    const r = await db.query<{ total: number; active: number; balance: string }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE c.cancelled_at IS NULL AND c.review_reason IS NULL AND c.expires_at > $2 AND a.balance > 0)::int AS active,
              coalesce(sum(a.balance) FILTER (WHERE c.cancelled_at IS NULL AND c.expires_at > $2), 0) AS balance
       FROM app.certificates c JOIN app.ledger_accounts a ON a.id = c.ledger_account_id WHERE ${MINE}`,
      [clientId, now],
    );
    const row = r.rows[0]!;
    return { total: row.total, active: row.active, balanceKop: Number(row.balance) };
  },
  async reassign(tx: Tx, from: string, to: string, ctx: MergeContext): Promise<Record<string, number>> {
    const rows = (
      await tx.query<{ id: string; recipient_client_id: string | null }>(
        `SELECT c.id, c.recipient_client_id FROM app.certificates c WHERE ${MINE} ORDER BY c.id FOR UPDATE`,
        [from],
      )
    ).rows;
    for (const c of rows) {
      await tx.query('UPDATE app.certificates SET recipient_client_id = $2, row_version = row_version + 1 WHERE id = $1', [c.id, to]);
      await tx.query(
        `INSERT INTO journal.certificate_holder_history (certificate_id, old_client_id, new_client_id, changed_by, changed_at) VALUES ($1, $2, $3, $4, $5)`,
        [c.id, c.recipient_client_id, to, ctx.staffId, ctx.now],
      );
    }
    return { certificates: rows.length };
  },
};

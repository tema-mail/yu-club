// K9 «Слияние», обработчик модуля notifications (K21): сообщения второй карточки (история и запланированные
// напоминания о бронях, которые уже переехали к основной) переходят к основной – ЛК основной видит их в центре уведомлений.
// Push-подписки второй отзывает сама процедура (как при обезличивании). Снимок аудитории кампаний
// (journal.notification_campaign_recipients) и журнал согласий – только вставка: остаются по id второй (решение D5-05).
import type { Db, Tx } from '../../core/audit.ts';
import type { ClientMerger } from '../clients/merge.ts';

export const notificationsClientMerger: ClientMerger = {
  name: 'notifications',
  async preview(db: Db, clientId: string) {
    const r = await db.query<{ messages: number; planned: number; subscriptions: number }>(
      `SELECT (SELECT count(*)::int FROM app.notifications WHERE client_id = $1) AS messages,
              (SELECT count(*)::int FROM app.notifications WHERE client_id = $1 AND status = 'planned') AS planned,
              (SELECT count(*)::int FROM app.push_subscriptions WHERE client_id = $1 AND revoked_at IS NULL) AS subscriptions`,
      [clientId],
    );
    return r.rows[0]!;
  },
  async reassign(tx: Tx, from: string, to: string): Promise<Record<string, number>> {
    const messages = (await tx.query('UPDATE app.notifications SET client_id = $2 WHERE client_id = $1', [from, to])).rowCount ?? 0;
    return { messages };
  },
};

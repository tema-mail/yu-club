// K9 «Слияние», обработчик модуля events (K20): мероприятия, где вторая карточка – заказчик или именинник, и подарки
// имениннику переходят к основной; суммы, состав, статусы и история не меняются. Имя и телефон заказчика в самом
// мероприятии – данные заявки, не карточки: не переписываются. Два подарка одного года у одного человека (EXCLUDE
// birthday_gifts_one_per_year) – 409 CLIENT_MERGE_CONFLICT: сначала отменить лишний подарок (решение D5-06).
import type { Db, Tx } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import type { ClientMerger } from '../clients/merge.ts';

export const eventsClientMerger: ClientMerger = {
  name: 'events',
  /** Мероприятия второй карточки – до строк клиентов: правка мероприятия берёт его, затем клиента (events.ts), иначе дедлок.
   *  Подарки – после клиентов, как в gift-booking (клиент → подарок). */
  async prelock(tx: Tx, from: string): Promise<void> {
    await tx.query('SELECT id FROM app.events WHERE customer_client_id = $1 OR birthday_client_id = $1 ORDER BY id FOR UPDATE', [from]);
  },
  async preview(db: Db, clientId: string) {
    const r = await db.query<{ events: number; live: number; gifts: number }>(
      `SELECT (SELECT count(*)::int FROM app.events WHERE customer_client_id = $1 OR birthday_client_id = $1) AS events,
              (SELECT count(*)::int FROM app.events WHERE (customer_client_id = $1 OR birthday_client_id = $1)
                 AND status NOT IN ('completed','cancelled','not_held')) AS live,
              (SELECT count(*)::int FROM app.birthday_gifts WHERE client_id = $1 AND status <> 'cancelled') AS gifts`,
      [clientId],
    );
    return r.rows[0]!;
  },
  async reassign(tx: Tx, from: string, to: string): Promise<Record<string, number>> {
    const customer = (await tx.query('UPDATE app.events SET customer_client_id = $2, row_version = row_version + 1 WHERE customer_client_id = $1', [from, to])).rowCount ?? 0;
    const birthday = (await tx.query('UPDATE app.events SET birthday_client_id = $2, row_version = row_version + 1 WHERE birthday_client_id = $1', [from, to])).rowCount ?? 0;
    let gifts: number;
    try {
      gifts = (await tx.query('UPDATE app.birthday_gifts SET client_id = $2, row_version = row_version + 1 WHERE client_id = $1', [from, to])).rowCount ?? 0;
    } catch (err) {
      if ((err as { code?: string }).code === '23P01') {
        throw new AppError('CLIENT_MERGE_CONFLICT', 409, 'У обеих карточек подарок имениннику за один год – сначала отмените лишний', {
          module: 'events', constraint: 'birthday_gifts_one_per_year',
        });
      }
      throw err;
    }
    return { customer, birthday, gifts };
  },
};

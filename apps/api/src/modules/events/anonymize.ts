// K9 «Обезличивание», обработчик модуля events (K20 §14, K21 §15, техдолг 4.6). ПДн мероприятия – имя и телефон заказчика,
// имя именинника, пожелания. Столбцы заказчика NOT NULL с CHECK – заглушки ниже; суммы, состав, статус и история остаются.
// Решение D4-64 (уже буквы K20 §14): клиент – заказчик → затираются все четыре поля; клиент – только именинник →
// имя именинника и пожелания, контакт заказчика (другого человека, обычно родителя) остаётся – его ПДн этим запросом не отзывались.
// Мешает обезличиванию мероприятие клиента в работе (не завершено, не отменено, не «не состоялось») – сначала закрыть.
import type { Tx } from '../../core/audit.ts';
import type { ClientAnonymizer } from '../clients/anonymize.ts';

export const ANONYMIZED_CUSTOMER_NAME = 'Обезличено';
export const ANONYMIZED_PHONE = '+70000000000';

export const eventsClientAnonymizer: ClientAnonymizer = {
  name: 'events',
  /** Мероприятия клиента – до строки клиента: правка мероприятия и слияние берут мероприятие, затем клиента (D5-08). */
  async prelock(tx: Tx, clientId: string): Promise<void> {
    await tx.query('SELECT id FROM app.events WHERE customer_client_id = $1 OR birthday_client_id = $1 ORDER BY id FOR UPDATE', [clientId]);
  },
  async blockers(tx: Tx, clientId: string): Promise<number> {
    const r = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM app.events
       WHERE (customer_client_id = $1 OR birthday_client_id = $1) AND status NOT IN ('completed', 'cancelled', 'not_held')`,
      [clientId],
    );
    return r.rows[0]?.n ?? 0;
  },
  async run(tx: Tx, clientId: string): Promise<number> {
    const r = await tx.query(
      `UPDATE app.events SET
         customer_name = CASE WHEN customer_client_id = $1 THEN $2 ELSE customer_name END,
         customer_phone_e164 = CASE WHEN customer_client_id = $1 THEN $3 ELSE customer_phone_e164 END,
         birthday_person_name = NULL, wishes = NULL, row_version = row_version + 1
       WHERE (customer_client_id = $1 AND (customer_name <> $2 OR customer_phone_e164 <> $3 OR birthday_person_name IS NOT NULL OR wishes IS NOT NULL))
          OR (birthday_client_id = $1 AND (birthday_person_name IS NOT NULL OR wishes IS NOT NULL))`,
      [clientId, ANONYMIZED_CUSTOMER_NAME, ANONYMIZED_PHONE],
    );
    return r.rowCount ?? 0;
  },
};

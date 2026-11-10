// K9 «Слияние», обработчик модуля booking: брони, удержания, время клиента (client_time), посещения и неявки
// второй карточки переезжают на основную – история и исходные идентификаторы сохраняются (03 §11.2), меняется только
// client_id. Пересечение времени по сети (EXCLUDE client_time_no_overlap): у обеих карточек живые записи на одно время –
// слияние невозможно, 409 CLIENT_MERGE_CONFLICT (решение D5-06): сначала отменить одну из броней.
// Замки: prelock берёт удержания и брони второй карточки FOR UPDATE ДО строки клиента – тот же порядок, что у подтверждения,
// отмены и переноса (удержание/бронь → клиент), взаимоблокировки нет. Строки клиентов – под замком процедуры (FOR UPDATE):
// новая бронь на вторую карточку ждёт и получает CLIENT_RESTRICTED (merged), удержание – NOT_FOUND (уже у основной).
// Удержание, созданное между prelock и замком клиента и занятое чужой командой, – 409 CLIENT_MERGE_CONFLICT
// (reason busy, повторить), а не взаимоблокировка. Журнал версий броней – только вставка, не трогается.
import type { Db, Tx } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import type { ClientMerger } from '../clients/merge.ts';

export interface BookingMergePreview {
  /** Впереди: подтверждённые, ещё не закончившиеся, и клиент в клубе (arrived). */
  upcoming: number;
  /** Прошедшие посещения (visits active). */
  visits: number;
  noShows: number;
  cancelled: number;
  /** Живые удержания (active, срок не вышел). */
  holds: number;
  total: number;
}

const n = (v: unknown): number => Number(v ?? 0);

const busy = () =>
  new AppError('CLIENT_MERGE_CONFLICT', 409, 'По второй карточке прямо сейчас оформляется запись – повторите объединение через минуту', {
    module: 'booking', reason: 'busy',
  });

export const bookingClientMerger: ClientMerger = {
  name: 'booking',
  async prelock(tx: Tx, from: string): Promise<void> {
    await tx.query('SELECT id FROM app.holds WHERE client_id = $1 ORDER BY id FOR UPDATE', [from]);
    await tx.query('SELECT id FROM app.bookings WHERE client_id = $1 ORDER BY id FOR UPDATE', [from]);
  },
  async preview(db: Db, clientId: string, now: Date): Promise<BookingMergePreview> {
    const b = await db.query<{ upcoming: string; cancelled: string; total: string }>(
      `SELECT count(*) FILTER (WHERE status = 'arrived' OR (status = 'confirmed' AND upper(period) > $2)) AS upcoming,
              count(*) FILTER (WHERE status LIKE 'cancelled%') AS cancelled, count(*) AS total
       FROM app.bookings WHERE client_id = $1`,
      [clientId, now],
    );
    const v = await db.query<{ visits: string; no_shows: string }>(
      `SELECT (SELECT count(*) FROM app.visits WHERE client_id = $1 AND status = 'active') AS visits,
              (SELECT count(*) FROM app.no_shows WHERE client_id = $1 AND status = 'active') AS no_shows`,
      [clientId],
    );
    const h = await db.query<{ holds: string }>(`SELECT count(*) AS holds FROM app.holds WHERE client_id = $1 AND status = 'active' AND expires_at > $2`, [clientId, now]);
    const row = b.rows[0]!;
    return { upcoming: n(row.upcoming), visits: n(v.rows[0]!.visits), noShows: n(v.rows[0]!.no_shows), cancelled: n(row.cancelled), holds: n(h.rows[0]!.holds), total: n(row.total) };
  },
  async reassign(tx: Tx, from: string, to: string): Promise<Record<string, number>> {
    for (const t of ['holds', 'bookings']) {
      const r = await tx.query<{ total: number; free: number }>(
        `SELECT (SELECT count(*)::int FROM app.${t} WHERE client_id = $1) AS total,
                (SELECT count(*)::int FROM (SELECT id FROM app.${t} WHERE client_id = $1 FOR UPDATE SKIP LOCKED) x) AS free`,
        [from],
      );
      if (r.rows[0]!.total !== r.rows[0]!.free) throw busy();
    }
    const bookings = (await tx.query('UPDATE app.bookings SET client_id = $2 WHERE client_id = $1', [from, to])).rowCount ?? 0;
    const holds = (await tx.query('UPDATE app.holds SET client_id = $2 WHERE client_id = $1', [from, to])).rowCount ?? 0;
    let clientTime: number;
    try {
      clientTime = (await tx.query('UPDATE app.client_time SET client_id = $2 WHERE client_id = $1', [from, to])).rowCount ?? 0;
    } catch (err) {
      if ((err as { code?: string }).code === '23P01') {
        throw new AppError('CLIENT_MERGE_CONFLICT', 409, 'У обеих карточек есть записи на одно и то же время – сначала отмените одну из них', {
          module: 'booking', constraint: 'client_time_no_overlap',
        });
      }
      throw err;
    }
    const visits = (await tx.query('UPDATE app.visits SET client_id = $2 WHERE client_id = $1', [from, to])).rowCount ?? 0;
    const noShows = (await tx.query('UPDATE app.no_shows SET client_id = $2 WHERE client_id = $1', [from, to])).rowCount ?? 0;
    return { bookings, holds, clientTime, visits, noShows };
  },
};

// S1-02. K6 occupy: занятие единиц строками occupancy – ядро защиты от двойной брони (01 §8, 17 §10, ADR 0004 §3).
// Гарантию даёт EXCLUDE occupancy_no_overlap, не код: предварительных SELECT «а не занято ли» нет (K6 правило 1).
// Порядок внутри команды: строки единиц FOR NO KEY UPDATE по id (S1-04: против FOR UPDATE блокировки) → один INSERT
// всех строк команды в порядке unit_id.
// Отклонение от K6 («FOR SHARE»), проверено тестом: при FOR SHARE две команды на одну единицу вставляют конфликтующие
// строки параллельно, и проверка EXCLUDE у каждой ждёт незавершённую строку другой – взаимная блокировка 40P01
// (в 2 из 3 прогонов «комната против мест»). Захват строки единицы ставит такие команды в очередь по id – дедлока нет,
// второй получает чистый 23P01. Цена – команды одной единицы идут по очереди (миллисекунды). Видимость против блокировок
// сохраняется: FOR UPDATE в createBlock конфликтует с FOR NO KEY UPDATE так же, как с FOR SHARE.
// 40P01/40001 – повтор всей команды один раз (runOccupancyCommand), вторая неудача → SLOT_HELD.
// client_time (запрет пересечений клиента по сети, 0108): одна строка на позицию, одним INSERT после occupancy;
// перед ним – строка клиента FOR NO KEY UPDATE (clients.lockClients): команды одного клиента идут по очереди, взаимного
// ожидания на EXCLUDE client_time нет. Команды клиента берут этот замок раньше ресурсов (hold.ts lockOwner) – здесь повтор.
import type pg from 'pg';
import type { Tx } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { toPgRange, type Interval } from '../../core/time.ts';
import { lockClients } from '../clients/index.ts';
import { lockCompositions, type UnitSet } from '../resources/index.ts';
import { assertNotBlocked } from './blocks.ts';

export type OccupySource =
  | { type: 'hold_item'; id: string; holdExpiresAt: Date }
  | { type: 'booking'; id: string; version: number }
  | { type: 'event'; id: string };

export interface OccupyItem {
  units: UnitSet;
  period: Interval;
  source: OccupySource;
  clientId: string | null; // null → client_time не пишется (посетитель без входа, мероприятие без клиента)
}

const unitOrder = (ids: Iterable<string>): string[] => [...new Set([...ids].map((s) => s.toLowerCase()))].sort();

/** Строки, которые не дали вставить: бронь/мероприятие → SLOT_TAKEN, только удержания → SLOT_HELD (владелец не раскрывается). */
async function conflictError(tx: Tx, items: OccupyItem[]): Promise<AppError> {
  const r = await tx.query<{ source_type: string }>(
    `SELECT DISTINCT o.source_type FROM app.occupancy o
     JOIN unnest($1::uuid[], $2::tstzrange[]) AS x(unit_id, period) ON o.unit_id = x.unit_id AND o.period && x.period
     WHERE o.active`,
    [items.flatMap((i) => i.units.unitIds), items.flatMap((i) => i.units.unitIds.map(() => toPgRange(i.period)))],
  );
  const types = new Set(r.rows.map((x) => x.source_type));
  if (types.size > 0 && [...types].every((t) => t === 'hold_item')) {
    return new AppError('SLOT_HELD', 409, 'Это время сейчас оформляет другой гость');
  }
  return new AppError('SLOT_TAKEN', 409, 'Это время уже занято');
}

/** K6: занять единицы всех позиций команды одним INSERT. Ошибка любой позиции – ничего не вставлено. */
export async function occupyMany(tx: Tx, branchId: string, items: OccupyItem[]): Promise<void> {
  if (items.length === 0) return;
  if (items.some((i) => i.clientId !== null && i.source.type === 'event')) throw new Error('booking.occupy: у мероприятия нет client_time');
  // 0) строки ресурсов FOR SHARE и сверка состава (против changeComposition) – до единиц: порядок «ресурсы → единицы».
  await lockCompositions(tx, items.map((i) => ({ resourceId: i.units.resourceId, unitIds: i.units.unitIds, at: i.period.start })));
  // 1) строки единиц в порядке id: очередь команд одной единицы и видимость против блокировок (createBlock – FOR UPDATE).
  await lockUnitsForWrite(tx, branchId, items.flatMap((i) => i.units.unitIds));
  // 2) блокировки (K6 правило 2: в той же транзакции, после захвата строк единиц).
  for (const i of items) await assertNotBlocked(tx, i.units.unitIds, i.period);
  // 3) все строки – одним INSERT в порядке unit_id.
  const rows = items
    .flatMap((i) => i.units.unitIds.map((u) => ({ u: u.toLowerCase(), i })))
    .sort((a, b) => (a.u < b.u ? -1 : a.u > b.u ? 1 : 0));
  await tx.query('SAVEPOINT occupy');
  try {
    await tx.query(
      `INSERT INTO app.occupancy (unit_id, branch_id, period, source_type, source_id, booking_version, hold_expires_at)
       SELECT x.unit_id, $1, x.period, x.source_type, x.source_id, x.booking_version, x.hold_expires_at
       FROM unnest($2::uuid[], $3::tstzrange[], $4::text[], $5::uuid[], $6::int[], $7::timestamptz[])
         AS x(unit_id, period, source_type, source_id, booking_version, hold_expires_at)
       ORDER BY x.unit_id`,
      [
        branchId,
        rows.map((r) => r.u),
        rows.map((r) => toPgRange(r.i.period)),
        rows.map((r) => r.i.source.type),
        rows.map((r) => r.i.source.id),
        rows.map((r) => (r.i.source.type === 'booking' ? r.i.source.version : null)),
        rows.map((r) => (r.i.source.type === 'hold_item' ? r.i.source.holdExpiresAt : null)),
      ],
    );
    await insertClientTime(
      tx,
      items.flatMap((i) => (i.clientId === null ? [] : [{ clientId: i.clientId, period: i.period, source: i.source as ClientTimeSource }])),
    );
    await tx.query('RELEASE SAVEPOINT occupy');
  } catch (err) {
    const e = err as { code?: string; constraint?: string };
    if (e.code === '23P01' && e.constraint === 'occupancy_no_overlap') {
      await tx.query('ROLLBACK TO SAVEPOINT occupy');
      throw await conflictError(tx, items);
    }
    if (err instanceof AppError && err.code === 'CLIENT_OVERLAP') {
      await tx.query('ROLLBACK TO SAVEPOINT occupy');
    }
    throw err;
  }
}

export type ClientTimeSource = { type: 'hold_item'; id: string; holdExpiresAt: Date } | { type: 'booking'; id: string };

/** client_time одним INSERT (K6 шаг 3). Пересечение у клиента по сети → CLIENT_OVERLAP. Своего SAVEPOINT нет:
 *  вызывающий (occupyMany, attach) откатывает до своей точки. */
export async function insertClientTime(tx: Tx, rows: Array<{ clientId: string; period: Interval; source: ClientTimeSource }>): Promise<void> {
  if (rows.length === 0) return;
  await lockClients(tx, rows.map((r) => r.clientId));
  try {
    await tx.query(
      `INSERT INTO app.client_time (client_id, period, source_type, source_id, hold_expires_at)
       SELECT * FROM unnest($1::uuid[], $2::tstzrange[], $3::text[], $4::uuid[], $5::timestamptz[])`,
      [
        rows.map((r) => r.clientId),
        rows.map((r) => toPgRange(r.period)),
        rows.map((r) => r.source.type),
        rows.map((r) => r.source.id),
        rows.map((r) => (r.source.type === 'hold_item' ? r.source.holdExpiresAt : null)),
      ],
    );
  } catch (err) {
    const e = err as { code?: string; constraint?: string };
    if (e.code === '23P01' && e.constraint === 'client_time_no_overlap') {
      throw new AppError('CLIENT_OVERLAP', 409, 'У вас уже есть запись на это время');
    }
    throw err;
  }
}

/** K6 release: погасить строки источников (отмена, перенос, удаление позиции, истечение). $now – из Clock команды. */
export async function releaseSources(
  tx: Tx,
  source: { type: 'hold_item' | 'booking' | 'event'; ids: string[] },
  reason: 'released' | 'cancelled' | 'rescheduled' | 'converted' | 'expired',
  now: Date,
): Promise<void> {
  if (source.ids.length === 0) return;
  const params = [source.type, source.ids, now, reason];
  await tx.query(
    `UPDATE app.occupancy SET active = false, released_at = $3, release_reason = $4 WHERE active AND source_type = $1 AND source_id = ANY($2::uuid[])`,
    params,
  );
  if (source.type !== 'event') {
    await tx.query(
      `UPDATE app.client_time SET active = false, released_at = $3, release_reason = $4 WHERE active AND source_type = $1 AND source_id = ANY($2::uuid[])`,
      params,
    );
  }
}

/** Строки единиц FOR NO KEY UPDATE по id – перед ЛЮБОЙ записью в occupancy (occupy, convertHoldItem, перенос, отмена;
 *  ревизия S1-02 п.2). Нет единицы в филиале / архив → RESOURCE_UNAVAILABLE. forRelease – для гашения строк (отмена,
 *  старая версия при переносе): единица в архиве не мешает освободить её строки. */
export async function lockUnitsForWrite(tx: Tx, branchId: string, unitIds: string[], opts: { forRelease?: boolean } = {}): Promise<void> {
  const all = unitOrder(unitIds);
  const locked = await tx.query(
    `SELECT id FROM app.occupancy_units WHERE id = ANY($1::uuid[]) AND branch_id = $2 AND ($3 OR status = 'active') ORDER BY id FOR NO KEY UPDATE`,
    [all, branchId, opts.forRelease === true],
  );
  if (locked.rowCount !== all.length) throw new AppError('RESOURCE_UNAVAILABLE', 409, 'Это место недоступно для записи');
}

/** K6 convertHoldItem: строки позиции удержания → бронь без окна свободного слота (K5 confirm шаг 5).
 *  Единицы уже захвачены вызывающим (lockUnitsForWrite). Строк меньше, чем единиц позиции (часть погашена
 *  истечением), → HOLD_EXPIRED: вся транзакция откатывается. Так же client_time (ровно 1 строка, если есть клиент). */
export async function convertHoldItem(tx: Tx, now: Date, item: { id: string; unitIds: string[]; clientId: string | null }, booking: { id: string; version: 1 }): Promise<void> {
  const o = await tx.query(
    `UPDATE app.occupancy SET source_type = 'booking', source_id = $2, booking_version = $3, hold_expires_at = NULL
     WHERE active AND source_type = 'hold_item' AND source_id = $1 AND hold_expires_at > $4 RETURNING unit_id`,
    [item.id, booking.id, booking.version, now],
  );
  if ((o.rowCount ?? 0) < item.unitIds.length) throw new AppError('HOLD_EXPIRED', 410, 'Время на оформление истекло, слоты освобождены');
  if (item.clientId === null) return;
  const c = await tx.query(
    `UPDATE app.client_time SET source_type = 'booking', source_id = $2, hold_expires_at = NULL
     WHERE active AND source_type = 'hold_item' AND source_id = $1 AND hold_expires_at > $3 RETURNING id`,
    [item.id, booking.id, now],
  );
  if (c.rowCount !== 1) throw new AppError('HOLD_EXPIRED', 410, 'Время на оформление истекло, слоты освобождены');
}

/** K6 occupy – одна позиция. */
export function occupy(tx: Tx, input: { branchId: string } & OccupyItem): Promise<void> {
  return occupyMany(tx, input.branchId, [input]);
}

const RETRYABLE = new Set(['40P01', '40001']);
export const isRetryable = (err: unknown): boolean => RETRYABLE.has((err as { code?: string }).code ?? '');

/** Транзакция команды занятия с повтором ADR 0004 §3: 40P01/40001 → повтор один раз целиком, вторая → SLOT_HELD.
 *  Ключ идемпотентности и $now повтора – те же: их держит вызывающий в замыкании `run`. */
export async function runOccupancyCommand<T>(pool: { connect(): Promise<pg.PoolClient> }, run: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await run(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (!isRetryable(err)) throw err;
      if (attempt >= 1) throw new AppError('SLOT_HELD', 409, 'Это время сейчас оформляет другой гость', { retried: true });
    } finally {
      client.release();
    }
  }
}

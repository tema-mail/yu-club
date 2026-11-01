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
// client_time (запрет пересечений клиента, 0108) появится в S1-06: до неё clientId должен быть null.
import type pg from 'pg';
import type { Tx } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { toPgRange, type Interval } from '../../core/time.ts';
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
  if (items.some((i) => i.clientId !== null)) throw new Error('booking.occupy: client_time появится с 0108 (S1-06) – clientId пока null');
  // 0) строки ресурсов FOR SHARE и сверка состава (против changeComposition) – до единиц: порядок «ресурсы → единицы».
  await lockCompositions(tx, items.map((i) => ({ resourceId: i.units.resourceId, unitIds: i.units.unitIds, at: i.period.start })));
  const all = unitOrder(items.flatMap((i) => i.units.unitIds));
  // 1) строки единиц в порядке id: очередь команд одной единицы и видимость против блокировок (createBlock – FOR UPDATE).
  const locked = await tx.query(
    `SELECT id FROM app.occupancy_units WHERE id = ANY($1::uuid[]) AND branch_id = $2 AND status = 'active' ORDER BY id FOR NO KEY UPDATE`,
    [all, branchId],
  );
  if (locked.rowCount !== all.length) throw new AppError('RESOURCE_UNAVAILABLE', 409, 'Это место недоступно для записи');
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
    await tx.query('RELEASE SAVEPOINT occupy');
  } catch (err) {
    const e = err as { code?: string; constraint?: string };
    if (e.code === '23P01' && e.constraint === 'occupancy_no_overlap') {
      await tx.query('ROLLBACK TO SAVEPOINT occupy');
      throw await conflictError(tx, items);
    }
    throw err;
  }
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

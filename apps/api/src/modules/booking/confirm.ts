// S1-07. K5 №12: подтверждение удержания в брони – одна транзакция, без окна свободного слота.
// Порядок замков у всех команд один: удержание FOR UPDATE → ресурсы FOR SHARE → единицы FOR NO KEY UPDATE → клиент.
// 8 повторных проверок 01 §8.2: филиал, график, ресурс, пересечения (строки удержания живы – convertHoldItem),
// активность удержания, блокировки, ограничения клиента (clients.assertCanBook), совместимость состава.
// Цена – pricing.quote на каждую бронь (нет тарифа → TARIFF_NOT_CONFIGURED, не 0 ₽). Позиции одного ресурса встык –
// одна бронь; остальные – отдельные брони с общим checkoutId. Снимок зоны, состава, ресурса и цены – booking_versions v1.
// Повтор подтверждения уже переведённого удержания тем же клиентом – прежний результат (повтор без ключа, K5).
// В транзакции – только запись, аудит и outbox (K4): внешних вызовов нет.
import { randomUUID } from 'node:crypto';
import { writeAudit, type AuditRequestMeta, type Db, type Tx } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { publish, type Tx as OutboxTx } from '../../core/outbox.ts';
import { resolveSetting } from '../../core/settings.ts';
import { contains, durationMinutes, instantToLocal, systemClock, toPgRange, type Clock, type Interval } from '../../core/time.ts';
import { assertCanBook } from '../clients/index.ts';
import { getBranch, isAcceptingBookings, openIntervals, type BranchInfo } from '../network/index.ts';
import { quote } from '../pricing/tariff.ts';
import { assertBookable, getResource, lockCompositions } from '../resources/index.ts';
import { assertNotBlocked } from './blocks.ts';
import { convertHoldItem, lockUnitsForWrite } from './occupancy.ts';

export type BookingStatus = 'confirmed' | 'arrived' | 'completed' | 'no_show' | 'cancelled_by_client' | 'cancelled_by_club';
export interface BookingDto {
  id: string;
  number: number;
  branchId: string;
  branchName: string;
  branchAddress: string;
  timezone: string;
  resourceId: string;
  resourceName: string;
  start: string;
  end: string;
  durationMinutes: number;
  priceKop: number;
  paymentNote: 'pay_at_club';
  status: BookingStatus;
  canCancel: boolean;
}
export interface ConfirmResultDto {
  checkoutId: string;
  bookings: BookingDto[];
}

declare module '../../core/outbox.ts' {
  interface EventRegistry {
    'booking.confirmed': {
      bookingId: string;
      number: number;
      checkoutId: string;
      branchId: string;
      branchTimezone: string;
      clientId: string;
      resourceId: string;
      resourceName: string;
      start: string;
      end: string;
      priceKop: number;
      source: 'site' | 'crm';
      bookingVersion: 1;
    };
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => new AppError('NOT_FOUND', 404, 'Не найдено');
const holdExpired = () => new AppError('HOLD_EXPIRED', 410, 'Время на оформление истекло, слоты освобождены');

interface ItemRow {
  id: string;
  resource_id: string;
  unit_ids: string[];
  s: Date;
  e: Date;
}

/** Позиции одного ресурса встык и с одним составом – одна бронь (K5 шаг 4). */
function mergeItems(items: ItemRow[]): ItemRow[][] {
  const sorted = [...items].sort((a, b) => (a.resource_id === b.resource_id ? a.s.getTime() - b.s.getTime() : a.resource_id < b.resource_id ? -1 : 1));
  const groups: ItemRow[][] = [];
  for (const i of sorted) {
    const g = groups.at(-1);
    const last = g?.at(-1);
    if (g && last && last.resource_id === i.resource_id && last.e.getTime() === i.s.getTime() && last.unit_ids.join() === i.unit_ids.join()) g.push(i);
    else groups.push([i]);
  }
  return groups;
}

/** Повторная проверка позиции на момент подтверждения (01 §8.2): ресурс, начало в будущем, филиал, график. */
async function recheck(tx: Tx, branch: BranchInfo, now: Date, i: ItemRow): Promise<void> {
  const r = await getResource(tx, i.resource_id);
  if (!r) throw new AppError('RESOURCE_UNAVAILABLE', 409, 'Это место недоступно для записи');
  assertBookable(r);
  if (i.s.getTime() <= now.getTime()) throw new AppError('OUTSIDE_BOOKING_WINDOW', 422, 'Это время уже прошло');
  if (!isAcceptingBookings(branch, i.s)) throw new AppError('BRANCH_NOT_ACTIVE', 409, 'Филиал сейчас не принимает записи');
  const period: Interval = { start: i.s, end: i.e };
  const open = await openIntervals(tx, { branchId: branch.id, date: instantToLocal(i.s, branch.timezone).date, roomId: r.roomId, resourceId: r.id });
  if (!open.some((o) => contains(o, period))) throw new AppError('OUTSIDE_SCHEDULE', 409, 'В это время филиал не работает');
  await assertNotBlocked(tx, i.unit_ids, period);
}

function itemError(err: unknown, index: number, i: ItemRow): never {
  if (err instanceof AppError) {
    throw new AppError(err.code, err.httpStatus, err.message, {
      ...err.details,
      items: [{ index, resourceId: i.resource_id, start: i.s.toISOString(), end: i.e.toISOString(), code: err.code }],
    });
  }
  throw err;
}

/** K5 №12. clientId – вошедший клиент; удержание должно принадлежать ему (attach выполнен). */
export async function confirmHold(tx: Tx, clientId: string, holdId: string, clock: Clock = systemClock): Promise<ConfirmResultDto> {
  const now = clock.now();
  if (!UUID_RE.test(holdId)) throw notFound();
  const hr = await tx.query<{ id: string; branch_id: string; client_id: string | null; status: string; expires_at: Date }>(
    'SELECT id, branch_id, client_id, status, expires_at FROM app.holds WHERE id = $1 FOR UPDATE',
    [holdId],
  );
  const h = hr.rows[0];
  if (!h || h.client_id !== clientId) throw notFound();
  if (h.status === 'converted') return checkoutOfHold(tx, h.id, now);
  if (h.status !== 'active' || h.expires_at.getTime() <= now.getTime()) throw holdExpired();
  const branch = await getBranch(tx, h.branch_id);
  if (!branch || !isAcceptingBookings(branch, now)) throw new AppError('BRANCH_NOT_ACTIVE', 409, 'Филиал сейчас не принимает записи');
  const items = (
    await tx.query<ItemRow>(
      `SELECT id, resource_id, unit_ids, lower(period) AS s, upper(period) AS e FROM app.hold_items WHERE hold_id = $1 AND status = 'active' ORDER BY lower(period), id`,
      [h.id],
    )
  ).rows;
  if (items.length === 0) throw holdExpired();
  // замки «ресурсы → единицы» и совместимость состава (COMPOSITE_CHANGED)
  await lockCompositions(tx, items.map((i) => ({ resourceId: i.resource_id, unitIds: i.unit_ids, at: i.s })));
  await lockUnitsForWrite(tx, branch.id, items.flatMap((i) => i.unit_ids));
  for (const [k, i] of items.entries()) await recheck(tx, branch, now, i).catch((e) => itemError(e, k, i));
  await assertCanBook(tx, clientId, now);

  const checkoutId = randomUUID();
  const bookingIds: string[] = [];
  for (const group of mergeItems(items)) {
    const first = group[0]!;
    const period: Interval = { start: first.s, end: group.at(-1)!.e };
    const r = (await getResource(tx, first.resource_id))!;
    const q = await quote(tx, { branchId: branch.id, resourceType: r.type, start: period.start, durationMinutes: durationMinutes(period) }).catch((e) =>
      itemError(e, items.indexOf(first), first),
    );
    const bookingId = randomUUID();
    for (const i of group) await convertHoldItem(tx, now, { id: i.id, unitIds: i.unit_ids, clientId }, { id: bookingId, version: 1 });
    const b = await tx.query<{ number: string }>(
      `INSERT INTO app.bookings (id, checkout_id, branch_id, client_id, hold_id, resource_id, period, price_kop, source, created_by_type, created_by_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'site', 'client', $4, $9) RETURNING number`,
      [bookingId, checkoutId, branch.id, clientId, h.id, r.id, toPgRange(period), q.priceKop, now],
    );
    const snapshot = { name: r.name, type: r.type, roomName: r.roomName, branchName: branch.name, branchAddress: branch.address };
    await tx.query(
      `INSERT INTO journal.booking_versions (booking_id, version, resource_id, period, branch_timezone, unit_ids, resource_snapshot, tariff_id, price_kop, price_snapshot, created_by_type, created_by_id, created_at)
       VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, 'client', $10, $11)`,
      [bookingId, r.id, toPgRange(period), branch.timezone, first.unit_ids, JSON.stringify(snapshot), q.tariffId, q.priceKop, JSON.stringify(q.snapshot), clientId, now],
    );
    const meta: AuditRequestMeta = { actor: { kind: 'client', clientId, sessionId: '' }, source: 'site', requestId: `confirm:${h.id}` };
    await writeAudit(
      tx,
      meta,
      { action: 'booking.created', object: { type: 'booking', id: bookingId }, branchId: branch.id, after: { holdId: h.id, resourceId: r.id, start: period.start, end: period.end, priceKop: q.priceKop } },
      clock,
    );
    await publish(tx as OutboxTx, {
      type: 'booking.confirmed',
      aggregateType: 'booking',
      aggregateId: bookingId,
      aggregateVersion: 1,
      branchId: branch.id,
      occurredAt: now,
      payload: {
        bookingId,
        number: Number(b.rows[0]!.number),
        checkoutId,
        branchId: branch.id,
        branchTimezone: branch.timezone,
        clientId,
        resourceId: r.id,
        resourceName: r.name,
        start: period.start.toISOString(),
        end: period.end.toISOString(),
        priceKop: q.priceKop,
        source: 'site',
        bookingVersion: 1,
      },
    });
    bookingIds.push(bookingId);
  }
  await tx.query(`UPDATE app.hold_items SET status = 'converted' WHERE hold_id = $1 AND status = 'active'`, [h.id]);
  await tx.query(`UPDATE app.holds SET status = 'converted', closed_at = $2 WHERE id = $1`, [h.id, now]);
  return { checkoutId, bookings: await bookingDtos(tx, bookingIds, now) };
}

/** Прежний результат подтверждения удержания (повтор нажатия). */
async function checkoutOfHold(db: Db | Tx, holdId: string, now: Date): Promise<ConfirmResultDto> {
  const r = await db.query<{ id: string; checkout_id: string }>('SELECT id, checkout_id FROM app.bookings WHERE hold_id = $1 ORDER BY number', [holdId]);
  if (r.rows.length === 0) throw holdExpired();
  return { checkoutId: r.rows[0]!.checkout_id, bookings: await bookingDtos(db, r.rows.map((x) => x.id), now) };
}

/** BookingDto (K5); canCancel – confirmed, начало в будущем и отмена клиентом включена (R-12, K7). */
export async function bookingDtos(db: Db | Tx, ids: string[], now: Date): Promise<BookingDto[]> {
  if (ids.length === 0) return [];
  const r = await db.query<{
    id: string; number: string; branch_id: string; branch_name: string; branch_address: string; timezone: string;
    resource_id: string; resource_name: string; s: Date; e: Date; price_kop: string; status: BookingStatus;
  }>(
    `SELECT b.id, b.number, b.branch_id, br.name AS branch_name, br.address AS branch_address, v.branch_timezone AS timezone,
            b.resource_id, v.resource_snapshot ->> 'name' AS resource_name, lower(b.period) AS s, upper(b.period) AS e, b.price_kop, b.status
     FROM app.bookings b JOIN app.branches br ON br.id = b.branch_id
     JOIN journal.booking_versions v ON v.booking_id = b.id AND v.version = b.current_version
     WHERE b.id = ANY($1::uuid[]) ORDER BY lower(b.period), b.number`,
    [ids],
  );
  const out: BookingDto[] = [];
  const cancelEnabled = new Map<string, boolean>();
  for (const x of r.rows) {
    if (!cancelEnabled.has(x.branch_id)) cancelEnabled.set(x.branch_id, (await resolveSetting(db, 'booking.client_cancel_enabled', { branchId: x.branch_id }, now)).value);
    out.push({
      id: x.id,
      number: Number(x.number),
      branchId: x.branch_id,
      branchName: x.branch_name,
      branchAddress: x.branch_address,
      timezone: x.timezone,
      resourceId: x.resource_id,
      resourceName: x.resource_name,
      start: x.s.toISOString(),
      end: x.e.toISOString(),
      durationMinutes: durationMinutes({ start: x.s, end: x.e }),
      priceKop: Number(x.price_kop),
      paymentNote: 'pay_at_club',
      status: x.status,
      canCancel: x.status === 'confirmed' && x.s.getTime() > now.getTime() && cancelEnabled.get(x.branch_id) === true,
    });
  }
  return out;
}

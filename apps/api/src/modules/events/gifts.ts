// S3-57. Подарок имениннику – сущность-право (K20 §8.1, 11 §9): фиксированный состав снимком на выдаче, 60 дней от выдачи,
// один на именинника в 365 дней – EXCLUDE базы (20 параллельных выдач → одна). Основание – день рождения этого клиента в
// статусе «идёт» или «завершён» (Q-115); без мероприятия выдаёт только Владелец с причиной. На передачу не рассчитан: clientId
// не меняется. Запись по подарку – gift-booking.ts; среди сертификатов подарок не показывается (приёмка 19). Истечение –
// задача worker раз в 10 минут: issued с прошедшим сроком → expired один раз (подписка – S3-59).
import type pg from 'pg';
import { z } from 'zod';
import { writeAudit, type AuditRequestMeta, type Db, type Tx } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { publish, type Tx as OutboxTx } from '../../core/outbox.ts';
import { assertCan, can, type AccessContext } from '../../core/permissions.ts';
import { resolveSettings } from '../../core/settings.ts';
import { addDays, instantToLocal, systemClock, type Clock, type LocalDate, type TimeZone } from '../../core/time.ts';
import { getBranch } from '../network/index.ts';
import { getEventRow, notFound, parseBody, registerEventGiftsProvider, requireReason, UUID_RE } from './events.ts';

export type GiftStatus = 'issued' | 'reserved' | 'used' | 'expired' | 'cancelled';

/** Снимок условий на выдаче (15 §3.4): состав – константа, меняются только gift.valid_days и gift.room_minutes для новых. */
export interface GiftTerms {
  devices: 2;
  device: 'Meta Quest 3S';
  minutesEach: 30;
  roomMinutes: number;
  weekdays: [1, 2, 3, 4, 5];
  excludesHolidays: true;
  notIncluded: ['PS4', 'PS VR', 'food'];
}

export interface BirthdayGiftDto {
  id: string;
  number: string;
  clientId: string;
  basisEventId: string | null;
  issuedOn: string;
  validUntil: string;
  issueBranchId: string;
  timezone: string;
  terms: GiftTerms;
  status: GiftStatus;
  bookingId: string | null;
  cancelReason: string | null;
  rowVersion: number;
}

export interface GiftRow {
  id: string;
  number: string;
  client_id: string;
  basis_event_id: string | null;
  issue_branch_id: string;
  timezone: string;
  issued_on: string;
  valid_until: string;
  terms: GiftTerms;
  status: GiftStatus;
  cancel_reason: string | null;
  row_version: number;
  booking_id: string | null;
}

/** Строка подарка с бронью живой записи. Даты – текстом: date без сдвига зоны машины. */
export const GIFT_SELECT = `SELECT g.id, g.number, g.client_id, g.basis_event_id, g.issue_branch_id, b.timezone, g.issued_on::text AS issued_on, g.valid_until::text AS valid_until,
    g.terms, g.status, g.cancel_reason, g.row_version,
    (SELECT u.booking_id FROM app.gift_uses u WHERE u.gift_id = g.id AND u.status IN ('held','booked','used')) AS booking_id
  FROM app.birthday_gifts g JOIN app.branches b ON b.id = g.issue_branch_id`;

export const toGiftDto = (r: GiftRow): BirthdayGiftDto => ({
  id: r.id, number: r.number, clientId: r.client_id, basisEventId: r.basis_event_id, issuedOn: r.issued_on, validUntil: r.valid_until, issueBranchId: r.issue_branch_id,
  timezone: r.timezone, terms: r.terms, status: r.status, bookingId: r.booking_id, cancelReason: r.cancel_reason, rowVersion: r.row_version,
});

export async function getGiftRow(db: Db, id: string, opts: { forUpdate?: boolean } = {}): Promise<GiftRow | null> {
  if (!UUID_RE.test(id)) return null;
  const r = await db.query<GiftRow>(`${GIFT_SELECT} WHERE g.id = $1${opts.forUpdate ? ' FOR UPDATE OF g' : ''}`, [id]);
  return r.rows[0] ?? null;
}

const Uuid = z.string().regex(UUID_RE);
const issueSchema = z.object({ clientId: Uuid, basisEventId: Uuid.nullish(), branchId: Uuid.nullish(), reason: z.string().max(2000).optional() });
const cancelSchema = z.object({ reason: z.string().max(2000).optional() });

const BASIS_TYPES = new Set(['birthday_party', 'birthday']);
const BASIS_STATUSES = new Set(['in_progress', 'completed']);
const basisInvalid = (reason: string) => new AppError('GIFT_BASIS_INVALID', 422, 'Основание – день рождения этого клиента в клубе', { reason });

/** Выдача: основание (Q-115) или ручная выдача Владельцем. 23P01 birthday_gifts_one_per_year → GIFT_ALREADY_ISSUED. */
export async function issueGift(tx: Tx, ctx: AccessContext, raw: unknown, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<BirthdayGiftDto> {
  const input = parseBody(issueSchema, raw);
  const now = clock.now();
  let branchId: string;
  let reason: string | null = null;
  if (input.basisEventId) {
    const e = await getEventRow(tx, input.basisEventId);
    if (!e) throw notFound();
    if (!can(ctx, 'event.view', { branchId: e.branch_id })) throw notFound();
    assertCan(ctx, 'gift.issue', { branchId: e.branch_id });
    if (!BASIS_TYPES.has(e.type_code)) throw basisInvalid('type');
    if (e.birthday_client_id !== input.clientId) throw basisInvalid('client');
    if (!BASIS_STATUSES.has(e.status)) throw basisInvalid('status');
    branchId = e.branch_id;
  } else {
    assertCan(ctx, 'gift.issue.manual', { network: true });
    reason = requireReason(input.reason);
    if (!input.branchId) throw new AppError('VALIDATION_FAILED', 400, 'Укажите филиал выдачи', { field: 'branchId' });
    branchId = input.branchId;
  }
  const branch = await getBranch(tx, branchId);
  if (!branch) throw notFound();
  const client = await tx.query<{ status: string }>('SELECT status FROM app.clients WHERE id = $1', [input.clientId]);
  if (!client.rows[0] || client.rows[0].status === 'anonymized') throw notFound();
  const s = await resolveSettings(tx, ['gift.valid_days', 'gift.room_minutes'], { branchId: branch.id }, now);
  const issuedOn = instantToLocal(now, branch.timezone).date;
  const validUntil = addDays(issuedOn, s['gift.valid_days'].value);
  const terms: GiftTerms = { devices: 2, device: 'Meta Quest 3S', minutesEach: 30, roomMinutes: s['gift.room_minutes'].value, weekdays: [1, 2, 3, 4, 5], excludesHolidays: true, notIncluded: ['PS4', 'PS VR', 'food'] };
  let id: string;
  await tx.query('SAVEPOINT gift_issue');
  try {
    const r = await tx.query<{ id: string }>(
      `INSERT INTO app.birthday_gifts (number, client_id, basis_event_id, issue_branch_id, issued_on, valid_until, terms, manual_reason, issued_by, issued_at)
       VALUES ('GF-' || lpad(nextval('app.gift_number_seq')::text, 6, '0'), $1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [input.clientId, input.basisEventId ?? null, branch.id, issuedOn, validUntil, JSON.stringify(terms), reason, ctx.actor.staffId, now],
    );
    id = r.rows[0]!.id;
    await tx.query('RELEASE SAVEPOINT gift_issue');
  } catch (err) {
    await tx.query('ROLLBACK TO SAVEPOINT gift_issue');
    if ((err as { code?: string; constraint?: string }).constraint === 'birthday_gifts_one_per_year') throw new AppError('GIFT_ALREADY_ISSUED', 409, 'Подарок этому клиенту уже выдан в этом году');
    throw err;
  }
  await writeAudit(tx, meta, { action: 'gift.issued', object: { type: 'gift', id }, branchId: branch.id, cityId: branch.cityId, after: { clientId: input.clientId, basisEventId: input.basisEventId ?? null, validUntil }, reason }, clock);
  await publish(tx as OutboxTx, {
    type: 'gift.issued',
    aggregateType: 'gift',
    aggregateId: id,
    aggregateVersion: 1,
    branchId: branch.id,
    occurredAt: now,
    payload: { giftId: id, clientId: input.clientId, validUntil, issueBranchId: branch.id },
  });
  return toGiftDto((await getGiftRow(tx, id))!);
}

/** Отмена Владельцем только невостребованного подарка: при живой записи сначала решается бронь (K20 §7 не трогает её молча). */
export async function cancelGift(tx: Tx, ctx: AccessContext, giftId: string, raw: unknown, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<BirthdayGiftDto> {
  const input = parseBody(cancelSchema, raw);
  assertCan(ctx, 'gift.cancel', { network: true });
  const g = await getGiftRow(tx, giftId, { forUpdate: true });
  if (!g) throw notFound();
  const reason = requireReason(input.reason);
  if (g.status !== 'issued') throw new AppError('GIFT_NOT_ACTIVE', 409, 'Отменить можно только подарок без записи', { status: g.status });
  await tx.query(`UPDATE app.birthday_gifts SET status = 'cancelled', cancel_reason = $2, row_version = row_version + 1 WHERE id = $1`, [g.id, reason]);
  await writeAudit(tx, meta, { action: 'gift.cancelled', object: { type: 'gift', id: g.id }, branchId: g.issue_branch_id, before: { status: g.status }, after: { status: 'cancelled' }, reason }, clock);
  return toGiftDto((await getGiftRow(tx, g.id))!);
}

/** Сегодня по зоне филиала выдачи: срок считается по ней же (K20 §8.1). */
export const giftToday = (r: Pick<GiftRow, 'timezone'>, now: Date): LocalDate => instantToLocal(now, r.timezone as TimeZone).date;

// ---- задача events.gift_expire: раз в 10 минут (K20 §8.1)

const EXPIRE_META: AuditRequestMeta = { actor: { kind: 'system', process: 'events.gift_expire' }, source: 'system', requestId: 'events.gift_expire' };

/** Один проход: issued с прошедшим сроком → expired. Занятые другой командой пропускаются (SKIP LOCKED); повторно – нечего. */
export async function expireDueGifts(pool: { connect(): Promise<pg.PoolClient> }, clock: Clock = systemClock, limit = 200): Promise<number> {
  const now = clock.now();
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await c.query<{ id: string; branch_id: string }>(
      `SELECT g.id, g.issue_branch_id AS branch_id FROM app.birthday_gifts g JOIN app.branches b ON b.id = g.issue_branch_id
        WHERE g.status = 'issued' AND g.valid_until < ($1::timestamptz AT TIME ZONE b.timezone)::date
        ORDER BY g.valid_until, g.id LIMIT $2 FOR UPDATE OF g SKIP LOCKED`,
      [now, limit],
    );
    for (const g of r.rows) {
      await c.query(`UPDATE app.birthday_gifts SET status = 'expired', row_version = row_version + 1 WHERE id = $1`, [g.id]);
      await writeAudit(c, EXPIRE_META, { action: 'gift.expired', object: { type: 'gift', id: g.id }, branchId: g.branch_id, before: { status: 'issued' }, after: { status: 'expired' } }, clock);
    }
    await c.query('COMMIT');
    return r.rows.length;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

export function startGiftExpiry(opts: { pool: { connect(): Promise<pg.PoolClient> }; clock?: Clock; intervalMs?: number; onError?: (err: unknown) => void }): { stop(): void } {
  const timer = setInterval(() => {
    expireDueGifts(opts.pool, opts.clock).catch((err: unknown) => (opts.onError ?? ((e) => console.error('events.gift_expire', e)))(err));
  }, opts.intervalMs ?? 10 * 60_000);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}

// Отмена мероприятия и сводка денег видят подарки основания (K20 §6, §7): кроме отменённых.
registerEventGiftsProvider(async (db, eventId) => {
  const r = await db.query<{ id: string }>(`SELECT id FROM app.birthday_gifts WHERE basis_event_id = $1 AND status <> 'cancelled' ORDER BY id`, [eventId]);
  return r.rows.map((x) => x.id);
});

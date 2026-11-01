// S1-06. Удержание (K5 №6–11, K6, 01 §7): общий таймер на все позиции, добавление слота перезапускает таймер,
// неудачное добавление не трогает уже удержанные (откат транзакции), истёкшее удержание не держит слот:
// гасится в транзакции следующей команды на тех же единицах (releaseExpiredHolds) и задачей раз в 15 с.
// $now – один раз на команду из Clock (ADR 0003 п.10). Владелец: посетитель (кука yu_visitor) или клиент;
// при входе удержания посетителя переходят к клиенту (attach: пишется client_time, пересечения клиента по сети).
// В транзакциях – никаких внешних вызовов: только запись и outbox (K4).
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { writeAudit, type AuditRequestMeta, type Db, type Tx } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { publish, type Tx as OutboxTx } from '../../core/outbox.ts';
import { resolveSettings } from '../../core/settings.ts';
import { assertSlotAligned, contains, durationMinutes, fromPgRange, instantToLocal, isDateInWindow, systemClock, toPgRange, type Clock, type Interval } from '../../core/time.ts';
import { getBranch, isAcceptingBookings, openIntervals, type BranchInfo } from '../network/index.ts';
import { quote } from '../pricing/tariff.ts';
import { lockClients } from '../clients/index.ts';
import { assertBookable, expandToUnits, getResource } from '../resources/index.ts';
import { insertClientTime, occupyMany, releaseSources, type OccupyItem } from './occupancy.ts';

export interface HoldOwner {
  clientId: string | null;
  visitorId: string | null;
}
export interface HoldItemInput {
  resourceId: string;
  start: Date;
  end: Date;
}
export interface HoldItemDto {
  id: string;
  resourceId: string;
  resourceName: string;
  start: string;
  end: string;
  priceKop: number | null;
}
export interface HoldDto {
  id: string;
  branchId: string;
  status: 'active' | 'converted' | 'expired' | 'released';
  expiresAt: string;
  serverNow: string;
  items: HoldItemDto[];
  totalKop: number | null;
  owner: 'visitor' | 'client';
}

type HoldItemEvent = { itemId: string; resourceId: string; start: string; end: string };
declare module '../../core/outbox.ts' {
  interface EventRegistry {
    'hold.created': { holdId: string; branchId: string; clientId: string | null; expiresAt: string; items: HoldItemEvent[] };
    'hold.extended': { holdId: string; expiresAt: string; addedItem: HoldItemEvent };
    'hold.expired': { holdId: string; branchId: string; clientId: string | null; itemIds: string[] };
  }
}

const SYSTEM_META: AuditRequestMeta = { actor: { kind: 'system', process: 'hold-expiry' }, source: 'system', requestId: 'hold-expiry' };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => new AppError('NOT_FOUND', 404, 'Не найдено');
const holdExpired = () => new AppError('HOLD_EXPIRED', 410, 'Время на оформление истекло, слоты освобождены');

interface HoldRow {
  id: string;
  branch_id: string;
  client_id: string | null;
  visitor_id: string | null;
  status: HoldDto['status'];
  ttl_minutes: number;
  expires_at: Date;
}
const HOLD_COLS = 'id, branch_id, client_id, visitor_id, status, ttl_minutes, expires_at';

/** Видит ли владелец удержание: клиент – своё; посетитель – своё, пока оно не перешло к клиенту. */
const ownedBy = (h: HoldRow, o: HoldOwner): boolean =>
  (o.clientId !== null && h.client_id === o.clientId) || (o.visitorId !== null && h.client_id === null && h.visitor_id === o.visitorId);

async function holdSettings(tx: Db | Tx, branchId: string, now: Date) {
  const s = await resolveSettings(
    tx,
    ['booking.hold_minutes', 'booking.max_hold_items', 'booking.max_anonymous_holds_per_branch', 'booking.window_max_days'],
    { branchId },
    now,
  );
  return {
    ttl: s['booking.hold_minutes'].value,
    maxItems: s['booking.max_hold_items'].value,
    maxAnon: s['booking.max_anonymous_holds_per_branch'].value,
    maxDays: s['booking.window_max_days'].value,
  };
}

function itemError(err: unknown, index: number, item: HoldItemInput): never {
  if (err instanceof AppError) {
    throw new AppError(err.code, err.httpStatus, err.message, {
      ...err.details,
      items: [{ index, resourceId: item.resourceId, start: item.start.toISOString(), end: item.end.toISOString(), code: err.code }],
    });
  }
  throw err;
}

/** Проверки позиции 01 §8.2 (кроме пересечений – их даёт база): ресурс, окно, шаг, график → развёрнутые единицы. */
async function checkItem(tx: Tx, branch: BranchInfo, now: Date, maxDays: number, item: HoldItemInput) {
  const r = await getResource(tx, item.resourceId);
  if (!r || r.branchId !== branch.id) throw notFound();
  assertBookable(r);
  if (!(item.start.getTime() < item.end.getTime())) throw new AppError('INVALID_DURATION', 422, 'Конец раньше начала', { reason: 'empty' });
  const period: Interval = { start: item.start, end: item.end };
  const date = instantToLocal(item.start, branch.timezone).date;
  if (item.start.getTime() <= now.getTime() || !isDateInWindow(date, { now: () => now }, branch.timezone, maxDays)) {
    throw new AppError('OUTSIDE_BOOKING_WINDOW', 422, `Запись доступна на ${maxDays} дней вперёд`, { maxDays });
  }
  assertSlotAligned(period, r.stepMinutes, branch.timezone);
  if (!isAcceptingBookings(branch, item.start)) throw new AppError('BRANCH_NOT_ACTIVE', 409, 'Филиал сейчас не принимает записи');
  const open = await openIntervals(tx, { branchId: branch.id, date, roomId: r.roomId, resourceId: r.id });
  if (!open.some((i) => contains(i, period))) throw new AppError('OUTSIDE_SCHEDULE', 409, 'В это время филиал не работает');
  return { resource: r, period, units: await expandToUnits(tx, r.id, item.start) };
}

async function activeBranch(tx: Tx, branchId: string, now: Date): Promise<BranchInfo> {
  const b = UUID_RE.test(branchId) ? await getBranch(tx, branchId) : null;
  if (!b || b.status === 'preparing' || b.status === 'archived') throw notFound();
  if (!isAcceptingBookings(b, now)) throw new AppError('BRANCH_NOT_ACTIVE', 409, 'Филиал сейчас не принимает записи');
  return b;
}

async function lockHold(tx: Tx, holdId: string, owner: HoldOwner): Promise<HoldRow> {
  if (!UUID_RE.test(holdId)) throw notFound();
  const r = await tx.query<HoldRow>(`SELECT ${HOLD_COLS} FROM app.holds WHERE id = $1 FOR UPDATE`, [holdId]);
  const h = r.rows[0];
  if (!h || !ownedBy(h, owner)) throw notFound();
  return h;
}

const isLive = (h: HoldRow, now: Date) => h.status === 'active' && h.expires_at.getTime() > now.getTime();

/** Замок владельца до проверки «одно активное удержание на филиал» (ревизия S1-06 п.3): клиент – строка клиента
 *  FOR NO KEY UPDATE (clients.lockClients), посетитель – advisory-замок транзакции по visitor_id. Порядок замков
 *  всех команд клиента: удержание/бронь → клиент → ресурсы → единицы; повторный захват в insertClientTime – no-op. */
export async function lockOwner(tx: Tx, owner: HoldOwner): Promise<void> {
  if (owner.clientId !== null) await lockClients(tx, [owner.clientId]);
  else if (owner.visitorId !== null) await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('hold-visitor:' || $1, 0))`, [owner.visitorId]);
}

/** Активное (не истёкшее) удержание владельца в филиале. */
async function ownActiveHold(tx: Tx, branchId: string, owner: HoldOwner, now: Date): Promise<string | null> {
  const r = await tx.query<{ id: string }>(
    `SELECT id FROM app.holds WHERE branch_id = $1 AND status = 'active' AND expires_at > $2
       AND (($3::uuid IS NOT NULL AND client_id = $3) OR ($3::uuid IS NULL AND client_id IS NULL AND visitor_id = $4)) LIMIT 1`,
    [branchId, now, owner.clientId, owner.visitorId],
  );
  return r.rows[0]?.id ?? null;
}

const eventItem = (id: string, i: HoldItemInput): HoldItemEvent => ({ itemId: id, resourceId: i.resourceId, start: i.start.toISOString(), end: i.end.toISOString() });

/** Проверить позиции, погасить истёкшие удержания на их единицах, занять все одним INSERT. */
async function occupyItems(tx: Tx, branch: BranchInfo, owner: HoldOwner, now: Date, maxDays: number, items: HoldItemInput[], ids: string[], expiresAt: Date, holdId: string) {
  const checked = [];
  for (const [k, item] of items.entries()) checked.push(await checkItem(tx, branch, now, maxDays, item).catch((e) => itemError(e, k, item)));
  for (const c of checked) await releaseExpiredHolds(tx, now, { unitIds: c.units.unitIds, clientId: owner.clientId ?? undefined, period: c.period });
  for (const [k, c] of checked.entries()) {
    await tx.query(`INSERT INTO app.hold_items (id, hold_id, resource_id, period, unit_ids, created_at) VALUES ($1, $2, $3, $4, $5, $6)`, [
      ids[k],
      holdId,
      c.resource.id,
      toPgRange(c.period),
      c.units.unitIds,
      now,
    ]);
  }
  const occ: OccupyItem[] = checked.map((c, k) => ({ units: c.units, period: c.period, source: { type: 'hold_item', id: ids[k]!, holdExpiresAt: expiresAt }, clientId: owner.clientId }));
  try {
    await occupyMany(tx, branch.id, occ);
  } catch (err) {
    if (err instanceof AppError && checked.length === 1) itemError(err, 0, items[0]!);
    throw err;
  }
}

/** K5 №6: создать удержание – все позиции или ничего. Владелец уже определён маршрутом (клиент или посетитель). */
export async function createHold(tx: Tx, owner: HoldOwner, input: { branchId: string; items: HoldItemInput[] }, clock: Clock = systemClock): Promise<HoldDto> {
  if (owner.clientId === null && owner.visitorId === null) throw new AppError('VISITOR_REQUIRED', 400, 'Нужна кука посетителя');
  const now = clock.now();
  const branch = await activeBranch(tx, input.branchId, now);
  const s = await holdSettings(tx, branch.id, now);
  await lockOwner(tx, owner);
  if (input.items.length === 0) throw new AppError('VALIDATION_FAILED', 400, 'Нет позиций', { field: 'items' });
  if (input.items.length > s.maxItems) throw new AppError('HOLD_LIMIT_REACHED', 422, 'Слишком много слотов в одной записи', { max: s.maxItems });
  const existing = await ownActiveHold(tx, branch.id, owner, now);
  if (existing) throw new AppError('HOLD_ALREADY_ACTIVE', 409, 'Уже есть активное удержание – добавьте слот в него', { holdId: existing });
  if (owner.clientId === null) {
    // потолок анонимных (ревизия S1-06 п.4): счёт под advisory-замком филиала – параллельные не проскочат вдвоём
    await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('anon-holds:' || $1, 0))`, [branch.id]);
    const n = await tx.query<{ n: number }>(`SELECT count(*)::int n FROM app.holds WHERE branch_id = $1 AND status = 'active' AND expires_at > $2 AND client_id IS NULL`, [branch.id, now]);
    if (n.rows[0]!.n >= s.maxAnon) throw new AppError('RATE_LIMITED', 429, 'Слишком много запросов, подождите минуту', { reason: 'anonymous_holds' });
  }
  const holdId = randomUUID();
  const expiresAt = new Date(now.getTime() + s.ttl * 60_000);
  await tx.query(
    `INSERT INTO app.holds (id, branch_id, client_id, visitor_id, created_by_type, created_by_id, ttl_minutes, expires_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [holdId, branch.id, owner.clientId, owner.visitorId, owner.clientId ? 'client' : 'visitor', owner.clientId ?? owner.visitorId, s.ttl, expiresAt, now],
  );
  const ids = input.items.map(() => randomUUID());
  await occupyItems(tx, branch, owner, now, s.maxDays, input.items, ids, expiresAt, holdId);
  await publish(tx as OutboxTx, {
    type: 'hold.created',
    aggregateType: 'hold',
    aggregateId: holdId,
    aggregateVersion: 1,
    branchId: branch.id,
    occurredAt: now,
    payload: { holdId, branchId: branch.id, clientId: owner.clientId, expiresAt: expiresAt.toISOString(), items: input.items.map((i, k) => eventItem(ids[k]!, i)) },
  });
  return holdDto(tx, holdId, now);
}

/** Активные позиции удержания. */
async function activeItemIds(tx: Tx, holdId: string): Promise<string[]> {
  const r = await tx.query<{ id: string }>(`SELECT id FROM app.hold_items WHERE hold_id = $1 AND status = 'active' ORDER BY id`, [holdId]);
  return r.rows.map((x) => x.id);
}

/** K5 №8: добавить слот – общий таймер перезапускается для всех позиций и их строк (01 §7.2). */
export async function addHoldItem(tx: Tx, owner: HoldOwner, holdId: string, item: HoldItemInput, clock: Clock = systemClock): Promise<HoldDto> {
  const now = clock.now();
  const h = await lockHold(tx, holdId, owner);
  if (!isLive(h, now)) throw holdExpired();
  if (h.client_id !== null) await lockClients(tx, [h.client_id]);
  const branch = await activeBranch(tx, h.branch_id, now);
  const s = await holdSettings(tx, branch.id, now);
  const current = await activeItemIds(tx, h.id);
  if (current.length + 1 > s.maxItems) throw new AppError('HOLD_LIMIT_REACHED', 422, 'Слишком много слотов в одной записи', { max: s.maxItems });
  const expiresAt = new Date(now.getTime() + h.ttl_minutes * 60_000);
  const id = randomUUID();
  await occupyItems(tx, branch, { clientId: h.client_id, visitorId: h.visitor_id }, now, s.maxDays, [item], [id], expiresAt, h.id);
  const all = [...current, id];
  await tx.query('UPDATE app.holds SET expires_at = $2 WHERE id = $1', [h.id, expiresAt]);
  await tx.query(`UPDATE app.occupancy SET hold_expires_at = $2 WHERE active AND source_type = 'hold_item' AND source_id = ANY($1::uuid[])`, [all, expiresAt]);
  await tx.query(`UPDATE app.client_time SET hold_expires_at = $2 WHERE active AND source_type = 'hold_item' AND source_id = ANY($1::uuid[])`, [all, expiresAt]);
  const total = await tx.query<{ n: number }>('SELECT count(*)::int n FROM app.hold_items WHERE hold_id = $1', [h.id]);
  await publish(tx as OutboxTx, {
    type: 'hold.extended',
    aggregateType: 'hold',
    aggregateId: h.id,
    aggregateVersion: total.rows[0]!.n,
    branchId: h.branch_id,
    occurredAt: now,
    payload: { holdId: h.id, expiresAt: expiresAt.toISOString(), addedItem: eventItem(id, item) },
  });
  return holdDto(tx, h.id, now);
}

/** K5 №9: убрать позицию (таймер не меняется); последняя – удержание released. */
export async function removeHoldItem(tx: Tx, owner: HoldOwner, holdId: string, itemId: string, clock: Clock = systemClock): Promise<HoldDto> {
  const now = clock.now();
  const h = await lockHold(tx, holdId, owner);
  if (!isLive(h, now)) throw holdExpired();
  const items = await activeItemIds(tx, h.id);
  if (!items.includes(itemId.toLowerCase())) throw notFound();
  await releaseSources(tx, { type: 'hold_item', ids: [itemId] }, 'released', now);
  await tx.query(`UPDATE app.hold_items SET status = 'removed' WHERE id = $1`, [itemId]);
  if (items.length === 1) await tx.query(`UPDATE app.holds SET status = 'released', closed_at = $2 WHERE id = $1`, [h.id, now]);
  return holdDto(tx, h.id, now);
}

/** K5 №10: отпустить удержание целиком. */
export async function releaseHold(tx: Tx, owner: HoldOwner, holdId: string, clock: Clock = systemClock): Promise<HoldDto> {
  const now = clock.now();
  const h = await lockHold(tx, holdId, owner);
  if (h.status !== 'active') return holdDto(tx, h.id, now);
  const items = await activeItemIds(tx, h.id);
  await releaseSources(tx, { type: 'hold_item', ids: items }, 'released', now);
  await tx.query(`UPDATE app.hold_items SET status = 'removed' WHERE hold_id = $1 AND status = 'active'`, [h.id]);
  await tx.query(`UPDATE app.holds SET status = 'released', closed_at = $2 WHERE id = $1`, [h.id, now]);
  return holdDto(tx, h.id, now);
}

/** K5 №11: удержание посетителя переходит к вошедшему клиенту; client_time по всем позициям → CLIENT_OVERLAP. */
export async function attachHold(tx: Tx, clientId: string, visitorId: string | null, holdId: string, clock: Clock = systemClock): Promise<HoldDto> {
  const now = clock.now();
  const h = await lockHold(tx, holdId, { clientId, visitorId });
  if (h.client_id === clientId) return holdDto(tx, h.id, now);
  if (!isLive(h, now)) throw holdExpired();
  await lockOwner(tx, { clientId, visitorId: null });
  const other = await ownActiveHold(tx, h.branch_id, { clientId, visitorId: null }, now);
  if (other) throw new AppError('HOLD_ALREADY_ACTIVE', 409, 'Уже есть активное удержание в этом филиале', { holdId: other });
  await tx.query('UPDATE app.holds SET client_id = $2 WHERE id = $1', [h.id, clientId]);
  const items = await tx.query<{ id: string; period: string }>(`SELECT id, period::text FROM app.hold_items WHERE hold_id = $1 AND status = 'active' ORDER BY id`, [h.id]);
  // истёкшие удержания клиента на эти периоды ещё держат client_time – гасим до вставки (ревизия S1-06 п.7)
  for (const i of items.rows) await releaseExpiredHolds(tx, now, { clientId, period: fromPgRange(i.period) });
  await insertClientTime(
    tx,
    items.rows.map((i) => ({ clientId, period: fromPgRange(i.period), source: { type: 'hold_item' as const, id: i.id, holdExpiresAt: h.expires_at } })),
  );
  return holdDto(tx, h.id, now);
}

/** Хук входа клиента (K9 ClientLoginHooks.onLogin): переносит удержания посетителя; конфликтующее остаётся посетителю
 *  (сайт покажет CLIENT_OVERLAP при attach/confirm) – вход из-за удержания не падает. */
export async function attachVisitorHolds(tx: Tx, input: { clientId: string; visitorId: string | null; at: Date }): Promise<void> {
  if (!input.visitorId) return;
  const r = await tx.query<{ id: string }>(
    `SELECT id FROM app.holds WHERE visitor_id = $1 AND client_id IS NULL AND status = 'active' AND expires_at > $2 ORDER BY id`,
    [input.visitorId, input.at],
  );
  for (const { id } of r.rows) {
    await tx.query('SAVEPOINT attach_hold');
    try {
      await attachHold(tx, input.clientId, input.visitorId, id, { now: () => input.at });
      await tx.query('RELEASE SAVEPOINT attach_hold');
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      await tx.query('ROLLBACK TO SAVEPOINT attach_hold');
    }
  }
}

// ---- истечение (K6 releaseExpiredHolds, задача)

/** Перевести удержания в expired: строки гасятся, позиции и удержание закрываются, событие и аудит (K2, K4). */
async function expireHolds(tx: Tx, holdIds: string[], now: Date): Promise<void> {
  for (const holdId of holdIds) {
    const h = await tx.query<{ branch_id: string; client_id: string | null }>(
      `UPDATE app.holds SET status = 'expired', closed_at = $2 WHERE id = $1 AND status = 'active' RETURNING branch_id, client_id`,
      [holdId, now],
    );
    const row = h.rows[0];
    if (!row) continue;
    const items = await tx.query<{ id: string }>(`UPDATE app.hold_items SET status = 'expired' WHERE hold_id = $1 AND status = 'active' RETURNING id`, [holdId]);
    const itemIds = items.rows.map((x) => x.id).sort();
    await releaseSources(tx, { type: 'hold_item', ids: itemIds }, 'expired', now);
    await publish(tx as OutboxTx, {
      type: 'hold.expired',
      aggregateType: 'hold',
      aggregateId: holdId,
      aggregateVersion: 'expired',
      branchId: row.branch_id,
      occurredAt: now,
      payload: { holdId, branchId: row.branch_id, clientId: row.client_id, itemIds },
    });
    await writeAudit(tx, SYSTEM_META, { action: 'hold.expired', object: { type: 'hold', id: holdId }, branchId: row.branch_id, after: { itemIds } }, { now: () => now });
  }
}

/** K6: погасить истёкшие удержания на единицах/клиенте в ТЕКУЩЕЙ транзакции, до вставки новых строк.
 *  Заблокированные другим (их сейчас подтверждают или гасят) пропускаются – конфликт вставки даст SLOT_HELD. */
export async function releaseExpiredHolds(tx: Tx, now: Date, scope: { unitIds?: string[]; clientId?: string | undefined; period: Interval }): Promise<{ expiredHoldIds: string[] }> {
  const r = await tx.query<{ id: string }>(
    `SELECT h.id FROM app.holds h WHERE h.status = 'active' AND h.expires_at <= $1 AND h.id IN (
       SELECT hi.hold_id FROM app.occupancy o JOIN app.hold_items hi ON hi.id = o.source_id
        WHERE o.active AND o.source_type = 'hold_item' AND o.unit_id = ANY($2::uuid[]) AND o.period && $4::tstzrange
       UNION SELECT hi.hold_id FROM app.client_time ct JOIN app.hold_items hi ON hi.id = ct.source_id
        WHERE ct.active AND ct.source_type = 'hold_item' AND ct.client_id = $3 AND ct.period && $4::tstzrange)
     ORDER BY h.id FOR UPDATE SKIP LOCKED`,
    [now, scope.unitIds ?? [], scope.clientId ?? null, toPgRange(scope.period)],
  );
  const ids = r.rows.map((x) => x.id);
  await expireHolds(tx, ids, now);
  return { expiredHoldIds: ids };
}

/** Задача истечения: пачка истёкших удержаний FOR UPDATE SKIP LOCKED. Возвращает число погашенных. */
export async function expireDueHolds(pool: { connect(): Promise<pg.PoolClient> }, clock: Clock = systemClock, limit = 100): Promise<number> {
  const now = clock.now();
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await c.query<{ id: string }>(
      `SELECT id FROM app.holds WHERE status = 'active' AND expires_at <= $1 ORDER BY id FOR UPDATE SKIP LOCKED LIMIT $2`,
      [now, limit],
    );
    await expireHolds(c, r.rows.map((x) => x.id), now);
    await c.query('COMMIT');
    return r.rows.length;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

/** Фоновая задача процесса worker: раз в intervalMs (15 с, model-dannyh §0102). */
export function startHoldExpiry(opts: { pool: { connect(): Promise<pg.PoolClient> }; clock?: Clock; intervalMs?: number; onError?: (err: unknown) => void }): { stop(): void } {
  const timer = setInterval(() => {
    expireDueHolds(opts.pool, opts.clock).catch((err: unknown) => (opts.onError ?? ((e) => console.error('hold-expiry', e)))(err));
  }, opts.intervalMs ?? 15_000);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}

// ---- чтение

/** availability 'mine' (S1-05 OwnHoldItems): позиции живых удержаний этого посетителя/клиента в филиале. */
export async function ownHoldItems(db: Db | Tx, branchId: string, viewer: { visitorId?: string | undefined; clientId?: string | undefined }, now: Date): Promise<ReadonlySet<string>> {
  if (!viewer.visitorId && !viewer.clientId) return new Set();
  const r = await db.query<{ id: string }>(
    `SELECT hi.id FROM app.hold_items hi JOIN app.holds h ON h.id = hi.hold_id
     WHERE h.branch_id = $1 AND h.status = 'active' AND h.expires_at > $2 AND hi.status = 'active'
       AND (h.client_id = $3::uuid OR (h.client_id IS NULL AND h.visitor_id = $4::uuid))`,
    [branchId, now, viewer.clientId ?? null, viewer.visitorId ?? null],
  );
  return new Set(r.rows.map((x) => x.id));
}

export async function getHold(db: Db | Tx, owner: HoldOwner, holdId: string, clock: Clock = systemClock): Promise<HoldDto> {
  if (!UUID_RE.test(holdId)) throw notFound();
  const r = await db.query<HoldRow>(`SELECT ${HOLD_COLS} FROM app.holds WHERE id = $1`, [holdId]);
  const h = r.rows[0];
  if (!h || !ownedBy(h, owner)) throw notFound();
  return holdDto(db, h.id, clock.now());
}

/** HoldDto: истёкшее (даже не погашенное задачей) – status 'expired' и пустые слоты (01 §7.4). Цена – K6 quote. */
export async function holdDto(db: Db | Tx, holdId: string, now: Date): Promise<HoldDto> {
  const h = (await db.query<HoldRow>(`SELECT ${HOLD_COLS} FROM app.holds WHERE id = $1`, [holdId])).rows[0]!;
  const status: HoldDto['status'] = h.status === 'active' && h.expires_at.getTime() <= now.getTime() ? 'expired' : h.status;
  const items =
    status === 'expired' || status === 'released'
      ? []
      : (
          await db.query<{ id: string; resource_id: string; name: string; resource_type: string; s: Date; e: Date }>(
            `SELECT hi.id, hi.resource_id, r.name, r.resource_type, lower(hi.period) AS s, upper(hi.period) AS e
             FROM app.hold_items hi JOIN app.resources r ON r.id = hi.resource_id
             WHERE hi.hold_id = $1 AND hi.status IN ('active','converted') ORDER BY lower(hi.period), hi.id`,
            [holdId],
          )
        ).rows;
  const dto: HoldItemDto[] = [];
  for (const i of items) {
    const price = await quote(db, { branchId: h.branch_id, resourceType: i.resource_type, start: i.s, durationMinutes: durationMinutes({ start: i.s, end: i.e }) })
      .then((q) => q.priceKop)
      .catch((err: unknown) => {
        if (err instanceof AppError && (err.code === 'TARIFF_NOT_CONFIGURED' || err.code === 'TARIFF_AMBIGUOUS')) return null;
        throw err;
      });
    dto.push({ id: i.id, resourceId: i.resource_id, resourceName: i.name, start: i.s.toISOString(), end: i.e.toISOString(), priceKop: price });
  }
  return {
    id: h.id,
    branchId: h.branch_id,
    status,
    expiresAt: h.expires_at.toISOString(),
    serverNow: now.toISOString(),
    items: dto,
    totalKop: dto.some((i) => i.priceKop === null) ? null : dto.reduce((a, i) => a + (i.priceKop ?? 0), 0),
    owner: h.client_id ? 'client' : 'visitor',
  };
}

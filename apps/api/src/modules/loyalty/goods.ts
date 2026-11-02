// K15 §6, №26–28 (07 §7, §12.4): товары за баллы – каталог, выдача в клубе, возврат невыданного.
// Только целиком (Q-47): цена в баллах списывается одной записью loyalty.spend_goods, расход партий FEFO, в долг не уходит.
// Остаток товара в филиале необязателен (stock NULL – не ведётся); при ведении меняется под FOR UPDATE строки наличия.
// Невыданный или отменённый товар – возврат с причиной в исходные партии (returnSpend, §7). Удаления нет – архив.
// Права (K10 §10): каталог – loyalty.goods.manage (Владелец, Директор), выдача и возврат – loyalty.goods.issue
// (+ Администратор) в зоне филиала; зону клиента проверяет маршрут CRM.
import { randomUUID } from 'node:crypto';
import { writeAudit, type AuditRequestMeta, type Db } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import type { Tx } from '../../core/ledger.ts';
import { assertCan, type AccessContext } from '../../core/permissions.ts';
import { systemClock, type Clock } from '../../core/time.ts';
import { debitBatches, openAccount, postPoints, reservedCenti, returnSpend } from './account.ts';

export interface GoodsDto {
  id: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  priceRubKop: number | null;
  pricePointsCenti: number;
  status: 'active' | 'archived';
  rowVersion: number;
  branches: Array<{ branchId: string; stock: number | null; active: boolean }>;
}

export interface GoodsInput {
  name: string;
  description?: string | null;
  imageUrl?: string | null;
  priceRubKop?: number | null;
  pricePointsCenti: number;
  branches: Array<{ branchId: string; stock?: number | null; active?: boolean }>;
}

const notFound = () => new AppError('NOT_FOUND', 404, 'Не найдено');
const unavailable = (why: string) => new AppError('GOODS_UNAVAILABLE', 409, 'Товар сейчас нельзя выдать', { reason: why });

function validate(input: Partial<GoodsInput>): void {
  if (input.name !== undefined && input.name.trim() === '') throw new AppError('VALIDATION_FAILED', 400, 'Нужно название', { field: 'name' });
  if (input.pricePointsCenti !== undefined && (!Number.isSafeInteger(input.pricePointsCenti) || input.pricePointsCenti <= 0)) {
    throw new AppError('VALIDATION_FAILED', 400, 'Цена в баллах – целое > 0 (сотые)', { field: 'pricePointsCenti' });
  }
  for (const b of input.branches ?? []) {
    if (b.stock !== undefined && b.stock !== null && (!Number.isSafeInteger(b.stock) || b.stock < 0)) throw new AppError('VALIDATION_FAILED', 400, 'Остаток – целое ≥ 0', { field: 'stock' });
  }
}

export async function getGoods(db: Db, id: string): Promise<GoodsDto | null> {
  const g = (
    await db.query<{ id: string; name: string; description: string | null; image_url: string | null; price_rub_kop: string | null; price_points_centi: string; status: 'active' | 'archived'; row_version: number }>(
      'SELECT id, name, description, image_url, price_rub_kop, price_points_centi, status, row_version FROM app.loyalty_goods WHERE id = $1',
      [id],
    )
  ).rows[0];
  if (!g) return null;
  const br = await db.query<{ branch_id: string; stock: number | null; active: boolean }>('SELECT branch_id, stock, active FROM app.loyalty_goods_branches WHERE goods_id = $1 ORDER BY branch_id', [id]);
  return {
    id: g.id, name: g.name, description: g.description, imageUrl: g.image_url, priceRubKop: g.price_rub_kop === null ? null : Number(g.price_rub_kop),
    pricePointsCenti: Number(g.price_points_centi), status: g.status, rowVersion: g.row_version,
    branches: br.rows.map((b) => ({ branchId: b.branch_id, stock: b.stock, active: b.active })),
  };
}

async function upsertBranches(tx: Tx, ctx: AccessContext, goodsId: string, branches: GoodsInput['branches']): Promise<void> {
  for (const b of branches) {
    assertCan(ctx, 'loyalty.goods.manage', { branchId: b.branchId });
    await tx.query(
      `INSERT INTO app.loyalty_goods_branches (goods_id, branch_id, stock, active) VALUES ($1, $2, $3, $4)
       ON CONFLICT (goods_id, branch_id) DO UPDATE SET stock = EXCLUDED.stock, active = EXCLUDED.active`,
      [goodsId, b.branchId, b.stock ?? null, b.active ?? true],
    );
  }
}

/** K15 №26 POST /goods. */
export async function createGoods(tx: Tx, ctx: AccessContext, input: GoodsInput, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<GoodsDto> {
  validate(input);
  if (input.branches.length === 0) throw new AppError('VALIDATION_FAILED', 400, 'Нужен хотя бы один филиал', { field: 'branches' });
  const id = randomUUID();
  await tx.query(
    `INSERT INTO app.loyalty_goods (id, name, description, image_url, price_rub_kop, price_points_centi, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, input.name.trim(), input.description ?? null, input.imageUrl ?? null, input.priceRubKop ?? null, input.pricePointsCenti, clock.now()],
  );
  await upsertBranches(tx, ctx, id, input.branches);
  const dto = (await getGoods(tx, id))!;
  await writeAudit(tx, meta, { action: 'loyalty.goods.created', object: { type: 'branch', id: input.branches[0]!.branchId }, after: dto }, clock);
  return dto;
}

/** K15 №26 PATCH /goods/{id}: поля, наличие в филиалах, архив (status 'archived') – вместо удаления. */
export async function updateGoods(
  tx: Tx,
  ctx: AccessContext,
  id: string,
  input: Partial<GoodsInput> & { rowVersion: number; status?: 'active' | 'archived' },
  meta: AuditRequestMeta,
  clock: Clock = systemClock,
): Promise<GoodsDto> {
  validate(input);
  const before = await getGoods(tx, id);
  if (!before || !before.branches.some((b) => ctx.network || ctx.branchIds.has(b.branchId))) throw notFound();
  for (const b of before.branches) if (ctx.network || ctx.branchIds.has(b.branchId)) assertCan(ctx, 'loyalty.goods.manage', { branchId: b.branchId });
  const r = await tx.query(
    `UPDATE app.loyalty_goods SET name = COALESCE($3, name), description = CASE WHEN $4::boolean THEN $5 ELSE description END,
       image_url = CASE WHEN $6::boolean THEN $7 ELSE image_url END, price_rub_kop = CASE WHEN $8::boolean THEN $9::bigint ELSE price_rub_kop END,
       price_points_centi = COALESCE($10::bigint, price_points_centi), status = COALESCE($11, status), row_version = row_version + 1
     WHERE id = $1 AND row_version = $2`,
    [id, input.rowVersion, input.name?.trim() ?? null, input.description !== undefined, input.description ?? null, input.imageUrl !== undefined, input.imageUrl ?? null,
      input.priceRubKop !== undefined, input.priceRubKop ?? null, input.pricePointsCenti ?? null, input.status ?? null],
  );
  if (r.rowCount !== 1) throw new AppError('VERSION_CONFLICT', 409, 'Карточку товара уже изменили', { rowVersion: before.rowVersion });
  if (input.branches) await upsertBranches(tx, ctx, id, input.branches);
  const after = (await getGoods(tx, id))!;
  const action = input.status === 'archived' && before.status !== 'archived' ? 'loyalty.goods.archived' : 'loyalty.goods.updated';
  await writeAudit(tx, meta, { action, object: { type: 'branch', id: after.branches[0]?.branchId ?? null }, before, after }, clock);
  return after;
}

/** Каталог филиала (K15 №26 GET /branches/{id}/goods и ЛК GET /goods): available – товар можно выдать сейчас. */
export async function listBranchGoods(db: Db, branchId: string, opts: { includeArchived?: boolean } = {}) {
  const r = await db.query<{ id: string; name: string; description: string | null; image_url: string | null; price_rub_kop: string | null; price_points_centi: string; status: string; stock: number | null; active: boolean; row_version: number }>(
    `SELECT g.id, g.name, g.description, g.image_url, g.price_rub_kop, g.price_points_centi, g.status, g.row_version, gb.stock, gb.active
     FROM app.loyalty_goods g JOIN app.loyalty_goods_branches gb ON gb.goods_id = g.id
     WHERE gb.branch_id = $1 AND ($2::boolean OR (g.status = 'active' AND gb.active)) ORDER BY g.name, g.id`,
    [branchId, opts.includeArchived === true],
  );
  return r.rows.map((g) => ({
    id: g.id, name: g.name, description: g.description, imageUrl: g.image_url, priceRubKop: g.price_rub_kop === null ? null : Number(g.price_rub_kop),
    pricePointsCenti: Number(g.price_points_centi), status: g.status, stock: g.stock, rowVersion: g.row_version,
    available: g.status === 'active' && g.active && (g.stock === null || g.stock > 0),
  }));
}

/** K15 №27: выдать товар за баллы целиком. Повтор с тем же ключом – тот же заказ. */
export async function issueGoods(
  tx: Tx,
  ctx: AccessContext,
  input: { clientId: string; goodsId: string; branchId: string; idempotencyKey: string },
  meta: AuditRequestMeta,
  clock: Clock = systemClock,
): Promise<{ orderId: string; entryId: number }> {
  assertCan(ctx, 'loyalty.goods.issue', { branchId: input.branchId });
  const now = clock.now();
  const key = `loyalty-goods:${input.idempotencyKey}`;
  const acc = await openAccount(tx, input.clientId, now);
  const prior = (await tx.query<{ id: string; spend_entry_id: string }>(
    `SELECT o.id, o.spend_entry_id FROM app.loyalty_goods_orders o JOIN journal.ledger_entries e ON e.id = o.spend_entry_id WHERE e.idempotency_key = $1`,
    [`${key}#0`],
  )).rows[0];
  if (prior) return { orderId: prior.id, entryId: Number(prior.spend_entry_id) };
  const g = (
    await tx.query<{ status: string; price_points_centi: string; stock: number | null; active: boolean }>(
      `SELECT g.status, g.price_points_centi, gb.stock, gb.active FROM app.loyalty_goods g
       JOIN app.loyalty_goods_branches gb ON gb.goods_id = g.id AND gb.branch_id = $2 WHERE g.id = $1 FOR UPDATE OF gb`,
      [input.goodsId, input.branchId],
    )
  ).rows[0];
  if (!g) throw unavailable('not_in_branch');
  if (g.status !== 'active') throw unavailable('archived');
  if (!g.active) throw unavailable('not_in_branch');
  if (g.stock !== null && g.stock <= 0) throw unavailable('out_of_stock');
  const price = Number(g.price_points_centi);
  const available = Math.max(0, Math.max(0, acc.balance) - (await reservedCenti(tx, acc.clientId, now)));
  if (available < price) throw new AppError('POINTS_INSUFFICIENT', 409, 'Баллов недостаточно для товара', { availableCenti: available, requiredCenti: price });
  const orderId = randomUUID();
  const p = await postPoints(tx, acc.clientId, { amount: -price, type: 'loyalty.spend_goods', branchId: input.branchId, occurredAt: now, ref: { type: 'goods_order', id: orderId } }, key, { type: 'staff', id: ctx.actor.staffId });
  await debitBatches(tx, { clientId: acc.clientId, entryId: p.entryId, amount: price, balanceBefore: p.balanceBefore, kind: 'spend_goods', ref: { type: 'goods_order', id: orderId } });
  if (g.stock !== null) await tx.query('UPDATE app.loyalty_goods_branches SET stock = stock - 1 WHERE goods_id = $1 AND branch_id = $2', [input.goodsId, input.branchId]);
  await tx.query(
    `INSERT INTO app.loyalty_goods_orders (id, goods_id, branch_id, client_id, price_points_centi, spend_entry_id, issued_by, issued_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [orderId, input.goodsId, input.branchId, acc.clientId, price, p.entryId, ctx.actor.staffId, now],
  );
  await writeAudit(tx, meta, { action: 'loyalty.goods.issued', object: { type: 'client', id: acc.clientId }, branchId: input.branchId, after: { orderId, goodsId: input.goodsId, priceCenti: price } }, clock);
  return { orderId, entryId: p.entryId };
}

/** K15 №28: возврат невыданного или отменённого товара с причиной – баллы в исходные партии, остаток +1. */
export async function returnGoods(
  tx: Tx,
  ctx: AccessContext,
  input: { orderId: string; reason: string },
  meta: AuditRequestMeta,
  clock: Clock = systemClock,
): Promise<{ returnedCenti: number; notReturnedCenti: number }> {
  const reason = input.reason?.trim() ?? '';
  const orderSql = 'SELECT id, goods_id, branch_id, client_id, spend_entry_id, status FROM app.loyalty_goods_orders WHERE id = $1';
  type OrderRow = { id: string; goods_id: string; branch_id: string; client_id: string; spend_entry_id: string; status: string };
  // счёт журнала – до строки заказа (K17 «Решения 02.11»): клиент без блокировки → openAccount → заказ FOR UPDATE → проверить
  const pre = (await tx.query<OrderRow>(orderSql, [input.orderId])).rows[0];
  if (!pre) throw notFound();
  assertCan(ctx, 'loyalty.goods.issue', { branchId: pre.branch_id }); // филиал заказа не меняется
  await openAccount(tx, pre.client_id, clock.now());
  const o = (await tx.query<OrderRow>(`${orderSql} FOR UPDATE`, [input.orderId])).rows[0];
  if (!o) throw notFound();
  if (reason === '') throw new AppError('COMMENT_REQUIRED', 422, 'Укажите причину возврата', { field: 'reason' });
  if (o.status !== 'issued') throw new AppError('ALREADY_REVERSED', 409, 'Товар уже возвращён');
  const now = clock.now();
  const r = await returnSpend(tx, { originalEntryId: Number(o.spend_entry_id), reason, idempotencyKey: `loyalty-goods-return:${o.id}`, author: { type: 'staff', id: ctx.actor.staffId }, occurredAt: now });
  await tx.query(`UPDATE app.loyalty_goods_branches SET stock = stock + 1 WHERE goods_id = $1 AND branch_id = $2 AND stock IS NOT NULL`, [o.goods_id, o.branch_id]);
  await tx.query(`UPDATE app.loyalty_goods_orders SET status = 'returned', return_entry_id = $2, return_reason = $3 WHERE id = $1`, [o.id, r.entryId, reason]);
  await writeAudit(tx, meta, { action: 'loyalty.goods.returned', object: { type: 'client', id: o.client_id }, branchId: o.branch_id, after: { orderId: o.id, ...r }, reason }, clock);
  return { returnedCenti: r.returnedCenti, notReturnedCenti: r.notReturnedCenti };
}

// K15 §1–§3, §7: бонусный счёт клиента, партии поверх K3, FEFO, «долг», возврат в исходную партию, доступный баланс.
// Баланс – только журнал K3 (триггер). Партии – кэш поверх журнала; инвариант (решение K15 §2):
//   Σ remaining_centi активных партий = max(0, баланс K3); отрицательный баланс – «долг» без партий.
// Порядок в каждой команде (K15 §1): openAccount (ensure + lockAccounts + ленивое истечение) → перечитать → проверить → писать.
// Транзакцию модуль не открывает: tx передаёт вызывающий (как K3).
import { AppError } from '../../core/errors.ts';
import { effectiveClientId } from '../clients/merge.ts';
import {
  ensureAccount,
  lockAccounts,
  post,
  reverse,
  type AccountRef,
  type Db,
  type EntryInput,
  type PostingInput,
  type Tx,
} from '../../core/ledger.ts';

/** Предел счёта баллов: −50 баллов (07 §3.1, §9.1). Константа подтверждённого правила. */
export const POINTS_MIN_BALANCE = -5000;
export const SYSTEM_AUTHOR = { type: 'system', id: null } as const;

export type MoveKind = 'spend_time' | 'spend_goods' | 'penalty' | 'expire' | 'return' | 'debt_cover' | 'manual' | 'accrual_reversal' | 'merge'; // merge – перенос остатка при слиянии карточек (0447)
export type Author = PostingInput['author'];

export const accountRef = (clientId: string): AccountRef => ({ kind: 'loyalty_client', ownerType: 'client', ownerId: clientId.toLowerCase() });

const num = (v: string | number | null | undefined): number => (v === null || v === undefined ? 0 : Number(v));

// ---- счёт

export interface OpenedAccount {
  accountId: string;
  clientId: string;
  balance: number;
}

/** Найти или создать счёт клиента, заблокировать его (FOR UPDATE) и списать истёкшие партии. Баланс – после истечения. */
export async function openAccount(tx: Tx, clientId: string, now: Date): Promise<OpenedAccount> {
  const acc = await ensureAccount(tx, accountRef(clientId), { unit: 'POINT_CENTI', branchId: null, minBalance: POINTS_MIN_BALANCE });
  await lockAccounts(tx, [acc.id]);
  await expireDue(tx, clientId, now);
  return { accountId: acc.id, clientId: acc.ownerId, balance: await currentBalance(tx, acc.id) };
}

/**
 * Счёт действующей карточки (K9 «Слияние», D5-09): тот же openAccount, затем – уже под замком счёта – проверка, что карточку
 * не объединили. Слияние держит счета обеих карточек до коммита; команда, которая прочла клиента без замка (обработчик по
 * брони, оплата по сеансу), после коммита слияния видит merged и получает CLIENT_MERGED: outbox повторит, повтор возьмёт
 * основную; в CRM – повторить на основной карточке. Внутренние коррекции объединённой карточки идут через openAccount.
 */
export async function openClientAccount(tx: Tx, clientId: string, now: Date): Promise<OpenedAccount> {
  const acc = await openAccount(tx, clientId, now);
  const owner = await effectiveClientId(tx, acc.clientId);
  if (owner !== acc.clientId) {
    throw new AppError('CLIENT_MERGED', 409, 'Карточка объединена – баллы у основной карточки', { clientId: acc.clientId, mergedIntoId: owner });
  }
  return acc;
}

async function currentBalance(tx: Tx, accountId: string): Promise<number> {
  return num((await tx.query<{ balance: string }>('SELECT balance FROM app.ledger_accounts WHERE id = $1', [accountId])).rows[0]?.balance);
}

/** Одна запись K3 по счёту клиента; возвращает id записи и баланс до неё. */
export async function postPoints(
  tx: Tx,
  clientId: string,
  e: Omit<EntryInput, 'account'>,
  key: string,
  author: Author,
  allowBelowLimit?: { reason: string },
): Promise<{ entryId: number; balanceBefore: number; replayed: boolean }> {
  const r = await post(tx, { entries: [{ ...e, account: accountRef(clientId) }], idempotencyKey: key, author, ...(allowBelowLimit ? { allowBelowLimit } : {}) });
  const entry = r.entries[0]!;
  return { entryId: entry.id, balanceBefore: entry.balanceAfter - entry.amount, replayed: r.replayed };
}

// ---- партии

interface BatchRow {
  id: string;
  remaining_centi: string;
  amount_centi: string;
  expires_at: Date | null;
  status: 'active' | 'depleted' | 'expired';
  branch_id: string | null;
}

async function insertMove(tx: Tx, batchId: string, entryId: number, kind: MoveKind, delta: number, ref?: { type: string; id: string }): Promise<void> {
  await tx.query(
    `INSERT INTO journal.loyalty_batch_moves (batch_id, ledger_entry_id, kind, delta_centi, ref_type, ref_id) VALUES ($1, $2, $3, $4, $5, $6)`,
    [batchId, entryId, kind, delta, ref?.type ?? null, ref?.id ?? null],
  );
}

async function setRemaining(tx: Tx, batchId: string, remaining: number, expired = false): Promise<void> {
  await tx.query(
    `UPDATE app.loyalty_batches SET remaining_centi = $2::bigint,
       status = CASE WHEN $3::boolean THEN 'expired' WHEN $2::bigint > 0 THEN 'active' WHEN status = 'expired' THEN 'expired' ELSE 'depleted' END
     WHERE id = $1`,
    [batchId, remaining, expired],
  );
}

/** Новая партия на приход +A при балансе B до записи: remaining = A − погашенный долг, долг – движение debt_cover (K15 §2). */
export async function createBatch(
  tx: Tx,
  input: {
    clientId: string;
    entryId: number;
    amount: number;
    balanceBefore: number;
    source: 'visit' | 'manual';
    branchId: string | null;
    bookingId?: string | null;
    visitId?: string | null;
    expiresAt: Date | null;
    accruedAt: Date;
  },
): Promise<string> {
  const cover = Math.min(input.amount, Math.max(0, -input.balanceBefore));
  const remaining = input.amount - cover;
  const r = await tx.query<{ id: string }>(
    `INSERT INTO app.loyalty_batches (client_id, source, accrual_entry_id, branch_id, booking_id, visit_id, amount_centi, remaining_centi, expires_at, status, accrued_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::bigint, $9, CASE WHEN $8::bigint > 0 THEN 'active' ELSE 'depleted' END, $10) RETURNING id`,
    [input.clientId, input.source, input.entryId, input.branchId, input.bookingId ?? null, input.visitId ?? null, input.amount, remaining, input.expiresAt, input.accruedAt],
  );
  const batchId = r.rows[0]!.id;
  if (cover > 0) await insertMove(tx, batchId, input.entryId, 'debt_cover', -cover);
  return batchId;
}

/** Расход −D при балансе B до записи: из remaining FEFO (сначала preferBatchId), не больше max(0, B); остаток – долг. */
export async function debitBatches(
  tx: Tx,
  input: { clientId: string; entryId: number; amount: number; balanceBefore: number; kind: MoveKind; preferBatchId?: string; ref?: { type: string; id: string } },
): Promise<void> {
  let left = Math.min(input.amount, Math.max(0, input.balanceBefore));
  if (left <= 0) return;
  const rows = (
    await tx.query<BatchRow>(
      `SELECT id, remaining_centi, amount_centi, expires_at, status, branch_id FROM app.loyalty_batches
       WHERE client_id = $1 AND status = 'active' AND remaining_centi > 0
       ORDER BY (id = $2::uuid) DESC, expires_at NULLS LAST, accrued_at, id FOR UPDATE`,
      [input.clientId, input.preferBatchId ?? null],
    )
  ).rows;
  for (const b of rows) {
    if (left === 0) break;
    const d = Math.min(num(b.remaining_centi), left);
    await setRemaining(tx, b.id, num(b.remaining_centi) - d);
    await insertMove(tx, b.id, input.entryId, input.kind, -d, input.ref);
    left -= d;
  }
  if (left > 0) throw new Error(`loyalty: партии клиента ${input.clientId} меньше баланса – нарушен инвариант K15 §2`);
}

/**
 * Приход +R в существующие партии при балансе B до записи (возврат, сторно расхода). targets – куда вернуть (исходные
 * партии, Σ ≤ R); свободная часть R − Σ targets – то, что когда-то ушло в долг. Порядок (решение K15 §2, §7):
 * 1) долг max(0, −B) гасит сначала свободная часть, затем targets (движение debt_cover −c);
 * 2) свободный остаток восстанавливает ранее погашенный долг партий (debt_cover +x, новые – первыми);
 * 3) часть, попавшая в истёкшую партию, сразу истекает снова (loyalty.expire, ключ reexpireKey) – срок не продлевается.
 */
export async function creditBatches(
  tx: Tx,
  input: {
    clientId: string;
    entryId: number;
    amount: number;
    balanceBefore: number;
    targets: Array<{ batchId: string; centi: number }>;
    ref?: { type: string; id: string };
    now: Date;
    reexpireKey: string;
    author: Author;
  },
): Promise<void> {
  const targeted = input.targets.reduce((s, t) => s + t.centi, 0);
  if (targeted > input.amount) throw new Error('loyalty: возврат в партии больше суммы прихода');
  let free = input.amount - targeted;
  let absorb = Math.min(Math.max(0, -input.balanceBefore), input.amount);
  const fromFree = Math.min(absorb, free);
  free -= fromFree;
  absorb -= fromFree;
  const touched = new Map<string, { added: number; dead: boolean }>(); // партия → добавлено в remaining, истекла ли
  const touch = (b: BatchRow, x: number) => {
    const t = touched.get(b.id) ?? { added: 0, dead: b.status === 'expired' || (b.expires_at !== null && b.expires_at <= input.now) };
    t.added += x;
    touched.set(b.id, t);
  };

  for (const t of input.targets) {
    if (t.centi <= 0) continue;
    const b = (await tx.query<BatchRow>('SELECT id, remaining_centi, amount_centi, expires_at, status, branch_id FROM app.loyalty_batches WHERE id = $1 FOR UPDATE', [t.batchId])).rows[0]!;
    await insertMove(tx, b.id, input.entryId, 'return', t.centi, input.ref);
    const c = Math.min(absorb, t.centi);
    if (c > 0) await insertMove(tx, b.id, input.entryId, 'debt_cover', -c, input.ref);
    absorb -= c;
    touch(b, t.centi - c);
    await setRemaining(tx, b.id, num(b.remaining_centi) + t.centi - c);
  }
  if (free > 0) {
    const covered = (
      await tx.query<{ batch_id: string; covered: string }>(
        `SELECT m.batch_id, -sum(m.delta_centi) AS covered FROM journal.loyalty_batch_moves m
         JOIN app.loyalty_batches b ON b.id = m.batch_id
         WHERE b.client_id = $1 AND m.kind = 'debt_cover'
         GROUP BY m.batch_id HAVING sum(m.delta_centi) < 0 ORDER BY max(m.id) DESC`,
        [input.clientId],
      )
    ).rows;
    for (const row of covered) {
      if (free === 0) break;
      const x = Math.min(free, num(row.covered));
      const b = (await tx.query<BatchRow>('SELECT id, remaining_centi, amount_centi, expires_at, status, branch_id FROM app.loyalty_batches WHERE id = $1 FOR UPDATE', [row.batch_id])).rows[0]!;
      await insertMove(tx, b.id, input.entryId, 'debt_cover', x, input.ref);
      touch(b, x);
      await setRemaining(tx, b.id, num(b.remaining_centi) + x);
      free -= x;
    }
    if (free > 0) throw new Error(`loyalty: свободная часть возврата ${free} без партии – нарушен инвариант K15 §2`);
  }

  // 3) истёкшие партии: вернувшееся сразу истекает снова
  const ids = [...touched.entries()].filter(([, v]) => v.dead && v.added > 0).map(([id]) => id);
  if (ids.length === 0) return;
  const dead = (
    await tx.query<BatchRow>('SELECT id, remaining_centi, amount_centi, expires_at, status, branch_id FROM app.loyalty_batches WHERE id = ANY($1::uuid[]) ORDER BY id', [ids])
  ).rows;
  const total = dead.reduce((s, b) => s + num(b.remaining_centi), 0);
  if (total === 0) return;
  const exp = await postPoints(tx, input.clientId, { amount: -total, type: 'loyalty.expire', branchId: dead[0]!.branch_id, occurredAt: input.now, refs: { reason: 'reexpire' } }, input.reexpireKey, input.author);
  for (const b of dead) {
    if (num(b.remaining_centi) === 0) continue;
    await insertMove(tx, b.id, exp.entryId, 'expire', -num(b.remaining_centi));
    await setRemaining(tx, b.id, 0, true);
  }
}

/** Списать партии клиента со сроком ≤ now: по одной записи K3 loyalty.expire на партию (ключ loyalty-expire:<batchId>). */
export async function expireDue(tx: Tx, clientId: string, now: Date): Promise<number> {
  const due = (
    await tx.query<BatchRow>(
      `SELECT id, remaining_centi, amount_centi, expires_at, status, branch_id FROM app.loyalty_batches
       WHERE client_id = $1 AND status IN ('active','depleted') AND expires_at IS NOT NULL AND expires_at <= $2
       ORDER BY expires_at, id FOR UPDATE`,
      [clientId, now],
    )
  ).rows;
  let expired = 0;
  for (const b of due) {
    const rem = num(b.remaining_centi);
    if (rem === 0) {
      await setRemaining(tx, b.id, 0, true);
      continue;
    }
    const e = await postPoints(tx, clientId, { amount: -rem, type: 'loyalty.expire', branchId: b.branch_id, occurredAt: b.expires_at!, refs: { batchId: b.id } }, `loyalty-expire:${b.id}`, SYSTEM_AUTHOR);
    await insertMove(tx, b.id, e.entryId, 'expire', -rem);
    await setRemaining(tx, b.id, 0, true);
    expired += rem;
  }
  return expired;
}

// ---- сторно записи с партиями

/** Движения партий записи K3, сгруппированные по партии (знак – как в журнале). */
export async function movesOf(tx: Db, entryId: number): Promise<Array<{ batchId: string; delta: number; expiresAt: Date | null; status: string }>> {
  const r = await tx.query<{ batch_id: string; delta: string; expires_at: Date | null; status: string }>(
    `SELECT m.batch_id, sum(m.delta_centi) AS delta, b.expires_at, b.status FROM journal.loyalty_batch_moves m
     JOIN app.loyalty_batches b ON b.id = m.batch_id
     WHERE m.ledger_entry_id = $1 AND m.kind NOT IN ('debt_cover') GROUP BY m.batch_id, b.expires_at, b.status ORDER BY min(m.id)`,
    [entryId],
  );
  return r.rows.map((x) => ({ batchId: x.batch_id, delta: num(x.delta), expiresAt: x.expires_at, status: x.status }));
}

/**
 * Сторно записи баллов K3 вместе с партиями. Приход (начисление, «+» корректировка): K3 reverse, расход FEFO с партии
 * самой записи первой (accrual_reversal). Расход (штраф, «−» корректировка): K3 reverse, возврат в исходные партии
 * (creditBatches: долг, истёкшее – истекает снова). Вызывающий уже держит openAccount.
 */
export async function reverseWithBatches(
  tx: Tx,
  input: { clientId: string; entryId: number; reason: string; idempotencyKey: string; author: Author; occurredAt: Date },
): Promise<{ entryId: number; amount: number; replayed: boolean }> {
  const r = await reverse(tx, { entryId: input.entryId, reason: input.reason, idempotencyKey: input.idempotencyKey, author: input.author, occurredAt: input.occurredAt });
  const e = r.entries[0]!;
  if (r.replayed) return { entryId: e.id, amount: e.amount, replayed: true };
  const balanceBefore = e.balanceAfter - e.amount;
  if (e.amount < 0) {
    const own = (await tx.query<{ id: string }>('SELECT id FROM app.loyalty_batches WHERE accrual_entry_id = $1', [input.entryId])).rows[0]?.id;
    await debitBatches(tx, { clientId: input.clientId, entryId: e.id, amount: -e.amount, balanceBefore, kind: 'accrual_reversal', ...(own ? { preferBatchId: own } : {}) });
  } else {
    const targets = (await movesOf(tx, input.entryId)).filter((m) => m.delta < 0).map((m) => ({ batchId: m.batchId, centi: -m.delta }));
    await creditBatches(tx, { clientId: input.clientId, entryId: e.id, amount: e.amount, balanceBefore, targets, now: input.occurredAt, reexpireKey: `${input.idempotencyKey}:reexpire`, author: input.author });
  }
  return { entryId: e.id, amount: e.amount, replayed: false };
}

// ---- возврат списания (K15 §7, 18 §6.3 п.9)

/**
 * Вернуть списание на время или товар в те же партии. Часть партии с истёкшим сроком – «не возвращено»: K3 и движения
 * не пишутся. Возвращённая часть – loyalty.return +R (refs.originalEntryId), сначала гасит долг, остаток – в remaining
 * исходных партий с их исходным expires_at. Повтор с тем же ключом – тот же ответ; второй возврат той же записи – ALREADY_REVERSED.
 */
export async function returnSpend(
  tx: Tx,
  input: { originalEntryId: number; reason: string; idempotencyKey: string; author: Author; occurredAt: Date },
): Promise<{ returnedCenti: number; notReturnedCenti: number; entryId: number | null }> {
  const orig = (
    await tx.query<{ owner_id: string; kind: string; entry_type: string; amount: string; branch_id: string | null; ref_type: string | null; ref_id: string | null }>(
      `SELECT a.owner_id, a.kind, e.entry_type, e.amount, e.branch_id, e.ref_type, e.ref_id FROM journal.ledger_entries e
       JOIN app.ledger_accounts a ON a.id = e.account_id WHERE e.id = $1`,
      [input.originalEntryId],
    )
  ).rows[0];
  if (!orig || orig.kind !== 'loyalty_client' || !['loyalty.spend_time', 'loyalty.spend_goods'].includes(orig.entry_type)) {
    throw new AppError('NOT_FOUND', 404, 'Списание баллов не найдено', { entryId: input.originalEntryId });
  }
  if (input.reason.trim() === '') throw new AppError('COMMENT_REQUIRED', 422, 'Нужна причина возврата');
  await openAccount(tx, orig.owner_id, input.occurredAt);
  const prev = (
    await tx.query<{ id: string; amount: string; idempotency_key: string; refs: { notReturnedCenti?: string } }>(
      `SELECT id, amount, idempotency_key, refs FROM journal.ledger_entries WHERE entry_type = 'loyalty.return' AND refs ->> 'originalEntryId' = $1`,
      [String(input.originalEntryId)],
    )
  ).rows[0];
  if (prev) {
    if (prev.idempotency_key !== `${input.idempotencyKey}#0`) throw new AppError('ALREADY_REVERSED', 409, 'Списание уже возвращено');
    return { returnedCenti: num(prev.amount), notReturnedCenti: num(prev.refs.notReturnedCenti), entryId: Number(prev.id) };
  }
  const moves = (await movesOf(tx, input.originalEntryId)).filter((m) => m.delta < 0);
  let notReturned = 0;
  const targets: Array<{ batchId: string; centi: number }> = [];
  for (const m of moves) {
    if (m.status === 'expired' || (m.expiresAt !== null && m.expiresAt <= input.occurredAt)) notReturned += -m.delta;
    else targets.push({ batchId: m.batchId, centi: -m.delta });
  }
  const returned = targets.reduce((s, t) => s + t.centi, 0);
  if (returned === 0) return { returnedCenti: 0, notReturnedCenti: notReturned, entryId: null };
  const ref = orig.ref_type && orig.ref_id ? { type: orig.ref_type as NonNullable<EntryInput['ref']>['type'], id: orig.ref_id } : undefined;
  const p = await postPoints(
    tx,
    orig.owner_id,
    {
      amount: returned,
      type: 'loyalty.return',
      basis: input.reason.trim(),
      branchId: orig.branch_id,
      occurredAt: input.occurredAt,
      refs: { originalEntryId: String(input.originalEntryId), notReturnedCenti: String(notReturned) },
      ...(ref ? { ref } : {}),
    },
    input.idempotencyKey,
    input.author,
  );
  await creditBatches(tx, {
    clientId: orig.owner_id, entryId: p.entryId, amount: returned, balanceBefore: p.balanceBefore, targets,
    now: input.occurredAt, reexpireKey: `${input.idempotencyKey}:reexpire`, author: input.author,
  });
  return { returnedCenti: returned, notReturnedCenti: notReturned, entryId: p.entryId };
}

// ---- резервы и доступный баланс (K15 §3)

/** Резерв удержания совпадает с удержанием hp (представление booking app.booking_hold_points, миграция 0208 – таблицы
 *  удержаний loyalty не читает, ADR 0002): подпись позиций та же и удержание живо или уже подтверждено («converted до
 *  обработки» booking.confirmed; подпись подтверждённого – по позициям 'converted'). Иначе резерв снят (hold_changed …). */
export const holdReserveMatchSql = (r: string, hp: string, atParam: string): string =>
  `(${r}.hold_signature = ${hp}.items_signature AND ((${hp}.status = 'active' AND ${hp}.expires_at > ${atParam}) OR ${hp}.status = 'converted'))`;

/** Резерв «занят»: резерв брони; резерв удержания, пока он совпадает с удержанием (ленивое снятие, K15 §3). */
export const reserveLiveSql = (r: string, atParam: string): string =>
  `(${r}.status = 'booking' OR (${r}.status = 'hold' AND EXISTS (
     SELECT 1 FROM app.booking_hold_points hp WHERE hp.hold_id = ${r}.hold_id AND ${holdReserveMatchSql(r, 'hp', atParam)})))`;

/** Σ занятых резервов клиента; exclude – не считать резерв этой брони или этого удержания (оплата той же брони). */
export async function reservedCenti(db: Db, clientId: string, at: Date, exclude: { bookingId?: string; holdId?: string } = {}): Promise<number> {
  const r = await db.query<{ s: string | null }>(
    `SELECT sum(r.amount_centi) AS s FROM app.loyalty_reserves r
     WHERE r.client_id = $1 AND r.status IN ('hold','booking') AND ${reserveLiveSql('r', '$2')}
       AND ($3::uuid IS NULL OR r.booking_id IS DISTINCT FROM $3::uuid)
       AND ($4::uuid IS NULL OR r.status <> 'hold' OR r.hold_id <> $4::uuid)`,
    [clientId, at, exclude.bookingId ?? null, exclude.holdId ?? null],
  );
  return num(r.rows[0]?.s);
}

export interface LoyaltyBalanceDto {
  balanceCenti: number;
  availableCenti: number;
  reservedCenti: number;
  nextExpiry: { at: string; centi: number } | null;
  preBookingBlocked: boolean;
  accrualBasis: 'planned';
}

/** Баланс по журналу (0 – счёта ещё нет), доступно = max(0, баланс) − резервы, не меньше 0 (07 §12.1). */
export async function getBalance(db: Db, clientId: string, at: Date): Promise<LoyaltyBalanceDto> {
  const id = clientId.toLowerCase();
  const bal = num(
    (await db.query<{ balance: string }>(`SELECT balance FROM app.ledger_accounts WHERE kind = 'loyalty_client' AND owner_type = 'client' AND owner_id = $1`, [id])).rows[0]?.balance,
  );
  const reserved = await reservedCenti(db, id, at);
  const next = (
    await db.query<{ at: Date; centi: string }>(
      `SELECT expires_at AS at, sum(remaining_centi) AS centi FROM app.loyalty_batches
       WHERE client_id = $1 AND status = 'active' AND remaining_centi > 0 AND expires_at > $2
       GROUP BY expires_at ORDER BY expires_at LIMIT 1`,
      [id, at],
    )
  ).rows[0];
  return {
    balanceCenti: bal,
    availableCenti: Math.max(0, Math.max(0, bal) - reserved),
    reservedCenti: reserved,
    nextExpiry: next ? { at: next.at.toISOString(), centi: num(next.centi) } : null,
    preBookingBlocked: bal <= POINTS_MIN_BALANCE,
    accrualBasis: 'planned',
  };
}

// K3. Журнал операций со сторно (ADR 0004 §1, model-dannyh 0004).
// Касса филиала, баллы клиента, остаток сертификата, расчёт сотрудника – один механизм.
// Баланс пишет только триггер ledger_entries_20_apply_balance; код его не трогает (у yu_app нет права).
// Транзакцию модуль НЕ открывает: вызывающий передаёт tx своей команды. Ошибка внутри post/reverse
// оставляет транзакцию в состоянии «aborted» – вызывающий её откатывает.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { AppError, type HttpStatus } from './errors.ts';

export type Tx = Pick<pg.ClientBase, 'query'>;
export type Db = Tx;

// ---- коды ошибок журнала (реестр в своём файле, ADR 0002)

export const ledgerErrors = {
  BALANCE_BELOW_LIMIT: 409,
  LIMIT_OVERRIDE_NOT_ALLOWED: 403,
  ALREADY_REVERSED: 409,
  CANNOT_REVERSE_REVERSAL: 409,
  UNIT_MISMATCH: 422,
  ACCOUNT_CLOSED: 409,
  INVALID_AMOUNT: 422,
} as const satisfies Record<string, HttpStatus>;

type LedgerErrorCode = keyof typeof ledgerErrors;


function fail(code: LedgerErrorCode, message: string, details?: Record<string, unknown>): AppError {
  return new AppError(code, ledgerErrors[code], message, details);
}

// ---- типы K3

/** cash_branch – наличные филиала, cash_branch_noncash – безнал филиала (карта и перевод; K17 §2, миграция 0202). */
export type AccountKind = 'cash_branch' | 'cash_branch_noncash' | 'loyalty_client' | 'certificate' | 'staff_payroll';
export type Unit = 'RUB_KOP' | 'POINT_CENTI'; // копейки; сотые балла (2,5 балла = 250)

/** Целое минорных единиц. */
export type Minor = number;

export interface AccountRef {
  kind: AccountKind;
  ownerType: 'branch' | 'client' | 'certificate' | 'staff';
  ownerId: string;
}

export interface Account {
  id: string;
  kind: AccountKind;
  unit: Unit;
  branchId: string | null;
  ownerType: AccountRef['ownerType'];
  ownerId: string;
  balance: Minor;
  minBalance: Minor | null;
  status: 'active' | 'closed';
}

/** Тип записи. Реестр расширяется модулем-владельцем через правку этого файла (K3). */
export type EntryType =
  | 'cash.opening_balance' | 'cash.income' | 'cash.expense' | 'cash.transfer_out' | 'cash.transfer_in'
  | 'cash.withdrawal' | 'cash.correction' | 'cash.refund'
  | 'loyalty.accrual' | 'loyalty.penalty' | 'loyalty.spend_time' | 'loyalty.spend_goods'
  | 'loyalty.return' | 'loyalty.expire' | 'loyalty.manual'
  | 'certificate.issue' | 'certificate.redeem' | 'certificate.expire' | 'certificate.correction'
  | 'payroll.accrual' | 'payroll.penalty' | 'payroll.bonus' | 'payroll.payout' | 'payroll.correction'
  | 'reversal';

export type RefType =
  | 'booking' | 'visit' | 'no_show' | 'event' | 'repair' | 'certificate' | 'shift' | 'goods_order' | 'payment'
  | 'payroll_penalty' | 'payroll_bonus' | 'payroll_statement' | 'staff'; // Э3, K18 §6, §9

export interface EntryInput {
  account: AccountRef;
  amount: Minor; // со знаком: + приход на счёт, − расход со счёта
  type: Exclude<EntryType, 'reversal'>;
  basis?: string; // обязателен для cash.expense, *.correction, loyalty.manual
  branchId: string | null; // филиал ОПЕРАЦИИ
  ref?: { type: RefType; id: string };
  refs?: Record<string, string>;
  occurredAt: Date;
}

export interface PostingInput {
  entries: EntryInput[];
  idempotencyKey: string; // ключ намерения; у записи i → `${key}#${i}`
  author: { type: 'staff' | 'client' | 'system'; id: string | null };
  /** Явный режим «ниже предела»: только сотрудник, право проверил вызывающий модуль, причина обязательна. */
  allowBelowLimit?: { reason: string };
}

export interface PostedEntry {
  id: number;
  postingId: string;
  accountId: string;
  amount: Minor;
  balanceAfter: Minor;
  type: EntryType;
  reversalOf: number | null;
  occurredAt: Date;
  recordedAt: Date;
}

export interface PostingResult {
  postingId: string;
  entries: PostedEntry[];
  replayed: boolean;
}

// ---- строки базы

interface AccountRow {
  id: string;
  kind: AccountKind;
  unit: Unit;
  branch_id: string | null;
  owner_type: AccountRef['ownerType'];
  owner_id: string;
  balance: string;
  min_balance: string | null;
  status: 'active' | 'closed';
}

interface EntryRow {
  id: string;
  posting_id: string;
  account_id: string;
  amount: string;
  balance_after: string;
  entry_type: EntryType;
  reversal_of: string | null;
  occurred_at: Date;
  recorded_at: Date;
  idempotency_key: string | null;
}

const ACCOUNT_COLS = 'id, kind, unit, branch_id, owner_type, owner_id, balance, min_balance, status';
const ENTRY_COLS =
  'id, posting_id, account_id, amount, balance_after, entry_type, reversal_of, occurred_at, recorded_at, idempotency_key';

/** bigint из pg (строка) → безопасное целое number. */
function toMinor(v: string | number): Minor {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isSafeInteger(n)) throw new Error(`ledger: значение ${String(v)} вне Number.MAX_SAFE_INTEGER`);
  return n;
}

function toAccount(r: AccountRow): Account {
  return {
    id: r.id,
    kind: r.kind,
    unit: r.unit,
    branchId: r.branch_id,
    ownerType: r.owner_type,
    ownerId: r.owner_id,
    balance: toMinor(r.balance),
    minBalance: r.min_balance === null ? null : toMinor(r.min_balance),
    status: r.status,
  };
}

function toEntry(r: EntryRow): PostedEntry {
  return {
    id: toMinor(r.id),
    postingId: r.posting_id,
    accountId: r.account_id,
    amount: toMinor(r.amount),
    balanceAfter: toMinor(r.balance_after),
    type: r.entry_type,
    reversalOf: r.reversal_of === null ? null : toMinor(r.reversal_of),
    occurredAt: r.occurred_at,
    recordedAt: r.recorded_at,
  };
}

interface PgError {
  code?: string;
  constraint?: string;
  detail?: string;
}

/** Перевод ошибок триггеров и ограничений журнала в коды K3; прочее – как есть. */
function mapDbError(err: unknown): unknown {
  const e = err as PgError;
  if (e?.code === '23514') {
    if (e.constraint === 'ledger_balance_below_limit') {
      let details: Record<string, unknown> = {};
      try {
        details = JSON.parse(e.detail ?? '{}') as Record<string, unknown>;
      } catch {
        // детали – справочно
      }
      return fail('BALANCE_BELOW_LIMIT', 'Недостаточно средств на счёте', details);
    }
    if (e.constraint === 'ledger_account_closed') return fail('ACCOUNT_CLOSED', 'Счёт закрыт');
    if (e.constraint === 'ledger_reversal_of_reversal') return fail('CANNOT_REVERSE_REVERSAL', 'Сторно нельзя сторнировать');
  }
  if (e?.code === '23505') {
    if (e.constraint === 'ledger_entries_reversal_of_key') return fail('ALREADY_REVERSED', 'Запись уже сторнирована');
    if (e.constraint === 'ledger_entries_idempotency_key_key') {
      return new AppError('IDEMPOTENCY_KEY_REUSED', 409, 'Операция с этим ключом уже проведена', { reason: 'race' });
    }
  }
  return err;
}

const BASIS_REQUIRED = new Set<EntryType>(['cash.expense', 'loyalty.manual']);

function assertAmount(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount === 0) {
    throw fail('INVALID_AMOUNT', 'Сумма должна быть целым ненулевым числом минорных единиц', { amount });
  }
}

function assertNonEmpty(value: string | undefined, field: string): string {
  if (value === undefined || value.trim() === '') {
    throw new AppError('VALIDATION_FAILED', 400, `Нужно поле ${field}`, { field });
  }
  return value.trim();
}

// ---- счета

/** Найти или создать счёт (UNIQUE kind+owner). minBalance задаётся при создании. */
export async function ensureAccount(
  tx: Tx,
  ref: AccountRef,
  opts: { unit: Unit; branchId: string | null; minBalance: Minor | null },
): Promise<Account> {
  if (opts.minBalance !== null && !Number.isSafeInteger(opts.minBalance)) {
    throw fail('INVALID_AMOUNT', 'Граница счёта должна быть целым числом', { minBalance: opts.minBalance });
  }
  const select = async () =>
    (
      await tx.query<AccountRow>(
        `SELECT ${ACCOUNT_COLS} FROM app.ledger_accounts WHERE kind = $1 AND owner_type = $2 AND owner_id = $3`,
        [ref.kind, ref.ownerType, ref.ownerId],
      )
    ).rows[0];
  // Сначала чтение: у существующего счёта сверяем единицу до вставки (иначе CHECK вида/единицы даст сырой 23514).
  let row = await select();
  if (!row) {
    const inserted = await tx.query<AccountRow>(
      `INSERT INTO app.ledger_accounts (kind, unit, branch_id, owner_type, owner_id, min_balance)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (kind, owner_type, owner_id) DO NOTHING
       RETURNING ${ACCOUNT_COLS}`,
      [ref.kind, opts.unit, opts.branchId, ref.ownerType, ref.ownerId, opts.minBalance],
    );
    row = inserted.rows[0] ?? (await select());
  }
  if (!row) throw new Error('ensureAccount: счёт не создан и не найден');
  const account = toAccount(row);
  if (account.unit !== opts.unit) {
    throw fail('UNIT_MISMATCH', 'У счёта другая единица', { expected: opts.unit, actual: account.unit });
  }
  return account;
}

/** Заблокировать счета до проводки (FOR UPDATE в порядке id – против взаимоблокировок). */
export async function lockAccounts(tx: Tx, accountIds: string[]): Promise<Account[]> {
  const ids = [...new Set(accountIds)].sort();
  if (ids.length === 0) return [];
  const res = await tx.query<AccountRow>(
    `SELECT ${ACCOUNT_COLS} FROM app.ledger_accounts WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
    [ids],
  );
  if (res.rows.length !== ids.length) {
    const found = new Set(res.rows.map((r) => r.id));
    throw new AppError('NOT_FOUND', 404, 'Счёт не найден', { accountIds: ids.filter((id) => !found.has(id)) });
  }
  return res.rows.map(toAccount);
}

async function findAccountIds(tx: Tx, refs: AccountRef[]): Promise<string[]> {
  const res = await tx.query<{ id: string; kind: string; owner_type: string; owner_id: string }>(
    `SELECT a.id, a.kind, a.owner_type, a.owner_id FROM app.ledger_accounts a
     JOIN unnest($1::text[], $2::text[], $3::uuid[]) AS r(kind, owner_type, owner_id)
       ON a.kind = r.kind AND a.owner_type = r.owner_type AND a.owner_id = r.owner_id`,
    [refs.map((r) => r.kind), refs.map((r) => r.ownerType), refs.map((r) => r.ownerId)],
  );
  const byRef = new Map(res.rows.map((r) => [`${r.kind}|${r.owner_type}|${r.owner_id}`, r.id]));
  return refs.map((r) => {
    const id = byRef.get(`${r.kind}|${r.ownerType}|${r.ownerId.toLowerCase()}`);
    if (!id) throw new AppError('NOT_FOUND', 404, 'Счёт не найден', { account: r });
    return id;
  });
}

// ---- проводка

/** Уже проведённая операция с этим ключом: записи по posting_id записи `${key}#0`. */
async function findReplay(tx: Tx, key: string): Promise<PostedEntry[] | null> {
  const res = await tx.query<EntryRow>(
    `SELECT ${ENTRY_COLS} FROM journal.ledger_entries
     WHERE posting_id = (SELECT posting_id FROM journal.ledger_entries WHERE idempotency_key = $1)
     ORDER BY id`,
    [`${key}#0`],
  );
  return res.rows.length > 0 ? res.rows.map(toEntry) : null;
}

function sameEntries(stored: PostedEntry[], expected: { accountId: string; amount: Minor; type: EntryType }[]): boolean {
  return (
    stored.length === expected.length &&
    stored.every((s, i) => {
      const e = expected[i]!;
      return s.accountId === e.accountId && s.amount === e.amount && s.type === e.type;
    })
  );
}

async function insertEntry(
  tx: Tx,
  v: {
    postingId: string;
    accountId: string;
    amount: Minor;
    type: EntryType;
    basis: string | null;
    branchId: string | null;
    ref: { type: string; id: string } | null;
    refs: Record<string, string>;
    reversalOf: number | null;
    idempotencyKey: string;
    occurredAt: Date;
    author: PostingInput['author'];
    /** Причина режима «ниже предела»; null – режим не включён. */
    limitOverrideReason: string | null;
  },
): Promise<PostedEntry> {
  const res = await tx.query<EntryRow>(
    `INSERT INTO journal.ledger_entries
       (posting_id, account_id, amount, balance_after, entry_type, basis, branch_id, ref_type, ref_id, refs,
        reversal_of, idempotency_key, occurred_at, author_type, author_id, limit_override, limit_override_reason)
     VALUES ($1, $2, $3, 0, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, $15, $16)
     RETURNING ${ENTRY_COLS}`,
    [
      v.postingId, v.accountId, v.amount, v.type, v.basis, v.branchId, v.ref?.type ?? null, v.ref?.id ?? null,
      JSON.stringify(v.refs), v.reversalOf, v.idempotencyKey, v.occurredAt, v.author.type, v.author.id, v.limitOverrideReason !== null, v.limitOverrideReason,
    ],
  );
  return toEntry(res.rows[0]!);
}

/** Проводка: блокировка счетов → проверка повтора по ключу → вставка; баланс ставит триггер. */
export async function post(tx: Tx, input: PostingInput): Promise<PostingResult> {
  if (input.entries.length === 0) throw new AppError('VALIDATION_FAILED', 400, 'Проводка без записей');
  const key = assertNonEmpty(input.idempotencyKey, 'idempotencyKey');
  for (const e of input.entries) {
    assertAmount(e.amount);
    if (BASIS_REQUIRED.has(e.type) || e.type.endsWith('.correction')) assertNonEmpty(e.basis, 'basis');
  }
  let overrideReason: string | null = null;
  if (input.allowBelowLimit !== undefined) {
    const reason = input.allowBelowLimit.reason?.trim() ?? '';
    if (input.author.type !== 'staff' || reason === '') {
      throw fail('LIMIT_OVERRIDE_NOT_ALLOWED', 'Уход ниже границы – только сотрудником и с причиной');
    }
    overrideReason = reason;
  }

  try {
    const accountIds = await findAccountIds(tx, input.entries.map((e) => e.account));
    const accounts = new Map((await lockAccounts(tx, accountIds)).map((a) => [a.id, a]));
    const units = new Set([...accounts.values()].map((a) => a.unit));
    if (units.size > 1) throw fail('UNIT_MISMATCH', 'В одной проводке разные единицы', { units: [...units] });

    const expected = input.entries.map((e, i) => ({ accountId: accountIds[i]!, amount: e.amount, type: e.type }));
    const stored = await findReplay(tx, key);
    if (stored) {
      if (!sameEntries(stored, expected)) {
        throw new AppError('IDEMPOTENCY_KEY_REUSED', 409, 'Ключ уже использован для другой операции', { idempotencyKey: key });
      }
      return { postingId: stored[0]!.postingId, entries: stored, replayed: true };
    }

    const postingId = randomUUID();
    const entries: PostedEntry[] = [];
    for (const [i, e] of input.entries.entries()) {
      entries.push(
        await insertEntry(tx, {
          postingId,
          accountId: accountIds[i]!,
          amount: e.amount,
          type: e.type,
          basis: e.basis?.trim() || overrideReason,
          branchId: e.branchId,
          ref: e.ref ?? null,
          refs: e.refs ?? {},
          reversalOf: null,
          idempotencyKey: `${key}#${i}`,
          occurredAt: e.occurredAt,
          author: input.author,
          limitOverrideReason: overrideReason,
        }),
      );
    }
    return { postingId, entries, replayed: false };
  } catch (err) {
    throw mapDbError(err);
  }
}

/** Сторно одной записи: та же сумма с обратным знаком, тот же счёт, reversal_of = id. */
export async function reverse(
  tx: Tx,
  input: { entryId: number; reason: string; idempotencyKey: string; author: PostingInput['author']; occurredAt: Date },
): Promise<PostingResult> {
  const reason = assertNonEmpty(input.reason, 'reason');
  const key = assertNonEmpty(input.idempotencyKey, 'idempotencyKey');
  try {
    const origRes = await tx.query<EntryRow & { branch_id: string | null; ref_type: string | null; ref_id: string | null }>(
      `SELECT ${ENTRY_COLS}, branch_id, ref_type, ref_id FROM journal.ledger_entries WHERE id = $1`,
      [input.entryId],
    );
    const origRow = origRes.rows[0];
    if (!origRow) throw new AppError('NOT_FOUND', 404, 'Запись не найдена', { entryId: input.entryId });
    const orig = toEntry(origRow);
    if (orig.reversalOf !== null) throw fail('CANNOT_REVERSE_REVERSAL', 'Сторно нельзя сторнировать');
    await lockAccounts(tx, [orig.accountId]);

    const expected = [{ accountId: orig.accountId, amount: -orig.amount, type: 'reversal' as const }];
    const stored = await findReplay(tx, key);
    if (stored) {
      if (!sameEntries(stored, expected) || stored[0]!.reversalOf !== orig.id) {
        throw new AppError('IDEMPOTENCY_KEY_REUSED', 409, 'Ключ уже использован для другой операции', { idempotencyKey: key });
      }
      return { postingId: stored[0]!.postingId, entries: stored, replayed: true };
    }

    // Повторное сторно не проверяем заранее: его ловит UNIQUE(reversal_of) → ALREADY_REVERSED.
    const postingId = randomUUID();
    const entry = await insertEntry(tx, {
      postingId,
      accountId: orig.accountId,
      amount: -orig.amount,
      type: 'reversal',
      basis: reason,
      branchId: origRow.branch_id,
      ref: origRow.ref_type && origRow.ref_id ? { type: origRow.ref_type, id: origRow.ref_id } : null,
      refs: {},
      reversalOf: orig.id,
      idempotencyKey: `${key}#0`,
      occurredAt: input.occurredAt,
      author: input.author,
      limitOverrideReason: null,
    });
    return { postingId, entries: [entry], replayed: false };
  } catch (err) {
    throw mapDbError(err);
  }
}

/** Сторно всей проводки одной новой проводкой (K17 §4: 1 операция кассы = 1 проводка, у перевода между местами
 *  денег записей две). Каждая запись – та же сумма с обратным знаком на том же счёте, reversal_of = её id. */
export async function reversePosting(
  tx: Tx,
  input: { postingId: string; reason: string; idempotencyKey: string; author: PostingInput['author']; occurredAt: Date },
): Promise<PostingResult> {
  const reason = assertNonEmpty(input.reason, 'reason');
  const key = assertNonEmpty(input.idempotencyKey, 'idempotencyKey');
  try {
    const res = await tx.query<EntryRow & { branch_id: string | null; ref_type: string | null; ref_id: string | null }>(
      `SELECT ${ENTRY_COLS}, branch_id, ref_type, ref_id FROM journal.ledger_entries WHERE posting_id = $1 ORDER BY id`,
      [input.postingId],
    );
    if (res.rows.length === 0) throw new AppError('NOT_FOUND', 404, 'Проводка не найдена', { postingId: input.postingId });
    const orig = res.rows.map(toEntry);
    if (orig.some((e) => e.reversalOf !== null)) throw fail('CANNOT_REVERSE_REVERSAL', 'Сторно нельзя сторнировать');
    await lockAccounts(tx, orig.map((e) => e.accountId));

    const expected = orig.map((e) => ({ accountId: e.accountId, amount: -e.amount, type: 'reversal' as const }));
    const stored = await findReplay(tx, key);
    if (stored) {
      if (!sameEntries(stored, expected) || stored.some((s, i) => s.reversalOf !== orig[i]!.id)) {
        throw new AppError('IDEMPOTENCY_KEY_REUSED', 409, 'Ключ уже использован для другой операции', { idempotencyKey: key });
      }
      return { postingId: stored[0]!.postingId, entries: stored, replayed: true };
    }

    const postingId = randomUUID();
    const entries: PostedEntry[] = [];
    for (const [i, e] of orig.entries()) {
      const row = res.rows[i]!;
      entries.push(
        await insertEntry(tx, {
          postingId,
          accountId: e.accountId,
          amount: -e.amount,
          type: 'reversal',
          basis: reason,
          branchId: row.branch_id,
          ref: row.ref_type && row.ref_id ? { type: row.ref_type, id: row.ref_id } : null,
          refs: {},
          reversalOf: e.id,
          idempotencyKey: `${key}#${i}`,
          occurredAt: input.occurredAt,
          author: input.author,
          limitOverrideReason: null,
        }),
      );
    }
    return { postingId, entries, replayed: false };
  } catch (err) {
    throw mapDbError(err);
  }
}

// ---- чтение

export async function getBalance(db: Db, accountId: string): Promise<Minor> {
  const res = await db.query<{ balance: string }>('SELECT balance FROM app.ledger_accounts WHERE id = $1', [accountId]);
  const row = res.rows[0];
  if (!row) throw new AppError('NOT_FOUND', 404, 'Счёт не найден', { accountId });
  return toMinor(row.balance);
}

/** Сверка кэша с суммой записей (16 §14). */
export async function verifyBalance(db: Db, accountId: string): Promise<{ cached: Minor; computed: Minor; ok: boolean }> {
  const res = await db.query<{ cached: string; computed: string }>(
    `SELECT a.balance AS cached, COALESCE((SELECT sum(amount) FROM journal.ledger_entries WHERE account_id = a.id), 0) AS computed
     FROM app.ledger_accounts a WHERE a.id = $1`,
    [accountId],
  );
  const row = res.rows[0];
  if (!row) throw new AppError('NOT_FOUND', 404, 'Счёт не найден', { accountId });
  const cached = toMinor(row.cached);
  const computed = toMinor(row.computed);
  return { cached, computed, ok: cached === computed };
}

/** История счёта: порядок (occurred_at, id), курсорная пагинация. */
export async function listEntries(
  db: Db,
  accountId: string,
  page: { after?: { occurredAt: Date; id: number }; limit: number },
): Promise<PostedEntry[]> {
  if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > 500) {
    throw new AppError('VALIDATION_FAILED', 400, 'limit – целое от 1 до 500', { limit: page.limit });
  }
  const res = await db.query<EntryRow>(
    `SELECT ${ENTRY_COLS} FROM journal.ledger_entries
     WHERE account_id = $1 AND ($2::timestamptz IS NULL OR (occurred_at, id) > ($2::timestamptz, $3::bigint))
     ORDER BY occurred_at, id LIMIT $4`,
    [accountId, page.after?.occurredAt ?? null, page.after?.id ?? null, page.limit],
  );
  return res.rows.map(toEntry);
}

// ---- баллы

/** Баллы за минуты (07 §4.2): минуты ÷ 6, вниз до 0,5 балла (= 50 сотых). Только целые. */
export function pointsForMinutes(minutes: number): Minor {
  if (!Number.isSafeInteger(minutes) || minutes < 0) {
    throw new AppError('VALIDATION_FAILED', 400, 'Минуты – целое неотрицательное число', { minutes });
  }
  return Math.floor((minutes * 100) / 300) * 50;
}

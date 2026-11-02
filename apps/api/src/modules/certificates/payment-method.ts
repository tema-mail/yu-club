// S2-51. Способ оплаты certificate для K10 (K16 §3, §5, §6): проверка кода отдельной короткой транзакцией,
// погашение (exact / drain по флагу R-03), возврат погашения целиком. Денежного поступления нет (TC-08, 06 §12).
// Порядок в транзакции оплаты: lockAccounts(счёт сертификата) → строка сертификата FOR UPDATE → проверки по
// перечитанному → K3 certificate.redeem → certificate_redemptions → аудит. Так же упорядочены сгорание, отмена,
// корректировка (lifecycle.ts): сначала счёт, потом строка – взаимоблокировок нет.
// Регистрация – registerPaymentMethod(createCertificatePaymentMethod({ pepper })) при старте API (server.ts).
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';
import { writeAudit, type AuditRequestMeta } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { lockAccounts, post, reverse, type Tx } from '../../core/ledger.ts';
import { systemClock, type Clock } from '../../core/time.ts';
import type { ChargeInput, ChargeResult, PaymentMethodHandler, RefundInput, RefundResult } from '../finance/methods.ts';
import { CERT_SELECT, normalizeNumber, pinHashOf, type CertificateRow } from './sale.ts';

// Уточнение K10 §5 (предложение к контракту): строке погашения нужен платёж – certificate_redemptions.payment_id NOT NULL
// (model-dannyh 0204). finance передаёт paymentId созданного платежа и, по желанию, meta запроса для аудита.
declare module '../finance/methods.ts' {
  interface ChargeInput {
    paymentId?: string;
    meta?: AuditRequestMeta;
  }
  interface RefundInput {
    meta?: AuditRequestMeta;
  }
}

export const PIN_MAX_FAILURES = 5; // Q-105
export const PIN_LOCK_MS = 15 * 60_000; // Q-105

const notFound = () => new AppError('CERTIFICATE_NOT_FOUND', 404, 'Сертификат не найден или код неверен');
const locked = (until: Date, now: Date) =>
  new AppError('CERTIFICATE_PIN_LOCKED', 429, 'Слишком много неверных кодов: попробуйте позже', {
    retryAfterSec: Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 1000)),
  });

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

const metaOf = (author: { id: string }, meta?: AuditRequestMeta): AuditRequestMeta =>
  meta ?? { actor: { kind: 'staff', staffId: author.id, sessionId: '' }, source: 'crm', requestId: randomUUID() };

// ---- проверка кода (K16 §3): отдельная короткая транзакция, неудача фиксируется до ответа

/** Проверить номер и код в своей транзакции. Неверный код увеличивает pin_failed_count и фиксируется (откат основной
 *  команды его не съест); 5-й неверный – блок на 15 минут и CERTIFICATE_PIN_LOCKED. Нет номера и неверный код –
 *  одинаковый CERTIFICATE_NOT_FOUND. Успех обнуляет счётчик. Возвращает id сертификата – дальше только подсказка. */
export async function verifyCertificatePin(
  pool: Pick<pg.Pool, 'connect'>,
  input: { number: string; pin: string },
  opts: { pepper: string; clock?: Clock; meta?: AuditRequestMeta },
): Promise<{ certificateId: string }> {
  const now = (opts.clock ?? systemClock).now();
  const c = await pool.connect();
  let failure: AppError | null = null;
  let certificateId = '';
  try {
    await c.query('BEGIN');
    const r = await c.query<{ id: string; pin_hash: string; pin_failed_count: number; pin_locked_until: Date | null; sale_branch_id: string }>(
      `SELECT id, pin_hash, pin_failed_count, pin_locked_until, sale_branch_id FROM app.certificates WHERE number = $1 FOR UPDATE`,
      [normalizeNumber(input.number)],
    );
    const row = r.rows[0];
    if (!row) failure = notFound();
    else if (row.pin_locked_until && row.pin_locked_until > now) failure = locked(row.pin_locked_until, now);
    else if (!/^\d{4}$/.test(input.pin) || !sameHash(row.pin_hash, pinHashOf(opts.pepper, row.id, input.pin))) {
      const count = row.pin_failed_count + 1;
      if (count >= PIN_MAX_FAILURES) {
        const until = new Date(now.getTime() + PIN_LOCK_MS);
        await c.query(`UPDATE app.certificates SET pin_failed_count = 0, pin_locked_until = $2 WHERE id = $1`, [row.id, until]);
        await writeAudit(
          c,
          opts.meta ?? { actor: { kind: 'system', process: 'certificates' }, source: 'system', requestId: randomUUID() },
          { action: 'certificate.pin_locked', object: { type: 'certificate', id: row.id }, branchId: row.sale_branch_id, after: { lockedUntil: until.toISOString() } },
        );
        failure = locked(until, now);
      } else {
        await c.query(`UPDATE app.certificates SET pin_failed_count = $2 WHERE id = $1`, [row.id, count]);
        failure = notFound();
      }
    } else {
      if (row.pin_failed_count > 0 || row.pin_locked_until) {
        await c.query(`UPDATE app.certificates SET pin_failed_count = 0, pin_locked_until = NULL WHERE id = $1`, [row.id]);
      }
      certificateId = row.id;
    }
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    c.release();
  }
  if (failure) throw failure;
  return { certificateId };
}

// ---- блокировка и перечитывание

/** Счёт K3 сертификата по номеру – вызывающему, чтобы взять все счета оплаты одним lockAccounts (K17, решение 02.11). */
export async function certificateAccountId(tx: Tx, number: string): Promise<string | null> {
  const r = await tx.query<{ ledger_account_id: string }>(`SELECT ledger_account_id FROM app.certificates WHERE number = $1`, [normalizeNumber(number)]);
  return r.rows[0]?.ledger_account_id ?? null;
}

/** lockAccounts(счёт) → строка FOR UPDATE → перечитанные остаток и поля. null – сертификата нет. */
export async function lockCertificate(tx: Tx, where: { id: string } | { number: string }): Promise<CertificateRow | null> {
  const byId = 'id' in where;
  const key = byId ? where.id : normalizeNumber(where.number);
  if (byId && !/^[0-9a-f-]{36}$/i.test(key)) return null;
  const acc = await tx.query<{ ledger_account_id: string }>(`SELECT ledger_account_id FROM app.certificates WHERE ${byId ? 'id' : 'number'} = $1`, [key]);
  if (!acc.rows[0]) return null;
  await lockAccounts(tx, [acc.rows[0].ledger_account_id]);
  const r = await tx.query<CertificateRow>(`${CERT_SELECT} WHERE c.${byId ? 'id' : 'number'} = $1 FOR UPDATE OF c`, [key]);
  return r.rows[0] ?? null;
}

const isBelowLimit = (err: unknown) => err instanceof AppError && err.code === 'BALANCE_BELOW_LIMIT';

// ---- обработчик K10 §5

export function createCertificatePaymentMethod(cfg: { pepper: string }): PaymentMethodHandler {
  return {
    method: 'certificate',

    async charge(tx: Tx, input: ChargeInput): Promise<ChargeResult> {
      if (!input.certificate) throw new AppError('VALIDATION_FAILED', 400, 'Укажите номер и код сертификата', { field: 'certificate' });
      if (!input.paymentId) throw new Error('certificate.charge: finance не передал paymentId');
      if (!Number.isSafeInteger(input.amountKop) || input.amountKop <= 0) {
        throw new AppError('INVALID_AMOUNT', 422, 'Сумма – целое положительное число копеек', { amountKop: input.amountKop });
      }
      const now = input.occurredAt;
      // 0) блокировка → перечитать; экран и /check – только подсказка
      const row = await lockCertificate(tx, { number: input.certificate.number });
      // 1) номер + код
      if (!row || !sameHash(row.pin_hash, pinHashOf(cfg.pepper, row.id, input.certificate.pin))) throw notFound();
      if (row.pin_locked_until && row.pin_locked_until > now) throw locked(row.pin_locked_until, now);
      // 2) отменён или «требует проверки»
      if (row.cancelled_at || row.review_reason !== null) throw new AppError('CERTIFICATE_NOT_ACTIVE', 409, 'Сертификат недействителен', { status: row.cancelled_at ? 'cancelled' : 'needs_review' });
      // 3) срок – по времени, не по статусу (задача сгорания могла не пройти)
      if (now.getTime() >= row.expires_at.getTime()) throw new AppError('CERTIFICATE_EXPIRED', 409, 'Срок действия сертификата истёк', { expiresOn: row.expires_on });
      const balance = Number(row.balance);
      // 4) остаток
      if (balance <= 0) throw new AppError('CERTIFICATE_NOT_ACTIVE', 409, 'Остаток сертификата исчерпан', { status: 'used_up' });
      // 6) сумма ≤ остатка (exact) или весь остаток (drain, флаг R-03)
      let amount = input.amountKop;
      if (amount > balance) {
        if (input.mode !== 'drain') throw new AppError('CERTIFICATE_INSUFFICIENT', 409, 'Остатка сертификата не хватает', { balanceKop: balance });
        amount = balance;
      }
      let posting;
      try {
        posting = await post(tx, {
          entries: [
            {
              account: { kind: 'certificate', ownerType: 'certificate', ownerId: row.id },
              amount: -amount,
              type: 'certificate.redeem',
              branchId: input.session.branchId,
              ref: { type: 'booking', id: input.session.bookingId },
              refs: { paymentId: input.paymentId },
              occurredAt: now,
            },
          ],
          idempotencyKey: input.idempotencyKey,
          author: input.author,
        });
      } catch (err) {
        // 7) триггер K3 min 0 – последняя линия; код K3 наружу не отдаём
        if (isBelowLimit(err)) throw new AppError('CERTIFICATE_INSUFFICIENT', 409, 'Остатка сертификата не хватает', { balanceKop: balance });
        throw err;
      }
      const entry = posting.entries[0]!;
      if (!posting.replayed) {
        await tx.query(
          `INSERT INTO app.certificate_redemptions (certificate_id, booking_id, payment_id, branch_id, client_id, amount_kop, ledger_entry_id, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [row.id, input.session.bookingId, input.paymentId, input.session.branchId, input.session.clientId, -entry.amount, entry.id, input.author.id],
        );
        if (row.pin_failed_count > 0) await tx.query(`UPDATE app.certificates SET pin_failed_count = 0 WHERE id = $1`, [row.id]);
        await writeAudit(tx, metaOf(input.author, input.meta), {
          action: 'certificate.redeemed',
          object: { type: 'certificate', id: row.id },
          branchId: input.session.branchId,
          after: { bookingId: input.session.bookingId, paymentId: input.paymentId, amountKop: -entry.amount, balanceAfterKop: entry.balanceAfter },
        }, { now: () => now });
      }
      return { postingId: posting.postingId, amountKop: -entry.amount, certificateId: row.id };
    },

    async refund(tx: Tx, input: RefundInput): Promise<RefundResult> {
      const red = await tx.query<{ id: string; certificate_id: string; amount_kop: string; ledger_entry_id: string; status: string; return_entry_id: string | null; branch_id: string }>(
        `SELECT r.id, r.certificate_id, r.amount_kop, r.ledger_entry_id, r.status, r.return_entry_id, r.branch_id FROM app.certificate_redemptions r
         JOIN journal.ledger_entries le ON le.id = r.ledger_entry_id WHERE le.posting_id = $1`,
        [input.line.ledgerPostingId],
      );
      const r0 = red.rows[0];
      if (!r0) throw new AppError('NOT_FOUND', 404, 'Погашение не найдено', { postingId: input.line.ledgerPostingId });
      if (input.amountKop !== Number(r0.amount_kop)) {
        throw new AppError('VALIDATION_FAILED', 400, 'Погашение сертификата возвращается только целиком', { field: 'amountKop', amountKop: Number(r0.amount_kop) });
      }
      const row = (await lockCertificate(tx, { id: r0.certificate_id }))!;
      // перечитать строку погашения под блокировкой счёта
      const cur = (await tx.query<{ status: string; return_entry_id: string | null }>(`SELECT status, return_entry_id FROM app.certificate_redemptions WHERE id = $1`, [r0.id])).rows[0]!;
      if (cur.status === 'not_restored') return { postingId: null, outcome: 'not_restored' };
      const now = input.occurredAt;
      const restorable = cur.status === 'returned' || (row.cancelled_at === null && now.getTime() < row.expires_at.getTime());
      if (!restorable) {
        await tx.query(`UPDATE app.certificate_redemptions SET status = 'not_restored' WHERE id = $1`, [r0.id]);
        await writeAudit(tx, metaOf(input.author, input.meta), {
          action: 'certificate.redemption_returned',
          object: { type: 'certificate', id: row.id },
          branchId: r0.branch_id,
          after: { redemptionId: r0.id, outcome: 'not_restored', amountKop: input.amountKop },
          reason: input.reason,
        }, { now: () => now });
        return { postingId: null, outcome: 'not_restored' };
      }
      // повтор возврата с тем же ключом – reverse отдаёт прежнюю проводку
      const rev = await reverse(tx, { entryId: Number(r0.ledger_entry_id), reason: input.reason, idempotencyKey: input.idempotencyKey, author: input.author, occurredAt: now });
      if (cur.status === 'active') {
        await tx.query(`UPDATE app.certificate_redemptions SET status = 'returned', return_entry_id = $2 WHERE id = $1`, [r0.id, rev.entries[0]!.id]);
        await writeAudit(tx, metaOf(input.author, input.meta), {
          action: 'certificate.redemption_returned',
          object: { type: 'certificate', id: row.id },
          branchId: r0.branch_id,
          after: { redemptionId: r0.id, outcome: 'returned', amountKop: input.amountKop, balanceAfterKop: rev.entries[0]!.balanceAfter },
          reason: input.reason,
        }, { now: () => now });
      }
      return { postingId: rev.postingId, outcome: 'returned' };
    },
  };
}

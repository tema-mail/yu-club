// S2-52. Жизненный цикл сертификата (K16 §4, §6, §7): задача сгорания, отмена продажи, корректировка остатка,
// «требует проверки», получатель. Порядок в каждой команде – как у погашения: счета K3 одним lockAccounts
// (у отмены с возвратом денег – вместе с местами денег филиала продажи, K17 решение 02.11) → строка сертификата
// FOR UPDATE → проверки по перечитанному → K3 → строка → аудит. Транзакцию открывает вызывающий (кроме задачи).
import { randomUUID } from 'node:crypto';
import { writeAudit, type AuditRequestMeta } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { lockAccounts, post, reverse, type Tx } from '../../core/ledger.ts';
import { assertCan, type AccessContext } from '../../core/permissions.ts';
import { systemClock, type Clock } from '../../core/time.ts';
import { lockPlaces, postMoneyOperation } from '../finance/cashbox.ts';
import { getBranch } from '../network/index.ts';
import { verifyCertificatePin } from './payment-method.ts';
import { CERT_SELECT, getCertificateRow, toCertificateDto, type CertificateDto, type CertificateRow } from './sale.ts';

const notFound = () => new AppError('NOT_FOUND', 404, 'Не найдено');
const systemMeta = (): AuditRequestMeta => ({ actor: { kind: 'system', process: 'certificates:expire' }, source: 'system', requestId: randomUUID() });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireText(value: string | null | undefined, field: string): string {
  const s = value?.trim() ?? '';
  if (s === '') throw new AppError('COMMENT_REQUIRED', 422, 'Укажите причину', { field });
  return s;
}

/** Строка без блокировки – только для проверки права по филиалу продажи (вне зоны – 404 как несуществующий). */
async function guarded(tx: Tx, ctx: AccessContext, id: string, action: string): Promise<CertificateRow> {
  const row = await getCertificateRow(tx, id);
  if (!row) throw notFound();
  assertCan(ctx, action, { branchId: row.sale_branch_id });
  return row;
}

/** Перечитать под блокировкой (счета уже взяты вызывающим) и сверить rowVersion. */
async function relock(tx: Tx, id: string, rowVersion: number): Promise<CertificateRow> {
  const r = await tx.query<CertificateRow>(`${CERT_SELECT} WHERE c.id = $1 FOR UPDATE OF c`, [id]);
  const row = r.rows[0]!;
  if (row.row_version !== rowVersion) throw new AppError('VERSION_CONFLICT', 409, 'Карточка изменилась: обновите', { current: row.row_version });
  return row;
}

async function bump(tx: Tx, id: string, set: string | null, params: unknown[]): Promise<void> {
  await tx.query(`UPDATE app.certificates SET ${set ? `${set}, ` : ''}row_version = row_version + 1 WHERE id = $1`, [id, ...params]);
}

async function dto(tx: Tx, id: string, now: Date): Promise<CertificateDto> {
  return toCertificateDto((await getCertificateRow(tx, id))!, now);
}

// ---- сгорание (K16 §4, 08 §5.2, §12.3)

/** Один проход задачи certificates:expire: у каждого сертификата с expires_at ≤ now и остатком > 0 – своя транзакция:
 *  lockAccounts(счёт) → перечитать → certificate.expire −остаток (автор system, ключ certificate-expire:<id>).
 *  Касса не меняется: это не денежное поступление и не доход. Ошибка одной строки откатывает только её: она уходит
 *  в onRowError (лог), проход идёт дальше, строка повторится следующим проходом. Возвращает число сгоревших. */
export async function expireDueCertificates(
  pool: { connect(): Promise<{ query: Tx['query']; release(): void }> },
  clock: Clock = systemClock,
  limit = 200,
  onRowError: (err: unknown, certificateId: string) => void = (err, id) => console.error('certificates:expire', id, err),
): Promise<number> {
  const now = clock.now();
  const c = await pool.connect();
  let burned = 0;
  try {
    const due = await c.query<{ id: string; ledger_account_id: string }>(
      `SELECT c.id, c.ledger_account_id FROM app.certificates c JOIN app.ledger_accounts la ON la.id = c.ledger_account_id
       WHERE c.expires_at <= $1 AND c.expired_entry_id IS NULL AND c.cancelled_at IS NULL AND la.balance > 0
       ORDER BY c.expires_at LIMIT $2`,
      [now, limit],
    );
    for (const d of due.rows) {
      await c.query('BEGIN');
      try {
        await lockAccounts(c, [d.ledger_account_id]);
        const row = (await c.query<CertificateRow>(`${CERT_SELECT} WHERE c.id = $1 FOR UPDATE OF c`, [d.id])).rows[0]!;
        const balance = Number(row.balance);
        if (row.expired_entry_id !== null || row.cancelled_at !== null || row.expires_at > now || balance <= 0) {
          await c.query('COMMIT'); // погашение или отмена успели раньше – перечитанное главнее
          continue;
        }
        const p = await post(c, {
          entries: [
            { account: { kind: 'certificate', ownerType: 'certificate', ownerId: row.id }, amount: -balance, type: 'certificate.expire', branchId: row.sale_branch_id, ref: { type: 'certificate', id: row.id }, occurredAt: row.expires_at },
          ],
          idempotencyKey: `certificate-expire:${row.id}`,
          author: { type: 'system', id: null },
        });
        await c.query(`UPDATE app.certificates SET expired_entry_id = $2 WHERE id = $1`, [row.id, p.entries[0]!.id]);
        await writeAudit(c, systemMeta(), {
          action: 'certificate.expired',
          object: { type: 'certificate', id: row.id },
          branchId: row.sale_branch_id,
          after: { burnedKop: balance, expiresOn: row.expires_on },
        }, clock);
        await c.query('COMMIT');
        burned++;
      } catch (err) {
        await c.query('ROLLBACK');
        onRowError(err, d.id);
      }
    }
  } finally {
    c.release();
  }
  return burned;
}

/** Задача раз в 5 минут (K16 §4). Таймер unref – процесс держат соединения worker. */
export function startCertificateExpiry(opts: {
  pool: { connect(): Promise<{ query: Tx['query']; release(): void }> };
  clock?: Clock;
  intervalMs?: number;
  onError?: (err: unknown) => void;
}): { stop(): void } {
  const timer = setInterval(() => {
    const log = opts.onError ?? ((e: unknown) => console.error('certificates:expire', e));
    expireDueCertificates(opts.pool, opts.clock, 200, (err, id) => log(Object.assign(err instanceof Error ? err : new Error(String(err)), { certificateId: id }))).catch((err: unknown) => (opts.onError ?? ((e) => console.error('certificates:expire', e)))(err));
  }, opts.intervalMs ?? 5 * 60_000);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}

// ---- отмена продажи (K16 §6, 08 §9.1)

/** Право certificate.cancel. Только без погашений и до срока, иначе CERTIFICATE_USED / CERTIFICATE_EXPIRED.
 *  K3 reverse записи certificate.issue; refundMoney – возврат кассы K17 на место денег продажи со ссылкой на продажу. */
export async function cancelSale(
  tx: Tx,
  ctx: AccessContext,
  input: { certificateId: string; rowVersion: number; reason: string; refundMoney: boolean },
  meta: AuditRequestMeta,
  clock: Clock = systemClock,
): Promise<CertificateDto> {
  const now = clock.now();
  const reason = requireText(input.reason, 'reason');
  const first = await guarded(tx, ctx, input.certificateId, 'certificate.cancel');
  const branch = (await getBranch(tx, first.sale_branch_id))!;
  if (input.refundMoney) await lockPlaces(tx, branch.id, [first.ledger_account_id]);
  else await lockAccounts(tx, [first.ledger_account_id]);
  const row = await relock(tx, first.id, input.rowVersion);
  if (row.cancelled_at) throw new AppError('CERTIFICATE_NOT_ACTIVE', 409, 'Продажа уже отменена', { status: 'cancelled' });
  if (now.getTime() >= row.expires_at.getTime()) throw new AppError('CERTIFICATE_EXPIRED', 409, 'Срок действия сертификата истёк', { expiresOn: row.expires_on });
  const used = await tx.query(`SELECT 1 FROM app.certificate_redemptions WHERE certificate_id = $1 LIMIT 1`, [row.id]);
  if (used.rows.length > 0 || Number(row.balance) !== Number(row.nominal_kop)) {
    throw new AppError('CERTIFICATE_USED', 409, 'Сертификат использовался: отмена – корректировкой Владельца');
  }
  const issue = await tx.query<{ id: string }>(
    `SELECT id FROM journal.ledger_entries WHERE account_id = $1 AND entry_type = 'certificate.issue' AND reversal_of IS NULL ORDER BY id LIMIT 1`,
    [row.ledger_account_id],
  );
  const author = { type: 'staff' as const, id: ctx.actor.staffId };
  await reverse(tx, { entryId: Number(issue.rows[0]!.id), reason, idempotencyKey: `certificate-cancel:${row.id}`, author, occurredAt: now });
  let refundOperationId: string | null = null;
  if (input.refundMoney) {
    const op = await postMoneyOperation(
      tx,
      ctx,
      {
        branchId: branch.id,
        kind: 'refund',
        place: row.sale_method === 'cash' ? 'cash' : 'noncash',
        method: row.sale_method,
        amountKop: Number(row.nominal_kop),
        ref: { type: 'operation', id: row.sale_operation_id },
        comment: `Отмена продажи сертификата ${row.number}: ${reason}`,
        occurredAt: now,
      },
      { idempotencyKey: `certificate-cancel-refund:${row.id}` },
      meta,
      clock,
    );
    refundOperationId = op.id;
  }
  await bump(tx, row.id, 'cancelled_at = $2, cancel_reason = $3', [now, reason]);
  const after = await dto(tx, row.id, now);
  await writeAudit(tx, meta, {
    action: 'certificate.cancelled',
    object: { type: 'certificate', id: row.id },
    branchId: branch.id,
    cityId: branch.cityId,
    before: { status: toCertificateDto(row, now).status, balanceKop: Number(row.balance) },
    after: { ...after, refundOperationId },
    reason,
  }, clock);
  return after;
}

// ---- корректировка остатка (K16 §6, 08 §9.3)

/** Право certificate.correct (Владелец). Остаток после ≤ номинала (CORRECTION_EXCEEDS_NOMINAL) и ≥ 0. */
export async function correctBalance(
  tx: Tx,
  ctx: AccessContext,
  input: { certificateId: string; rowVersion: number; deltaKop: number; reason: string; ref?: string | null },
  meta: AuditRequestMeta,
  clock: Clock = systemClock,
): Promise<CertificateDto> {
  const now = clock.now();
  const reason = requireText(input.reason, 'reason');
  if (!Number.isSafeInteger(input.deltaKop) || input.deltaKop === 0) {
    throw new AppError('INVALID_AMOUNT', 422, 'Корректировка – целое ненулевое число копеек', { deltaKop: input.deltaKop });
  }
  const first = await guarded(tx, ctx, input.certificateId, 'certificate.correct');
  await lockAccounts(tx, [first.ledger_account_id]);
  const row = await relock(tx, first.id, input.rowVersion);
  if (row.cancelled_at) throw new AppError('CERTIFICATE_NOT_ACTIVE', 409, 'Продажа отменена', { status: 'cancelled' });
  // плюс после срока или сгорания не создаёт новый остаток: продления нет (08 §5.3, ревью 03.11)
  if (input.deltaKop > 0 && (row.expired_entry_id !== null || now.getTime() >= row.expires_at.getTime())) {
    throw new AppError('CERTIFICATE_EXPIRED', 409, 'Срок действия сертификата истёк: пополнение невозможно', { expiresOn: row.expires_on });
  }
  const balance = Number(row.balance);
  const after = balance + input.deltaKop;
  if (after > Number(row.nominal_kop)) {
    throw new AppError('CORRECTION_EXCEEDS_NOMINAL', 422, 'Остаток после корректировки больше номинала', { balanceKop: balance, nominalKop: Number(row.nominal_kop) });
  }
  if (after < 0) throw new AppError('CERTIFICATE_INSUFFICIENT', 409, 'Остаток не может стать отрицательным', { balanceKop: balance });
  const basis = input.ref?.trim() ? `${reason} (${input.ref.trim()})` : reason;
  await post(tx, {
    entries: [
      { account: { kind: 'certificate', ownerType: 'certificate', ownerId: row.id }, amount: input.deltaKop, type: 'certificate.correction', basis, branchId: row.sale_branch_id, ref: { type: 'certificate', id: row.id }, occurredAt: now },
    ],
    idempotencyKey: `certificate-correct:${row.id}:${row.row_version}`,
    author: { type: 'staff', id: ctx.actor.staffId },
  });
  await bump(tx, row.id, null, []);
  const res = await dto(tx, row.id, now);
  await writeAudit(tx, meta, {
    action: 'certificate.corrected',
    object: { type: 'certificate', id: row.id },
    branchId: row.sale_branch_id,
    before: { balanceKop: balance },
    after: { balanceKop: res.balanceKop, deltaKop: input.deltaKop, ref: input.ref ?? null },
    reason,
  }, clock);
  return res;
}

// ---- «требует проверки» (K16 §6, 08 §8)

/** Право certificate.review (Владелец, Директор): флаг с причиной; пока включён – погашение запрещено. */
export async function setReview(
  tx: Tx,
  ctx: AccessContext,
  input: { certificateId: string; rowVersion: number; on: boolean; reason: string },
  meta: AuditRequestMeta,
  clock: Clock = systemClock,
): Promise<CertificateDto> {
  const now = clock.now();
  const reason = requireText(input.reason, 'reason');
  const first = await guarded(tx, ctx, input.certificateId, 'certificate.review');
  await lockAccounts(tx, [first.ledger_account_id]);
  const row = await relock(tx, first.id, input.rowVersion);
  await bump(tx, row.id, 'review_reason = $2', [input.on ? reason : null]);
  const res = await dto(tx, row.id, now);
  await writeAudit(tx, meta, {
    action: 'certificate.review_changed',
    object: { type: 'certificate', id: row.id },
    branchId: row.sale_branch_id,
    before: { reviewReason: row.review_reason },
    after: { reviewReason: input.on ? reason : null, status: res.status },
    reason,
  }, clock);
  return res;
}

// ---- получатель (K16 §7, 08 §7)

/** Привязка или смена получателя: строка в journal.certificate_holder_history; именным сертификат не становится (Q-26).
 *  where – филиал, по которому проверено право (продажи или предъявления). rowVersion – только из карточки CRM. */
async function applyRecipient(
  tx: Tx,
  ctx: AccessContext,
  first: CertificateRow,
  input: { clientId: string | null; rowVersion: number | null; where: string },
  meta: AuditRequestMeta,
  now: Date,
  clock: Clock,
): Promise<CertificateDto> {
  if (input.clientId !== null) {
    const c = UUID_RE.test(input.clientId) ? await tx.query(`SELECT 1 FROM app.clients WHERE id = $1 AND status <> 'anonymized'`, [input.clientId]) : { rows: [] };
    if (c.rows.length === 0) throw new AppError('VALIDATION_FAILED', 400, 'Клиент не найден', { field: 'clientId' });
  }
  await lockAccounts(tx, [first.ledger_account_id]);
  const row = await relock(tx, first.id, input.rowVersion ?? first.row_version);
  if (row.recipient_client_id === input.clientId) return toCertificateDto(row, now);
  await bump(tx, row.id, 'recipient_client_id = $2', [input.clientId]);
  await tx.query(
    `INSERT INTO journal.certificate_holder_history (certificate_id, old_client_id, new_client_id, changed_by, changed_at) VALUES ($1, $2, $3, $4, $5)`,
    [row.id, row.recipient_client_id, input.clientId, ctx.actor.staffId, now],
  );
  const res = await dto(tx, row.id, now);
  await writeAudit(tx, meta, {
    action: 'certificate.recipient_changed',
    object: { type: 'certificate', id: row.id },
    branchId: input.where,
    before: { recipientClientId: row.recipient_client_id },
    after: { recipientClientId: input.clientId },
  }, clock);
  return res;
}

/** №35, карточка CRM: право certificate.link в зоне филиала продажи (вне зоны – 404), сверка rowVersion. */
export async function linkRecipient(
  tx: Tx,
  ctx: AccessContext,
  input: { certificateId: string; clientId: string | null; rowVersion: number },
  meta: AuditRequestMeta,
  clock: Clock = systemClock,
): Promise<CertificateDto> {
  const first = await getCertificateRow(tx, input.certificateId);
  if (!first) throw notFound();
  assertCan(ctx, 'certificate.link', { branchId: first.sale_branch_id });
  return applyRecipient(tx, ctx, first, { clientId: input.clientId, rowVersion: input.rowVersion, where: first.sale_branch_id }, meta, clock.now(), clock);
}

/** Сертификат предъявлен в филиале сотрудника (K16 §7, ревью 03.11): id чужого филиала сотрудник не знает –
 *  номер и код. Право certificate.link в филиале предъявления; код проверяется verifyCertificatePin отдельной
 *  транзакцией (неверный код увеличивает счётчик и не откатывается, блок 15 минут – как у оплаты). */
export async function linkRecipientByCode(
  tx: Tx,
  pool: Parameters<typeof verifyCertificatePin>[0],
  ctx: AccessContext,
  input: { branchId: string; number: string; pin: string; clientId: string | null },
  meta: AuditRequestMeta,
  opts: { pepper: string; clock?: Clock },
): Promise<CertificateDto> {
  const clock = opts.clock ?? systemClock;
  if (!UUID_RE.test(input.branchId)) throw notFound();
  assertCan(ctx, 'certificate.link', { branchId: input.branchId });
  const { certificateId } = await verifyCertificatePin(pool, { number: input.number, pin: input.pin }, { pepper: opts.pepper, clock, meta });
  const first = (await getCertificateRow(tx, certificateId))!;
  return applyRecipient(tx, ctx, first, { clientId: input.clientId, rowVersion: null, where: input.branchId }, meta, clock.now(), clock);
}

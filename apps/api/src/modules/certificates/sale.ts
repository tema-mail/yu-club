// S2-50. Сертификат: номер и код, срок 6 месяцев, остаток, продажа одной проводкой с поступлением в кассу (K16 §1–§4).
// Продажа – одна транзакция вызывающего: счёт сертификата K3 (min 0) → postMoneyOperation кассы K17 (доход источника
// certificate_sale на место денег филиала продажи + certificate.issue на счёт сертификата – одна проводка, все счета
// одним lockAccounts) → строка certificates → аудит certificate.sold. Код (pin) – только в ответе этой команды:
// в базе HMAC-SHA256(pin, CERT_PEPPER), в аудит, лог и idempotency_keys не попадает (redactSaleResponse).
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { writeAudit, type AuditRequestMeta, type Db } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { secretDigest } from '../../core/idempotency.ts';
import { ensureAccount, type Tx } from '../../core/ledger.ts';
import { assertCan, type AccessContext } from '../../core/permissions.ts';
import { resolveSettings } from '../../core/settings.ts';
import { addDays, instantToLocal, localToInstant, systemClock, type Clock, type LocalDate, type LocalTime, type TimeZone } from '../../core/time.ts';
import { postMoneyOperation } from '../finance/cashbox.ts';
import { getBranch } from '../network/index.ts';

// ---- типы K16 §1

export type CertificateStatus = 'active' | 'partially_used' | 'used_up' | 'expired' | 'cancelled' | 'needs_review';
export type SaleMethod = 'cash' | 'card' | 'transfer';

export interface CertificateDto {
  id: string;
  number: string;
  nominalKop: number;
  balanceKop: number;
  soldAt: string;
  saleBranchId: string;
  saleMethod: SaleMethod;
  soldBy: string;
  expiresOn: string;
  expiresAt: string;
  status: CertificateStatus;
  buyerClientId: string | null;
  recipientClientId: string | null;
  comment: string | null;
  rowVersion: number;
}

export interface CertificateRow {
  id: string;
  number: string;
  pin_hash: string;
  pin_failed_count: number;
  pin_locked_until: Date | null;
  nominal_kop: string;
  sale_branch_id: string;
  sale_method: SaleMethod;
  sale_operation_id: string;
  ledger_account_id: string;
  sold_at: Date;
  sold_by: string;
  expires_on: string;
  expires_at: Date;
  expired_entry_id: string | null;
  cancelled_at: Date | null;
  cancel_reason: string | null;
  review_reason: string | null;
  buyer_client_id: string | null;
  recipient_client_id: string | null;
  comment: string | null;
  row_version: number;
  balance: string;
}

/** Строка сертификата с остатком счёта K3. expires_on – текстом (date без сдвига зоны машины). */
export const CERT_SELECT = `SELECT c.id, c.number, c.pin_hash, c.pin_failed_count, c.pin_locked_until, c.nominal_kop, c.sale_branch_id,
    c.sale_method, c.sale_operation_id, c.ledger_account_id, c.sold_at, c.sold_by, c.expires_on::text AS expires_on, c.expires_at,
    c.expired_entry_id, c.cancelled_at, c.cancel_reason, c.review_reason, c.buyer_client_id, c.recipient_client_id, c.comment,
    c.row_version, la.balance
  FROM app.certificates c JOIN app.ledger_accounts la ON la.id = c.ledger_account_id`;

/** Статус вычисляется (08 §8) по порядку: cancelled → needs_review → expired → used_up → partially_used → active. */
export function statusOf(r: Pick<CertificateRow, 'cancelled_at' | 'review_reason' | 'expires_at' | 'nominal_kop' | 'balance'>, now: Date): CertificateStatus {
  if (r.cancelled_at !== null) return 'cancelled';
  if (r.review_reason !== null) return 'needs_review';
  if (now.getTime() >= r.expires_at.getTime()) return 'expired';
  const balance = Number(r.balance);
  if (balance <= 0) return 'used_up';
  if (balance < Number(r.nominal_kop)) return 'partially_used';
  return 'active';
}

export function toCertificateDto(r: CertificateRow, now: Date): CertificateDto {
  return {
    id: r.id,
    number: r.number,
    nominalKop: Number(r.nominal_kop),
    balanceKop: Number(r.balance),
    soldAt: r.sold_at.toISOString(),
    saleBranchId: r.sale_branch_id,
    saleMethod: r.sale_method,
    soldBy: r.sold_by,
    expiresOn: r.expires_on,
    expiresAt: r.expires_at.toISOString(),
    status: statusOf(r, now),
    buyerClientId: r.buyer_client_id,
    recipientClientId: r.recipient_client_id,
    comment: r.comment,
    rowVersion: r.row_version,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getCertificateRow(db: Db, id: string, opts: { forUpdate?: boolean } = {}): Promise<CertificateRow | null> {
  if (!UUID_RE.test(id)) return null;
  const r = await db.query<CertificateRow>(`${CERT_SELECT} WHERE c.id = $1${opts.forUpdate ? ' FOR UPDATE OF c' : ''}`, [id]);
  return r.rows[0] ?? null;
}

export async function getCertificate(db: Db, id: string, clock: Clock = systemClock): Promise<CertificateDto | null> {
  const r = await getCertificateRow(db, id);
  return r ? toCertificateDto(r, clock.now()) : null;
}

// ---- срок (K16 §4, Q-27)

/** Дата продажи по зоне филиала продажи + 6 календарных месяцев; дня нет в месяце → последний день месяца.
 *  Действует до конца этой даты: expiresAt – 00:00 следующих суток по той же зоне. */
export function expiryOf(soldAt: Date, saleBranchTz: TimeZone): { expiresOn: LocalDate; expiresAt: Date } {
  const sold = instantToLocal(soldAt, saleBranchTz).date;
  const [y, m, d] = sold.split('-').map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + 6;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const expiresOn = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(Math.min(d, lastDay)).padStart(2, '0')}` as LocalDate;
  return { expiresOn, expiresAt: localToInstant(addDays(expiresOn, 1), '00:00' as LocalTime, saleBranchTz) };
}

// ---- номер и код (K16 §3)

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 'YC-' + 8 символов Crockford Base32 из криптографического генератора (40 бит), вид YC-7K2M-9QXD. */
export function generateNumber(): string {
  const bytes = randomBytes(5);
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  let s = '';
  for (let i = 7; i >= 0; i--) s += CROCKFORD[Number((bits >> BigInt(i * 5)) & 31n)];
  return `YC-${s.slice(0, 4)}-${s.slice(4)}`;
}

/** 4 цифры из криптографического генератора (Q-105). */
export function generatePin(): string {
  return String(randomInt(0, 10_000)).padStart(4, '0');
}

/** Хэш кода для базы и request_hash: HMAC-SHA256(pin, CERT_PEPPER) (K16 §3). */
export const pinDigest = (pepper: string, pin: string): string => secretDigest(pepper, pin);

/** Нормализация ввода номера: регистр, пробелы, похожие символы Crockford (O→0, I/L→1). */
export function normalizeNumber(raw: string): string {
  const s = raw.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  const body = s.startsWith('YC') ? s.slice(2) : s;
  return body.length === 8 ? `YC-${body.slice(0, 4)}-${body.slice(4)}` : raw.trim().toUpperCase();
}

/** Ответ продажи для idempotency_keys: без кода, «код показан один раз» (K16 §3, S2-08). */
export function redactSaleResponse(body: unknown): unknown {
  const b = body as { certificate: CertificateDto; pin: string | null };
  return { certificate: b.certificate, pin: null, pinShownOnce: true };
}

// ---- продажа (K16 §2)

export interface SaleInput {
  branchId: string;
  nominalKop: number;
  method: SaleMethod;
  buyerClientId?: string | null;
  recipientClientId?: string | null;
  comment?: string | null;
}

export interface SaleOpts {
  /** CERT_PEPPER (config.ts). */
  pepper: string;
  clock?: Clock;
}

function invalid(message: string, field: string): AppError {
  return new AppError('VALIDATION_FAILED', 400, message, { field });
}

async function assertClient(tx: Tx, id: string | null | undefined, field: string): Promise<string | null> {
  if (id === undefined || id === null) return null;
  if (!UUID_RE.test(id)) throw invalid('Клиент не найден', field);
  const r = await tx.query(`SELECT 1 FROM app.clients WHERE id = $1 AND status <> 'anonymized'`, [id]);
  if (r.rows.length === 0) throw invalid('Клиент не найден', field);
  return id;
}

/** Право certificate.sell в филиале продажи (вне зоны – 404). Только за деньги: способы – cash | card | transfer. */
export async function sellCertificate(
  tx: Tx,
  ctx: AccessContext,
  input: SaleInput,
  meta: AuditRequestMeta,
  opts: SaleOpts,
): Promise<{ certificate: CertificateDto; pin: string }> {
  const clock = opts.clock ?? systemClock;
  const now = clock.now();
  if (!UUID_RE.test(input.branchId)) throw new AppError('NOT_FOUND', 404, 'Не найдено');
  assertCan(ctx, 'certificate.sell', { branchId: input.branchId });
  const branch = await getBranch(tx, input.branchId);
  if (!branch) throw new AppError('NOT_FOUND', 404, 'Не найдено');

  const s = await resolveSettings(tx, ['certificate.sale_methods', 'certificate.nominal_min_kop', 'certificate.nominal_max_kop'], { branchId: branch.id }, now);
  const nominal = input.nominalKop;
  const min = s['certificate.nominal_min_kop'].value;
  const max = s['certificate.nominal_max_kop'].value;
  if (!Number.isSafeInteger(nominal) || nominal <= 0 || (min !== null && nominal < min) || (max !== null && nominal > max)) {
    throw new AppError('NOMINAL_OUT_OF_RANGE', 422, 'Номинал вне допустимых пределов', { nominalKop: nominal, minKop: min, maxKop: max });
  }
  if (!s['certificate.sale_methods'].value.includes(input.method)) throw invalid('Способ продажи не разрешён настройкой', 'method');
  const buyer = await assertClient(tx, input.buyerClientId, 'buyerClientId');
  const recipient = await assertClient(tx, input.recipientClientId, 'recipientClientId');
  const comment = input.comment?.trim() || null;

  const id = randomUUID();
  const pin = generatePin();
  const { expiresOn, expiresAt } = expiryOf(now, branch.timezone);
  const account = await ensureAccount(tx, { kind: 'certificate', ownerType: 'certificate', ownerId: id }, { unit: 'RUB_KOP', branchId: branch.id, minBalance: 0 });

  const operation = await postMoneyOperation(
    tx,
    ctx,
    {
      branchId: branch.id,
      kind: 'income',
      place: input.method === 'cash' ? 'cash' : 'noncash',
      method: input.method,
      amountKop: nominal,
      source: 'certificate_sale',
      ref: { type: 'certificate', id },
      occurredAt: now,
    },
    {
      idempotencyKey: `certificate-sale:${id}`,
      linkedEntries: [
        {
          account: { kind: 'certificate', ownerType: 'certificate', ownerId: id },
          amount: nominal,
          type: 'certificate.issue',
          branchId: branch.id,
          ref: { type: 'certificate', id },
          occurredAt: now,
        },
      ],
    },
    meta,
    clock,
  );

  // Номер: 40 бит, совпадение маловероятно; при совпадении – новая попытка в точке сохранения (транзакция цела).
  for (let attempt = 0; ; attempt++) {
    await tx.query('SAVEPOINT certificate_number');
    try {
      await tx.query(
        `INSERT INTO app.certificates (id, number, pin_hash, nominal_kop, sale_branch_id, sale_method, sale_operation_id, ledger_account_id,
           sold_at, sold_by, expires_on, expires_at, buyer_client_id, recipient_client_id, comment)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [id, generateNumber(), pinDigest(opts.pepper, pin), nominal, branch.id, input.method, operation.id, account.id, now, ctx.actor.staffId, expiresOn, expiresAt, buyer, recipient, comment],
      );
      await tx.query('RELEASE SAVEPOINT certificate_number');
      break;
    } catch (err) {
      await tx.query('ROLLBACK TO SAVEPOINT certificate_number');
      const e = err as { code?: string; constraint?: string };
      if (e.code !== '23505' || e.constraint !== 'certificates_number_key' || attempt >= 4) throw err;
    }
  }

  const certificate = toCertificateDto((await getCertificateRow(tx, id))!, now);
  await writeAudit(
    tx,
    meta,
    { action: 'certificate.sold', object: { type: 'certificate', id }, branchId: branch.id, cityId: branch.cityId, after: { ...certificate, saleOperationId: operation.id } },
    clock,
  );
  return { certificate, pin };
}

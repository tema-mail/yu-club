// Мок сертификатов CRM строго по apps/api/src/modules/certificates/routes.crm.ts, sale.ts, lifecycle.ts (K16 §11):
// №29 список (зона по филиалу продажи, статус, «истекающие» 7/30/60, поиск по номеру и телефону), №30 карточка
// (погашения, смены получателя, движение остатка), №31 продажа (код – только в первом ответе; повтор по ключу –
// pin: null, pinShownOnce), №32 отмена продажи (без погашений и до срока, возврат денег – refund кассы),
// №33 корректировка остатка (Владелец). Деньги продажи и возврата – через recordMoney мока кассы (K17).
// Настройки номинала и способов – системные значения (null / все способы). Подключается из mock-api.ts.
// S2-63: №36 проверка номера и кода (payment-method.ts verifyCertificatePin: 5-й неверный код – блок 15 минут,
// CERTIFICATE_PIN_LOCKED с retryAfterSec; нет номера и неверный код – один CERTIFICATE_NOT_FOUND) и обработчик способа
// certificate для mock-payments.ts (certificatePayments: verify, charge exact/drain, refund целиком).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomInt, randomUUID } from 'node:crypto';
import { recordMoney } from './mock-finance.ts';

type Rec = Record<string, unknown>;
interface Staffish { id: string; role: string }
interface Zone { network: boolean; cityIds: string[]; branchIds: string[] }
interface BranchLite { id: string; name: string; timezone: string }
interface ClientLite { id: string; phoneE164: string | null }

export interface CertificatesMockDeps {
  current: (req: FastifyRequest) => Staffish;
  zone: (s: Staffish) => Zone;
  can: (s: Staffish, action: string) => boolean;
  branches: () => BranchLite[];
  clients: () => ClientLite[];
}

type Method = 'cash' | 'card' | 'transfer';
interface Cert {
  id: string; number: string; pin: string; nominalKop: number; balanceKop: number; soldAt: number; saleBranchId: string; saleMethod: Method;
  saleOperationId: string; soldBy: string; expiresOn: string; expiresAt: number; cancelledAt: number | null; cancelReason: string | null;
  reviewReason: string | null; buyerClientId: string | null; recipientClientId: string | null; comment: string | null; rowVersion: number;
  redemptions: Array<{ id: string; bookingId: string; paymentId: string; branchId: string; branchName: string; clientId: string | null; amountKop: number; status: string; at: string }>;
  history: Array<{ oldClientId: string | null; newClientId: string | null; changedBy: string; at: string }>;
  timeline: Array<{ type: string; amountKop: number; balanceAfterKop: number; at: string; branchId: string; basis: string | null }>;
}

class Fail extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Rec;
  constructor(status: number, code: string, message: string, details?: Rec) {
    super(message);
    this.status = status;
    this.code = code;
    if (details) this.details = details;
  }
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => new Fail(404, 'NOT_FOUND', 'Не найдено');
const zodFail = (path: string) => new Fail(400, 'VALIDATION_FAILED', 'Неверные данные запроса', { issues: [{ path, message: 'Invalid input' }] });

// ---- срок (sale.ts expiryOf): дата продажи по зоне + 6 месяцев, до конца этой даты

const localDate = (at: number, tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(at));
function midnight(date: string, tz: string): number {
  const guess = Date.parse(`${date}T00:00:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(guess));
  const p = (t: string) => parts.find((x) => x.type === t)!.value;
  return guess - (Date.parse(`${p('year')}-${p('month')}-${p('day')}T${p('hour')}:${p('minute')}:00Z`) - guess);
}
function expiryOf(soldAt: number, tz: string): { expiresOn: string; expiresAt: number } {
  const [y, m, d] = localDate(soldAt, tz).split('-').map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + 6;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const expiresOn = `${year}-${String(month).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
  const next = new Date(Date.parse(`${expiresOn}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return { expiresOn, expiresAt: midnight(next, tz) };
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const genNumber = () => {
  let s = '';
  for (let i = 0; i < 8; i++) s += CROCKFORD[randomInt(0, 32)];
  return `YC-${s.slice(0, 4)}-${s.slice(4)}`;
};

function statusOf(c: Cert, now: number): string {
  if (c.cancelledAt !== null) return 'cancelled';
  if (c.reviewReason !== null) return 'needs_review';
  if (now >= c.expiresAt) return 'expired';
  if (c.balanceKop <= 0) return 'used_up';
  if (c.balanceKop < c.nominalKop) return 'partially_used';
  return 'active';
}
const dto = (c: Cert, now = Date.now()) => ({
  id: c.id, number: c.number, nominalKop: c.nominalKop, balanceKop: c.balanceKop, soldAt: new Date(c.soldAt).toISOString(), saleBranchId: c.saleBranchId,
  saleMethod: c.saleMethod, soldBy: c.soldBy, expiresOn: c.expiresOn, expiresAt: new Date(c.expiresAt).toISOString(), status: statusOf(c, now),
  buyerClientId: c.buyerClientId, recipientClientId: c.recipientClientId, comment: c.comment, rowVersion: c.rowVersion,
});

// ---- состояние

let certs: Cert[] = [];
let pins = new Map<string, { failed: number; lockedUntil: number | null }>(); // pin_failed_count, pin_locked_until
const PIN_MAX_FAILURES = 5; // Q-105
const PIN_LOCK_MS = 15 * 60_000;
const replays = new Map<string, { hash: string; status: number; body: unknown }>();

export function resetCertificates(branches: BranchLite[]): void {
  certs = [];
  pins = new Map();
  replays.clear();
  const DAY = 86_400_000;
  const mk = (branchId: string, number: string, nominalKop: number, soldAt: number, soldBy: string, method: Method, extra: Partial<Cert> = {}): Cert => {
    const b = branches.find((x) => x.id === branchId)!;
    const { expiresOn, expiresAt } = expiryOf(soldAt, b.timezone);
    const c: Cert = {
      id: randomUUID(), number, pin: String(randomInt(0, 10_000)).padStart(4, '0'), nominalKop, balanceKop: nominalKop, soldAt, saleBranchId: branchId, saleMethod: method,
      saleOperationId: randomUUID(), soldBy, expiresOn, expiresAt, cancelledAt: null, cancelReason: null, reviewReason: null, buyerClientId: null, recipientClientId: null,
      comment: null, rowVersion: 1, redemptions: [], history: [],
      timeline: [{ type: 'sale', amountKop: nominalKop, balanceAfterKop: nominalKop, at: new Date(soldAt).toISOString(), branchId, basis: null }],
      ...extra,
    };
    certs.push(c);
    return c;
  };
  const now = Date.now();
  // Истекает через 5 дней: продан 6 месяцев назад без 5 дней.
  const soonSold = (() => {
    const d = new Date(now);
    d.setUTCMonth(d.getUTCMonth() - 6);
    return d.getTime() + 5 * DAY;
  })();
  mk('b-nsk-krasny', 'YC-7K2M-9QXD', 300_000, soonSold, 's-director', 'cash', { comment: 'Подарок на день рождения' });
  const part = mk('b-nsk-krasny', 'YC-4H8P-2RTW', 500_000, now - 40 * DAY, 's-owner', 'card');
  part.redemptions.push({ id: randomUUID(), bookingId: randomUUID(), paymentId: randomUUID(), branchId: 'b-nsk-krasny', branchName: 'Ю Клуб на Красном', clientId: null, amountKop: 150_000, status: 'active', at: new Date(now - 10 * DAY).toISOString() });
  part.balanceKop = 350_000;
  part.timeline.push({ type: 'redeem', amountKop: -150_000, balanceAfterKop: 350_000, at: new Date(now - 10 * DAY).toISOString(), branchId: 'b-nsk-krasny', basis: null });
  const canc = mk('b-nsk-krasny', 'YC-9ZQ1-MN3B', 200_000, now - 100 * DAY, 's-director', 'cash', { cancelledAt: now - 99 * DAY, cancelReason: 'Покупатель передумал' });
  canc.balanceKop = 0;
  canc.timeline.push({ type: 'cancel', amountKop: -200_000, balanceAfterKop: 0, at: new Date(now - 99 * DAY).toISOString(), branchId: 'b-nsk-krasny', basis: 'Покупатель передумал' });
  const exp = mk('b-nsk-krasny', 'YC-2B6C-8DFG', 100_000, now - 220 * DAY, 's-owner', 'transfer');
  exp.balanceKop = 0;
  exp.timeline.push({ type: 'expire', amountKop: -100_000, balanceAfterKop: 0, at: new Date(exp.expiresAt).toISOString(), branchId: 'b-nsk-krasny', basis: null });
  mk('b-tsk-lenina', 'YC-5T7V-1XYZ', 100_000, now - 10 * DAY, 's-admin-tsk', 'cash');
}

// ---- код и погашение (payment-method.ts): для №36 и для оплаты сеанса (mock-payments.ts)

const certNotFound = () => new Fail(404, 'CERTIFICATE_NOT_FOUND', 'Сертификат не найден или код неверен');
const pinLocked = (until: number, now: number) =>
  new Fail(429, 'CERTIFICATE_PIN_LOCKED', 'Слишком много неверных кодов: попробуйте позже', { retryAfterSec: Math.max(1, Math.ceil((until - now) / 1000)) });

export const certificatePayments = {
  /** Остаток под «блокировкой» (lockCertificate → перечитать): drain знает, сколько спишется. */
  balanceOf: (certificateId: string) => certs.find((x) => x.id === certificateId)?.balanceKop ?? 0,
  /** verifyCertificatePin: неудача считается и остаётся, даже если команда дальше откатится. */
  verify(number: string, pin: string, now = Date.now()): string {
    const c = certs.find((x) => x.number === number.trim().toUpperCase());
    if (!c) throw certNotFound();
    const st = pins.get(c.id) ?? { failed: 0, lockedUntil: null };
    if (st.lockedUntil !== null && st.lockedUntil > now) throw pinLocked(st.lockedUntil, now);
    if (!/^\d{4}$/.test(pin) || pin !== c.pin) {
      const failed = st.failed + 1;
      if (failed >= PIN_MAX_FAILURES) {
        pins.set(c.id, { failed: 0, lockedUntil: now + PIN_LOCK_MS });
        throw pinLocked(now + PIN_LOCK_MS, now);
      }
      pins.set(c.id, { failed, lockedUntil: st.lockedUntil });
      throw certNotFound();
    }
    pins.delete(c.id);
    return c.id;
  },
  /** charge: отменён/проверка – NOT_ACTIVE, срок – EXPIRED, 0 – used_up, не хватает – INSUFFICIENT (drain – весь остаток). */
  charge(certificateId: string, amountKop: number, mode: 'exact' | 'drain', at: { bookingId: string; paymentId: string; branchId: string; branchName: string; clientId: string }) {
    const c = certs.find((x) => x.id === certificateId);
    if (!c) throw certNotFound();
    const now = Date.now();
    if (c.cancelledAt !== null || c.reviewReason !== null) throw new Fail(409, 'CERTIFICATE_NOT_ACTIVE', 'Сертификат недействителен', { status: c.cancelledAt !== null ? 'cancelled' : 'needs_review' });
    if (now >= c.expiresAt) throw new Fail(409, 'CERTIFICATE_EXPIRED', 'Срок действия сертификата истёк', { expiresOn: c.expiresOn });
    if (c.balanceKop <= 0) throw new Fail(409, 'CERTIFICATE_NOT_ACTIVE', 'Остаток сертификата исчерпан', { status: 'used_up' });
    let amount = amountKop;
    if (amount > c.balanceKop) {
      if (mode !== 'drain') throw new Fail(409, 'CERTIFICATE_INSUFFICIENT', 'Остатка сертификата не хватает', { balanceKop: c.balanceKop });
      amount = c.balanceKop;
    }
    const redemptionId = randomUUID();
    c.balanceKop -= amount;
    c.redemptions.push({ id: redemptionId, bookingId: at.bookingId, paymentId: at.paymentId, branchId: at.branchId, branchName: at.branchName, clientId: at.clientId, amountKop: amount, status: 'active', at: new Date(now).toISOString() });
    c.timeline.push({ type: 'redeem', amountKop: -amount, balanceAfterKop: c.balanceKop, at: new Date(now).toISOString(), branchId: at.branchId, basis: null });
    return { amountKop: amount, certificateId: c.id, redemptionId };
  },
  /** refund: только целиком; после срока или отмены – not_restored, остаток не меняется. */
  refund(redemptionId: string): 'returned' | 'not_restored' {
    const c = certs.find((x) => x.redemptions.some((r) => r.id === redemptionId))!;
    const r = c.redemptions.find((x) => x.id === redemptionId)!;
    if (r.status !== 'active') return r.status === 'returned' ? 'returned' : 'not_restored';
    const now = Date.now();
    if (c.cancelledAt !== null || now >= c.expiresAt) {
      r.status = 'not_restored';
      return 'not_restored';
    }
    r.status = 'returned';
    c.balanceKop += r.amountKop;
    c.timeline.push({ type: 'return', amountKop: r.amountKop, balanceAfterKop: c.balanceKop, at: new Date(now).toISOString(), branchId: r.branchId, basis: null });
    return 'returned';
  },
};

// ---- маршруты

export function registerCertificates(app: FastifyInstance, P: string, deps: CertificatesMockDeps): void {
  const inZone = (s: Staffish, branchId: string) => {
    const z = deps.zone(s);
    return z.network || z.branchIds.includes(branchId);
  };
  /** assertCan по филиалу: вне зоны – 404, без права – 403. */
  const assertCan = (s: Staffish, action: string, branchId: string) => {
    if (!inZone(s, branchId)) throw notFound();
    if (!deps.can(s, action)) throw new Fail(403, 'FORBIDDEN', 'Недостаточно прав', { action });
  };
  const send = (reply: FastifyReply, e: unknown) => {
    const f = e as { status?: number; code?: string; message?: string; details?: Rec };
    if (typeof f.status !== 'number' || typeof f.code !== 'string') throw e;
    return reply.code(f.status).send({ error: { code: f.code, message: f.message, ...(f.details ? { details: f.details } : {}), requestId: randomUUID() } });
  };

  // №29 список
  app.get(`${P}/certificates`, async (req, reply) => {
    try {
      const s = deps.current(req);
      const q = req.query as Record<string, string | undefined>;
      const needle = q.q?.trim();
      if (q.q !== undefined && (!needle || needle.length > 100)) throw zodFail('q');
      if (q.status !== undefined && !['active', 'partially_used', 'used_up', 'expired', 'cancelled', 'needs_review'].includes(q.status)) throw zodFail('status');
      if (q.expiring !== undefined && !['7', '30', '60'].includes(q.expiring)) throw zodFail('expiring');
      if (q.cursor !== undefined && !/^\d{1,16}:[0-9a-f-]{36}$/i.test(q.cursor)) throw zodFail('cursor');
      const limit = q.limit === undefined ? 50 : Number(q.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw zodFail('limit');
      const now = Date.now();
      const digits = needle?.replace(/\D/g, '') ?? '';
      const phoneOf = (id: string | null) => (id ? (deps.clients().find((c) => c.id === id)?.phoneE164 ?? '') : '');
      const [cms, cid] = q.cursor ? [Number(q.cursor.split(':')[0]), q.cursor.slice(q.cursor.indexOf(':') + 1)] : [null, null];
      const all = certs
        .filter((c) => deps.can(s, 'certificate.view') && inZone(s, c.saleBranchId))
        .filter((c) => !q.branchId || c.saleBranchId === q.branchId)
        .filter((c) => !q.status || statusOf(c, now) === q.status)
        .filter((c) => !q.expiring || (c.expiresAt > now && c.expiresAt <= now + Number(q.expiring) * 86_400_000 && c.cancelledAt === null && c.balanceKop > 0))
        .filter((c) => !needle || c.number.includes(needle.toUpperCase()) || (digits.length >= 4 && [c.buyerClientId, c.recipientClientId].some((id) => phoneOf(id).endsWith(digits))))
        .sort((a, b) => b.soldAt - a.soldAt || b.id.localeCompare(a.id))
        .filter((c) => cms === null || c.soldAt < cms || (c.soldAt === cms && c.id < cid!));
      const items = all.slice(0, limit);
      const last = items.at(-1);
      return { items: items.map((c) => dto(c, now)), nextCursor: all.length > limit && last ? `${last.soldAt}:${last.id}` : null };
    } catch (e) {
      return send(reply, e);
    }
  });

  // №30 карточка
  app.get(`${P}/certificates/:id`, async (req, reply) => {
    try {
      const s = deps.current(req);
      const c = certs.find((x) => x.id === (req.params as { id: string }).id);
      if (!c) throw notFound();
      assertCan(s, 'certificate.view', c.saleBranchId);
      return { ...dto(c), cancelReason: c.cancelReason, reviewReason: c.reviewReason, redemptions: c.redemptions, history: c.history, timeline: c.timeline };
    } catch (e) {
      return send(reply, e);
    }
  });

  /** command(): ключ, повтор по хэшу (ответ продажи сохраняется без кода), откат состояния при отказе. */
  function command(op: string, run: (s: Staffish, p: Record<string, string>, body: Rec) => unknown, status: number, redact?: (b: unknown) => unknown) {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      const s = deps.current(req);
      try {
        const raw = req.headers['idempotency-key'];
        const key = (Array.isArray(raw) ? raw[0] : raw)?.trim();
        if (!key) throw new Fail(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Нужен заголовок Idempotency-Key');
        if (!UUID_RE.test(key)) throw new Fail(400, 'VALIDATION_FAILED', 'Idempotency-Key должен быть UUID', { field: 'Idempotency-Key' });
        const params = req.params as Record<string, string>;
        const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? (req.body as Rec) : {};
        const hash = JSON.stringify({ route: `${req.method} ${req.routeOptions.url}`, params, body });
        const memoKey = `${s.id}:certificate.${op}:${key.toLowerCase()}`;
        const memo = replays.get(memoKey);
        if (memo) {
          if (memo.hash !== hash) throw new Fail(409, 'IDEMPOTENCY_KEY_REUSED', 'Этот ключ уже использован для другого запроса');
          return reply.code(memo.status).header('idempotent-replay', 'true').send(memo.body);
        }
        const snap = certs.map((c) => ({ ...c, redemptions: [...c.redemptions], history: [...c.history], timeline: [...c.timeline] }));
        let out: unknown;
        try {
          out = run(s, params, body);
        } catch (e) {
          certs = snap;
          throw e;
        }
        replays.set(memoKey, { hash, status, body: redact ? redact(out) : out });
        return reply.code(status).send(out);
      } catch (e) {
        return send(reply, e);
      }
    };
  }

  const reasonOf = (v: unknown) => {
    const r = typeof v === 'string' ? v.trim() : '';
    if (r === '') throw new Fail(422, 'COMMENT_REQUIRED', 'Укажите причину', { field: 'reason' });
    return r;
  };
  const byId = (p: Record<string, string>) => {
    if (!UUID_RE.test(p.id ?? '')) throw notFound();
    return p.id!;
  };
  const guarded = (s: Staffish, id: string, action: string) => {
    const c = certs.find((x) => x.id === id);
    if (!c) throw notFound();
    assertCan(s, action, c.saleBranchId);
    return c;
  };
  const relock = (c: Cert, rowVersion: number) => {
    if (c.rowVersion !== rowVersion) throw new Fail(409, 'VERSION_CONFLICT', 'Карточка изменилась: обновите', { current: c.rowVersion });
  };

  // №31 продажа
  app.post(`${P}/branches/:branchId/certificates`, command('sell', (s, p, body) => {
    if (typeof body.nominalKop !== 'number') throw zodFail('nominalKop');
    if (!['cash', 'card', 'transfer'].includes(String(body.method))) throw zodFail('method');
    for (const f of ['buyerClientId', 'recipientClientId']) if (body[f] !== undefined && body[f] !== null && !UUID_RE.test(String(body[f]))) throw zodFail(f);
    if (body.comment !== undefined && body.comment !== null && (typeof body.comment !== 'string' || body.comment.length > 2000)) throw zodFail('comment');
    const b = deps.branches().find((x) => x.id === p.branchId);
    if (!b) throw notFound();
    assertCan(s, 'certificate.sell', b.id);
    const nominal = body.nominalKop;
    if (!Number.isSafeInteger(nominal) || nominal <= 0) throw new Fail(422, 'NOMINAL_OUT_OF_RANGE', 'Номинал вне допустимых пределов', { nominalKop: nominal, minKop: null, maxKop: null });
    const id = randomUUID();
    const pin = String(randomInt(0, 10_000)).padStart(4, '0');
    const now = Date.now();
    const { expiresOn, expiresAt } = expiryOf(now, b.timezone);
    const sale = recordMoney({ branchId: b.id, timezone: b.timezone, kind: 'income', method: body.method as Method, amountKop: nominal, source: 'certificate_sale', ref: { type: 'certificate', id }, comment: null, authorId: s.id });
    const c: Cert = {
      id, number: genNumber(), pin, nominalKop: nominal, balanceKop: nominal, soldAt: now, saleBranchId: b.id, saleMethod: body.method as Method, saleOperationId: sale.id,
      soldBy: s.id, expiresOn, expiresAt, cancelledAt: null, cancelReason: null, reviewReason: null, buyerClientId: (body.buyerClientId as string | null | undefined) ?? null,
      recipientClientId: (body.recipientClientId as string | null | undefined) ?? null, comment: typeof body.comment === 'string' ? body.comment.trim() || null : null, rowVersion: 1,
      redemptions: [], history: [], timeline: [{ type: 'sale', amountKop: nominal, balanceAfterKop: nominal, at: new Date(now).toISOString(), branchId: b.id, basis: null }],
    };
    certs.push(c);
    return { certificate: dto(c, now), pin };
  }, 201, (out) => ({ certificate: (out as { certificate: unknown }).certificate, pin: null, pinShownOnce: true })));

  // №32 отмена продажи
  app.post(`${P}/certificates/:id/cancel`, command('cancel', (s, p, body) => {
    const id = byId(p);
    if (!Number.isInteger(body.rowVersion)) throw zodFail('rowVersion');
    if (typeof body.reason !== 'string' || body.reason.length > 2000) throw zodFail('reason');
    if (typeof body.refundMoney !== 'boolean') throw zodFail('refundMoney');
    const reason = reasonOf(body.reason);
    const c = guarded(s, id, 'certificate.cancel');
    relock(c, body.rowVersion as number);
    const now = Date.now();
    if (c.cancelledAt !== null) throw new Fail(409, 'CERTIFICATE_NOT_ACTIVE', 'Продажа уже отменена', { status: 'cancelled' });
    if (now >= c.expiresAt) throw new Fail(409, 'CERTIFICATE_EXPIRED', 'Срок действия сертификата истёк', { expiresOn: c.expiresOn });
    if (c.redemptions.length > 0 || c.balanceKop !== c.nominalKop) throw new Fail(409, 'CERTIFICATE_USED', 'Сертификат использовался: отмена – корректировкой Владельца');
    if (body.refundMoney) {
      const b = deps.branches().find((x) => x.id === c.saleBranchId)!;
      recordMoney({ branchId: b.id, timezone: b.timezone, kind: 'refund', method: c.saleMethod, amountKop: c.nominalKop, source: null, ref: { type: 'operation', id: c.saleOperationId }, comment: `Отмена продажи сертификата ${c.number}: ${reason}`, authorId: s.id });
    }
    c.timeline.push({ type: 'cancel', amountKop: -c.balanceKop, balanceAfterKop: 0, at: new Date(now).toISOString(), branchId: c.saleBranchId, basis: reason });
    Object.assign(c, { balanceKop: 0, cancelledAt: now, cancelReason: reason, rowVersion: c.rowVersion + 1 });
    return dto(c, now);
  }, 200));

  // №36 проверка по номеру и коду перед оплатой (право finance.payment.record на филиал); тот же лимит попыток.
  // Неудача кода фиксируется до ответа (не откатывается снимком command). Ответ повтора – без кода в хэше (hashPin).
  app.post(`${P}/certificates/check`, async (req, reply) => {
    const s = deps.current(req);
    try {
      const raw = req.headers['idempotency-key'];
      const key = (Array.isArray(raw) ? raw[0] : raw)?.trim();
      if (!key) throw new Fail(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Нужен заголовок Idempotency-Key');
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? (req.body as Rec) : {};
      if (typeof body.branchId !== 'string') throw zodFail('branchId');
      if (typeof body.number !== 'string' || body.number.length < 1 || body.number.length > 40) throw zodFail('number');
      if (typeof body.pin !== 'string' || body.pin.length > 10) throw zodFail('pin');
      if (!deps.branches().some((b) => b.id === body.branchId) || !inZone(s, body.branchId)) throw notFound();
      if (!deps.can(s, 'finance.payment.record')) throw new Fail(403, 'FORBIDDEN', 'Недостаточно прав', { action: 'finance.payment.record' });
      const id = certificatePayments.verify(body.number, body.pin);
      const c = dto(certs.find((x) => x.id === id)!);
      return reply.code(200).send({ number: c.number, status: c.status, balanceKop: c.balanceKop, expiresOn: c.expiresOn });
    } catch (e) {
      return send(reply, e);
    }
  });

  // №33 корректировка остатка (Владелец)
  app.post(`${P}/certificates/:id/correct`, command('correct', (s, p, body) => {
    const id = byId(p);
    if (!Number.isInteger(body.rowVersion)) throw zodFail('rowVersion');
    if (typeof body.deltaKop !== 'number') throw zodFail('deltaKop');
    if (typeof body.reason !== 'string' || body.reason.length > 2000) throw zodFail('reason');
    if (body.ref !== undefined && body.ref !== null && (typeof body.ref !== 'string' || body.ref.length > 200)) throw zodFail('ref');
    const reason = reasonOf(body.reason);
    if (!Number.isSafeInteger(body.deltaKop) || body.deltaKop === 0) throw new Fail(422, 'INVALID_AMOUNT', 'Корректировка – целое ненулевое число копеек', { deltaKop: body.deltaKop });
    const c = guarded(s, id, 'certificate.correct');
    relock(c, body.rowVersion as number);
    if (c.cancelledAt !== null) throw new Fail(409, 'CERTIFICATE_NOT_ACTIVE', 'Продажа отменена', { status: 'cancelled' });
    const after = c.balanceKop + (body.deltaKop as number);
    if (after > c.nominalKop) throw new Fail(422, 'CORRECTION_EXCEEDS_NOMINAL', 'Остаток после корректировки больше номинала', { balanceKop: c.balanceKop, nominalKop: c.nominalKop });
    if (after < 0) throw new Fail(409, 'CERTIFICATE_INSUFFICIENT', 'Остаток не может стать отрицательным', { balanceKop: c.balanceKop });
    const ref = typeof body.ref === 'string' && body.ref.trim() ? body.ref.trim() : null;
    c.timeline.push({ type: 'correction', amountKop: body.deltaKop as number, balanceAfterKop: after, at: new Date().toISOString(), branchId: c.saleBranchId, basis: ref ? `${reason} (${ref})` : reason });
    Object.assign(c, { balanceKop: after, rowVersion: c.rowVersion + 1 });
    return dto(c);
  }, 201));
}

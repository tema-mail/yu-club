// Мок оплаты сеанса CRM строго по apps/api/src/modules/finance/routes.payments.ts, payment.ts, refund.ts (K10 §2, §5, §7, §11):
// №19 карточка оплаты (allowedMethods считает «сервер»), №20 проведение (один способ; «сертификат + доплата» только
// при payment.certificate_topup_enabled; код сертификата проверяется до команды и неудача не откатывается), №21 возврат
// (деньги частично и целиком, баллы и сертификат – целиком; rowVersion сеанса), №22 «к оплате» за сутки филиала,
// №23 статусы для календаря. Idempotency-Key обязателен: повтор с тем же телом – тот же ответ, с другим –
// IDEMPOTENCY_KEY_REUSED; код сертификата в хэш не попадает.
// Провайдеры, как в server.ts: бронь – GET /bookings/{id} мока брони с кукой сотрудника (вне зоны – 404), настройки и
// доступные баллы – служебной сессией Владельца (ownerCookie). Деньги – recordMoney мока кассы (K17), сертификат –
// certificatePayments мока сертификатов (K16). Баллы: списания и возвраты оплаты считаются здесь (мок loyalty их не
// видит); резерв брони, сделанный на сайте (K15 §3), засеян в ownReserves – он не мешает оплатить эту бронь баллами.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { certificatePayments } from './mock-certificates.ts';
import { recordMoney } from './mock-finance.ts';
import { opsState } from './mock-ops.ts';

type Rec = Record<string, unknown>;
interface Staffish { id: string; role: string }
interface Zone { network: boolean; cityIds: string[]; branchIds: string[] }
interface BranchLite { id: string; name: string; timezone: string }

export interface PaymentsMockDeps {
  current: (req: FastifyRequest) => Staffish;
  zone: (s: Staffish) => Zone;
  can: (s: Staffish, action: string) => boolean;
  branches: () => BranchLite[];
  /** Служебная сессия для провайдеров настроек и баллов (на сервере они читают базу без прав сотрудника). */
  ownerCookie: () => string;
}

type Method = 'cash' | 'card' | 'transfer' | 'points' | 'certificate' | 'none';
type MoneyMethod = 'cash' | 'card' | 'transfer';
type SessionStatus = 'unpaid' | 'paid' | 'partially_refunded' | 'refunded';
interface Session { bookingId: string; branchId: string; clientId: string; amountDueKop: number; bookingVersion: number; status: SessionStatus; rowVersion: number }
interface Line { lineNo: 1 | 2; method: Exclude<Method, 'none'>; amountKop: number; ledgerPostingId: string; pointsCenti?: number; certificateId?: string; financeOperationId?: string; redemptionId?: string }
interface Payment { id: string; sessionId: string; attempt: number; status: 'active' | 'partially_refunded' | 'refunded'; lines: Line[]; totalKop: number; recordedBy: string; recordedAt: string; topupRuleSnapshot: boolean; comment: string | null }
interface Refund { id: string; paymentId: string; lineNo: 1 | 2; seq: number; amountKop: number; pointsCenti: number | null; reason: string; outcome: 'returned' | 'not_restored'; createdAt: string }
interface Booking { id: string; number: number; branchId: string; status: string; priceKop: number; currentVersion: number; start: string; end: string; resourceId: string; resourceName: string; client: { id: string } }

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
const ID_RE = /^[0-9a-f-]{36}$/i;
const KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONEY: MoneyMethod[] = ['cash', 'card', 'transfer'];
const isMoney = (m: string): m is MoneyMethod => (MONEY as string[]).includes(m);
const notFound = () => new Fail(404, 'NOT_FOUND', 'Не найдено');
const forbidden = (action: string) => new Fail(403, 'FORBIDDEN', 'Недостаточно прав', { action });
const zodFail = (path: string) => new Fail(400, 'VALIDATION_FAILED', 'Неверные данные запроса', { issues: [{ path, message: 'Invalid input' }] });
const combined = (details: Rec) => new Fail(422, 'PAYMENT_METHODS_COMBINED', 'Сеанс оплачивается одним способом', details);

// ---- состояние

let sessions = new Map<string, Session>();
let payments: Payment[] = [];
let refunds: Refund[] = [];
let pointsSpent = new Map<string, number>(); // клиент → Σ списано оплатами (сотые балла), за вычетом возвратов
let ownReserves = new Map<string, number>(); // бронь → резерв баллов этой брони (сделан при записи на сайте)
let replays = new Map<string, { hash: string; status: number; body: unknown }>();

export function resetPayments(): void {
  sessions = new Map();
  payments = [];
  refunds = [];
  pointsSpent = new Map();
  // Резерв 6 баллов клиента Ольги (мок loyalty: reserves C1 = 600) – это резерв брони, которая сейчас идёт.
  ownReserves = new Map([['b0000000-0000-4000-8000-000000000001', 600]]);
  replays = new Map();
}

const livePayment = (bookingId: string) => payments.find((p) => p.sessionId === bookingId && p.status !== 'refunded') ?? null;
const sessionDto = (s: Session) => ({ id: s.bookingId, ...s, activePaymentId: livePayment(s.bookingId)?.id ?? null });
const paymentDto = (p: Payment) => ({ ...p, lines: p.lines.map(({ redemptionId: _r, ...l }) => (void _r, l)) });

// ---- маршруты

export function registerPayments(app: FastifyInstance, P: string, deps: PaymentsMockDeps): void {
  const branchOf = (id: string) => deps.branches().find((b) => b.id === id);
  const inZone = (s: Staffish, branchId: string) => deps.zone(s).network || deps.zone(s).branchIds.includes(branchId);
  /** guardFinance: вне зоны – 404, в зоне без права – 403. */
  const guard = (s: Staffish, branchId: string, action: string) => {
    if (!branchOf(branchId) || !inZone(s, branchId)) throw notFound();
    if (!deps.can(s, action)) throw forbidden(action);
  };
  const call = async (method: 'GET' | 'POST', url: string, cookie: string): Promise<{ status: number; body: unknown }> => {
    const r = await app.inject({ method, url: `${P}${url}`, headers: { cookie } });
    return { status: r.statusCode, body: r.statusCode === 204 ? null : r.json() };
  };
  /** bookings.facts / payableBooking: бронь без прав сотрудника на кассу (их проверяет guard). */
  const booking = async (req: FastifyRequest, id: string): Promise<Booking | null> => {
    if (!ID_RE.test(id)) return null;
    const r = await call('GET', `/bookings/${encodeURIComponent(id)}`, req.headers.cookie ?? '');
    return r.status === 200 ? (r.body as Booking) : null;
  };
  const settings = async (branchId: string) => {
    const r = await call('GET', `/settings?scope=branch&id=${encodeURIComponent(branchId)}`, deps.ownerCookie());
    const items = (r.body as { items: Array<{ key: string; value: unknown }> }).items;
    const v = (k: string) => items.find((i) => i.key === k)?.value;
    return { topup: v('payment.certificate_topup_enabled') === true, pointsTypes: (v('loyalty.points_resource_types') as string[]) ?? [] };
  };
  /** Доступно для ЭТОЙ брони: доступное счёта (минус все резервы) + собственный резерв брони − списано оплатами. */
  const pointsFor = async (clientId: string, bookingId: string) => {
    const r = await call('GET', `/clients/${encodeURIComponent(clientId)}/loyalty`, deps.ownerCookie());
    const base = r.status === 200 ? (r.body as { availableCenti: number }).availableCenti : 0;
    return Math.max(0, base + (ownReserves.get(bookingId) ?? 0) - (pointsSpent.get(clientId) ?? 0));
  };
  const minutesOf = (b: Booking) => Math.round((Date.parse(b.end) - Date.parse(b.start)) / 60_000);
  const typeOf = (b: Booking) => opsState().resources.find((r) => r.id === b.resourceId)?.type ?? '';
  const payable = (b: Booking) => b.status === 'arrived' || b.status === 'completed';

  const send = (reply: FastifyReply, e: unknown) => {
    if (e instanceof Fail || (e && typeof (e as Fail).status === 'number' && typeof (e as Fail).code === 'string')) {
      const f = e as Fail;
      return reply.code(f.status).send({ error: { code: f.code, message: f.message, ...(f.details ? { details: f.details } : {}), requestId: randomUUID() } });
    }
    throw e;
  };
  const objectBody = (b: unknown): Rec => (b && typeof b === 'object' && !Array.isArray(b) ? (b as Rec) : {});
  /** Тело для хэша: код сертификата заменён (в idempotency_keys его нет). */
  const hashBody = (body: Rec) => ({
    ...body,
    ...(Array.isArray(body.lines) ? { lines: body.lines.map((l) => { const x = objectBody(l); const c = objectBody(x.certificate); return typeof c.pin === 'string' ? { ...x, certificate: { ...c, pin: '***' } } : x; }) } : {}),
  });

  /** command: ключ → prepare (до транзакции, не откатывается) → run со снимком состояния (отказ – откат). */
  function command(op: string, prepare: (s: Staffish, body: Rec) => Promise<Rec>, run: (s: Staffish, p: Record<string, string>, body: Rec, req: FastifyRequest, prepared: Rec) => Promise<unknown>) {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      const s = deps.current(req);
      try {
        const raw = req.headers['idempotency-key'];
        const key = (Array.isArray(raw) ? raw[0] : raw)?.trim();
        if (!key) throw new Fail(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Нужен заголовок Idempotency-Key');
        if (!KEY_RE.test(key)) throw new Fail(400, 'VALIDATION_FAILED', 'Idempotency-Key должен быть UUID', { field: 'Idempotency-Key' });
        const params = req.params as Record<string, string>;
        const body = objectBody(req.body);
        const hash = JSON.stringify({ route: `${req.method} ${req.routeOptions.url}`, params, body: hashBody(body) });
        const memoKey = `${s.id}:finance.${op}:${key.toLowerCase()}`;
        const prior = replays.get(memoKey);
        if (prior) {
          if (prior.hash !== hash) throw new Fail(409, 'IDEMPOTENCY_KEY_REUSED', 'Этот ключ уже использован для другого запроса');
          return reply.code(prior.status).header('idempotent-replay', 'true').send(prior.body);
        }
        const prepared = await prepare(s, body);
        const snap = { sessions: new Map([...sessions].map(([k, v]) => [k, { ...v }])), payments: payments.map((p) => ({ ...p, lines: [...p.lines] })), refunds: [...refunds], spent: new Map(pointsSpent) };
        let out: unknown;
        try {
          out = await run(s, params, body, req, prepared);
        } catch (e) {
          ({ sessions, payments, refunds } = snap);
          pointsSpent = snap.spent;
          throw e;
        }
        replays.set(memoKey, { hash, status: 201, body: out });
        return reply.code(201).send(out);
      } catch (e) {
        return send(reply, e);
      }
    };
  }

  // №19 карточка оплаты брони
  app.get(`${P}/bookings/:bookingId/payment`, async (req, reply) => {
    const s = deps.current(req);
    try {
      const b = await booking(req, (req.params as { bookingId: string }).bookingId);
      if (!b) throw notFound();
      guard(s, b.branchId, 'finance.payment.view');
      const session = sessions.get(b.id) ?? null;
      const last = payments.filter((p) => p.sessionId === b.id).sort((x, y) => y.attempt - x.attempt)[0] ?? null;
      const st = await settings(b.branchId);
      const pointsType = st.pointsTypes.includes(typeOf(b));
      const pointsAvailableCenti = await pointsFor(b.client.id, b.id);
      const pointsRequiredCenti = pointsType ? minutesOf(b) * 100 : null;
      const live = livePayment(b.id);
      const due = session && !live ? b.priceKop : (session?.amountDueKop ?? b.priceKop);
      let allowedMethods: Method[] = [];
      if (payable(b) && !live && deps.can(s, 'finance.payment.record')) {
        if (due === 0) allowedMethods = ['none'];
        else {
          allowedMethods = [...MONEY];
          if (pointsRequiredCenti !== null && pointsAvailableCenti >= pointsRequiredCenti) allowedMethods.push('points');
          allowedMethods.push('certificate');
        }
      }
      return {
        session: session ? sessionDto(session) : null, payment: last ? paymentDto(last) : null,
        refunds: last ? refunds.filter((r) => r.paymentId === last.id).map(({ paymentId: _p, ...r }) => (void _p, r)) : [],
        allowedMethods, amountDueKop: due, topupEnabled: st.topup, pointsAvailableCenti, pointsRequiredCenti,
      };
    } catch (e) {
      return send(reply, e);
    }
  });

  // №20 провести оплату: код сертификата – до команды (verify считает неудачи)
  app.post(`${P}/bookings/:bookingId/payment`, command(
    'payment.record',
    async (_s, body) => {
      const lines = Array.isArray(body.lines) ? body.lines.map(objectBody) : [];
      const cert = lines.find((l) => l.method === 'certificate');
      if (!cert) return {};
      const c = objectBody(cert.certificate);
      if (typeof c.number !== 'string' || typeof c.pin !== 'string') throw new Fail(400, 'VALIDATION_FAILED', 'Укажите номер и код сертификата', { field: 'certificate' });
      return { certificateId: certificatePayments.verify(c.number, c.pin) };
    },
    async (s, p, body, req, prepared) => {
      // разбор (recordSchema)
      if (!Array.isArray(body.lines) || body.lines.length < 1 || body.lines.length > 2) throw zodFail('lines');
      const lines = body.lines.map(objectBody);
      lines.forEach((l, i) => {
        if (!['cash', 'card', 'transfer', 'points', 'certificate', 'none'].includes(String(l.method))) throw zodFail(`lines.${i}.method`);
        if (!Number.isSafeInteger(l.amountKop) || (l.amountKop as number) < 0) throw zodFail(`lines.${i}.amountKop`);
      });
      if (body.comment !== undefined && (typeof body.comment !== 'string' || body.comment.trim().length > 2000)) throw zodFail('comment');
      if (body.receiptIssued !== undefined && typeof body.receiptIssued !== 'boolean') throw zodFail('receiptIssued');
      const b = await booking(req, p.bookingId ?? '');
      if (!b) throw notFound();
      guard(s, b.branchId, 'finance.payment.record');
      const st = await settings(b.branchId);
      // правило способа (TC-07)
      if (lines.length === 2 && (!st.topup || lines[0]!.method !== 'certificate' || !isMoney(String(lines[1]!.method)))) {
        throw combined({ methods: lines.map((l) => l.method), topupEnabled: st.topup });
      }
      if (lines.some((l) => l.method === 'certificate' && !l.certificate)) throw new Fail(400, 'VALIDATION_FAILED', 'Укажите номер и код сертификата', { field: 'certificate' });
      if (!payable(b)) throw new Fail(409, 'BOOKING_NOT_PAYABLE', 'Оплата – после прихода клиента', { status: b.status });
      let session = sessions.get(b.id);
      if (!session) {
        session = { bookingId: b.id, branchId: b.branchId, clientId: b.client.id, amountDueKop: b.priceKop, bookingVersion: b.currentVersion, status: 'unpaid', rowVersion: 1 };
        sessions.set(b.id, session);
      }
      const live = livePayment(b.id);
      if (live) throw new Fail(409, 'ALREADY_PAID', 'Сеанс уже оплачен', { paymentId: live.id });
      if (session.bookingVersion !== b.currentVersion || session.amountDueKop !== b.priceKop) Object.assign(session, { amountDueKop: b.priceKop, bookingVersion: b.currentVersion });
      const due = session.amountDueKop;
      // суммы (assertAmounts)
      if (lines.some((l) => l.method === 'none')) {
        if (lines.length > 1) throw combined({ methods: lines.map((l) => l.method) });
        if (due > 0) throw new Fail(422, 'NOTHING_TO_PAY', 'Способ «без оплаты» – только для сеанса за 0 ₽', { amountDueKop: due });
        if (lines[0]!.amountKop !== 0) throw new Fail(422, 'AMOUNT_MISMATCH', 'Сумма не совпадает с суммой к оплате', { amountDueKop: due });
      } else {
        if (due === 0) throw new Fail(422, 'NOTHING_TO_PAY', 'Сеанс за 0 ₽ закрывается способом «без оплаты»', { amountDueKop: due });
        const sum = lines.reduce((x, l) => x + (l.amountKop as number), 0);
        if (sum !== due || lines.some((l) => (l.amountKop as number) <= 0)) throw new Fail(422, 'AMOUNT_MISMATCH', 'Сумма не совпадает с суммой к оплате', { amountDueKop: due, totalKop: sum });
      }
      // проверки обработчиков до проводок: баллы и остаток сертификата в режиме drain
      const drain = lines.length === 2;
      const pl = lines.find((l) => l.method === 'points');
      if (pl) {
        if (!st.pointsTypes.includes(typeOf(b))) throw new Fail(422, 'POINTS_NOT_ALLOWED', 'Этот вид посещения баллами не оплачивается', { resourceType: typeOf(b) });
        const required = minutesOf(b) * 100;
        const available = await pointsFor(b.client.id, b.id);
        if (available < required) throw new Fail(409, 'POINTS_INSUFFICIENT', 'Баллов недостаточно для оплаты сеанса', { availableCenti: available, requiredCenti: required });
      }
      const certId = prepared.certificateId as string | undefined;
      if (drain && certId) {
        const left = certificatePayments.balanceOf(certId);
        const charged = Math.min(left, due);
        if (!(charged > 0 && charged < due && charged === lines[0]!.amountKop)) {
          throw new Fail(422, 'AMOUNT_MISMATCH', 'Остаток сертификата изменился: проверьте суммы', { amountDueKop: due, certificateKop: charged });
        }
      }
      // платёж и строки
      const attempt = payments.filter((x) => x.sessionId === b.id).length + 1;
      const paymentId = randomUUID();
      const branch = branchOf(b.branchId)!;
      const out: Line[] = [];
      let rest = due;
      for (const [i, l] of lines.entries()) {
        if (l.method === 'none') break;
        const lineNo = (i + 1) as 1 | 2;
        const method = l.method as Line['method'];
        if (isMoney(method)) {
          const amount = drain ? rest : (l.amountKop as number);
          const op = recordMoney({ branchId: b.branchId, timezone: branch.timezone, kind: 'income', method, amountKop: amount, source: 'session', ref: { type: 'payment', id: paymentId }, comment: typeof body.comment === 'string' ? body.comment.trim() || null : null, authorId: s.id });
          out.push({ lineNo, method, amountKop: amount, ledgerPostingId: randomUUID(), financeOperationId: op.id });
        } else if (method === 'points') {
          const centi = minutesOf(b) * 100;
          pointsSpent.set(b.client.id, (pointsSpent.get(b.client.id) ?? 0) + centi);
          out.push({ lineNo, method, amountKop: l.amountKop as number, ledgerPostingId: randomUUID(), pointsCenti: centi });
        } else {
          const r = certificatePayments.charge(certId!, drain ? due : (l.amountKop as number), drain ? 'drain' : 'exact', { bookingId: b.id, paymentId, branchId: b.branchId, branchName: branch.name, clientId: b.client.id });
          out.push({ lineNo, method, amountKop: r.amountKop, ledgerPostingId: randomUUID(), certificateId: r.certificateId, redemptionId: r.redemptionId });
        }
        rest -= out.at(-1)!.amountKop;
      }
      payments.push({ id: paymentId, sessionId: b.id, attempt, status: 'active', lines: out, totalKop: due, recordedBy: s.id, recordedAt: new Date().toISOString(), topupRuleSnapshot: st.topup, comment: typeof body.comment === 'string' ? body.comment.trim() || null : null });
      Object.assign(session, { status: 'paid', rowVersion: session.rowVersion + 1 });
      return { paymentId, session: sessionDto(session) };
    },
  ));

  // №21 возврат
  app.post(`${P}/payments/:paymentId/refund`, command('payment.refund', async () => ({}), async (s, p, body) => {
    if (typeof p.paymentId !== 'string' || !ID_RE.test(p.paymentId)) throw zodFail('paymentId');
    if (!Number.isInteger(body.rowVersion) || (body.rowVersion as number) < 1) throw zodFail('rowVersion');
    if (body.reason !== undefined && (typeof body.reason !== 'string' || body.reason.length > 2000)) throw zodFail('reason');
    if (!Array.isArray(body.lines) || body.lines.length > 2) throw zodFail('lines');
    const reqLines = body.lines.map(objectBody);
    if (reqLines.some((l) => l.lineNo !== 1 && l.lineNo !== 2) || new Set(reqLines.map((l) => l.lineNo)).size !== reqLines.length) throw zodFail('lines');
    if (reqLines.some((l) => l.amountKop !== undefined && typeof l.amountKop !== 'number')) throw zodFail('lines.amountKop');
    const payment = payments.find((x) => x.id === p.paymentId);
    const session = payment ? sessions.get(payment.sessionId) : undefined;
    if (!payment || !session) throw notFound();
    guard(s, session.branchId, 'finance.refund');
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (reason === '') throw new Fail(422, 'COMMENT_REQUIRED', 'Укажите комментарий', { field: 'reason' });
    if (reqLines.length === 0 && payment.lines.length > 0) throw new Fail(400, 'VALIDATION_FAILED', 'Укажите строки возврата', { field: 'lines' });
    if (session.rowVersion !== body.rowVersion) throw new Fail(409, 'VERSION_CONFLICT', 'Оплату уже изменили', { rowVersion: session.rowVersion });
    if (payment.status === 'refunded') throw new Fail(422, 'REFUND_EXCEEDS_PAID', 'Платёж уже возвращён полностью', { paymentId: payment.id });
    const branch = branchOf(session.branchId)!;
    const done = (lineNo: number) => refunds.filter((r) => r.paymentId === payment.id && r.lineNo === lineNo);
    const refundIds: string[] = [];
    for (const rq of reqLines) {
      const line = payment.lines.find((l) => l.lineNo === rq.lineNo);
      if (!line) throw new Fail(400, 'VALIDATION_FAILED', 'Нет такой строки платежа', { field: 'lineNo', lineNo: rq.lineNo });
      const prev = done(line.lineNo);
      const left = line.amountKop - prev.reduce((x, r) => x + r.amountKop, 0);
      const amount = (rq.amountKop as number | undefined) ?? left;
      if (!Number.isSafeInteger(amount) || amount <= 0) {
        if (left <= 0) throw new Fail(422, 'REFUND_EXCEEDS_PAID', 'Строка уже возвращена', { lineNo: line.lineNo, leftKop: 0 });
        throw new Fail(422, 'INVALID_AMOUNT', 'Сумма – целое положительное число копеек', { amountKop: amount });
      }
      if (amount > left) throw new Fail(422, 'REFUND_EXCEEDS_PAID', 'Возврат больше непогашенной части строки', { lineNo: line.lineNo, leftKop: left });
      if (!isMoney(line.method) && amount !== line.amountKop) throw new Fail(422, 'REFUND_PARTIAL_NOT_ALLOWED', 'Баллы и сертификат возвращаются только целиком', { lineNo: line.lineNo, amountKop: line.amountKop });
      let outcome: Refund['outcome'] = 'returned';
      if (isMoney(line.method)) {
        recordMoney({ branchId: branch.id, timezone: branch.timezone, kind: 'refund', method: line.method, amountKop: amount, source: null, ref: { type: 'operation', id: line.financeOperationId! }, comment: reason, authorId: s.id });
      } else if (line.method === 'points') {
        pointsSpent.set(session.clientId, (pointsSpent.get(session.clientId) ?? 0) - (line.pointsCenti ?? 0));
      } else {
        outcome = certificatePayments.refund(line.redemptionId!);
      }
      const id = randomUUID();
      refunds.push({ id, paymentId: payment.id, lineNo: line.lineNo, seq: prev.length + 1, amountKop: amount, pointsCenti: line.method === 'points' ? (line.pointsCenti ?? null) : null, reason, outcome, createdAt: new Date().toISOString() });
      refundIds.push(id);
    }
    const full = payment.lines.every((l) => done(l.lineNo).reduce((x, r) => x + r.amountKop, 0) >= l.amountKop);
    payment.status = full ? 'refunded' : 'partially_refunded';
    Object.assign(session, { status: payment.status, rowVersion: session.rowVersion + 1 });
    return { refundIds, session: sessionDto(session) };
  }));

  // №22 к оплате: пришедшие и завершённые без живого платежа за сутки филиала
  app.get(`${P}/branches/:branchId/unpaid`, async (req, reply) => {
    const s = deps.current(req);
    try {
      const branchId = (req.params as { branchId: string }).branchId;
      guard(s, branchId, 'finance.payment.view');
      const q = req.query as Record<string, string | undefined>;
      const date = q.date ?? '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) throw new Fail(400, 'VALIDATION_FAILED', 'Неверная дата', { field: 'date' });
      const limit = q.limit === undefined ? 50 : Number(q.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Fail(400, 'VALIDATION_FAILED', 'limit – от 1 до 200', { field: 'limit' });
      if (q.cursor !== undefined && !/^\d{1,16}:\d{1,18}$/.test(q.cursor)) throw new Fail(400, 'VALIDATION_FAILED', 'Неверный курсор', { field: 'cursor' });
      const rows: Booking[] = [];
      let cursor: string | null = null;
      do {
        const r = await call('GET', `/branches/${encodeURIComponent(branchId)}/bookings?date=${date}&status=arrived,completed&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, req.headers.cookie ?? '');
        const page = r.body as { items: Array<{ id: string }>; nextCursor: string | null };
        for (const it of page.items) {
          const b = await booking(req, it.id);
          if (b) rows.push(b);
        }
        cursor = page.nextCursor;
      } while (cursor);
      const [cMs, cNum] = q.cursor ? q.cursor.split(':').map(Number) : [null, null];
      const unpaid = rows
        .filter((b) => { const st = sessions.get(b.id)?.status; return !st || st === 'unpaid' || st === 'refunded'; })
        .sort((x, y) => Date.parse(x.start) - Date.parse(y.start) || x.number - y.number)
        .filter((b) => cMs === null || Date.parse(b.start) > cMs || (Date.parse(b.start) === cMs && b.number > cNum!));
      const page = unpaid.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map((b) => ({
          bookingId: b.id, number: b.number, status: b.status, clientId: b.client.id, resourceName: b.resourceName, start: b.start, end: b.end,
          amountDueKop: b.priceKop, paymentStatus: sessions.get(b.id)?.status === 'refunded' ? 'refunded' : 'unpaid',
        })),
        nextCursor: unpaid.length > limit && last ? `${Date.parse(last.start)}:${last.number}` : null,
      };
    } catch (e) {
      return send(reply, e);
    }
  });

  // №23 статусы для календаря: чужие брони в ответ не попадают
  app.post(`${P}/bookings/payment-status`, async (req, reply) => {
    const s = deps.current(req);
    try {
      const ids = objectBody(req.body).bookingIds;
      if (!Array.isArray(ids) || ids.length < 1 || ids.length > 200 || ids.some((x) => typeof x !== 'string' || !ID_RE.test(x))) {
        throw new Fail(400, 'VALIDATION_FAILED', 'Неверные данные запроса', { field: 'bookingIds' });
      }
      const items: Array<{ bookingId: string; status: SessionStatus }> = [];
      for (const id of new Set(ids as string[])) {
        const b = await booking(req, id);
        if (b && inZone(s, b.branchId) && deps.can(s, 'finance.payment.view')) items.push({ bookingId: id, status: sessions.get(id)?.status ?? 'unpaid' });
      }
      return { items };
    } catch (e) {
      return send(reply, e);
    }
  });
}

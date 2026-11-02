// Мок баллов и сертификатов для e2e сайта (Э2: S2-70…S2-72) – точно по apps/api/src/modules/loyalty/routes.public.ts
// (K15 §11–12) и modules/certificates/routes.public.ts (K16 §8): только своя карточка, без внутренних комментариев.
// Баллы хранятся в сотых (centi): 1 балл = 1 минута (07 §6.1), резерв на удержание = Σ минут × 100, держится, пока
// удержание живо и его состав не менялся (подпись позиций, K15 §3 «ленивое снятие»). Комната целиком баллами
// не оплачивается (Q-42) – POINTS_NOT_ALLOWED. Баланс ≤ −50 – preBookingBlocked и ворота на создании удержания (hold.ts).
// Клиенты по телефону: Алина – баллы, история с «не возвращено», 3 сертификата; Пётр – 20 баллов (мало на 30 минут)
// и свой сертификат; …0050 – баланс −50. Остальные – пустой счёт.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';

const DAY = 86_400_000;
const LIMIT_MESSAGE = 'Предварительная запись временно недоступна: баланс бонусных баллов достиг минимального значения −50. Обратитесь к администратору клуба';
const POINTS_TYPES = ['pc', 'vr_seat', 'ps_room']; // loyalty.points_resource_types по умолчанию (Q-42)

export interface CommerceDeps {
  /** Клиент сессии по куке (yu_client) – id и телефон. */
  sessionClient: (cookie: string | undefined) => { id: string; phone: string } | null;
  /** Удержание из мока записи: владелец, жив ли, позиции (id, минуты, тип ресурса). */
  holdView: (holdId: string) => { clientId: string | null; live: boolean; items: Array<{ id: string; minutes: number; type: string }> } | null;
  fail: (reply: FastifyReply, status: number, code: string, message: string) => unknown;
}

type Entry = { type: string; delta: number; daysAgo: number; branchName: string | null; bookingNumber: number | null; notReturned?: number };
const NOTES: Record<string, string> = {
  accrual: 'Начисление за посещение', penalty: 'Штраф за неявку', spend_time: 'Оплата сеанса баллами', spend_goods: 'Товар за баллы',
  return: 'Возврат баллов', expire: 'Срок баллов истёк', manual: 'Корректировка клубом',
};
const ACCOUNTS: Record<string, { entries: Entry[]; nextExpiryDays: number | null; nextExpiryCenti: number }> = {
  '+79131234567': {
    nextExpiryDays: 20, nextExpiryCenti: 12_000,
    entries: [ // от старых к новым
      { type: 'accrual', delta: 30_000, daysAgo: 60, branchName: 'Ю-Клуб на Красном', bookingNumber: 990 },
      { type: 'accrual', delta: 12_000, daysAgo: 40, branchName: 'Ю-Клуб на Ленина', bookingNumber: 995 },
      { type: 'penalty', delta: -5_000, daysAgo: 30, branchName: 'Ю-Клуб на Ленина', bookingNumber: 997 },
      { type: 'spend_goods', delta: -6_000, daysAgo: 20, branchName: 'Ю-Клуб на Красном', bookingNumber: null },
      { type: 'expire', delta: -2_000, daysAgo: 10, branchName: null, bookingNumber: null },
      { type: 'return', delta: 3_050, daysAgo: 2, branchName: 'Ю-Клуб на Красном', bookingNumber: null, notReturned: 1_000 },
    ],
  },
  '+79135550000': { nextExpiryDays: 5, nextExpiryCenti: 2_000, entries: [{ type: 'accrual', delta: 2_000, daysAgo: 3, branchName: 'Ю-Клуб на Красном', bookingNumber: 1001 }] },
  '+79135550050': {
    nextExpiryDays: null, nextExpiryCenti: 0,
    entries: [
      { type: 'accrual', delta: 1_000, daysAgo: 20, branchName: 'Ю-Клуб на Красном', bookingNumber: 1002 },
      { type: 'penalty', delta: -6_000, daysAgo: 1, branchName: 'Ю-Клуб на Красном', bookingNumber: 1003 },
    ],
  },
};

type CertEntry = { type: 'sale' | 'redeem' | 'return' | 'expire' | 'correction'; amount: number; daysAgo: number; branchName: string | null };
const CERTS: Record<string, Array<{ number: string; nominal: number; soldDaysAgo: number; expiresInDays: number; entries: CertEntry[] }>> = {
  '+79131234567': [
    { number: 'YU-2026-0001', nominal: 300_000, soldDaysAgo: 40, expiresInDays: 140, entries: [
      { type: 'sale', amount: 300_000, daysAgo: 40, branchName: 'Ю-Клуб на Красном' },
      { type: 'redeem', amount: -150_000, daysAgo: 30, branchName: 'Ю-Клуб на Красном' },
      { type: 'redeem', amount: -50_000, daysAgo: 12, branchName: 'Ю-Клуб на Ленина' },
      { type: 'return', amount: 20_000, daysAgo: 11, branchName: 'Ю-Клуб на Ленина' },
    ] },
    { number: 'YU-2026-0007', nominal: 100_000, soldDaysAgo: 90, expiresInDays: 90, entries: [
      { type: 'sale', amount: 100_000, daysAgo: 90, branchName: 'Ю-Клуб на Ленина' },
      { type: 'redeem', amount: -100_000, daysAgo: 60, branchName: 'Ю-Клуб на Ленина' },
    ] },
    { number: 'YU-2025-0042', nominal: 200_000, soldDaysAgo: 375, expiresInDays: -10, entries: [
      { type: 'sale', amount: 200_000, daysAgo: 375, branchName: 'Ю-Клуб на Красном' },
      { type: 'redeem', amount: -150_000, daysAgo: 200, branchName: 'Ю-Клуб на Красном' },
      { type: 'expire', amount: -50_000, daysAgo: 10, branchName: null },
    ] },
  ],
  '+79135550000': [{ number: 'YU-2026-0099', nominal: 500_000, soldDaysAgo: 5, expiresInDays: 360, entries: [{ type: 'sale', amount: 500_000, daysAgo: 5, branchName: 'Ю-Клуб на Красном' }] }],
};

const balanceOf = (phone: string) => (ACCOUNTS[phone]?.entries ?? []).reduce((s, e) => s + e.delta, 0);
const signature = (items: Array<{ id: string }>) => items.map((i) => i.id).sort().join(',');
const reserves = new Map<string, { clientId: string; amountCenti: number; signature: string; reserveId: string }>(); // holdId →
const replays = new Map<string, unknown>();

export function registerCommerce(app: FastifyInstance, P: string, deps: CommerceDeps) {
  const err = (reply: FastifyReply, status: number, code: string, message: string, details: Record<string, unknown> = {}) =>
    reply.code(status).send({ error: { code, message, details, requestId: randomUUID() } });
  const me = (req: { headers: { cookie?: string | undefined } }) => deps.sessionClient(req.headers.cookie);
  /** Активный резерв: удержание живо, его, состав тот же (иначе снят лениво – K15 §3). */
  const reservedOf = (clientId: string, exceptHold?: string) => {
    let sum = 0;
    for (const [holdId, r] of reserves) {
      const h = deps.holdView(holdId);
      const active = r.clientId === clientId && h !== null && h.live && signature(h.items) === r.signature;
      if (!active) reserves.delete(holdId);
      else if (holdId !== exceptHold) sum += r.amountCenti;
    }
    return sum;
  };
  const balanceDto = (c: { id: string; phone: string }) => {
    const bal = balanceOf(c.phone);
    const reserved = reservedOf(c.id);
    const acc = ACCOUNTS[c.phone];
    return {
      balanceCenti: bal, availableCenti: Math.max(0, Math.max(0, bal) - reserved), reservedCenti: reserved,
      nextExpiry: acc?.nextExpiryDays != null ? { at: new Date(Date.now() + acc.nextExpiryDays * DAY).toISOString(), centi: acc.nextExpiryCenti } : null,
      preBookingBlocked: bal <= -5_000, accrualBasis: 'planned' as const,
    };
  };

  app.post('/__test/commerce-reset', async () => {
    reserves.clear();
    replays.clear();
    return { ok: true };
  });

  // Ворота записи на создании удержания известным клиентом (hold.ts, K15 §8): −50 → LOYALTY_LIMIT_REACHED.
  app.addHook('preHandler', async (req, reply) => {
    if (req.method !== 'POST' || req.url.split('?')[0] !== `${P}/holds`) return;
    const c = me(req);
    if (c && balanceOf(c.phone) <= -5_000) return err(reply, 403, 'LOYALTY_LIMIT_REACHED', LIMIT_MESSAGE, { balanceCenti: balanceOf(c.phone) });
  });

  app.get(`${P}/me/loyalty`, async (req, reply) => {
    const c = me(req);
    return c ? balanceDto(c) : deps.fail(reply, 401, 'AUTH_REQUIRED', 'Нужно войти');
  });

  app.get(`${P}/me/loyalty/history`, async (req, reply) => {
    const c = me(req);
    if (!c) return deps.fail(reply, 401, 'AUTH_REQUIRED', 'Нужно войти');
    const q = req.query as { cursor?: string; limit?: string };
    const limit = Math.min(100, Math.max(1, Number(q.limit ?? 50) || 50));
    let after = 0;
    let balance = 0;
    const rows = (ACCOUNTS[c.phone]?.entries ?? []).map((e, i) => {
      balance += e.delta;
      return { i, e, balanceAfter: balance };
    }).reverse();
    if (q.cursor) {
      after = Number(Buffer.from(q.cursor, 'base64url').toString('utf8'));
      if (!Number.isInteger(after)) return deps.fail(reply, 400, 'VALIDATION_FAILED', 'Неверный курсор');
    }
    const from = q.cursor ? rows.filter((r) => r.i < after) : rows;
    const page = from.slice(0, limit);
    const items = [];
    for (const { e, balanceAfter } of page) {
      const base = { at: new Date(Date.now() - e.daysAgo * DAY).toISOString(), branchName: e.branchName, bookingNumber: e.bookingNumber };
      if (e.notReturned) items.push({ ...base, type: 'not_returned', deltaCenti: 0, balanceAfterCenti: balanceAfter, note: `Не возвращено ${e.notReturned / 100} балла: срок партии истёк` });
      items.push({ ...base, type: e.type, deltaCenti: e.delta, balanceAfterCenti: balanceAfter, note: NOTES[e.type] ?? 'Операция' });
    }
    const last = page.at(-1);
    return { items, nextCursor: from.length > limit && last ? Buffer.from(String(last.i)).toString('base64url') : null };
  });

  app.post(`${P}/holds/:holdId/points-reserve`, async (req, reply) => {
    const c = me(req);
    if (!c) return deps.fail(reply, 401, 'AUTH_REQUIRED', 'Нужно войти');
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || !key.trim()) return deps.fail(reply, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'Нужен заголовок Idempotency-Key');
    const prev = replays.get(`${c.id}|${key}`);
    if (prev) return reply.header('idempotent-replay', 'true').code(201).send(prev);
    const holdId = (req.params as { holdId: string }).holdId;
    const h = deps.holdView(holdId);
    if (!h || h.clientId !== c.id || !h.live || h.items.length === 0) return err(reply, 409, 'RESERVE_HOLD_INVALID', 'Удержание истекло, уже подтверждено или не ваше');
    const bal = balanceOf(c.phone);
    if (bal <= -5_000) return err(reply, 403, 'LOYALTY_LIMIT_REACHED', LIMIT_MESSAGE, { balanceCenti: bal });
    const denied = h.items.find((i) => !POINTS_TYPES.includes(i.type));
    if (denied) return err(reply, 422, 'POINTS_NOT_ALLOWED', 'Этот вид посещения баллами не оплачивается', { resourceType: denied.type });
    const required = h.items.reduce((s, i) => s + i.minutes, 0) * 100;
    const available = Math.max(0, Math.max(0, bal) - reservedOf(c.id, holdId));
    if (available < required) return err(reply, 409, 'POINTS_INSUFFICIENT', 'Баллов недостаточно для оплаты выбранного времени', { availableCenti: available, requiredCenti: required });
    const body = { reserveId: randomUUID(), amountCenti: required, availableCenti: available - required };
    reserves.set(holdId, { clientId: c.id, amountCenti: required, signature: signature(h.items), reserveId: body.reserveId });
    replays.set(`${c.id}|${key}`, body);
    return reply.code(201).send(body);
  });

  app.delete(`${P}/holds/:holdId/points-reserve`, async (req, reply) => {
    const c = me(req);
    if (!c) return deps.fail(reply, 401, 'AUTH_REQUIRED', 'Нужно войти');
    const holdId = (req.params as { holdId: string }).holdId;
    reservedOf(c.id); // снять лениво то, что уже не держит баллы
    const released = reserves.get(holdId)?.clientId === c.id;
    if (released) reserves.delete(holdId);
    return { released };
  });

  app.get(`${P}/goods`, async (req, reply) => {
    if (!me(req)) return deps.fail(reply, 401, 'AUTH_REQUIRED', 'Нужно войти');
    return {
      items: [
        { id: '0b0a0000-0000-4000-8000-000000000001', name: 'Энергетик 0,45 л', description: 'Выдаётся на стойке клуба', imageUrl: null, priceRubKop: 15_000, pricePointsCenti: 15_000, available: true },
        { id: '0b0a0000-0000-4000-8000-000000000002', name: 'Брелок Ю-Клуб', description: 'Металл, эмаль', imageUrl: null, priceRubKop: 30_000, pricePointsCenti: 25_000, available: false },
      ],
    };
  });

  const certsOf = (phone: string) => CERTS[phone] ?? [];
  const certBalance = (c: (typeof CERTS)[string][number]) => c.entries.reduce((s, e) => s + e.amount, 0);
  app.get(`${P}/me/certificates`, async (req, reply) => {
    const c = me(req);
    if (!c) return deps.fail(reply, 401, 'AUTH_REQUIRED', 'Нужно войти');
    return {
      items: certsOf(c.phone).map((x) => {
        const expired = x.expiresInDays <= 0;
        const bal = certBalance(x);
        const burned = expired ? -(x.entries.find((e) => e.type === 'expire')?.amount ?? -bal) : null;
        const status = expired ? 'expired' : bal <= 0 ? 'used_up' : bal < x.nominal ? 'partially_used' : 'active';
        return {
          number: x.number, nominalKop: x.nominal, balanceKop: expired ? 0 : bal, soldAt: new Date(Date.now() - x.soldDaysAgo * DAY).toISOString(),
          expiresOn: new Date(Date.now() + x.expiresInDays * DAY).toISOString().slice(0, 10), status, burnedKop: burned,
        };
      }),
    };
  });

  app.get(`${P}/me/certificates/:number/history`, async (req, reply) => {
    const c = me(req);
    if (!c) return deps.fail(reply, 401, 'AUTH_REQUIRED', 'Нужно войти');
    const number = String((req.params as { number: string }).number).toUpperCase().slice(0, 40);
    const cert = certsOf(c.phone).find((x) => x.number === number);
    if (!cert) return deps.fail(reply, 404, 'NOT_FOUND', 'Не найдено');
    let balance = 0;
    return {
      items: cert.entries.map((e) => {
        balance += e.amount;
        return { at: new Date(Date.now() - e.daysAgo * DAY).toISOString(), type: e.type, amountKop: e.amount, balanceAfterKop: balance, branchName: e.branchName };
      }),
    };
  });
}

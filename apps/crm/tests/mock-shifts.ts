// Мок кассовой смены CRM строго по apps/api/src/modules/finance/shift.ts и routes.crm.ts (K17 §7, №49–50, 55–56):
// открыть (одна открытая на филиал, пересчёт вслепую, флаг finance.cash_shift_enabled), закрыть (expected = остаток
// наличных; сошлось и при открытии сошлось – closed, иначе needs_resolution, без проводки), решение Директора или
// Владельца (причина обязательна; при разнице ≠ 0 обе ветки выравнивают кассу операцией в этой смене: correct –
// correction, когда нашли ошибочную операцию; accept – пересчёт признан фактом: расход «Недостача кассы» или доход
// «Излишек кассы»; открытая после неё смена сдвигает opening_expected на разницу), текущая смена с флагом и список.
// Без finance.view (Администратор) – ни expected, ни diff, ни сумм; в списке только свои. Флаг – настройкой мока
// (служебная сессия Владельца); перед каждой командой флаги перечитываются для ворот CASH_SHIFT_REQUIRED кассы.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { cashBalance, recordShiftOperation, setShiftGate } from './mock-finance.ts';

type Rec = Record<string, unknown>;
interface Staffish { id: string; role: string }
interface Zone { network: boolean; cityIds: string[]; branchIds: string[] }
interface BranchLite { id: string; timezone: string }

export interface ShiftsMockDeps {
  current: (req: FastifyRequest) => Staffish;
  zone: (s: Staffish) => Zone;
  can: (s: Staffish, action: string) => boolean;
  branches: () => BranchLite[];
  ownerCookie: () => string;
}

type Status = 'open' | 'closed' | 'needs_resolution' | 'resolved';
interface Shift {
  id: string; branchId: string; status: Status; openedBy: string; openedAt: string; openingCountedKop: number; openingExpectedKop: number;
  closedBy: string | null; closedAt: string | null; closingCountedKop: number | null; closingExpectedKop: number | null;
  resolution: 'correct' | 'accept' | null; resolutionReason: string | null; resolutionOperationId: string | null; rowVersion: number;
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

let shifts: Shift[] = [];
const flags = new Map<string, boolean>(); // finance.cash_shift_enabled по филиалам – перечитывается перед командами
const replays = new Map<string, { hash: string; status: number; body: unknown }>();

export function resetShifts(): void {
  shifts = [];
  flags.clear();
  replays.clear();
}

const dto = (s: Shift) => ({
  ...s,
  openingDiffKop: s.openingCountedKop - s.openingExpectedKop,
  closingDiffKop: s.closingCountedKop !== null && s.closingExpectedKop !== null ? s.closingCountedKop - s.closingExpectedKop : null,
});

export function registerShifts(app: FastifyInstance, P: string, deps: ShiftsMockDeps): void {
  const branchOf = (id: string) => deps.branches().find((b) => b.id === id);
  const inZone = (s: Staffish, branchId: string) => deps.zone(s).network || deps.zone(s).branchIds.includes(branchId);
  /** guardFinance: вне зоны – 404, без права – 403. */
  const guard = (s: Staffish, branchId: string, action: string) => {
    const b = branchOf(branchId);
    if (!b || !inZone(s, branchId) || !deps.can(s, 'finance.view.day')) throw notFound();
    if (!deps.can(s, action)) throw new Fail(403, 'FORBIDDEN', 'Недостаточно прав', { action });
    return b;
  };
  const full = (s: Staffish, branchId: string) => deps.can(s, 'finance.view') && inZone(s, branchId);
  /** №49–50: без finance.view – только id и статус. */
  const shapeCmd = (s: Staffish, x: Shift) => (full(s, x.branchId) ? { shiftId: x.id, ...dto(x) } : { shiftId: x.id, status: x.status });
  /** №55–56: без finance.view – кто и когда, статус. */
  const shapeRead = (s: Staffish, x: Shift) => full(s, x.branchId)
    ? { shiftId: x.id, ...dto(x) }
    : { shiftId: x.id, branchId: x.branchId, status: x.status, openedAt: x.openedAt, openedBy: x.openedBy, closedAt: x.closedAt, closedBy: x.closedBy };
  const enabled = async (branchId: string) => {
    const r = await app.inject({ method: 'GET', url: `${P}/settings?scope=branch&id=${encodeURIComponent(branchId)}`, headers: { cookie: deps.ownerCookie() } });
    const on = (r.json() as { items: Array<{ key: string; value: unknown }> }).items.find((i) => i.key === 'finance.cash_shift_enabled')?.value === true;
    flags.set(branchId, on);
    return on;
  };
  // insertOperation читает флаг и открытую смену в своей транзакции; в моке флаг перечитывается перед любой командой
  setShiftGate((branchId) => (flags.get(branchId) ? (shifts.find((x) => x.branchId === branchId && x.status === 'open')?.id ?? null) : undefined));
  app.addHook('preHandler', async (req) => {
    if (req.method === 'GET' || req.url.startsWith(`${P}/settings`) || req.url.startsWith(`${P}/auth`) || req.url.startsWith('/__test')) return;
    for (const b of deps.branches()) await enabled(b.id);
  });
  const counted = (v: unknown) => {
    if (!Number.isSafeInteger(v) || (v as number) < 0) throw zodFail('countedKop');
    return v as number;
  };
  const send = (reply: FastifyReply, e: unknown) => {
    if (!(e instanceof Error) || typeof (e as Fail).status !== 'number') throw e;
    const f = e as Fail;
    return reply.code(f.status).send({ error: { code: f.code, message: f.message, ...(f.details ? { details: f.details } : {}), requestId: randomUUID() } });
  };
  const byId = (id: string | undefined) => {
    const x = UUID_RE.test(id ?? '') ? shifts.find((y) => y.id === id) : undefined;
    if (!x) throw notFound();
    return x;
  };

  function command(op: string, status: number, run: (s: Staffish, p: Record<string, string>, body: Rec) => Promise<unknown>) {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      const s = deps.current(req);
      try {
        const raw = req.headers['idempotency-key'];
        const key = (Array.isArray(raw) ? raw[0] : raw)?.trim();
        if (!key) throw new Fail(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Нужен заголовок Idempotency-Key');
        if (!UUID_RE.test(key)) throw new Fail(400, 'VALIDATION_FAILED', 'Idempotency-Key должен быть UUID', { field: 'Idempotency-Key' });
        const params = req.params as Record<string, string>;
        const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? (req.body as Rec) : {};
        const hash = JSON.stringify({ params, body });
        const memoKey = `${s.id}:finance.${op}:${key.toLowerCase()}`;
        const prior = replays.get(memoKey);
        if (prior) {
          if (prior.hash !== hash) throw new Fail(409, 'IDEMPOTENCY_KEY_REUSED', 'Этот ключ уже использован для другого запроса');
          return reply.code(prior.status).header('idempotent-replay', 'true').send(prior.body);
        }
        const out = await run(s, params, body);
        replays.set(memoKey, { hash, status, body: out });
        return reply.code(status).send(out);
      } catch (e) {
        return send(reply, e);
      }
    };
  }

  // №49 открыть
  app.post(`${P}/branches/:branchId/cash-shifts/open`, command('shift.open', 201, async (s, p, body) => {
    const n = counted(body.countedKop);
    const b = guard(s, p.branchId ?? '', 'finance.shift.operate');
    if (!(await enabled(b.id))) throw new Fail(400, 'VALIDATION_FAILED', 'Кассовая смена в филиале выключена', { setting: 'finance.cash_shift_enabled' });
    const open = shifts.find((x) => x.branchId === b.id && x.status === 'open');
    if (open) throw new Fail(409, 'CASH_SHIFT_ALREADY_OPEN', 'Смена уже открыта', { shiftId: open.id });
    const x: Shift = {
      id: randomUUID(), branchId: b.id, status: 'open', openedBy: s.id, openedAt: new Date().toISOString(), openingCountedKop: n, openingExpectedKop: cashBalance(b.id),
      closedBy: null, closedAt: null, closingCountedKop: null, closingExpectedKop: null, resolution: null, resolutionReason: null, resolutionOperationId: null, rowVersion: 1,
    };
    shifts.push(x);
    return shapeCmd(s, x);
  }));

  // №49 закрыть: расхождение (при закрытии или при открытии) – needs_resolution
  app.post(`${P}/cash-shifts/:id/close`, command('shift.close', 200, async (s, p, body) => {
    const n = counted(body.countedKop);
    const x = byId(p.id);
    guard(s, x.branchId, 'finance.shift.operate');
    if (x.status !== 'open') throw new Fail(400, 'VALIDATION_FAILED', 'Смена уже закрыта', { status: x.status });
    const expected = cashBalance(x.branchId);
    Object.assign(x, {
      status: n === expected && x.openingCountedKop === x.openingExpectedKop ? 'closed' : 'needs_resolution',
      closedBy: s.id, closedAt: new Date().toISOString(), closingCountedKop: n, closingExpectedKop: expected, rowVersion: x.rowVersion + 1,
    });
    return shapeCmd(s, x);
  }));

  // №50 решение по расхождению
  app.post(`${P}/cash-shifts/:id/resolve`, command('shift.resolve', 200, async (s, p, body) => {
    if (body.action !== 'correct' && body.action !== 'accept') throw zodFail('action');
    if (body.reason !== undefined && (typeof body.reason !== 'string' || body.reason.length > 2000)) throw zodFail('reason');
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (reason === '') throw new Fail(422, 'COMMENT_REQUIRED', 'Укажите комментарий', { field: 'reason' });
    const x = byId(p.id);
    const b = guard(s, x.branchId, 'finance.shift.resolve');
    if (x.status !== 'needs_resolution') throw new Fail(400, 'VALIDATION_FAILED', 'Расхождения нет или оно уже решено', { status: x.status });
    let operation: Rec | null = null;
    const diff = dto(x).closingDiffKop ?? 0;
    if (body.action === 'correct' && diff === 0) throw new Fail(400, 'VALIDATION_FAILED', 'При закрытии сошлось – решение «принять» (без проводки)', { field: 'action' });
    if (diff !== 0) {
      operation = recordShiftOperation({ branchId: b.id, timezone: b.timezone, action: body.action, diffKop: diff, comment: reason, authorId: s.id, shiftId: x.id }) as unknown as Rec;
      const next = shifts.find((y) => y.branchId === b.id && y.status === 'open' && x.closedAt !== null && y.openedAt >= x.closedAt);
      if (next) Object.assign(next, { openingExpectedKop: next.openingExpectedKop + diff, rowVersion: next.rowVersion + 1 });
    }
    Object.assign(x, { status: 'resolved', resolution: body.action, resolutionReason: reason, resolutionOperationId: (operation?.id as string | undefined) ?? null, rowVersion: x.rowVersion + 1 });
    return { shift: shapeCmd(s, x), operation };
  }));

  // №55 текущая смена и флаг
  app.get(`${P}/branches/:branchId/cash-shifts/current`, async (req, reply) => {
    const s = deps.current(req);
    try {
      const b = guard(s, (req.params as { branchId: string }).branchId, 'finance.shift.operate');
      const open = shifts.find((x) => x.branchId === b.id && x.status === 'open');
      return { enabled: await enabled(b.id), openShift: open ? shapeRead(s, open) : null };
    } catch (e) {
      return send(reply, e);
    }
  });

  // №56 список: новые сверху; без finance.view – только свои
  app.get(`${P}/branches/:branchId/cash-shifts`, async (req, reply) => {
    const s = deps.current(req);
    try {
      const b = guard(s, (req.params as { branchId: string }).branchId, 'finance.shift.operate');
      const q = req.query as Record<string, string | undefined>;
      if (q.status !== undefined && !['open', 'closed', 'needs_resolution', 'resolved'].includes(q.status)) throw zodFail('status');
      if (q.cursor !== undefined && !/^\d{1,16}:[0-9a-f-]{36}$/i.test(q.cursor)) throw zodFail('cursor');
      const limit = q.limit === undefined ? 50 : Number(q.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw zodFail('limit');
      const [cms, cid] = q.cursor ? [Number(q.cursor.split(':')[0]), q.cursor.slice(q.cursor.indexOf(':') + 1)] : [null, null];
      const all = shifts
        .filter((x) => x.branchId === b.id && (!q.status || x.status === q.status) && (full(s, b.id) || x.openedBy === s.id || x.closedBy === s.id))
        .sort((x, y) => Date.parse(y.openedAt) - Date.parse(x.openedAt) || y.id.localeCompare(x.id))
        .filter((x) => cms === null || Date.parse(x.openedAt) < cms || (Date.parse(x.openedAt) === cms && x.id < cid!));
      const items = all.slice(0, limit);
      const last = items.at(-1);
      return { items: items.map((x) => shapeRead(s, x)), nextCursor: all.length > limit && last ? `${Date.parse(last.openedAt)}:${last.id}` : null };
    } catch (e) {
      return send(reply, e);
    }
  });
}

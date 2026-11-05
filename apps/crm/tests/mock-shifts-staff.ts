// Мок смен сотрудников и зарплаты строго по apps/api/src/modules/shifts/routes.crm.ts и routes.payroll.ts (K18 №301–318).
// Не путать с mock-shifts.ts – там кассовая смена. Права – как K1 §12: вне зоны – 404, в зоне без права – 403; без payroll.view суммы
// смены null, Администратору весь раздел зарплаты – 403. Начисление в моке проводится сразу (в API – обработчиком события), суммы – целые
// копейки. Флаг payroll.penalties_enabled читается из мока настроек; без него – FEATURE_DISABLED. Подключается из mock-api.ts.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { addDays, inZone, zonedIso } from '../src/lib/booking.ts';

export type Rec = Record<string, unknown>;
export type ShiftStatus = 'planned' | 'worked' | 'no_show' | 'cancelled' | 'needs_review';
export type StatementStatus = 'draft' | 'calculated' | 'checked' | 'ready' | 'paid' | 'disputed';
export interface Staffish { id: string; role: string }
interface Zone { network: boolean; cityIds: string[]; branchIds: string[] }
interface BranchLite { id: string; cityId: string; timezone: string; name: string; weeklyHours: Array<{ weekday: number; open: string | null; close: string | null }> }
interface StaffLite extends Staffish { firstName: string; lastName: string; branchIds: string[]; cityIds: string[]; status?: string; rowVersion?: number; planningStatus?: 'available' | 'on_leave' }

export interface ShiftsStaffMockDeps {
  current: (req: FastifyRequest) => Staffish;
  zone: (s: Staffish) => Zone;
  can: (s: Staffish, action: string) => boolean;
  branches: () => BranchLite[];
  staff: () => StaffLite[];
  audit: (s: Staffish, objectType: string, objectId: string, action: string, before: object, after: object, reason?: string | null) => void;
  ownerCookie: () => string;
}

/** Строки K1 §12, которые добавляет этот мок в действия ролей (core/permissions.ts). */
const OWN = ['shift.view.own', 'shift.plan.own', 'shift.attendance.self', 'shift.view'];
const OD = [...OWN, 'shift.manage', 'shift.outside_hours', 'shift.attendance.correct', 'staff.planning_status', 'payroll.view', 'payroll.penalty.manage', 'payroll.statement.review'];
export const SHIFT_ACTIONS: Record<'owner' | 'director' | 'admin', string[]> = {
  owner: [...OD, 'payroll.rate.manage', 'payroll.bonus.manage', 'payroll.period.manage', 'payroll.statement.ready', 'payroll.payout.mark', 'payroll.correct', 'payroll.payout.expense'],
  director: OD,
  admin: OWN,
};

export interface Shift {
  id: string; staffId: string; branchId: string; localDate: string; start: string; end: string; status: ShiftStatus;
  factStart: string | null; factEnd: string | null; paidMinutes: number | null; source: 'fact_time' | 'manual' | null; factVersion: number;
  outsideHours: boolean; unpaid: boolean; reviewReason: string | null; comment: string | null; createdBy: string; rowVersion: number;
}
interface Rate { id: string; staffId: string; validFrom: string; hourlyKop: number; attendanceFeeKop: number; corrects: string | null; reason: string; createdBy: string; createdAt: string }
export interface Period { id: string; from: string; to: string; status: 'open' | 'closed'; closedAt: string | null; closedBy: string | null }
export interface Entry { id: string; staffId: string; date: string; type: string; kind: string; branchId: string | null; amountKop: number; basis: string | null; ref: { type: string; id: string } | null }
export interface Totals { plannedShifts: number; workedShifts: number; noShows: number; plannedMinutes: number; paidMinutes: number; forecastKop: number; accruedKop: number; hourlyPartKop: number; feePartKop: number; penaltiesKop: number; bonusesKop: number; correctionsKop: number; toPayKop: number }
export interface BranchLine { branchId: string; workedShifts: number; paidMinutes: number; accruedKop: number }
export interface Statement { id: string; periodId: string; staffId: string; status: StatementStatus; totals: Totals; byBranch: BranchLine[]; plannedPayoutDate: string | null; actualPayoutDate: string | null; payoutComment: string | null; rowVersion: number }
export interface Penalty { id: string; kind: 'penalty' | 'bonus'; staffId: string; branchId: string | null; date: string; amountKop: number; reason: string; comment: string | null; status: 'active' | 'cancelled'; periodId: string | null; authorId: string; postingId: string; cancelReason: string | null; replacedBy: string | null }
interface Change { id: string; shiftId: string; changedBy: string; changedAt: string; kind: string; before: unknown; after: unknown; reason: string | null; acknowledgedAt: string | null }
interface Ev { id: string; at: string; action: string; objectType: string; objectId: string; actorType: string; actorId: string; branchId: string | null; before: unknown; after: unknown; reason: string | null; result: string }

export class Fail extends Error {
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
export const notFound = () => new Fail(404, 'NOT_FOUND', 'Не найдено');
export const forbidden = (action: string) => new Fail(403, 'FORBIDDEN', 'Недостаточно прав', { action });
export const invalid = (message = 'Неверные данные запроса', details?: Rec) => new Fail(400, 'VALIDATION_FAILED', message, details);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 31;
export const TZ = 'Asia/Novosibirsk';
const FEE_MIN_MINUTES = 120;
const EARLY_MINUTES = 30;
const SELF_DEADLINE_HOURS = 24;

export let shifts: Shift[] = [];
let rates: Rate[] = [];
export let periods: Period[] = [];
export let entries: Entry[] = [];
export let statements: Statement[] = [];
export let penalties: Penalty[] = [];
let changes: Change[] = [];
let events: Ev[] = [];
export let expenses = new Map<string, string[]>();
const leave = new Set<string>(); // staff.planning_status = on_leave
let seq = 1;
export const nextSeq = () => seq++;
const replays = new Map<string, { hash: string; status: number; body: unknown }>();

export const rateAt = (staffId: string, date: string): Rate | null => {
  const list = rates.map((r, i) => ({ r, i })).filter((x) => x.r.staffId === staffId && x.r.validFrom <= date);
  list.sort((a, b) => (a.r.validFrom === b.r.validFrom ? b.i - a.i : a.r.validFrom < b.r.validFrom ? 1 : -1));
  return list[0]?.r ?? null;
};
/** accrualParts: до копейки, половина вверх; ставка за выход – от порога минут (K18 §6). */
export const parts = (minutes: number, r: { hourlyKop: number; attendanceFeeKop: number }) => {
  const hourlyPartKop = Math.floor((minutes * r.hourlyKop + 30) / 60);
  const feePartKop = minutes >= FEE_MIN_MINUTES ? r.attendanceFeeKop : 0;
  return { hourlyPartKop, feePartKop, totalKop: hourlyPartKop + feePartKop };
};
export const minutesOf = (s: Shift) => Math.round((Date.parse(s.end) - Date.parse(s.start)) / 60_000);
export const accrualOf = (shiftId: string) => entries.filter((e) => e.kind === 'payroll.accrual' && e.ref?.id === shiftId);
export const periodOf = (date: string) => periods.find((p) => p.from <= date && date <= p.to) ?? null;
export const assertOpen = (date: string, message = 'Расчётный период закрыт: исправление – корректировкой в открытом периоде') => {
  const p = periodOf(date);
  if (p?.status === 'closed') throw new Fail(409, 'PAYROLL_PERIOD_CLOSED', message, { periodId: p.id });
};
/** Начисление по текущему факту: прежняя запись снимается, новая проводится (K18 §6, обработчик shift.attendance_changed). */
function accrue(s: Shift): void {
  entries = entries.filter((e) => !(e.kind === 'payroll.accrual' && e.ref?.id === s.id));
  if (s.status !== 'worked' || s.unpaid || s.paidMinutes === null) return;
  const r = rateAt(s.staffId, s.localDate);
  if (!r) return;
  entries.push({ id: String(seq++), staffId: s.staffId, date: s.localDate, type: 'payroll.accrual', kind: 'payroll.accrual', branchId: s.branchId, amountKop: parts(s.paidMinutes, r).totalKop, basis: null, ref: { type: 'shift', id: s.id } });
}

export function dto(s: Shift, tz: string) {
  const r = rateAt(s.staffId, s.localDate);
  const live = s.status !== 'cancelled' && s.status !== 'no_show';
  const fact = accrualOf(s.id).reduce((a, e) => a + e.amountKop, 0);
  return {
    id: s.id, staffId: s.staffId, branchId: s.branchId, timezone: tz, localDate: s.localDate, plannedStart: s.start, plannedEnd: s.end, plannedMinutes: minutesOf(s),
    status: s.status, factStart: s.factStart, factEnd: s.factEnd, paidMinutes: s.paidMinutes, paidMinutesSource: s.source,
    flags: { rateMissing: live && !s.unpaid && !r, unpaidConfirmed: s.unpaid, outsideHours: s.outsideHours, reviewReason: s.reviewReason },
    plannedAccrualKop: r ? parts(minutesOf(s), r).totalKop : null,
    factAccrualKop: s.status === 'worked' && accrualOf(s.id).length > 0 ? fact : null,
    factVersion: s.factVersion, comment: s.comment, createdBy: s.createdBy, rowVersion: s.rowVersion,
  };
}

/** unresolvedShifts (payroll.ts): now = null – любая плановая смена считается нерешённой (закрытие). */
export function unresolved(range: { from: string; to: string }, now: number | null, staffId?: string) {
  const out: Array<{ shiftId: string; staffId: string; branchId: string; reason: string }> = [];
  for (const s of shifts) {
    if (s.localDate < range.from || s.localDate > range.to || (staffId && s.staffId !== staffId)) continue;
    let reason: string | null = null;
    if (s.status === 'needs_review') reason = 'needs_review';
    else if (s.status === 'planned' && (now === null || Date.parse(s.end) <= now)) reason = 'no_fact';
    else if (s.status === 'worked' && !s.unpaid && !rateAt(s.staffId, s.localDate)) reason = 'rate_missing';
    if (reason) out.push({ shiftId: s.id, staffId: s.staffId, branchId: s.branchId, reason });
  }
  return out;
}

const ZERO: Totals = { plannedShifts: 0, workedShifts: 0, noShows: 0, plannedMinutes: 0, paidMinutes: 0, forecastKop: 0, accruedKop: 0, hourlyPartKop: 0, feePartKop: 0, penaltiesKop: 0, bonusesKop: 0, correctionsKop: 0, toPayKop: 0 };
export function computeTotals(range: { from: string; to: string }, staffId: string, zone?: string[]): { totals: Totals; byBranch: BranchLine[] } {
  const totals = { ...ZERO };
  const lines = new Map<string, BranchLine>();
  const inZ = (b: string | null) => !zone || (b !== null && zone.includes(b));
  for (const s of shifts) {
    if (s.staffId !== staffId || s.localDate < range.from || s.localDate > range.to || s.status === 'cancelled' || !inZ(s.branchId)) continue;
    totals.plannedShifts += 1;
    totals.plannedMinutes += minutesOf(s);
    if (s.status === 'no_show') totals.noShows += 1;
    if (s.status === 'planned') {
      const r = rateAt(s.staffId, s.localDate);
      if (r) totals.forecastKop += parts(minutesOf(s), r).totalKop;
    }
    if (s.status === 'worked') {
      totals.workedShifts += 1;
      totals.paidMinutes += s.paidMinutes ?? 0;
      const l = lines.get(s.branchId) ?? { branchId: s.branchId, workedShifts: 0, paidMinutes: 0, accruedKop: 0 };
      l.workedShifts += 1;
      l.paidMinutes += s.paidMinutes ?? 0;
      lines.set(s.branchId, l);
      const r = rateAt(s.staffId, s.localDate);
      if (r && !s.unpaid) {
        const p = parts(s.paidMinutes ?? 0, r);
        totals.hourlyPartKop += p.hourlyPartKop;
        totals.feePartKop += p.feePartKop;
      }
    }
  }
  for (const e of entries) {
    if (e.staffId !== staffId || e.date < range.from || e.date > range.to || !inZ(e.branchId)) continue;
    if (e.kind === 'payroll.accrual') {
      totals.accruedKop += e.amountKop;
      if (e.branchId) {
        const l = lines.get(e.branchId) ?? { branchId: e.branchId, workedShifts: 0, paidMinutes: 0, accruedKop: 0 };
        l.accruedKop += e.amountKop;
        lines.set(e.branchId, l);
      }
    } else if (e.kind === 'payroll.penalty') totals.penaltiesKop -= e.amountKop;
    else if (e.kind === 'payroll.bonus') totals.bonusesKop += e.amountKop;
    else if (e.kind === 'payroll.correction') totals.correctionsKop += e.amountKop;
  }
  totals.toPayKop = totals.accruedKop - totals.penaltiesKop + totals.bonusesKop + totals.correctionsKop;
  return { totals, byBranch: [...lines.values()] };
}

/** Засев: период закрыт [D−40; D−11], открыт [D−10; D+20]; D – сегодня по Новосибирску. */
export function resetShiftsStaff(): void {
  const D = inZone(Date.now(), TZ).date;
  const at = (date: string, hm: string) => zonedIso(date, hm, TZ);
  const now = Date.now();
  const nowDate = inZone(now, TZ).date;
  const blank = { factStart: null, factEnd: null, paidMinutes: null, source: null, factVersion: 0, outsideHours: false, unpaid: false, reviewReason: null, comment: null, createdBy: 's-owner', rowVersion: 1 };
  const plan = (id: string, staffId: string, branchId: string, date: string, from: string, to: string, status: ShiftStatus = 'planned', extra: Partial<Shift> = {}): Shift =>
    ({ ...blank, id, staffId, branchId, localDate: date, start: at(date, from), end: at(date, to), status, ...extra });
  const worked = (id: string, staffId: string, branchId: string, date: string, from: string, to: string): Shift => {
    const minutes = Math.round((Date.parse(at(date, to)) - Date.parse(at(date, from))) / 60_000);
    return plan(id, staffId, branchId, date, from, to, 'worked', { factStart: at(date, from), factEnd: at(date, to), paidMinutes: minutes, source: 'fact_time', factVersion: 1 });
  };
  periods = [
    { id: 'p-closed', from: addDays(D, -40), to: addDays(D, -11), status: 'closed', closedAt: at(addDays(D, -10), '12:00'), closedBy: 's-owner' },
    { id: 'p-open', from: addDays(D, -10), to: addDays(D, 20), status: 'open', closedAt: null, closedBy: null },
  ];
  const rate = (id: string, staffId: string, validFrom: string, hourlyKop: number, attendanceFeeKop: number, reason: string): Rate =>
    ({ id, staffId, validFrom, hourlyKop, attendanceFeeKop, corrects: null, reason, createdBy: 's-owner', createdAt: at(validFrom, '09:00') });
  rates = [
    rate('r-admin-1', 's-admin', addDays(D, -60), 30000, 50000, 'Приём на работу'),
    rate('r-admin-2', 's-admin', addDays(D, -5), 35050, 50000, 'Повышение'),
    rate('r-tsk', 's-admin-tsk', addDays(D, -60), 28000, 40000, 'Приём на работу'),
    rate('r-fresh', 's-fresh', addDays(D, -60), 30000, 0, 'Приём на работу'),
  ];
  const adminNow: Shift = { ...blank, id: 'sh-now', staffId: 's-admin', branchId: 'b-nsk-krasny', localDate: nowDate, start: new Date(now - 10 * 60_000).toISOString(), end: new Date(now + 60 * 60_000).toISOString(), status: 'planned' };
  shifts = [
    worked('sh-closed-admin', 's-admin', 'b-nsk-krasny', addDays(D, -15), '10:00', '18:00'),
    worked('sh-closed-tsk', 's-admin-tsk', 'b-tsk-lenina', addDays(D, -15), '10:00', '18:00'),
    worked('sh-worked', 's-admin', 'b-nsk-krasny', addDays(D, -1), '10:00', '18:00'),
    plan('sh-review', 's-fresh', 'b-nsk-krasny', addDays(D, -1), '10:00', '18:00', 'needs_review', { reviewReason: 'no_checkout' }),
    plan('sh-past', 's-fresh', 'b-nsk-krasny', addDays(D, -2), '10:00', '14:00', 'planned', { comment: 'Подмена на утро' }),
    worked('sh-rateless', 's-two', 'b-nsk-krasny', addDays(D, -3), '10:00', '14:00'),
    adminNow,
    plan('sh-future', 's-admin', 'b-nsk-krasny', addDays(D, 3), '10:00', '14:00'),
    plan('sh-fresh-next', 's-fresh', 'b-nsk-krasny', addDays(D, 1), '14:00', '18:00'),
    plan('sh-tsk', 's-admin-tsk', 'b-tsk-lenina', addDays(D, 1), '10:00', '22:00'),
  ];
  entries = [];
  seq = 1;
  for (const s of shifts) accrue(s);
  const closedRange = { from: periods[0]!.from, to: periods[0]!.to };
  const statement = (id: string, staffId: string, status: StatementStatus): Statement =>
    ({ id, periodId: 'p-closed', staffId, status, ...computeTotals(closedRange, staffId), plannedPayoutDate: null, actualPayoutDate: null, payoutComment: null, rowVersion: 1 });
  statements = [statement('st-admin', 's-admin', 'ready'), statement('st-tsk', 's-admin-tsk', 'calculated')];
  penalties = [];
  changes = [{
    id: '1', shiftId: 'sh-future', changedBy: 's-director', changedAt: at(addDays(D, -1), '12:00'), kind: 'updated',
    before: { start: at(addDays(D, 3), '09:00'), end: at(addDays(D, 3), '13:00'), branchId: 'b-nsk-krasny' },
    after: { start: at(addDays(D, 3), '10:00'), end: at(addDays(D, 3), '14:00'), branchId: 'b-nsk-krasny' }, reason: 'Перенос по графику', acknowledgedAt: null,
  }];
  events = [{ id: '1', at: at(addDays(D, -1), '12:00'), action: 'shift.created', objectType: 'shift', objectId: 'sh-past', actorType: 'staff', actorId: 's-director', branchId: 'b-nsk-krasny', before: null, after: { status: 'planned', amountKop: 120000 }, reason: null, result: 'ok' }];
  expenses = new Map();
  leave.clear();
  replays.clear();
}

const MONEY_KEY = /kop$|^toPay|^accrued|^rate$|^rates$|^totals$|^parts$/i;
function maskMoney(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(maskMoney);
  if (v === null || typeof v !== 'object') return v;
  return Object.fromEntries(Object.entries(v as Rec).map(([k, x]) => [k, MONEY_KEY.test(k) ? 'сумма скрыта' : maskMoney(x)]));
}

export function registerShiftsStaff(app: FastifyInstance, P: string, deps: ShiftsStaffMockDeps) {
  const branchOf = (id: string) => deps.branches().find((b) => b.id === id);
  const tzOf = (id: string) => branchOf(id)?.timezone ?? TZ;
  const inZ = (s: Staffish, b: string) => deps.zone(s).network || deps.zone(s).branchIds.includes(b);
  const can = (s: Staffish, action: string, b: string) => deps.can(s, action) && inZ(s, b);
  /** assertCan: вне зоны – 404, в зоне без права – 403. */
  const assertCan = (s: Staffish, action: string, b: string) => {
    if (!inZ(s, b)) throw notFound();
    if (!deps.can(s, action)) throw forbidden(action);
  };
  const owner = (s: Staffish, action: string) => {
    if (!deps.can(s, action)) throw forbidden(action);
  };
  const out = (s: Staffish, x: Shift) => {
    const d = dto(x, tzOf(x.branchId));
    return can(s, 'payroll.view', x.branchId) ? d : { ...d, plannedAccrualKop: null, factAccrualKop: null };
  };
  const view = (s: Staffish, x: Shift) => x.staffId === s.id || can(s, 'shift.view', x.branchId);
  const findShift = (id: string) => {
    const x = shifts.find((y) => y.id === id);
    if (!x) throw notFound();
    return x;
  };
  const staffOf = (id: string) => deps.staff().find((x) => x.id === id);
  /** Чтения смен (routes.crm.ts withNames): только имя – без фамилии, контактов и ставок. */
  const withName = (s: Staffish, x: Shift) => ({ ...out(s, x), staffName: staffOf(x.staffId)?.firstName ?? '' });
  const staffBranches = (t: StaffLite) => deps.branches().filter((b) => t.branchIds.includes(b.id) || t.cityIds.includes(b.cityId)).map((b) => b.id);
  const reasonOf = (v: unknown, field = 'reason') => {
    const t = typeof v === 'string' ? v.trim() : '';
    if (!t) throw new Fail(422, 'COMMENT_REQUIRED', 'Укажите причину', { field });
    return t;
  };
  const log = (s: Staffish, action: string, objectType: string, objectId: string, branchId: string | null, before: unknown, after: unknown, reason: string | null = null) =>
    events.push({ id: String(events.length + 2), at: new Date().toISOString(), action, objectType, objectId, actorType: 'staff', actorId: s.id, branchId, before, after, reason, result: 'ok' });
  const send = (reply: FastifyReply, e: unknown) => {
    if (!(e instanceof Fail)) throw e;
    return reply.code(e.status).send({ error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}), requestId: randomUUID() } });
  };

  function command(op: string, status: number, run: (s: Staffish, p: Record<string, string>, body: Rec) => unknown | Promise<unknown>) {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      const s = deps.current(req);
      try {
        if (op.startsWith('payroll.') && !deps.can(s, 'payroll.view')) throw forbidden('payroll.view');
        const raw = req.headers['idempotency-key'];
        const key = (Array.isArray(raw) ? raw[0] : raw)?.trim();
        if (!key) throw new Fail(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Нужен заголовок Idempotency-Key');
        if (!UUID_RE.test(key)) throw new Fail(400, 'VALIDATION_FAILED', 'Idempotency-Key должен быть UUID', { field: 'Idempotency-Key' });
        const params = req.params as Record<string, string>;
        const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? (req.body as Rec) : {};
        const hash = JSON.stringify({ params, body });
        const memo = `${s.id}:${op}:${key.toLowerCase()}`;
        const prior = replays.get(memo);
        if (prior) {
          if (prior.hash !== hash) throw new Fail(409, 'IDEMPOTENCY_KEY_REUSED', 'Этот ключ уже использован для другого запроса');
          return reply.code(prior.status).header('idempotent-replay', 'true').send(prior.body);
        }
        const result = await run(s, params, body);
        replays.set(memo, { hash, status, body: result });
        return reply.code(status).send(result);
      } catch (e) {
        return send(reply, e);
      }
    };
  }
  const read = (run: (s: Staffish, req: FastifyRequest) => unknown | Promise<unknown>) => async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      return await run(deps.current(req), req);
    } catch (e) {
      return send(reply, e);
    }
  };
  const viewer = (s: Staffish) => {
    if (!deps.can(s, 'payroll.view')) throw forbidden('payroll.view');
  };

  // ---- смены

  const dateRange = (from: unknown, to: unknown, max = MAX_DAYS) => {
    if (typeof from !== 'string' || typeof to !== 'string' || !DATE_RE.test(from) || !DATE_RE.test(to) || from > to || addDays(from, max - 1) < to) {
      throw invalid(`Период – даты ГГГГ-ММ-ДД, не больше ${max} дней`, { maxDays: max });
    }
    return { from, to };
  };
  const iso = (v: unknown, field: string) => {
    if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) throw invalid('Неверные данные запроса', { issues: [{ path: field, message: 'Invalid input' }] });
    return new Date(v).toISOString();
  };
  const openOf = (b: BranchLite, date: string) => {
    const weekday = ((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
    const h = b.weeklyHours.find((x) => x.weekday === weekday);
    return h?.open && h.close ? [{ start: zonedIso(date, h.open, b.timezone), end: zonedIso(date, h.close, b.timezone) }] : [];
  };
  /** assertSlot: тот же порядок проверок, что K18 §4. */
  function assertSlot(s: Staffish, v: { staffId: string; branch: BranchLite; start: string; end: string; selfId: string | null }): { date: string; outside: boolean } {
    const t = staffOf(v.staffId);
    if (!t) throw notFound();
    const date = inZone(v.start, v.branch.timezone).date;
    if (Date.parse(v.start) >= Date.parse(v.end)) throw new Fail(422, 'INVALID_DURATION', 'Начало смены должно быть раньше конца');
    if ((t.status ?? 'active') !== 'active') throw new Fail(409, 'STAFF_NOT_ACTIVE', 'Сотрудник заблокирован или в архиве');
    if (leave.has(v.staffId)) throw new Fail(409, 'STAFF_ON_LEAVE', 'Сотрудник временно не работает');
    if (t.role !== 'owner' && !staffBranches(t).includes(v.branch.id)) throw new Fail(422, 'STAFF_NOT_ASSIGNED', 'Сотрудник не назначен на этот филиал на эту дату');
    if (inZone(new Date(Date.parse(v.end) - 1), v.branch.timezone).date !== date) throw new Fail(422, 'INVALID_DURATION', 'Смена не переходит через полночь');
    const open = openOf(v.branch, date);
    const inside = open.some((i) => Date.parse(i.start) <= Date.parse(v.start) && Date.parse(v.end) <= Date.parse(i.end));
    if (!inside && !can(s, 'shift.outside_hours', v.branch.id)) throw new Fail(409, 'OUTSIDE_SCHEDULE', 'Вне графика филиала нужно отдельное разрешение', { open });
    const conflict = shifts.find((x) => x.staffId === v.staffId && x.id !== v.selfId && ['planned', 'worked', 'needs_review'].includes(x.status) && Date.parse(x.start) < Date.parse(v.end) && Date.parse(v.start) < Date.parse(x.end));
    if (conflict) throw new Fail(409, 'SHIFT_OVERLAP', 'Смена пересекается с другой сменой сотрудника', { conflictShiftId: conflict.id, ...(can(s, 'shift.view', conflict.branchId) ? { branchId: conflict.branchId } : {}) });
    if (v.staffId === s.id) assertDeadline(v.start);
    const p = periodOf(date);
    if (p?.status === 'closed') throw new Fail(409, 'PAYROLL_PERIOD_CLOSED', 'Расчётный период закрыт', { periodId: p.id });
    return { date, outside: !inside };
  }
  const assertDeadline = (start: string) => {
    if (Date.parse(start) < Date.now() + SELF_DEADLINE_HOURS * 3_600_000) throw new Fail(409, 'SHIFT_EDIT_DEADLINE', 'Изменить свою смену можно не позже срока', { deadlineHours: SELF_DEADLINE_HOURS });
  };
  const guardPlan = (s: Staffish, staffId: string, branchId: string) => assertCan(s, staffId === s.id ? 'shift.plan.own' : 'shift.manage', branchId);
  const assertEditable = (s: Staffish, x: Shift) => {
    const no = (why: string) => new Fail(409, 'SHIFT_NOT_EDITABLE', why, { status: x.status });
    if (x.status === 'cancelled') throw no('Смена отменена');
    if ((x.status === 'worked' || x.status === 'no_show') && !can(s, 'shift.attendance.correct', x.branchId)) throw no('Смену с фактом исправляет руководитель');
    if (x.staffId === s.id && Date.parse(x.start) <= Date.now() && !can(s, 'shift.attendance.correct', x.branchId)) throw no('Прошедшую смену исправляет руководитель');
  };
  const foreign = (s: Staffish, x: Shift, kind: string, before: unknown, after: unknown, reason: string | null) => {
    if (x.staffId !== s.id) changes.push({ id: String(changes.length + 2), shiftId: x.id, changedBy: s.id, changedAt: new Date().toISOString(), kind, before, after, reason, acknowledgedAt: null });
  };
  const version = (x: Shift, v: unknown) => {
    if (x.rowVersion !== v) throw new Fail(409, 'VERSION_CONFLICT', 'Смену уже изменили, обновите данные', { rowVersion: x.rowVersion });
  };

  app.get(`${P}/shifts`, read((s, req) => {
    const q = req.query as Record<string, string | undefined>;
    if (!q.from || !q.to) throw invalid('Нужны даты from и to');
    const range = dateRange(q.from, q.to);
    const ids = q.branchIds ? q.branchIds.split(',').filter(Boolean) : [];
    for (const id of ids) if (!can(s, 'shift.view', id)) throw notFound();
    const items = shifts
      .filter((x) => x.localDate >= range.from && x.localDate <= range.to && view(s, x) && (ids.length === 0 || ids.includes(x.branchId)) && (!q.staffId || x.staffId === q.staffId) && (!q.status || x.status === q.status))
      .sort((a, b) => a.start.localeCompare(b.start));
    return { items: items.map((x) => withName(s, x)) };
  }));
  app.get(`${P}/shifts/coverage`, read((s, req) => {
    const q = req.query as Record<string, string | undefined>;
    if (!q.from || !q.to || !DATE_RE.test(q.from) || !DATE_RE.test(q.to)) throw invalid('Нужны филиалы и даты from, to');
    const range = dateRange(q.from, q.to);
    const res: unknown[] = [];
    for (const id of (q.branchIds ?? '').split(',').filter(Boolean)) {
      const b = branchOf(id);
      if (!b) throw notFound();
      assertCan(s, 'shift.view', id);
      res.push(...coverageOf(b, range));
    }
    return res;
  }));
  function coverageOf(b: BranchLite, range: { from: string; to: string }) {
    const res: Array<{ branchId: string; date: string; timezone: string; open: unknown[]; covered: unknown[]; gaps: Array<{ start: string; end: string }>; state: string }> = [];
    for (let date = range.from; date <= range.to; date = addDays(date, 1)) {
      const open = openOf(b, date);
      if (open.length === 0) {
        res.push({ branchId: b.id, date, timezone: b.timezone, open, covered: [], gaps: [], state: 'closed' });
        continue;
      }
      const busy = shifts.filter((x) => x.branchId === b.id && x.localDate === date && ['planned', 'worked', 'needs_review'].includes(x.status)).sort((x, y) => x.start.localeCompare(y.start));
      const gaps: Array<{ start: string; end: string }> = [];
      const covered: Array<{ start: string; end: string }> = [];
      for (const o of open) {
        let cursor = o.start;
        for (const x of busy) {
          const a = x.start > cursor ? x.start : cursor;
          const e = x.end < o.end ? x.end : o.end;
          if (a >= e) continue;
          if (a > cursor) gaps.push({ start: cursor, end: a });
          covered.push({ start: a, end: e });
          cursor = e;
        }
        if (cursor < o.end) gaps.push({ start: cursor, end: o.end });
      }
      res.push({ branchId: b.id, date, timezone: b.timezone, open, covered, gaps, state: covered.length === 0 ? 'empty' : gaps.length === 0 ? 'full' : 'partial' });
    }
    return res;
  }
  app.get(`${P}/shifts/:id`, read((s, req) => {
    const x = shifts.find((y) => y.id === (req.params as { id: string }).id);
    if (!x || !view(s, x)) throw notFound();
    return withName(s, x);
  }));
  app.get(`${P}/shifts/:id/timeline`, async (req, reply) => {
    const s = deps.current(req);
    try {
      const x = shifts.find((y) => y.id === (req.params as { id: string }).id);
      if (!x || !view(s, x)) throw notFound();
      reply.header('cache-control', 'no-store');
      const allowed = (b: string | null) => (b === null ? deps.zone(s).network : can(s, 'payroll.view', b));
      return { items: events.filter((e) => e.objectType === 'shift' && e.objectId === x.id).reverse().map((e) => (allowed(e.branchId) ? e : { ...e, before: maskMoney(e.before), after: maskMoney(e.after) })) };
    } catch (e) {
      return send(reply, e);
    }
  });
  app.post(`${P}/shifts`, command('shifts.create', 201, (s, _p, b) => {
    const start = iso(b.start, 'start');
    const end = iso(b.end, 'end');
    const staffId = String(b.staffId ?? '');
    const branch = branchOf(String(b.branchId ?? ''));
    if (!branch) throw notFound();
    guardPlan(s, staffId, branch.id);
    const { date, outside } = assertSlot(s, { staffId, branch, start, end, selfId: null });
    const comment = typeof b.comment === 'string' && b.comment.trim() ? b.comment.trim() : null;
    const x: Shift = { id: randomUUID(), staffId, branchId: branch.id, localDate: date, start, end, status: 'planned', factStart: null, factEnd: null, paidMinutes: null, source: null, factVersion: 0, outsideHours: outside, unpaid: false, reviewReason: null, comment, createdBy: s.id, rowVersion: 1 };
    shifts.push(x);
    foreign(s, x, 'created', null, { start, end, branchId: branch.id }, comment);
    log(s, 'shift.created', 'shift', x.id, branch.id, null, { staffId, start, end, branchId: branch.id, outsideHours: outside, comment });
    return out(s, x);
  }));
  app.patch(`${P}/shifts/:id`, command('shifts.update', 200, (s, p, b) => {
    const x = findShift(p.id!);
    guardPlan(s, x.staffId, x.branchId);
    const own = x.staffId === s.id;
    const reason = own ? (typeof b.reason === 'string' && b.reason.trim()) || null : reasonOf(b.reason);
    const branch = branchOf(typeof b.branchId === 'string' ? b.branchId : x.branchId);
    if (!branch) throw notFound();
    guardPlan(s, x.staffId, branch.id);
    const start = b.start === undefined ? x.start : iso(b.start, 'start');
    const end = b.end === undefined ? x.end : iso(b.end, 'end');
    version(x, b.rowVersion);
    assertEditable(s, x);
    if (own) assertDeadline(x.start);
    const { date, outside } = assertSlot(s, { staffId: x.staffId, branch, start, end, selfId: x.id });
    const before = { start: x.start, end: x.end, branchId: x.branchId };
    Object.assign(x, { start, end, branchId: branch.id, localDate: date, outsideHours: outside, rowVersion: x.rowVersion + 1 });
    if (x.status === 'worked') accrue(x);
    const after = { start, end, branchId: branch.id };
    foreign(s, x, 'updated', before, after, reason);
    log(s, 'shift.updated', 'shift', x.id, branch.id, before, after, reason);
    return out(s, x);
  }));
  app.post(`${P}/shifts/:id/cancel`, command('shifts.cancel', 200, (s, p, b) => {
    const x = findShift(p.id!);
    guardPlan(s, x.staffId, x.branchId);
    const reason = reasonOf(b.reason);
    version(x, b.rowVersion);
    assertEditable(s, x);
    if (x.staffId === s.id) assertDeadline(x.start);
    assertOpen(x.localDate, 'Расчётный период закрыт');
    const before = { start: x.start, end: x.end, branchId: x.branchId };
    x.status = 'cancelled';
    x.rowVersion += 1;
    accrue(x);
    foreign(s, x, 'cancelled', before, null, reason);
    log(s, 'shift.cancelled', 'shift', x.id, x.branchId, { ...before, status: 'planned' }, null, reason);
    return out(s, x);
  }));
  const assertOwn = (s: Staffish, x: Shift) => {
    if (x.staffId === s.id) return;
    if (!can(s, 'shift.view', x.branchId)) throw notFound();
    throw new Fail(403, 'FORBIDDEN', 'Отметить приход и уход может только сам сотрудник', { action: 'shift.attendance.self' });
  };
  const fact = (s: Staffish, x: Shift, set: Partial<Shift>, reason: string | null) => {
    const before = { status: x.status, factStart: x.factStart, factEnd: x.factEnd, paidMinutes: x.paidMinutes, unpaidConfirmed: x.unpaid };
    Object.assign(x, set, { reviewReason: null, factVersion: x.factVersion + 1, rowVersion: x.rowVersion + 1 });
    accrue(x);
    log(s, 'shift.attendance_set', 'shift', x.id, x.branchId, before, { status: x.status, factStart: x.factStart, factEnd: x.factEnd, paidMinutes: x.paidMinutes, paidMinutesSource: x.source, unpaidConfirmed: x.unpaid, factVersion: x.factVersion }, reason);
    return out(s, x);
  };
  app.post(`${P}/shifts/:id/check-in`, command('shifts.check_in', 200, (s, p) => {
    const x = findShift(p.id!);
    assertOwn(s, x);
    assertOpen(x.localDate);
    if (x.status !== 'planned') throw new Fail(409, 'SHIFT_NOT_EDITABLE', 'Смена уже не плановая: отметку исправляет руководитель', { status: x.status });
    if (x.factStart) return out(s, x);
    const now = Date.now();
    if (now < Date.parse(x.start) - EARLY_MINUTES * 60_000 || now >= Date.parse(x.end)) throw new Fail(409, 'CHECKIN_WINDOW', 'Приход отмечается перед началом смены и до её конца', { earlyMinutes: EARLY_MINUTES });
    return fact(s, x, { factStart: new Date(now).toISOString() }, null);
  }));
  app.post(`${P}/shifts/:id/check-out`, command('shifts.check_out', 200, (s, p) => {
    const x = findShift(p.id!);
    assertOwn(s, x);
    assertOpen(x.localDate);
    if (x.status === 'worked' && x.factEnd) return out(s, x);
    if (x.status !== 'planned') throw new Fail(409, 'SHIFT_NOT_EDITABLE', 'Смена уже не плановая: отметку исправляет руководитель', { status: x.status });
    if (!x.factStart) throw new Fail(409, 'CHECKIN_WINDOW', 'Сначала отметьте приход');
    const now = Date.now();
    return fact(s, x, { status: 'worked', factEnd: new Date(now).toISOString(), paidMinutes: Math.max(0, Math.floor((now - Date.parse(x.factStart)) / 60_000)), source: 'fact_time' }, null);
  }));
  app.post(`${P}/shifts/:id/attendance`, command('shifts.attendance', 200, (s, p, b) => {
    const x = findShift(p.id!);
    assertCan(s, 'shift.attendance.correct', x.branchId);
    const reason = reasonOf(b.reason);
    assertOpen(x.localDate);
    version(x, b.rowVersion);
    if (x.status === 'cancelled') throw new Fail(409, 'SHIFT_NOT_EDITABLE', 'Смена отменена', { status: x.status });
    if (b.unpaidConfirmed === true) return fact(s, x, { unpaid: true }, reason);
    if (Date.parse(x.start) > Date.now()) throw new Fail(409, 'SHIFT_NOT_EDITABLE', 'Смена ещё не началась', { status: x.status });
    if (b.status === 'no_show') return fact(s, x, { status: 'no_show', factStart: null, factEnd: null, paidMinutes: null, source: null }, reason);
    if (b.status !== 'worked') throw invalid();
    if (b.paidMinutes !== undefined) {
      if (!Number.isInteger(b.paidMinutes) || (b.paidMinutes as number) < 0 || (b.paidMinutes as number) > 1440) throw invalid();
      return fact(s, x, { status: 'worked', paidMinutes: b.paidMinutes as number, source: 'manual', unpaid: false }, reason);
    }
    const start = iso(b.factStart, 'factStart');
    const end = iso(b.factEnd, 'factEnd');
    if (start >= end) throw new Fail(422, 'INVALID_DURATION', 'Приход должен быть раньше ухода');
    if (Date.parse(end) > Date.now()) throw invalid('Уход не может быть в будущем', { field: 'factEnd' });
    return fact(s, x, { status: 'worked', factStart: start, factEnd: end, paidMinutes: Math.floor((Date.parse(end) - Date.parse(start)) / 60_000), source: 'fact_time', unpaid: false }, reason);
  }));
  app.get(`${P}/me/shift-changes`, read((s, req) => {
    const unread = (req.query as { unread?: string }).unread === 'true';
    const mine = new Set(shifts.filter((x) => x.staffId === s.id).map((x) => x.id));
    return { items: changes.filter((c) => mine.has(c.shiftId) && (!unread || !c.acknowledgedAt)).reverse() };
  }));
  app.post(`${P}/me/shift-changes/:id/ack`, command('shifts.ack', 200, (s, p) => {
    const c = changes.find((x) => x.id === p.id);
    if (!c || findShift(c.shiftId).staffId !== s.id) throw notFound();
    c.acknowledgedAt ??= new Date().toISOString();
    return { id: c.id, acknowledgedAt: c.acknowledgedAt };
  }));

  // ---- ставки и «временно не работает»

  const assertStaffPayroll = (s: Staffish, id: string) => {
    const t = staffOf(id);
    if (!t) throw notFound();
    if (deps.zone(s).network) return owner(s, 'payroll.view');
    if (!staffBranches(t).some((b) => inZ(s, b))) throw notFound();
    owner(s, 'payroll.view');
  };
  app.get(`${P}/staff/:id/rates`, read((s, req) => {
    const id = (req.params as { id: string }).id;
    assertStaffPayroll(s, id);
    return { items: rates.filter((r) => r.staffId === id).map((r, i) => ({ r, i })).sort((a, b) => (a.r.validFrom === b.r.validFrom ? b.i - a.i : a.r.validFrom < b.r.validFrom ? 1 : -1)).map((x) => x.r) };
  }));
  const assertKop = (v: unknown, field: string) => {
    if (!Number.isSafeInteger(v) || (v as number) < 0) throw new Fail(422, 'INVALID_AMOUNT', 'Сумма – целое неотрицательное число копеек', { field });
    return v as number;
  };
  app.post(`${P}/staff/:id/rates`, command('shifts.rate.set', 201, (s, p, b) => {
    owner(s, 'payroll.rate.manage');
    const validFrom = String(b.validFrom ?? '');
    if (!DATE_RE.test(validFrom)) throw invalid('Дата вступления – ГГГГ-ММ-ДД', { field: 'validFrom' });
    const hourlyKop = assertKop(b.hourlyKop, 'hourlyKop');
    const attendanceFeeKop = assertKop(b.attendanceFeeKop, 'attendanceFeeKop');
    const reason = reasonOf(b.reason);
    if (!staffOf(p.id!)) throw notFound();
    const corrects = (b.corrects as string | null | undefined) ?? null;
    if (corrects !== null && !rates.some((r) => r.id === corrects && r.staffId === p.id && r.validFrom === validFrom)) throw invalid('Исправлять можно только ставку этого сотрудника с той же датой', { field: 'corrects' });
    const rate: Rate = { id: randomUUID(), staffId: p.id!, validFrom, hourlyKop, attendanceFeeKop, corrects, reason, createdBy: s.id, createdAt: new Date().toISOString() };
    rates.push(rate);
    const next = rates.filter((r) => r.staffId === p.id && r.validFrom > validFrom).map((r) => r.validFrom).sort()[0] ?? '9999-12-31';
    const affected = shifts.filter((x) => x.staffId === p.id && x.status === 'worked' && !x.unpaid && x.localDate >= validFrom && x.localDate < next && periodOf(x.localDate)?.status !== 'closed');
    for (const x of affected) accrue(x);
    return { rate, affectedShiftIds: affected.map((x) => x.id) };
  }));
  app.patch(`${P}/staff/:id/planning`, command('shifts.planning', 200, (s, p, b) => {
    const status = b.planningStatus;
    if (status !== 'available' && status !== 'on_leave') throw invalid('planningStatus – available или on_leave', { field: 'planningStatus' });
    const t = staffOf(p.id!);
    if (!t) throw notFound();
    if (!deps.zone(s).network && !staffBranches(t).some((x) => inZ(s, x))) throw notFound();
    owner(s, 'staff.planning_status');
    const prev = leave.has(t.id) ? 'on_leave' : 'available';
    if (prev !== status) {
      if (status === 'on_leave') leave.add(t.id);
      else leave.delete(t.id);
      t.planningStatus = status;
      t.rowVersion = (t.rowVersion ?? 1) + 1;
      deps.audit(s, 'staff', t.id, 'staff.planning_changed', { planningStatus: prev }, { planningStatus: status });
    }
    const future = status === 'on_leave' ? shifts.filter((x) => x.staffId === t.id && x.status === 'planned' && Date.parse(x.start) > Date.now()) : [];
    return { planningStatus: status, rowVersion: t.rowVersion ?? 1, futureShiftsNeedingDecision: future.map((x) => out(s, x)) };
  }));

  return { deps, branchOf, tzOf, inZ, can, assertCan, owner, viewer, read, command, send, staffOf, staffBranches, reasonOf, dateRange, coverageOf };
}
export type ShiftsHelpers = ReturnType<typeof registerShiftsStaff>;

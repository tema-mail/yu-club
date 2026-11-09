// Мок подарка и справочников Э3 строго по apps/api/src/modules/events/routes.gifts.ts, gifts.ts, gift-booking.ts и network/holidays.ts (K20 №376–379): один подарок
// в 365 дней, запись только в будни без праздников. Категории оборудования и исполнители (equipment/routes*.ts, №337, №349) ставятся, только если их ещё
// не поставил другой мок. Подключается из mock-events.ts; общие команды и проверки приходят параметром tools.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { addGiftBooking, bookingBusy } from './mock-booking.ts';
import { Fail, type EventsMockDeps } from './mock-events.ts';
import { opsHoursOn, opsState } from './mock-ops.ts';

type Rec = Record<string, unknown>;
type Staffish = { id: string; role: string };
type BranchLite = ReturnType<EventsMockDeps['branches']>[number];
interface GiftRec { id: string; number: string; clientId: string; basisEventId: string | null; issuedOn: string; validUntil: string; issueBranchId: string; terms: Rec; status: string; bookingId: string | null; cancelReason: string | null; rowVersion: number }
interface HolidayRec { id: string; scope: 'network' | 'city'; cityId: string | null; date: string; name: string; status: 'active' | 'cancelled' }
export interface GiftTools {
  command: (op: string, status: number, run: (s: Staffish, p: Record<string, string>, body: Rec) => unknown) => (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  read: (run: (s: Staffish, req: FastifyRequest) => unknown) => (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  canAt: (s: Staffish, action: string, branchId: string) => boolean;
  manage: (s: Staffish, action: string) => void;
  reasonOf: (body: Rec, field?: string) => string;
  eventBusy: (branchId: string, units: string[], s: number, e: number) => boolean;
  assertVersion: (e: { rowVersion: number }, body: Rec) => void;
  idOf: (req: FastifyRequest) => string;
  basisOf: (id: string) => { branchId: string; typeCode: string; birthdayClientId: string | null; status: string } | undefined;
}

let gifts: GiftRec[] = [];
let holidays: HolidayRec[] = [];
let giftSeq = 40;

const notFound = () => new Fail(404, 'NOT_FOUND', 'Не найдено');
const invalid = (message: string, field: string) => new Fail(400, 'VALIDATION_FAILED', message, { field });
const zodFail = (path: string) => new Fail(400, 'VALIDATION_FAILED', 'Неверные данные запроса', { issues: [{ path, message: 'Invalid input' }] });
const forbidden = (action: string) => new Fail(403, 'FORBIDDEN', 'Недостаточно прав', { action });
const localDate = (at: number, tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(at));
const localHM = (at: number, tz: string) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(at));
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
function zoned(date: string, hm: string, tz: string): number {
  const naive = Date.parse(`${date}T${hm}:00Z`);
  const shown = (at: number) => Date.parse(`${localDate(at, tz)}T${localHM(at, tz)}:00Z`);
  return naive - (shown(naive) - naive);
}
const isMoment = (v: unknown): v is string => typeof v === 'string' && /T.*(Z|[+-]\d{2}:\d{2})$/.test(v) && !Number.isNaN(Date.parse(v));
const iso = (ms: number) => new Date(ms).toISOString();

/** Подарки основания кроме отменённых: сводка денег и ответ отмены (K20 §6, §7). */
export const giftIdsOfEvent = (eventId: string) => gifts.filter((g) => g.basisEventId === eventId && g.status !== 'cancelled').map((g) => g.id);

export function resetGifts(weekday: (n: number) => string): void {
  giftSeq = 40;
  gifts = [];
  holidays = [
    { id: randomUUID(), scope: 'network', cityId: null, date: weekday(7), name: 'Праздник сети', status: 'active' },
    { id: randomUUID(), scope: 'city', cityId: 'c-tsk', date: weekday(14), name: 'День города Томск', status: 'active' },
  ];
}

export function registerGifts(app: FastifyInstance, P: string, d: EventsMockDeps, t: GiftTools): void {
  const { command, read, canAt, manage, reasonOf, eventBusy, idOf } = t;
  const anyZone = (s: Staffish) => {
    if (!d.can(s, 'event.view')) throw forbidden('event.view');
  };
  // ---- №376–378 подарки

  const giftDto = (g: GiftRec) => ({ ...g, timezone: d.branches().find((b) => b.id === g.issueBranchId)!.timezone });
  app.get(`${P}/gifts`, read((s, req) => {
    const q = req.query as { clientId?: string; status?: string };
    return { items: gifts.filter((g) => canAt(s, 'event.view', g.issueBranchId) && (!q.clientId || g.clientId === q.clientId) && (!q.status || g.status === q.status)).sort((a, b) => (a.issuedOn < b.issuedOn ? 1 : -1)).map(giftDto) };
  }));
  app.post(`${P}/gifts`, command('issue', 201, (s, _p, body) => {
    if (typeof body.clientId !== 'string') throw zodFail('clientId');
    let branchId: string;
    let reason: string | null = null;
    if (body.basisEventId) {
      const e = t.basisOf(String(body.basisEventId));
      if (!e || !canAt(s, 'event.view', e.branchId)) throw notFound();
      if (!canAt(s, 'gift.issue', e.branchId)) throw forbidden('gift.issue');
      const basis = (r: string) => new Fail(422, 'GIFT_BASIS_INVALID', 'Основание – день рождения этого клиента в клубе', { reason: r });
      if (!['birthday_party', 'birthday'].includes(e.typeCode)) throw basis('type');
      if (e.birthdayClientId !== body.clientId) throw basis('client');
      if (!['in_progress', 'completed'].includes(e.status)) throw basis('status');
      branchId = e.branchId;
    } else {
      manage(s, 'gift.issue.manual');
      reason = reasonOf(body);
      if (!body.branchId) throw invalid('Укажите филиал выдачи', 'branchId');
      branchId = String(body.branchId);
    }
    const branch = d.branches().find((b) => b.id === branchId);
    if (!branch) throw notFound();
    const client = d.clients().find((c) => c.id === body.clientId);
    if (!client || client.status === 'anonymized') throw notFound();
    const issuedOn = localDate(Date.now(), branch.timezone);
    if (gifts.some((g) => g.clientId === body.clientId && g.status !== 'cancelled' && g.issuedOn > addDays(issuedOn, -365))) throw new Fail(409, 'GIFT_ALREADY_ISSUED', 'Подарок этому клиенту уже выдан в этом году');
    void reason;
    const g: GiftRec = {
      id: randomUUID(), number: `GF-${String(++giftSeq).padStart(6, '0')}`, clientId: body.clientId, basisEventId: (body.basisEventId as string | null | undefined) ?? null, issuedOn, validUntil: addDays(issuedOn, 60), issueBranchId: branch.id,
      terms: { devices: 2, device: 'Meta Quest 3S', minutesEach: 30, roomMinutes: 40, weekdays: [1, 2, 3, 4, 5], excludesHolidays: true, notIncluded: ['PS4', 'PS VR', 'food'] }, status: 'issued', bookingId: null, cancelReason: null, rowVersion: 1,
    };
    gifts.push(g);
    return giftDto(g);
  }));
  app.post(`${P}/gifts/:id/cancel`, command('cancel', 200, (s, p, body) => {
    manage(s, 'gift.cancel');
    const g = gifts.find((x) => x.id === p.id);
    if (!g) throw notFound();
    const reason = reasonOf(body);
    if (g.status !== 'issued') throw new Fail(409, 'GIFT_NOT_ACTIVE', 'Отменить можно только подарок без записи', { status: g.status });
    Object.assign(g, { status: 'cancelled', cancelReason: reason, rowVersion: g.rowVersion + 1 });
    return giftDto(g);
  }));

  const isHoliday = (branch: BranchLite, date: string) => holidays.some((h) => h.status === 'active' && h.date === date && (h.scope === 'network' || h.cityId === branch.cityId));
  /** assertGiftDay: срок, будни, праздник (K20 §8.2). */
  function dayClosed(g: GiftRec, branch: BranchLite, date: string): [number, string, string] | null {
    if (date > g.validUntil) return [409, 'GIFT_EXPIRED', 'Срок подарка истёк'];
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (dow === 0 || dow === 6) return [422, 'GIFT_WEEKDAY_ONLY', 'Подарок – только с понедельника по пятницу'];
    if (isHoliday(branch, date)) return [422, 'GIFT_HOLIDAY', 'В праздничный день подарок не действует'];
    return null;
  }
  const GIFT_UNITS = () => [...(opsState().composition['res-vr1'] ?? []), ...(opsState().composition['res-vr2'] ?? [])];
  app.get(`${P}/gifts/:id/slots`, read((s, req) => {
    const q = req.query as { branchId?: string; date?: string };
    if (!q.branchId || !q.date) throw zodFail('branchId');
    const g = gifts.find((x) => x.id === idOf(req));
    if (!g || !canAt(s, 'event.view', q.branchId)) throw notFound();
    const branch = d.branches().find((b) => b.id === q.branchId);
    if (!branch) throw notFound();
    const closedBy = dayClosed(g, branch, q.date);
    if (closedBy) return { date: q.date, closedReason: closedBy[1], slots: [] };
    const today = localDate(Date.now(), branch.timezone);
    if (q.date < today || q.date >= addDays(today, 30)) return { date: q.date, closedReason: 'OUTSIDE_BOOKING_WINDOW', slots: [] };
    if (!opsState().resources.some((r) => r.branchId === branch.id && r.id === 'res-vr1')) return { date: q.date, closedReason: 'RESOURCE_UNAVAILABLE', slots: [] };
    const h = opsHoursOn(branch.id, q.date, GIFT_UNITS());
    if (!h) return { date: q.date, closedReason: null, slots: [] };
    const slots: Array<{ start: string; end: string }> = [];
    const close = zoned(q.date, h.close === '24:00' ? '23:59' : h.close, branch.timezone);
    for (let t = zoned(q.date, h.open, branch.timezone); t + 40 * 60_000 <= close; t += 15 * 60_000) {
      const e = t + 40 * 60_000;
      if (t <= Date.now() || bookingBusy(branch.id, GIFT_UNITS(), t, e) || eventBusy(branch.id, GIFT_UNITS(), t, e)) continue;
      slots.push({ start: iso(t), end: iso(e) });
    }
    return { date: q.date, closedReason: null, slots };
  }));
  app.post(`${P}/gifts/:id/book`, command('book', 201, (s, p, body) => {
    if (typeof body.branchId !== 'string' || !isMoment(body.start)) throw zodFail('start');
    const g = gifts.find((x) => x.id === p.id);
    const branch = d.branches().find((b) => b.id === body.branchId);
    if (!g || !branch || !canAt(s, 'event.view', branch.id)) throw notFound();
    if (!canAt(s, 'gift.book', branch.id)) throw forbidden('gift.book');
    if (body.clientId && body.clientId !== g.clientId) throw new Fail(422, 'GIFT_CLIENT_MISMATCH', 'Записать можно только самого именинника');
    if (g.status === 'reserved') throw new Fail(409, 'GIFT_ALREADY_RESERVED', 'По подарку уже есть запись');
    if (g.status !== 'issued') throw new Fail(409, 'GIFT_NOT_ACTIVE', 'Подарок уже не активен');
    const start = Date.parse(body.start);
    const closedBy = dayClosed(g, branch, localDate(start, branch.timezone));
    if (closedBy) throw new Fail(closedBy[0], closedBy[1], closedBy[2]);
    const end = start + 40 * 60_000;
    if (bookingBusy(branch.id, GIFT_UNITS(), start, end) || eventBusy(branch.id, GIFT_UNITS(), start, end)) throw new Fail(409, 'SLOT_TAKEN', 'Это время уже занято');
    const b = addGiftBooking({ branchId: branch.id, clientId: g.clientId, start, end, comment: (body.comment as string | undefined) ?? null, unitIds: GIFT_UNITS() });
    Object.assign(g, { status: 'reserved', bookingId: b.id, rowVersion: g.rowVersion + 1 });
    return b;
  }));

  // ---- №379 праздничный календарь

  app.get(`${P}/holidays`, read((s, req) => {
    anyZone(s);
    const q = req.query as { from?: string; to?: string; cityId?: string; includeCancelled?: string };
    return { items: holidays.filter((h) => (!q.from || h.date >= q.from) && (!q.to || h.date <= q.to) && (!q.cityId || h.scope === 'network' || h.cityId === q.cityId) && (q.includeCancelled === 'true' || h.status === 'active')).sort((a, b) => (a.date < b.date ? -1 : 1)) };
  }));
  app.post(`${P}/holidays`, command('holiday.set', 201, (s, _p, body) => {
    manage(s, 'holiday.manage');
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!['network', 'city'].includes(String(body.scope)) || !name || !/^\d{4}-\d{2}-\d{2}$/.test(String(body.date))) throw zodFail('date');
    const scope = body.scope as 'network' | 'city';
    const cityId = scope === 'city' ? ((body.cityId as string | null | undefined) ?? null) : null;
    if (scope === 'city' && !cityId) throw invalid('Укажите город', 'cityId');
    const same = holidays.find((h) => h.status === 'active' && h.scope === scope && h.cityId === cityId && h.date === body.date);
    if (same) return same;
    const h: HolidayRec = { id: randomUUID(), scope, cityId, date: String(body.date), name, status: 'active' };
    holidays.push(h);
    return h;
  }));
  app.post(`${P}/holidays/:id/cancel`, command('holiday.cancel', 200, (s, p, body) => {
    manage(s, 'holiday.manage');
    const reason = reasonOf(body);
    void reason;
    const h = holidays.find((x) => x.id === p.id);
    if (!h) throw notFound();
    h.status = 'cancelled'; // уже отменённая – 200 с записью, как API (network/holidays.ts)
    return h;
  }));
}

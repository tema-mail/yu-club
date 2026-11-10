// Мок отчётов CRM строго по apps/api/src/modules/reports: routes.crm.ts (№239–242, №248, №250), routes.crm.export.ts (№243–247),
// report-handlers.ts (схема фильтров), framework.ts (период, область, Metric), dashboard.ts, search.ts, export.ts, segment.ts.
// Порядок проверок как в API: вход → фильтры (422 REPORT_FILTER_INVALID) → отчёт (404 REPORT_UNKNOWN) → период (422) → право (403)
// → область (чужой филиал или город – 404). Без права на деньги сотрудников – unavailable/not_permitted, а не 0.
// Отличия от API (данные мока): id филиалов засева не UUID – принимаются известные id; показатели считаются по засеянным строкам
// одним условием для итога и детализации (Σ detail = итог); у клиентов, баллов, сертификатов и уведомлений набор показателей сокращён;
// сегмент hour и source/category/place не сужают строки; задача экспорта сама проходит queued → running → ready за ~1 с.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { DashboardCard, DashboardResult, DetailResult, ExportJob, Metric, MetricUnit, Period, ReconcileRun, ReportResult, SearchGroup, SearchResponse, UnitCalendar, UnitRow } from '../src/lib/reports.ts';
import { maskPhone } from './mock-clients.ts';

type Rec = Record<string, unknown>;
type Role = 'owner' | 'director' | 'admin';
interface Staffish { id: string; role: string; firstName?: string; lastName?: string; branchIds?: string[]; cityIds?: string[] }
interface BranchLite { id: string; cityId: string; name: string; timezone: string }
interface ClientLite { id: string; status: string; firstName: string | null; lastName: string | null; phoneE164: string | null; links: string[] }
export interface ReportsMockDeps {
  current: (req: FastifyRequest) => Staffish;
  zone: (s: Staffish) => { network: boolean; cityIds: string[]; branchIds: string[] };
  can: (s: Staffish, action: string) => boolean;
  branches: () => BranchLite[];
  clients: () => ClientLite[];
  staff: () => Staffish[];
  grant: (role: Role, actions: string[]) => void;
}

/** K24 §8 / core/permissions.ts. audit.view, export.pd – уже в моке. */
export const REPORT_ACTIONS: Record<Role, string[]> = {
  owner: ['reports.ops.view', 'reports.finance.view', 'reports.clients.view', 'reports.loyalty.view', 'reports.events.view', 'reports.staff.view', 'reports.payroll.view',
    'reports.equipment.view', 'reports.comms.view', 'reports.export', 'reports.export.detail', 'reports.export.payroll', 'search.global'],
  director: ['reports.ops.view', 'reports.finance.view', 'reports.clients.view', 'reports.loyalty.view', 'reports.events.view', 'reports.staff.view', 'reports.payroll.view',
    'reports.equipment.view', 'reports.comms.view', 'reports.export', 'reports.export.detail', 'search.global'],
  admin: ['reports.ops.view', 'reports.equipment.view', 'search.global'],
};

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
const notFound = () => new Fail(404, 'NOT_FOUND', 'Не найдено');
const forbidden = (action: string) => new Fail(403, 'FORBIDDEN', 'Недостаточно прав', { action });
const filterInvalid = (message: string, details: Rec) => new Fail(422, 'REPORT_FILTER_INVALID', message, details);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 92; // reports.interactive_max_days
const DAY_RULE = 'Сутки – по времени каждого филиала';
const OFFSET = '+07:00'; // засев: у всех филиалов мока +7 (Новосибирск, Томск)
const DAY_MS = 86_400_000;

// ---- время

const dateFmt = new Map<string, Intl.DateTimeFormat>();
function localDate(iso: string, tz: string): string {
  let f = dateFmt.get(tz);
  if (!f) dateFmt.set(tz, (f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })));
  return f.format(new Date(iso));
}
const fmtLocal = (iso: string, tz: string) =>
  `${new Intl.DateTimeFormat('ru-RU', { timeZone: tz, day: 'numeric', month: 'long' }).format(new Date(iso))}, ${new Intl.DateTimeFormat('ru-RU', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso))}`;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
const at = (day: string, hh: number, mm = 0) => new Date(`${day}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00${OFFSET}`).toISOString();

function parsePeriod(q: Rec, maxDays?: number): Period {
  for (const f of ['from', 'to'] as const) if (typeof q[f] !== 'string' || !DATE.test(q[f] as string) || Number.isNaN(Date.parse(`${q[f]}T00:00:00Z`))) throw new Fail(422, 'REPORT_PERIOD_INVALID', 'Неверный период', { field: f });
  const from = q.from as string;
  const to = q.to as string;
  if (from > to || to > addDays(new Date().toISOString().slice(0, 10), 366)) throw new Fail(422, 'REPORT_PERIOD_INVALID', 'Неверный период', { from, to });
  if (maxDays !== undefined && daysBetween(from, to) + 1 > maxDays) throw new Fail(422, 'REPORT_PERIOD_TOO_LONG', 'Период слишком длинный для экрана – сформируйте файл', { useExport: true, maxDays });
  return { from, to };
}
function prevPeriod(p: Period): Period {
  const last = addDays(`${addDays(`${p.from.slice(0, 8)}01`, 32).slice(0, 8)}01`, -1);
  const to = addDays(p.from, -1);
  if (p.from.endsWith('-01') && p.to === last) return { from: `${to.slice(0, 8)}01`, to };
  return { from: addDays(to, -daysBetween(p.from, p.to)), to };
}

// ---- фильтры (report-handlers.ts QUERY)

interface Query { from?: string; to?: string; cityId?: string; branchIds?: string[]; status?: string[]; resourceType?: string[]; method?: string[]; paid?: boolean;
  series?: 'day' | 'hour'; metric?: string; segment?: string; cursor?: string; limit?: number }
function parseQuery(raw: unknown): Query {
  const r = (raw ?? {}) as Rec;
  const issues: Array<{ path: string; message: string }> = [];
  const list = (k: string) => (r[k] === undefined ? undefined : (Array.isArray(r[k]) ? (r[k] as string[]) : String(r[k]).split(',')).map((x) => x.trim()).filter(Boolean));
  const q: Query = { branchIds: list('branchIds'), status: list('status'), resourceType: list('resourceType'), method: list('method') };
  for (const k of ['from', 'to', 'cityId', 'metric', 'segment', 'cursor'] as const) if (typeof r[k] === 'string') q[k] = r[k] as string;
  if (q.method?.some((m) => !['cash', 'card', 'transfer'].includes(m))) issues.push({ path: 'method', message: 'Invalid option' });
  if (r.paid === 'true' || r.paid === 'false') q.paid = r.paid === 'true';
  else if (r.paid !== undefined) issues.push({ path: 'paid', message: 'Invalid option' });
  if (r.series === 'day' || r.series === 'hour') q.series = r.series;
  else if (r.series !== undefined) issues.push({ path: 'series', message: 'Invalid option' });
  if (r.limit !== undefined) {
    const n = Number(r.limit);
    if (Number.isInteger(n) && n >= 1 && n <= 500) q.limit = n;
    else issues.push({ path: 'limit', message: 'Invalid number' });
  }
  if (issues.length) throw filterInvalid('Неверный фильтр', { issues });
  return q;
}

// ---- засев

interface Row { id: string; branchId: string | null; [k: string]: unknown }
const PEOPLE = [['Ольга', 'Смирнова', '+79131234567'], ['Иван', 'Петров', '+79139876543'], ['Мария', 'Кузнецова', '+79230001122']] as const;
const RESOURCES = [['pc', 'ПК 3'], ['vr', 'VR-зона'], ['ps', 'PlayStation 1'], ['room', 'Комната «Космос»']] as const;
const hex = (prefix: string, n: number) => `${prefix}${String(n).padStart(12, '0')}`;

interface Seed { bookings: Row[]; finance: Row[]; events: Row[]; shifts: Row[]; payroll: Row[]; repairs: Row[]; equipment: Row[]; ops: Row[] }
let seed: Seed;
let exportsList: Array<ExportJob & { staffId: string; hash: string }> = [];

function seedAll(branches: BranchLite[]): Seed {
  const now = Date.now();
  const today = localDate(new Date(now).toISOString(), 'Asia/Novosibirsk');
  const s: Seed = { bookings: [], finance: [], events: [], shifts: [], payroll: [], repairs: [], equipment: [], ops: [] };
  let k = 0;
  let op = 0;
  branches.forEach((b, bi) => {
    for (let di = 0, day = '2026-09-01'; day <= '2026-11-30'; di++, day = addDays(day, 1)) {
      const n = 1 + ((di * 5 + bi * 3) % 4);
      for (let j = 0; j < n; j++, k++) {
        const startAt = at(day, 11 + j * 2 + (bi % 2));
        const past = Date.parse(startAt) < now;
        const [type, name] = RESOURCES[k % 4]!;
        const minutes = [60, 90, 120][k % 3]!;
        const needsDecision = past && day === today && k % 2 === 0;
        const status = !past || needsDecision ? 'confirmed' : k % 9 === 0 ? 'cancelled_by_client' : k % 11 === 0 ? 'cancelled_by_club' : k % 13 === 0 ? 'no_show' : 'completed';
        const priceKop = (minutes / 60) * 30_000;
        const paidMethod = status === 'completed' ? (k % 2 ? 'card' : 'cash') : null;
        const bookingId = hex('b0000000-0000-4000-8000-', k + 1);
        s.bookings.push({ id: bookingId, branchId: b.id, number: 1001 + k, startAt, createdAt: new Date(Date.parse(startAt) - ((k % 5) + 1) * DAY_MS).toISOString(),
          rescheduledAt: k % 7 === 0 && !String(status).startsWith('cancelled') ? new Date(Date.parse(startAt) - DAY_MS / 2).toISOString() : null,
          resourceType: type, resourceName: name, minutes, status, priceKop, paidMethod, needsDecision, person: k % 3,
          cancelledAt: String(status).startsWith('cancelled') ? new Date(Date.parse(startAt) - 3_600_000).toISOString() : null });
        if (paidMethod) {
          s.finance.push({ id: hex('f0000000-0000-4000-8000-', ++op), branchId: b.id, number: op, occurredAt: startAt, kind: 'income', source: 'session', method: paidMethod,
            place: paidMethod === 'cash' ? 'cash' : 'noncash', amountKop: priceKop, delta: priceKop, ref: { type: 'booking', id: bookingId }, comment: null });
          if (k % 10 === 0) s.finance.push({ id: hex('f0000000-0000-4000-8000-', ++op), branchId: b.id, number: op, occurredAt: new Date(Date.parse(startAt) + 3_600_000).toISOString(),
            kind: 'refund', source: 'session', method: paidMethod, place: paidMethod === 'cash' ? 'cash' : 'noncash', amountKop: priceKop / 2, delta: -priceKop / 2, ref: { type: 'booking', id: bookingId }, comment: 'Возврат половины: сбой ПК' });
        }
      }
      if (di % 7 === 3 && day <= today) s.finance.push({ id: hex('f0000000-0000-4000-8000-', ++op), branchId: b.id, number: op, occurredAt: at(day, 18), kind: 'expense', source: null,
        method: 'cash', place: 'cash', amountKop: 150_000 + bi * 10_000, delta: -(150_000 + bi * 10_000), ref: null, comment: 'Хозтовары' });
      for (const [h, len] of [[10, 360], [16, 360]] as const) {
        const startAt = at(day, h);
        const sk = s.shifts.length;
        const past = Date.parse(startAt) + len * 60_000 < now;
        const status = !past ? 'planned' : sk % 15 === 0 ? 'no_show' : sk % 23 === 0 ? 'needs_review' : sk % 29 === 0 ? 'planned' : 'worked';
        s.shifts.push({ id: hex('5a000000-0000-4000-8000-', sk + 1), branchId: b.id, startAt, kind: 'shift', status, plannedMinutes: len, paidMinutes: status === 'worked' ? len - (sk % 4) * 30 : 0,
          endAt: new Date(Date.parse(startAt) + len * 60_000).toISOString() });
      }
      if (b.id.endsWith('akadem') && di % 7 === 0) s.shifts.push({ id: hex('5b000000-0000-4000-8000-', di), branchId: b.id, startAt: at(day, 10), kind: 'gap', status: 'gap', plannedMinutes: 120, paidMinutes: 0 });
    }
    for (let e = 0; e < 3; e++) s.equipment.push({ id: hex('e0000000-0000-4000-8000-', bi * 10 + e + 1), branchId: b.id, inventoryNo: `INV-${String(bi * 10 + e + 1).padStart(4, '0')}`,
      serialNo: `SN${bi}${e}77`, status: e === 2 ? 'repair' : 'in_service' });
    s.repairs.push({ id: hex('ee000000-0000-4000-8000-', bi + 1), branchId: b.id, incidentAt: at('2026-11-04', 12), startedAt: bi === 2 ? null : at('2026-11-04', 14),
      finishedAt: bi === 0 ? at('2026-11-05', 14) : null, status: bi === 0 ? 'closed' : 'repair', warranty: bi === 1, expenseKop: 250_000, downtimeMinutes: 1440 });
  });
  const ev = [['2026-10-05', 0, 'held'], ['2026-10-20', 2, 'held'], ['2026-11-02', 2, 'cancelled'], ['2026-11-03', 0, 'held'], ['2026-11-08', 1, 'held'], ['2026-11-15', 0, 'planned']] as const;
  ev.forEach(([day, bi, status], i) => {
    const agreed = status === 'cancelled' ? 0 : 1_200_000 + i * 100_000;
    s.events.push({ id: hex('ea000000-0000-4000-8000-', i + 1), branchId: branches[bi]!.id, number: `EV-${String(i + 1).padStart(4, '0')}`, heldAt: at(day, 15), status, hasBooking: i !== 4,
      agreedPriceKop: agreed, receivedKop: status === 'held' ? agreed : 0, refundedKop: 0, dueKop: status === 'planned' ? agreed : 0, plannedCostKop: agreed / 3, factCostKop: status === 'held' ? agreed / 3 + 20_000 : 0 });
  });
  for (const sh of s.shifts) if (sh.status === 'worked') s.payroll.push({ id: `pe-${sh.id}`, branchId: sh.branchId, at: sh.startAt, hourly: Math.round((Number(sh.paidMinutes) * 25_000) / 60), fee: 50_000 });
  for (const m of ['2026-09-30', '2026-10-31']) {
    s.payroll.push({ id: `payout-${m}`, branchId: null, at: at(m, 12), payout: 3_000_000 });
    for (const b of branches) s.ops.push({ id: `po-${m}-${b.id}`, branchId: b.id, at: at(m, 12), amountKop: 1_000_000 });
  }
  return s;
}

// ---- область (framework.ts resolveBranches)

interface Env { s: Staffish; zone: { network: boolean; branchIds: string[] }; branches: BranchLite[]; deps: ReportsMockDeps }
function resolveBranches(env: Env, action: string, q: Pick<Query, 'cityId' | 'branchIds'>): BranchLite[] {
  if (!env.deps.can(env.s, action)) throw forbidden(action);
  const zone = env.branches.filter((b) => env.zone.network || env.zone.branchIds.includes(b.id));
  if (q.cityId && !zone.some((b) => b.cityId === q.cityId)) throw notFound();
  for (const id of q.branchIds ?? []) if (!zone.some((b) => b.id === id)) throw notFound();
  return zone.filter((b) => (!q.cityId || b.cityId === q.cityId) && (!q.branchIds?.length || q.branchIds.includes(b.id)));
}

// ---- показатели: одно условие на итог и детализацию

interface MDef { unit: MetricUnit; agg?: 'count' | 'sum' | 'avg' | 'distinct'; src: keyof Seed; date?: string; where?: (r: Row) => boolean; value?: (r: Row) => number; key?: (r: Row) => string; netNull?: boolean }
function select(env: Env, d: MDef, rows: Row[], bs: BranchLite[], p: Period, wide: boolean): Row[] {
  const tz = new Map(bs.map((b) => [b.id, b.timezone]));
  return rows.filter((r) => {
    if (r.branchId === null ? !(d.netNull && wide) : !tz.has(r.branchId)) return false;
    if (d.where && !d.where(r)) return false;
    if (!d.date) return true;
    const day = localDate(String(r[d.date]), r.branchId === null ? 'UTC' : tz.get(r.branchId)!);
    return day >= p.from && day <= p.to;
  });
}
function aggregate(d: MDef, rows: Row[]): number {
  const v = (r: Row) => (d.value ? d.value(r) : 1);
  if (d.agg === 'distinct') return new Set(rows.map((r) => d.key!(r))).size;
  const sum = rows.reduce((a, r) => a + v(r), 0);
  return d.agg === 'avg' ? sum / rows.length : sum;
}
const ok = (value: number, unit: MetricUnit, prev: number | null): Metric =>
  prev === null ? { state: 'ok', value, unit, prev: null, deltaAbs: null, deltaPct: null } : { state: 'ok', value, unit, prev, deltaAbs: value - prev, deltaPct: prev === 0 ? null : ((value - prev) / Math.abs(prev)) * 100 };

function computeMetrics(env: Env, defs: Record<string, MDef>, bs: BranchLite[], p: Period, wide: boolean): Record<string, Metric> {
  const pp = prevPeriod(p);
  const cur = Object.entries(defs).map(([k, d]) => [k, select(env, d, seed[d.src], bs, p, wide), select(env, d, seed[d.src], bs, pp, wide)] as const);
  const anyCur = cur.some(([, c]) => c.length > 0);
  const anyPrev = cur.some(([, , c]) => c.length > 0);
  return Object.fromEntries(cur.map(([k, c, pr]) => {
    const d = defs[k]!;
    const avg = d.agg === 'avg';
    if (!anyCur || (avg && c.length === 0)) return [k, { state: 'no_data' } as Metric];
    const hasPrev = anyPrev && d.date !== undefined && !(avg && pr.length === 0);
    return [k, ok(c.length ? aggregate(d, c) : 0, d.unit, hasPrev ? (pr.length ? aggregate(d, pr) : 0) : null)];
  }));
}

const visitedStatus = (r: Row) => r.status === 'completed' || r.status === 'arrived';
const isShift = (r: Row) => r.kind === 'shift';
type RQ = Query & { period: Period };
function bookingWhere(q: RQ) {
  return (r: Row) => (!q.status?.length || q.status.includes(String(r.status))) && (!q.resourceType?.length || q.resourceType.includes(String(r.resourceType)))
    && (q.paid === undefined || q.paid === (r.paidMethod !== null));
}
const and = (a: (r: Row) => boolean, b?: (r: Row) => boolean) => (r: Row) => a(r) && (!b || b(r));

interface ReportDef {
  action: string;
  defs: (q: RQ, env: Env) => Record<string, MDef>;
  labels?: Record<string, string>;
  /** Права на часть показателей (staff: деньги), недоступное по данным (equipment). */
  post?: (m: Record<string, Metric>, env: Env, q: RQ, bs: BranchLite[]) => Record<string, Metric>;
  project: (r: Row, env: Env, value: number) => Rec;
  columns: string[];
}

const MONEY = new Set(['accrued', 'hoursAmount', 'perShift', 'penalties', 'bonuses', 'adjustments', 'toPay', 'paid', 'payoutExpense', 'forecast']);
const wideOf = (env: Env, q: RQ) => env.zone.network && !q.cityId && !q.branchIds?.length;
const bName = (env: Env, id: unknown) => env.branches.find((b) => b.id === id)?.name ?? '';
const bTz = (env: Env, id: unknown) => env.branches.find((b) => b.id === id)?.timezone ?? 'Asia/Novosibirsk';

function maskedClient(env: Env, person: number, branchId: string) {
  const [first, last, phone] = PEOPLE[person]!;
  const full = env.deps.can(env.s, 'client.view.full') && (env.zone.network || env.zone.branchIds.includes(branchId));
  return { id: hex('c0000000-0000-4000-8000-', person + 1), kind: 'profile', name: full ? `${first} ${last}` : `${first} ${last[0]}.`, phone: full ? phone : maskPhone(phone) };
}

const REPORTS: Record<string, ReportDef> = {
  bookings: {
    action: 'reports.ops.view',
    defs: (q) => {
      const f = bookingWhere(q);
      const b = (date: string | undefined, where?: (r: Row) => boolean, extra: Partial<MDef> = {}): MDef => ({ unit: 'count', src: 'bookings', ...(date ? { date } : {}), where: and(f, where), ...extra });
      return {
        created: b('createdAt'), planned: b('startAt', (r) => !String(r.status).startsWith('cancelled')), visited: b('startAt', visitedStatus),
        cancelledByClient: b('startAt', (r) => r.status === 'cancelled_by_client'), cancelledByClub: b('startAt', (r) => r.status === 'cancelled_by_club'),
        rescheduled: b('rescheduledAt', (r) => r.rescheduledAt !== null), noShows: b('startAt', (r) => r.status === 'no_show'), awaitingDecision: b(undefined, (r) => r.needsDecision === true),
        avgMinutes: b('startAt', visitedStatus, { agg: 'avg', unit: 'minutes', value: (r) => Number(r.minutes) }),
        uniqueVisitors: b('startAt', visitedStatus, { agg: 'distinct', key: (r) => String(r.person) }),
      };
    },
    project: (r, env) => ({ bookingId: r.id, number: r.number, startLocal: fmtLocal(String(r.startAt), bTz(env, r.branchId)), branchId: r.branchId, branchName: bName(env, r.branchId),
      client: maskedClient(env, Number(r.person), String(r.branchId)), resourceType: r.resourceType, resourceName: r.resourceName, minutes: r.minutes, status: r.status, priceKop: r.priceKop,
      payment: r.paidMethod ? { state: 'paid', methods: [r.paidMethod], paidKop: r.priceKop } : { state: 'unpaid', methods: [], paidKop: 0 }, reasonCode: null, cancelledAt: r.cancelledAt, metricValue: r.minutes }),
    columns: ['number', 'startLocal', 'branchName', 'client', 'resourceName', 'minutes', 'status', 'priceKop', 'payment', 'reasonCode', 'cancelledAt'],
  },
  finance: {
    action: 'reports.finance.view',
    defs: (q) => {
      const m = (where: (r: Row) => boolean, value: (r: Row) => number = (r) => Number(r.amountKop)): MDef =>
        ({ unit: 'kop', agg: 'sum', src: 'finance', date: 'occurredAt', where: and((r) => !q.method?.length || q.method.includes(String(r.method)), where), value });
      const inc = (src?: string) => m((r) => r.kind === 'income' && (!src || r.source === src));
      return {
        income: inc(), incomeSession: inc('session'), incomeEvent: inc('event'), incomeCertificateSale: inc('certificate_sale'), incomeExtraService: inc('extra_service'), incomeOther: inc('other'),
        refunds: m((r) => r.kind === 'refund'), expenses: m((r) => r.kind === 'expense'), withdrawals: m((r) => r.kind === 'withdrawal'), transfers: m((r) => r.kind === 'place_transfer'),
        corrections: m((r) => r.kind === 'correction'), netMovement: m((r) => ['income', 'refund', 'expense'].includes(String(r.kind)), (r) => Number(r.delta)),
        nonMoneyPoints: { unit: 'centi', agg: 'sum', src: 'finance', date: 'occurredAt', where: () => false }, nonMoneyCertificate: { unit: 'kop', agg: 'sum', src: 'finance', date: 'occurredAt', where: () => false },
      };
    },
    post: (m, env, q, bs) => {
      const opening = (p: Period) => seed.finance.filter((r) => bs.some((b) => b.id === r.branchId) && localDate(String(r.occurredAt), bTz(env, r.branchId)) < p.from).reduce((a, r) => a + Number(r.delta), 0) + 2_000_000 * bs.length;
      const pp = prevPeriod(q.period);
      const close = (p: Period) => opening({ from: addDays(p.to, 1), to: p.to });
      return { ...m, cashOpening: bs.length ? ok(opening(q.period), 'kop', opening(pp)) : { state: 'no_data' }, cashClosing: bs.length ? ok(close(q.period), 'kop', close(pp)) : { state: 'no_data' } };
    },
    project: (r, env, value) => ({ id: r.id, number: r.number, occurredLocal: fmtLocal(String(r.occurredAt), bTz(env, r.branchId)), branchId: r.branchId, branchName: bName(env, r.branchId), kind: r.kind,
      isReversal: false, place: r.place, method: r.method, source: r.source, categoryId: null, amountKop: r.amountKop, ref: r.ref, authorId: null, comment: r.comment, value }),
    columns: ['number', 'occurredLocal', 'branchName', 'kind', 'method', 'place', 'source', 'amountKop', 'comment'],
  },
  events: {
    action: 'reports.events.view',
    labels: { money: 'Деньги – за всё время мероприятия, период – по дате проведения', result: 'Поступления − возвраты − прямые расходы в себестоимости; не бухгалтерская прибыль', deviation: 'Факт себестоимости − план; больше нуля – перерасход' },
    defs: () => {
      const e = (agg: 'count' | 'sum' | 'avg', value?: (r: Row) => number, where?: (r: Row) => boolean): MDef => ({ unit: agg === 'count' ? 'count' : 'kop', agg, src: 'events', date: 'heldAt', ...(value ? { value } : {}), ...(where ? { where } : {}) });
      const n = (k: string) => (r: Row) => Number(r[k]);
      return {
        count: e('count'), cancelled: e('count', undefined, (r) => r.status === 'cancelled'), withoutBooking: e('count', undefined, (r) => !r.hasBooking), agreedPrice: e('sum', n('agreedPriceKop')),
        avgPrice: e('avg', n('agreedPriceKop')), received: e('sum', n('receivedKop')), refunded: e('sum', n('refundedKop')), due: e('sum', n('dueKop')), plannedCost: e('sum', n('plannedCostKop')),
        factCost: e('sum', n('factCostKop')), deviation: e('sum', (r) => Number(r.factCostKop) - Number(r.plannedCostKop)), result: e('sum', (r) => Number(r.receivedKop) - Number(r.refundedKop) - Number(r.factCostKop)),
      };
    },
    project: (r, env, value) => ({ eventId: r.id, number: r.number, branchId: r.branchId, branchName: bName(env, r.branchId), heldLocal: fmtLocal(String(r.heldAt), bTz(env, r.branchId)), status: r.status, value }),
    columns: ['number', 'heldLocal', 'branchName', 'status', 'value'],
  },
  staff: {
    action: 'reports.staff.view',
    labels: { emptyIntervals: 'Пустые интервалы – часы работы филиала без сотрудника на смене', unclosedShifts: 'Незакрытые – смена на проверке или прошедшая без отметки явки',
      paid: 'Выплата проводится без филиала – видна только по всей сети', forecast: 'Прогноз по плановым сменам и ставке на дату смены, в учёт не пишется' },
    defs: () => {
      const now = Date.now();
      const sh = (where: (r: Row) => boolean, sum?: string): MDef => ({ unit: sum ? 'minutes' : 'count', agg: sum ? 'sum' : 'count', src: 'shifts', date: 'startAt', where: and(isShift, where), ...(sum ? { value: (r) => Number(r[sum]) } : {}) });
      const pay = (value: (r: Row) => number, where: (r: Row) => boolean = (r) => r.hourly !== undefined): MDef => ({ unit: 'kop', agg: 'sum', src: 'payroll', date: 'at', where, value, netNull: true });
      return {
        plannedShifts: sh((r) => r.status !== 'cancelled'), workedShifts: sh((r) => r.status === 'worked'), noShows: sh((r) => r.status === 'no_show'),
        unclosedShifts: sh((r) => r.status === 'needs_review' || (r.status === 'planned' && Date.parse(String(r.endAt)) <= now)), shortShifts: sh((r) => r.status === 'worked' && Number(r.paidMinutes) < 300),
        plannedMinutes: sh(() => true, 'plannedMinutes'), paidMinutes: sh((r) => r.status === 'worked', 'paidMinutes'),
        emptyIntervals: { unit: 'count', src: 'shifts', date: 'startAt', where: (r) => r.kind === 'gap' }, emptyMinutes: { unit: 'minutes', agg: 'sum', src: 'shifts', date: 'startAt', where: (r) => r.kind === 'gap', value: (r) => Number(r.plannedMinutes) },
        accrued: pay((r) => Number(r.hourly) + Number(r.fee)), hoursAmount: pay((r) => Number(r.hourly)), perShift: pay((r) => Number(r.fee)), penalties: pay(() => 0), bonuses: pay(() => 0), adjustments: pay(() => 0),
        toPay: pay((r) => Number(r.hourly) + Number(r.fee)), paid: pay((r) => Number(r.payout), (r) => r.payout !== undefined),
        payoutExpense: { unit: 'kop', agg: 'sum', src: 'ops', date: 'at', value: (r) => Number(r.amountKop) },
        forecast: { unit: 'kop', agg: 'sum', src: 'shifts', date: 'startAt', where: (r) => isShift(r) && r.status === 'planned', value: (r) => Math.floor((Number(r.plannedMinutes) * 25_000 + 30) / 60) + 50_000 },
      };
    },
    post: (m, env, q) => {
      if (!env.deps.can(env.s, 'reports.payroll.view')) return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, MONEY.has(k) ? { state: 'unavailable', reason: 'not_permitted' } : v]));
      return wideOf(env, q) ? m : { ...m, paid: { state: 'unavailable', reason: 'not_permitted' } };
    },
    project: (r, env, value) => ({ id: r.id, kind: r.kind ?? (r.payout !== undefined ? 'entry' : r.hourly !== undefined ? 'entry' : 'payout_expense'), branchId: r.branchId, branchName: r.branchId ? bName(env, r.branchId) : 'Вся сеть',
      atLocal: fmtLocal(String(r.startAt ?? r.at), r.branchId ? bTz(env, r.branchId) : 'Europe/Moscow'), status: r.status ?? null, plannedMinutes: r.plannedMinutes ?? null, paidMinutes: r.paidMinutes ?? null, value }),
    columns: ['atLocal', 'branchName', 'kind', 'status', 'plannedMinutes', 'paidMinutes', 'value'],
  },
  equipment: {
    action: 'reports.equipment.view',
    labels: { downtimeMinutes: 'Простой – по блокировкам ремонта, пересечения одной единицы считаются один раз', avgRepairMinutes: 'От начала ремонта до завершения; ремонт без даты начала – показатель недоступен',
      repairExpenses: 'Те же операции, что расходы в «Финансах», – не складывать' },
    defs: () => {
      const eq = (where: (r: Row) => boolean): MDef => ({ unit: 'count', src: 'equipment', where });
      const rp = (where: (r: Row) => boolean = () => true, extra: Partial<MDef> = {}): MDef => ({ unit: 'count', src: 'repairs', date: 'incidentAt', where, ...extra });
      return {
        totalEquipment: eq(() => true), inService: eq((r) => r.status === 'in_service'), faulty: eq((r) => r.status === 'repair'),
        openFaults: { unit: 'count', src: 'repairs', where: (r) => !['closed', 'cancelled'].includes(String(r.status)) }, incidents: rp(), warrantyRepairs: rp((r) => r.warranty === true),
        repairExpenses: rp(() => true, { unit: 'kop', agg: 'sum', value: (r) => Number(r.expenseKop) }),
        avgRepairMinutes: rp((r) => r.finishedAt !== null, { unit: 'minutes', agg: 'avg', value: (r) => (Date.parse(String(r.finishedAt)) - Date.parse(String(r.startedAt))) / 60_000 }),
        downtimeMinutes: rp(() => true, { unit: 'minutes', agg: 'sum', value: (r) => Number(r.downtimeMinutes) }), repeatBreakdowns: rp(() => false),
      };
    },
    post: (m, env, q, bs) => (seed.repairs.some((r) => r.startedAt === null && bs.some((b) => b.id === r.branchId)) ? { ...m, avgRepairMinutes: { state: 'unavailable', reason: 'missing_input' } } : m),
    project: (r, env, value) => ({ id: r.id, branchId: r.branchId, branchName: bName(env, r.branchId), inventoryNo: r.inventoryNo ?? null, status: r.status, value }),
    columns: ['id', 'branchName', 'inventoryNo', 'status', 'value'],
  },
  clients: {
    action: 'reports.clients.view',
    defs: () => ({ withVisit: { unit: 'count', agg: 'distinct', src: 'bookings', date: 'startAt', where: visitedStatus, key: (r) => String(r.person) },
      profileVisits: { unit: 'count', src: 'bookings', date: 'startAt', where: visitedStatus } }),
    project: (r, env, value) => ({ clientId: maskedClient(env, Number(r.person), String(r.branchId)).id, client: maskedClient(env, Number(r.person), String(r.branchId)), branchName: bName(env, r.branchId), value }),
    columns: ['client', 'branchName', 'value'],
  },
  loyalty: {
    action: 'reports.loyalty.view',
    labels: { notMoney: 'Баллы не входят в денежную выручку' },
    defs: () => ({ accrued: { unit: 'centi', agg: 'sum', src: 'bookings', date: 'startAt', where: visitedStatus, value: (r) => Number(r.priceKop) / 10 } }),
    project: (r, env, value) => ({ id: r.id, branchName: bName(env, r.branchId), value }),
    columns: ['id', 'branchName', 'value'],
  },
  certificates: {
    action: 'reports.finance.view',
    labels: { birthdayGift: 'Подарок имениннику – право на услугу, не деньги', redeemed: 'Погашение не является поступлением денег' },
    defs: () => ({ salesCount: { unit: 'count', src: 'finance', date: 'occurredAt', where: (r) => r.source === 'certificate_sale' } }),
    project: (r, env, value) => ({ id: r.id, branchName: bName(env, r.branchId), value }),
    columns: ['id', 'branchName', 'value'],
  },
  comms: {
    action: 'reports.comms.view',
    defs: () => ({ campaignsCount: { unit: 'count', src: 'events', date: 'heldAt', where: () => false } }),
    post: (m) => ({ ...m, siteViews: { state: 'unavailable', reason: 'source_not_ready' }, siteClicks: { state: 'unavailable', reason: 'source_not_ready' } }),
    project: (r, env, value) => ({ id: r.id, value }),
    columns: ['id', 'value'],
  },
};
const SEGMENTS: Record<string, string[]> = { bookings: ['branch', 'day', 'resourceType', 'status'], utilization: ['branch', 'day', 'hour', 'resourceType'],
  finance: ['branch', 'day', 'method', 'source', 'category', 'place'], clients: ['branch', 'day'], loyalty: ['branch', 'day'], certificates: ['branch', 'day'], comms: ['branch', 'day'] };

/** segment.ts: сегмент сужает фильтры; несовместимый с фильтром или чужой отчёту – ошибка фильтра. */
function applySegment(report: string, q: RQ): RQ {
  if (q.segment === undefined) return q;
  const i = q.segment.indexOf(':');
  const dim = q.segment.slice(0, i);
  const value = q.segment.slice(i + 1);
  const bad = () => filterInvalid('Неверный сегмент', { field: 'segment', segment: q.segment });
  if (i <= 0 || !value || !(SEGMENTS[report] ?? []).includes(dim)) throw bad();
  const narrow = (cur: string[] | undefined) => { if (cur?.length && !cur.includes(value)) throw bad(); return [value]; };
  if (dim === 'branch') return { ...q, branchIds: narrow(q.branchIds) };
  if (dim === 'day') {
    if (!DATE.test(value) || value < q.period.from || value > q.period.to) throw bad();
    return { ...q, period: { from: value, to: value } };
  }
  if (dim === 'resourceType') return { ...q, resourceType: narrow(q.resourceType) };
  if (dim === 'status') return { ...q, status: narrow(q.status) };
  if (dim === 'method') return { ...q, method: narrow(q.method) };
  return q;
}

// ---- загрузка ресурсов (utilization.ts): единицы мест, минуты по дням, календарь единицы

const UNITS = [['ПК 1', 'pc'], ['ПК 2', 'pc'], ['VR1', 'vr'], ['VR2', 'vr'], ['PlayStation 1', 'ps']] as const;
const OPEN_MIN = 720; // 10:00–22:00
const unitId = (bi: number, ui: number) => hex('7a000000-0000-4000-8000-', bi * 10 + ui + 1);
const bookedPerDay = (bi: number, ui: number, day: string) => ((Number(day.slice(8)) + ui + bi) % 4) * 60 + (ui >= 2 && ui <= 3 ? 120 : 0); // VR1/VR2: аренда комнаты 14–16
const blockedPerDay = (bi: number, ui: number) => (ui === 3 ? 60 : 0);

function unitRows(env: Env, bs: BranchLite[], p: Period, q: Query): UnitRow[] {
  const now = Date.now();
  const rows: UnitRow[] = [];
  for (const b of bs) {
    const bi = env.branches.indexOf(b);
    UNITS.forEach(([name, type], ui) => {
      if (q.resourceType?.length && !q.resourceType.includes(type)) return;
      const r: UnitRow = { unitId: unitId(bi, ui), unitName: name, resourceId: hex('7b000000-0000-4000-8000-', bi * 10 + ui), resourceType: type, roomId: null, branchId: b.id, branchName: b.name,
        availableMin: 0, availableElapsedMin: 0, blockedMin: 0, technicalMin: 0, bookedMin: 0, usedMin: 0, freeMin: 0 };
      for (let d = p.from; d <= p.to; d = addDays(d, 1)) {
        const open = Date.parse(at(d, 10));
        const elapsed = Math.max(0, Math.min(OPEN_MIN, (now - open) / 60_000));
        const bk = bookedPerDay(bi, ui, d);
        r.availableMin += OPEN_MIN;
        r.availableElapsedMin += Math.round(elapsed);
        r.bookedMin += bk;
        r.blockedMin += blockedPerDay(bi, ui);
        r.usedMin += Math.round(bk * (elapsed / OPEN_MIN) * 0.9);
        r.freeMin += OPEN_MIN - bk - blockedPerDay(bi, ui);
      }
      rows.push(r);
    });
  }
  return rows;
}
function loadMetrics(rows: UnitRow[], prev: UnitRow[]): Record<string, Metric> {
  const sum = (rs: UnitRow[], k: keyof UnitRow) => rs.reduce((a, r) => a + Number(r[k]), 0);
  const keys: Record<string, keyof UnitRow> = { available: 'availableMin', availableElapsed: 'availableElapsedMin', blocked: 'blockedMin', technical: 'technicalMin', booked: 'bookedMin', used: 'usedMin', free: 'freeMin' };
  if (!rows.length) return Object.fromEntries([...Object.keys(keys), 'actualLoad', 'commercialLoad'].map((k) => [k, { state: 'no_data' }]));
  const out: Record<string, Metric> = Object.fromEntries(Object.entries(keys).map(([k, c]) => [k, ok(sum(rows, c), 'minutes', prev.length ? sum(prev, c) : null)]));
  const pct = (rs: UnitRow[], top: keyof UnitRow, base: keyof UnitRow) => (sum(rs, base) > 0 ? (sum(rs, top) / sum(rs, base)) * 100 : null);
  const load = (top: keyof UnitRow, base: keyof UnitRow): Metric => {
    const v = pct(rows, top, base);
    return v === null ? { state: 'unavailable', reason: 'missing_input' } : ok(v, 'pct', prev.length ? pct(prev, top, base) : null);
  };
  return { ...out, actualLoad: load('usedMin', 'availableElapsedMin'), commercialLoad: load('bookedMin', 'availableMin') };
}
function utilization(env: Env, q: RQ): ReportResult & { rows: UnitRow[] } {
  const bs = resolveBranches(env, 'reports.ops.view', q);
  const pp = prevPeriod(q.period);
  const rows = unitRows(env, bs, q.period, q);
  const prev = unitRows(env, bs, pp, q);
  const group = (k: 'branchId' | 'resourceType') => [...new Set(rows.map((r) => String(r[k])))].map((key) => ({ key, metrics: loadMetrics(rows.filter((r) => r[k] === key), prev.filter((r) => r[k] === key)) }));
  const out: ReportResult & { rows: UnitRow[] } = { metrics: loadMetrics(rows, prev), rows, groups: { byBranch: group('branchId'), byResourceType: group('resourceType'), wholeRoom: [] },
    labels: { actualLoad: 'к прошедшему времени периода', commercialLoad: 'ко всему периоду; не равна фактической: бронь может закончиться неявкой', unit: 'единица = место' },
    period: q.period, prevPeriod: pp, computedAt: new Date().toISOString(), dateBasis: 'session_start', dayRule: DAY_RULE };
  if (q.series === 'day') {
    const points = [];
    for (let d = q.period.from; d <= q.period.to; d = addDays(d, 1)) {
      const r = unitRows(env, bs, { from: d, to: d }, q);
      points.push({ bucket: d, availableMin: r.reduce((a, x) => a + Number(x.availableMin), 0), usedMin: r.reduce((a, x) => a + Number(x.usedMin), 0), bookedMin: r.reduce((a, x) => a + Number(x.bookedMin), 0) });
    }
    out.series = { points, zoneNote: null };
  } else if (q.series === 'hour') {
    out.series = { points: Array.from({ length: 24 }, (_, h) => ({ bucket: String(h).padStart(2, '0'), availableMin: h >= 10 && h < 22 ? 60 * rows.length : 0, usedMin: h >= 12 && h < 20 ? 30 * rows.length : 0, bookedMin: h >= 12 && h < 20 ? 35 * rows.length : 0 })),
      zoneNote: new Set(bs.map((b) => b.timezone)).size > 1 ? 'по местному времени каждого филиала' : null };
  }
  return out;
}

// ---- маршруты

function page<T>(rows: T[], q: Query): { slice: T[]; nextCursor: string | null } {
  const from = q.cursor === undefined ? 0 : Number(q.cursor);
  if (!Number.isInteger(from) || from < 0) throw filterInvalid('Неверный курсор', { field: 'cursor' });
  const limit = q.limit ?? 100;
  return { slice: rows.slice(from, from + limit), nextCursor: from + limit < rows.length ? String(from + limit) : null };
}

function metricsOf(env: Env, name: string, q: RQ): ReportResult {
  if (name === 'utilization') return utilization(env, q);
  const r = REPORTS[name]!;
  const bs = resolveBranches(env, r.action, q);
  const defs = r.defs(q, env);
  let metrics = computeMetrics(env, defs, bs, q.period, wideOf(env, q));
  if (r.post) metrics = r.post(metrics, env, q, bs);
  const dateBasis = Object.fromEntries(Object.entries(defs).map(([k, d]) => [k, d.date ? (d.src === 'finance' || d.src === 'ops' ? 'occurred_at' : d.date === 'createdAt' ? 'created_at' : d.date === 'rescheduledAt' ? 'rescheduled_at' : d.src === 'payroll' || d.src === 'repairs' ? 'at' : 'session_start') : 'now']));
  return { metrics, dateBasis, ...(r.labels ? { labels: r.labels } : {}), period: q.period, prevPeriod: prevPeriod(q.period), computedAt: new Date().toISOString(), dayRule: DAY_RULE };
}

function detailOf(env: Env, name: string, q0: RQ): DetailResult {
  const q = applySegment(name, q0);
  if (name === 'utilization') {
    const u = utilization(env, q);
    if (!q.metric || !Object.hasOwn(u.metrics, q.metric)) throw filterInvalid('Неизвестный показатель', { field: 'metric' });
    const col: Record<string, keyof UnitRow> = { available: 'availableMin', availableElapsed: 'availableElapsedMin', blocked: 'blockedMin', technical: 'technicalMin', booked: 'bookedMin', used: 'usedMin', free: 'freeMin' };
    const pg = page([...u.rows].sort((a, b) => (String(a.unitId) < String(b.unitId) ? -1 : 1)), q);
    const rows = pg.slice.map((r) => {
      if (q.metric === 'actualLoad' || q.metric === 'commercialLoad') {
        const [top, base]: Array<keyof UnitRow> = q.metric === 'actualLoad' ? ['usedMin', 'availableElapsedMin'] : ['bookedMin', 'availableMin'];
        return { ...r, value: Number(r[base!]) > 0 ? (Number(r[top!]) / Number(r[base!])) * 100 : null };
      }
      return { ...r, value: r[col[q.metric!]!] };
    });
    return { columns: Object.keys(rows[0] ?? {}), rows, total: u.metrics[q.metric]!, nextCursor: pg.nextCursor };
  }
  const r = REPORTS[name]!;
  const bs = resolveBranches(env, r.action, q);
  const defs = r.defs(q, env);
  const d = q.metric !== undefined && Object.hasOwn(defs, q.metric) ? defs[q.metric]! : undefined;
  if (!d) {
    const m = metricsOf(env, name, q0).metrics;
    if (q.metric && m[q.metric]?.state === 'unavailable') return { columns: r.columns, rows: [], total: m[q.metric]!, nextCursor: null };
    throw filterInvalid('Неизвестный показатель', { field: 'metric' });
  }
  if (name === 'staff' && MONEY.has(q.metric!) && (!env.deps.can(env.s, 'reports.payroll.view') || (q.metric === 'paid' && !wideOf(env, q)))) {
    return { columns: r.columns, rows: [], total: { state: 'unavailable', reason: 'not_permitted' }, nextCursor: null };
  }
  let rows = select(env, d, seed[d.src], bs, q.period, wideOf(env, q));
  if (d.agg === 'distinct') rows = [...new Map(rows.map((x) => [d.key!(x), x])).values()];
  rows.sort((a, b) => String(a[d.date ?? 'id'] ?? a.id).localeCompare(String(b[d.date ?? 'id'] ?? b.id)) || a.id.localeCompare(b.id));
  const total: Metric = rows.length ? ok(aggregate(d, rows), d.unit, null) : { state: 'no_data' };
  const pg = page(rows, q);
  return { columns: r.columns, rows: pg.slice.map((x) => r.project(x, env, d.agg === 'distinct' ? 1 : d.value ? d.value(x) : 1)), total, nextCursor: pg.nextCursor };
}

function dashboard(env: Env, q: RQ): DashboardResult {
  const cards: DashboardCard[] = [];
  const can = (a: string) => env.deps.can(env.s, a);
  const add = (report: string, list: Array<[string, string, string?]>) => {
    const m = metricsOf(env, report, q);
    for (const [key, title, note] of list) cards.push({ key, title, metric: m.metrics[key]!, link: { report, metric: key }, ...(note ? { note } : {}) });
  };
  if (can('reports.ops.view')) {
    add('bookings', [['created', 'Создано броней'], ['visited', 'Состоялось посещений'], ['cancelledByClient', 'Отмены клиентом'], ['cancelledByClub', 'Отмены клубом'], ['noShows', 'Неявки']]);
    add('utilization', [['actualLoad', 'Фактическая загрузка']]);
  }
  if (can('reports.finance.view')) add('finance', [['incomeSession', 'Поступления от сеансов'], ['incomeEvent', 'Поступления от мероприятий'], ['incomeCertificateSale', 'Продажи сертификатов'],
    ['refunds', 'Возвраты'], ['expenses', 'Расходы'], ['netMovement', 'Чистое движение денег'], ['cashClosing', 'Остаток кассы на конец']]);
  if (can('reports.events.view')) add('events', [['count', 'Мероприятия', 'По дате проведения']]);
  if (can('reports.staff.view')) add('staff', [['emptyIntervals', 'Пустые смены', REPORTS.staff!.labels!.emptyIntervals], ['unclosedShifts', 'Незакрытые смены', REPORTS.staff!.labels!.unclosedShifts]]);
  if (can('reports.equipment.view')) add('equipment', [['openFaults', 'Открытые неисправности', 'На момент запроса'], ['downtimeMinutes', 'Часы простоя', 'В минутах, пересечения не задваиваются']]);
  for (const c of cards) c.key = c.key === 'downtimeMinutes' ? 'downtime' : c.key === 'count' ? 'eventsCount' : c.key; // ключи карточек dashboard.ts
  return { cards, period: q.period, prevPeriod: prevPeriod(q.period), dayRule: DAY_RULE, computedAt: new Date().toISOString() };
}

function reconcileRuns(): ReconcileRun[] {
  const checked = { ledger_balance: 12, loyalty_points: 40, loyalty_batch: 55, certificate_balance: 8, cash_place: 6, payroll_accrual: 120, payroll_balance: 9, event_expense: 4, repair_expense: 3, operation_link: 300 };
  return [
    { id: hex('9e000000-0000-4000-8000-', 3), trigger: 'schedule', scheduledFor: '2026-11-11', startedAt: '2026-11-11T00:30:00.000Z', finishedAt: '2026-11-11T00:30:04.000Z', status: 'discrepancies', checked, discrepancyCount: 3, error: null, discrepancies: [
      { check: 'cash_place', objectType: 'branch', objectId: 'b-nsk-krasny', branchId: 'b-nsk-krasny', expected: 1_250_000, actual: 1_200_000, details: { place: 'cash' }, createdAt: '2026-11-11T00:30:03.000Z' },
      { check: 'certificate_balance', objectType: 'certificate', objectId: hex('ce000000-0000-4000-8000-', 1), branchId: 'b-tsk-lenina', expected: 300_000, actual: 350_000, details: {}, createdAt: '2026-11-11T00:30:03.000Z' },
      { check: 'loyalty_points', objectType: 'client', objectId: hex('c0000000-0000-4000-8000-', 1), branchId: null, expected: 12_000, actual: 11_000, details: {}, createdAt: '2026-11-11T00:30:03.000Z' },
    ] },
    { id: hex('9e000000-0000-4000-8000-', 2), trigger: 'schedule', scheduledFor: '2026-11-10', startedAt: '2026-11-10T00:30:00.000Z', finishedAt: '2026-11-10T00:30:03.000Z', status: 'ok', checked, discrepancyCount: 0, error: null, discrepancies: [] },
    { id: hex('9e000000-0000-4000-8000-', 1), trigger: 'manual', scheduledFor: null, startedAt: '2026-11-09T05:00:00.000Z', finishedAt: '2026-11-09T05:00:01.000Z', status: 'failed', checked: null, discrepancyCount: 0, error: 'connection terminated', discrepancies: [] },
  ];
}

function search(env: Env, raw: unknown): SearchResponse {
  if (!env.deps.can(env.s, 'search.global')) throw forbidden('search.global');
  const q = typeof raw === 'string' ? raw.trim() : '';
  const digits = q.replace(/\D/g, '');
  const isDate = /^\d{4}-\d{2}-\d{2}$/.test(q) || /^\d{2}\.\d{2}$/.test(q);
  const phoneLike = !isDate && /^[+\d\s().-]+$/.test(q);
  const isNumber = /^\d{1,15}$/.test(q);
  if (q.length < 2 || q.length > 100) throw new Fail(422, 'SEARCH_QUERY_TOO_SHORT', 'Введите не меньше 2 символов', { min: 2 });
  if (phoneLike && digits.length < 4 && !isNumber) throw new Fail(422, 'SEARCH_QUERY_TOO_SHORT', 'Для поиска по телефону нужно от 4 цифр', { min: 4 });
  const can = (a: string) => env.deps.can(env.s, a);
  const inZone = (id: string | null) => id !== null && (env.zone.network || env.zone.branchIds.includes(id));
  const lower = q.toLowerCase();
  const cut = <I>(all: I[]) => ({ items: all.slice(0, 5), more: all.length > 5 });
  const out: SearchGroup[] = [];
  const clients = can('client.view.basic') && !isDate && (!phoneLike || digits.length >= 4)
    ? env.deps.clients().filter((c) => (env.zone.network || c.links.some(inZone)) && c.firstName && (phoneLike ? (c.phoneE164 ?? '').endsWith(digits) : `${c.firstName} ${c.lastName}`.toLowerCase().split(' ').some((w) => w.startsWith(lower))))
    : [];
  const full = can('client.view.full'); // search.ts: имя – по client.view.full (maskClient), телефон – maskPhone всем ролям, и Владельцу (03 §14)
  if (can('client.view.basic')) out.push({ type: 'client', ...cut(clients.map((c) => ({ id: c.id, name: full ? `${c.firstName} ${c.lastName ?? ''}`.trim() : `${c.firstName}${c.lastName ? ` ${c.lastName[0]}.` : ''}`,
    phone: maskPhone(c.phoneE164), kind: c.status === 'guest' ? 'guest' as const : 'profile' as const }))) });
  if (can('schedule.view')) out.push({ type: 'booking', ...cut(seed.bookings.filter((b) => inZone(b.branchId) && (String(b.number) === q || localDate(String(b.startAt), 'Asia/Novosibirsk') === q))
    .map((b) => ({ id: b.id, number: Number(b.number), branchId: String(b.branchId), branchName: bName(env, b.branchId), startLocal: fmtLocal(String(b.startAt), bTz(env, b.branchId)), status: String(b.status), resourceName: String(b.resourceName) }))) });
  if (can('finance.view')) out.push({ type: 'finance_operation', ...cut(seed.finance.filter((f) => inZone(f.branchId) && (String(f.number) === q || (!isNumber && String(f.comment ?? '').toLowerCase().includes(lower))))
    .map((f) => ({ id: f.id, number: Number(f.number), branchId: String(f.branchId), kind: String(f.kind), amountKop: Number(f.amountKop), occurredAt: String(f.occurredAt), comment: f.comment == null ? null : String(f.comment) }))) });
  if (can('staff.view')) out.push({ type: 'staff', ...cut(phoneLike || isDate ? [] : env.deps.staff().filter((s) => (env.zone.network || (s.branchIds ?? []).some(inZone) || (s.cityIds ?? []).some((c) => env.branches.some((b) => b.cityId === c && inZone(b.id)))) && `${s.firstName} ${s.lastName}`.toLowerCase().split(' ').some((w) => w.startsWith(lower)))
    .map((s) => ({ id: s.id, name: `${s.firstName} ${s.lastName}`, role: s.role }))) });
  if (can('event.view')) out.push({ type: 'event', ...cut(seed.events.filter((e) => inZone(e.branchId) && String(e.number).toUpperCase() === (isNumber ? `EV-${q.padStart(4, '0')}` : q.toUpperCase()))
    .map((e) => ({ id: e.id, number: String(e.number), branchId: String(e.branchId), heldOn: localDate(String(e.heldAt), bTz(env, e.branchId)), status: String(e.status) }))) });
  if (can('equipment.view')) out.push({ type: 'equipment', ...cut(seed.equipment.filter((e) => inZone(e.branchId) && (String(e.inventoryNo) === (isNumber ? `INV-${q.padStart(4, '0')}` : q.toUpperCase()) || String(e.serialNo) === q.toUpperCase()))
    .map((e) => ({ id: e.id, inventoryNo: String(e.inventoryNo), serialNo: e.serialNo == null ? null : String(e.serialNo), branchId: String(e.branchId), status: String(e.status) }))) });
  return { groups: out };
}

// ---- экспорт (export.ts)

const EXPORT_VIEW: Record<string, string> = { bookings: 'reports.ops.view', utilization: 'reports.ops.view', finance: 'reports.finance.view', certificates: 'reports.finance.view', clients: 'reports.clients.view',
  loyalty: 'reports.loyalty.view', comms: 'reports.comms.view', events: 'reports.events.view', staff: 'reports.staff.view', equipment: 'reports.equipment.view' };
const EXPORT_DETAIL: Record<string, string> = { finance: 'reports.export.detail', certificates: 'reports.export.detail' };
const TTL_MS = 24 * 3_600_000;

/** Ход задачи мока: queued → running через 0,3 с → ready через 1 с (в API – worker reports:export). */
function advance(j: ExportJob): ExportJob {
  const age = Date.now() - Date.parse(j.createdAt);
  if (j.status === 'queued' && age > 300) Object.assign(j, { status: 'running', startedAt: new Date().toISOString() });
  if (j.status === 'running' && age > 1000) Object.assign(j, { status: 'ready', rows: 42, bytes: 2048, finishedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + TTL_MS).toISOString() });
  if (j.status === 'ready' && j.expiresAt && Date.parse(j.expiresAt) <= Date.now()) j.status = 'expired';
  return j;
}
function publicJob(stored: ExportJob & { staffId: string; hash: string }): ExportJob {
  advance(stored);
  const j: Partial<typeof stored> = { ...stored };
  delete j.staffId;
  delete j.hash;
  return j as ExportJob;
}

function seedExports(): Array<ExportJob & { staffId: string; hash: string }> {
  const base = { format: 'xlsx' as const, detail: false, masked: false, errorCode: null, rows: null, bytes: null, startedAt: null, finishedAt: null, expiresAt: null, downloadedAt: null };
  return [
    { ...base, id: hex('ea000000-0000-4000-8000-', 901), staffId: 's-owner', hash: 'seed-1', report: 'finance', params: { from: '2026-10-01', to: '2026-10-31' }, status: 'ready', rows: 310, bytes: 18_432,
      createdAt: '2026-11-11T03:00:00.000Z', startedAt: '2026-11-11T03:00:01.000Z', finishedAt: '2026-11-11T03:00:05.000Z', expiresAt: '2026-11-12T03:00:05.000Z' },
    { ...base, id: hex('ea000000-0000-4000-8000-', 902), staffId: 's-owner', hash: 'seed-2', report: 'bookings', format: 'csv', params: { from: '2026-09-01', to: '2026-09-30' }, status: 'expired',
      createdAt: '2026-11-01T03:00:00.000Z', finishedAt: '2026-11-01T03:00:04.000Z', expiresAt: '2026-11-02T03:00:04.000Z' },
    { ...base, id: hex('ea000000-0000-4000-8000-', 903), staffId: 's-owner', hash: 'seed-3', report: 'bookings', detail: true, params: { from: '2025-11-01', to: '2026-10-31', metric: 'created' }, status: 'failed',
      errorCode: 'EXPORT_TOO_LARGE', createdAt: '2026-11-05T03:00:00.000Z', finishedAt: '2026-11-05T03:00:09.000Z' },
  ];
}

function requestExport(env: Env, body: unknown): ExportJob {
  const b = (body ?? {}) as Rec;
  const issues: Array<{ path: string; message: string }> = [];
  for (const k of Object.keys(b)) if (!['report', 'format', 'detail', 'params'].includes(k)) issues.push({ path: k, message: 'Unrecognized key' });
  if (typeof b.report !== 'string' || b.report.length > 40) issues.push({ path: 'report', message: 'Invalid input' });
  if (b.format !== 'xlsx' && b.format !== 'csv') issues.push({ path: 'format', message: 'Invalid option' });
  if (b.detail !== undefined && typeof b.detail !== 'boolean') issues.push({ path: 'detail', message: 'Invalid input: expected boolean' });
  if (b.params !== undefined && (typeof b.params !== 'object' || b.params === null || Array.isArray(b.params))) issues.push({ path: 'params', message: 'Invalid input' });
  if (issues.length) throw filterInvalid('Неверный запрос экспорта', { issues });
  const report = b.report as string;
  const detail = b.detail === true;
  if (report !== 'dashboard' && !Object.hasOwn(EXPORT_VIEW, report)) throw new Fail(404, 'REPORT_UNKNOWN', 'Нет такого отчёта', { report });
  for (const a of ['reports.export', EXPORT_VIEW[report], detail ? EXPORT_DETAIL[report] : undefined]) if (a && !env.deps.can(env.s, a)) throw forbidden(a);
  if (detail && report === 'dashboard') throw filterInvalid('У сводки нет детализации', { field: 'detail' });
  const raw = (b.params ?? {}) as Rec;
  const q = parseQuery(raw.paid === undefined ? raw : { ...raw, paid: String(raw.paid) });
  if (detail && !q.metric) throw filterInvalid('Для детализации нужен показатель', { field: 'metric' });
  const period = parsePeriod(q as Rec);
  const bs = resolveBranches(env, 'reports.export', q);
  if (bs.length === 0) throw notFound();
  const skip = new Set(['cursor', 'limit', 'series', ...(detail ? [] : ['metric', 'segment'])]);
  const params: Rec = {};
  for (const k of Object.keys({ ...q, ...period }).sort()) {
    const v = ({ ...q, ...period } as Rec)[k];
    if (!skip.has(k) && v !== undefined) params[k] = Array.isArray(v) ? [...v].sort() : v;
  }
  if (!env.zone.network) {
    delete params.cityId;
    params.branchIds = bs.map((x) => x.id).sort();
  }
  const hash = JSON.stringify([report, detail, params, env.s.id, b.format]);
  const same = exportsList.find((j) => j.hash === hash && ['queued', 'running', 'ready'].includes(advance(j).status));
  if (same) return publicJob(same);
  const job = { id: randomUUID(), staffId: env.s.id, hash, report, format: b.format as 'xlsx' | 'csv', params, detail, masked: !env.deps.can(env.s, 'export.pd'), status: 'queued' as const,
    errorCode: null, rows: null, bytes: null, createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, expiresAt: null, downloadedAt: null };
  exportsList.unshift(job);
  return publicJob(job);
}

function ownJob(env: Env, id: string) {
  const j = UUID.test(id) ? exportsList.find((x) => x.id === id.toLowerCase() && x.staffId === env.s.id) : undefined;
  if (!j) throw notFound();
  return j;
}

const prm = (req: FastifyRequest) => req.params as { report: string; id: string };

function idempotencyKey(req: FastifyRequest) {
  const v = req.headers['idempotency-key'];
  const key = Array.isArray(v) ? v[0] : v;
  if (key === undefined || key.trim() === '') throw new Fail(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Нужен заголовок Idempotency-Key');
  if (!UUID.test(key.trim())) throw new Fail(400, 'VALIDATION_FAILED', 'Idempotency-Key должен быть UUID', { field: 'Idempotency-Key' });
}

export function resetReports(branches: BranchLite[]): void {
  seed = seedAll(branches);
  exportsList = seedExports();
}

export function registerReports(app: FastifyInstance, P: string, deps: ReportsMockDeps): void {
  for (const r of ['owner', 'director', 'admin'] as const) deps.grant(r, REPORT_ACTIONS[r]);
  resetReports(deps.branches());
  app.addHook('onRequest', async (req) => {
    if (req.method === 'POST' && req.url === '/__test/reset') resetReports(deps.branches());
  });
  const env = (req: FastifyRequest): Env => {
    const s = deps.current(req);
    return { s, zone: deps.zone(s), branches: deps.branches(), deps };
  };
  const handle = (fn: (req: FastifyRequest, reply: FastifyReply) => unknown) => async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      return await fn(req, reply);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      return reply.code(e.status).send({ error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}), requestId: randomUUID() } });
    }
  };
  const rq = (q: Query, maxDays = MAX_DAYS): RQ => ({ ...q, period: parsePeriod(q as Rec, maxDays) });
  const known = (name: string) => {
    if (name !== 'utilization' && !Object.hasOwn(REPORTS, name)) throw new Fail(404, 'REPORT_UNKNOWN', 'Нет такого отчёта', { report: name });
  };

  app.get(`${P}/reports/dashboard`, handle((req) => dashboard(env(req), rq(parseQuery(req.query)))));
  app.get(`${P}/reports/reconcile/runs`, handle((req) => {
    const e = env(req);
    if (!deps.can(e.s, 'audit.view')) throw forbidden('audit.view');
    const cursor = (req.query as Rec).cursor;
    if (cursor !== undefined && Number.isNaN(Date.parse(String(cursor)))) throw filterInvalid('Неверный курсор', { field: 'cursor' });
    const runs = reconcileRuns().filter((r) => cursor === undefined || r.startedAt < new Date(String(cursor)).toISOString());
    return { items: runs.map((r) => (e.zone.network ? r : { ...r, discrepancyCount: undefined, error: undefined, discrepancies: r.discrepancies.filter((d) => d.branchId !== null && e.zone.branchIds.includes(d.branchId)) })), nextCursor: null } satisfies { items: ReconcileRun[]; nextCursor: string | null };
  }));
  app.get(`${P}/search`, handle((req) => search(env(req), (req.query as Rec | undefined)?.q)));
  app.get(`${P}/reports/utilization/calendar`, handle((req) => {
    parseQuery(req.query);
    const e = env(req);
    if (!deps.can(e.s, 'reports.ops.view')) throw forbidden('reports.ops.view');
    const { unitId: id, date } = req.query as Rec;
    const found = e.branches.flatMap((b, bi) => UNITS.map((_, ui) => ({ b, bi, ui, id: unitId(bi, ui) }))).find((u) => u.id === id);
    if (typeof id !== 'string' || !found || !(e.zone.network || e.zone.branchIds.includes(found.b.id))) throw notFound();
    if (typeof date !== 'string' || !DATE.test(date)) throw filterInvalid('Неверная дата', { field: 'date' });
    const iv = (h1: number, m1: number, h2: number, m2: number) => ({ start: at(date, h1, m1), end: at(date, h2, m2) });
    const own = (Number(date.slice(8)) + found.ui + found.bi) % 4;
    const booked = [...(own ? [iv(11, 0, 11 + own, 0)] : []), ...(found.ui === 2 || found.ui === 3 ? [iv(14, 0, 16, 0)] : [])];
    const blocked = found.ui === 3 ? [iv(18, 0, 19, 0)] : [];
    const busy = [...booked, ...blocked].sort((a, b) => a.start.localeCompare(b.start));
    const free: Array<{ start: string; end: string }> = [];
    let cur = at(date, 10);
    for (const x of busy) {
      if (x.start > cur) free.push({ start: cur, end: x.start });
      if (x.end > cur) cur = x.end;
    }
    if (cur < at(date, 22)) free.push({ start: cur, end: at(date, 22) });
    return { unitId: id, date, open: [iv(10, 0, 22, 0)], booked, blocked, free } satisfies UnitCalendar;
  }));
  app.get(`${P}/reports/:report/detail`, handle((req) => {
    const q = parseQuery(req.query);
    known(prm(req).report);
    return detailOf(env(req), prm(req).report, rq(q));
  }));
  app.post(`${P}/reports/exports`, handle((req, reply) => {
    const e = env(req);
    idempotencyKey(req);
    return reply.code(202).send(requestExport(e, req.body));
  }));
  app.get(`${P}/reports/exports`, handle((req) => {
    const e = env(req);
    const cursor = (req.query as Rec).cursor;
    if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 400)) throw filterInvalid('Неверный курсор', { field: 'cursor' });
    if (!deps.can(e.s, 'reports.export')) throw forbidden('reports.export');
    return { items: exportsList.filter((j) => j.staffId === e.s.id).map(publicJob), nextCursor: null } satisfies { items: ExportJob[]; nextCursor: string | null };
  }));
  app.get(`${P}/reports/exports/:id`, handle((req) => publicJob(ownJob(env(req), prm(req).id))));
  app.get(`${P}/reports/exports/:id/file`, handle((req, reply) => {
    const e = env(req);
    const j = ownJob(e, prm(req).id);
    advance(j);
    if (!deps.can(e.s, 'reports.export')) throw new Fail(403, 'EXPORT_FORBIDDEN', 'Право на этот файл потеряно');
    if (j.status === 'expired') throw new Fail(410, 'EXPORT_EXPIRED', 'Срок хранения файла истёк – сформируйте заново');
    if (j.status !== 'ready') throw new Fail(409, 'EXPORT_NOT_READY', 'Файл ещё не готов', { status: j.status });
    j.downloadedAt = new Date().toISOString();
    const csv = j.format === 'csv';
    reply.header('Content-Type', csv ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    reply.header('Content-Disposition', `attachment; filename="${j.report}-${String(j.params.from)}-${String(j.params.to)}.${j.format}"`);
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    return reply.send('﻿Отчёт;Период\r\nмок;1\r\n');
  }));
  app.post(`${P}/reports/exports/:id/cancel`, handle((req) => {
    const e = env(req);
    idempotencyKey(req);
    const j = ownJob(e, prm(req).id);
    advance(j);
    if (j.status === 'queued' || j.status === 'running') Object.assign(j, { status: 'cancelled', finishedAt: new Date().toISOString() });
    return publicJob(j);
  }));
  app.get(`${P}/reports/:report`, handle((req) => {
    const q = parseQuery(req.query);
    known(prm(req).report);
    return metricsOf(env(req), prm(req).report, rq(q));
  }));
}

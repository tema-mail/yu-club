// Мок операционных экранов филиала (S1-24): строго по маршрутам API –
// resources/routes.ts (комнаты, ресурсы, единицы, состав с dryRun), booking/blocks.ts (блокировки),
// network/routes.ts + calendar.ts (недельный график и исключения: предпросмотр → применение с confirmedAffected),
// pricing/routes.ts + tariff.ts (тарифы: цена неизменна, конфликт приоритета – до сохранения).
// Помещений (spaces) экран не использует – их маршрутов в моке нет. Брони для «затронутых» – из mock-booking.ts (syncOps).
// Подключается из mock-api.ts (registerOps), resetOps() – в POST /__test/reset.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';

type Rec = Record<string, unknown>;
interface Staffish { id: string; role: string }
interface BranchLite { id: string; timezone: string; status: string }
export interface OpsDeps {
  current: (req: FastifyRequest) => Staffish;
  zone: (s: Staffish) => { branchIds: string[] };
  can: (s: Staffish, action: string) => boolean;
  branches: () => BranchLite[];
  reasons: () => Array<Rec & { id?: unknown; domain?: unknown; archivedAt: string | null; requiresComment?: unknown }>;
  resourceTypes: () => Array<Rec & { code: string; bookable?: unknown; archivedAt: string | null }>;
  fail: (reply: FastifyReply, status: number, code: string, message: string, details?: Rec) => unknown;
  audit: (s: Staffish, objectType: string, objectId: string, action: string, before: object, after: object, reason?: string | null) => void;
}

interface Room { id: string; branchId: string; spaceId: string | null; slug: string; name: string; capacity: number | null; publicDescription: string | null;
  internalDescription: string | null; status: string; isPublished: boolean; wholeRentAllowed: boolean; sortOrder: number; archivedAt: string | null; rowVersion: number }
interface Resource { id: string; branchId: string; roomId: string | null; type: string; name: string; status: string; selfBookable: boolean;
  stepMinutesOverride: number | null; sortOrder: number; internalComment: string | null; archivedAt: string | null; rowVersion: number }
interface Unit { id: string; branchId: string; roomId: string | null; code: string; name: string; status: 'active' | 'archived' }
interface Booking { id: string; branchId: string; unitIds: string[]; date: string; start: string; end: string }
interface Hours { weekday: number; open: string | null; close: string | null; closed: boolean; validFrom: string; validTo: string | null }
interface Exception { id: string; branchId: string; scope: { type: 'branch' } | { type: 'room' | 'resource'; id: string }; date: string; kind: string;
  open: string | null; close: string | null; reason: string; status: 'active' | 'cancelled'; createdBy: string; createdAt: string }
interface Block { id: string; branchId: string; targetType: string; targetIds: string[]; start: string; end: string; reasonId: string; comment: string | null;
  status: 'active' | 'lifted'; unitIds: string[]; rowVersion: number }
interface Tariff { id: string; branchId: string; resourceType: string; name: string; unitMinutes: number; pricePerUnitKop: number; durationFromMin: number;
  durationToMin: number | null; validFrom: string; validTo: string | null; priority: number; status: 'draft' | 'active' | 'archived'; createdBy: string;
  createdAt: string; archivedAt: string | null }

const TZ_OFFSET = '+07:00'; // филиалы засева – Новосибирск и Томск (UTC+7)
const localToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Novosibirsk' }).format(new Date());
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const weekdayOf = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay() || 7;
const iso = (date: string, time: string) => new Date(`${date}T${time}:00${TZ_OFFSET}`).toISOString();
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const OWN_UNIT_TYPES = new Set(['pc', 'vr_seat', 'ps_room']);
const CLOSING = new Set(['closed', 'holiday', 'technical']);
const ZONE: Record<string, string> = { pc: 'pc', vr_seat: 'vr', room_whole: 'vr', composite: 'vr', ps_room: 'ps' };
const STEP: Record<string, number> = { pc: 30, vr_seat: 15, room_whole: 15, ps_room: 30, composite: 15 };

function seed() {
  const today = localToday();
  const room = (id: string, branchId: string, slug: string, name: string, extra: Partial<Room> = {}): Room => ({
    id, branchId, spaceId: null, slug, name, capacity: null, publicDescription: null, internalDescription: null, status: 'active',
    isPublished: true, wholeRentAllowed: false, sortOrder: 0, archivedAt: null, rowVersion: 1, ...extra,
  });
  const res = (id: string, branchId: string, roomId: string, type: string, name: string, sortOrder: number): Resource => ({
    id, branchId, roomId, type, name, status: 'active', selfBookable: true, stepMinutesOverride: null, sortOrder, internalComment: null, archivedAt: null, rowVersion: 1,
  });
  const unit = (id: string, branchId: string, roomId: string, code: string, name: string): Unit => ({ id, branchId, roomId, code, name, status: 'active' });
  const K = 'b-nsk-krasny';
  return {
    rooms: [
      room('r-hall', K, 'hall', 'Общий зал', { capacity: 20, sortOrder: 10 }),
      room('r-vr', K, 'vr', 'VR-комната', { capacity: 4, wholeRentAllowed: true, sortOrder: 20 }),
      room('r-tsk-hall', 'b-tsk-lenina', 'hall', 'Зал Томск', { capacity: 10 }),
    ],
    resources: [
      res('res-pc1', K, 'r-hall', 'pc', 'ПК 1', 10), res('res-pc2', K, 'r-hall', 'pc', 'ПК 2', 20),
      res('res-vr1', K, 'r-vr', 'vr_seat', 'VR1', 30), res('res-vr2', K, 'r-vr', 'vr_seat', 'VR2', 40),
      res('res-vrroom', K, 'r-vr', 'room_whole', 'VR-комната целиком', 50),
      res('res-tsk-pc1', 'b-tsk-lenina', 'r-tsk-hall', 'pc', 'ПК 1', 10),
    ],
    units: [
      unit('u-pc1', K, 'r-hall', 'PC1', 'ПК 1'), unit('u-pc2', K, 'r-hall', 'PC2', 'ПК 2'),
      unit('u-vr1', K, 'r-vr', 'VR1', 'VR1'), unit('u-vr2', K, 'r-vr', 'VR2', 'VR2'), unit('u-ps4', K, 'r-vr', 'PS4', 'PS4 в VR-комнате'),
      unit('u-tsk-pc1', 'b-tsk-lenina', 'r-tsk-hall', 'PC1', 'ПК 1'),
    ],
    composition: {
      'res-pc1': ['u-pc1'], 'res-pc2': ['u-pc2'], 'res-vr1': ['u-vr1'], 'res-vr2': ['u-vr2'],
      'res-vrroom': ['u-ps4', 'u-vr1', 'u-vr2'], 'res-tsk-pc1': ['u-tsk-pc1'],
    } as Record<string, string[]>,
    compositionFrom: {} as Record<string, string>,
    bookings: [
      { id: 'bk-pc1-evening', branchId: K, unitIds: ['u-pc1'], date: addDays(today, 1), start: '20:00', end: '22:00' },
      { id: 'bk-vrroom', branchId: K, unitIds: ['u-ps4', 'u-vr1', 'u-vr2'], date: addDays(today, 3), start: '15:00', end: '17:00' },
      { id: 'bk-tsk', branchId: 'b-tsk-lenina', unitIds: ['u-tsk-pc1'], date: addDays(today, 1), start: '12:00', end: '14:00' },
    ] as Booking[],
    hours: {
      [K]: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, open: '10:00', close: '22:00', closed: false, validFrom: '2026-01-01', validTo: null })),
      'b-nsk-akadem': [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, open: '10:00', close: '22:00', closed: false, validFrom: '2026-01-01', validTo: null })),
      'b-tsk-lenina': [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, open: '09:00', close: '21:00', closed: false, validFrom: '2026-01-01', validTo: null })),
    } as Record<string, Hours[]>,
    exceptions: [] as Exception[],
    blocks: [] as Block[],
    tariffs: [
      { id: 't-pc-base', branchId: K, resourceType: 'pc', name: 'ПК – базовый', unitMinutes: 60, pricePerUnitKop: 15000, durationFromMin: 0, durationToMin: null,
        validFrom: '2026-01-01T00:00:00.000Z', validTo: null, priority: 0, status: 'active', createdBy: 's-owner', createdAt: '2026-01-01T00:00:00.000Z', archivedAt: null },
      { id: 't-vr-base', branchId: K, resourceType: 'vr_seat', name: 'VR – базовый', unitMinutes: 15, pricePerUnitKop: 25000, durationFromMin: 0, durationToMin: null,
        validFrom: '2026-01-01T00:00:00.000Z', validTo: null, priority: 0, status: 'active', createdBy: 's-owner', createdAt: '2026-01-01T00:00:00.000Z', archivedAt: null },
    ] as Tariff[],
  };
}
let db = seed();
export function resetOps(): void {
  db = seed();
}

/** Часы объекта на дату с учётом исключений: null – закрыто. */
function hoursOn(branchId: string, date: string, rows: Hours[], exs: Exception[], unitIds: string[]): { open: string; close: string } | null {
  const roomIds = new Set(db.units.filter((u) => unitIds.includes(u.id)).map((u) => u.roomId));
  const resIds = new Set(Object.entries(db.composition).filter(([, us]) => us.some((u) => unitIds.includes(u))).map(([r]) => r));
  const ex = exs.filter((e) => e.status === 'active' && e.branchId === branchId && e.date === date &&
    (e.scope.type === 'branch' || (e.scope.type === 'room' && roomIds.has(e.scope.id)) || (e.scope.type === 'resource' && resIds.has(e.scope.id))));
  if (ex.some((e) => CLOSING.has(e.kind))) return null;
  const special = ex.find((e) => e.open && e.close);
  if (special) return { open: special.open!, close: special.close! };
  const w = rows.filter((r) => r.weekday === weekdayOf(date) && r.validFrom <= date && (!r.validTo || r.validTo >= date)).sort((a, b) => b.validFrom.localeCompare(a.validFrom))[0];
  return w && !w.closed && w.open && w.close ? { open: w.open, close: w.close } : null;
}
/** Для мока броней (mock-booking.ts): состояние и часы работы объекта на дату по графику и исключениям. */
export const opsState = () => db;
export const opsHoursOn = (branchId: string, date: string, unitIds: string[]) => hoursOn(branchId, date, db.hours[branchId] ?? [], db.exceptions, unitIds);

const sortIds = (ids: string[]) => [...new Set(ids)].sort();
const same = (a: string[], b: string[]) => JSON.stringify(sortIds(a)) === JSON.stringify(sortIds(b));

export function registerOps(app: FastifyInstance, P: string, d: OpsDeps): void {
  const notFound = (reply: FastifyReply) => d.fail(reply, 404, 'NOT_FOUND', 'Не найдено');
  const invalid = (reply: FastifyReply, message: string, details: Rec = {}) => d.fail(reply, 400, 'VALIDATION_FAILED', message, details);
  const issues = (reply: FastifyReply, list: Array<{ path: string; message: string }>) => invalid(reply, 'Неверные данные запроса', { issues: list });
  const conflict = (reply: FastifyReply, current: number) => d.fail(reply, 409, 'VERSION_CONFLICT', 'Запись изменилась – обновите форму', { current });
  const linkInvalid = (reply: FastifyReply, field: string) => d.fail(reply, 422, 'RESOURCE_LINK_INVALID', 'Связанный объект не найден в этом филиале или в архиве', { field });

  // K21 §9 / K24 §4: сбои критичных уведомлений для предупреждений Владельца – форма ответа потока уведомлений
  // (notifications/routes.crm.ts, делает другой поток): { critical, periodFrom, periodTo }, период – последние сутки по зоне сети.
  // Право – notifications.view. Здесь, а не в mock-notifications.ts: тот файл ведёт поток уведомлений.
  app.get(`${P}/notifications/failures/summary`, async (req, reply) => {
    if (!d.can(d.current(req), 'notifications.view')) return d.fail(reply, 403, 'FORBIDDEN', 'Недостаточно прав', { action: 'notifications.view' });
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Novosibirsk' }).format(new Date());
    const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    return { critical: 2, periodFrom: yesterday, periodTo: today };
  });

  /** Видимость по филиалу (view) → право (perm). Вне зоны – 404, без права – 403. */
  function guard(req: FastifyRequest, reply: FastifyReply, branchId: string, view: string, perm?: string): Staffish | null {
    const s = d.current(req);
    const b = d.branches().find((x) => x.id === branchId);
    if (!b || !d.can(s, view) || !d.zone(s).branchIds.includes(branchId)) {
      notFound(reply);
      return null;
    }
    if (perm && !d.can(s, perm)) {
      d.fail(reply, 403, 'FORBIDDEN', 'Недостаточно прав', { action: perm });
      return null;
    }
    return s;
  }
  const paged = <T>(all: T[], q: { cursor?: string; limit?: string }) => {
    const size = Math.min(Number(q.limit ?? 50), Number(process.env.MOCK_PAGE_SIZE ?? 100));
    const from = q.cursor ? Number(q.cursor) : 0;
    return { items: all.slice(from, from + size), nextCursor: from + size < all.length ? String(from + size) : null };
  };
  const bySort = (a: { sortOrder: number; name: string; id: string }, b: { sortOrder: number; name: string; id: string }) =>
    a.sortOrder - b.sortOrder || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

  // ---- комнаты и ресурсы (resources/routes.ts)

  const ROOM_FIELDS = ['spaceId', 'slug', 'name', 'capacity', 'publicDescription', 'internalDescription', 'status', 'isPublished', 'wholeRentAllowed', 'sortOrder'];
  const RES_FIELDS = ['roomId', 'type', 'name', 'status', 'selfBookable', 'stepMinutesOverride', 'sortOrder', 'internalComment'];
  const card = (r: Resource) => {
    const room = db.rooms.find((x) => x.id === r.roomId);
    return { ...r, stepMinutes: r.stepMinutesOverride ?? STEP[r.type] ?? 30, zone: ZONE[r.type] ?? 'pc', roomStatus: room?.status ?? null, unitIds: db.composition[r.id] ?? [] };
  };

  function check(kind: 'room' | 'resource', body: Rec, partial: boolean): Array<{ path: string; message: string }> {
    const fields = kind === 'room' ? ROOM_FIELDS : RES_FIELDS;
    const extra = Object.keys(body).filter((k) => !fields.includes(k) && !['rowVersion', 'unitCode', 'unitIds'].includes(k));
    const out = extra.map((k) => ({ path: k, message: 'Лишнее поле' }));
    if (partial && body.type !== undefined) out.push({ path: 'type', message: 'Тип ресурса не меняется' });
    const req = kind === 'room' ? ['slug', 'name'] : ['type', 'name'];
    for (const k of req) if (!partial && (typeof body[k] !== 'string' || !(body[k] as string).trim())) out.push({ path: k, message: 'Заполните поле' });
    if (typeof body.name === 'string' && !body.name.trim()) out.push({ path: 'name', message: 'Заполните поле' });
    if (body.slug !== undefined && !/^[a-z0-9-]{1,64}$/.test(String(body.slug))) out.push({ path: 'slug', message: 'Латиница в нижнем регистре, цифры и дефис' });
    if (body.capacity !== undefined && body.capacity !== null && !(Number.isInteger(body.capacity) && (body.capacity as number) >= 1)) out.push({ path: 'capacity', message: 'Целое от 1' });
    return out;
  }

  for (const kind of ['room', 'resource'] as const) {
    const plural = kind === 'room' ? 'rooms' : 'resources';
    const table = () => (kind === 'room' ? db.rooms : db.resources) as Array<Room | Resource>;

    app.get(`${P}/branches/:branchId/${plural}`, async (req, reply) => {
      const { branchId } = req.params as { branchId: string };
      if (!guard(req, reply, branchId, 'resources.view')) return reply;
      const q = req.query as { includeArchived?: string; roomId?: string; cursor?: string; limit?: string };
      const all = table()
        .filter((r) => r.branchId === branchId && (q.includeArchived === 'true' || r.status !== 'archived'))
        .filter((r) => !(kind === 'resource' && q.roomId) || (r as Resource).roomId === q.roomId)
        .sort(bySort);
      return paged(all, q);
    });

    app.get(`${P}/${plural}/:id`, async (req, reply) => {
      const row = table().find((r) => r.id === (req.params as { id: string }).id);
      if (!row) return notFound(reply);
      if (!guard(req, reply, row.branchId, 'resources.view')) return reply;
      return kind === 'resource' ? card(row as Resource) : row;
    });

    app.post(`${P}/branches/:branchId/${plural}`, async (req, reply) => {
      const { branchId } = req.params as { branchId: string };
      const s = guard(req, reply, branchId, 'resources.view', 'resources.manage');
      if (!s) return reply;
      const body = (req.body ?? {}) as Rec;
      const bad = check(kind, body, false);
      if (bad.length) return issues(reply, bad);
      if (body.roomId && !db.rooms.some((r) => r.id === body.roomId && r.branchId === branchId && r.status !== 'archived')) return linkInvalid(reply, 'roomId');
      if (kind === 'room') {
        if (db.rooms.some((r) => r.branchId === branchId && r.slug === body.slug)) return d.fail(reply, 409, 'RESOURCE_SLUG_TAKEN', 'Адрес (slug) уже занят в филиале');
        const row: Room = {
          id: `r-${randomUUID().slice(0, 8)}`, branchId, spaceId: null, slug: String(body.slug), name: String(body.name).trim(), capacity: null, publicDescription: null,
          internalDescription: null, status: 'active', isPublished: false, wholeRentAllowed: false, sortOrder: 0, archivedAt: null, rowVersion: 1,
          ...Object.fromEntries(ROOM_FIELDS.filter((k) => body[k] !== undefined && k !== 'name').map((k) => [k, body[k]])),
        };
        db.rooms.push(row);
        d.audit(s, 'room', row.id, 'room.created', {}, row);
        return reply.code(201).send(row);
      }
      const type = String(body.type);
      if (!d.resourceTypes().some((t) => t.code === type && t.bookable !== false && !t.archivedAt)) return linkInvalid(reply, 'type');
      const row: Resource = {
        id: `res-${randomUUID().slice(0, 8)}`, branchId, roomId: null, type, name: String(body.name).trim(), status: 'active', selfBookable: true,
        stepMinutesOverride: null, sortOrder: 0, internalComment: null, archivedAt: null, rowVersion: 1,
        ...Object.fromEntries(RES_FIELDS.filter((k) => body[k] !== undefined && !['name', 'type'].includes(k)).map((k) => [k, body[k]])),
      };
      let unitIds: string[];
      if (OWN_UNIT_TYPES.has(type)) {
        if (body.unitIds !== undefined) return invalid(reply, 'У обычного ресурса своя единица – unitIds не передаются', { field: 'unitIds' });
        const code = String(body.unitCode ?? row.name);
        if (db.units.some((u) => u.branchId === branchId && u.code === code)) return d.fail(reply, 409, 'RESOURCE_SLUG_TAKEN', 'Код единицы уже занят в филиале', { field: 'unitCode' });
        const u: Unit = { id: `u-${randomUUID().slice(0, 8)}`, branchId, roomId: row.roomId, code, name: row.name, status: 'active' };
        db.units.push(u);
        unitIds = [u.id];
      } else {
        if (body.unitCode !== undefined) return invalid(reply, 'Составной ресурс собирается из unitIds', { field: 'unitCode' });
        unitIds = sortIds((body.unitIds as string[] | undefined) ?? []);
        if (unitIds.some((id) => !db.units.some((u) => u.id === id && u.branchId === branchId && u.status === 'active'))) {
          return d.fail(reply, 422, 'RESOURCE_LINK_INVALID', 'Единица не найдена в этом филиале или в архиве', { field: 'unitIds' });
        }
      }
      db.resources.push(row);
      db.composition[row.id] = unitIds;
      d.audit(s, 'resource', row.id, 'resource.created', {}, { ...row, unitIds });
      return reply.code(201).send({ ...row, unitIds });
    });

    app.patch(`${P}/${plural}/:id`, async (req, reply) => {
      const row = table().find((r) => r.id === (req.params as { id: string }).id);
      if (!row) return notFound(reply);
      const s = guard(req, reply, row.branchId, 'resources.view', 'resources.manage');
      if (!s) return reply;
      const body = (req.body ?? {}) as Rec;
      const bad = check(kind, body, true);
      if (typeof body.rowVersion !== 'number') bad.push({ path: 'rowVersion', message: 'Нужна версия' });
      if (bad.length) return issues(reply, bad);
      if (row.status === 'archived') return d.fail(reply, 409, 'RESOURCE_ARCHIVED', 'Объект в архиве');
      if (body.rowVersion !== row.rowVersion) return conflict(reply, row.rowVersion);
      if (body.roomId && !db.rooms.some((r) => r.id === body.roomId && r.branchId === row.branchId && r.status !== 'archived')) return linkInvalid(reply, 'roomId');
      if (kind === 'room' && body.slug !== undefined && db.rooms.some((r) => r.branchId === row.branchId && r.slug === body.slug && r.id !== row.id)) {
        return d.fail(reply, 409, 'RESOURCE_SLUG_TAKEN', 'Адрес (slug) уже занят в филиале');
      }
      const before = { ...row };
      const fields = kind === 'room' ? ROOM_FIELDS : RES_FIELDS;
      for (const k of fields) if (body[k] !== undefined) (row as unknown as Rec)[k] = typeof body[k] === 'string' && k === 'name' ? (body[k] as string).trim() : body[k];
      row.rowVersion += 1;
      d.audit(s, kind, row.id, `${kind}.updated`, before, row);
      return row;
    });

    app.post(`${P}/${plural}/:id/archive`, async (req, reply) => {
      const row = table().find((r) => r.id === (req.params as { id: string }).id);
      if (!row) return notFound(reply);
      const s = guard(req, reply, row.branchId, 'resources.view', 'resources.manage');
      if (!s) return reply;
      const body = (req.body ?? {}) as Rec;
      if (typeof body.rowVersion !== 'number') return issues(reply, [{ path: 'rowVersion', message: 'Нужна версия' }]);
      if (row.status === 'archived') return row;
      if (body.rowVersion !== row.rowVersion) return conflict(reply, row.rowVersion);
      if (kind === 'room' && db.resources.some((r) => r.roomId === row.id && r.status !== 'archived')) {
        return d.fail(reply, 409, 'OBJECT_IN_USE', 'Сначала уберите в архив вложенные объекты');
      }
      const before = { ...row };
      Object.assign(row, { status: 'archived', archivedAt: new Date().toISOString(), rowVersion: row.rowVersion + 1 });
      d.audit(s, kind, row.id, `${kind}.archived`, before, row);
      return row;
    });
  }

  app.get(`${P}/branches/:branchId/units`, async (req, reply) => {
    const { branchId } = req.params as { branchId: string };
    if (!guard(req, reply, branchId, 'resources.view')) return reply;
    return { items: db.units.filter((u) => u.branchId === branchId).sort((a, b) => a.code.localeCompare(b.code)), nextCursor: null };
  });

  app.post(`${P}/branches/:branchId/units`, async (req, reply) => {
    const { branchId } = req.params as { branchId: string };
    const s = guard(req, reply, branchId, 'resources.view', 'resources.manage');
    if (!s) return reply;
    const b = (req.body ?? {}) as Rec;
    if (typeof b.code !== 'string' || !b.code.trim() || typeof b.name !== 'string' || !b.name.trim() || typeof b.roomId !== 'string') {
      return issues(reply, [{ path: 'code', message: 'Заполните код, название и комнату' }]);
    }
    if (!db.rooms.some((r) => r.id === b.roomId && r.branchId === branchId && r.status !== 'archived')) return linkInvalid(reply, 'roomId');
    if (db.units.some((u) => u.branchId === branchId && u.code === (b.code as string).trim())) {
      return d.fail(reply, 409, 'RESOURCE_SLUG_TAKEN', 'Код единицы уже занят в филиале', { field: 'unitCode' });
    }
    const unit: Unit = { id: `u-${randomUUID().slice(0, 8)}`, branchId, roomId: b.roomId, code: (b.code as string).trim(), name: (b.name as string).trim(), status: 'active' };
    db.units.push(unit);
    d.audit(s, 'room', unit.roomId!, 'room.updated', { unit: null }, { unit });
    return reply.code(201).send(unit);
  });

  /** Брони/удержания, занимающие ровно текущий состав ресурса после момента at (composite.ts futureUsage). */
  const futureUsage = (resourceId: string, at: Date) =>
    db.bookings.filter((b) => Date.parse(iso(b.date, b.end)) > at.getTime() && same(b.unitIds, db.composition[resourceId] ?? [])).map((b) => b.id).sort();

  app.post(`${P}/resources/:id/composition`, async (req, reply) => {
    const r = db.resources.find((x) => x.id === (req.params as { id: string }).id);
    if (!r) return notFound(reply);
    const s = guard(req, reply, r.branchId, 'resources.view', 'resources.manage');
    if (!s) return reply;
    const b = (req.body ?? {}) as { unitIds?: unknown; validFrom?: unknown; dryRun?: unknown };
    if (!Array.isArray(b.unitIds) || b.unitIds.length === 0 || typeof b.validFrom !== 'string' || Number.isNaN(Date.parse(b.validFrom))) {
      return issues(reply, [{ path: 'unitIds', message: 'Нужен состав и дата начала' }]);
    }
    if (r.status === 'archived') return d.fail(reply, 409, 'RESOURCE_ARCHIVED', 'Объект в архиве');
    const unitIds = sortIds(b.unitIds as string[]);
    if (unitIds.some((id) => !db.units.some((u) => u.id === id && u.branchId === r.branchId && u.status === 'active'))) {
      return d.fail(reply, 422, 'RESOURCE_LINK_INVALID', 'Единица не найдена в этом филиале или в архиве', { field: 'unitIds' });
    }
    const validFrom = new Date(b.validFrom);
    if (validFrom.getTime() < Date.now() - 60_000) return invalid(reply, 'Состав меняется с текущего момента или позже – прошлое не переписывается', { field: 'validFrom' });
    const last = db.compositionFrom[r.id];
    if (last && validFrom.getTime() <= Date.parse(last)) return invalid(reply, 'Дата раньше последнего изменения состава', { field: 'validFrom', last });
    const before = db.composition[r.id] ?? [];
    const affected = same(before, unitIds) ? [] : futureUsage(r.id, validFrom);
    const result = { affectedBookingIds: affected, affectedHoldIds: [] as string[], applied: false };
    if (same(before, unitIds) || b.dryRun === true) return result;
    if (affected.length) {
      return d.fail(reply, 409, 'COMPOSITION_HAS_FUTURE_BOOKINGS', 'У ресурса есть будущие брони – решите каждую до смены состава', { bookingIds: affected, holdIds: [] });
    }
    db.composition[r.id] = unitIds;
    db.compositionFrom[r.id] = validFrom.toISOString();
    d.audit(s, 'resource', r.id, 'resource.composition_changed', { unitIds: before }, { unitIds, validFrom: validFrom.toISOString() });
    return { ...result, applied: true };
  });

  // ---- блокировки (booking/blocks.ts): брони не трогаются, только список затронутых

  function unitsOfTarget(branchId: string, t: { type: string; ids: string[] }): string[] | null {
    const out: string[] = [];
    for (const id of t.ids) {
      if (t.type === 'unit') {
        if (!db.units.some((u) => u.id === id && u.branchId === branchId && u.status === 'active')) return null;
        out.push(id);
      } else if (t.type === 'resource' || t.type === 'resources') {
        const r = db.resources.find((x) => x.id === id && x.branchId === branchId && x.status !== 'archived');
        if (!r) return null;
        out.push(...(db.composition[r.id] ?? []));
      } else {
        if (!db.rooms.some((x) => x.id === id && x.branchId === branchId && x.status !== 'archived')) return null;
        out.push(...db.units.filter((u) => u.roomId === id && u.status === 'active').map((u) => u.id));
      }
    }
    return sortIds(out);
  }

  app.post(`${P}/branches/:branchId/blocks`, async (req, reply) => {
    const { branchId } = req.params as { branchId: string };
    const s = guard(req, reply, branchId, 'schedule.view', 'block.manage');
    if (!s) return reply;
    const b = (req.body ?? {}) as { target?: { type?: string; ids?: string[] }; start?: string; end?: string; reasonId?: string; comment?: string };
    const bad: Array<{ path: string; message: string }> = [];
    if (!b.target || !['unit', 'resource', 'room', 'resources'].includes(String(b.target.type)) || !Array.isArray(b.target.ids) || b.target.ids.length === 0) {
      bad.push({ path: 'target', message: 'Выберите, что блокировать' });
    }
    if (!b.start || Number.isNaN(Date.parse(b.start))) bad.push({ path: 'start', message: 'Укажите начало' });
    if (!b.end || Number.isNaN(Date.parse(b.end))) bad.push({ path: 'end', message: 'Укажите конец' });
    if (typeof b.reasonId !== 'string') bad.push({ path: 'reasonId', message: 'Выберите причину' });
    if (bad.length) return issues(reply, bad);
    const start = Date.parse(b.start!);
    const end = Date.parse(b.end!);
    if (!(start < end)) return invalid(reply, 'Конец блокировки раньше начала', { field: 'end' });
    const reason = d.reasons().find((r) => r.id === b.reasonId && r.domain === 'resource_block' && !r.archivedAt);
    if (!reason) return invalid(reply, 'Неизвестная причина блокировки', { field: 'reasonId' });
    const comment = b.comment?.trim() || null;
    if (reason.requiresComment && !comment) return invalid(reply, 'Для этой причины нужен комментарий', { field: 'comment' });
    const unitIds = unitsOfTarget(branchId, b.target as { type: string; ids: string[] });
    if (!unitIds) return d.fail(reply, 422, 'RESOURCE_LINK_INVALID', 'Цель блокировки не найдена в этом филиале', { field: 'target.ids' });
    const block: Block = {
      id: randomUUID(), branchId, targetType: b.target!.type!, targetIds: b.target!.ids!, start: new Date(start).toISOString(), end: new Date(end).toISOString(),
      reasonId: b.reasonId!, comment, status: 'active', unitIds, rowVersion: 1,
    };
    db.blocks.push(block);
    const affected = db.bookings
      .filter((x) => x.unitIds.some((u) => unitIds.includes(u)) && Date.parse(iso(x.date, x.start)) < end && Date.parse(iso(x.date, x.end)) > start)
      .map((x) => x.id).sort();
    d.audit(s, 'resource_block', block.id, 'block.created', {}, { target: b.target, start: block.start, end: block.end, reasonId: block.reasonId, unitIds, affectedBookingIds: affected });
    return reply.code(201).send({ block, affectedBookingIds: affected, affectedHoldIds: [] });
  });

  app.post(`${P}/blocks/:blockId/lift`, async (req, reply) => {
    const block = db.blocks.find((x) => x.id === (req.params as { blockId: string }).blockId);
    if (!block) return notFound(reply);
    const s = guard(req, reply, block.branchId, 'schedule.view', 'block.manage');
    if (!s) return reply;
    const b = (req.body ?? {}) as { rowVersion?: unknown; comment?: string };
    if (typeof b.rowVersion !== 'number') return issues(reply, [{ path: 'rowVersion', message: 'Нужна версия' }]);
    if (block.status === 'lifted') return block;
    if (b.rowVersion !== block.rowVersion) return conflict(reply, block.rowVersion);
    Object.assign(block, { status: 'lifted', rowVersion: block.rowVersion + 1 });
    d.audit(s, 'resource_block', block.id, 'block.lifted', { status: 'active' }, { status: 'lifted', comment: b.comment ?? null });
    return block;
  });

  // ---- недельный график и исключения (network/calendar.ts)

  const outside = (b: Booking, h: { open: string; close: string } | null) => !h || b.start < h.open || b.end > h.close;

  type Change =
    | { kind: 'weekly'; validFrom: string; days: Array<{ weekday: number; open: string | null; close: string | null }> }
    | { kind: 'exception'; scope: Exception['scope']; date: string; exceptionKind: string; open?: string; close?: string; reason: string }
    | { kind: 'cancel_exception'; exceptionId: string; reason: string };

  /** prepare(): проверки + затронутые брони. Ошибка – ответ уже отправлен, возвращается null. */
  function prepare(reply: FastifyReply, branchId: string, c: Change): { affected: string[]; target?: Exception } | null {
    const today = localToday();
    const rows = db.hours[branchId] ?? [];
    const badHours = (open: unknown, close: unknown, required: boolean) => {
      if (!required && open == null && close == null) return false;
      return !(typeof open === 'string' && typeof close === 'string' && TIME.test(open) && TIME.test(close) && close > open);
    };
    const hoursError = () => d.fail(reply, 422, 'INVALID_HOURS', 'Время закрытия должно быть позже открытия, в пределах суток');
    let nextRows = rows;
    let nextEx = db.exceptions;
    let target: Exception | undefined;
    let dates: string[];
    if (c.kind === 'weekly') {
      if (!DATE.test(String(c.validFrom)) || !Array.isArray(c.days) || c.days.length === 0) return issues(reply, [{ path: 'days', message: 'Нужны дата и дни' }]), null;
      if (c.validFrom <= today) return invalid(reply, 'Прошлое не меняется', { field: 'validFrom', value: c.validFrom, today }), null;
      const wd = c.days.map((x) => x.weekday);
      if (new Set(wd).size !== wd.length) return invalid(reply, 'День недели повторяется', { weekdays: wd }), null;
      if (c.days.some((x) => badHours(x.open, x.close, false))) return hoursError(), null;
      if (rows.some((r) => wd.includes(r.weekday) && r.validFrom > c.validFrom)) {
        return d.fail(reply, 409, 'SCHEDULE_CONFLICT', 'С более поздней даты уже запланирован другой график'), null;
      }
      nextRows = [...rows.filter((r) => !wd.includes(r.weekday)), ...c.days.map((x) => ({ weekday: x.weekday, open: x.open, close: x.close, closed: x.open === null, validFrom: c.validFrom, validTo: null }))];
      dates = db.bookings.filter((b) => b.date >= c.validFrom && wd.includes(weekdayOf(b.date))).map((b) => b.date);
    } else if (c.kind === 'exception') {
      if (!DATE.test(String(c.date)) || !c.reason?.trim() || !['closed', 'short_day', 'special_hours', 'holiday', 'technical'].includes(c.exceptionKind) || !c.scope) {
        return issues(reply, [{ path: 'date', message: 'Нужны дата, вид, объект и причина' }]), null;
      }
      if (c.date < today) return invalid(reply, 'Прошлое не меняется', { field: 'date', value: c.date, today }), null;
      if (CLOSING.has(c.exceptionKind)) {
        if (c.open !== undefined || c.close !== undefined) return d.fail(reply, 422, 'INVALID_HOURS', 'У закрытия нет часов работы', { exceptionKind: c.exceptionKind }), null;
      } else if (badHours(c.open, c.close, true)) return hoursError(), null;
      if (c.scope.type !== 'branch') {
        const id = c.scope.id;
        const ok = c.scope.type === 'room' ? db.rooms.some((r) => r.id === id && r.branchId === branchId) : db.resources.some((r) => r.id === id && r.branchId === branchId);
        if (!ok) return notFound(reply), null;
      }
      const sameScope = (e: Exception) => e.scope.type === c.scope.type && (e.scope.type === 'branch' || ('id' in c.scope && 'id' in e.scope && e.scope.id === c.scope.id));
      const dup = db.exceptions.find((e) => e.status === 'active' && e.branchId === branchId && e.date === c.date && sameScope(e));
      if (dup) return d.fail(reply, 409, 'SCHEDULE_CONFLICT', 'На эту дату для объекта уже есть исключение', { exceptionId: dup.id }), null;
      nextEx = [...db.exceptions, { id: 'preview', branchId, scope: c.scope, date: c.date, kind: c.exceptionKind, open: c.open ?? null, close: c.close ?? null, reason: c.reason, status: 'active', createdBy: '', createdAt: '' }];
      dates = [c.date];
    } else {
      target = db.exceptions.find((e) => e.id === c.exceptionId && e.branchId === branchId && e.status === 'active');
      if (!target) return notFound(reply), null;
      if (!c.reason?.trim()) return issues(reply, [{ path: 'reason', message: 'Укажите причину' }]), null;
      if (target.date < today) return invalid(reply, 'Прошлое не меняется', { field: 'date' }), null;
      nextEx = db.exceptions.filter((e) => e.id !== target!.id);
      dates = [target.date];
    }
    // Затронута бронь, которая была внутри часов и после изменения выходит за них.
    const affected = db.bookings
      .filter((b) => b.branchId === branchId && dates.includes(b.date) && b.date >= today)
      .filter((b) => !outside(b, hoursOn(branchId, b.date, rows, db.exceptions, b.unitIds)) && outside(b, hoursOn(branchId, b.date, nextRows, nextEx, b.unitIds)))
      .map((b) => b.id).sort();
    return { affected, ...(target ? { target } : {}) };
  }

  const KIND_PATH: Record<Change['kind'], string> = { weekly: 'hours', exception: 'calendar-exceptions', cancel_exception: 'calendar-exceptions/:exceptionId/cancel' };
  for (const kind of ['weekly', 'exception', 'cancel_exception'] as const) {
    const path = `${P}/branches/:branchId/${KIND_PATH[kind]}`;
    const changeOf = (req: FastifyRequest) => ({ ...((req.body ?? {}) as Rec), kind, ...(kind === 'cancel_exception' ? { exceptionId: (req.params as Rec).exceptionId } : {}) }) as Change;
    app.post(`${path}/preview`, async (req, reply) => {
      const { branchId } = req.params as { branchId: string };
      if (!guard(req, reply, branchId, 'network.view', 'network.hours.manage')) return reply;
      const p = prepare(reply, branchId, changeOf(req));
      return p ? { affectedBookingIds: p.affected } : reply;
    });
    app.post(path, async (req, reply) => {
      const { branchId } = req.params as { branchId: string };
      const s = guard(req, reply, branchId, 'network.view', 'network.hours.manage');
      if (!s) return reply;
      const confirmed = ((req.body ?? {}) as Rec).confirmedAffected;
      if (!Array.isArray(confirmed)) return invalid(reply, 'Нужен список подтверждённых затронутых записей', { field: 'confirmedAffected' });
      const c = changeOf(req);
      const p = prepare(reply, branchId, c);
      if (!p) return reply;
      if (JSON.stringify(sortIds(confirmed as string[])) !== JSON.stringify(p.affected)) {
        return d.fail(reply, 409, 'AFFECTED_CHANGED', 'Список затронутых записей изменился – проверьте заново', { affectedBookingIds: p.affected });
      }
      if (c.kind === 'weekly') {
        const before = (db.hours[branchId] ?? []).filter((r) => !r.validTo);
        for (const day of c.days) {
          const list = db.hours[branchId] ?? (db.hours[branchId] = []);
          const cur = list.find((r) => r.weekday === day.weekday && !r.validTo);
          const row = { weekday: day.weekday, open: day.open, close: day.close, closed: day.open === null, validFrom: c.validFrom, validTo: null };
          if (cur && cur.validFrom === c.validFrom) Object.assign(cur, row);
          else {
            if (cur) cur.validTo = addDays(c.validFrom, -1);
            list.push(row);
          }
        }
        d.audit(s, 'branch', branchId, 'branch.hours_changed', { weeklyHours: before }, { validFrom: c.validFrom, days: c.days, affectedBookingIds: p.affected });
        return { kind: 'weekly', branchId, validFrom: c.validFrom, days: c.days, affectedBookingIds: p.affected };
      }
      if (c.kind === 'exception') {
        const ex: Exception = {
          id: randomUUID(), branchId, scope: c.scope, date: c.date, kind: c.exceptionKind, open: c.open ?? null, close: c.close ?? null,
          reason: c.reason.trim(), status: 'active', createdBy: s.id, createdAt: new Date().toISOString(),
        };
        db.exceptions.push(ex);
        d.audit(s, 'calendar_exception', ex.id, 'calendar.exception_created', {}, { ...ex, affectedBookingIds: p.affected });
        return reply.code(201).send({ kind: 'exception', exception: ex, affectedBookingIds: p.affected });
      }
      p.target!.status = 'cancelled';
      d.audit(s, 'calendar_exception', p.target!.id, 'calendar.exception_cancelled', { status: 'active' }, { status: 'cancelled', affectedBookingIds: p.affected }, c.reason);
      return { kind: 'cancel_exception', exception: p.target, affectedBookingIds: p.affected };
    });
  }

  app.get(`${P}/branches/:branchId/hours`, async (req, reply) => {
    const { branchId } = req.params as { branchId: string };
    if (!guard(req, reply, branchId, 'network.view')) return reply;
    const today = localToday();
    const items = (db.hours[branchId] ?? []).filter((r) => !r.validTo || r.validTo >= today).sort((a, b) => a.validFrom.localeCompare(b.validFrom) || a.weekday - b.weekday);
    return { timezone: d.branches().find((b) => b.id === branchId)!.timezone, items };
  });

  app.get(`${P}/branches/:branchId/calendar-exceptions`, async (req, reply) => {
    const { branchId } = req.params as { branchId: string };
    const q = req.query as { from?: string; to?: string };
    if (!DATE.test(q.from ?? '') || !DATE.test(q.to ?? '') || q.to! < q.from! || addDays(q.from!, 366) < q.to!) {
      return invalid(reply, 'Период from..to, не больше года', { field: 'from,to' });
    }
    if (!guard(req, reply, branchId, 'network.view')) return reply;
    const items = db.exceptions.filter((e) => e.branchId === branchId && e.date >= q.from! && e.date <= q.to!).sort((a, b) => a.date.localeCompare(b.date) || a.scope.type.localeCompare(b.scope.type));
    return { items };
  });

  // ---- тарифы (pricing/tariff.ts)

  const overlaps = (t: Tariff, o: Tariff) =>
    o.status === 'active' && o.id !== t.id && o.branchId === t.branchId && o.resourceType === t.resourceType && o.priority === t.priority &&
    t.durationFromMin < (o.durationToMin ?? Infinity) && o.durationFromMin < (t.durationToMin ?? Infinity) &&
    Date.parse(t.validFrom) < (o.validTo ? Date.parse(o.validTo) : Infinity) && Date.parse(o.validFrom) < (t.validTo ? Date.parse(t.validTo) : Infinity);
  const priorityConflict = (reply: FastifyReply, id: string) =>
    d.fail(reply, 409, 'TARIFF_PRIORITY_CONFLICT', 'Уже есть тариф того же приоритета на эти длительности и даты', { tariffId: id });

  app.get(`${P}/branches/:branchId/tariffs`, async (req, reply) => {
    const { branchId } = req.params as { branchId: string };
    if (!guard(req, reply, branchId, 'schedule.view')) return reply;
    const q = req.query as { resourceType?: string; status?: string };
    const items = db.tariffs
      .filter((t) => t.branchId === branchId && (!q.resourceType || t.resourceType === q.resourceType) && (!q.status || t.status === q.status))
      .sort((a, b) => a.resourceType.localeCompare(b.resourceType) || b.priority - a.priority || a.validFrom.localeCompare(b.validFrom) || a.id.localeCompare(b.id));
    return { items };
  });

  app.post(`${P}/branches/:branchId/tariffs`, async (req, reply) => {
    const { branchId } = req.params as { branchId: string };
    const s = guard(req, reply, branchId, 'network.view', 'tariff.manage');
    if (!s) return reply;
    const b = (req.body ?? {}) as Rec;
    const bad: Array<{ path: string; message: string }> = [];
    const int = (k: string, min: number) => Number.isInteger(b[k]) && (b[k] as number) >= min;
    if (typeof b.resourceType !== 'string' || !b.resourceType) bad.push({ path: 'resourceType', message: 'Выберите тип ресурса' });
    if (typeof b.name !== 'string' || !b.name.trim()) bad.push({ path: 'name', message: 'Заполните поле' });
    if (!int('unitMinutes', 1)) bad.push({ path: 'unitMinutes', message: 'Целое число минут от 1' });
    if (!int('pricePerUnitKop', 0)) bad.push({ path: 'pricePerUnitKop', message: 'Цена – целое число копеек' });
    if (b.durationFromMin !== undefined && !int('durationFromMin', 0)) bad.push({ path: 'durationFromMin', message: 'Целое число минут' });
    if (b.durationToMin != null && !int('durationToMin', 0)) bad.push({ path: 'durationToMin', message: 'Целое число минут' });
    if (typeof b.validFrom !== 'string' || Number.isNaN(Date.parse(b.validFrom))) bad.push({ path: 'validFrom', message: 'Укажите начало действия' });
    if (b.validTo != null && (typeof b.validTo !== 'string' || Number.isNaN(Date.parse(b.validTo)))) bad.push({ path: 'validTo', message: 'Неверная дата' });
    if (b.priority !== undefined && !Number.isInteger(b.priority)) bad.push({ path: 'priority', message: 'Целое число' });
    if (b.status !== undefined && b.status !== 'draft' && b.status !== 'active') bad.push({ path: 'status', message: 'Черновик или действующий' });
    const from = (b.durationFromMin as number | undefined) ?? 0;
    const to = (b.durationToMin as number | null | undefined) ?? null;
    if (!bad.length && to !== null && to <= from) bad.push({ path: 'durationToMin', message: 'Верх длительности больше низа' });
    if (!bad.length && b.validTo != null && Date.parse(b.validTo as string) <= Date.parse(b.validFrom as string)) bad.push({ path: 'validTo', message: 'Конец действия позже начала' });
    if (bad.length) return issues(reply, bad);
    if (!d.resourceTypes().some((t) => t.code === b.resourceType)) return invalid(reply, 'Неизвестный тип ресурса', { field: 'resourceType' });
    const t: Tariff = {
      id: randomUUID(), branchId, resourceType: b.resourceType as string, name: (b.name as string).trim(), unitMinutes: b.unitMinutes as number,
      pricePerUnitKop: b.pricePerUnitKop as number, durationFromMin: from, durationToMin: to, validFrom: new Date(b.validFrom as string).toISOString(),
      validTo: b.validTo ? new Date(b.validTo as string).toISOString() : null, priority: (b.priority as number | undefined) ?? 0,
      status: (b.status as 'draft' | 'active' | undefined) ?? 'active', createdBy: s.id, createdAt: new Date().toISOString(), archivedAt: null,
    };
    const clash = t.status === 'active' && db.tariffs.find((o) => overlaps(t, o));
    if (clash) return priorityConflict(reply, clash.id);
    db.tariffs.push(t);
    d.audit(s, 'tariff', t.id, 'tariff.created', {}, t);
    return reply.code(201).send(t);
  });

  const lockTariff = (req: FastifyRequest, reply: FastifyReply): { s: Staffish; t: Tariff } | null => {
    const t = db.tariffs.find((x) => x.id === (req.params as { tariffId: string }).tariffId);
    if (!t) return notFound(reply), null;
    const s = guard(req, reply, t.branchId, 'network.view', 'tariff.manage');
    if (!s) return null;
    if (t.status === 'archived') return d.fail(reply, 409, 'TARIFF_ARCHIVED', 'Тариф в архиве'), null;
    return { s, t };
  };

  app.patch(`${P}/tariffs/:tariffId`, async (req, reply) => {
    const l = lockTariff(req, reply);
    if (!l) return reply;
    const b = (req.body ?? {}) as Rec;
    const extra = Object.keys(b).filter((k) => !['name', 'validTo', 'status'].includes(k));
    if (extra.length || Object.keys(b).length === 0 || (b.status !== undefined && b.status !== 'active') || (b.name !== undefined && (typeof b.name !== 'string' || !b.name.trim()))) {
      return issues(reply, [{ path: extra[0] ?? 'name', message: extra.length ? 'Цена и условия тарифа не меняются – создайте новый тариф' : 'Нечего менять' }]);
    }
    const validTo = b.validTo === undefined ? l.t.validTo : b.validTo === null ? null : new Date(b.validTo as string).toISOString();
    if (b.validTo != null && (Date.parse(validTo!) <= Date.parse(l.t.validFrom) || Date.parse(validTo!) < Date.now())) {
      return invalid(reply, 'Конец действия – позже начала и не в прошлом', { field: 'validTo' });
    }
    const next: Tariff = { ...l.t, name: (b.name as string | undefined)?.trim() ?? l.t.name, validTo, status: (b.status as 'active' | undefined) ?? l.t.status };
    const clash = next.status === 'active' && db.tariffs.find((o) => overlaps(next, o));
    if (clash) return priorityConflict(reply, clash.id);
    const before = { ...l.t };
    Object.assign(l.t, next);
    d.audit(l.s, 'tariff', l.t.id, 'tariff.updated', before, l.t);
    return l.t;
  });

  app.post(`${P}/tariffs/:tariffId/archive`, async (req, reply) => {
    const l = lockTariff(req, reply);
    if (!l) return reply;
    const before = l.t.status;
    Object.assign(l.t, { status: 'archived', archivedAt: new Date().toISOString() });
    d.audit(l.s, 'tariff', l.t.id, 'tariff.archived', { status: before }, { status: 'archived' });
    return l.t;
  });
}

/** Хронология объектов этого мока (room/resource/tariff/resource_block/calendar_exception): филиал объекта в зоне. */
export function opsObjectBranch(objectType: string, objectId: string): string | null | undefined {
  const find = (list: Array<{ id: string; branchId: string }>) => list.find((x) => x.id === objectId)?.branchId ?? null;
  if (objectType === 'room') return find(db.rooms);
  if (objectType === 'resource') return find(db.resources);
  if (objectType === 'tariff') return find(db.tariffs);
  if (objectType === 'resource_block') return find(db.blocks);
  if (objectType === 'calendar_exception') return find(db.exceptions);
  return undefined; // не объект этого мока
}

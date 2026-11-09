// Мок оборудования и ремонта CRM строго по apps/api/src/modules/equipment/routes.crm.ts, routes.repairs.ts и
// attachments/routes.crm.ts (K19 №331–350, §18). Правила – как у сервера: вне зоны 404, в зоне без права 403, команды под
// Idempotency-Key (повтор – тот же ответ), rowVersion – VERSION_CONFLICT. Паролей у учёток нет: лишнее поле – 400 (strictObject).
// Блокировка и расход идут в моки ops и кассы (app.inject с кукой сотрудника): блокировка видна календарю, бронь не трогается
// (TC-12), расход виден журналу кассы, связь – одна на операцию. Подключается из mock-api.ts.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { opsState } from './mock-ops.ts';

type Rec = Record<string, unknown>;
interface Staffish { id: string; role: string }
export interface EquipmentMockDeps {
  current: (req: FastifyRequest) => Staffish;
  zone: (s: Staffish) => { network: boolean; branchIds: string[] };
  can: (s: Staffish, action: string) => boolean;
  branches: () => Array<{ id: string; timezone: string }>;
  reasonId: (domain: string, code: string) => string;
  audit: (s: Staffish, objectType: string, objectId: string, action: string, before: object, after: object, reason?: string | null) => void;
}

/** Реестр K19 §12: дополняет ACTIONS мока. */
const OD = ['equipment.view', 'equipment.view.accounts', 'equipment.manage', 'equipment.move', 'repair.register', 'repair.attach', 'repair.manage', 'repair.accept', 'repair.close', 'repair.expense.create', 'repair.executor.manage'];
export const EQUIPMENT_ACTIONS = {
  owner: [...OD, 'equipment.financial.edit', 'equipment.write_off', 'equipment.category.manage', 'repair.approve'],
  director: OD,
  admin: ['equipment.view', 'repair.register', 'repair.attach', 'repair.accept'],
};

const STATUSES = ['in_service', 'reserve', 'diagnostics', 'repair', 'awaiting_parts', 'unavailable', 'written_off', 'lost'];
const NOT_PLACEABLE = ['reserve', 'written_off', 'lost'];
const PROPOSES = ['diagnostics', 'repair', 'awaiting_parts', 'unavailable'];
const REASON_REQUIRED = ['written_off', 'lost', 'unavailable'];
const THRESHOLD = 1_000_000;
const MAX_BYTES = 10_485_760;
const TRANSITIONS: Record<string, string[]> = {
  new: ['diagnostics', 'planned', 'in_repair', 'cancelled'], diagnostics: ['awaiting_approval', 'planned', 'in_repair', 'done_pending_check', 'cancelled'],
  awaiting_approval: ['cancelled'], planned: ['in_repair', 'awaiting_parts', 'cancelled'], in_repair: ['awaiting_parts', 'done_pending_check'],
  awaiting_parts: ['in_repair', 'cancelled'], done_pending_check: ['in_repair'], closed: [], cancelled: [],
};
const FOLLOW: Record<string, string> = { diagnostics: 'diagnostics', in_repair: 'repair', awaiting_parts: 'awaiting_parts' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DOC_TYPES = ['photo', 'receipt', 'check', 'invoice', 'act', 'warranty_card', 'waybill', 'service_report', 'other'];

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
const invalid = (field: string, message = 'Неверные данные запроса') => new Fail(400, 'VALIDATION_FAILED', message, { field });
const conflict = (current: number) => new Fail(409, 'VERSION_CONFLICT', 'Запись изменилась – обновите форму', { current });

interface Item {
  id: string; inventoryNumber: string; legacyNumber: string | null; name: string; categoryId: string; manufacturer: string | null; model: string | null; serialNumber: string | null;
  parentId: string | null; purchaseDate: string | null; purchaseCostKop: number | null; commissionedOn: string | null; status: string; statusReason: string | null;
  placement: { branchId: string; roomId: string | null; unitId: string | null; since: string }; lastRepairAt: string | null; comment: string | null; rowVersion: number;
}
interface Placement { id: string; itemId: string; branchId: string; roomId: string | null; unitId: string | null; placedAt: string; removedAt: string | null; movedBy: string; reason: string }
interface Account { id: string; platform: string; displayName: string; equipmentId: string | null; branchId: string; status: 'active' | 'ended'; boundFrom: string; boundTo: string | null; endReason: string | null; accessHint: string | null; comment: string | null }
interface Warranty { id: string; kind: string; equipmentId: string; repairId: string | null; startsOn: string; endsOn: string; terms: string | null; issuer: string | null; attachmentId: string | null; comment: string | null; status: 'active' | 'invalid' }
interface Executor { id: string; kind: string; name: string; staffId: string | null; contactPerson: string | null; phone: string | null; email: string | null; address: string | null; inn: string | null; comment: string | null; status: 'active' | 'archived'; rowVersion: number }
interface Attachment { id: string; ownerType: string; ownerId: string; docType: string; sha256: string; sizeBytes: number; mimeType: string; originalName: string | null; comment: string | null; supersedes: string | null; status: 'active' | 'invalid'; invalidReason: string | null; invalidatedAt: string | null; createdById: string | null; createdAt: string; content: Buffer }
interface Repair {
  id: string; number: string; equipmentId: string; branchId: string; roomId: string | null; unitId: string | null; brokenAt: string | null; brokenAtUnknown: boolean; detectedAt: string; registeredAt: string;
  reportedBy: { staffId: string | null; name: string | null }; symptoms: string; priority: string; impact: string; status: string; diagnostics: string | null; cause: string | null; worksDone: string | null; partsUsed: string | null; conclusion: string | null;
  plan: { works: string | null; start: string | null; end: string | null; costKop: number | null; responsibleStaffId: string | null; partsNeeded: boolean; comment: string | null };
  executor: { id: string | null; snapshot: Rec | null }; approval: { required: boolean; approvedBy: string | null; approvedAt: string | null };
  actualCostKop: number | null; noCost: boolean; completedAt: string | null; finalEquipmentStatus: string | null; acceptedBy: string | null; previousRepairId: string | null; rowVersion: number;
  blockIds: string[]; liftedAt: Record<string, string>; movedToWork: boolean; timeline: Rec[];
}
interface Link { operationId: string; repairId: string; amountKop: number; occurredAt: string }

const uid = (prefix: string, n: number) => `${prefix}0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const K = 'b-nsk-krasny';
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
const EQUIP = { quest: uid('e', 1), ps5: uid('e', 2), pc: uid('e', 3), router: uid('e', 4), writtenOff: uid('e', 5), projector: uid('e', 6), tomsk: uid('e', 7) };
const REPAIR = { overdue: uid('a', 1), ps5: uid('a', 2), tomsk: uid('a', 3), old: uid('a', 4), check: uid('a', 5), otherOnQuest: uid('a', 6) };

const CATEGORIES = () => [
  { id: uid('d', 1), name: 'VR-шлемы', sortOrder: 10, status: 'active' }, { id: uid('d', 2), name: 'Консоли', sortOrder: 20, status: 'active' },
  { id: uid('d', 3), name: 'Компьютеры', sortOrder: 30, status: 'active' }, { id: uid('d', 4), name: 'Сетевое', sortOrder: 40, status: 'active' }, { id: uid('d', 5), name: 'Мониторы', sortOrder: 50, status: 'active' },
];
function item(id: string, n: number, name: string, categoryId: string, branchId: string, roomId: string | null, unitId: string | null, status: string, extra: Partial<Item> = {}): Item {
  return { id, inventoryNumber: `INV-${String(n).padStart(6, '0')}`, legacyNumber: null, name, categoryId, manufacturer: null, model: null, serialNumber: null, parentId: null, purchaseDate: null, purchaseCostKop: null, commissionedOn: null, status, statusReason: null, placement: { branchId, roomId, unitId, since: ago(24 * 60) }, lastRepairAt: null, comment: null, rowVersion: 1, ...extra };
}
const EXECUTOR_MASTER = uid('c', 1);
const master = (): Executor => ({ id: EXECUTOR_MASTER, kind: 'service_center', name: 'Сервис «Пиксель»', staffId: null, contactPerson: 'Игорь', phone: '+73830000000', email: null, address: null, inn: null, comment: null, status: 'active', rowVersion: 1 });
const snapshotOf = (e: Executor): Rec => ({ kind: e.kind, name: e.name, staffId: e.staffId, contactPerson: e.contactPerson, phone: e.phone, email: e.email, address: e.address, inn: e.inn });
function repair(id: string, n: number, equipmentId: string, branchId: string, roomId: string | null, unitId: string | null, status: string, extra: Partial<Repair> = {}): Repair {
  return {
    id, number: `R-${String(n).padStart(6, '0')}`, equipmentId, branchId, roomId, unitId, brokenAt: null, brokenAtUnknown: true, detectedAt: ago(48), registeredAt: ago(47), reportedBy: { staffId: 's-admin', name: null }, symptoms: 'Не включается', priority: 'medium', impact: 'partial', status,
    diagnostics: null, cause: null, worksDone: null, partsUsed: null, conclusion: null, plan: { works: null, start: null, end: null, costKop: null, responsibleStaffId: null, partsNeeded: false, comment: null }, executor: { id: null, snapshot: null },
    approval: { required: false, approvedBy: null, approvedAt: null }, actualCostKop: null, noCost: false, completedAt: null, finalEquipmentStatus: null, acceptedBy: null, previousRepairId: null, rowVersion: 1, blockIds: [], liftedAt: {}, movedToWork: false, timeline: [], ...extra,
  };
}
function seed() {
  const items: Item[] = [
    item(EQUIP.quest, 1, 'VR-шлем Quest 3', uid('d', 1), K, 'r-vr', 'u-vr1', 'in_service', { manufacturer: 'Meta', model: 'Quest 3', serialNumber: 'SN-VR-1', lastRepairAt: ago(24 * 30) }),
    item(EQUIP.ps5, 2, 'PlayStation 5', uid('d', 2), K, 'r-vr', 'u-ps4', 'diagnostics', { manufacturer: 'Sony', model: 'PS5', serialNumber: 'SN-PS-5' }),
    item(EQUIP.pc, 3, 'Компьютер ПК 1', uid('d', 3), K, 'r-hall', 'u-pc1', 'repair', { model: 'RTX 4070', serialNumber: 'SN-PC-1', purchaseCostKop: 12_000_000, lastRepairAt: ago(24 * 90) }),
    item(EQUIP.router, 4, 'Роутер VR-комнаты', uid('d', 4), K, 'r-vr', null, 'in_service', { model: 'AX3000' }),
    item(EQUIP.writtenOff, 5, 'Старый монитор', uid('d', 5), K, null, null, 'written_off', { statusReason: 'Разбита матрица', model: 'LG 24' }),
    item(EQUIP.projector, 6, 'Проектор в резерве', uid('d', 5), 'b-nsk-akadem', null, null, 'reserve'),
    item(EQUIP.tomsk, 7, 'Компьютер Томск', uid('d', 3), 'b-tsk-lenina', 'r-tsk-hall', 'u-tsk-pc1', 'in_service', { serialNumber: 'SN-TSK-1' }),
  ];
  const placements: Placement[] = items.map((i, n) => ({ id: uid('9', n + 1), itemId: i.id, branchId: i.placement.branchId, roomId: i.placement.roomId, unitId: i.placement.unitId, placedAt: i.placement.since, removedAt: null, movedBy: 's-owner', reason: 'Постановка на учёт' }));
  const accounts: Account[] = [
    { id: uid('8', 1), platform: 'meta', displayName: 'quest1@club.example', equipmentId: EQUIP.quest, branchId: K, status: 'active', boundFrom: day(-60), boundTo: null, endReason: null, accessHint: 'Сейф директора, журнал доступов', comment: null },
    { id: uid('8', 2), platform: 'playstation', displayName: 'yuclub_psn_old', equipmentId: EQUIP.quest, branchId: K, status: 'ended', boundFrom: day(-200), boundTo: day(-60), endReason: 'Замена учётки', accessHint: null, comment: null },
  ];
  const warranties: Warranty[] = [{ id: uid('7', 1), kind: 'manufacturer', equipmentId: EQUIP.quest, repairId: null, startsOn: day(-100), endsOn: day(200), terms: '12 месяцев', issuer: 'Продавец', attachmentId: null, comment: null, status: 'active' }];
  const repairs: Repair[] = [
    repair(REPAIR.overdue, 1, EQUIP.pc, K, 'r-hall', 'u-pc1', 'in_repair', { priority: 'high', cause: 'Перегрев видеокарты', plan: { works: 'Заменить кулер', start: day(-7), end: day(-3), costKop: 300_000, responsibleStaffId: null, partsNeeded: true, comment: null }, executor: { id: EXECUTOR_MASTER, snapshot: snapshotOf(master()) }, movedToWork: true }),
    repair(REPAIR.ps5, 2, EQUIP.ps5, K, 'r-vr', 'u-ps4', 'diagnostics', { impact: 'none', priority: 'low', symptoms: 'Шумит вентилятор' }),
    repair(REPAIR.tomsk, 3, EQUIP.tomsk, 'b-tsk-lenina', 'r-tsk-hall', 'u-tsk-pc1', 'new'),
    repair(REPAIR.old, 4, EQUIP.pc, K, 'r-hall', 'u-pc1', 'closed', { actualCostKop: 150_000, completedAt: ago(24 * 90), finalEquipmentStatus: 'in_service', worksDone: 'Чистка', executor: { id: EXECUTOR_MASTER, snapshot: snapshotOf(master()) }, movedToWork: true, detectedAt: ago(24 * 95) }),
    repair(REPAIR.check, 5, EQUIP.quest, K, 'r-vr', 'u-vr1', 'done_pending_check', { symptoms: 'Трещина линзы', priority: 'high', executor: { id: EXECUTOR_MASTER, snapshot: snapshotOf(master()) }, movedToWork: true, plan: { works: 'Заменить линзу', start: day(-5), end: day(1), costKop: 500_000, responsibleStaffId: null, partsNeeded: false, comment: null } }),
    repair(REPAIR.otherOnQuest, 6, EQUIP.quest, K, 'r-vr', 'u-vr1', 'awaiting_parts', { symptoms: 'Не держит заряд', movedToWork: true }),
  ];
  const eventStart = Date.now() + 5 * 86_400_000;
  return {
    items, placements, accounts, warranties, repairs, categories: CATEGORIES(), executors: [master()], attachments: [] as Attachment[], links: [] as Link[], nextInv: items.length + 1, nextRepair: repairs.length + 1,
    events: [{ eventId: uid('f', 1), unitIds: ['u-vr1'], number: 'M-000042', status: 'confirmed', start: new Date(eventStart).toISOString(), end: new Date(eventStart + 7_200_000).toISOString() }],
  };
}
let db = seed();
let replays = new Map<string, { status: number; body: unknown }>();
export function resetEquipment(): void {
  db = seed();
  replays = new Map();
}

export function registerEquipment(app: FastifyInstance, P: string, d: EquipmentMockDeps): void {
  const sees = (s: Staffish, branchId: string) => d.can(s, 'equipment.view') && d.zone(s).branchIds.includes(branchId);
  const guard = (s: Staffish, branchId: string, action: string) => {
    if (!sees(s, branchId)) throw notFound();
    if (!d.can(s, action)) throw forbidden(action);
  };
  const role = (s: Staffish, action: string) => {
    if (!d.can(s, action)) throw forbidden(action);
  };
  const send = (reply: FastifyReply, e: unknown) => {
    if (!(e instanceof Fail)) throw e;
    return reply.code(e.status).send({ error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}), requestId: randomUUID() } });
  };
  const strict = (body: Rec, keys: string[]) => {
    for (const k of Object.keys(body)) if (!keys.includes(k)) throw invalid(k);
  };
  const version = (body: Rec, current: number) => {
    if (!Number.isInteger(body.rowVersion) || (body.rowVersion as number) < 1) throw invalid('rowVersion');
    if (body.rowVersion !== current) throw conflict(current);
  };
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const getItem = (s: Staffish, id: string) => {
    const it = db.items.find((x) => x.id === id);
    if (!it || !sees(s, it.placement.branchId)) throw notFound();
    return it;
  };
  const getRepair = (s: Staffish, id: string) => {
    const r = db.repairs.find((x) => x.id === id);
    if (!r || !sees(s, r.branchId)) throw notFound();
    return r;
  };
  const isOpen = (r: Repair) => r.status !== 'closed' && r.status !== 'cancelled';
  const warrantyUntil = (id: string) => db.warranties.filter((w) => w.equipmentId === id && w.status === 'active' && w.endsOn >= day(0)).map((w) => w.endsOn).sort().at(-1) ?? null;
  const dto = (i: Item) => ({ ...i, openRepairsCount: db.repairs.filter((r) => r.equipmentId === i.id && isOpen(r)).length, warrantyUntil: warrantyUntil(i.id) });

  /** Команда: Idempotency-Key обязателен, повтор – сохранённый ответ (ADR 0004). */
  const command = (name: string, status: number, run: (s: Staffish, id: string, body: Rec, req: FastifyRequest, key: string) => unknown) => async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const s = d.current(req);
      const key = String(req.headers['idempotency-key'] ?? '');
      if (!key) throw new Fail(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Нужен заголовок Idempotency-Key');
      const scope = `${s.id}:${name}:${key}`;
      const saved = replays.get(scope);
      if (saved) return reply.header('idempotent-replay', 'true').code(saved.status).send(saved.body);
      const body = await run(s, (req.params as { id?: string }).id ?? '', (req.body ?? {}) as Rec, req, key);
      replays.set(scope, { status, body });
      return reply.code(status).send(body);
    } catch (e) {
      return send(reply, e);
    }
  };
  const read = (run: (s: Staffish, id: string, q: Record<string, string | undefined>, req: FastifyRequest) => unknown) => async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      return await run(d.current(req), (req.params as { id?: string }).id ?? '', req.query as Record<string, string | undefined>, req);
    } catch (e) {
      return send(reply, e);
    }
  };

  // ---- брони и мероприятия на единицах (booking providers)

  const unitsOf = (branchId: string, t: { type: string; ids: string[] }) => {
    const units = opsState().units.filter((u) => u.branchId === branchId);
    return t.type === 'unit' ? units.filter((u) => t.ids.includes(u.id)).map((u) => u.id) : units.filter((u) => u.roomId && t.ids.includes(u.roomId)).map((u) => u.id);
  };
  const placeUnits = (p: { branchId: string; roomId: string | null; unitId: string | null }) => (p.unitId ? [p.unitId] : p.roomId ? unitsOf(p.branchId, { type: 'room', ids: [p.roomId] }) : []);
  const msOf = (date: string, hm: string) => Date.parse(`${date}T${hm}:00+07:00`);
  const onUnits = (units: string[], from: number, to = Infinity) => ({
    bookingIds: opsState().bookings.filter((b) => b.unitIds.some((u) => units.includes(u)) && msOf(b.date, b.end) > from && msOf(b.date, b.start) < to).map((b) => b.id).sort(),
    events: db.events.filter((e) => e.unitIds.some((u) => units.includes(u)) && Date.parse(e.end) > from && Date.parse(e.start) < to),
  });
  const bookingRows = async (req: FastifyRequest, ids: string[]) => {
    const out: Rec[] = [];
    for (const id of ids) {
      const r = await app.inject({ method: 'GET', url: `${P}/bookings/${id}`, headers: { cookie: req.headers.cookie ?? '' } });
      if (r.statusCode !== 200) continue;
      const c = r.json() as Rec;
      out.push({ id: c.id, number: c.number, status: c.status, resourceName: c.resourceName, start: c.start, end: c.end, client: c.client, source: c.source, rowVersion: c.rowVersion, needsDecision: c.needsDecision });
    }
    return out;
  };
  const buildProposal = async (req: FastifyRequest, branchId: string, target: { type: string; ids: string[] }, period: { start: string; end: string }, exceptRepairId: string | null) => {
    const units = unitsOf(branchId, target);
    if (units.length === 0) throw new Fail(422, 'RESOURCE_LINK_INVALID', 'Цель блокировки не найдена в этом филиале', { field: 'target.ids' });
    const a = onUnits(units, Date.parse(period.start), Date.parse(period.end));
    return {
      target, period, reasonCode: 'repair', affectedBookings: await bookingRows(req, a.bookingIds),
      affectedEvents: a.events.map(({ eventId, number, status, start, end }) => ({ eventId, number, status, start, end })),
      otherOpenRepairs: db.repairs.filter((r) => r.id !== exceptRepairId && isOpen(r) && r.branchId === branchId && placeUnits(r).some((u) => units.includes(u))).map((r) => r.id),
    };
  };
  const criticalPeriod = () => ({ start: new Date().toISOString(), end: new Date(Date.now() + 24 * 3_600_000).toISOString() });
  const targetOf = (p: { roomId: string | null; unitId: string | null }) => (p.unitId ? { type: 'unit', ids: [p.unitId] } : p.roomId ? { type: 'room', ids: [p.roomId] } : null);

  // ---- №331–337 оборудование

  const cityBranches = (cityId: string) => (cityId === 'c-nsk' ? [K, 'b-nsk-akadem'] : cityId === 'c-tsk' ? ['b-tsk-lenina'] : []);
  app.get(`${P}/equipment`, read((s, _id, q) => {
    role(s, 'equipment.view');
    const limit = Number(q.limit ?? 50);
    let items = db.items.filter((i) => d.zone(s).branchIds.includes(i.placement.branchId));
    if (q.branchId) items = items.filter((i) => i.placement.branchId === q.branchId);
    if (q.categoryId) items = items.filter((i) => i.categoryId === q.categoryId);
    if (q.status) {
      if (!STATUSES.includes(q.status)) throw invalid('status');
      items = items.filter((i) => i.status === q.status);
    }
    if (q.roomId) items = items.filter((i) => i.placement.roomId === q.roomId);
    if (q.unitId) items = items.filter((i) => i.placement.unitId === q.unitId);
    if (q.serial) items = items.filter((i) => i.serialNumber === q.serial!.trim());
    if (q.warrantyExpiresBefore) items = items.filter((i) => db.warranties.some((w) => w.equipmentId === i.id && w.status === 'active' && w.endsOn >= day(0) && w.endsOn < q.warrantyExpiresBefore!));
    if (q.hasOpenRepair) items = items.filter((i) => db.repairs.some((r) => r.equipmentId === i.id && isOpen(r)) === (q.hasOpenRepair === 'true'));
    if (q.cityId) items = items.filter((i) => cityBranches(q.cityId!).includes(i.placement.branchId));
    items = items.sort((a, b) => a.inventoryNumber.localeCompare(b.inventoryNumber));
    if (q.cursor) items = items.filter((i) => i.inventoryNumber > q.cursor!);
    const page = items.slice(0, limit);
    return { items: page.map(dto), nextCursor: items.length > limit ? page.at(-1)!.inventoryNumber : null };
  }));
  const duplicates = (i: { serialNumber: string | null; categoryId: string; model: string | null; id: string }) => (i.serialNumber ? db.items.filter((x) => x.id !== i.id && x.serialNumber === i.serialNumber && x.categoryId === i.categoryId && x.model === i.model).map((x) => x.id) : []);
  const FIELDS = ['name', 'categoryId', 'manufacturer', 'model', 'serialNumber', 'legacyNumber', 'parentId', 'purchaseDate', 'purchaseCostKop', 'commissionedOn', 'comment'];

  app.post(`${P}/equipment`, command('create', 201, (s, _id, b) => {
    if (typeof b.branchId === 'string') guard(s, b.branchId, 'equipment.manage');
    strict(b, [...FIELDS, 'branchId', 'roomId', 'unitId', 'status']);
    if (!text(b.name)) throw invalid('name');
    if (!db.categories.some((c) => c.id === b.categoryId && c.status === 'active')) throw invalid('categoryId', 'Неизвестная категория');
    const it = item(randomUUID(), db.nextInv++, text(b.name)!, String(b.categoryId), String(b.branchId), (b.roomId as string) ?? null, (b.unitId as string) ?? null, (b.status as string) ?? 'in_service', {
      manufacturer: text(b.manufacturer), model: text(b.model), serialNumber: text(b.serialNumber), legacyNumber: text(b.legacyNumber), purchaseDate: (b.purchaseDate as string) ?? null,
      purchaseCostKop: (b.purchaseCostKop as number) ?? null, commissionedOn: (b.commissionedOn as string) ?? null, comment: text(b.comment),
    });
    if (it.status === 'reserve' && (it.placement.roomId || it.placement.unitId)) throw new Fail(409, 'EQUIPMENT_NOT_PLACEABLE', 'Списанное, утерянное или резервное не ставится в единицу или комнату');
    it.placement.since = new Date().toISOString();
    const dup = duplicates(it);
    db.items.push(it);
    db.placements.push({ id: randomUUID(), itemId: it.id, branchId: it.placement.branchId, roomId: it.placement.roomId, unitId: it.placement.unitId, placedAt: it.placement.since, removedAt: null, movedBy: s.id, reason: 'Постановка на учёт' });
    d.audit(s, 'equipment', it.id, 'equipment.created', {}, { name: it.name });
    return { ...dto(it), ...(dup.length ? { details: { duplicateOf: dup } } : {}) };
  }));
  app.get(`${P}/equipment/:id`, read((s, id) => {
    const it = getItem(s, id);
    if (!d.can(s, 'equipment.view.accounts')) return dto(it);
    return { ...dto(it), accounts: db.accounts.filter((a) => a.equipmentId === id) };
  }));
  app.patch(`${P}/equipment/:id`, command('update', 200, (s, id, b) => {
    const it = db.items.find((x) => x.id === id);
    if (!it) throw notFound();
    guard(s, it.placement.branchId, 'equipment.manage');
    strict(b, ['rowVersion', ...FIELDS]);
    if (it.status === 'written_off') throw new Fail(409, 'EQUIPMENT_WRITTEN_OFF', 'Списанное оборудование не изменяется');
    version(b, it.rowVersion);
    if (['serialNumber', 'legacyNumber', 'purchaseCostKop'].some((k) => b[k] !== undefined && b[k] !== (it as unknown as Rec)[k])) role(s, 'equipment.financial.edit');
    for (const k of FIELDS) if (b[k] !== undefined) (it as unknown as Rec)[k] = b[k];
    it.rowVersion++;
    d.audit(s, 'equipment', id, 'equipment.updated', {}, b);
    const dup = duplicates(it);
    return { ...dto(it), ...(dup.length ? { details: { duplicateOf: dup } } : {}) };
  }));
  function movePlacement(it: Item, by: string, to: { branchId: string; roomId: string | null; unitId: string | null }, at: string, reason: string) {
    const cur = db.placements.find((p) => p.itemId === it.id && !p.removedAt);
    if (cur) cur.removedAt = at;
    db.placements.push({ id: randomUUID(), itemId: it.id, ...to, placedAt: at, removedAt: null, movedBy: by, reason });
    it.placement = { ...to, since: at };
  }
  app.post(`${P}/equipment/:id/status`, command('status', 200, async (s, id, b, req) => {
    const it = db.items.find((x) => x.id === id);
    if (!it) throw notFound();
    guard(s, it.placement.branchId, 'equipment.manage');
    strict(b, ['rowVersion', 'status', 'reason']);
    if (!STATUSES.includes(String(b.status))) throw invalid('status');
    if (it.status === 'written_off') throw new Fail(409, 'EQUIPMENT_WRITTEN_OFF', 'Списание – конечный статус');
    if (b.status === 'written_off' || it.status === 'lost') role(s, 'equipment.write_off');
    version(b, it.rowVersion);
    const reason = text(b.reason);
    if (!reason && (REASON_REQUIRED.includes(String(b.status)) || it.status === 'lost')) throw new Fail(422, 'COMMENT_REQUIRED', 'Укажите причину смены статуса', { field: 'reason' });
    if (b.status === it.status) return { equipment: dto(it), blockProposal: null };
    const before = it.status;
    it.status = String(b.status);
    it.statusReason = reason;
    it.rowVersion++;
    if (NOT_PLACEABLE.includes(it.status)) movePlacement(it, s.id, { branchId: it.placement.branchId, roomId: null, unitId: null }, new Date().toISOString(), reason ?? 'Смена статуса');
    d.audit(s, 'equipment', id, it.status === 'written_off' ? 'equipment.written_off' : 'equipment.status_changed', { status: before }, { status: it.status }, reason);
    const t = targetOf(it.placement);
    const blockProposal = PROPOSES.includes(it.status) && t ? await buildProposal(req, it.placement.branchId, t, criticalPeriod(), null) : null;
    return { equipment: dto(it), blockProposal };
  }));
  app.post(`${P}/equipment/:id/move`, command('move', 200, async (s, id, b, req) => {
    const it = db.items.find((x) => x.id === id);
    if (!it) throw notFound();
    guard(s, it.placement.branchId, 'equipment.move');
    strict(b, ['rowVersion', 'to', 'at', 'reason', 'acknowledgeBookings']);
    const to = (b.to ?? {}) as { branchId?: string; roomId?: string | null; unitId?: string | null };
    if (typeof to.branchId !== 'string') throw invalid('to');
    if (!text(b.reason)) throw invalid('reason');
    if (typeof b.at !== 'string' || !ISO.test(b.at)) throw invalid('at');
    guard(s, to.branchId, 'equipment.move');
    const place = { branchId: to.branchId, roomId: to.roomId ?? null, unitId: to.unitId ?? null };
    if (place.unitId && !opsState().units.some((u) => u.id === place.unitId && u.branchId === place.branchId)) throw new Fail(422, 'RESOURCE_LINK_INVALID', 'Единица не из этого филиала');
    if ((place.roomId || place.unitId) && NOT_PLACEABLE.includes(it.status)) throw new Fail(409, 'EQUIPMENT_NOT_PLACEABLE', 'Списанное, утерянное или резервное не ставится в единицу или комнату', { status: it.status });
    if (it.status === 'written_off') throw new Fail(409, 'EQUIPMENT_WRITTEN_OFF', 'Списанное оборудование не перемещается');
    version(b, it.rowVersion);
    if (Date.parse(b.at) > Date.now() + 60_000) throw invalid('at', 'Перемещение – фактический момент, не будущий');
    if (Date.parse(b.at) < Date.parse(it.placement.since)) throw invalid('at', 'Момент перемещения раньше постановки на прежнее место');
    if (it.placement.branchId === place.branchId && it.placement.roomId === place.roomId && it.placement.unitId === place.unitId) throw invalid('to', 'Оборудование уже на этом месте');
    const targetUnits = placeUnits(place);
    const left = placeUnits(it.placement).filter((u) => !targetUnits.includes(u));
    const a = onUnits(left, Date.now());
    const eventIds = a.events.map((e) => e.eventId);
    const has = a.bookingIds.length + eventIds.length > 0;
    if (has && b.acknowledgeBookings !== true) throw new Fail(409, 'EQUIPMENT_MOVE_HAS_BOOKINGS', 'На прежнем месте есть будущие брони или мероприятия', { bookingIds: a.bookingIds, holdIds: [], eventIds });
    const freed = targetOf(it.placement);
    const fromBranch = it.placement.branchId;
    movePlacement(it, s.id, place, b.at, text(b.reason)!);
    it.rowVersion++;
    if (fromBranch !== place.branchId) for (const acc of db.accounts) if (acc.equipmentId === it.id && acc.status === 'active') acc.branchId = place.branchId;
    d.audit(s, 'equipment', id, 'equipment.moved', { branchId: fromBranch }, { ...place, affectedBookingIds: a.bookingIds, eventIds }, text(b.reason));
    const blockProposal = has && freed ? await buildProposal(req, fromBranch, freed, criticalPeriod(), null) : null;
    return { equipment: dto(it), affectedBookingIds: a.bookingIds, blockProposal };
  }));
  app.get(`${P}/equipment/:id/placements`, read((s, id) => {
    getItem(s, id);
    return { items: db.placements.filter((p) => p.itemId === id).map(({ itemId: _i, ...p }) => (void _i, p)).sort((a, b) => b.placedAt.localeCompare(a.placedAt)) };
  }));

  // №336 учётки: только идентификатор и подсказка; поля пароля в схеме нет – strictObject отвергает
  app.get(`${P}/equipment-accounts`, read((s, _id, q) => {
    role(s, 'equipment.view.accounts');
    return { items: db.accounts.filter((a) => d.zone(s).branchIds.includes(a.branchId) && (!q.equipmentId || a.equipmentId === q.equipmentId) && (!q.branchId || a.branchId === q.branchId)) };
  }));
  app.post(`${P}/equipment-accounts`, command('account.bind', 201, (s, _id, b) => {
    if (typeof b.branchId === 'string') guard(s, b.branchId, 'equipment.manage');
    strict(b, ['platform', 'displayName', 'equipmentId', 'branchId', 'boundFrom', 'accessHint', 'comment']);
    if (!['playstation', 'meta', 'other'].includes(String(b.platform)) || !text(b.displayName)) throw invalid('displayName');
    if (typeof b.boundFrom !== 'string' || !DATE.test(b.boundFrom)) throw invalid('boundFrom');
    const a: Account = { id: randomUUID(), platform: String(b.platform), displayName: text(b.displayName)!, equipmentId: (b.equipmentId as string) ?? null, branchId: String(b.branchId), status: 'active', boundFrom: b.boundFrom, boundTo: null, endReason: null, accessHint: text(b.accessHint), comment: text(b.comment) };
    db.accounts.push(a);
    return a;
  }));
  app.post(`${P}/equipment-accounts/:id/rebind`, command('account.rebind', 200, (s, id, b) => {
    const a = db.accounts.find((x) => x.id === id);
    if (!a) throw notFound();
    guard(s, a.branchId, 'equipment.manage');
    strict(b, ['equipmentId', 'at', 'reason']);
    if (!text(b.reason)) throw invalid('reason');
    if (typeof b.at !== 'string' || !DATE.test(b.at)) throw invalid('at');
    Object.assign(a, { status: 'ended', boundTo: b.at, endReason: text(b.reason) });
    const current: Account | null = b.equipmentId ? { ...a, id: randomUUID(), equipmentId: b.equipmentId as string, status: 'active', boundFrom: b.at, boundTo: null, endReason: null } : null;
    if (current) db.accounts.push(current);
    return { ended: a, current };
  }));
  app.get(`${P}/equipment-categories`, read((s) => {
    role(s, 'equipment.view');
    return { items: db.categories };
  }));
  app.post(`${P}/equipment-categories`, command('category.create', 201, (s, _id, b) => {
    role(s, 'equipment.category.manage');
    const name = text(b.name);
    if (!name) throw invalid('name');
    if (db.categories.some((c) => c.name === name)) throw invalid('name', 'Категория с таким названием уже есть');
    const c = { ...db.categories[0]!, id: randomUUID(), name, sortOrder: (b.sortOrder as number | undefined) ?? 0, status: 'active' };
    db.categories.push(c);
    return c;
  }));
  app.patch(`${P}/equipment-categories/:id`, command('category.update', 200, (s, id, b) => {
    role(s, 'equipment.category.manage');
    const c = db.categories.find((x) => x.id === id);
    if (!c) throw notFound();
    const name = text(b.name);
    if (name && db.categories.some((x) => x.name === name && x.id !== id)) throw invalid('name', 'Категория с таким названием уже есть');
    Object.assign(c, name ? { name } : {}, b.sortOrder !== undefined ? { sortOrder: b.sortOrder } : {}, b.status !== undefined ? { status: b.status } : {});
    return c;
  }));

  // №348 гарантии
  app.get(`${P}/equipment/:id/warranties`, read((s, id) => {
    getItem(s, id);
    return { items: db.warranties.filter((w) => w.equipmentId === id).sort((a, b) => b.endsOn.localeCompare(a.endsOn)) };
  }));
  app.post(`${P}/equipment/:id/warranties`, command('warranty', 201, (s, id, b) => {
    const it = db.items.find((x) => x.id === id);
    if (!it) throw notFound();
    guard(s, it.placement.branchId, 'repair.manage');
    strict(b, ['kind', 'repairId', 'startsOn', 'endsOn', 'terms', 'issuer', 'attachmentId', 'comment']);
    if (!['manufacturer', 'repair'].includes(String(b.kind))) throw invalid('kind');
    if ((b.kind === 'repair') !== Boolean(b.repairId)) throw invalid('repairId', 'Ремонт указывается только у гарантии на работы');
    if (typeof b.startsOn !== 'string' || typeof b.endsOn !== 'string' || !DATE.test(b.startsOn) || !DATE.test(b.endsOn)) throw invalid('endsOn');
    if (b.endsOn < b.startsOn) throw invalid('endsOn', 'Конец гарантии раньше начала');
    const w: Warranty = { id: randomUUID(), kind: String(b.kind), equipmentId: id, repairId: (b.repairId as string) ?? null, startsOn: b.startsOn, endsOn: b.endsOn, terms: text(b.terms), issuer: text(b.issuer), attachmentId: (b.attachmentId as string) ?? null, comment: text(b.comment), status: 'active' };
    db.warranties.push(w);
    return w;
  }));
  app.post(`${P}/warranties/:id/invalidate`, command('warranty.invalidate', 200, (s, id, b) => {
    const w = db.warranties.find((x) => x.id === id);
    const it = w && db.items.find((x) => x.id === w.equipmentId);
    if (!w || !it) throw notFound();
    guard(s, it.placement.branchId, 'repair.manage');
    if (!text(b.reason)) throw invalid('reason');
    w.status = 'invalid';
    return w;
  }));

  // ---- №341–347 ремонт

  const blocksOf = (r: Repair) => r.blockIds.map((id) => {
    const b = opsState().blocks.find((x) => x.id === id)!;
    return { blockId: id, active: b.status === 'active', period: { start: b.start, end: b.end }, liftedAt: r.liftedAt[id] ?? null, rowVersion: b.rowVersion };
  });
  const paymentOf = (r: Repair) => {
    const links = db.links.filter((l) => l.repairId === r.id);
    const paidKop = links.reduce((sum, l) => sum + l.amountKop, 0);
    const target = r.actualCostKop ?? r.plan.costKop;
    const status = r.noCost ? 'no_cost' : paidKop === 0 ? 'unpaid' : target === null || paidKop === target ? 'paid' : paidKop < target ? 'partially_paid' : 'overpaid';
    return { paidKop, status, lastPaidAt: links.map((l) => l.occurredAt).sort().at(-1) ?? null, operationIds: links.map((l) => l.operationId) };
  };
  const repairDto = (r: Repair) => {
    const { blockIds: _b, liftedAt: _l, movedToWork: _m, timeline: _t, ...rest } = r;
    void _b; void _l; void _m; void _t;
    return { ...rest, blocks: blocksOf(r), payment: paymentOf(r) };
  };
  const event = (s: Staffish, r: Repair, action: string, before: Rec, after: Rec, reason: string | null = null) =>
    r.timeline.unshift({ id: randomUUID(), at: new Date().toISOString(), objectType: 'repair', objectId: r.id, action, actorType: 'staff', actorId: s.id, before, after, reason, result: 'success' });
  const today = (branchId: string) => new Intl.DateTimeFormat('en-CA', { timeZone: d.branches().find((b) => b.id === branchId)?.timezone ?? 'Asia/Novosibirsk' }).format(new Date());

  app.get(`${P}/repairs`, read((s, _id, q) => {
    role(s, 'equipment.view');
    let rows = db.repairs.filter((r) => d.zone(s).branchIds.includes(r.branchId));
    if (q.branchId) rows = rows.filter((r) => r.branchId === q.branchId);
    if (q.equipmentId) rows = rows.filter((r) => r.equipmentId === q.equipmentId);
    if (q.status) rows = rows.filter((r) => r.status === q.status);
    if (q.executorId) rows = rows.filter((r) => r.executor.id === q.executorId);
    if (q.priority) rows = rows.filter((r) => r.priority === q.priority);
    for (const [k, v] of [['from', q.from], ['to', q.to]] as const) if (v && !ISO.test(v)) throw invalid(k);
    if (q.from) rows = rows.filter((r) => Date.parse(r.detectedAt) >= Date.parse(q.from!));
    if (q.to) rows = rows.filter((r) => Date.parse(r.detectedAt) < Date.parse(q.to!));
    if (q.planOverdue) rows = rows.filter((r) => (isOpen(r) && !!r.plan.end && r.plan.end < today(r.branchId)) === (q.planOverdue === 'true'));
    rows = rows.sort((a, b) => b.number.localeCompare(a.number));
    if (q.cursor) rows = rows.filter((r) => r.number < q.cursor!);
    const limit = Number(q.limit ?? 50);
    const page = rows.slice(0, limit);
    return { items: page.map(repairDto), nextCursor: rows.length > limit ? page.at(-1)!.number : null };
  }));
  app.post(`${P}/repairs`, command('register', 201, async (s, _id, b, req) => {
    const it = db.items.find((x) => x.id === b.equipmentId);
    if (!it) throw notFound();
    guard(s, it.placement.branchId, 'repair.register');
    strict(b, ['equipmentId', 'detectedAt', 'brokenAt', 'brokenAtUnknown', 'symptoms', 'priority', 'impact', 'reportedByName', 'previousRepairId']);
    if (typeof b.detectedAt !== 'string' || !ISO.test(b.detectedAt)) throw invalid('detectedAt');
    if (!text(b.symptoms)) throw invalid('symptoms');
    if (!['critical', 'high', 'medium', 'low'].includes(String(b.priority))) throw invalid('priority');
    if (!['none', 'partial', 'full'].includes(String(b.impact))) throw invalid('impact');
    if (it.status === 'written_off') throw new Fail(409, 'EQUIPMENT_WRITTEN_OFF', 'Списанное оборудование не ремонтируется');
    const broken = typeof b.brokenAt === 'string' ? b.brokenAt : null;
    const dates = (m: string) => new Fail(422, 'REPAIR_DATES_INVALID', m);
    if (!broken && b.brokenAtUnknown !== true) throw dates('Укажите дату поломки или отметьте, что она неизвестна');
    if (broken && b.brokenAtUnknown === true) throw dates('Дата поломки указана, а отметка «неизвестна» стоит');
    if (broken && Date.parse(broken) > Date.parse(b.detectedAt)) throw dates('Поломка не может быть позже обнаружения');
    if (Date.parse(b.detectedAt) > Date.now()) throw dates('Обнаружение не может быть позже регистрации');
    const r = repair(randomUUID(), db.nextRepair++, it.id, it.placement.branchId, it.placement.roomId, it.placement.unitId, 'new', {
      brokenAt: broken && new Date(broken).toISOString(), brokenAtUnknown: b.brokenAtUnknown === true, detectedAt: new Date(b.detectedAt).toISOString(), registeredAt: new Date().toISOString(),
      reportedBy: { staffId: s.id, name: text(b.reportedByName) }, symptoms: text(b.symptoms)!, priority: String(b.priority), impact: String(b.impact), previousRepairId: (b.previousRepairId as string) ?? null,
    });
    db.repairs.push(r);
    event(s, r, 'repair.registered', {}, { number: r.number });
    const t = targetOf(r);
    const blockProposal = r.impact === 'none' || !t ? null : await buildProposal(req, r.branchId, t, { start: r.detectedAt, end: criticalPeriod().end }, r.id);
    const history = db.repairs.filter((x) => x.equipmentId === it.id && x.id !== r.id).map((x) => ({ id: x.id, number: x.number, status: x.status, detectedAt: x.detectedAt, conclusion: x.conclusion }));
    return { repair: repairDto(r), blockProposal, autoBlock: null, details: { history, warranties: db.warranties.filter((w) => w.equipmentId === it.id && w.status === 'active') } };
  }));
  app.get(`${P}/repairs/:id`, read((s, id) => {
    const r = getRepair(s, id);
    const minutes = blocksOf(r).reduce((sum, b) => sum + Math.max(0, Math.round((Math.min(Date.parse(b.period.end), b.liftedAt ? Date.parse(b.liftedAt) : Date.now()) - Date.parse(b.period.start)) / 60_000)), 0);
    return { ...repairDto(r), downtime: { minutes, hasBlocks: r.blockIds.length > 0 }, timeline: r.timeline };
  }));
  app.patch(`${P}/repairs/:id`, command('update', 200, (s, id, b) => {
    const r = db.repairs.find((x) => x.id === id);
    if (!r) throw notFound();
    guard(s, r.branchId, 'repair.manage');
    strict(b, ['rowVersion', 'diagnostics', 'cause', 'worksDone', 'partsUsed', 'conclusion', 'plan', 'executorId', 'priority']);
    if (!isOpen(r)) throw new Fail(409, 'REPAIR_TRANSITION_INVALID', 'Закрытый или отменённый ремонт не меняется', { status: r.status });
    version(b, r.rowVersion);
    for (const k of ['diagnostics', 'cause', 'worksDone', 'partsUsed', 'conclusion'] as const) if (b[k] !== undefined) r[k] = b[k] as string | null;
    if (b.priority) r.priority = String(b.priority);
    if (b.plan) {
      const p = b.plan as Partial<Repair['plan']>;
      strict(p as Rec, ['works', 'start', 'end', 'costKop', 'responsibleStaffId', 'partsNeeded', 'comment']);
      const next = { ...r.plan, ...p };
      if (next.start && next.end && next.end < next.start) throw invalid('plan.end', 'Конец плана раньше начала');
      if (JSON.stringify(next) !== JSON.stringify(r.plan) && (next.costKop ?? 0) > THRESHOLD && r.approval.approvedAt) r.approval = { required: true, approvedBy: null, approvedAt: null };
      r.plan = next;
      r.approval.required = (r.plan.costKop ?? 0) > THRESHOLD;
    }
    if (b.executorId !== undefined) {
      if (b.executorId === null) r.executor = { id: null, snapshot: null };
      else {
        const e = db.executors.find((x) => x.id === b.executorId && x.status === 'active');
        if (!e) throw invalid('executorId', 'Исполнитель не найден или в архиве');
        r.executor = { id: e.id, snapshot: snapshotOf(e) };
      }
    }
    r.rowVersion++;
    event(s, r, 'repair.updated', {}, { fields: Object.keys(b).filter((k) => k !== 'rowVersion') });
    return repairDto(r);
  }));
  const follow = (s: Staffish, r: Repair, to: string) => {
    const it = db.items.find((x) => x.id === r.equipmentId);
    const status = FOLLOW[to];
    if (it && status && it.status !== status && it.status !== 'written_off' && it.status !== 'lost') {
      d.audit(s, 'equipment', it.id, 'equipment.status_changed', { status: it.status }, { status }, `Ремонт ${r.number}`);
      Object.assign(it, { status, statusReason: `Ремонт ${r.number}`, rowVersion: it.rowVersion + 1 });
    }
  };
  app.post(`${P}/repairs/:id/status`, command('status', 200, (s, id, b) => {
    const r = db.repairs.find((x) => x.id === id);
    if (!r) throw notFound();
    guard(s, r.branchId, 'repair.manage');
    strict(b, ['rowVersion', 'to', 'comment']);
    version(b, r.rowVersion);
    const comment = text(b.comment);
    if (!comment) throw new Fail(422, 'COMMENT_REQUIRED', 'Смена статуса ремонта – с комментарием', { field: 'comment' });
    const to = String(b.to);
    if (!TRANSITIONS[r.status]?.includes(to)) throw new Fail(409, 'REPAIR_TRANSITION_INVALID', 'Такой переход статуса ремонта невозможен', { from: r.status, to });
    if ((to === 'planned' || to === 'in_repair' || (to === 'done_pending_check' && r.status === 'in_repair')) && (r.plan.costKop ?? 0) > THRESHOLD && !r.approval.approvedAt) {
      throw new Fail(409, 'REPAIR_APPROVAL_REQUIRED', 'План выше порога – нужно согласование', { planCostKop: r.plan.costKop, thresholdKop: THRESHOLD });
    }
    event(s, r, 'repair.status_changed', { status: r.status }, { status: to }, comment);
    r.status = to;
    if (to === 'in_repair') r.movedToWork = true;
    r.rowVersion++;
    follow(s, r, to);
    return repairDto(r);
  }));
  app.post(`${P}/repairs/:id/approve`, command('approve', 200, (s, id, b) => {
    const r = db.repairs.find((x) => x.id === id);
    if (!r || !sees(s, r.branchId)) throw notFound();
    role(s, 'repair.approve');
    strict(b, ['rowVersion', 'decision', 'comment']);
    version(b, r.rowVersion);
    const comment = text(b.comment);
    if (!comment) throw new Fail(422, 'COMMENT_REQUIRED', 'Решение по согласованию – с комментарием', { field: 'comment' });
    const inPlace = r.approval.required && !r.approval.approvedAt && ['planned', 'in_repair', 'awaiting_parts'].includes(r.status);
    if (r.status !== 'awaiting_approval' && !inPlace) throw new Fail(409, 'REPAIR_TRANSITION_INVALID', 'Такой переход статуса ремонта невозможен', { from: r.status });
    if (b.decision === 'approve') r.approval = { ...r.approval, approvedBy: s.id, approvedAt: new Date().toISOString() };
    if (!inPlace) r.status = b.decision === 'approve' ? 'planned' : 'diagnostics';
    r.rowVersion++;
    event(s, r, 'repair.approved', {}, { decision: b.decision }, comment);
    return repairDto(r);
  }));
  app.get(`${P}/repairs/:id/block-proposal`, read(async (s, id, q, req) => {
    const r = getRepair(s, id);
    const target = q.targetType && q.targetId ? { type: q.targetType, ids: [q.targetId] } : targetOf(r);
    if (!target) return { target: null, period: null, reasonCode: 'repair', affectedBookings: [], affectedEvents: [], otherOpenRepairs: [] };
    const start = r.blockIds.length ? new Date().toISOString() : r.detectedAt;
    const planned = r.plan.end ? new Date(Date.parse(`${r.plan.end}T00:00:00+07:00`) + 86_400_000).toISOString() : criticalPeriod().end;
    const end = Date.parse(planned) > Date.parse(start) ? planned : criticalPeriod().end;
    return buildProposal(req, r.branchId, target, q.start && q.end ? { start: q.start, end: q.end } : { start, end }, r.id);
  }));
  app.post(`${P}/repairs/:id/blocks`, command('block', 201, async (s, id, b, req) => {
    const r = db.repairs.find((x) => x.id === id);
    if (!r) throw notFound();
    guard(s, r.branchId, 'block.manage');
    strict(b, ['target', 'period', 'comment', 'blockId']);
    const period = b.period as { start: string; end: string } | undefined;
    if (!b.target || !period) throw invalid('target');
    const res = await app.inject({
      method: 'POST', url: `${P}/branches/${r.branchId}/blocks`, headers: { cookie: req.headers.cookie ?? '', 'content-type': 'application/json' },
      payload: JSON.stringify({ target: b.target, start: period.start, end: period.end, reasonId: d.reasonId('resource_block', 'repair'), ...(b.comment ? { comment: b.comment } : {}) }),
    });
    const out = res.json() as { block?: { id: string }; affectedBookingIds?: string[]; error?: { code: string; message: string; details?: Rec } };
    if (res.statusCode !== 201) throw new Fail(res.statusCode, out.error?.code ?? 'INTERNAL', out.error?.message ?? 'Ошибка', out.error?.details);
    r.blockIds.push(out.block!.id);
    r.rowVersion++;
    event(s, r, 'repair.block_linked', {}, { blockId: out.block!.id });
    const units = unitsOf(r.branchId, b.target as { type: string; ids: string[] });
    return { blockId: out.block!.id, affectedBookings: await bookingRows(req, out.affectedBookingIds ?? []), affectedEventIds: onUnits(units, Date.parse(period.start), Date.parse(period.end)).events.map((e) => e.eventId), affectedHoldIds: [] };
  }));
  app.post(`${P}/repairs/:id/close`, command('close', 200, (s, id, b) => {
    const r = db.repairs.find((x) => x.id === id);
    if (!r || !sees(s, r.branchId)) throw notFound();
    const canClose = d.can(s, 'repair.close');
    if (!canClose && !d.can(s, 'repair.accept')) throw forbidden('repair.close');
    strict(b, ['rowVersion', 'worksDone', 'completedAt', 'finalEquipmentStatus', 'actualCostKop', 'noCost', 'costComment', 'executorId', 'warranty', 'liftBlockIds']);
    if (r.status !== 'done_pending_check') throw new Fail(409, 'REPAIR_TRANSITION_INVALID', 'Закрыть можно только ремонт на проверке', { from: r.status, to: 'closed' });
    version(b, r.rowVersion);
    const executorId = b.executorId === undefined ? r.executor.id : (b.executorId as string | null);
    const missing: string[] = [];
    if (!text(b.worksDone)) missing.push('worksDone');
    if (!b.completedAt) missing.push('completedAt');
    if (!b.finalEquipmentStatus) missing.push('finalEquipmentStatus');
    const noCost = b.noCost === true;
    if (noCost === (b.actualCostKop !== undefined)) missing.push('actualCostKop', 'noCost');
    if (noCost && !text(b.costComment)) missing.push('costComment');
    if (b.actualCostKop === 0) missing.push('noCost');
    if (!executorId && r.movedToWork) missing.push('executorId');
    if (missing.length) throw new Fail(422, 'REPAIR_CLOSE_INCOMPLETE', 'Для закрытия ремонта не хватает данных', { fields: missing });
    const at = Date.parse(String(b.completedAt));
    if (at < Date.parse(r.detectedAt) || at > Date.now() + 60_000) throw new Fail(422, 'REPAIR_DATES_INVALID', 'Дата завершения – между обнаружением и сейчас');
    if (!canClose && Math.max(Number(b.actualCostKop ?? 0), r.plan.costKop ?? 0) > THRESHOLD) throw forbidden('repair.close');
    const final = String(b.finalEquipmentStatus);
    if (final === 'written_off' || final === 'lost') role(s, 'equipment.write_off');
    if (noCost && paymentOf(r).paidKop > 0) throw new Fail(422, 'REPAIR_CLOSE_INCOMPLETE', 'По ремонту уже есть расход – укажите сумму', { fields: ['noCost'], operationIds: paymentOf(r).operationIds });
    const selected = new Set((b.liftBlockIds as string[] | undefined) ?? []);
    const still: Array<{ blockId: string; reason: string }> = [];
    for (const bid of r.blockIds) {
      const block = opsState().blocks.find((x) => x.id === bid)!;
      if (block.status !== 'active') continue;
      if (!selected.has(bid)) {
        still.push({ blockId: bid, reason: 'not_selected' });
        continue;
      }
      if (db.repairs.some((o) => o.id !== r.id && isOpen(o) && o.branchId === r.branchId && placeUnits(o).some((u) => block.unitIds.includes(u)))) {
        still.push({ blockId: bid, reason: 'other_open_repair' });
        continue;
      }
      block.status = 'lifted';
      block.rowVersion++;
      r.liftedAt[bid] = new Date().toISOString();
    }
    if (executorId && executorId !== r.executor.id) {
      const e = db.executors.find((x) => x.id === executorId);
      if (e) r.executor = { id: e.id, snapshot: snapshotOf(e) };
    }
    Object.assign(r, { status: 'closed', worksDone: text(b.worksDone), completedAt: new Date(at).toISOString(), finalEquipmentStatus: final, actualCostKop: noCost ? null : b.actualCostKop, noCost, acceptedBy: s.id, rowVersion: r.rowVersion + 1 });
    const it = db.items.find((x) => x.id === r.equipmentId);
    if (it) Object.assign(it, { status: final, statusReason: `Ремонт ${r.number}`, lastRepairAt: r.completedAt, rowVersion: it.rowVersion + 1 });
    if (b.warranty) {
      const w = b.warranty as Rec;
      db.warranties.push({ id: randomUUID(), kind: 'repair', equipmentId: r.equipmentId, repairId: r.id, startsOn: String(w.startsOn), endsOn: String(w.endsOn), terms: text(w.terms), issuer: text(w.issuer), attachmentId: null, comment: null, status: 'active' });
    }
    event(s, r, 'repair.closed', {}, { finalEquipmentStatus: final, stillBlocked: still });
    return { repair: repairDto(r), stillBlocked: still };
  }));
  app.post(`${P}/repairs/:id/expense`, command('expense', 201, async (s, id, b, req, key) => {
    const r = db.repairs.find((x) => x.id === id);
    if (!r) throw notFound();
    guard(s, r.branchId, 'repair.expense.create');
    if (r.status === 'cancelled') throw new Fail(409, 'REPAIR_TRANSITION_INVALID', 'Отменённый ремонт расходов не имеет', { status: r.status });
    if (r.noCost) throw new Fail(409, 'REPAIR_TRANSITION_INVALID', 'Ремонт закрыт без затрат', { status: r.status });
    strict(b, ['branchId', 'method', 'amountKop', 'subcategoryId', 'occurredAt', 'comment']);
    if (!d.can(s, 'finance.expense.create') || !d.zone(s).branchIds.includes(String(b.branchId))) throw forbidden('finance.expense.create');
    const cats = await app.inject({ method: 'GET', url: `${P}/finance/categories?kind=expense`, headers: { cookie: req.headers.cookie ?? '' } });
    const tree = cats.json() as { items: Array<{ id: string; name: string; parentId?: string | null; children?: Array<{ id: string; name: string }> }> };
    const top = tree.items.find((c) => c.name === 'Ремонт и обслуживание');
    if (!top) throw invalid('subcategoryId', 'Нет категории «Ремонт и обслуживание» – выберите подкатегорию');
    const sub = top.children?.find((c) => c.name === 'Оборудование') ?? tree.items.find((c) => c.parentId === top.id && c.name === 'Оборудование') ?? null;
    const res = await app.inject({
      method: 'POST', url: `${P}/branches/${String(b.branchId)}/finance/expense`, headers: { cookie: req.headers.cookie ?? '', 'content-type': 'application/json', 'idempotency-key': key },
      payload: JSON.stringify({ method: b.method, amountKop: b.amountKop, categoryId: top.id, subcategoryId: sub?.id ?? null, occurredAt: b.occurredAt, comment: text(b.comment) ?? `Ремонт ${r.number}` }),
    });
    const op = res.json() as Rec & { id: string; error?: { code: string; message: string; details?: Rec } };
    if (res.statusCode >= 300) throw new Fail(res.statusCode, op.error?.code ?? 'INTERNAL', op.error?.message ?? 'Ошибка', op.error?.details);
    db.links.push({ operationId: op.id, repairId: r.id, amountKop: Number(b.amountKop), occurredAt: String(b.occurredAt) });
    event(s, r, 'repair.expense_linked', {}, { operationId: op.id, amountKop: b.amountKop, created: true });
    return op;
  }));
  app.post(`${P}/repairs/:id/expense/link`, command('expense.link', 200, async (s, id, b, req) => {
    const r = db.repairs.find((x) => x.id === id);
    if (!r) throw notFound();
    guard(s, r.branchId, 'repair.expense.create');
    strict(b, ['operationId']);
    if (typeof b.operationId !== 'string' || !UUID.test(b.operationId)) throw invalid('operationId');
    const same = db.links.find((l) => l.operationId === b.operationId);
    if (same && same.repairId !== r.id) throw new Fail(409, 'OPERATION_ALREADY_LINKED', 'Операция уже связана с другим объектом');
    if (!same) {
      const ops = await app.inject({ method: 'GET', url: `${P}/branches/${r.branchId}/finance/operations?kind=expense&limit=200`, headers: { cookie: req.headers.cookie ?? '' } });
      const op = (ops.json() as { items?: Array<{ id: string; amountKop: number; occurredAt: string }> }).items?.find((o) => o.id === b.operationId);
      if (!op) throw notFound();
      db.links.push({ operationId: op.id, repairId: r.id, amountKop: Math.abs(op.amountKop), occurredAt: op.occurredAt });
      event(s, r, 'repair.expense_linked', {}, { operationId: op.id, created: false });
    }
    return repairDto(r);
  }));

  // №349 исполнители
  app.get(`${P}/repair-executors`, read((s, _id, q) => {
    role(s, 'equipment.view');
    return { items: db.executors.filter((e) => q.includeArchived === 'true' || e.status === 'active') };
  }));
  app.post(`${P}/repair-executors`, command('executor.create', 201, (s, _id, b) => {
    role(s, 'repair.executor.manage');
    strict(b, ['kind', 'name', 'contactPerson', 'phone', 'email', 'address', 'inn', 'comment', 'staffId']);
    if (!['staff', 'contractor', 'service_center', 'manufacturer'].includes(String(b.kind)) || !text(b.name)) throw invalid('name');
    const e: Executor = { id: randomUUID(), kind: String(b.kind), name: text(b.name)!, staffId: (b.staffId as string) ?? null, contactPerson: text(b.contactPerson), phone: text(b.phone), email: text(b.email), address: text(b.address), inn: text(b.inn), comment: text(b.comment), status: 'active', rowVersion: 1 };
    db.executors.push(e);
    return e;
  }));
  app.patch(`${P}/repair-executors/:id`, command('executor.update', 200, (s, id, b) => {
    role(s, 'repair.executor.manage');
    const e = db.executors.find((x) => x.id === id);
    if (!e) throw notFound();
    for (const f of ['kind', 'name', 'contactPerson', 'phone', 'email', 'comment', 'status'] as const) if (b[f] !== undefined) (e as unknown as Rec)[f] = b[f];
    return e;
  }));

  // ---- №350 вложения: тело – файл; лимит и тип – по сигнатуре, как core/files.ts

  app.addContentTypeParser(['application/octet-stream', 'image/jpeg', 'image/png', 'application/pdf'], { parseAs: 'buffer', bodyLimit: 52_428_801 }, (_req, body, done) => done(null, body));
  const owner = (s: Staffish, ownerType: string, ownerId: string, action: string) => {
    if (ownerType !== 'equipment' && ownerType !== 'repair') throw invalid('ownerType', 'Неизвестный тип объекта вложения');
    if (!UUID.test(ownerId)) throw notFound();
    const branchId = ownerType === 'equipment' ? db.items.find((x) => x.id === ownerId)?.placement.branchId : db.repairs.find((x) => x.id === ownerId)?.branchId;
    if (!branchId || !sees(s, branchId)) throw notFound();
    if (!d.can(s, action)) throw forbidden(action);
  };
  const sniff = (b: Buffer) => (b[0] === 0xff && b[1] === 0xd8 ? 'image/jpeg' : b[0] === 0x89 && b[1] === 0x50 ? 'image/png' : b.subarray(0, 4).toString() === '%PDF' ? 'application/pdf' : null);
  const attachmentDto = ({ content: _c, ...a }: Attachment) => (void _c, a);

  app.post(`${P}/attachments`, command('attachment.add', 201, (s, _id, _b, req) => {
    const q = req.query as Record<string, string | undefined>;
    if (!DOC_TYPES.includes(q.docType ?? '')) throw invalid('docType');
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) throw new Fail(400, 'VALIDATION_FAILED', 'Пустой файл');
    owner(s, q.ownerType ?? '', q.ownerId ?? '', 'repair.attach');
    if (q.supersedes) {
      const prev = db.attachments.find((a) => a.id === q.supersedes);
      if (!prev || prev.ownerType !== q.ownerType || prev.ownerId !== q.ownerId) throw notFound();
      if (db.attachments.some((a) => a.supersedes === q.supersedes)) throw new Fail(409, 'VERSION_CONFLICT', 'У этого вложения уже есть новая версия', { supersedes: q.supersedes });
    }
    if (body.length > MAX_BYTES) throw new Fail(413, 'ATTACHMENT_TOO_LARGE', 'Файл больше допустимого размера', { maxBytes: MAX_BYTES });
    const mime = sniff(body);
    if (!mime) throw new Fail(415, 'ATTACHMENT_TYPE_NOT_ALLOWED', 'Разрешены только JPG, PNG и PDF');
    const a: Attachment = { id: randomUUID(), ownerType: q.ownerType!, ownerId: q.ownerId!, docType: q.docType!, sha256: createHash('sha256').update(body).digest('hex'), sizeBytes: body.length, mimeType: mime, originalName: q.name ?? null, comment: q.comment ?? null, supersedes: q.supersedes ?? null, status: 'active', invalidReason: null, invalidatedAt: null, createdById: s.id, createdAt: new Date().toISOString(), content: body };
    db.attachments.push(a);
    return { attachmentId: a.id, attachment: attachmentDto(a) };
  }));
  app.get(`${P}/attachments`, read((s, _id, q) => {
    owner(s, q.ownerType ?? '', q.ownerId ?? '', 'equipment.view');
    return { items: db.attachments.filter((a) => a.ownerType === q.ownerType && a.ownerId === q.ownerId).sort((x, y) => y.createdAt.localeCompare(x.createdAt)).map(attachmentDto) };
  }));
  app.get(`${P}/attachments/:id`, async (req, reply) => {
    try {
      const s = d.current(req);
      const a = db.attachments.find((x) => x.id === (req.params as { id: string }).id);
      if (!a) throw notFound();
      owner(s, a.ownerType, a.ownerId, 'equipment.view');
      return await reply.header('content-type', a.mimeType).header('content-disposition', `attachment; filename="file"; filename*=UTF-8''${encodeURIComponent(a.originalName ?? a.id)}`)
        .header('x-content-type-options', 'nosniff').header('cache-control', 'private, no-store').header('content-security-policy', "default-src 'none'; sandbox").send(a.content);
    } catch (e) {
      return send(reply, e);
    }
  });
  app.post(`${P}/attachments/:id/invalidate`, command('attachment.invalidate', 200, (s, id, b) => {
    const a = db.attachments.find((x) => x.id === id);
    if (!a) throw notFound();
    owner(s, a.ownerType, a.ownerId, 'repair.attach');
    const reason = text(b.reason);
    if (!reason) throw new Fail(422, 'COMMENT_REQUIRED', 'Укажите причину', { field: 'reason' });
    if (a.status === 'active') Object.assign(a, { status: 'invalid', invalidReason: reason, invalidatedAt: new Date().toISOString() });
    return attachmentDto(a);
  }));
}

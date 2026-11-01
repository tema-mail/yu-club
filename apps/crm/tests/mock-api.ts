// Мок API CRM для разработки и Playwright – пока нет бэкенда (S0-09…S0-11).
// Повторяет контракты: K12 (вход, сессия, пароль), K11 №1 GET /me, K11 №18 сеть (список и карточка филиала),
// K1 (роли и зоны: объект вне зоны – 404 с телом, как у несуществующего), ADR 0002 (тело ошибки).
// S0-15: города и филиалы (создание, правка с rowVersion, архив), хронология аудита (K2), справочники –
// точно по apps/api/src/modules/dictionaries/routes.ts. S1-25: поиск и карточка клиента – по clients/routes.crm.ts.
// Запуск: MOCK_PORT=4010 node tests/mock-api.ts; CRM: API_URL=http://127.0.0.1:4010.
// Учётки (пароль у всех один – MOCK_PASSWORD): owner@yu.test, director@yu.test, admin@yu.test.
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { randomBytes, randomUUID } from 'node:crypto';

type Role = 'owner' | 'director' | 'admin';

export const MOCK_PASSWORD = 'yu-club-test-pass';

// Состояние мока изменяемое (S0-15: создание, правка, архив); POST /__test/reset возвращает исходное.
interface MockCity { id: string; slug: string; name: string; region: string | null; timezone: string; status: 'active' | 'archived'; rowVersion: number }
interface Hours { weekday: number; open: string | null; close: string | null }
interface MockBranch {
  id: string; cityId: string; cityName: string; citySlug: string; slug: string; name: string; address: string; timezone: string;
  status: 'preparing' | 'active' | 'temporarily_closed' | 'archived'; rowVersion: number; weeklyHours: Hours[];
}

const week = (open: string | null, close: string | null): Hours[] =>
  [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, open, close }));

function seedCities(): MockCity[] {
  return [
    { id: 'c-nsk', slug: 'nsk', name: 'Новосибирск', region: 'Новосибирская область', timezone: 'Asia/Novosibirsk', status: 'active', rowVersion: 1 },
    { id: 'c-tsk', slug: 'tomsk', name: 'Томск', region: 'Томская область', timezone: 'Asia/Tomsk', status: 'active', rowVersion: 1 },
  ];
}

function seedBranches(cs: MockCity[]): MockBranch[] {
  return [
    { id: 'b-nsk-krasny', cityId: 'c-nsk', slug: 'krasny', name: 'Ю Клуб на Красном', address: 'Красный проспект, 25', timezone: 'Asia/Novosibirsk', status: 'active' as const },
    { id: 'b-nsk-akadem', cityId: 'c-nsk', slug: 'akadem', name: 'Ю Клуб Академгородок', address: 'Морской проспект, 2', timezone: 'Asia/Novosibirsk', status: 'temporarily_closed' as const },
    { id: 'b-tsk-lenina', cityId: 'c-tsk', slug: 'lenina', name: 'Ю Клуб на Ленина', address: 'проспект Ленина, 80', timezone: 'Asia/Tomsk', status: 'active' as const },
  ].map((b) => {
    const c = cs.find((x) => x.id === b.cityId)!;
    return { ...b, cityName: c.name, citySlug: c.slug, rowVersion: 1, weeklyHours: week('10:00', '22:00') };
  });
}

let cities = seedCities();
let branches = seedBranches(cities);

// Действия ролей по реестру K1 (Э1).
const ACTIONS: Record<Role, string[]> = {
  owner: [
    'network.view', 'network.city.manage', 'network.branch.create', 'network.branch.archive', 'network.branch.update',
    'network.hours.manage', 'staff.view', 'staff.director.assign', 'staff.admin.assign', 'staff.block',
    'resources.view', 'resources.manage', 'schedule.view', 'booking.create', 'booking.cancel', 'booking.reschedule',
    'booking.visit.mark', 'booking.visit.correct', 'block.manage', 'client.view.basic', 'client.view.full',
    'client.update.limited', 'client.update', 'client.merge', 'client.export', 'export.pd', 'tariff.manage',
    'settings.network.manage', 'settings.branch.manage', 'dictionary.manage', 'audit.view', 'audit.view.own',
    'audit.export', 'notifications.view',
  ],
  director: [
    'network.view', 'network.branch.update', 'network.hours.manage', 'staff.view', 'staff.admin.assign', 'staff.block',
    'resources.view', 'resources.manage', 'schedule.view', 'booking.create', 'booking.cancel', 'booking.reschedule',
    'booking.visit.mark', 'booking.visit.correct', 'block.manage', 'client.view.basic', 'client.view.full',
    'client.update.limited', 'client.update', 'settings.branch.manage', 'audit.view', 'audit.view.own', 'notifications.view',
  ],
  admin: [
    'network.view', 'resources.view', 'schedule.view', 'booking.create', 'booking.cancel', 'booking.reschedule',
    'booking.visit.mark', 'block.manage', 'client.view.basic', 'client.update.limited', 'audit.view.own', 'notifications.view',
  ],
};

interface MockStaff {
  id: string; email: string; password: string; firstName: string; lastName: string; role: Role;
  cityIds: string[]; branchIds: string[]; mustChangePassword?: boolean;
}

const staff: MockStaff[] = [
  { id: 's-owner', email: 'owner@yu.test', password: MOCK_PASSWORD, firstName: 'Ольга', lastName: 'Владимирова', role: 'owner', cityIds: [], branchIds: [] },
  { id: 's-director', email: 'director@yu.test', password: MOCK_PASSWORD, firstName: 'Денис', lastName: 'Директоров', role: 'director', cityIds: ['c-nsk'], branchIds: [] },
  { id: 's-admin', email: 'admin@yu.test', password: MOCK_PASSWORD, firstName: 'Анна', lastName: 'Админова', role: 'admin', cityIds: [], branchIds: ['b-nsk-krasny'] },
  // После засева/сброса: сервер пускает только в session, password, logout (K12).
  { id: 's-fresh', email: 'fresh@yu.test', password: MOCK_PASSWORD, firstName: 'Фёдор', lastName: 'Новиков', role: 'admin', cityIds: [], branchIds: ['b-nsk-krasny'], mustChangePassword: true },
];

const sessions = new Map<string, string>(); // токен → staffId

function access(s: MockStaff) {
  const network = s.role === 'owner';
  const branchIds = network
    ? branches.map((b) => b.id)
    : [...new Set([...s.branchIds, ...branches.filter((b) => s.cityIds.includes(b.cityId)).map((b) => b.id)])];
  return { network, cityIds: network ? cities.map((c) => c.id) : s.cityIds, branchIds };
}

function publicStaff(s: MockStaff) {
  return { id: s.id, firstName: s.firstName, lastName: s.lastName, role: s.role };
}

function fail(reply: FastifyReply, status: number, code: string, message: string, details?: Record<string, unknown>) {
  return reply.code(status).send({ error: { code, message, ...(details ? { details } : {}), requestId: randomUUID() } });
}

function readCookie(req: FastifyRequest, name: string): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

function currentStaff(req: FastifyRequest): MockStaff | null {
  const token = readCookie(req, 'yu_staff');
  const id = token ? sessions.get(token) : undefined;
  return staff.find((s) => s.id === id) ?? null;
}

// ---- аудит (K2): только изменённые поля; хронология объекта – новые сверху

interface AuditEvent {
  id: string; at: string; objectType: string; objectId: string; action: string;
  actor: { id: string; name: string; role: Role } | null; before: Record<string, unknown>; after: Record<string, unknown>; reason: string | null;
}
let audit: AuditEvent[] = [];
// Засев аудита клиентов (seedClientAudit) – в buildMock и /__test/reset: данные клиентов объявлены ниже.

function diff(before: Record<string, unknown>, after: Record<string, unknown>) {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (k === 'rowVersion') continue;
    if (JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null)) {
      b[k] = before[k] ?? null;
      a[k] = after[k] ?? null;
    }
  }
  return { before: b, after: a };
}

function writeAudit(s: MockStaff, objectType: string, objectId: string, action: string, before: object, after: object, reason: string | null = null) {
  const d = diff(before as Record<string, unknown>, after as Record<string, unknown>);
  audit.push({
    id: randomUUID(), at: new Date().toISOString(), objectType, objectId, action,
    actor: { id: s.id, name: `${s.firstName} ${s.lastName}`, role: s.role }, ...d, reason,
  });
}

// ---- общее для маршрутов S0-15

const can = (s: MockStaff, action: string) => ACTIONS[s.role].includes(action);
const forbidden = (reply: FastifyReply) => fail(reply, 403, 'FORBIDDEN', 'Недостаточно прав');
const notFound = (reply: FastifyReply) => fail(reply, 404, 'NOT_FOUND', 'Не найдено');
type Issue = { path: string; message: string };
const invalid = (reply: FastifyReply, issues: Issue[]) =>
  fail(reply, 400, 'VALIDATION_FAILED', 'Неверные данные запроса', { issues });

function page<T>(all: T[], q: { cursor?: string; limit?: string }) {
  const size = Math.min(Number(q.limit ?? 50), Number(process.env.MOCK_PAGE_SIZE ?? 100));
  const from = q.cursor ? Number(q.cursor) : 0;
  return { items: all.slice(from, from + size), nextCursor: from + size < all.length ? String(from + size) : null };
}

const SLUG = /^[a-z0-9-]+$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function textIssues(body: Record<string, unknown>, fields: string[], partial: boolean): Issue[] {
  const issues: Issue[] = [];
  for (const f of fields) {
    const v = body[f];
    if (v === undefined && partial) continue;
    if (typeof v !== 'string' || v.trim() === '') issues.push({ path: f, message: 'Заполните поле' });
    else if (f === 'slug' && !SLUG.test(v)) issues.push({ path: f, message: 'Только латиница в нижнем регистре, цифры и дефис' });
  }
  return issues;
}

function hoursIssues(v: unknown): Issue[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length !== 7) return [{ path: 'weeklyHours', message: 'Нужны все 7 дней недели' }];
  const issues: Issue[] = [];
  for (const d of v as Hours[]) {
    if (d.open === null && d.close === null) continue;
    if (!TIME.test(String(d.open)) || !TIME.test(String(d.close)) || String(d.close) <= String(d.open)) {
      issues.push({ path: `weeklyHours.${d.weekday}`, message: 'Закрытие позже открытия, в пределах суток' });
    }
  }
  return issues;
}

function staleVersion(reply: FastifyReply, body: Record<string, unknown>, current: { rowVersion: number }) {
  if (body.rowVersion === current.rowVersion) return null;
  return fail(reply, 409, 'VERSION_CONFLICT', 'Запись уже изменили. Обновите страницу', { current });
}

function zoneCityIds(s: MockStaff): string[] {
  const a = access(s);
  return a.network ? cities.map((c) => c.id) : [...new Set([...a.cityIds, ...branches.filter((b) => a.branchIds.includes(b.id)).map((b) => b.cityId)])];
}

const pick = (body: Record<string, unknown>, keys: string[]) =>
  Object.fromEntries(keys.filter((k) => body[k] !== undefined).map((k) => [k, typeof body[k] === 'string' ? (body[k] as string).trim() : body[k]]));

// ---- сеть: города и филиалы (K11 №18 «CRUD по K13»; настоящие маршруты пишет бэкенд S0-11)

function registerNetwork(app: FastifyInstance, P: string) {
  app.get(`${P}/cities`, async (req, reply) => {
    const s = currentStaff(req)!;
    if (!can(s, 'network.view')) return forbidden(reply);
    const q = req.query as { q?: string; archived?: string; cursor?: string; limit?: string };
    const zone = new Set(zoneCityIds(s));
    const needle = (q.q ?? '').trim().toLowerCase();
    const all = cities.filter(
      (c) => zone.has(c.id) && (q.archived === 'true') === (c.status === 'archived') && (!needle || c.name.toLowerCase().includes(needle)),
    );
    return page(all.map((c) => ({ ...c, branchCount: branches.filter((b) => b.cityId === c.id && b.status !== 'archived').length })), q);
  });

  app.get(`${P}/cities/:cityId`, async (req, reply) => {
    const { cityId } = req.params as { cityId: string };
    const c = cities.find((x) => x.id === cityId);
    if (!c || !zoneCityIds(currentStaff(req)!).includes(c.id)) return notFound(reply);
    return c;
  });

  app.post(`${P}/cities`, async (req, reply) => {
    const s = currentStaff(req)!;
    if (!can(s, 'network.city.manage')) return forbidden(reply);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const issues = textIssues(body, ['name', 'slug', 'timezone'], false);
    if (issues.length) return invalid(reply, issues);
    if (cities.some((c) => c.slug === body.slug)) return fail(reply, 409, 'SLUG_TAKEN', 'Такой адрес (slug) уже занят');
    const c = { id: `c-${randomUUID().slice(0, 8)}`, region: null, ...pick(body, ['name', 'slug', 'region', 'timezone']), status: 'active', rowVersion: 1 } as MockCity;
    cities.push(c);
    writeAudit(s, 'city', c.id, 'city.created', {}, c);
    return reply.code(201).send(c);
  });

  app.patch(`${P}/cities/:cityId`, async (req, reply) => {
    const s = currentStaff(req)!;
    if (!can(s, 'network.city.manage')) return forbidden(reply);
    const c = cities.find((x) => x.id === (req.params as { cityId: string }).cityId);
    if (!c) return notFound(reply);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const issues = textIssues(body, ['name', 'slug', 'timezone'], true);
    if (issues.length) return invalid(reply, issues);
    const stale = staleVersion(reply, body, c);
    if (stale) return stale;
    if (body.slug !== undefined && cities.some((x) => x.slug === body.slug && x.id !== c.id)) return fail(reply, 409, 'SLUG_TAKEN', 'Такой адрес (slug) уже занят');
    const before = { ...c };
    Object.assign(c, pick(body, ['name', 'slug', 'region', 'timezone']), { rowVersion: c.rowVersion + 1 });
    for (const b of branches) if (b.cityId === c.id) Object.assign(b, { cityName: c.name, citySlug: c.slug });
    writeAudit(s, 'city', c.id, 'city.updated', before, c);
    return c;
  });

  for (const op of ['archive', 'restore'] as const) {
    app.post(`${P}/cities/:cityId/${op}`, async (req, reply) => {
      const s = currentStaff(req)!;
      if (!can(s, 'network.city.manage')) return forbidden(reply);
      const c = cities.find((x) => x.id === (req.params as { cityId: string }).cityId);
      if (!c) return notFound(reply);
      const stale = staleVersion(reply, (req.body ?? {}) as Record<string, unknown>, c);
      if (stale) return stale;
      if (op === 'archive' && branches.some((b) => b.cityId === c.id && b.status !== 'archived')) {
        return fail(reply, 409, 'CITY_HAS_ACTIVE_BRANCHES', 'В городе есть действующие филиалы – сначала отправьте их в архив');
      }
      const before = { ...c };
      Object.assign(c, { status: op === 'archive' ? 'archived' : 'active', rowVersion: c.rowVersion + 1 });
      writeAudit(s, 'city', c.id, op === 'archive' ? 'city.archived' : 'city.updated', before, c);
      return c;
    });
  }

  // Курсорная пагинация K11; MOCK_PAGE_SIZE ужимает страницу, чтобы e2e проходили по курсору до конца.
  // Архивные филиалы – только по archived=true (рабочие списки и переключатель их не видят).
  app.get(`${P}/branches`, async (req) => {
    const ids = new Set(access(currentStaff(req)!).branchIds);
    const q = req.query as { q?: string; cityId?: string; status?: string; archived?: string; cursor?: string; limit?: string };
    const needle = (q.q ?? '').trim().toLowerCase();
    const all = branches.filter(
      (b) =>
        ids.has(b.id) &&
        (q.archived === 'true') === (b.status === 'archived') &&
        (!q.cityId || b.cityId === q.cityId) &&
        (!q.status || b.status === q.status) &&
        (!needle || `${b.name} ${b.address}`.toLowerCase().includes(needle)),
    );
    return page(all, q);
  });

  app.get(`${P}/branches/:branchId`, async (req, reply) => {
    const { branchId } = req.params as { branchId: string };
    const b = branches.find((x) => x.id === branchId);
    // K1/K11: вне зоны – то же 404, что у несуществующего.
    if (!b || !access(currentStaff(req)!).branchIds.includes(b.id)) return notFound(reply);
    return b;
  });

  app.post(`${P}/branches`, async (req, reply) => {
    const s = currentStaff(req)!;
    if (!can(s, 'network.branch.create')) return forbidden(reply);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const issues = [...textIssues(body, ['cityId', 'name', 'slug', 'address', 'timezone'], false), ...hoursIssues(body.weeklyHours ?? null)];
    if (issues.length) return invalid(reply, issues);
    const city = cities.find((c) => c.id === body.cityId && c.status === 'active');
    if (!city) return invalid(reply, [{ path: 'cityId', message: 'Выберите действующий город' }]);
    if (body.status === 'archived') return invalid(reply, [{ path: 'status', message: 'Архив – отдельной командой' }]);
    if (branches.some((b) => b.cityId === city.id && b.slug === body.slug)) return fail(reply, 409, 'SLUG_TAKEN', 'Такой адрес (slug) в городе уже занят');
    const b = {
      id: `b-${randomUUID().slice(0, 8)}`, status: 'preparing',
      ...pick(body, ['cityId', 'name', 'slug', 'address', 'timezone', 'status', 'weeklyHours']),
      cityName: city.name, citySlug: city.slug, rowVersion: 1,
    } as MockBranch;
    branches.push(b);
    writeAudit(s, 'branch', b.id, 'branch.created', {}, b);
    return reply.code(201).send(b);
  });

  app.patch(`${P}/branches/:branchId`, async (req, reply) => {
    const s = currentStaff(req)!;
    const b = branches.find((x) => x.id === (req.params as { branchId: string }).branchId);
    if (!b || !access(s).branchIds.includes(b.id)) return notFound(reply);
    if (!can(s, 'network.branch.update')) return forbidden(reply);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const issues = [...textIssues(body, ['name', 'slug', 'address', 'timezone'], true), ...hoursIssues(body.weeklyHours)];
    if (body.status === 'archived') issues.push({ path: 'status', message: 'Архив – отдельной командой' });
    if (body.cityId !== undefined && body.cityId !== b.cityId) issues.push({ path: 'cityId', message: 'Город филиала не меняется' });
    if (issues.length) return invalid(reply, issues);
    const stale = staleVersion(reply, body, b);
    if (stale) return stale;
    const before = { ...b };
    Object.assign(b, pick(body, ['name', 'slug', 'address', 'timezone', 'status', 'weeklyHours']), { rowVersion: b.rowVersion + 1 });
    const action =
      before.status !== b.status ? 'branch.status_changed'
      : JSON.stringify(before.weeklyHours) !== JSON.stringify(b.weeklyHours) ? 'branch.hours_changed' : 'branch.updated';
    writeAudit(s, 'branch', b.id, action, before, b);
    return b;
  });

  for (const op of ['archive', 'restore'] as const) {
    app.post(`${P}/branches/:branchId/${op}`, async (req, reply) => {
      const s = currentStaff(req)!;
      const b = branches.find((x) => x.id === (req.params as { branchId: string }).branchId);
      if (!b || !access(s).branchIds.includes(b.id)) return notFound(reply);
      if (!can(s, 'network.branch.archive')) return forbidden(reply);
      const stale = staleVersion(reply, (req.body ?? {}) as Record<string, unknown>, b);
      if (stale) return stale;
      const before = { ...b };
      Object.assign(b, { status: op === 'archive' ? 'archived' : 'preparing', rowVersion: b.rowVersion + 1 });
      writeAudit(s, 'branch', b.id, op === 'archive' ? 'branch.archived' : 'branch.status_changed', before, b);
      return b;
    });
  }

  // Хронология объекта (K2 objectTimeline): audit.view – в зоне, audit.view.own – только свои действия.
  // HTTP-маршрута в K11 нет – предложение контракта: GET /audit/timeline?objectType=&objectId=&cursor=&limit=.
  app.get(`${P}/audit/timeline`, async (req, reply) => {
    const s = currentStaff(req)!;
    const q = req.query as { objectType?: string; objectId?: string; cursor?: string; limit?: string };
    if (!can(s, 'audit.view') && !can(s, 'audit.view.own')) return forbidden(reply);
    if (q.objectType === 'branch' && !access(s).branchIds.includes(q.objectId ?? '')) return notFound(reply);
    if (q.objectType === 'city' && !zoneCityIds(s).includes(q.objectId ?? '')) return notFound(reply);
    if (q.objectType === 'client') {
      const c = clients.find((x) => x.id === q.objectId);
      if (!c || !clientInZone(s, c)) return notFound(reply);
    }
    const all = audit
      .filter((e) => e.objectType === q.objectType && e.objectId === q.objectId && (can(s, 'audit.view') || e.actor?.id === s.id))
      .reverse();
    return page(all, q);
  });
}

// ---- справочники: точно по apps/api/src/modules/dictionaries/routes.ts (S0-13)

interface DictRow { code: string; name: string; isSystem: boolean; archivedAt: string | null; sortOrder: number; [k: string]: unknown }
type DictKind = 'resource-types' | 'space-types' | 'reasons';

function seedDictionaries(): Record<DictKind, DictRow[]> {
  const rt = (code: string, name: string, stepMinutes: number, sortOrder: number): DictRow =>
    ({ code, name, stepMinutes, bookable: true, isSystem: true, archivedAt: null, sortOrder });
  const st = (code: string, name: string, sortOrder: number): DictRow => ({ code, name, isSystem: false, archivedAt: null, sortOrder });
  let n = 0;
  const rs = (domain: string, code: string, name: string, isSystem: boolean, requiresComment: boolean, sortOrder: number): DictRow => ({
    id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, domain, code, name, isSystem, requiresComment, archivedAt: null, sortOrder,
  });
  return {
    'resource-types': [
      rt('pc', 'ПК', 30, 10), rt('vr_seat', 'VR-место', 15, 20), rt('room_whole', 'Комната целиком', 15, 30),
      rt('ps_room', 'PlayStation-комната', 30, 40), rt('composite', 'Составная конфигурация', 15, 50),
    ],
    'space-types': [
      st('hall', 'Общий зал', 10), st('vr_zone', 'VR-зона', 20), st('game_room', 'Отдельная игровая комната', 30),
      st('vip_room', 'VIP-комната', 40), st('technical', 'Техническое помещение', 50),
    ],
    reasons: [
      ...['booking_cancel_club', 'booking_cancel_client', 'no_show', 'visit_correction', 'resource_block', 'ledger_correction']
        .map((d) => rs(d, 'other', 'Другое', true, true, 1000)),
      rs('booking_cancel_club', 'equipment_failure', 'Неисправность оборудования', false, false, 10),
      rs('booking_cancel_client', 'changed_plans', 'Изменились планы', false, false, 10),
      rs('resource_block', 'repair', 'Ремонт', false, false, 10),
      rs('resource_block', 'maintenance', 'Обслуживание', false, false, 20),
    ],
  };
}
let dict = seedDictionaries();

const DICT_TABLE: Record<DictKind, string> = { 'resource-types': 'app.dict_resource_types', 'space-types': 'app.dict_space_types', reasons: 'app.dict_reasons' };
const DICT_EDITABLE: Record<DictKind, string[]> = {
  'resource-types': ['name', 'stepMinutes', 'bookable', 'sortOrder'], 'space-types': ['name', 'sortOrder'], reasons: ['name', 'requiresComment', 'sortOrder'],
};
const DICT_CODE = /^[a-z][a-z0-9_]{0,62}$/;

function registerDictionaries(app: FastifyInstance, P: string) {
  const D = `${P}/dictionaries`;
  const systemImmutable = (reply: FastifyReply) =>
    fail(reply, 409, 'DICTIONARY_SYSTEM_IMMUTABLE', 'Системное значение: код нельзя изменить, значение нельзя удалить или архивировать');
  const archiveOnly = (reply: FastifyReply) => fail(reply, 409, 'DICTIONARY_ARCHIVE_ONLY', 'Значение не удаляется – только архив');

  for (const kind of Object.keys(DICT_TABLE) as DictKind[]) {
    const keyParam = kind === 'reasons' ? 'id' : 'code';
    const path = `${D}/${kind}/:${keyParam}`;
    const find = (req: FastifyRequest) => {
      const key = (req.params as Record<string, string>)[keyParam];
      return dict[kind].find((r) => r[keyParam] === key);
    };
    const ref = (r: DictRow) => `${DICT_TABLE[kind]}:${String(r[keyParam])}`;

    app.get(`${D}/${kind}`, async (req, reply) => {
      if (!can(currentStaff(req)!, 'network.view')) return forbidden(reply);
      const q = req.query as { domain?: string; includeArchived?: string };
      return {
        items: dict[kind].filter(
          (r) => (kind === 'resource-types' || q.includeArchived === 'true' || !r.archivedAt) && (!q.domain || kind !== 'reasons' || r.domain === q.domain),
        ),
      };
    });

    app.patch(path, async (req, reply) => {
      const s = currentStaff(req)!;
      if (!can(s, 'dictionary.manage')) return forbidden(reply);
      const row = find(req);
      if (!row) return notFound(reply);
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (body.code !== undefined && body.code !== row.code) {
        if (row.isSystem) return systemImmutable(reply);
        return fail(reply, 400, 'VALIDATION_FAILED', 'Код значения неизменен – создайте новое, старое – в архив');
      }
      if (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim())) return invalid(reply, [{ path: 'name', message: 'Заполните поле' }]);
      const before = { ...row };
      Object.assign(row, pick(body, DICT_EDITABLE[kind]));
      writeAudit(s, 'dictionary', ref(row), 'dictionary.changed', before, row, 'update');
      return row;
    });

    app.delete(path, async (req, reply) => {
      if (!can(currentStaff(req)!, 'dictionary.manage')) return forbidden(reply);
      const row = find(req);
      if (!row) return notFound(reply);
      return row.isSystem ? systemImmutable(reply) : archiveOnly(reply);
    });

    if (kind === 'resource-types') continue;
    for (const op of ['archive', 'restore'] as const) {
      app.post(`${path}/${op}`, async (req, reply) => {
        const s = currentStaff(req)!;
        if (!can(s, 'dictionary.manage')) return forbidden(reply);
        const row = find(req);
        if (!row) return notFound(reply);
        if (row.isSystem) return systemImmutable(reply);
        const before = { ...row };
        row.archivedAt = op === 'archive' ? (row.archivedAt ?? new Date().toISOString()) : null;
        if (before.archivedAt !== row.archivedAt) writeAudit(s, 'dictionary', ref(row), 'dictionary.changed', before, row, op);
        return row;
      });
    }

    app.post(`${D}/${kind}`, async (req, reply) => {
      const s = currentStaff(req)!;
      if (!can(s, 'dictionary.manage')) return forbidden(reply);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const issues: Issue[] = [];
      if (typeof body.code !== 'string' || !DICT_CODE.test(body.code)) issues.push({ path: 'code', message: 'Латиница в нижнем регистре, цифры и _, первая – буква' });
      if (typeof body.name !== 'string' || !body.name.trim()) issues.push({ path: 'name', message: 'Заполните поле' });
      if (kind === 'reasons' && typeof body.domain !== 'string') issues.push({ path: 'domain', message: 'Выберите раздел' });
      if (issues.length) return invalid(reply, issues);
      if (dict[kind].some((r) => r.code === body.code && (kind !== 'reasons' || r.domain === body.domain))) {
        return fail(reply, 409, 'DICTIONARY_CODE_TAKEN', 'Такой код уже есть');
      }
      const row: DictRow = {
        ...(kind === 'reasons' ? { id: randomUUID(), domain: body.domain, requiresComment: body.requiresComment ?? false } : {}),
        code: body.code as string, name: (body.name as string).trim(), isSystem: false, archivedAt: null, sortOrder: Number(body.sortOrder ?? 0),
      };
      dict[kind].push(row);
      writeAudit(s, 'dictionary', ref(row), 'dictionary.changed', {}, row, 'create');
      return reply.code(201).send(row);
    });
  }
}

// ---- клиенты: точно по apps/api/src/modules/clients/routes.crm.ts (K11 №15–16, S1-11)
// Связь клиент – филиал (брони, S1-07) в моке – поле links: так не-Владелец видит клиентов своей зоны.
// Пока бронирования нет, настоящий бэкенд связей не даёт (noBranchLinks) – находит только по точному телефону.

const CLIENT_STATUSES = ['guest', 'active', 'restricted', 'blocked', 'deletion_requested', 'anonymized'] as const;
type ClientStatus = (typeof CLIENT_STATUSES)[number];
interface MockClient {
  id: string; status: ClientStatus; firstName: string | null; lastName: string | null; phoneE164: string | null;
  email: string | null; birthDate: string | null; statusReason: string | null; statusUntil: string | null;
  registrationSource: string | null; phoneVerifiedAt: string | null; registeredAt: string | null; createdAt: string;
  lastLoginAt: string | null; rowVersion: number; links: string[];
}

const clientId = (n: number) => `c0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function seedClients(): MockClient[] {
  const base = { email: null, birthDate: null, statusReason: null, statusUntil: null, registrationSource: null, lastLoginAt: null, rowVersion: 1 };
  return [
    { ...base, id: clientId(1), status: 'active', firstName: 'Ольга', lastName: 'Смирнова', phoneE164: '+79131234567', email: 'olga@yu.test',
      birthDate: '1995-04-12', registrationSource: 'site', phoneVerifiedAt: '2026-10-01T05:00:00.000Z', registeredAt: '2026-10-01T05:00:00.000Z',
      createdAt: '2026-09-28T09:30:00.000Z', lastLoginAt: '2026-10-30T12:15:00.000Z', rowVersion: 3, links: ['b-nsk-krasny'] },
    { ...base, id: clientId(2), status: 'guest', firstName: 'Иван', lastName: 'Петров', phoneE164: '+79139876543',
      phoneVerifiedAt: null, registeredAt: null, createdAt: '2026-10-15T11:00:00.000Z', links: ['b-nsk-krasny'] },
    { ...base, id: clientId(3), status: 'blocked', firstName: 'Мария', lastName: 'Кузнецова', phoneE164: '+79230001122', email: 'maria@yu.test',
      statusReason: 'Нарушение правил клуба', registrationSource: 'site', phoneVerifiedAt: '2026-08-01T05:00:00.000Z',
      registeredAt: '2026-08-01T05:00:00.000Z', createdAt: '2026-08-01T05:00:00.000Z', links: ['b-tsk-lenina'] },
    { ...base, id: clientId(4), status: 'anonymized', firstName: null, lastName: null, phoneE164: null,
      phoneVerifiedAt: null, registeredAt: null, createdAt: '2026-01-10T05:00:00.000Z', links: ['b-nsk-krasny'] },
  ];
}
let clients = seedClients();

// Аудит клиента пишется уже маскированным (K2 redact: PD_KEYS) – так его отдаёт и хронология.
function seedClientAudit(): AuditEvent[] {
  const sys = null as unknown as AuditEvent['actor'];
  return [
    { id: randomUUID(), at: '2026-09-28T09:30:00.000Z', objectType: 'client', objectId: clientId(1), action: 'client.created', actor: sys,
      before: {}, after: { status: 'guest', phoneE164: '+7******4567', firstName: 'О***', lastName: 'С***' }, reason: null },
    { id: randomUUID(), at: '2026-10-01T05:00:00.000Z', objectType: 'client', objectId: clientId(1), action: 'client.status_changed', actor: sys,
      before: { status: 'guest' }, after: { status: 'active' }, reason: null },
  ];
}

const maskPhone = (e164: string | null) =>
  !e164 ? '' : e164.startsWith('+7') && e164.length === 12 ? `+7 ••• ••• ••-${e164.slice(-2)}` : `${e164.slice(0, 2)} ••• ${e164.slice(-2)}`;
const clientRef = (c: MockClient) => ({ id: c.id, status: c.status, firstName: c.firstName, lastName: c.lastName, phoneMasked: maskPhone(c.phoneE164) });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Упрощённый normalizePhone (clients/index.ts): РФ по умолчанию, неверный – null. */
function normalizePhone(t: string): string | null {
  const raw = t.trim().replace(/[\s().-]/g, '');
  const digits = raw.startsWith('+') ? raw.slice(1) : raw;
  if (!/^\d+$/.test(digits)) return null;
  if (raw.startsWith('+')) return /^[1-9]\d{7,14}$/.test(digits) && (!digits.startsWith('7') || digits.length === 11) ? `+${digits}` : null;
  if (digits.length === 11 && (digits[0] === '8' || digits[0] === '7')) return `+7${digits.slice(1)}`;
  return digits.length === 10 ? `+7${digits}` : null;
}

/** Клиент в зоне сотрудника: Владелец – все, остальные – по связи с филиалами зоны. */
const clientInZone = (s: MockStaff, c: MockClient) => access(s).network || c.links.some((b) => access(s).branchIds.includes(b));

function registerClients(app: FastifyInstance, P: string) {
  app.get(`${P}/clients`, async (req, reply) => {
    const s = currentStaff(req)!;
    if (!can(s, 'client.view.basic')) return fail(reply, 403, 'FORBIDDEN', 'Недостаточно прав', { action: 'client.view.basic' });
    const q = req.query as { q?: string; branchId?: string; status?: string; cursor?: string; limit?: string };
    const t = (q.q ?? '').trim();
    const status = (q.status ?? '').split(',').filter((x) => x !== '');
    const limit = q.limit === undefined ? 50 : Number(q.limit);
    if ((q.q ?? '').length > 100 || status.some((x) => !(CLIENT_STATUSES as readonly string[]).includes(x)) || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      return invalid(reply, [{ path: 'query', message: 'Неверные данные запроса' }]);
    }
    let match: (c: MockClient) => boolean = () => true;
    let byPhone = false;
    if (UUID.test(t)) match = (c) => c.id === t.toLowerCase();
    else if (/^[+\d\s().-]+$/.test(t)) {
      const digits = t.replace(/\D/g, '');
      if (digits.length < 4) return fail(reply, 400, 'VALIDATION_FAILED', 'Для поиска по телефону нужно от 4 цифр', { field: 'q' });
      const e164 = digits.length === 4 ? null : normalizePhone(t);
      byPhone = e164 !== null;
      match = digits.length === 4 ? (c) => (c.phoneE164 ?? '').endsWith(digits) : e164 ? (c) => c.phoneE164 === e164 : (c) => (c.phoneE164 ?? '').includes(digits);
    } else if (t.includes('@')) match = (c) => c.email === t.toLowerCase();
    else if (t) {
      const words = t.toLowerCase().split(/\s+/).slice(0, 3);
      match = (c) => words.every((w) => (c.lastName ?? '').toLowerCase().startsWith(w) || (c.firstName ?? '').toLowerCase().startsWith(w));
    }
    const zone = access(s);
    if (q.branchId && !zone.branchIds.includes(q.branchId)) return notFound(reply);
    const key = (c: MockClient) => `${(c.lastName ?? '').toLowerCase()}\u0000${(c.firstName ?? '').toLowerCase()}\u0000${c.id}`;
    const all = clients
      .filter((c) => match(c) && (byPhone || clientInZone(s, c)) && (!q.branchId || c.links.includes(q.branchId)))
      .filter((c) => (status.length ? status.includes(c.status) : c.status !== 'anonymized'))
      .sort((a, b) => (key(a) < key(b) ? -1 : 1))
      .map((c) => ({ ...clientRef(c), lastVisitAt: null, lastBranchId: null }));
    return page(all, { ...q, limit: String(limit) });
  });

  app.get(`${P}/clients/:clientId`, async (req, reply) => {
    const s = currentStaff(req)!;
    if (!can(s, 'client.view.basic')) return fail(reply, 403, 'FORBIDDEN', 'Недостаточно прав', { action: 'client.view.basic' });
    const c = clients.find((x) => x.id === (req.params as { clientId: string }).clientId);
    if (!c || !clientInZone(s, c)) return notFound(reply);
    return {
      ...clientRef(c), isGuest: c.status === 'guest', phoneVerified: c.phoneVerifiedAt !== null, registeredAt: c.registeredAt,
      full: can(s, 'client.view.full')
        ? { phoneE164: c.phoneE164, email: c.email, birthDate: c.birthDate, statusReason: c.statusReason, statusUntil: c.statusUntil,
            registrationSource: c.registrationSource, createdAt: c.createdAt, lastLoginAt: c.lastLoginAt }
        : null,
      rowVersion: c.rowVersion,
    };
  });
}

export function buildMock() {
  const app = Fastify({ logger: false });
  const P = '/api/crm/v1';
  audit = seedClientAudit();

  app.addHook('preHandler', async (req, reply) => {
    if (req.url.startsWith(`${P}/auth/login`) || req.url === '/__test/reset') return;
    const s = currentStaff(req);
    if (!s) return fail(reply, 401, 'AUTH_REQUIRED', 'Нужно войти');
    const allowed = [`${P}/auth/session`, `${P}/auth/password`, `${P}/auth/logout`, `${P}/me`];
    if (s.mustChangePassword && !allowed.some((u) => req.url.startsWith(u))) {
      return fail(reply, 403, 'PASSWORD_CHANGE_REQUIRED', 'Сначала смените пароль');
    }
  });

  app.post(`${P}/auth/login`, async (req, reply) => {
    const body = (req.body ?? {}) as { email?: string; password?: string };
    const email = String(body.email ?? '').trim().toLowerCase();
    const s = staff.find((x) => x.email === email);
    // K12: неверный email и неверный пароль – один и тот же ответ.
    if (!s || s.password !== body.password) return fail(reply, 401, 'INVALID_CREDENTIALS', 'Неверная почта или пароль');
    const token = randomBytes(32).toString('base64url');
    sessions.set(token, s.id);
    reply.header('set-cookie', `yu_staff=${token}; HttpOnly; SameSite=Strict; Path=/`);
    return { staff: publicStaff(s), totpRequired: false };
  });

  app.post(`${P}/auth/logout`, async (req, reply) => {
    const token = readCookie(req, 'yu_staff');
    if (token) sessions.delete(token);
    reply.header('set-cookie', 'yu_staff=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return reply.code(204).send();
  });

  app.get(`${P}/auth/session`, async (req) => {
    const s = currentStaff(req)!;
    const now = Date.now();
    return { staff: { ...publicStaff(s), mustChangePassword: s.mustChangePassword === true }, expiresAt: new Date(now + 12 * 3600e3).toISOString(), idleExpiresAt: new Date(now + 30 * 60e3).toISOString() };
  });

  app.post(`${P}/auth/password`, async (req, reply) => {
    const s = currentStaff(req)!;
    const body = (req.body ?? {}) as { currentPassword?: string; newPassword?: string };
    if (body.currentPassword !== s.password) return fail(reply, 401, 'INVALID_CREDENTIALS', 'Текущий пароль указан неверно');
    if (String(body.newPassword ?? '').length < 12) return fail(reply, 422, 'PASSWORD_TOO_WEAK', 'Новый пароль – не короче 12 символов');
    // Мок не меняет пароль по-настоящему: тесты идут параллельно на общих учётках. Флаг смены – снимает.
    s.mustChangePassword = false;
    return reply.code(204).send();
  });

  app.get(`${P}/me`, async (req) => {
    const s = currentStaff(req)!;
    return { staff: { ...publicStaff(s), mustChangePassword: s.mustChangePassword === true }, access: access(s), actions: ACTIONS[s.role] };
  });

  app.post('/__test/reset', async () => {
    cities = seedCities();
    branches = seedBranches(cities);
    dict = seedDictionaries();
    clients = seedClients();
    audit = seedClientAudit();
    return { ok: true };
  });

  registerNetwork(app, P);
  registerDictionaries(app, P);
  registerClients(app, P);
  return app;
}

if (import.meta.main) {
  const port = Number(process.env.MOCK_PORT ?? 4010);
  await buildMock().listen({ host: '127.0.0.1', port });
  console.log(`mock-api: http://127.0.0.1:${port}`);
}

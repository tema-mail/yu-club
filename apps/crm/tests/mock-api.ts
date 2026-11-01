// Мок API CRM для разработки и Playwright – пока нет бэкенда (S0-09…S0-11).
// Повторяет контракты: K12 (вход, сессия, пароль), K11 №1 GET /me, K11 №18 сеть (список и карточка филиала),
// K1 (роли и зоны: объект вне зоны – 404 с телом, как у несуществующего), ADR 0002 (тело ошибки).
// Запуск: MOCK_PORT=4010 node tests/mock-api.ts; CRM: API_URL=http://127.0.0.1:4010.
// Учётки (пароль у всех один – MOCK_PASSWORD): owner@yu.test, director@yu.test, admin@yu.test.
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { randomBytes, randomUUID } from 'node:crypto';

type Role = 'owner' | 'director' | 'admin';

export const MOCK_PASSWORD = 'yu-club-test-pass';

const cities = [
  { id: 'c-nsk', name: 'Новосибирск' },
  { id: 'c-tsk', name: 'Томск' },
];

const branches = [
  { id: 'b-nsk-krasny', cityId: 'c-nsk', slug: 'krasny', name: 'Ю Клуб на Красном', address: 'Красный проспект, 25', timezone: 'Asia/Novosibirsk', status: 'active' },
  { id: 'b-nsk-akadem', cityId: 'c-nsk', slug: 'akadem', name: 'Ю Клуб Академгородок', address: 'Морской проспект, 2', timezone: 'Asia/Novosibirsk', status: 'temporarily_closed' },
  { id: 'b-tsk-lenina', cityId: 'c-tsk', slug: 'lenina', name: 'Ю Клуб на Ленина', address: 'проспект Ленина, 80', timezone: 'Asia/Tomsk', status: 'active' },
].map((b) => ({ ...b, cityName: cities.find((c) => c.id === b.cityId)!.name }));

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

export function buildMock() {
  const app = Fastify({ logger: false });
  const P = '/api/crm/v1';

  app.addHook('preHandler', async (req, reply) => {
    if (req.url.startsWith(`${P}/auth/login`)) return;
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

  // Курсорная пагинация K11; MOCK_PAGE_SIZE ужимает страницу, чтобы e2e проходили по курсору до конца.
  app.get(`${P}/branches`, async (req) => {
    const ids = new Set(access(currentStaff(req)!).branchIds);
    const q = req.query as { cursor?: string; limit?: string };
    const size = Math.min(Number(q.limit ?? 50), Number(process.env.MOCK_PAGE_SIZE ?? 100));
    const all = branches.filter((b) => ids.has(b.id));
    const from = q.cursor ? Number(q.cursor) : 0;
    const items = all.slice(from, from + size);
    return { items, nextCursor: from + size < all.length ? String(from + size) : null };
  });

  app.get(`${P}/branches/:branchId`, async (req, reply) => {
    const { branchId } = req.params as { branchId: string };
    const b = branches.find((x) => x.id === branchId);
    // K1/K11: вне зоны – то же 404, что у несуществующего.
    if (!b || !access(currentStaff(req)!).branchIds.includes(b.id)) return fail(reply, 404, 'NOT_FOUND', 'Не найдено');
    return b;
  });

  return app;
}

if (import.meta.main) {
  const port = Number(process.env.MOCK_PORT ?? 4010);
  await buildMock().listen({ host: '127.0.0.1', port });
  console.log(`mock-api: http://127.0.0.1:${port}`);
}

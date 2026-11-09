// Мок ленты событий CRM строго по apps/api/src/modules/notifications/staff-feed.ts и routes.crm.ts (13 §11, S4-28, D4-46):
// GET /staff-feed (cursor, limit 1..50, unread=true|false), GET /staff-feed/unread-count, POST /staff-feed/:id/read (204),
// POST /staff-feed/read-all { before } → { marked }. Видимость: адресная строка – только адресату; строка зоны – право строки
// (equipment.view / notifications.view) в зоне филиала; чужое – 404. Порядок (occurredAt DESC, id DESC). Прочтение – своё у каждого.
// Отличие от API (данные мока): id филиалов и сотрудников засева – не UUID. Сброс – вместе с POST /__test/reset (хук onRequest).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

interface Staffish { id: string; role: string }
interface BranchLite { id: string; name: string }
export interface StaffFeedMockDeps {
  current: (req: FastifyRequest) => Staffish;
  zone: (s: Staffish) => { network: boolean; branchIds: string[] };
  can: (s: Staffish, action: string) => boolean;
  branches: () => BranchLite[];
}

type Kind = 'shift_changed' | 'repair_registered' | 'repair_closed' | 'service_notification_failed';
interface Row {
  id: string; branchId: string; staffId: string | null; action: 'equipment.view' | 'notifications.view' | null;
  kind: Kind; refType: 'shift' | 'repair' | 'client'; refId: string; title: string; body: string | null; occurredAt: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const fid = (n: number) => `f0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const K = 'b-nsk-krasny';
const T = 'b-tsk-lenina';

function seed(): Row[] {
  return [
    { id: fid(1), branchId: K, staffId: 's-admin', action: null, kind: 'shift_changed', refType: 'shift', refId: '5f000000-0000-4000-8000-000000000001',
      title: 'Ваша смена изменена', body: 'Было: 12 ноября, 10:00–18:00. Стало: 12 ноября, 12:00–20:00. Причина: замена', occurredAt: '2026-11-10T06:00:00.000Z' },
    { id: fid(2), branchId: K, staffId: null, action: 'equipment.view', kind: 'repair_registered', refType: 'repair', refId: 'e7000000-0000-4000-8000-000000000001',
      title: 'Новый ремонт № Р-12', body: 'Приоритет критичный, полный простой, ресурс заблокирован', occurredAt: '2026-11-10T05:00:00.000Z' },
    { id: fid(3), branchId: K, staffId: null, action: 'notifications.view', kind: 'service_notification_failed', refType: 'client', refId: 'c0000000-0000-4000-8000-000000000001',
      title: 'Клиент не получил: Ю-Клуб: бронь отменена', body: 'Нет канала push – сообщите клиенту по телефону', occurredAt: '2026-11-10T04:00:00.000Z' },
    { id: fid(4), branchId: T, staffId: null, action: 'equipment.view', kind: 'repair_registered', refType: 'repair', refId: 'e7000000-0000-4000-8000-000000000002',
      title: 'Новый ремонт № Т-3', body: 'Приоритет высокий, частичный простой', occurredAt: '2026-11-10T03:00:00.000Z' },
    { id: fid(5), branchId: K, staffId: null, action: 'equipment.view', kind: 'repair_closed', refType: 'repair', refId: 'e7000000-0000-4000-8000-000000000003',
      title: 'Ремонт № Р-9 закрыт', body: null, occurredAt: '2026-11-09T03:00:00.000Z' },
  ];
}

let rows: Row[] = [];
let reads = new Map<string, Set<string>>();
function reset(): void {
  rows = seed();
  reads = new Map([['s-admin', new Set([fid(5)])]]); // закрытый ремонт Анна уже прочла
}

const fail = (reply: FastifyReply, status: number, code: string, message: string, details?: Record<string, unknown>) =>
  reply.code(status).send({ error: { code, message, ...(details ? { details } : {}) } });

export function registerStaffFeed(app: FastifyInstance, P: string, d: StaffFeedMockDeps): void {
  reset();
  app.addHook('onRequest', async (req) => {
    if (req.method === 'POST' && req.url === '/__test/reset') reset();
  });
  /** Для спека: новое событие зоны (как обработчик repair.registered). */
  app.post('/__test/staff-feed/add', async (req) => {
    const b = (req.body ?? {}) as Partial<Row>;
    const r: Row = { id: fid(100 + rows.length), branchId: b.branchId ?? K, staffId: null, action: 'equipment.view', kind: 'repair_registered', refType: 'repair',
      refId: 'e7000000-0000-4000-8000-000000000099', title: b.title ?? 'Новый ремонт № Р-99', body: null, occurredAt: b.occurredAt ?? '2026-11-10T07:00:00.000Z' };
    rows.push(r);
    return { id: r.id };
  });

  const visible = (s: Staffish) => {
    const z = d.zone(s);
    return rows
      .filter((r) => (r.staffId !== null ? r.staffId === s.id : d.can(s, r.action!) && (z.network || z.branchIds.includes(r.branchId))))
      .sort((a, b) => (a.occurredAt === b.occurredAt ? (a.id < b.id ? 1 : -1) : a.occurredAt < b.occurredAt ? 1 : -1));
  };
  const isRead = (s: Staffish, id: string) => reads.get(s.id)?.has(id) ?? false;
  const unread = (s: Staffish) => visible(s).filter((r) => !isRead(s, r.id)).length;
  const mark = (s: Staffish, id: string) => {
    const set = reads.get(s.id) ?? new Set<string>();
    set.add(id);
    reads.set(s.id, set);
  };

  app.get(`${P}/staff-feed`, async (req, reply) => {
    const s = d.current(req);
    const q = (req.query ?? {}) as { cursor?: string; limit?: string; unread?: string };
    const issues: Array<{ path: string; message: string }> = [];
    const limit = q.limit === undefined ? 20 : Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) issues.push({ path: 'limit', message: 'Invalid number' });
    if (q.unread !== undefined && q.unread !== 'true' && q.unread !== 'false') issues.push({ path: 'unread', message: 'Invalid option' });
    if (q.cursor !== undefined && q.cursor.length > 512) issues.push({ path: 'cursor', message: 'Too big' });
    if (issues.length > 0) return fail(reply, 400, 'VALIDATION_FAILED', 'Неверные данные запроса', { issues });
    let list = visible(s);
    if (q.unread === 'true') list = list.filter((r) => !isRead(s, r.id));
    if (q.cursor) {
      let pos: [string, string];
      try {
        pos = JSON.parse(Buffer.from(q.cursor, 'base64url').toString('utf8')) as [string, string];
        if (!UUID.test(pos[1]) || Number.isNaN(Date.parse(pos[0]))) throw new Error('cursor');
      } catch {
        return fail(reply, 400, 'VALIDATION_FAILED', 'Неверный курсор', { field: 'cursor' });
      }
      const at = new Date(pos[0]).toISOString();
      list = list.filter((r) => r.occurredAt < at || (r.occurredAt === at && r.id < pos[1]));
    }
    const pageRows = list.slice(0, limit);
    const last = pageRows.at(-1);
    const names = new Map(d.branches().map((b) => [b.id, b.name]));
    reply.header('cache-control', 'no-store');
    return {
      items: pageRows.map((r) => ({ id: r.id, kind: r.kind, branchId: r.branchId, branchName: names.get(r.branchId) ?? '', refType: r.refType, refId: r.refId,
        title: r.title, body: r.body, occurredAt: r.occurredAt, read: isRead(s, r.id) })),
      nextCursor: list.length > limit && last ? Buffer.from(JSON.stringify([last.occurredAt, last.id])).toString('base64url') : null,
      unread: unread(s),
    };
  });

  app.get(`${P}/staff-feed/unread-count`, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return { unread: unread(d.current(req)) };
  });

  app.post(`${P}/staff-feed/:id/read`, async (req, reply) => {
    const s = d.current(req);
    const id = ((req.params as { id?: string }).id ?? '').toLowerCase();
    if (!UUID.test(id) || !visible(s).some((r) => r.id === id)) return fail(reply, 404, 'NOT_FOUND', 'Не найдено');
    mark(s, id);
    return reply.code(204).send();
  });

  app.post(`${P}/staff-feed/read-all`, async (req, reply) => {
    const s = d.current(req);
    const before = ((req.body ?? {}) as { before?: unknown }).before;
    if (typeof before !== 'string' || !ISO_OFFSET.test(before)) {
      return fail(reply, 400, 'VALIDATION_FAILED', 'Неверные данные запроса', { issues: [{ path: 'before', message: 'Invalid ISO datetime' }] });
    }
    const at = new Date(before).toISOString();
    const todo = visible(s).filter((r) => r.occurredAt <= at && !isRead(s, r.id));
    for (const r of todo) mark(s, r.id);
    return { marked: todo.length };
  });
}

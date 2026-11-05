// S3-61. Публичные маршруты мероприятий (K20 §10, §15): П3 «Мои мероприятия» (только чтение, без цен и себестоимости), П4 заявка на
// праздник с сайта (мероприятие birthday_party в new_request, source='site', без занятия комнаты, профиль клиента не создаётся),
// П5 сведения о празднике для страницы /birthday/ (цифры – из настроек, а не из вёрстки; цены нет, пока price_confirmed=false).
// Защита П4: пустая галочка согласия – CONSENT_REQUIRED, 5 заявок с телефона в сутки и 30 с адреса в час – RATE_LIMITED; счёт под
// замком телефона и адреса, параллельные не проскочат; адрес берётся из аудита заявки (своего столбца нет: 152-ФЗ, Q-100).
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit, type AuditRequestMeta, type Db, type Tx } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { idempotencyScope, requireIdempotencyKey, runIdempotent } from '../../core/idempotency.ts';
import { resolveSettings } from '../../core/settings.ts';
import { instantToLocal, parseLocalDate, systemClock, type Clock } from '../../core/time.ts';
import { authenticateClient, type ClientPublicDeps } from '../clients/routes.public.ts';
import { normalizePhone, withTx } from '../clients/index.ts';
import { getBranch, getBranches, isAcceptingBookings } from '../network/index.ts';
import { listBookableResources } from '../resources/index.ts';
import { getEventRow, insertEvent, notFound, parseBody, UUID_RE } from './events.ts';
import { assertPartyGuests } from './party.ts';

const MAX_PER_PHONE_DAY = 5;
const MAX_PER_IP_HOUR = 30;
const DAY_MS = 86_400_000;

const requestBody = z.object({
  branchId: z.string().regex(UUID_RE),
  preferredDate: z.string(),
  format: z.enum(['h2', 'h3plus', 'full_day']),
  guests: z.number().int(),
  name: z.string().trim().min(1).max(200),
  phone: z.string(),
  comment: z.string().trim().max(2000).optional(),
  consent: z.boolean().optional(),
});
const infoQuery = z.object({ branchId: z.string().regex(UUID_RE).optional() });

/** Заявка с сайта. Комната не занимается: сотрудник решает сам (K20 §4). Дата – пожелание: в карточке пока нет подтверждённого времени. */
async function createRequest(tx: Tx, raw: z.infer<typeof requestBody>, meta: AuditRequestMeta, clock: Clock): Promise<{ requestNumber: string }> {
  const now = clock.now();
  const branch = await getBranch(tx, raw.branchId);
  if (!branch || !isAcceptingBookings(branch, now)) throw notFound();
  const s = await resolveSettings(tx, ['event.requests_enabled'], { branchId: branch.id }, now);
  if (!s['event.requests_enabled'].value) throw new AppError('VALIDATION_FAILED', 400, 'Заявки сейчас не принимаются', { reason: 'requests_disabled' });
  if (!(await listBookableResources(tx, branch.id)).some((r) => r.type === 'room_whole')) throw new AppError('VALIDATION_FAILED', 400, 'В этом филиале нет комнаты для праздника', { field: 'branchId' });
  const date = parseLocalDate(raw.preferredDate);
  if (date < instantToLocal(now, branch.timezone).date) throw new AppError('VALIDATION_FAILED', 400, 'Дата уже прошла', { field: 'preferredDate' });
  await assertPartyGuests(tx, branch.id, raw.guests, now);
  const phone = normalizePhone(raw.phone);
  // порядок замков один: адрес → телефон
  if (meta.ip) await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('event-request-ip:' || $1, 0))`, [meta.ip]);
  await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('event-request-phone:' || $1, 0))`, [phone]);
  const byPhone = await tx.query<{ n: number }>(`SELECT count(*)::int n FROM app.events WHERE source = 'site' AND customer_phone_e164 = $1 AND created_at > $2`, [phone, new Date(now.getTime() - DAY_MS)]);
  if (byPhone.rows[0]!.n >= MAX_PER_PHONE_DAY) throw new AppError('RATE_LIMITED', 429, 'Слишком много заявок с этого номера, попробуйте завтра', { reason: 'phone_day', retryAfterSec: DAY_MS / 1000 });
  if (meta.ip) {
    const byIp = await tx.query<{ n: number }>(`SELECT count(*)::int n FROM journal.audit_events WHERE action = 'event.request_received' AND ip = $1::inet AND occurred_at > $2`, [meta.ip, new Date(now.getTime() - DAY_MS / 24)]);
    if (byIp.rows[0]!.n >= MAX_PER_IP_HOUR) throw new AppError('RATE_LIMITED', 429, 'Слишком много заявок, попробуйте позже', { reason: 'ip_hour', retryAfterSec: 3600 });
  }
  const type = await tx.query<{ id: string; name: string }>(`SELECT id, name FROM app.event_types WHERE code = 'birthday_party'`);
  const id = await insertEvent(tx, {
    typeId: type.rows[0]!.id,
    branch,
    title: type.rows[0]!.name,
    plannedStart: null,
    plannedEnd: null,
    customer: { clientId: null, name: raw.name, phone },
    birthdayPerson: { clientId: null, name: null },
    participantsCount: raw.guests,
    responsibleStaffId: null,
    wishes: [`Желаемая дата: ${date}`, raw.comment].filter(Boolean).join('. '),
    packageId: null,
    party: { format: raw.format, guests: raw.guests, catering: false },
    source: 'site',
    actor: { type: 'system', id: null },
    at: now,
  });
  const row = (await getEventRow(tx, id))!;
  await writeAudit(tx, meta, { action: 'event.request_received', object: { type: 'event', id }, branchId: branch.id, cityId: branch.cityId, after: { number: row.number, guestName: raw.name, guestPhone: phone, preferredDate: date, format: raw.format, guests: raw.guests, consent: true } }, clock);
  return { requestNumber: row.number };
}

/** П5: что показывает /birthday/. Филиал подходит, если в нём есть комната целиком на продажу. */
async function partyInfo(db: Db, branchId: string | undefined, now: Date) {
  const scope = await db.query<{ id: string }>(`SELECT id FROM app.branches WHERE status = 'active' AND ($1::uuid IS NULL OR id = $1) ORDER BY id`, [branchId ?? null]);
  const map = await getBranches(db, scope.rows.map((r) => r.id));
  const branches = [];
  for (const b of map.values()) {
    branches.push({ id: b.id, name: b.name, hasRoom: (await listBookableResources(db, b.id)).some((r) => r.type === 'room_whole') });
  }
  branches.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  const s = await resolveSettings(db, ['event.party.min_minutes', 'event.party.max_guests', 'event.party.price_confirmed', 'gift.valid_days', 'gift.room_minutes'], { network: true }, now);
  return {
    branches,
    minMinutes: s['event.party.min_minutes'].value,
    maxGuests: s['event.party.max_guests'].value,
    formats: ['h2', 'h3plus', 'full_day'] as const,
    // цены нет: пока price_confirmed=false сайт пишет «цена уточняется» (R-11, Q-70); подтверждённую цену добавит ответ заказчика
    priceConfirmed: s['event.party.price_confirmed'].value,
    giftTerms: { devices: 2, device: 'Meta Quest 3S', minutesEach: 30, roomMinutes: s['gift.room_minutes'].value, validDays: s['gift.valid_days'].value, weekdays: [1, 2, 3, 4, 5], excludesHolidays: true, notIncluded: ['PS4', 'PS VR', 'food'] },
  };
}

interface MyEventRow {
  id: string;
  number: string;
  title: string;
  status: string;
  planned_start: Date | null;
  planned_end: Date | null;
  branch_name: string;
  address: string;
}

export async function eventPublicRoutes(app: FastifyInstance, deps: ClientPublicDeps): Promise<void> {
  const clock = deps.clock ?? systemClock;

  // П3: только свои, от confirmed; состав – названия и количество, без цен и себестоимости; связанные брони – только чтение
  app.get('/me/events', async (request, reply) => {
    const { clientId } = await authenticateClient(deps, request, reply);
    const r = await deps.pool.query<MyEventRow>(
      `SELECT e.id, e.number, e.title, e.status, e.planned_start, e.planned_end, b.name AS branch_name, b.address
         FROM app.events e JOIN app.branches b ON b.id = e.branch_id
        WHERE e.customer_client_id = $1 AND e.status IN ('confirmed','preparing','in_progress','completed')
        ORDER BY e.planned_start DESC NULLS LAST, e.id DESC LIMIT 100`,
      [clientId],
    );
    const items = [];
    for (const e of r.rows) {
      const lines = await deps.pool.query<{ name: string; quantity: string; unit: string }>(`SELECT name, quantity, unit FROM app.event_lines WHERE event_id = $1 AND status = 'active' ORDER BY sort_order, id`, [e.id]);
      const bookings = await deps.pool.query<{ booking_id: string }>(`SELECT booking_id FROM app.event_bookings WHERE event_id = $1 ORDER BY linked_at, booking_id`, [e.id]);
      items.push({
        id: e.id,
        number: e.number,
        title: e.title,
        status: e.status,
        start: e.planned_start?.toISOString() ?? null,
        end: e.planned_end?.toISOString() ?? null,
        branch: { name: e.branch_name, address: e.address },
        lines: lines.rows.map((l) => ({ name: l.name, quantity: Number(l.quantity), unit: l.unit })),
        bookingIds: bookings.rows.map((b) => b.booking_id),
      });
    }
    return { items };
  });

  // П4: без входа. Галочка согласия – до всего остального: без неё сервер не принимает даже проверки полей
  app.post('/event-requests', async (request, reply) => {
    const key = requireIdempotencyKey(request.headers['idempotency-key']);
    const raw = (request.body && typeof request.body === 'object' ? request.body : {}) as Record<string, unknown>;
    if (raw.consent !== true) throw new AppError('CONSENT_REQUIRED', 422, 'Нужно согласие на обработку персональных данных', { field: 'consent' });
    const input = parseBody(requestBody, raw);
    const meta: AuditRequestMeta = { actor: { kind: 'system', process: 'site-event-request' }, source: 'site', requestId: request.id, ip: request.ip };
    // телефон в ключ не пишем: область – хэш адреса заявителя, чтобы повтор чужим ключом не вернул чужую заявку
    const actor = createHash('sha256').update(request.ip).digest('hex').slice(0, 32);
    const result = await withTx(deps.pool, (tx) =>
      runIdempotent(
        tx,
        { scope: idempotencyScope('visitor', actor, 'event.request'), key, request: { route: 'POST /event-requests', body: { ...input, phone: createHash('sha256').update(input.phone).digest('hex') } }, clock },
        async () => ({ status: 201, body: await createRequest(tx, input, meta, clock) }),
      ),
    );
    if (result.replayed) reply.header('idempotent-replay', 'true');
    return reply.code(result.status).send(result.body);
  });

  // П5: без входа
  app.get('/party-info', async (request) => {
    const q = parseBody(infoQuery, request.query);
    return partyInfo(deps.pool, q.branchId, clock.now());
  });
}

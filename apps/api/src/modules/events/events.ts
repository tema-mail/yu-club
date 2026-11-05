// S3-50. Мероприятие (K20 §2): создаётся без брони и без профиля, статусы по таблице переходов с историей в аудите,
// номер EV-000123 из последовательности сети, подтверждение – с проверкой готовности. Мероприятие – не сеанс оплаты K10:
// деньги – отдельные операции кассы (money.ts). Телефон заказчика – контакт: профиль клиента по нему не создаётся.
// Команды идут в транзакции вызывающего; порядок замков: мероприятие FOR UPDATE → единицы (через провайдер booking).
// Занятие и освобождение ресурсов – только провайдерами booking (K6), не импортом occupancy.ts.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { diffFields, writeAudit, type AuditRequestMeta, type Db, type Tx } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { publish, type Tx as OutboxTx } from '../../core/outbox.ts';
import { can, type AccessContext, type Action } from '../../core/permissions.ts';
import { resolveSetting } from '../../core/settings.ts';
import { systemClock, type Clock } from '../../core/time.ts';
import { releaseEvent } from '../booking/providers.ts';
import { maskPhone, normalizePhone } from '../clients/index.ts';
import { getBranch, type BranchInfo } from '../network/index.ts';

export const EVENT_STATUSES = ['new_request', 'negotiation', 'awaiting_confirmation', 'confirmed', 'preparing', 'in_progress', 'completed', 'cancelled', 'not_held'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];
export type PartyFormat = 'h2' | 'h3plus' | 'full_day';
export interface PartyInfo {
  format: PartyFormat;
  guests: number;
  catering: boolean;
}

/** Деньги (K20 §6) добавляет маршрут из money.ts: это чтение кассы, а не строка мероприятия. */
export interface EventDto {
  id: string;
  number: string;
  typeId: string;
  typeCode: string;
  title: string;
  branchId: string;
  timezone: string;
  plannedStart: string | null;
  plannedEnd: string | null;
  status: EventStatus;
  customer: { clientId: string | null; name: string; phoneMasked: string };
  birthdayPerson: { clientId: string | null; name: string | null };
  participantsCount: number | null;
  responsibleStaffId: string | null;
  wishes: string | null;
  packageId: string | null;
  party: PartyInfo | null;
  source: 'crm' | 'site';
  cancel: { reason: string; by: string | null; at: string } | null;
  rowVersion: number;
}

export interface EventRow {
  id: string;
  number: string;
  type_id: string;
  type_code: string;
  title: string;
  branch_id: string;
  timezone: string;
  planned_start: Date | null;
  planned_end: Date | null;
  status: EventStatus;
  customer_client_id: string | null;
  customer_name: string;
  customer_phone_e164: string;
  birthday_client_id: string | null;
  birthday_person_name: string | null;
  participants_count: number | null;
  responsible_staff_id: string | null;
  wishes: string | null;
  package_id: string | null;
  party_format: PartyFormat | null;
  party_guests: number | null;
  party_catering: boolean | null;
  source: 'crm' | 'site';
  cancel_reason: string | null;
  cancelled_by: string | null;
  cancelled_at: Date | null;
  row_version: number;
  created_at: Date;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const notFound = () => new AppError('NOT_FOUND', 404, 'Не найдено');

export const EVENT_SELECT = `SELECT e.id, e.number, e.type_id, t.code AS type_code, e.title, e.branch_id, b.timezone, e.planned_start, e.planned_end, e.status,
    e.customer_client_id, e.customer_name, e.customer_phone_e164, e.birthday_client_id, e.birthday_person_name, e.participants_count,
    e.responsible_staff_id, e.wishes, e.package_id, e.party_format, e.party_guests, e.party_catering, e.source, e.cancel_reason, e.cancelled_by,
    e.cancelled_at, e.row_version, e.created_at
  FROM app.events e JOIN app.event_types t ON t.id = e.type_id JOIN app.branches b ON b.id = e.branch_id`;

export function toEventDto(r: EventRow): EventDto {
  return {
    id: r.id,
    number: r.number,
    typeId: r.type_id,
    typeCode: r.type_code,
    title: r.title,
    branchId: r.branch_id,
    timezone: r.timezone,
    plannedStart: r.planned_start?.toISOString() ?? null,
    plannedEnd: r.planned_end?.toISOString() ?? null,
    status: r.status,
    customer: { clientId: r.customer_client_id, name: r.customer_name, phoneMasked: maskPhone(r.customer_phone_e164) },
    birthdayPerson: { clientId: r.birthday_client_id, name: r.birthday_person_name },
    participantsCount: r.participants_count,
    responsibleStaffId: r.responsible_staff_id,
    wishes: r.wishes,
    packageId: r.package_id,
    party: r.party_format ? { format: r.party_format, guests: r.party_guests ?? 0, catering: r.party_catering ?? false } : null,
    source: r.source,
    cancel: r.cancel_reason !== null && r.cancelled_at !== null ? { reason: r.cancel_reason, by: r.cancelled_by, at: r.cancelled_at.toISOString() } : null,
    rowVersion: r.row_version,
  };
}

export const isClosed = (s: EventStatus): boolean => s === 'completed' || s === 'cancelled' || s === 'not_held';

/** Чтение строки мероприятия; неверный id – null. */
export async function getEventRow(db: Db, id: string, opts: { forUpdate?: boolean } = {}): Promise<EventRow | null> {
  if (!UUID_RE.test(id)) return null;
  const r = await db.query<EventRow>(`${EVENT_SELECT} WHERE e.id = $1${opts.forUpdate ? ' FOR UPDATE OF e' : ''}`, [id]);
  return r.rows[0] ?? null;
}

/** Вне зоны (нет event.view на филиал) – 404 как у несуществующего; в зоне без права – 403 (K1). */
export function guardEvent(ctx: AccessContext, branchId: string, action: Action): void {
  if (!can(ctx, 'event.view', { branchId })) throw notFound();
  if (!can(ctx, action, { branchId })) throw new AppError('FORBIDDEN', 403, 'Недостаточно прав', { action });
}

/** Мероприятие под замком с проверкой прав – начало всех команд над ним. */
export async function lockEvent(tx: Tx, ctx: AccessContext, id: string, action: Action): Promise<EventRow> {
  const e = await getEventRow(tx, id, { forUpdate: true });
  if (!e) throw notFound();
  guardEvent(ctx, e.branch_id, action);
  return e;
}

export function assertRowVersion(row: { row_version: number }, rowVersion: number): void {
  if (row.row_version !== rowVersion) throw new AppError('VERSION_CONFLICT', 409, 'Мероприятие уже изменили – обновите карточку', { current: row.row_version });
}

export function requireReason(value: string | null | undefined, field = 'reason'): string {
  const s = (value ?? '').trim();
  if (s === '') throw new AppError('COMMENT_REQUIRED', 422, 'Укажите причину', { field });
  if (s.length > 2000) throw new AppError('VALIDATION_FAILED', 400, 'Слишком длинный текст', { field });
  return s;
}

export function parseBody<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value ?? {});
  if (!r.success) throw new AppError('VALIDATION_FAILED', 400, 'Неверные данные запроса', { issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  return r.data;
}

// ---- подарки в ответе отмены: таблицу ведёт gifts.ts (S3-57), она сама сообщает свои связи

export type EventGiftsProvider = (db: Db, eventId: string) => Promise<string[]>;
let eventGifts: EventGiftsProvider = async () => [];
export function registerEventGiftsProvider(p: EventGiftsProvider): void {
  eventGifts = p;
}
export const giftsOfEvent = (db: Db, eventId: string): Promise<string[]> => eventGifts(db, eventId);

// ---- ввод

const Uuid = z.string().regex(UUID_RE);
const At = z.iso.datetime({ offset: true }).transform((s) => new Date(s));
const Name = z.string().trim().min(1).max(200);
const Text = z.string().trim().max(4000);
const PartySchema = z.object({ format: z.enum(['h2', 'h3plus', 'full_day']), guests: z.number().int(), catering: z.boolean().default(false) });
const BirthdaySchema = z.object({ clientId: Uuid.nullish(), name: Name.nullish() });

const createSchema = z.object({
  typeId: Uuid,
  branchId: Uuid,
  title: Name.optional(),
  plannedStart: At.nullish(),
  plannedEnd: At.nullish(),
  customer: z.object({ clientId: Uuid.nullish(), name: Name, phone: z.string() }),
  birthdayPerson: BirthdaySchema.optional(),
  participantsCount: z.number().int().positive().nullish(),
  responsibleStaffId: Uuid.nullish(),
  wishes: Text.nullish(),
  packageId: Uuid.nullish(),
  party: PartySchema.nullish(),
});

const updateSchema = z.object({
  rowVersion: z.number().int(),
  title: Name.optional(),
  branchId: Uuid.optional(),
  plannedStart: At.nullish(),
  plannedEnd: At.nullish(),
  customer: z.object({ clientId: Uuid.nullish(), name: Name, phone: z.string().optional() }).optional(),
  birthdayPerson: BirthdaySchema.optional(),
  participantsCount: z.number().int().positive().nullish(),
  responsibleStaffId: Uuid.nullish(),
  wishes: Text.nullish(),
  party: PartySchema.nullish(),
  reason: z.string().max(2000).optional(),
});

const statusSchema = z.object({ rowVersion: z.number().int(), to: z.enum(EVENT_STATUSES), reason: z.string().max(2000).optional() });

function assertPeriod(start: Date | null | undefined, end: Date | null | undefined): void {
  if (start && end && end.getTime() <= start.getTime()) throw new AppError('VALIDATION_FAILED', 400, 'Конец раньше начала', { field: 'plannedEnd' });
}

/** Гости праздника (K20 §4): 1…event.party.max_guests. */
export async function assertPartyGuests(db: Db, branchId: string, guests: number, now: Date): Promise<void> {
  const max = (await resolveSetting(db, 'event.party.max_guests', { branchId }, now)).value;
  if (!Number.isInteger(guests) || guests < 1 || guests > max) throw new AppError('PARTY_GUESTS_LIMIT', 422, `Гостей на празднике – от 1 до ${max}`, { max });
}

async function activeType(db: Db, typeId: string): Promise<{ id: string; code: string; name: string }> {
  const r = await db.query<{ id: string; code: string; name: string }>(`SELECT id, code, name FROM app.event_types WHERE id = $1 AND status = 'active'`, [typeId]);
  if (!r.rows[0]) throw new AppError('VALIDATION_FAILED', 400, 'Тип мероприятия не найден', { field: 'typeId' });
  return r.rows[0];
}

export interface EventActor {
  type: 'staff' | 'client' | 'system';
  id: string | null;
}

export interface NewEventRow {
  typeId: string;
  branch: BranchInfo;
  title: string;
  plannedStart: Date | null;
  plannedEnd: Date | null;
  customer: { clientId: string | null; name: string; phone: string };
  birthdayPerson: { clientId: string | null; name: string | null };
  participantsCount: number | null;
  responsibleStaffId: string | null;
  wishes: string | null;
  packageId: string | null;
  party: PartyInfo | null;
  source: 'crm' | 'site';
  actor: EventActor;
  at: Date;
}

/** Посев чек-листа 11 §6 (10 пунктов). */
const CHECKLIST: ReadonlyArray<readonly [string, string]> = [
  ['date', 'Подтверждение даты и времени'],
  ['composition', 'Подтверждение состава услуг'],
  ['participants', 'Подтверждение количества участников'],
  ['responsible', 'Назначение ответственного сотрудника'],
  ['contractor', 'Подтверждение аниматора или подрядчика'],
  ['catering', 'Заказ кейтеринга'],
  ['room', 'Подготовка комнаты и оборудования'],
  ['purchase', 'Закупка расходных материалов'],
  ['payment', 'Проверка оплаты или предоплаты'],
  ['gift', 'Подготовка подарка имениннику'],
];

/** Строка мероприятия и чек-лист (K20 §2, §5). Номер – из последовательности: дублей при параллельном создании нет. */
export async function insertEvent(tx: Tx, v: NewEventRow): Promise<string> {
  const id = randomUUID();
  await tx.query(
    `INSERT INTO app.events (id, number, type_id, branch_id, title, planned_start, planned_end, customer_client_id, customer_name, customer_phone_e164,
       birthday_client_id, birthday_person_name, participants_count, responsible_staff_id, wishes, package_id, party_format, party_guests, party_catering,
       source, created_by_type, created_by_id, created_at)
     VALUES ($1, 'EV-' || lpad(nextval('app.event_number_seq')::text, 6, '0'), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)`,
    [
      id, v.typeId, v.branch.id, v.title, v.plannedStart, v.plannedEnd, v.customer.clientId, v.customer.name, v.customer.phone,
      v.birthdayPerson.clientId, v.birthdayPerson.name, v.participantsCount, v.responsibleStaffId, v.wishes, v.packageId,
      v.party?.format ?? null, v.party?.guests ?? null, v.party?.catering ?? null, v.source, v.actor.type, v.actor.id, v.at,
    ],
  );
  await tx.query(
    `INSERT INTO app.event_checklist (event_id, code, title, sort_order)
     SELECT $1, x.code, x.title, x.ord FROM unnest($2::text[], $3::text[]) WITH ORDINALITY AS x(code, title, ord)`,
    [id, CHECKLIST.map((c) => c[0]), CHECKLIST.map((c) => c[1])],
  );
  return id;
}

/** Поля для before/after аудита (имя и телефон – под ключами PD_KEYS, маскирует ядро). */
function auditView(r: EventRow): Record<string, unknown> {
  return {
    title: r.title,
    branchId: r.branch_id,
    plannedStart: r.planned_start?.toISOString() ?? null,
    plannedEnd: r.planned_end?.toISOString() ?? null,
    status: r.status,
    customerClientId: r.customer_client_id,
    guestName: r.customer_name,
    guestPhone: r.customer_phone_e164,
    birthdayClientId: r.birthday_client_id,
    participantsCount: r.participants_count,
    responsibleStaffId: r.responsible_staff_id,
    wishes: r.wishes,
    partyFormat: r.party_format,
    partyGuests: r.party_guests,
    partyCatering: r.party_catering,
  };
}

/** K20 §2: без брони и без профиля; профиль клиента по телефону не создаётся. */
export async function createEvent(tx: Tx, ctx: AccessContext, raw: unknown, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<EventDto> {
  const input = parseBody(createSchema, raw);
  const branch = await getBranch(tx, input.branchId);
  if (!branch) throw notFound();
  guardEvent(ctx, branch.id, 'event.manage');
  const type = await activeType(tx, input.typeId);
  assertPeriod(input.plannedStart, input.plannedEnd);
  const now = clock.now();
  const isParty = type.code === 'birthday_party';
  if (input.party && !isParty) throw new AppError('VALIDATION_FAILED', 400, 'Формат праздника – только у платного праздника', { field: 'party' });
  if (input.party) await assertPartyGuests(tx, branch.id, input.party.guests, now);
  if (isParty && input.participantsCount != null) await assertPartyGuests(tx, branch.id, input.participantsCount, now);
  const id = await insertEvent(tx, {
    typeId: type.id,
    branch,
    title: input.title ?? type.name,
    plannedStart: input.plannedStart ?? null,
    plannedEnd: input.plannedEnd ?? null,
    customer: { clientId: input.customer.clientId ?? null, name: input.customer.name, phone: normalizePhone(input.customer.phone) },
    birthdayPerson: { clientId: input.birthdayPerson?.clientId ?? null, name: input.birthdayPerson?.name ?? null },
    participantsCount: input.participantsCount ?? null,
    responsibleStaffId: input.responsibleStaffId ?? null,
    wishes: input.wishes ?? null,
    packageId: input.packageId ?? null,
    party: input.party ?? null,
    source: 'crm',
    actor: { type: 'staff', id: ctx.actor.staffId },
    at: now,
  });
  const row = (await getEventRow(tx, id))!;
  await writeAudit(tx, meta, { action: 'event.created', object: { type: 'event', id }, branchId: branch.id, cityId: branch.cityId, after: auditView(row) }, clock);
  return toEventDto(row);
}

async function activeResourceCount(db: Db, eventId: string): Promise<number> {
  const r = await db.query<{ n: number }>(`SELECT count(*)::int n FROM app.event_resources WHERE event_id = $1 AND status = 'active'`, [eventId]);
  return r.rows[0]!.n;
}

/** Изменение оргданных с историей (11 §7.4). Дата и филиал при занятых ресурсах – только перенос moveEvent (K20 §2). */
export async function updateEvent(tx: Tx, ctx: AccessContext, id: string, raw: unknown, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<EventDto> {
  const input = parseBody(updateSchema, raw);
  const e = await lockEvent(tx, ctx, id, 'event.manage');
  assertRowVersion(e, input.rowVersion);
  if (isClosed(e.status)) throw new AppError('EVENT_CLOSED', 409, 'Мероприятие завершено – правка недоступна', { status: e.status });
  const now = clock.now();
  const start = input.plannedStart !== undefined ? input.plannedStart : e.planned_start;
  const end = input.plannedEnd !== undefined ? input.plannedEnd : e.planned_end;
  assertPeriod(start, end);
  const movesTime = (start?.getTime() ?? null) !== (e.planned_start?.getTime() ?? null) || (end?.getTime() ?? null) !== (e.planned_end?.getTime() ?? null);
  const branchId = input.branchId ?? e.branch_id;
  if (branchId !== e.branch_id || movesTime) {
    if ((await activeResourceCount(tx, e.id)) > 0) throw new AppError('VALIDATION_FAILED', 400, 'Ресурсы заняты: дату и филиал меняет перенос', { reason: 'use_move' });
    if (['confirmed', 'preparing', 'in_progress'].includes(e.status) && (!start || !end)) {
      throw new AppError('EVENT_NOT_READY', 422, 'У подтверждённого мероприятия должны быть дата и время', { fields: ['plannedStart', 'plannedEnd'] });
    }
  }
  if (branchId !== e.branch_id) {
    const target = await getBranch(tx, branchId);
    if (!target) throw notFound();
    guardEvent(ctx, target.id, 'event.manage');
  }
  const party = input.party !== undefined ? input.party : e.party_format ? { format: e.party_format, guests: e.party_guests ?? 0, catering: e.party_catering ?? false } : null;
  if (party && e.type_code !== 'birthday_party') throw new AppError('VALIDATION_FAILED', 400, 'Формат праздника – только у платного праздника', { field: 'party' });
  if (party && input.party !== undefined) await assertPartyGuests(tx, branchId, party.guests, now);
  const participants = input.participantsCount !== undefined ? input.participantsCount : e.participants_count;
  if (e.type_code === 'birthday_party' && participants != null && input.participantsCount !== undefined) await assertPartyGuests(tx, branchId, participants, now);
  const phone = input.customer?.phone !== undefined ? normalizePhone(input.customer.phone) : e.customer_phone_e164;
  await tx.query(
    `UPDATE app.events SET title = $2, branch_id = $3, planned_start = $4, planned_end = $5, customer_client_id = $6, customer_name = $7, customer_phone_e164 = $8,
       birthday_client_id = $9, birthday_person_name = $10, participants_count = $11, responsible_staff_id = $12, wishes = $13, party_format = $14, party_guests = $15,
       party_catering = $16, row_version = row_version + 1 WHERE id = $1`,
    [
      e.id, input.title ?? e.title, branchId, start, end,
      input.customer ? (input.customer.clientId ?? null) : e.customer_client_id,
      input.customer?.name ?? e.customer_name, phone,
      input.birthdayPerson ? (input.birthdayPerson.clientId ?? null) : e.birthday_client_id,
      input.birthdayPerson ? (input.birthdayPerson.name ?? null) : e.birthday_person_name,
      participants, input.responsibleStaffId !== undefined ? input.responsibleStaffId : e.responsible_staff_id,
      input.wishes !== undefined ? input.wishes : e.wishes, party?.format ?? null, party?.guests ?? null, party?.catering ?? null,
    ],
  );
  const row = (await getEventRow(tx, e.id))!;
  const diff = diffFields(auditView(e), auditView(row));
  await writeAudit(tx, meta, { action: 'event.updated', object: { type: 'event', id: e.id }, branchId, before: diff.before, after: diff.after, reason: input.reason?.trim() || null }, clock);
  return toEventDto(row);
}

// ---- статусы (K20 §2, таблица переходов)

const TRANSITIONS: Readonly<Record<EventStatus, readonly EventStatus[]>> = {
  new_request: ['negotiation', 'awaiting_confirmation', 'cancelled'],
  negotiation: ['awaiting_confirmation', 'cancelled'],
  awaiting_confirmation: ['confirmed', 'negotiation', 'cancelled'],
  confirmed: ['preparing', 'in_progress', 'cancelled', 'not_held'],
  preparing: ['in_progress', 'cancelled', 'not_held'],
  in_progress: ['completed'],
  completed: [],
  cancelled: [],
  not_held: [],
};

/** Согласованная стоимость: Σ активных строк quantity × price − discount (11 §7.1), округление до копейки на строку. */
export async function agreedOf(db: Db, eventId: string): Promise<{ agreedKop: number; lines: Array<{ id: string; name: string; totalKop: number }> }> {
  const r = await db.query<{ id: string; name: string; total: string }>(
    `SELECT id, name, round(quantity * price_kop - discount_kop)::bigint AS total FROM app.event_lines WHERE event_id = $1 AND status = 'active' ORDER BY sort_order, id`,
    [eventId],
  );
  const lines = r.rows.map((x) => ({ id: x.id, name: x.name, totalKop: Number(x.total) }));
  return { agreedKop: lines.reduce((a, l) => a + l.totalKop, 0), lines };
}

/** Что мешает подтвердить (11 §4.2): дата и время, состав; у платного праздника – занятая комната (K20 §4). */
async function notReadyFields(db: Db, e: EventRow): Promise<string[]> {
  const fields: string[] = [];
  if (!e.planned_start) fields.push('plannedStart');
  if (!e.planned_end) fields.push('plannedEnd');
  const lines = await db.query(`SELECT 1 FROM app.event_lines WHERE event_id = $1 AND status = 'active' LIMIT 1`, [e.id]);
  if (lines.rowCount !== 1) fields.push('lines');
  if (e.type_code === 'birthday_party' && (await activeResourceCount(db, e.id)) === 0) fields.push('room');
  return fields;
}

export interface NeedsDecision {
  bookingIds: string[];
  giftIds: string[];
}

export interface StatusChangeResult {
  event: EventDto;
  /** Только при отмене и «не состоялось»: связанное система не трогает (11 §10). Деньги добавляет маршрут. */
  needsDecision: NeedsDecision | null;
}

/** Освободить все свои строки занятости (K6 release); соседние ресурсы и чужие брони не задеваются. */
async function releaseAll(tx: Tx, eventId: string, now: Date, clock: Clock): Promise<void> {
  const r = await tx.query<{ id: string }>(`SELECT id FROM app.event_resources WHERE event_id = $1 AND status = 'active' ORDER BY id`, [eventId]);
  for (const { id } of r.rows) {
    await releaseEvent(tx, id, 'cancelled', clock);
    await tx.query(`UPDATE app.event_resources SET status = 'released', released_at = $2, release_reason = 'cancelled' WHERE id = $1`, [id, now]);
  }
}

export async function changeEventStatus(tx: Tx, ctx: AccessContext, id: string, raw: unknown, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<StatusChangeResult> {
  const input = parseBody(statusSchema, raw);
  const e = await lockEvent(tx, ctx, id, 'event.manage');
  assertRowVersion(e, input.rowVersion);
  if (!TRANSITIONS[e.status].includes(input.to)) throw new AppError('EVENT_TRANSITION_INVALID', 409, 'Этот переход недоступен для мероприятия в текущем статусе', { from: e.status, to: input.to });
  const now = clock.now();
  const cancelling = input.to === 'cancelled' || input.to === 'not_held';
  const reason = cancelling ? requireReason(input.reason) : input.reason?.trim() || null;
  if (input.to === 'confirmed') {
    const fields = await notReadyFields(tx, e);
    if (fields.length > 0) throw new AppError('EVENT_NOT_READY', 422, 'Мероприятие нельзя подтвердить: заполнено не всё', { fields });
  }
  let needsDecision: NeedsDecision | null = null;
  if (cancelling) {
    await releaseAll(tx, e.id, now, clock);
    const b = await tx.query<{ booking_id: string }>('SELECT booking_id FROM app.event_bookings WHERE event_id = $1 ORDER BY booking_id', [e.id]);
    needsDecision = { bookingIds: b.rows.map((x) => x.booking_id), giftIds: await giftsOfEvent(tx, e.id) };
    await tx.query(`UPDATE app.events SET status = $2, cancel_reason = $3, cancelled_by = $4, cancelled_at = $5, row_version = row_version + 1 WHERE id = $1`, [e.id, input.to, reason, ctx.actor.staffId, now]);
  } else if (input.to === 'confirmed') {
    const agreed = await agreedOf(tx, e.id);
    await tx.query(`UPDATE app.events SET status = $2, agreed_snapshot = $3, row_version = row_version + 1 WHERE id = $1`, [e.id, input.to, JSON.stringify({ ...agreed, at: now.toISOString() })]);
  } else {
    await tx.query(`UPDATE app.events SET status = $2, row_version = row_version + 1 WHERE id = $1`, [e.id, input.to]);
  }
  await writeAudit(tx, meta, { action: 'event.status_changed', object: { type: 'event', id: e.id }, branchId: e.branch_id, before: { status: e.status }, after: { status: input.to }, reason }, clock);
  const row = (await getEventRow(tx, e.id))!;
  if (input.to === 'confirmed') {
    await publish(tx as OutboxTx, {
      type: 'event.confirmed',
      aggregateType: 'event',
      aggregateId: e.id,
      aggregateVersion: row.row_version,
      branchId: e.branch_id,
      occurredAt: now,
      payload: {
        eventId: e.id, number: e.number, branchId: e.branch_id, branchTimezone: e.timezone, customerClientId: e.customer_client_id,
        plannedStart: e.planned_start!.toISOString(), plannedEnd: e.planned_end!.toISOString(),
      },
    });
  }
  if (cancelling) {
    await publish(tx as OutboxTx, {
      type: 'event.cancelled',
      aggregateType: 'event',
      aggregateId: e.id,
      aggregateVersion: 'cancelled',
      branchId: e.branch_id,
      occurredAt: now,
      payload: { eventId: e.id, branchId: e.branch_id, customerClientId: e.customer_client_id, reason: reason!, linkedBookingIds: needsDecision!.bookingIds, giftIds: needsDecision!.giftIds },
    });
  }
  return { event: toEventDto(row), needsDecision };
}

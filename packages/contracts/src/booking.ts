// K5 (+ K9 «мои записи»): схемы публичного API записи – один источник для сервера (разбор тел и запросов),
// сайта и ЛК (типы ответов) и контракт-теста (ответ проходит схему). Ответы – z.strictObject: лишнее поле
// (например, телефон или имя другого клиента) ломает контракт-тест, а не утекает молча (17 §7.2).
// OpenAPI 3.1 – bookingOpenApi(): JSON Schema из этих же схем (z.toJSONSchema), файл openapi/booking.json
// пересобирается `npm run openapi -w @yu/contracts`; тест сверяет файл с генерацией.
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

const Iso = z.iso.datetime({ offset: true }).describe('ISO 8601 UTC');
const LocalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('YYYY-MM-DD по зоне филиала');
const Uuid = z.uuid();

// ---- ответы

export const CityDto = z.strictObject({ id: Uuid, slug: z.string(), name: z.string(), timezone: z.string() });
export const BranchDto = z.strictObject({
  id: Uuid,
  cityId: Uuid,
  slug: z.string(),
  name: z.string(),
  address: z.string(),
  timezone: z.string(),
  status: z.enum(['active', 'temporarily_closed']),
  phone: z.string().nullable(),
  publicContacts: z.record(z.string(), z.string()),
  bookingWindow: z.strictObject({ defaultDays: z.int(), maxDays: z.int() }),
  holdMinutes: z.int(),
});
export const BranchDetailDto = BranchDto.extend({ hoursToday: z.array(z.strictObject({ start: z.string(), end: z.string() })) });
export const Zone = z.enum(['pc', 'vr', 'ps']);
export const ResourceDto = z.strictObject({
  id: Uuid,
  branchId: Uuid,
  roomId: Uuid.nullable(),
  roomName: z.string().nullable(),
  roomSlug: z.string().regex(/^[a-z0-9-]{1,64}$/).nullable(), // rooms.slug, адрес /{city}/{branch}/rooms/{roomSlug}/
  type: z.enum(['pc', 'vr_seat', 'ps_room', 'room_whole', 'composite']),
  zone: Zone,
  name: z.string(),
  stepMinutes: z.int(),
  selfBookable: z.literal(true),
});
export const SlotState = z.enum(['free', 'mine', 'held', 'booked', 'blocked', 'closed']);
export const SlotDto = z.strictObject({ start: Iso, end: Iso, state: SlotState });
export const AvailabilityDto = z.strictObject({
  branchId: Uuid,
  date: LocalDate,
  timezone: z.string(),
  dayState: z.enum(['open', 'closed', 'outside_window']),
  openIntervals: z.array(z.strictObject({ start: Iso, end: Iso })),
  resources: z.array(z.strictObject({ resourceId: Uuid, slots: z.array(SlotDto) })),
  generatedAt: Iso,
});
export const HoldItemDto = z.strictObject({ id: Uuid, resourceId: Uuid, resourceName: z.string(), start: Iso, end: Iso, priceKop: z.int().nullable() });
export const HoldDto = z.strictObject({
  id: Uuid,
  branchId: Uuid,
  status: z.enum(['active', 'converted', 'expired', 'released']),
  expiresAt: Iso,
  serverNow: Iso,
  items: z.array(HoldItemDto),
  totalKop: z.int().nullable(),
  owner: z.enum(['visitor', 'client']),
});
export const BookingStatus = z.enum(['confirmed', 'arrived', 'completed', 'no_show', 'cancelled_by_client', 'cancelled_by_club']);
export const BookingDto = z.strictObject({
  id: Uuid,
  number: z.int(),
  branchId: Uuid,
  branchName: z.string(),
  branchAddress: z.string(),
  timezone: z.string(),
  resourceId: Uuid,
  resourceName: z.string(),
  start: Iso,
  end: Iso,
  durationMinutes: z.int(),
  priceKop: z.int(),
  paymentNote: z.literal('pay_at_club'),
  status: BookingStatus,
  canCancel: z.boolean(),
});
export const ConfirmResultDto = z.strictObject({ checkoutId: Uuid, bookings: z.array(BookingDto) });
/** K9: запись в ЛК – без служебного комментария (03 §8.3). */
export const MyBookingDto = BookingDto.extend({ cityName: z.string(), roomName: z.string().nullable(), visit: z.strictObject({ arrivedAt: Iso }).nullable() });
export const MyVisitDto = z.strictObject({
  bookingId: Uuid,
  number: z.int(),
  branchName: z.string(),
  resourceName: z.string(),
  plannedStart: Iso,
  plannedEnd: Iso,
  arrivedAt: Iso,
  status: z.literal('visited'),
});
export const ErrorBody = z.strictObject({
  error: z.strictObject({ code: z.string(), message: z.string(), details: z.record(z.string(), z.unknown()).optional(), requestId: z.string() }),
});
const page = <T extends z.ZodType>(item: T) => z.strictObject({ items: z.array(item), nextCursor: z.string().nullable() });
export const MyBookingsPage = page(MyBookingDto);
export const MyVisitsPage = page(MyVisitDto);

// ---- запросы (тела и строки запроса)

export const HoldItemInput = z.strictObject({ resourceId: Uuid, start: Iso, end: Iso });
export const CreateHoldBody = z.strictObject({ branchId: Uuid, items: z.array(HoldItemInput).min(1).max(20) });
export const ConfirmBody = z.strictObject({ comment: z.string().max(500).optional() });
export const CancelBody = z.strictObject({ reason: z.string().max(300).optional() });
export const AvailabilityQuery = z.object({ date: z.string().max(10), resourceIds: z.string().max(50 * 37).optional() });
export const MyBookingsQuery = z.object({ tab: z.enum(['upcoming', 'past', 'cancelled']).default('upcoming'), cursor: z.string().max(512).optional() });
export const MyVisitsQuery = z.object({ cursor: z.string().max(512).optional() });

export type CityDto = z.infer<typeof CityDto>;
export type BranchDto = z.infer<typeof BranchDto>;
export type ResourceDto = z.infer<typeof ResourceDto>;
export type AvailabilityDto = z.infer<typeof AvailabilityDto>;
export type HoldDto = z.infer<typeof HoldDto>;
export type BookingDto = z.infer<typeof BookingDto>;
export type ConfirmResultDto = z.infer<typeof ConfirmResultDto>;
export type MyBookingDto = z.infer<typeof MyBookingDto>;
export type MyVisitDto = z.infer<typeof MyVisitDto>;

// ---- маршруты (K5 №1–13, K9 мои записи) и OpenAPI

export interface RouteContract {
  id: string;
  method: 'get' | 'post' | 'delete';
  path: string; // OpenAPI-стиль: /branches/{branchId}
  summary: string;
  auth: 'none' | 'visitor_or_client' | 'client';
  idempotent?: true;
  query?: z.ZodType;
  body?: z.ZodType;
  success: { status: number; schema: z.ZodType };
  errors: string[];
}

export const BOOKING_ROUTES: RouteContract[] = [
  { id: 'K5-1', method: 'get', path: '/cities', summary: 'Города с публичными филиалами', auth: 'none', success: { status: 200, schema: z.strictObject({ items: z.array(CityDto) }) }, errors: [] },
  { id: 'K5-2', method: 'get', path: '/branches', summary: 'Филиалы (city – slug города)', auth: 'none', query: z.object({ city: z.string().max(64).optional() }), success: { status: 200, schema: z.strictObject({ items: z.array(BranchDto) }) }, errors: ['VALIDATION_FAILED'] },
  { id: 'K5-3', method: 'get', path: '/branches/{branchId}', summary: 'Филиал и часы сегодня', auth: 'none', success: { status: 200, schema: BranchDetailDto }, errors: ['NOT_FOUND'] },
  { id: 'K5-4', method: 'get', path: '/branches/{branchId}/resources', summary: 'Ресурсы филиала', auth: 'none', query: z.object({ zone: Zone.optional() }), success: { status: 200, schema: z.strictObject({ items: z.array(ResourceDto) }) }, errors: ['NOT_FOUND', 'VALIDATION_FAILED'] },
  { id: 'K5-5', method: 'get', path: '/branches/{branchId}/availability', summary: 'Слоты на дату (ставит куку yu_visitor)', auth: 'none', query: AvailabilityQuery, success: { status: 200, schema: AvailabilityDto }, errors: ['NOT_FOUND', 'VALIDATION_FAILED', 'RATE_LIMITED'] },
  { id: 'K5-6', method: 'post', path: '/holds', summary: 'Создать удержание – все позиции или ничего', auth: 'visitor_or_client', idempotent: true, body: CreateHoldBody, success: { status: 201, schema: HoldDto },
    errors: ['VALIDATION_FAILED', 'VISITOR_REQUIRED', 'IDEMPOTENCY_KEY_REQUIRED', 'NOT_FOUND', 'BRANCH_NOT_ACTIVE', 'OUTSIDE_BOOKING_WINDOW', 'OUTSIDE_SCHEDULE', 'INVALID_DURATION', 'RESOURCE_UNAVAILABLE', 'RESOURCE_BLOCKED', 'SLOT_TAKEN', 'SLOT_HELD', 'CLIENT_OVERLAP', 'HOLD_ALREADY_ACTIVE', 'HOLD_LIMIT_REACHED', 'IDEMPOTENCY_KEY_REUSED', 'RATE_LIMITED'] },
  { id: 'K5-7', method: 'get', path: '/holds/{holdId}', summary: 'Удержание владельца', auth: 'visitor_or_client', success: { status: 200, schema: HoldDto }, errors: ['NOT_FOUND', 'RATE_LIMITED'] },
  { id: 'K5-8', method: 'post', path: '/holds/{holdId}/items', summary: 'Добавить слот (таймер перезапускается)', auth: 'visitor_or_client', idempotent: true, body: HoldItemInput, success: { status: 200, schema: HoldDto },
    errors: ['NOT_FOUND', 'HOLD_EXPIRED', 'HOLD_LIMIT_REACHED', 'SLOT_TAKEN', 'SLOT_HELD', 'CLIENT_OVERLAP', 'OUTSIDE_SCHEDULE', 'INVALID_DURATION'] },
  { id: 'K5-9', method: 'delete', path: '/holds/{holdId}/items/{itemId}', summary: 'Убрать слот', auth: 'visitor_or_client', idempotent: true, success: { status: 200, schema: HoldDto }, errors: ['NOT_FOUND', 'HOLD_EXPIRED'] },
  { id: 'K5-10', method: 'post', path: '/holds/{holdId}/release', summary: 'Отпустить удержание', auth: 'visitor_or_client', idempotent: true, success: { status: 200, schema: HoldDto }, errors: ['NOT_FOUND'] },
  { id: 'K5-11', method: 'post', path: '/holds/{holdId}/attach', summary: 'Перенести удержание посетителя к вошедшему клиенту', auth: 'client', idempotent: true, success: { status: 200, schema: HoldDto }, errors: ['AUTH_REQUIRED', 'NOT_FOUND', 'HOLD_EXPIRED', 'HOLD_ALREADY_ACTIVE', 'CLIENT_OVERLAP'] },
  { id: 'K5-12', method: 'post', path: '/holds/{holdId}/confirm', summary: 'Подтвердить удержание – брони', auth: 'client', idempotent: true, body: ConfirmBody, success: { status: 201, schema: ConfirmResultDto },
    errors: ['AUTH_REQUIRED', 'NOT_FOUND', 'HOLD_EXPIRED', 'BRANCH_NOT_ACTIVE', 'OUTSIDE_SCHEDULE', 'RESOURCE_UNAVAILABLE', 'RESOURCE_BLOCKED', 'CLIENT_RESTRICTED', 'COMPOSITE_CHANGED', 'TARIFF_NOT_CONFIGURED', 'TARIFF_AMBIGUOUS'] },
  { id: 'K5-13', method: 'post', path: '/bookings/{bookingId}/cancel', summary: 'Отмена клиентом своей записи (R-12, без денег)', auth: 'client', idempotent: true, body: CancelBody, success: { status: 200, schema: BookingDto }, errors: ['AUTH_REQUIRED', 'NOT_FOUND', 'BOOKING_NOT_CANCELLABLE'] },
  { id: 'K9-bookings', method: 'get', path: '/me/bookings', summary: 'Мои записи: будущие / прошлые / отменённые', auth: 'client', query: MyBookingsQuery, success: { status: 200, schema: MyBookingsPage }, errors: ['AUTH_REQUIRED', 'VALIDATION_FAILED'] },
  { id: 'K9-visits', method: 'get', path: '/me/visits', summary: 'Мои посещения (только фактические)', auth: 'client', query: MyVisitsQuery, success: { status: 200, schema: MyVisitsPage }, errors: ['AUTH_REQUIRED', 'VALIDATION_FAILED'] },
];

const jsonSchema = (s: z.ZodType) => z.toJSONSchema(s, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;

function queryParams(s: z.ZodType | undefined): unknown[] {
  if (!s) return [];
  const js = jsonSchema(s) as { properties?: Record<string, unknown>; required?: string[] };
  return Object.entries(js.properties ?? {}).map(([name, schema]) => ({ name, in: 'query', required: (js.required ?? []).includes(name), schema }));
}

/** OpenAPI 3.1 публичного API записи (база /api/public/v1). */
export function bookingOpenApi(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of BOOKING_ROUTES) {
    const pathParams = [...r.path.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }));
    const headers = r.idempotent ? [{ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', format: 'uuid' } }] : [];
    const op: Record<string, unknown> = {
      operationId: r.id,
      summary: r.summary,
      'x-auth': r.auth,
      parameters: [...pathParams, ...queryParams(r.query), ...headers],
      responses: {
        [String(r.success.status)]: { description: 'Успех', content: { 'application/json': { schema: jsonSchema(r.success.schema) } } },
        default: { description: `Ошибка: ${r.errors.join(', ') || 'INTERNAL'}`, content: { 'application/json': { schema: jsonSchema(ErrorBody) } } },
      },
    };
    if (r.body) op.requestBody = { required: true, content: { 'application/json': { schema: jsonSchema(r.body) } } };
    (paths[r.path] ??= {})[r.method] = op;
  }
  return { openapi: '3.1.0', info: { title: 'Ю-Клуб: публичный API записи (K5)', version: '1' }, servers: [{ url: '/api/public/v1' }], paths };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`${JSON.stringify(bookingOpenApi(), null, 2)}\n`);
}

// K11 №2–12: схемы CRM-маршрутов брони (/api/crm/v1) – календарь филиала, список, карточка с хронологией,
// бронь администратором (K9 CrmCreateBooking), отмена, перенос, приход, завершение, неявка, исправление.
// Сервер – apps/api/src/modules/booking/routes.crm.ts (разбор тел этими схемами), потребитель – apps/crm (S1-22…S1-23).
// Ответы – strictObject: поле сверх контракта (полный телефон, служебное) ломает тест.
import { z } from 'zod';
import { BookingStatus } from '../booking.ts';

const Iso = z.iso.datetime({ offset: true });
const Uuid = z.uuid();
const LocalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const RowVersion = z.int().min(1);

// ---- запросы

export const CalendarQuery = z.object({ from: LocalDate, to: LocalDate, resourceIds: z.string().max(50 * 37).optional() });
export const BookingListQuery = z.object({
  date: LocalDate.optional(),
  status: z.string().max(200).optional(), // через запятую
  needsDecision: z.enum(['true', 'false']).optional(),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const CrmCreateBooking = z.strictObject({
  resourceId: Uuid,
  start: Iso,
  end: Iso,
  client: z.union([
    z.strictObject({ clientId: Uuid }),
    z.strictObject({ phone: z.string().min(5).max(32), firstName: z.string().min(1).max(100), lastName: z.string().max(100).optional() }),
  ]),
  internalComment: z.string().max(1000).optional(),
});
export const CrmCancelBody = z.strictObject({ rowVersion: RowVersion, initiator: z.enum(['club', 'client_by_phone']), reasonId: Uuid, comment: z.string().max(1000) });
export const CrmRescheduleBody = z.strictObject({ rowVersion: RowVersion, resourceId: Uuid, start: Iso, end: Iso, reason: z.string().max(1000) });
export const CrmRowVersionBody = z.strictObject({ rowVersion: RowVersion });
export const CrmNoShowBody = z.strictObject({ rowVersion: RowVersion, reasonId: Uuid.optional() });
export const CrmRevertVisitBody = z.strictObject({ rowVersion: RowVersion, reason: z.string().max(1000) });
export const CrmPatchBooking = z.strictObject({ rowVersion: RowVersion, internalComment: z.string().max(1000).nullable() });

// ---- ответы

export const CrmAction = z.enum(['cancel', 'reschedule', 'arrive', 'complete', 'no_show', 'revert_visit']);
export const CrmBookingRow = z.strictObject({
  id: Uuid,
  number: z.int(),
  status: BookingStatus,
  resourceName: z.string(),
  start: Iso,
  end: Iso,
  client: z.strictObject({ id: Uuid, name: z.string().nullable(), phoneMasked: z.string(), isGuest: z.boolean() }),
  source: z.enum(['site', 'crm']),
  rowVersion: z.int(),
  needsDecision: z.boolean(),
});
export const CrmBooking = CrmBookingRow.extend({
  branchId: Uuid,
  timezone: z.string(),
  resourceId: Uuid,
  currentVersion: z.int(),
  priceKop: z.int(),
  internalComment: z.string().nullable(),
  cancel: z.strictObject({ at: Iso, by: z.string(), reasonName: z.string().nullable(), comment: z.string().nullable() }).nullable(),
  visit: z.strictObject({ arrivedAt: Iso, completedAt: Iso.nullable() }).nullable(),
  versions: z.array(z.strictObject({ version: z.int(), resourceName: z.string(), start: Iso, end: Iso, priceKop: z.int(), createdAt: Iso, reason: z.string().nullable() })),
  allowedActions: z.array(CrmAction),
});
export const AuditEventView = z.strictObject({
  id: z.string(),
  at: Iso,
  action: z.string(),
  actorType: z.string(),
  actorId: z.string().nullable(),
  actorRole: z.string().nullable(),
  before: z.unknown(),
  after: z.unknown(),
  reason: z.string().nullable(),
  result: z.string(),
});
export const CrmBookingCard = CrmBooking.extend({ timeline: z.array(AuditEventView) });
export const CalendarItem = z.strictObject({
  kind: z.enum(['booking', 'hold', 'block']),
  id: Uuid,
  resourceIds: z.array(Uuid),
  start: Iso,
  end: Iso,
  booking: z.strictObject({ number: z.int(), status: BookingStatus, clientName: z.string().nullable(), phoneMasked: z.string(), needsDecision: z.boolean() }).optional(),
  hold: z.strictObject({ expiresAt: Iso }).optional(),
  block: z.strictObject({ reasonName: z.string() }).optional(),
});
export const CalendarDto = z.strictObject({
  branchId: Uuid,
  timezone: z.string(),
  from: LocalDate,
  to: LocalDate,
  openIntervals: z.array(z.strictObject({ start: Iso, end: Iso })),
  resources: z.array(z.strictObject({ id: Uuid, name: z.string(), type: z.string(), roomName: z.string().nullable() })),
  items: z.array(CalendarItem),
});
export const CrmBookingList = z.strictObject({ items: z.array(CrmBookingRow), nextCursor: z.string().nullable() });

export type CrmBookingRow = z.infer<typeof CrmBookingRow>;
export type CrmBooking = z.infer<typeof CrmBooking>;
export type CalendarItem = z.infer<typeof CalendarItem>;
export type CalendarDto = z.infer<typeof CalendarDto>;

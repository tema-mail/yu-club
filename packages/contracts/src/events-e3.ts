// K4 «События этапа 3» (K18 §11, K19 §11, K20 §12): Zod-схемы payload событий Э3 – один источник для
// производителей (shifts, equipment, events), потребителей (начисление зарплаты, подарок, Э4: уведомления и отчёты)
// и тестов. Типы выводятся из схем; реестр EventRegistry ядра (core/outbox.ts) расширяется этим отображением.
// Схемы строгие (z.strictObject): лишнее поле – например, сумма зарплаты или телефон клиента – отвергается, а не
// утекает в outbox (K4 правило 2, K18 §10). Новое событие или поле – правка K4 и этого файла (K4 правило 5).
import { z } from 'zod';

const Uuid = z.uuid();
const Iso = z.iso.datetime({ offset: true });
const LocalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Interval = z.strictObject({ start: Iso, end: Iso });
const ShiftSlot = z.strictObject({ start: Iso, end: Iso, branchId: Uuid });

/** K19 §2 – единый список статусов оборудования (Q-50). */
export const EQUIPMENT_STATUSES = ['in_service', 'reserve', 'diagnostics', 'repair', 'awaiting_parts', 'unavailable', 'written_off', 'lost'] as const;

export const E3_EVENT_SCHEMAS = {
  // K18 §11 – смены и ставки
  'shift.changed': z.strictObject({
    shiftId: Uuid,
    staffId: Uuid,
    branchId: Uuid,
    branchTimezone: z.string().min(1),
    changedBy: Uuid,
    kind: z.enum(['created', 'updated', 'cancelled']),
    before: ShiftSlot.nullable(),
    after: ShiftSlot.nullable(),
    reason: z.string().nullable(),
  }),
  'shift.attendance_changed': z.strictObject({ shiftId: Uuid, staffId: Uuid, branchId: Uuid, localDate: LocalDate, factVersion: z.int().min(1) }),
  'staff.rate_set': z.strictObject({ rateId: Uuid, staffId: Uuid, validFrom: LocalDate, affectedShiftIds: z.array(Uuid) }),
  // K19 §11 – ремонт
  'repair.registered': z.strictObject({
    repairId: Uuid,
    number: z.string().min(1),
    equipmentId: Uuid,
    branchId: Uuid,
    priority: z.enum(['critical', 'high', 'medium', 'low']),
    impact: z.enum(['none', 'partial', 'full']),
    autoBlockId: Uuid.nullable(),
  }),
  'repair.closed': z.strictObject({ repairId: Uuid, branchId: Uuid, finalEquipmentStatus: z.enum(EQUIPMENT_STATUSES), stillBlockedIds: z.array(Uuid) }),
  // K20 §12 – мероприятия и подарок
  'event.confirmed': z.strictObject({
    eventId: Uuid,
    number: z.string().min(1),
    branchId: Uuid,
    branchTimezone: z.string().min(1),
    customerClientId: Uuid.nullable(),
    plannedStart: Iso,
    plannedEnd: Iso,
  }),
  'event.rescheduled': z.strictObject({ eventId: Uuid, branchId: Uuid, customerClientId: Uuid.nullable(), previous: Interval, current: Interval }),
  'event.cancelled': z.strictObject({
    eventId: Uuid,
    branchId: Uuid,
    customerClientId: Uuid.nullable(),
    reason: z.string().min(1),
    linkedBookingIds: z.array(Uuid),
    giftIds: z.array(Uuid),
  }),
  'gift.issued': z.strictObject({ giftId: Uuid, clientId: Uuid, validUntil: LocalDate, issueBranchId: Uuid }),
} as const;

export type E3EventType = keyof typeof E3_EVENT_SCHEMAS;
/** Отображение «тип события → payload» для EventRegistry ядра (core/outbox.ts). */
export type E3EventPayloads = { [T in E3EventType]: z.infer<(typeof E3_EVENT_SCHEMAS)[T]> };

/** Типы агрегатов Э3 (K4 «События этапа 3», S3-08). */
export const E3_AGGREGATE_TYPES = ['shift', 'staff_rate', 'repair', 'event', 'gift'] as const;

/** Проверка payload перед publish и в тестах; неверный – исключение Zod с путём поля. */
export function parseE3Payload<T extends E3EventType>(type: T, payload: unknown): E3EventPayloads[T] {
  return E3_EVENT_SCHEMAS[type].parse(payload) as E3EventPayloads[T];
}

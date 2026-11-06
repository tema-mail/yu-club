// Оборудование и ремонт в CRM (K19): типы ответов API, подписи, время в зоне филиала. Типы повторяют
// apps/api/src/modules/equipment/*: контракт один, подмена мок ↔ бэкенд – только API_URL.
import { ApiError } from './api.ts';
import { inZone, zonedIso, type CrmBookingRow } from './booking.ts';

export type EquipmentStatus = 'in_service' | 'reserve' | 'diagnostics' | 'repair' | 'awaiting_parts' | 'unavailable' | 'written_off' | 'lost';
export type RepairStatus = 'new' | 'diagnostics' | 'awaiting_approval' | 'planned' | 'in_repair' | 'awaiting_parts' | 'done_pending_check' | 'closed' | 'cancelled';
export type RepairPriority = 'critical' | 'high' | 'medium' | 'low';
export type RepairImpact = 'none' | 'partial' | 'full';

export interface AccountDto {
  id: string; platform: 'playstation' | 'meta' | 'other'; displayName: string; equipmentId: string | null; branchId: string; status: 'active' | 'ended';
  boundFrom: string; boundTo: string | null; endReason: string | null; accessHint: string | null; comment: string | null;
}
export interface EquipmentDto {
  id: string; inventoryNumber: string; legacyNumber: string | null; name: string; categoryId: string; manufacturer: string | null; model: string | null; serialNumber: string | null;
  parentId: string | null; purchaseDate: string | null; purchaseCostKop: number | null; commissionedOn: string | null; status: EquipmentStatus; statusReason: string | null;
  placement: { branchId: string; roomId: string | null; unitId: string | null; since: string };
  openRepairsCount: number; warrantyUntil: string | null; lastRepairAt: string | null; comment: string | null; rowVersion: number;
  /** Только с equipment.view.accounts: у Администратора ключа нет вовсе (Q-54). */
  accounts?: AccountDto[];
}
export interface PlacementRow { id: string; branchId: string; roomId: string | null; unitId: string | null; placedAt: string; removedAt: string | null; movedBy: string; reason: string }
export interface WarrantyDto { id: string; kind: 'manufacturer' | 'repair'; equipmentId: string; repairId: string | null; startsOn: string; endsOn: string; terms: string | null; issuer: string | null; attachmentId: string | null; comment: string | null; status: 'active' | 'invalid' }
export interface CategoryDto { id: string; name: string; sortOrder: number; status: 'active' | 'archived' }
export interface ExecutorDto { id: string; kind: 'staff' | 'contractor' | 'service_center' | 'manufacturer'; name: string; phone: string | null; contactPerson: string | null; status: 'active' | 'archived' }
export interface PlaceOption { id: string; name: string; roomId?: string | null }
export interface AttachmentDto {
  id: string; ownerType: string; ownerId: string; docType: string; sha256: string; sizeBytes: number; mimeType: string; originalName: string | null; comment: string | null;
  supersedes: string | null; status: 'active' | 'invalid'; invalidReason: string | null; invalidatedAt: string | null; createdById: string | null; createdAt: string;
}
export interface EventSummary { eventId: string; number: string | null; status: string | null; start: string | null; end: string | null }
export interface BlockProposal {
  target: { type: 'unit' | 'room'; ids: string[] } | null;
  period: { start: string; end: string } | null;
  reasonCode: 'repair'; affectedBookings: CrmBookingRow[]; affectedEvents: EventSummary[]; otherOpenRepairs: string[];
}
export interface RepairDto {
  id: string; number: string; equipmentId: string; branchId: string; roomId: string | null; unitId: string | null; brokenAt: string | null; brokenAtUnknown: boolean; detectedAt: string; registeredAt: string;
  reportedBy: { staffId: string | null; name: string | null }; symptoms: string; priority: RepairPriority; impact: RepairImpact; status: RepairStatus;
  diagnostics: string | null; cause: string | null; worksDone: string | null; partsUsed: string | null; conclusion: string | null;
  plan: { works: string | null; start: string | null; end: string | null; costKop: number | null; responsibleStaffId: string | null; partsNeeded: boolean; comment: string | null };
  executor: { id: string | null; snapshot: { kind: string; name: string; phone: string | null; contactPerson: string | null } | null };
  approval: { required: boolean; approvedBy: string | null; approvedAt: string | null };
  actualCostKop: number | null; noCost: boolean; completedAt: string | null; finalEquipmentStatus: EquipmentStatus | null; acceptedBy: string | null; previousRepairId: string | null;
  blocks: Array<{ blockId: string; active: boolean; period: { start: string; end: string }; liftedAt: string | null }>;
  payment: { paidKop: number; status: 'unpaid' | 'partially_paid' | 'paid' | 'overpaid' | 'no_cost'; lastPaidAt: string | null; operationIds: string[] };
  rowVersion: number;
}
export interface RepairTimelineEvent { id: string; at: string; action: string; actorType: string; actorId: string | null; before: unknown; after: unknown; reason: string | null }
export interface RepairCardDto extends RepairDto { downtime: { minutes: number; hasBlocks: boolean }; timeline: RepairTimelineEvent[] }

export const EQUIPMENT_STATUS: Record<EquipmentStatus, string> = {
  in_service: 'В эксплуатации', reserve: 'В резерве', diagnostics: 'На диагностике', repair: 'В ремонте', awaiting_parts: 'Ожидает запчастей', unavailable: 'Временно недоступно', written_off: 'Списано', lost: 'Утеряно',
};
export const EQUIPMENT_BADGE: Record<EquipmentStatus, string> = {
  in_service: 'active', reserve: 'preparing', diagnostics: 'temporarily_closed', repair: 'temporarily_closed', awaiting_parts: 'temporarily_closed', unavailable: 'temporarily_closed', written_off: 'archived', lost: 'archived',
};
export const REPAIR_STATUS: Record<RepairStatus, string> = {
  new: 'Новый', diagnostics: 'Диагностика', awaiting_approval: 'Ждёт согласования', planned: 'Запланирован', in_repair: 'В ремонте', awaiting_parts: 'Ждёт запчасти', done_pending_check: 'На проверке', closed: 'Закрыт', cancelled: 'Отменён',
};
export const REPAIR_BADGE: Record<RepairStatus, string> = {
  new: 'preparing', diagnostics: 'temporarily_closed', awaiting_approval: 'temporarily_closed', planned: 'preparing', in_repair: 'temporarily_closed', awaiting_parts: 'temporarily_closed', done_pending_check: 'preparing', closed: 'active', cancelled: 'archived',
};
export const PRIORITY: Record<RepairPriority, string> = { critical: 'Критический', high: 'Высокий', medium: 'Средний', low: 'Низкий' };
export const IMPACT: Record<RepairImpact, string> = { none: 'Не влияет на работу', partial: 'Частично мешает', full: 'Ресурс не работает' };
export const PAYMENT: Record<RepairDto['payment']['status'], string> = { unpaid: 'Не оплачен', partially_paid: 'Оплачен частично', paid: 'Оплачен', overpaid: 'Переплата', no_cost: 'Без затрат' };
export const DOC_TYPE: Record<string, string> = { photo: 'Фото', receipt: 'Квитанция', check: 'Чек', invoice: 'Счёт', act: 'Акт', warranty_card: 'Гарантийный талон', waybill: 'Накладная', service_report: 'Сервисный отчёт', other: 'Другое' };
export const PLATFORM: Record<AccountDto['platform'], string> = { playstation: 'PlayStation', meta: 'Meta (VR)', other: 'Другая' };
export const EXECUTOR_KIND: Record<ExecutorDto['kind'], string> = { staff: 'Сотрудник', contractor: 'Подрядчик', service_center: 'Сервисный центр', manufacturer: 'Производитель' };
/** Переходы K19 §6 (planned и diagnostics из согласования – только решением Владельца, closed – только закрытием). */
export const REPAIR_NEXT: Record<RepairStatus, RepairStatus[]> = {
  new: ['diagnostics', 'planned', 'in_repair', 'cancelled'], diagnostics: ['awaiting_approval', 'planned', 'in_repair', 'done_pending_check', 'cancelled'], awaiting_approval: ['cancelled'],
  planned: ['in_repair', 'awaiting_parts', 'cancelled'], in_repair: ['awaiting_parts', 'done_pending_check'], awaiting_parts: ['in_repair', 'cancelled'], done_pending_check: ['in_repair'], closed: [], cancelled: [],
};
/** Коды полей из REPAIR_CLOSE_INCOMPLETE (repair-close.ts). */
export const CLOSE_FIELD: Record<string, string> = { worksDone: 'выполненные работы', completedAt: 'дата завершения', finalEquipmentStatus: 'итоговый статус', actualCostKop: 'сумма', noCost: 'отметка «без затрат»', costComment: 'комментарий к «без затрат»', executorId: 'исполнитель' };

export const isOpenRepair = (r: Pick<RepairDto, 'status'>) => r.status !== 'closed' && r.status !== 'cancelled';
/** Просрочен план: открыт, и конец плана раньше сегодняшней даты филиала (как planOverdue у №341). */
export const isPlanOverdue = (r: RepairDto, timezone: string) => isOpenRepair(r) && !!r.plan.end && r.plan.end < inZone(Date.now(), timezone).date;

export const ruDate = (d: string | null | undefined) => (d ? d.split('-').reverse().join('.') : '–');
export const fmtAt = (iso: string | null | undefined, timezone: string) => (iso ? new Intl.DateTimeFormat('ru-RU', { timeZone: timezone, dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso)) : '–');
/** Значение поля datetime-local во времени филиала и обратно: сервер получает момент с зоной. */
export const toLocalInput = (iso: string | number, timezone: string) => {
  const z = inZone(iso, timezone);
  return `${z.date}T${z.hm}`;
};
export const fromLocalInput = (value: string, timezone: string) => zonedIso(value.slice(0, 10), value.slice(11, 16), timezone);

export function errorText(e: unknown): string {
  if (!(e instanceof ApiError)) return 'Не удалось выполнить. Повторите.';
  if (e.code === 'FORBIDDEN') return 'Недостаточно прав.';
  if (e.code === 'VERSION_CONFLICT') return 'Запись уже изменили – данные обновлены, проверьте и повторите.';
  if (e.status === 404) return 'Запись не найдена или недоступна.';
  return e.message;
}

// Мероприятия в CRM (S3-81…S3-85): типы ответов – строго по apps/api/src/modules/events/*.ts (K20), подписи, деньги и
// количество без дробной арифметики, время – в зоне филиала (K8), понятные тексты ошибок по кодам сервера.
import { ApiError, browserCall } from './api.ts';
import { addDays, inZone, zonedIso } from './booking.ts';

export type EventStatus = 'new_request' | 'negotiation' | 'awaiting_confirmation' | 'confirmed' | 'preparing' | 'in_progress' | 'completed' | 'cancelled' | 'not_held';
export type PartyFormat = 'h2' | 'h3plus' | 'full_day';
export type LineKind = 'service' | 'goods' | 'room_rent' | 'game_time' | 'animator' | 'catering' | 'decor' | 'activity' | 'other';

/** Полная сводка 11 §11.3 – только с event.money.view; иначе сервер отдаёт один dueKop. */
export interface MoneySummary {
  agreedKop: number; receivedKop: number; refundedKop: number; dueKop: number; planCostKop: number; factCostKop: number;
  resultKop: number; deviationKop: number; discountsKop: number; giftsIssued: number;
}
export type EventMoney = MoneySummary | { dueKop: number };
export const fullMoney = (m: EventMoney): m is MoneySummary => 'agreedKop' in m;

export interface EventDto {
  id: string; number: string; typeId: string; typeCode: string; title: string; branchId: string; timezone: string;
  plannedStart: string | null; plannedEnd: string | null; status: EventStatus;
  customer: { clientId: string | null; name: string; phoneMasked: string };
  birthdayPerson: { clientId: string | null; name: string | null };
  participantsCount: number | null; responsibleStaffId: string | null; wishes: string | null; packageId: string | null;
  party: { format: PartyFormat; guests: number; catering: boolean } | null;
  source: 'crm' | 'site'; cancel: { reason: string; by: string | null; at: string } | null; rowVersion: number;
}
export interface EventRow extends EventDto { money: EventMoney; requestHoldRemind: boolean }
export interface EventLine {
  id: string; eventId: string; kind: LineKind; name: string; quantity: number; unit: string; priceKop: number; discountKop: number; discountReason: string | null;
  /** Нет без event.money.view. */
  planCostKop?: number | null;
  supplier: string | null; comment: string | null; status: 'active' | 'removed'; removedReason: string | null; rowVersion: number;
}
export interface EventResource {
  id: string; eventId: string; resourceId: string; resourceName: string; resourceType: string; start: string; end: string; unitIds: string[];
  status: 'active' | 'released'; releaseReason: string | null; requestHold: { expiresAt: string; remind: boolean } | null;
}
export interface ChecklistItem {
  id: string; code: string | null; title: string; status: 'todo' | 'done' | 'not_needed'; responsibleStaffId: string | null; comment: string | null;
  updatedBy: string | null; updatedAt: string | null; dueKop?: number;
}
export interface TimelineItem {
  id: string; at: string; action: string; actorType: string; actorId: string | null; actorRole: string | null; reason: string | null; result: string;
  /** Нет без event.money.view. */
  before?: Record<string, unknown> | null; after?: Record<string, unknown> | null;
}
export interface EventCardDto extends EventDto {
  money: EventMoney; lines: EventLine[]; resources: EventResource[]; checklist: ChecklistItem[]; bookingIds: string[]; timeline: TimelineItem[];
}
export interface EventType { id: string; code: string; name: string; status: 'active' | 'archived'; rowVersion: number }
export interface PackageLine { kind: LineKind; name: string; quantity: number; unit: string; priceKop: number; planCostKop?: number | null; supplier?: string | null; comment?: string | null }
export interface EventPackage { id: string; typeId: string; name: string; lines: PackageLine[]; approxPriceKop: number | null; status: 'active' | 'archived'; rowVersion: number }

export type GiftStatus = 'issued' | 'reserved' | 'used' | 'expired' | 'cancelled';
export interface GiftTerms { devices: number; device: string; minutesEach: number; roomMinutes: number; weekdays: number[]; excludesHolidays: boolean; notIncluded: string[] }
export interface Gift {
  id: string; number: string; clientId: string; basisEventId: string | null; issuedOn: string; validUntil: string; issueBranchId: string; timezone: string;
  terms: GiftTerms; status: GiftStatus; bookingId: string | null; cancelReason: string | null; rowVersion: number;
}
export interface Holiday { id: string; scope: 'network' | 'city'; cityId: string | null; date: string; name: string; status: 'active' | 'cancelled' }

export const EVENT_STATUS: Record<EventStatus, string> = {
  new_request: 'Новая заявка', negotiation: 'Согласование', awaiting_confirmation: 'Ожидает подтверждения', confirmed: 'Подтверждено', preparing: 'Подготовка',
  in_progress: 'Идёт', completed: 'Завершено', cancelled: 'Отменено', not_held: 'Не состоялось',
};
export const EVENT_BADGE: Record<EventStatus, string> = {
  new_request: 'preparing', negotiation: 'preparing', awaiting_confirmation: 'preparing', confirmed: 'active', preparing: 'active', in_progress: 'active',
  completed: 'archived', cancelled: 'temporarily_closed', not_held: 'temporarily_closed',
};
/** Таблица переходов K20 §2: сервер решает окончательно, здесь – чтобы не предлагать лишнего. */
export const TRANSITIONS: Record<EventStatus, EventStatus[]> = {
  new_request: ['negotiation', 'awaiting_confirmation', 'cancelled'],
  negotiation: ['awaiting_confirmation', 'cancelled'],
  awaiting_confirmation: ['confirmed', 'negotiation', 'cancelled'],
  confirmed: ['preparing', 'in_progress', 'cancelled', 'not_held'],
  preparing: ['in_progress', 'cancelled', 'not_held'],
  in_progress: ['completed'],
  completed: [], cancelled: [], not_held: [],
};
export const isClosed = (s: EventStatus) => s === 'completed' || s === 'cancelled' || s === 'not_held';
export const PARTY_FORMAT: Record<PartyFormat, string> = { h2: '2 часа', h3plus: '3 часа и больше', full_day: 'Весь день' };
export const LINE_KIND: Record<LineKind, string> = {
  service: 'Услуга', goods: 'Товар', room_rent: 'Аренда комнаты', game_time: 'Игровое время', animator: 'Аниматор', catering: 'Кейтеринг', decor: 'Оформление', activity: 'Активность', other: 'Прочее',
};
export const GIFT_STATUS: Record<GiftStatus, string> = { issued: 'Выдан', reserved: 'Есть запись', used: 'Использован', expired: 'Истёк', cancelled: 'Отменён' };
export const GIFT_BADGE: Record<GiftStatus, string> = { issued: 'active', reserved: 'preparing', used: 'archived', expired: 'archived', cancelled: 'temporarily_closed' };
export const CHECK_STATUS: Record<ChecklistItem['status'], string> = { todo: 'Нужно сделать', done: 'Сделано', not_needed: 'Не нужно' };
export const NOT_READY_FIELD: Record<string, string> = { plannedStart: 'дата и время начала', plannedEnd: 'дата и время конца', lines: 'состав услуг', room: 'занятая комната' };

// ---- деньги и количество: только целые числа

/** «1 234,5» → 123450 копеек; ноль допустим (строка состава может быть бесплатной); мусор, минус и третий знак – null. */
export function kopOf(input: string): number | null {
  const t = input.replace(/\s/g, '').replace(',', '.');
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(t);
  return m ? Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0')) : null;
}
/** Копейки → «1234,50» для поля ввода: без деления с плавающей точкой. */
export function kopText(kop: number): string {
  const r = Math.trunc(kop / 100);
  return `${r},${String(kop - r * 100).padStart(2, '0')}`;
}
/** Количество «1,5» → сотые (150); не положительное, третий знак – null. */
export function hundredthsOf(input: string): number | null {
  const m = /^(\d{1,8})(?:\.(\d{1,2}))?$/.exec(input.replace(/\s/g, '').replace(',', '.'));
  if (!m) return null;
  const v = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return v > 0 ? v : null;
}
/** Сумма строки как у сервера (agreedOf): round(количество × цена − скидка) на сотых, без дробной арифметики. */
export function lineTotalKop(hundredths: number, priceKop: number, discountKop: number): number {
  const x = BigInt(hundredths) * BigInt(priceKop) - BigInt(discountKop) * 100n;
  const neg = x < 0n;
  const abs = neg ? -x : x;
  const out = Number((abs + 50n) / 100n);
  return neg ? -out : out;
}
export const lineTotal = (l: Pick<EventLine, 'quantity' | 'priceKop' | 'discountKop'>) => lineTotalKop(Math.round(l.quantity * 100), l.priceKop, l.discountKop);
export const qtyText = (q: number) => String(q).replace('.', ',');

// ---- время: зона филиала

export const atText = (iso: string | null, tz: string) => (iso ? new Intl.DateTimeFormat('ru-RU', { timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)) : 'не задано');
export function periodText(start: string | null, end: string | null, tz: string): string {
  if (!start) return 'Дата не задана';
  const s = inZone(start, tz);
  const date = s.date.split('-').reverse().join('.');
  if (!end) return `${date}, с ${s.hm}`;
  const e = inZone(end, tz);
  return e.date === s.date ? `${date}, ${s.hm}–${e.hm}` : `${date} ${s.hm} – ${e.date.split('-').reverse().join('.')} ${e.hm}`;
}
export const dayText = (d: string) => d.split('-').reverse().join('.');
/** Значения полей даты и времени (зона филиала) → момент ISO; пустая дата или время – null. */
export const toIso = (date: string, hm: string, tz: string) => (date && hm ? zonedIso(date, hm, tz) : null);
export const WEEKDAY = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
export const weekdayOf = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();

// ---- мероприятия в календаре филиала (S3-83): занятость из карточек, API календаря их не отдаёт

export interface CalendarEventItem { id: string; number: string; title: string; status: EventStatus; start: string; end: string; resourceIds: string[] }

/** Активные ресурсы мероприятий, начинающихся в периоде → строки календаря: дорожка показывается, если её единицы пересекают занятые. */
export async function loadCalendarEvents(branchId: string, from: string, to: string, tz: string, laneIds: string[]): Promise<CalendarEventItem[]> {
  const q = new URLSearchParams({ branchId, from: zonedIso(from, '00:00', tz), to: zonedIso(addDays(to, 1), '00:00', tz), limit: '200' });
  const list = await browserCall<{ items: EventDto[] }>(`/events?${q}`);
  const live = list.items.filter((e) => e.status !== 'cancelled' && e.status !== 'not_held');
  if (live.length === 0) return [];
  const lanes = await Promise.all(laneIds.map((id) => browserCall<{ id: string; unitIds?: string[] }>(`/resources/${encodeURIComponent(id)}`).catch(() => ({ id, unitIds: [] as string[] }))));
  const out: CalendarEventItem[] = [];
  for (const e of live) {
    const card = await browserCall<EventCardDto>(`/events/${e.id}`);
    for (const r of card.resources.filter((x) => x.status === 'active')) {
      const hit = lanes.filter((l) => l.id === r.resourceId || (l.unitIds ?? []).some((u) => r.unitIds.includes(u))).map((l) => l.id);
      if (hit.length > 0) out.push({ id: e.id, number: e.number, title: e.title, status: e.status, start: r.start, end: r.end, resourceIds: hit });
    }
  }
  return out;
}

// ---- ошибки

const TEXT: Record<string, string> = {
  FORBIDDEN: 'Недостаточно прав для этого действия.',
  NOT_FOUND: 'Не найдено: запись изменилась или вне вашей зоны.',
  VERSION_CONFLICT: 'Запись уже изменили – данные обновлены, проверьте и повторите.',
  EVENT_CLOSED: 'Мероприятие завершено – эта правка недоступна.',
  EVENT_TRANSITION_INVALID: 'Этот переход недоступен: статус уже изменился. Обновите карточку.',
  EVENT_MOVE_RESOURCES_INVALID: 'Перенос должен двигать все занятые ресурсы и держать их внутри новых дат. Прежнее время осталось – проверьте ресурсы и повторите.',
  SLOT_TAKEN: 'Это время занято другой бронью или мероприятием. Прежнее время сохранено.',
  SLOT_HELD: 'Это время сейчас оформляется на сайте. Выберите другое.',
  RESOURCE_BLOCKED: 'Ресурс заблокирован на это время.',
  OUTSIDE_SCHEDULE: 'В это время филиал не работает.',
  OPERATION_ALREADY_LINKED: 'Этот расход уже учтён – привязать его второй раз нельзя.',
  OPERATION_LINK_INVALID: 'Эту операцию нельзя привязать к мероприятию.',
  OPERATION_REVERSED: 'Поступление уже сторнировано – возврат невозможен.',
  INCOME_HAS_REFUNDS: 'По поступлению есть возвраты: сначала сторно возвратов.',
  EVENT_REFUND_EXCEEDS_INCOME: 'Сумма больше, чем осталось по этому поступлению.',
  CASH_INSUFFICIENT: 'Недостаточно денег в кассе.',
  CASH_SHIFT_REQUIRED: 'Наличные – только в открытой кассовой смене. Откройте смену в «Финансах».',
  PERIOD_CLOSED: 'Месяц закрыт – операцию этой датой внести нельзя.',
  SUBCATEGORY_REQUIRED: 'Выберите подкатегорию.',
  GIFT_ALREADY_ISSUED: 'Этому клиенту подарок уже выдан в этом году.',
  GIFT_BASIS_INVALID: 'Выдача только за день рождения этого клиента, когда мероприятие идёт или завершено.',
  GIFT_NOT_ACTIVE: 'Подарок уже не активен.',
  GIFT_ALREADY_RESERVED: 'По подарку уже есть запись.',
  GIFT_CLIENT_MISMATCH: 'Записать можно только самого именинника.',
};
export function eventError(e: unknown): string {
  if (!(e instanceof ApiError)) return 'Не удалось сохранить. Повторите.';
  if (e.code === 'EVENT_NOT_READY') {
    const fields = (e.details?.fields as string[] | undefined) ?? [];
    return `Подтвердить нельзя: не хватает – ${fields.map((f) => NOT_READY_FIELD[f] ?? f).join(', ')}.`;
  }
  return TEXT[e.code] ?? e.message;
}

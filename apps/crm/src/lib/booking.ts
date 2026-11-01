// Брони в CRM (S1-22, S1-23): типы – из packages/contracts/src/crm/booking.ts (K11 №2–12), вызовы API из браузера,
// время в зоне филиала (не браузера) и понятные администратору тексты ошибок по кодам сервера.
import type { z } from 'zod';
import type { AuditEventView, CalendarDto, CalendarItem, CrmAction, CrmBooking, CrmBookingRow } from '../../../../packages/contracts/src/crm/booking.ts';
import { ApiError, browserCall } from './api.ts';

export type { CalendarDto, CalendarItem, CrmBooking, CrmBookingRow };
export type BookingAction = z.infer<typeof CrmAction>;
export type TimelineEvent = z.infer<typeof AuditEventView>;
export type BookingCard = CrmBooking & { timeline: TimelineEvent[] };
export type BookingStatus = CrmBooking['status'];
export interface BookingPage { items: CrmBookingRow[]; nextCursor: string | null }

export const STATUS_LABEL: Record<BookingStatus, string> = {
  confirmed: 'Подтверждена',
  arrived: 'Пришёл',
  completed: 'Завершена',
  no_show: 'Неявка',
  cancelled_by_client: 'Отменена клиентом',
  cancelled_by_club: 'Отменена клубом',
};

/** Длина периода календаря – как MAX_DAYS сервера (RANGE_TOO_LONG). */
export const MAX_DAYS = 7;

// ---- время в зоне филиала

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const isLocalDate = (s: string | null | undefined): s is string => !!s && DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
export const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

const partsCache = new Map<string, Intl.DateTimeFormat>();
function partsFmt(tz: string): Intl.DateTimeFormat {
  let f = partsCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    partsCache.set(tz, f);
  }
  return f;
}

/** Мгновение → дата и время в зоне филиала. */
export function inZone(at: string | number | Date, tz: string): { date: string; hm: string; minutes: number } {
  const p = Object.fromEntries(partsFmt(tz).formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  const hm = `${p.hour}:${p.minute}`;
  return { date: `${p.year}-${p.month}-${p.day}`, hm, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

/** Дата + «ЧЧ:ММ» в зоне филиала → мгновение (мс). Смещение зоны берём на это же мгновение (две итерации – переходы). */
export function zonedMs(date: string, hm: string, tz: string): number {
  const naive = Date.parse(`${date}T${hm}:00Z`);
  let guess = naive;
  for (let i = 0; i < 2; i++) {
    const z = inZone(guess, tz);
    const shown = Date.parse(`${z.date}T${z.hm}:00Z`);
    guess -= shown - naive;
  }
  return guess;
}
export const zonedIso = (date: string, hm: string, tz: string) => new Date(zonedMs(date, hm, tz)).toISOString();
export const today = (tz: string) => inZone(Date.now(), tz).date;
export const hmOf = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

export function fmtDay(date: string, style: 'short' | 'long' = 'short'): string {
  const d = new Date(`${date}T12:00:00Z`);
  return new Intl.DateTimeFormat('ru-RU', style === 'long'
    ? { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }
    : { weekday: 'short', day: 'numeric', month: 'numeric', timeZone: 'UTC' }).format(d);
}
/** «03.11, 12:00–13:30» в зоне филиала; другой день конца – с датой. */
export function fmtRange(start: string, end: string, tz: string, withDate = true): string {
  const s = inZone(start, tz);
  const e = inZone(end, tz);
  const day = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;
  const tail = e.date === s.date || (e.hm === '00:00' && e.date === addDays(s.date, 1)) ? (e.hm === '00:00' ? '24:00' : e.hm) : `${day(e.date)} ${e.hm}`;
  return `${withDate ? `${day(s.date)}, ` : ''}${s.hm}–${tail}`;
}
export const fmtRub = (kop: number) => `${(kop / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽`;

// ---- ошибки

const FRIENDLY: Record<string, string> = {
  SLOT_TAKEN: 'Это время уже занято другой записью. Выберите другое время или место.',
  SLOT_HELD: 'Это время сейчас оформляет гость на сайте. Выберите другое время или повторите через несколько минут.',
  CLIENT_OVERLAP: 'У клиента уже есть запись на это время (в любом филиале сети).',
  RESOURCE_BLOCKED: 'Место заблокировано на это время (ремонт или обслуживание).',
  RESOURCE_UNAVAILABLE: 'Это место сейчас недоступно для записи.',
  OUTSIDE_SCHEDULE: 'В это время филиал или место не работает.',
  BRANCH_NOT_ACTIVE: 'Филиал сейчас не принимает записи.',
  CLIENT_RESTRICTED: 'Запись для этого клиента ограничена – проверьте его карточку.',
  VERSION_CONFLICT: 'Запись уже изменил другой сотрудник. Карточка обновлена – проверьте данные и повторите действие.',
  COMMENT_REQUIRED: 'Укажите комментарий – без него действие не выполнить.',
  RANGE_TOO_LONG: `Календарь показывает не больше ${MAX_DAYS} дней.`,
  NETWORK: 'Сервер недоступен. Проверьте связь и повторите.',
  NOT_FOUND: 'Запись не найдена или вне вашей зоны доступа.',
  FORBIDDEN: 'Недостаточно прав для этого действия.',
};
export function bookingError(e: unknown): string {
  if (!(e instanceof ApiError)) return 'Неизвестная ошибка. Повторите.';
  return FRIENDLY[e.code] ?? e.message;
}
export const isConflict = (e: unknown) => e instanceof ApiError && e.code === 'VERSION_CONFLICT';

// ---- API (браузер → /api/crm/v1, ключ идемпотентности ставит browserCall)

const enc = encodeURIComponent;
export interface CreateBody {
  resourceId: string; start: string; end: string;
  client: { clientId: string } | { phone: string; firstName: string; lastName?: string };
  internalComment?: string;
}
export const bookingApi = {
  calendar: (branchId: string, from: string, to: string) => browserCall<CalendarDto>(`/branches/${enc(branchId)}/calendar?from=${from}&to=${to}`),
  card: (id: string) => browserCall<BookingCard>(`/bookings/${enc(id)}`),
  create: (branchId: string, body: CreateBody) => browserCall<CrmBooking>(`/branches/${enc(branchId)}/bookings`, { method: 'POST', body }),
  cancel: (id: string, body: { rowVersion: number; initiator: 'club' | 'client_by_phone'; reasonId: string; comment: string }) =>
    browserCall<CrmBooking>(`/bookings/${enc(id)}/cancel`, { method: 'POST', body }),
  reschedule: (id: string, body: { rowVersion: number; resourceId: string; start: string; end: string; reason: string }) =>
    browserCall<CrmBooking>(`/bookings/${enc(id)}/reschedule`, { method: 'POST', body }),
  arrive: (id: string, rowVersion: number) => browserCall<CrmBooking>(`/bookings/${enc(id)}/arrive`, { method: 'POST', body: { rowVersion } }),
  complete: (id: string, rowVersion: number) => browserCall<CrmBooking>(`/bookings/${enc(id)}/complete`, { method: 'POST', body: { rowVersion } }),
  noShow: (id: string, rowVersion: number, reasonId?: string) =>
    browserCall<CrmBooking>(`/bookings/${enc(id)}/no-show`, { method: 'POST', body: reasonId ? { rowVersion, reasonId } : { rowVersion } }),
  revertVisit: (id: string, rowVersion: number, reason: string) => browserCall<CrmBooking>(`/bookings/${enc(id)}/revert-visit`, { method: 'POST', body: { rowVersion, reason } }),
  comment: (id: string, rowVersion: number, internalComment: string | null) => browserCall<CrmBooking>(`/bookings/${enc(id)}`, { method: 'PATCH', body: { rowVersion, internalComment } }),
};

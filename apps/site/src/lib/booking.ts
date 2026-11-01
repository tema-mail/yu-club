// Запись из браузера (S1-19, S1-20): клиент API доступности и удержаний – точно по apps/api/src/modules/booking/routes.public.ts
// (K5 №5–12: availability, holds, items, release, attach, confirm), тексты 12 состояний tz/01 §15.1 и фразы на коды ошибок.
// Таймер удержания – от серверного времени: остаток = expiresAt − serverNow из ответа, дальше отсчёт по performance.now()
// (монотонные часы), часы браузера (Date) в расчёт не входят. Изменяющие запросы – с Idempotency-Key и X-Requested-With.
import { API_PREFIX } from './api.ts';
import { ClientApiError } from './client.ts';

export type SlotState = 'free' | 'mine' | 'held' | 'booked' | 'blocked' | 'closed';
export interface SlotDto { start: string; end: string; state: SlotState }
export interface AvailabilityDto {
  branchId: string; date: string; timezone: string;
  dayState: 'open' | 'closed' | 'outside_window';
  openIntervals: Array<{ start: string; end: string }>;
  resources: Array<{ resourceId: string; slots: SlotDto[] }>;
  generatedAt: string;
}
export interface HoldItemDto { id: string; resourceId: string; resourceName: string; start: string; end: string; priceKop: number | null }
export interface HoldDto {
  id: string; branchId: string;
  status: 'active' | 'converted' | 'expired' | 'released';
  expiresAt: string; serverNow: string;
  items: HoldItemDto[]; totalKop: number | null;
  owner: 'visitor' | 'client';
}
export interface BookingDto {
  id: string; number: number; branchId: string; branchName: string; branchAddress: string; timezone: string;
  resourceId: string; resourceName: string; start: string; end: string; durationMinutes: number;
  priceKop: number; paymentNote: 'pay_at_club'; status: string; canCancel: boolean;
}
export interface ConfirmResultDto { checkoutId: string; bookings: BookingDto[] }
export interface HoldItemInput { resourceId: string; start: string; end: string }

async function call<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (method !== 'GET') {
    headers['x-requested-with'] = 'yu-site';
    headers['idempotency-key'] = idempotencyKey ?? crypto.randomUUID();
    headers['content-type'] = 'application/json';
  }
  // Слеш перед запросом – из-за trailingSlash: 'always' сайта; прокси его не передаёт (как browserCall).
  const q = path.indexOf('?');
  const url = q < 0 ? `${path}/` : `${path.slice(0, q)}/${path.slice(q)}`;
  let res: Response;
  try {
    res = await fetch(`${API_PREFIX}${url}`, {
      method, headers, credentials: 'same-origin',
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
  } catch {
    throw new ClientApiError(0, 'NETWORK', '');
  }
  if (!res.ok) {
    let b: { error?: { code?: string; message?: string; details?: Record<string, unknown> } } = {};
    try {
      b = (await res.json()) as typeof b;
    } catch {
      // тело не JSON – общий код ниже
    }
    const retry = Number(res.headers.get('retry-after'));
    throw new ClientApiError(res.status, b.error?.code ?? 'INTERNAL', b.error?.message ?? '', b.error?.details ?? {}, Number.isFinite(retry) && retry > 0 ? retry : null);
  }
  return (await res.json()) as T;
}

const enc = encodeURIComponent;
export const bookingApi = {
  availability: (branchId: string, date: string) => call<AvailabilityDto>('GET', `/branches/${enc(branchId)}/availability?date=${enc(date)}`),
  getHold: (holdId: string) => call<HoldDto>('GET', `/holds/${enc(holdId)}`),
  createHold: (branchId: string, item: HoldItemInput) => call<HoldDto>('POST', '/holds', { branchId, items: [item] }),
  addItem: (holdId: string, item: HoldItemInput) => call<HoldDto>('POST', `/holds/${enc(holdId)}/items`, item),
  removeItem: (holdId: string, itemId: string) => call<HoldDto>('DELETE', `/holds/${enc(holdId)}/items/${enc(itemId)}`),
  release: (holdId: string) => call<HoldDto>('POST', `/holds/${enc(holdId)}/release`),
  attach: (holdId: string) => call<HoldDto>('POST', `/holds/${enc(holdId)}/attach`),
  /** Ключ – один на попытку оформления: повторное нажатие отдаёт ту же бронь (ADR 0004). */
  confirm: (holdId: string, key: string) => call<ConfirmResultDto>('POST', `/holds/${enc(holdId)}/confirm`, {}, key),
};

// ── Таймер от серверного времени ───────────────────────────
/** Точка истечения в шкале performance.now(): не зависит от часов браузера. */
export const holdDeadline = (hold: Pick<HoldDto, 'expiresAt' | 'serverNow'>, receivedAt = performance.now()) =>
  receivedAt + (Date.parse(hold.expiresAt) - Date.parse(hold.serverNow));
export const msLeft = (deadline: number) => Math.max(0, deadline - performance.now());
export const mmss = (ms: number) => {
  const s = Math.ceil(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
/** «Скоро истечёт» – последние 2 минуты. */
export const EXPIRING_MS = 120_000;

// ── Даты и время по зоне филиала ───────────────────────────
export const timeIn = (iso: string, tz: string) =>
  new Intl.DateTimeFormat('ru-RU', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
/** 'YYYY-MM-DD' + n дней (календарно, без часовых поясов). */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
export function dayLabel(date: string): { week: string; day: string } {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return {
    week: new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC', weekday: 'short' }).format(dt),
    day: new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC', day: 'numeric', month: 'short' }).format(dt),
  };
}
/** Сегодняшняя дата в зоне филиала (на сервере страницы – часами сервера). */
export const todayIn = (tz: string, now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now);
export const rub = (kop: number | null) => (kop === null ? 'цена уточняется в клубе' : `${new Intl.NumberFormat('ru-RU').format(kop / 100)} ₽`);

// ── 12 состояний tz/01 §15.1 – каждое своей фразой ─────────
export type UiState =
  | 'loading' | 'loaded' | 'empty' | 'held' | 'expiring' | 'expired'
  | 'conflict' | 'load_error' | 'forbidden' | 'blocked' | 'cancelled' | 'success';

export const UI_STATES: Record<UiState, string> = {
  loading: 'Загружаем расписание…',
  loaded: 'Выберите свободное время – можно несколько слотов подряд.',
  empty: 'На этот день свободного времени нет. Выберите другой день или зону.',
  held: 'Время закреплено за вами. Оформите запись, пока идёт таймер.',
  expiring: 'Осталось меньше двух минут – подтвердите запись, иначе время освободится.',
  expired: 'Время на оформление вышло, слоты освобождены. Выберите время заново.',
  conflict: 'Это время только что заняли. Выберите другое.',
  load_error: 'Не удалось загрузить расписание. Проверьте связь и нажмите «Повторить».',
  forbidden: 'Онлайн-запись для вашего профиля сейчас недоступна. Обратитесь к администратору клуба.',
  blocked: 'Это место сейчас на обслуживании. Выберите другое место.',
  cancelled: 'Выбор отменён, время освобождено.',
  success: 'Запись подтверждена. Ждём вас в клубе.',
};

/** Код ошибки API → состояние и своя фраза (если у кода есть уточнение). Выбор при ошибке не сбрасывается – кроме истечения. */
export const ERROR_STATES: Record<string, { state: UiState; text?: string }> = {
  SLOT_TAKEN: { state: 'conflict' },
  SLOT_HELD: { state: 'conflict', text: 'Это время сейчас оформляет другой гость. Выберите другое или загляните через пару минут.' },
  CLIENT_OVERLAP: { state: 'conflict', text: 'У вас уже есть запись на это время в одном из клубов. Уберите пересекающийся слот или выберите другое время.' },
  HOLD_ALREADY_ACTIVE: { state: 'conflict', text: 'У вас уже есть незавершённая запись в этом клубе – сначала оформите или отмените её.' },
  COMPOSITE_CHANGED: { state: 'conflict', text: 'Состав комнаты изменился. Выберите время заново.' },
  RESOURCE_BLOCKED: { state: 'blocked' },
  RESOURCE_UNAVAILABLE: { state: 'blocked', text: 'Это место сейчас недоступно для записи. Выберите другое.' },
  HOLD_EXPIRED: { state: 'expired' },
  CLIENT_RESTRICTED: { state: 'forbidden' },
  FORBIDDEN: { state: 'forbidden', text: 'Действие отклонено. Обновите страницу и попробуйте снова.' },
  BRANCH_NOT_ACTIVE: { state: 'forbidden', text: 'Клуб сейчас не принимает онлайн-записи.' },
  OUTSIDE_SCHEDULE: { state: 'conflict', text: 'В это время клуб не работает. Выберите время в часы работы.' },
  OUTSIDE_BOOKING_WINDOW: { state: 'conflict', text: 'Это время уже прошло или ещё не открыто для записи.' },
  HOLD_LIMIT_REACHED: { state: 'conflict', text: 'В одной записи слишком много слотов. Оформите эти и выберите остальные отдельно.' },
  INVALID_DURATION: { state: 'conflict', text: 'Выберите время по сетке расписания.' },
  RATE_LIMITED: { state: 'load_error', text: 'Слишком много запросов. Подождите минуту и попробуйте снова.' },
  TARIFF_NOT_CONFIGURED: { state: 'load_error', text: 'Цена на это время ещё не настроена. Позвоните в клуб – запишем вручную.' },
  NETWORK: { state: 'load_error', text: 'Нет связи с сервером. Проверьте интернет и попробуйте снова.' },
};

export function describeError(e: unknown): { state: UiState; text: string } {
  const code = e instanceof ClientApiError ? e.code : 'INTERNAL';
  const hit = ERROR_STATES[code];
  if (hit) return { state: hit.state, text: hit.text ?? UI_STATES[hit.state] };
  return { state: 'load_error', text: 'Сервис временно недоступен. Попробуйте ещё раз через минуту.' };
}

/** Удержание этого филиала переживает перезагрузку страницы (не продлевается: срок – на сервере). */
export const holdStoreKey = (branchId: string) => `yu_hold:${branchId}`;
export const SUCCESS_STORE_KEY = 'yu_booking_done';

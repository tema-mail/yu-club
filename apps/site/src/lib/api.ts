// Клиент публичного API записи для сайта – по контракту K5 (типы ответа, ошибки ADR 0002) и K13 (статусы филиала).
// Публичного эндпоинта филиалов в API ещё нет (S1-08): до него сайт ходит в мок tests/mock-api.ts, подмена –
// только переменной API_URL. Серверная часть (страницы SSR) ходит в API_URL напрямую.
// Здесь же – режим индексации и адрес сайта для canonical/sitemap: одно место для всех страниц.

export const API_PREFIX = '/api/public/v1';

/** Кука выбора посетителя: `{citySlug}/{branchSlug}` (карта сайта п.2.9). Не HttpOnly – её ставит остров BranchPicker. */
export const BRANCH_COOKIE = 'yu_branch';
export const BRANCH_COOKIE_MAX_AGE = 365 * 24 * 3600;

export interface CityDto { id: string; slug: string; name: string; timezone: string }

/** K5: 'preparing' и 'archived' публичный API не отдаёт вовсе. */
export type BranchStatus = 'active' | 'temporarily_closed';

export interface BranchDto {
  id: string; cityId: string; slug: string; name: string; address: string; timezone: string;
  status: BranchStatus;
  phone: string | null; publicContacts: Record<string, string>;
  bookingWindow: { defaultDays: number; maxDays: number };
  holdMinutes: number;
}

export type ZoneCode = 'pc' | 'vr' | 'ps';

export interface ResourceDto {
  id: string; branchId: string; roomId: string | null; roomName: string | null;
  type: 'pc' | 'vr_seat' | 'ps_room' | 'room_whole' | 'composite';
  zone: ZoneCode; name: string; stepMinutes: number; selfBookable: true;
}

export interface AvailabilityDto {
  branchId: string; date: string; timezone: string;
  dayState: 'open' | 'closed' | 'outside_window';
  openIntervals: { start: string; end: string }[];
  resources: { resourceId: string; slots: { start: string; end: string; state: string }[] }[];
  generatedAt: string;
}

/** Город с его филиалами – то, из чего строятся выбор, хабы и sitemap. */
export interface CityWithBranches extends CityDto { branches: BranchDto[] }

export const ZONE_LABEL: Record<ZoneCode, string> = { pc: 'Компьютеры', vr: 'VR и PS4', ps: 'PlayStation 5' };
export const ZONE_ORDER: ZoneCode[] = ['pc', 'vr', 'ps'];

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function apiBase(): string {
  const url = process.env.API_URL;
  if (!url) throw new Error('Не задана переменная окружения API_URL');
  return url.replace(/\/+$/, '');
}

async function get<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${apiBase()}${API_PREFIX}${path}`, { headers: { accept: 'application/json' }, redirect: 'manual' });
  } catch {
    throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'API не отвечает');
  }
  if (!res.ok) {
    let body: { error?: { code?: string; message?: string } } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      // тело не JSON – общий текст ниже
    }
    throw new ApiError(res.status, body.error?.code ?? 'INTERNAL', body.error?.message ?? 'Ошибка сервера');
  }
  return (await res.json()) as T;
}

export const site = {
  cities: async () => (await get<{ items: CityDto[] }>('/cities')).items,
  branches: async (citySlug?: string) =>
    (await get<{ items: BranchDto[] }>(citySlug ? `/branches?city=${encodeURIComponent(citySlug)}` : '/branches')).items,
  resources: async (branchId: string) =>
    (await get<{ items: ResourceDto[] }>(`/branches/${encodeURIComponent(branchId)}/resources`)).items,
  availability: (branchId: string, date: string) =>
    get<AvailabilityDto>(`/branches/${encodeURIComponent(branchId)}/availability?date=${encodeURIComponent(date)}`),
};

/** Вся сеть: города (K5 №1 – только с открытыми филиалами) и их филиалы (K5 №2). Два запроса, не N. */
export async function loadNetwork(): Promise<CityWithBranches[]> {
  const [cities, branches] = await Promise.all([site.cities(), site.branches()]);
  return cities
    .map((c) => ({ ...c, branches: branches.filter((b) => b.cityId === c.id) }))
    .filter((c) => c.branches.length > 0);
}

/** Филиал по паре слагов. Нет города или филиала – null (страница отдаёт 404). */
export function findBranch(net: CityWithBranches[], citySlug: string, branchSlug: string): { city: CityWithBranches; branch: BranchDto } | null {
  const city = net.find((c) => c.slug === citySlug);
  const branch = city?.branches.find((b) => b.slug === branchSlug);
  return city && branch ? { city, branch } : null;
}

export const branchPath = (citySlug: string, branchSlug: string) => `/${citySlug}/${branchSlug}/`;

/** Значение куки → пара слагов. Мусор – null (выбор просто не показывается). */
export function parseBranchCookie(raw: string | undefined | null): { city: string; branch: string } | null {
  const m = /^([a-z0-9-]{1,60})\/([a-z0-9-]{1,60})$/.exec(raw ?? '');
  return m ? { city: m[1]!, branch: m[2]! } : null;
}

/** Индексация открыта только на бою: APP_ENV=prod. Стенд и разработка – noindex везде (правило владельца). */
export const isIndexable = () => process.env.APP_ENV === 'prod';

/** Адрес сайта для canonical и sitemap.xml. На бою без PUBLIC_SITE_URL не работаем – молча не подставляем. */
export function siteUrl(fallbackOrigin: string): string {
  const url = process.env.PUBLIC_SITE_URL;
  if (url) return url.replace(/\/+$/, '');
  if (isIndexable()) throw new Error('Не задана переменная окружения PUBLIC_SITE_URL');
  return fallbackOrigin;
}

/** Сегодняшняя дата филиала 'YYYY-MM-DD' по его зоне (ADR 0003: локальные даты – по зоне филиала). */
export function todayIn(timezone: string, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** ISO UTC → «10:00» по зоне филиала. */
export function timeIn(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('ru-RU', { timeZone: timezone, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

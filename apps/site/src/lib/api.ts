// Клиент публичного API записи для сайта – по контракту K5 (типы ответа, ошибки ADR 0002) и K13 (статусы филиала).
// Маршруты – apps/api/src/modules/network/routes.public.ts; e2e ходит в мок tests/mock-api.ts с теми же ответами, подмена –
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
  roomSlug: string | null; // rooms.slug – адрес /{city}/{branch}/rooms/{roomSlug}/
  type: string; // API отдаёт код типа из справочника (modules/network/routes.public.ts)
  zone: ZoneCode; name: string; stepMinutes: number; selfBookable: true;
}

/** K5 №3 + расширение API: часы сегодня 'HH:mm' по зоне филиала (пусто – сегодня закрыт). */
export interface BranchDetailDto extends BranchDto { hoursToday: Array<{ start: string; end: string }> }

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
  branch: (branchId: string) => get<BranchDetailDto>(`/branches/${encodeURIComponent(branchId)}`),
  // Доступность (K5 №5, слоты) – шаг S1-19: до расписания сайт её не вызывает.
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

// ── Комнаты (S1-21, карта сайта 3.2: /{city}/{branch}/rooms/{room}/) ──
// Комната – группа ресурсов с одним roomId из GET /branches/{id}/resources (K5 №4): в API только опубликованные
// активные комнаты, поэтому архивная сюда не попадает и её адрес отдаёт 404. Адрес – roomSlug из API (rooms.slug,
// уникален в филиале, английскими словами по карте сайта п.5). Вместимости в ResourceDto нет, а из числа устройств
// её выводить нельзя (12 §7.1) – число не показываем.

export interface RoomView { id: string; slug: string; name: string; zones: ZoneCode[]; resources: ResourceDto[] }

/** Комнаты филиала в порядке зон (затем id – стабильно). */
export function branchRooms(resources: ResourceDto[]): RoomView[] {
  const byRoom = new Map<string, RoomView>();
  for (const r of resources) {
    if (!r.roomId) continue;
    if (!r.roomSlug) continue; // комната без адреса – страницы нет
    const room = byRoom.get(r.roomId) ?? { id: r.roomId, slug: r.roomSlug, name: r.roomName ?? r.name, zones: [], resources: [] };
    room.resources.push(r);
    if (!room.zones.includes(r.zone)) room.zones.push(r.zone);
    byRoom.set(r.roomId, room);
  }
  return [...byRoom.values()].sort((a, b) => ZONE_ORDER.indexOf(a.zones[0]!) - ZONE_ORDER.indexOf(b.zones[0]!) || a.id.localeCompare(b.id));
}

export const roomPath = (citySlug: string, branchSlug: string, slug: string) => `/${citySlug}/${branchSlug}/rooms/${slug}/`;

/** Запись с предвыбором: клуб, зона и комната – фильтры /schedule/ (карта п.2.10, canonical без них). */
export const scheduleHref = (citySlug: string, branchSlug: string, opts: { zone?: ZoneCode; room?: string } = {}) =>
  `/schedule/?branch=${citySlug}/${branchSlug}${opts.zone ? `&zone=${opts.zone}` : ''}${opts.room ? `&room=${opts.room}` : ''}`;

/** Что можно взять в комнате – понятным посетителю языком (12 §7.2), по типу ресурса из справочника. */
export const RESOURCE_KIND: Record<string, string> = {
  pc: 'игровое место за компьютером',
  vr_seat: 'отдельное VR-место – каждое бронируется независимо',
  room_whole: 'вся комната целиком – занимает все места в ней',
  ps_room: 'комната с PlayStation целиком',
  composite: 'набор мест одной записью',
};

// Тонкий клиент API CRM по контрактам K12 (вход), K11 (CRM), K1 (права), ошибки – ADR 0002.
// Серверная часть (SSR, middleware, страницы) ходит в API_URL напрямую, пересылая куку браузера.
// Браузер ходит только в /api/crm/v1/* своего же сервера CRM (src/pages/api/crm/v1/[...path].ts).
// Подмена мок ↔ настоящий бэкенд – только переменная окружения API_URL.

export const API_PREFIX = '/api/crm/v1';

export type StaffRole = 'owner' | 'director' | 'admin';

export interface Staff {
  id: string;
  firstName: string;
  lastName: string;
  role: StaffRole;
}

/** K11 №1 GET /me. Меню строится по `actions`, защита – на сервере. */
export interface Me {
  staff: Staff;
  access: { network: boolean; cityIds: string[]; branchIds: string[] };
  actions: string[];
}

export type BranchStatus = 'preparing' | 'active' | 'temporarily_closed' | 'archived';

/** Филиал в CRM: поля BranchInfo из K13, отдаёт K11 №18 (сеть, список и карточка). */
export interface Branch {
  id: string;
  cityId: string;
  cityName: string;
  slug: string;
  name: string;
  address: string;
  timezone: string;
  status: BranchStatus;
}

export interface LoginResult {
  staff?: Staff;
  totpRequired: boolean;
}

export interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown>; requestId?: string };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const ROLE_LABEL: Record<StaffRole, string> = {
  owner: 'Владелец',
  director: 'Директор',
  admin: 'Администратор',
};

export const BRANCH_STATUS_LABEL: Record<BranchStatus, string> = {
  preparing: 'Готовится к открытию',
  active: 'Работает',
  temporarily_closed: 'Временно закрыт',
  archived: 'В архиве',
};

/** Адрес API для серверной части. Без переменной CRM не работает – говорим имя переменной, не гадаем. */
export function apiBase(): string {
  const url = process.env.API_URL;
  if (!url) throw new Error('Не задана переменная окружения API_URL');
  return url.replace(/\/+$/, '');
}

async function toApiError(res: Response): Promise<ApiError> {
  let body: Partial<ErrorBody> = {};
  try {
    body = (await res.json()) as Partial<ErrorBody>;
  } catch {
    // тело не JSON – остаётся общий текст ниже
  }
  const e = body.error;
  return new ApiError(res.status, e?.code ?? 'INTERNAL', e?.message ?? 'Ошибка сервера', e?.details);
}

/** Серверный вызов API с кукой пользователя. */
export async function serverCall<T>(cookie: string | null, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (cookie) headers.cookie = cookie;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${apiBase()}${API_PREFIX}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    redirect: 'manual',
  });
  if (!res.ok) throw await toApiError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const crm = {
  me: (cookie: string | null) => serverCall<Me>(cookie, '/me'),
  branches: (cookie: string | null) =>
    serverCall<{ items: Branch[]; nextCursor: string | null }>(cookie, '/branches?limit=100').then((r) => r.items),
  branch: (cookie: string | null, id: string) => serverCall<Branch>(cookie, `/branches/${encodeURIComponent(id)}`),
};

/** Вызов из браузера (острова, скрипты страниц): тот же источник, кука уходит сама.
 *  Изменяющие запросы получают Idempotency-Key (ADR 0004). */
export async function browserCall<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers['idempotency-key'] = crypto.randomUUID();
  let res: Response;
  try {
    res = await fetch(`${API_PREFIX}${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Сервер недоступен. Проверьте связь и повторите.');
  }
  if (!res.ok) throw await toApiError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const auth = {
  login: (email: string, password: string, totp?: string) =>
    browserCall<LoginResult>('/auth/login', { method: 'POST', body: totp ? { email, password, totp } : { email, password } }),
  logout: () => browserCall<void>('/auth/logout', { method: 'POST' }),
  changePassword: (currentPassword: string, newPassword: string) =>
    browserCall<void>('/auth/password', { method: 'POST', body: { currentPassword, newPassword } }),
};

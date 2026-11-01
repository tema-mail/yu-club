// Клиент на сайте: вход по коду и ЛК (K9, apps/api/src/modules/clients/routes.public.ts).
// Браузер ходит только в /api/public/v1/* своего сервера (прокси src/pages/api/public/v1/[...path].ts) – кука yu_client своя.
// Сервер (middleware, страницы) ходит в API_URL напрямую, пересылая куку посетителя.
// Тексты ошибок не раскрывают, есть ли аккаунт: запрос кода отвечает одинаково на любой номер (K9).
import { API_PREFIX, apiBase } from './api.ts';

export const CLIENT_COOKIE = 'yu_client';

/** MeDto (K9 §ЛК) – как отдаёт GET /me и POST /auth/otp/verify. */
export interface Me {
  id: string;
  phoneMasked: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  birthDate: string | null;
  status: 'active' | 'restricted';
  notifications: { remindersEnabled: boolean; marketingEnabled: boolean };
  loyalty: null;
  certificates: null;
}

export interface OtpRequested { challengeId: string; resendAfterSec: number; expiresInSec: number }

export class ClientApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;
  readonly retryAfterSec: number | null;

  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}, retryAfterSec: number | null = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryAfterSec = retryAfterSec;
  }
}

async function toError(res: Response): Promise<ClientApiError> {
  let body: { error?: { code?: string; message?: string; details?: Record<string, unknown> } } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    // тело не JSON – общий код ниже
  }
  const retry = Number(res.headers.get('retry-after'));
  return new ClientApiError(res.status, body.error?.code ?? 'INTERNAL', body.error?.message ?? '', body.error?.details ?? {}, Number.isFinite(retry) && retry > 0 ? retry : null);
}

/** Вызов из браузера. Слеш в конце – из-за trailingSlash: 'always' сайта; прокси его не передаёт.
 *  POST: Idempotency-Key на одно нажатие (ADR 0004) и X-Requested-With для CSRF-проверки прокси. */
export async function browserCall<T>(path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  const post = body !== undefined;
  if (post) {
    headers['content-type'] = 'application/json';
    headers['x-requested-with'] = 'yu-site';
    headers['idempotency-key'] = idempotencyKey ?? crypto.randomUUID();
  }
  let res: Response;
  try {
    res = await fetch(`${API_PREFIX}${path}/`, {
      method: post ? 'POST' : 'GET',
      headers,
      credentials: 'same-origin',
      body: post ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ClientApiError(0, 'NETWORK', '');
  }
  if (!res.ok) throw await toError(res);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export const clientAuth = {
  requestCode: (phone: string, key: string) => browserCall<OtpRequested>('/auth/otp/request', { phone, purpose: 'login' }, key),
  verify: (challengeId: string, code: string) =>
    browserCall<{ client: Me; isNew: boolean }>('/auth/otp/verify', { challengeId, code, consents: { pdProcessing: true } }),
  logout: () => browserCall<void>('/auth/logout', {}),
};

/** Профиль по куке посетителя (сервер). 401 – сессии нет; прочее – ClientApiError (страница отвечает 503). */
export async function serverMe(cookie: string): Promise<Me | null> {
  let res: Response;
  try {
    res = await fetch(`${apiBase()}${API_PREFIX}/me`, { headers: { accept: 'application/json', cookie }, redirect: 'manual' });
  } catch {
    throw new ClientApiError(503, 'SERVICE_UNAVAILABLE', 'API не отвечает');
  }
  if (res.status === 401) return null;
  if (!res.ok) throw await toError(res);
  return (await res.json()) as Me;
}

/** Куда вернуть после входа: только путь этого же сайта (как safeNext CRM). Иначе – кабинет.
 *  Управляющие символы и `\` – отказ: браузер вырезает таб/перевод строки, и `/\t/evil.com` становится `//evil.com`. */
export function safeNext(next: string | null | undefined, origin: string, fallback = '/account/'): string {
  // eslint-disable-next-line no-control-regex -- ловим именно управляющие символы
  if (!next || !next.startsWith('/') || /[\u0000-\u001f\u007f\\]/.test(next)) return fallback;
  let url: URL;
  try {
    url = new URL(next, origin);
  } catch {
    return fallback;
  }
  if (url.origin !== new URL(origin).origin) return fallback;
  return url.pathname + url.search + url.hash;
}

const minutes = (sec: number) => {
  const m = Math.max(1, Math.ceil(sec / 60));
  return `${m} мин`;
};

/** Ошибка → фраза для посетителя. Ни одна не говорит, есть ли аккаунт на этом номере. */
export function errorText(e: unknown): string {
  if (!(e instanceof ClientApiError)) return 'Что-то пошло не так. Попробуйте ещё раз.';
  const wait = e.retryAfterSec ?? Number(e.details.resendAfterSec ?? 0);
  switch (e.code) {
    case 'VALIDATION_FAILED':
      if (e.details.field === 'phone') return 'Проверьте номер: нужен российский мобильный, 10 цифр после +7.';
      if (e.details.field === 'code') return 'Код – это 6 цифр из SMS.';
      return 'Проверьте введённые данные.';
    case 'OTP_RATE_LIMITED':
      return `Слишком много запросов кода. Попробуйте через ${minutes(wait || 60)}.`;
    case 'SMS_UNAVAILABLE':
      return 'Не получилось отправить SMS. Попробуйте через минуту.';
    case 'OTP_INVALID': {
      const left = Number(e.details.attemptsLeft ?? 0);
      return left > 0 ? `Код не подходит. Осталось попыток: ${left}.` : 'Код не подходит, попытки закончились. Запросите новый код.';
    }
    case 'OTP_EXPIRED':
      return 'Код устарел или попытки закончились. Запросите новый код.';
    case 'CLIENT_RESTRICTED':
      return 'Вход в кабинет сейчас недоступен. Обратитесь к администратору клуба.';
    case 'CONSENT_REQUIRED':
      return 'Отметьте согласие на обработку персональных данных.';
    case 'RATE_LIMITED':
      return 'Слишком много запросов. Подождите минуту и попробуйте снова.';
    case 'NETWORK':
      return 'Нет связи с сервером. Проверьте интернет и попробуйте снова.';
    case 'FORBIDDEN':
      return 'Обновите страницу и попробуйте снова.';
    default:
      return e.status >= 500 ? 'Сервис временно недоступен. Попробуйте через минуту.' : 'Что-то пошло не так. Попробуйте ещё раз.';
  }
}

// Единый тип ошибки (ADR 0002). Коды – стабильные. Общие коды – здесь, коды модулей –
// в modules/<x>/errors.ts, собираются в core/registry.ts (там же проверка на дубли).
import type { ModuleErrorCode } from './registry.ts';

// 413, 415, 507 – медиа K22 §14; 504 – REPORT_TIMEOUT K24 §10 (D4-07).
export type HttpStatus = 400 | 401 | 403 | 404 | 409 | 410 | 413 | 415 | 422 | 429 | 500 | 503 | 504 | 507;

export const coreErrors = {
  VALIDATION_FAILED: 400,
  INVALID_DURATION: 422,
  AUTH_REQUIRED: 401, // K1: нет сессии
  SESSION_REVOKED: 401, // K1/K12: сессия отозвана, истекла, сотрудник заблокирован
  FORBIDDEN: 403, // K1: объект в зоне, действие роли не разрешено
  NOT_FOUND: 404, // K1: нет объекта ИЛИ он вне зоны – тело одинаковое
  IDEMPOTENCY_KEY_REQUIRED: 400, // ADR 0004: команда без Idempotency-Key
  IDEMPOTENCY_KEY_REUSED: 409, // ADR 0004: ключ уже использован для другого запроса или ещё выполняется
  VERSION_CONFLICT: 409, // K11: устаревший rowVersion
  RATE_LIMITED: 429,
  INTERNAL: 500,
} as const satisfies Record<string, HttpStatus>;

export type CoreErrorCode = keyof typeof coreErrors;
export type ErrorCode = CoreErrorCode | ModuleErrorCode;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: HttpStatus;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, httpStatus: HttpStatus, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = httpStatus;
    if (details !== undefined) this.details = details;
  }
}

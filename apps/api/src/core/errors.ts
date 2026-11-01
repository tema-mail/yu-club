// Единый тип ошибки (ADR 0002). Коды – стабильные, список растёт вместе с модулями (K5 §Ошибки).
export type ErrorCode = 'VALIDATION_FAILED' | 'INVALID_DURATION';

export type HttpStatus = 400 | 401 | 403 | 404 | 409 | 410 | 422 | 429 | 500 | 503;

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

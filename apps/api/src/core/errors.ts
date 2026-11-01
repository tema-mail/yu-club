// Единый тип ошибки (ADR 0002). Коды – стабильные.
// Общие коды ядра – здесь. Коды модуля (и узких частей ядра вроде ledger) добавляются в его собственном файле
// расширением интерфейса, чтобы параллельные потоки не правили этот файл:
//   declare module '<путь>/core/errors.ts' { interface ErrorCodeRegistry { BALANCE_BELOW_LIMIT: 409 } }
// Значение в реестре – HTTP-статус кода (справочно; в AppError статус передаётся явно).
export type CoreErrorCode =
  | 'VALIDATION_FAILED'
  | 'INVALID_DURATION'
  | 'NOT_FOUND'
  | 'IDEMPOTENCY_KEY_REQUIRED'
  | 'IDEMPOTENCY_KEY_REUSED';

// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- точка расширения для модулей
export interface ErrorCodeRegistry {}

export type ErrorCode = CoreErrorCode | (keyof ErrorCodeRegistry & string);

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

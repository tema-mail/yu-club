import { z } from 'zod';

// Конфиг API только из окружения. Ошибка валидации останавливает запуск:
// лучше упасть на старте, чем работать с неверными настройками.
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  // Хеш коммита, выставляется при сборке/выкладке; локально – 'dev'.
  GIT_SHA: z.string().min(1).default('dev'),
  // Рантайм-учётка yu_app (ADR 0001). Без неё API отдаёт только /health.
  DATABASE_URL: z.string().min(1).optional(),
  // Секрет HMAC токенов сессий (K12). Без него вход сотрудников выключен.
  SESSION_PEPPER: z.string().min(32, 'не короче 32 символов').optional(),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Неверная конфигурация окружения: ${issues}`);
  }
  return parsed.data;
}

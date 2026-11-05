import { z } from 'zod';

// Конфиг API только из окружения. Ошибка валидации останавливает запуск:
// лучше упасть на старте, чем работать с неверными настройками.
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // Окружение выкладки (K9): prod – боевой стенд; stage/dev – тестовый адаптер SMS пишет код в лог сервера.
  APP_ENV: z.enum(['dev', 'stage', 'prod']).default('dev'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  // Хеш коммита, выставляется при сборке/выкладке; локально – 'dev'.
  GIT_SHA: z.string().min(1).default('dev'),
  // Рантайм-учётка yu_app (ADR 0001). Без неё API отдаёт только /health.
  DATABASE_URL: z.string().min(1).optional(),
  // Секрет HMAC токенов сессий (K12). Без него вход сотрудников выключен.
  SESSION_PEPPER: z.string().min(32, 'не короче 32 символов').optional(),
  // Секрет HMAC кода сертификата (K16 §3, S2-08): pin_hash в базе и замена кода в request_hash идемпотентности.
  // Генерирует deploy.sh один раз (как SESSION_PEPPER). Смена значения = все выданные коды сертификатов перестают сходиться.
  CERT_PEPPER: z.string().min(32, 'не короче 32 символов').optional(),
  // Закрытые вложения Э3 (K19 №350, core/files.ts): каталог вне веб-корня – Caddy его не раздаёт, файлы отдаёт только API
  // с проверкой права на объект-владелец. В контейнере – том deploy/compose.yml; входит в бэкап (S3-94).
  ATTACHMENTS_DIR: z.string().min(1).refine((p) => p.startsWith('/'), 'абсолютный путь').default('/data/attachments'),
  // Прокси, чьему X-Forwarded-For верим (адреса и IPv4-CIDR через запятую) – как TRUSTED_PROXIES в CRM.
  // От остальных XFF игнорируется: request.ip – адрес соединения. Нужен лимиту входа K12 по IP.
  TRUSTED_PROXIES: z
    .string()
    .default('127.0.0.0/8,::1,172.16.0.0/12')
    .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))
    .refine((list) => list.every((x) => /^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(x)), 'адреса или CIDR через запятую'),
  // Web Push (S1-15, Q-30): пара VAPID P-256 в base64url – открытый 65 байт, закрытый 32 байта; subject – mailto: или https://.
  // Генерирует deploy.sh один раз на сервере (как SESSION_PEPPER). Смена пары = все подписки браузеров недействительны.
  // Нет ключей – подписка отвечает 503, уведомления остаются записью в ЛК со статусом «нет канала».
  VAPID_PUBLIC_KEY: z.string().regex(/^[A-Za-z0-9_-]{87}$/, '65 байт base64url без =').optional(),
  VAPID_PRIVATE_KEY: z.string().regex(/^[A-Za-z0-9_-]{43}$/, '32 байта base64url без =').optional(),
  VAPID_SUBJECT: z.string().regex(/^(mailto:|https:\/\/)\S+$/, 'mailto: или https://').optional(),
  // Хосты push-сервисов, на которые сервер шлёт (защита от SSRF). Пусто – список браузеров по умолчанию (notifications/index.ts).
  PUSH_ENDPOINT_HOSTS: z
    .string()
    .optional()
    .transform((s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : undefined)),
}).superRefine((c, ctx) => {
  const set = [c.VAPID_PUBLIC_KEY, c.VAPID_PRIVATE_KEY, c.VAPID_SUBJECT].filter((x) => x !== undefined).length;
  if (set !== 0 && set !== 3) ctx.addIssue({ code: 'custom', path: ['VAPID_PUBLIC_KEY'], message: 'VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY и VAPID_SUBJECT – все три или ни одного' });
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

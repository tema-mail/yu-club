import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { loadConfig, type Config } from './config.ts';
import { AppError } from './core/errors.ts';
import './core/registry.ts'; // проверка реестров модулей на дубли – при старте (ADR 0002)
import { dictionaryRoutes } from './modules/dictionaries/routes.ts';
import { staffAuthConfig } from './modules/staff/auth.ts';
import { authenticate, staffAuthRoutes, type StaffDeps } from './modules/staff/routes.crm.ts';

export interface ServerDeps {
  staff?: StaffDeps;
}

export function buildServer(config: Config, deps: ServerDeps = {}): FastifyInstance {
  const app = Fastify({ logger: { level: config.LOG_LEVEL } });

  // Тело ошибки (ADR 0002): { error: { code, message, details?, requestId } }. Стек и SQL – только в лог.
  app.setErrorHandler((err: FastifyError | AppError, request, reply) => {
    if (err instanceof AppError) {
      const retry = err.details?.retryAfterSec;
      if (typeof retry === 'number') reply.header('retry-after', String(retry));
      const body: Record<string, unknown> = { code: err.code, message: err.message, requestId: request.id };
      if (err.details !== undefined) body.details = err.details;
      return reply.code(err.httpStatus).send({ error: body });
    }
    if (typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500) {
      return reply.code(400).send({ error: { code: 'VALIDATION_FAILED', message: 'Неверный запрос', requestId: request.id } });
    }
    request.log.error(err);
    return reply.code(500).send({ error: { code: 'INTERNAL', message: 'Внутренняя ошибка', requestId: request.id } });
  });

  app.get('/health', async () => ({ status: 'ok', version: config.GIT_SHA }));

  if (deps.staff) {
    const staff = deps.staff;
    void app.register(async (scope) => staffAuthRoutes(scope, staff), { prefix: '/api/crm/v1/auth' });
    void app.register(
      async (scope) =>
        dictionaryRoutes(scope, {
          pool: staff.pool,
          ...(staff.clock ? { clock: staff.clock } : {}),
          authenticate: (request, reply) => authenticate(staff, request, reply),
        }),
      { prefix: '/api/crm/v1/dictionaries' },
    );
  }

  return app;
}

/** Зависимости из окружения: пул yu_app (search_path=app,journal – model-dannyh §0) и вход сотрудников. */
export function depsFromConfig(config: Config): { deps: ServerDeps; close: () => Promise<void> } {
  if (!config.DATABASE_URL) return { deps: {}, close: async () => {} };
  const pool = new pg.Pool({ connectionString: config.DATABASE_URL, options: '-c search_path=app,journal', max: 10 });
  const deps: ServerDeps = {};
  if (config.SESSION_PEPPER) deps.staff = { pool, auth: staffAuthConfig(config.SESSION_PEPPER) };
  return { deps, close: () => pool.end() };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const { deps, close } = depsFromConfig(config);
  const app = buildServer(config, deps);
  if (!deps.staff) app.log.warn('Вход сотрудников выключен: нужны DATABASE_URL и SESSION_PEPPER');
  app.addHook('onClose', close);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void app.close().then(() => process.exit(0));
    });
  }
  await app.listen({ host: config.HOST, port: config.PORT });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}

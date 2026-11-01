import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { pathToFileURL } from 'node:url';
import { loadConfig, type Config } from './config.ts';
import { AppError } from './core/errors.ts';
import './core/registry.ts'; // проверка реестров модулей на дубли – при старте (ADR 0002)
import { staffAuthRoutes, type StaffDeps } from './modules/staff/routes.crm.ts';

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
  }

  return app;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const app = buildServer(config);
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

import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { loadConfig, type Config } from './config.ts';
import { AppError } from './core/errors.ts';
import './core/registry.ts'; // проверка реестров модулей на дубли – при старте (ADR 0002)
import { blockRoutes } from './modules/booking/blocks.ts';
import { clientAuthConfig, createDevSmsSender, unconfiguredSmsSender } from './modules/clients/otp.ts';
import { clientCrmRoutes } from './modules/clients/routes.crm.ts';
import { clientPublicRoutes, type ClientPublicDeps } from './modules/clients/routes.public.ts';
import type { NetworkLookup } from './core/permissions.ts';
import { dictionaryRoutes } from './modules/dictionaries/routes.ts';
import { branchIdsOfCities, timezonesOf } from './modules/network/index.ts';
import { networkRoutes } from './modules/network/routes.ts';
import { resourcesRoutes } from './modules/resources/routes.ts';
import { pricingRoutes } from './modules/pricing/routes.ts';
import { staffAuthConfig } from './modules/staff/auth.ts';
import { authenticate, staffAuthRoutes, staffMeRoutes, type StaffDeps } from './modules/staff/routes.crm.ts';
import { staffAdminRoutes } from './modules/staff/routes.staff.ts';

export interface ServerDeps {
  staff?: StaffDeps;
  clients?: ClientPublicDeps;
  /** Куда писать лог (по умолчанию stdout) – тесты проверяют, что код и токен в лог не попадают. */
  logStream?: NodeJS.WritableStream;
}

/** K1: назначение на город раскрывается в филиалы, дата назначения – по зоне цели (modules/network). */
export const networkLookup: NetworkLookup = { branchesOfCities: branchIdsOfCities, timezonesOf };

export function buildServer(config: Config, deps: ServerDeps = {}): FastifyInstance {
  // trustProxy – только список доверенных: иначе за Caddy у всех один request.ip и 51 неудача закроет вход всем.
  const app = Fastify({
    logger: deps.logStream ? { level: config.LOG_LEVEL, stream: deps.logStream } : { level: config.LOG_LEVEL },
    trustProxy: config.TRUSTED_PROXIES,
  });

  // Тело ошибки (ADR 0002): { error: { code, message, details?, requestId } }. Стек и SQL – только в лог.
  app.setErrorHandler((err: FastifyError | AppError, request, reply) => {
    if (err instanceof AppError) {
      const retry = err.details?.retryAfterSec ?? err.details?.resendAfterSec;
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
    const staff: StaffDeps = { network: networkLookup, ...deps.staff };
    void app.register(async (scope) => staffAuthRoutes(scope, staff), { prefix: '/api/crm/v1/auth' });
    void app.register(async (scope) => staffMeRoutes(scope, staff), { prefix: '/api/crm/v1' });
    void app.register(async (scope) => staffAdminRoutes(scope, staff), { prefix: '/api/crm/v1' });
    void app.register(
      async (scope) =>
        dictionaryRoutes(scope, {
          pool: staff.pool,
          ...(staff.clock ? { clock: staff.clock } : {}),
          authenticate: (request, reply) => authenticate(staff, request, reply),
        }),
      { prefix: '/api/crm/v1/dictionaries' },
    );
    void app.register(
      async (scope) =>
        networkRoutes(scope, {
          pool: staff.pool,
          ...(staff.clock ? { clock: staff.clock } : {}),
          authenticate: (request, reply) => authenticate(staff, request, reply),
        }),
      { prefix: '/api/crm/v1' },
    );
    void app.register(
      async (scope) =>
        pricingRoutes(scope, {
          pool: staff.pool,
          ...(staff.clock ? { clock: staff.clock } : {}),
          authenticate: (request, reply) => authenticate(staff, request, reply),
        }),
      { prefix: '/api/crm/v1' },
    );
    void app.register(
      async (scope) =>
        resourcesRoutes(scope, {
          pool: staff.pool,
          ...(staff.clock ? { clock: staff.clock } : {}),
          authenticate: (request, reply) => authenticate(staff, request, reply),
        }),
      { prefix: '/api/crm/v1' },
    );
    void app.register(
      async (scope) =>
        blockRoutes(scope, {
          pool: staff.pool,
          ...(staff.clock ? { clock: staff.clock } : {}),
          authenticate: (request, reply) => authenticate(staff, request, reply),
        }),
      { prefix: '/api/crm/v1' },
    );
    void app.register(
      async (scope) =>
        clientCrmRoutes(scope, { pool: staff.pool, authenticate: (request, reply) => authenticate(staff, request, reply) }),
      { prefix: '/api/crm/v1/clients' },
    );
  }

  if (deps.clients) {
    const clients = deps.clients;
    void app.register(async (scope) => clientPublicRoutes(scope, clients), { prefix: '/api/public/v1' });
  }

  return app;
}

/** Зависимости из окружения: пул yu_app (search_path=app,journal – model-dannyh §0), вход сотрудников и клиентов.
 *  SMS: APP_ENV=prod – боевой адаптер (провайдер не выбран, R-18 → 503); stage и dev – тестовый (код в лог сервера). */
export function depsFromConfig(config: Config): { deps: ServerDeps; close: () => Promise<void> } {
  if (!config.DATABASE_URL) return { deps: {}, close: async () => {} };
  const pool = new pg.Pool({ connectionString: config.DATABASE_URL, options: '-c search_path=app,journal', max: 10 });
  const deps: ServerDeps = {};
  if (config.SESSION_PEPPER) {
    deps.staff = { pool, auth: staffAuthConfig(config.SESSION_PEPPER) };
    const sms =
      config.APP_ENV === 'prod' ? unconfiguredSmsSender : createDevSmsSender(config.APP_ENV, (line) => console.info(line));
    deps.clients = { pool, auth: clientAuthConfig(config.SESSION_PEPPER), sms };
  }
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

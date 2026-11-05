import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { loadConfig, type Config } from './config.ts';
import { AppError } from './core/errors.ts';
import './core/registry.ts'; // проверка реестров модулей на дубли – при старте (ADR 0002)
import { blockRoutes } from './modules/booking/blocks.ts';
import { blockListRoutes } from './modules/booking/blocks.routes.list.ts';
import { clientAuthConfig, createDevSmsSender, unconfiguredSmsSender } from './modules/clients/otp.ts';
import { registerBookingGate } from './modules/clients/index.ts';
import { clientCrmRoutes } from './modules/clients/routes.crm.ts';
import { authenticateClient, clientPublicRoutes, type ClientPublicDeps } from './modules/clients/routes.public.ts';
import { attachVisitorHolds } from './modules/booking/hold.ts';
import { createFileStore, type FileStore } from './core/files.ts';
import { attachmentCrmRoutes } from './modules/attachments/routes.crm.ts';
import { bookingCrmRoutes } from './modules/booking/routes.crm.ts';
import { bookingPublicRoutes } from './modules/booking/routes.public.ts';
import { bookingLookup, bookingsProvider, clientBranchLinks, paymentBookingProvider } from './modules/booking/providers.ts';
import { calendarTargets } from './modules/resources/index.ts';
import type { NetworkLookup } from './core/permissions.ts';
import { dictionaryRoutes } from './modules/dictionaries/routes.ts';
import { registerPaymentMethod } from './modules/finance/methods.ts';
import { loyaltyGate } from './modules/loyalty/gate.ts';
import { pointsPaymentMethod } from './modules/loyalty/payment-method.ts';
import { loyaltyCrmRoutes } from './modules/loyalty/routes.crm.ts';
import { loyaltyPublicRoutes } from './modules/loyalty/routes.public.ts';
import { branchIdsOfCities, timezonesOf } from './modules/network/index.ts';
import { networkRoutes } from './modules/network/routes.ts';
import { networkPublicRoutes, type NetworkPublicDeps } from './modules/network/routes.public.ts';
import { resourcesRoutes } from './modules/resources/routes.ts';
import { pricingRoutes } from './modules/pricing/routes.ts';
import { settingsRoutes } from './modules/settings/routes.crm.ts';
import { financeCrmRoutes } from './modules/finance/routes.crm.ts';
import { paymentRoutes } from './modules/finance/routes.payments.ts';
import { availableForBookingCenti as loyaltyAvailableForBooking } from './modules/loyalty/account.ts';
import { createCertificatePaymentMethod, verifyCertificatePin } from './modules/certificates/payment-method.ts';
import { certificateCrmRoutes } from './modules/certificates/routes.crm.ts';
import { certificatePublicRoutes } from './modules/certificates/routes.public.ts';
import { DEFAULT_PUSH_HOSTS } from './modules/notifications/index.ts';
import { notificationPublicRoutes } from './modules/notifications/routes.public.ts';
import type { SenderDeps } from './modules/notifications/sender.ts';
import { vapidKeys } from './modules/notifications/webpush.ts';
import { staffAuthConfig } from './modules/staff/auth.ts';
import { authenticate, staffAuthRoutes, staffMeRoutes, type StaffDeps } from './modules/staff/routes.crm.ts';
import { staffAdminRoutes } from './modules/staff/routes.staff.ts';

export interface ServerDeps {
  staff?: StaffDeps;
  clients?: ClientPublicDeps;
  /** Публичная сеть для сайта (K5 №1–4) – без входа, нужна только база. */
  network?: NetworkPublicDeps;
  /** Web Push (S1-15): открытый ключ VAPID (null – не настроен, подписка 503) и разрешённые push-сервисы. Нужны clients. */
  notifications?: { vapidPublicKey: string | null; allowedPushHosts?: readonly string[] };
  /** Сертификаты (K16): CERT_PEPPER – HMAC кода. Нет – маршруты сертификатов не подключаются. */
  certificates?: { pepper: string };
  /** Вложения Э3 (K19 №350): адаптер диска с корнем ATTACHMENTS_DIR вне веб-корня. Нет – маршруты не подключаются. */
  attachments?: { store: FileStore };
  /** Куда писать лог (по умолчанию stdout) – тесты проверяют, что код и токен в лог не попадают. */
  logStream?: NodeJS.WritableStream;
}

/** Реестры модулей на процесс (ворота записи K9, способы оплаты K10 §5), а buildServer зовут повторно (тесты) –
 *  регистрируем один раз. Модули друг друга не импортируют (ADR 0002): связывает их только этот файл. */
let hooksRegistered = false;
function registerModuleHooks(): void {
  if (hooksRegistered) return;
  registerBookingGate(loyaltyGate); // K15 §8: −50 → LOYALTY_LIMIT_REACHED
  registerPaymentMethod(pointsPaymentMethod); // K15 §6: оплата сеанса баллами
  hooksRegistered = true;
}

/** K1: назначение на город раскрывается в филиалы, дата назначения – по зоне цели (modules/network). */
export const networkLookup: NetworkLookup = { branchesOfCities: branchIdsOfCities, timezonesOf };

export function buildServer(config: Config, deps: ServerDeps = {}): FastifyInstance {
  registerModuleHooks();
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
          bookings: bookingsProvider,
          targets: calendarTargets,
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
    // K7 по HTTP: экран CRM «Настройки» (наследование сеть → город → филиал, даты, история).
    void app.register(
      async (scope) =>
        settingsRoutes(scope, {
          pool: staff.pool,
          ...(staff.clock ? { clock: staff.clock } : {}),
          authenticate: (request, reply) => authenticate(staff, request, reply),
        }),
      { prefix: '/api/crm/v1' },
    );
    void app.register(
      async (scope) =>
        financeCrmRoutes(scope, {
          pool: staff.pool,
          ...(staff.clock ? { clock: staff.clock } : {}),
          authenticate: (request, reply) => authenticate(staff, request, reply),
        }),
      { prefix: '/api/crm/v1' },
    );
    // K10 №19–23: оплата сеанса. Код сертификата – verifyCertificatePin до транзакции оплаты (K10 §5, решение 02.11).
    const certPepper = deps.certificates?.pepper;
    void app.register(
      async (scope) =>
        paymentRoutes(scope, {
          pool: staff.pool,
          authenticate: (request, reply) => authenticate(staff, request, reply),
          bookings: {
            facts: (db, id) => bookingLookup.facts(db, id),
            payableBooking: (db, id) => paymentBookingProvider.payableBooking(db, id),
            payableInPeriod: (db, input) => paymentBookingProvider.payableInPeriod(db, input),
          },
          pointsAvailable: async (_db, clientId, at, bookingId) => {
            const c = await staff.pool.connect();
            try {
              return await loyaltyAvailableForBooking(c, clientId, at, bookingId);
            } finally {
              c.release();
            }
          },
          ...(certPepper
            ? { certificates: { pepper: certPepper, verify: (input, meta) => verifyCertificatePin(staff.pool, input, { pepper: certPepper, meta, ...(staff.clock ? { clock: staff.clock } : {}) }) } }
            : {}),
          ...(staff.clock ? { clock: staff.clock } : {}),
        }),
      { prefix: '/api/crm/v1' },
    );
    if (deps.certificates) {
      const pepper = deps.certificates.pepper;
      void app.register(
        async (scope) =>
          certificateCrmRoutes(scope, {
            pool: staff.pool,
            pepper,
            ...(staff.clock ? { clock: staff.clock } : {}),
            authenticate: (request, reply) => authenticate(staff, request, reply),
          }),
        { prefix: '/api/crm/v1' },
      );
    }
    void app.register(
      async (scope) =>
        resourcesRoutes(scope, {
          pool: staff.pool,
          usage: bookingsProvider,
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
        bookingCrmRoutes(scope, {
          pool: staff.pool,
          ...(staff.clock ? { clock: staff.clock } : {}),
          authenticate: (request, reply) => authenticate(staff, request, reply),
        }),
      { prefix: '/api/crm/v1' },
    );
    void app.register(
      async (scope) => blockListRoutes(scope, { pool: staff.pool, authenticate: (request, reply) => authenticate(staff, request, reply) }),
      { prefix: '/api/crm/v1' },
    );
    void app.register(
      async (scope) =>
        clientCrmRoutes(scope, { pool: staff.pool, links: clientBranchLinks, authenticate: (request, reply) => authenticate(staff, request, reply) }),
      { prefix: '/api/crm/v1/clients' },
    );
    // K19 №350: закрытые вложения – выдача только через API с правом на объект-владелец
    if (deps.attachments) {
      const store = deps.attachments.store;
      void app.register(
        async (scope) =>
          attachmentCrmRoutes(scope, {
            pool: staff.pool,
            store,
            ...(staff.clock ? { clock: staff.clock } : {}),
            authenticate: (request, reply) => authenticate(staff, request, reply),
          }),
        { prefix: '/api/crm/v1' },
      );
    }
    // K15 №24–28: бонусный счёт и товары за баллы; зона клиента – через брони (clientBranchLinks)
    void app.register(
      async (scope) =>
        loyaltyCrmRoutes(scope, {
          pool: staff.pool,
          links: clientBranchLinks,
          ...(staff.clock ? { clock: staff.clock } : {}),
          authenticate: (request, reply) => authenticate(staff, request, reply),
        }),
      { prefix: '/api/crm/v1' },
    );
  }

  if (deps.network) {
    const network = deps.network;
    void app.register(async (scope) => networkPublicRoutes(scope, network), { prefix: '/api/public/v1' });
  }

  if (deps.clients) {
    // K5: при входе удержания посетителя переходят к клиенту (attach в транзакции входа).
    const clients: ClientPublicDeps = { ...deps.clients, hooks: { onLogin: attachVisitorHolds, ...deps.clients.hooks } };
    void app.register(async (scope) => clientPublicRoutes(scope, clients), { prefix: '/api/public/v1' });
    const push = deps.notifications ?? { vapidPublicKey: null };
    void app.register(async (scope) => notificationPublicRoutes(scope, { clients, ...push }), { prefix: '/api/public/v1' });
    // ЛК «Мои сертификаты» (K16 §8): только чтение, CERT_PEPPER не нужен
    void app.register(async (scope) => certificatePublicRoutes(scope, clients), { prefix: '/api/public/v1' });
    // K15 §11: баллы в ЛК – баланс, история, резерв на своё удержание, каталог
    void app.register(async (scope) => loyaltyPublicRoutes(scope, { clients, bookings: paymentBookingProvider }), { prefix: '/api/public/v1' });
    void app.register(
      async (scope) =>
        bookingPublicRoutes(scope, {
          pool: clients.pool as Parameters<typeof bookingPublicRoutes>[1]['pool'],
          ...(clients.clock ? { clock: clients.clock } : {}),
          identify: async (request, reply) => {
            if (!/(?:^|;\s*)yu_client=/.test(request.headers.cookie ?? '')) return null;
            try {
              return { clientId: (await authenticateClient(clients, request, reply)).clientId };
            } catch (err) {
              if (err instanceof AppError && err.code === 'SESSION_REVOKED') return null;
              throw err;
            }
          },
        }),
      { prefix: '/api/public/v1' },
    );
  }

  return app;
}

/** Зависимости из окружения: пул yu_app (search_path=app,journal – model-dannyh §0), вход сотрудников и клиентов.
 *  SMS: APP_ENV=prod – боевой адаптер (провайдер не выбран, R-18 → 503); stage и dev – тестовый (код в лог сервера). */
export function depsFromConfig(config: Config): { deps: ServerDeps; close: () => Promise<void>; sender?: SenderDeps } {
  if (!config.DATABASE_URL) return { deps: {}, close: async () => {} };
  const pool = new pg.Pool({ connectionString: config.DATABASE_URL, options: '-c search_path=app,journal', max: 10 });
  const deps: ServerDeps = { network: { pool } };
  // Пара VAPID проверяется здесь: несовпадение ключей – ошибка запуска, а не тихий отказ всех отправок.
  const vapid =
    config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY && config.VAPID_SUBJECT
      ? vapidKeys(config.VAPID_PUBLIC_KEY, config.VAPID_PRIVATE_KEY, config.VAPID_SUBJECT)
      : null;
  deps.notifications = { vapidPublicKey: vapid?.publicKey ?? null, allowedPushHosts: config.PUSH_ENDPOINT_HOSTS ?? DEFAULT_PUSH_HOSTS };
  if (config.CERT_PEPPER) deps.certificates = { pepper: config.CERT_PEPPER };
  // K19 №350: каталог создаётся при первой записи (mkdir в адаптере); без входа сотрудников маршруты не подключаются
  deps.attachments = { store: createFileStore({ root: config.ATTACHMENTS_DIR }) };
  if (config.SESSION_PEPPER) {
    deps.staff = { pool, auth: staffAuthConfig(config.SESSION_PEPPER) };
    const sms =
      config.APP_ENV === 'prod' ? unconfiguredSmsSender : createDevSmsSender(config.APP_ENV, (line) => console.info(line));
    deps.clients = { pool, auth: clientAuthConfig(config.SESSION_PEPPER), sms };
  }
  // Диспетчер уведомлений работает и без VAPID: строки получают статус «нет канала» и остаются в ЛК.
  // sender здесь – только для предупреждения о VAPID при старте; отправляет worker (startWorkerTasks, с bookingLookup)
  return { deps, close: () => pool.end(), sender: { pool, vapid } };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const { deps, close, sender } = depsFromConfig(config);
  // Способ certificate (K10 §5) – здесь, а не в registerModuleHooks: нужен CERT_PEPPER; один раз на процесс.
  if (config.CERT_PEPPER) registerPaymentMethod(createCertificatePaymentMethod({ pepper: config.CERT_PEPPER }));
  const app = buildServer(config, deps);
  if (!deps.staff) app.log.warn('Вход сотрудников выключен: нужны DATABASE_URL и SESSION_PEPPER');
  if (!config.CERT_PEPPER) app.log.warn('Оплата сертификатом выключена: нет CERT_PEPPER');
  if (sender && !sender.vapid) app.log.warn('Web Push выключен: нет VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY/VAPID_SUBJECT');
  // Диспетчер уведомлений, outbox и истечение удержаний – в отдельном процессе apps/api/src/worker.ts.
  app.addHook('onClose', async () => {
    await close();
  });
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

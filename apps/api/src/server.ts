import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { loadConfig, type Config } from './config.ts';
import { AppError } from './core/errors.ts';
import './core/registry.ts'; // проверка реестров модулей на дубли – при старте (ADR 0002)
import { blockRoutes } from './modules/booking/blocks.ts';
import { blockListRoutes } from './modules/booking/blocks.routes.list.ts';
import { clientAuthConfig, createDevSmsSender, unconfiguredSmsSender } from './modules/clients/otp.ts';
import { registerBookingGate } from './modules/clients/index.ts';
import { registerClientAnonymizer } from './modules/clients/anonymize.ts';
import { bookingClientAnonymizer } from './modules/booking/anonymize.ts';
import { eventsClientAnonymizer } from './modules/events/anonymize.ts';
import { registerClientMerger } from './modules/clients/merge.ts';
import { bookingClientMerger } from './modules/booking/merge.ts';
import { financeClientMerger } from './modules/finance/merge.ts';
import { loyaltyClientMerger } from './modules/loyalty/merge.ts';
import { certificatesClientMerger } from './modules/certificates/merge.ts';
import { eventsClientMerger } from './modules/events/merge.ts';
import { notificationsClientMerger } from './modules/notifications/merge.ts';
import { anonymizeClientNotifications } from './modules/notifications/campaign-runner.ts';
import { clientCrmRoutes } from './modules/clients/routes.crm.ts';
import { authenticateClient, clientPublicRoutes, type ClientPublicDeps } from './modules/clients/routes.public.ts';
import { attachVisitorHolds } from './modules/booking/hold.ts';
import { createFileStore, type FileStore } from './core/files.ts';
import { createDeepHealth, type HealthThresholds } from './core/health.ts';
import { attachmentCrmRoutes } from './modules/attachments/routes.crm.ts';
import { registerEventSummaries } from './modules/equipment/items.ts';
import { equipmentCrmRoutes } from './modules/equipment/routes.crm.ts';
import { registerEquipmentAttachmentOwners, repairCrmRoutes } from './modules/equipment/routes.repairs.ts';
import { mediaRoutes } from './modules/content/routes.media.ts';
import { catalogCrmRoutes } from './modules/content/routes.crm.catalog.ts';
import { publicationCrmRoutes } from './modules/content/routes.crm.publications.ts';
import { contentInternalRoutes } from './modules/content/routes.internal.ts';
import { contentPublicRoutes } from './modules/content/routes.public.ts';
import { bookingCrmRoutes } from './modules/booking/routes.crm.ts';
import { createReportsPool } from './modules/reports/framework.ts';
import { reportsExportRoutes } from './modules/reports/routes.crm.export.ts';
import { reportsCrmRoutes } from './modules/reports/routes.crm.ts';
import { bookingPublicRoutes } from './modules/booking/routes.public.ts';
import { bookingLookup, bookingsProvider, clientBranchLinks, paymentBookingProvider } from './modules/booking/providers.ts';
import { calendarTargets } from './modules/resources/index.ts';
import type { NetworkLookup } from './core/permissions.ts';
import { dictionaryRoutes } from './modules/dictionaries/routes.ts';
import { registerEventAttachmentOwner } from './modules/events/attachments.ts';
import { eventSummaries } from './modules/events/events.ts';
import { registerGiftGrant } from './modules/events/gift-booking.ts';
import { ensureGiftResource } from './modules/events/gift-resource.ts';
import { registerEventSources } from './modules/events/resources.ts';
import { giftCrmRoutes, giftPublicRoutes } from './modules/events/routes.gifts.ts';
import { eventCrmRoutes } from './modules/events/routes.crm.ts';
import { eventPublicRoutes } from './modules/events/routes.public.ts';
import { registerPaymentMethod } from './modules/finance/methods.ts';
import { paymentLookup } from './modules/finance/payment.ts';
import { loyaltyGate } from './modules/loyalty/gate.ts';
import { pointsAvailableForBooking, pointsPaymentMethod, setPointsPaymentDeps } from './modules/loyalty/payment-method.ts';
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
import { createCertificatePaymentMethod, verifyCertificatePin } from './modules/certificates/payment-method.ts';
import { certificateCrmRoutes } from './modules/certificates/routes.crm.ts';
import { certificatePublicRoutes } from './modules/certificates/routes.public.ts';
import { DEFAULT_PUSH_HOSTS } from './modules/notifications/index.ts';
import { notificationCrmRoutes } from './modules/notifications/routes.crm.ts';
import { notificationPublicRoutes } from './modules/notifications/routes.public.ts';
import type { SenderDeps } from './modules/notifications/sender.ts';
import { vapidKeys } from './modules/notifications/webpush.ts';
import { staffAuthConfig } from './modules/staff/auth.ts';
import { shiftsCrmRoutes } from './modules/shifts/routes.crm.ts';
import { payrollCrmRoutes } from './modules/shifts/routes.payroll.ts';
import { authenticate, staffAuthRoutes, staffMeRoutes, type StaffDeps } from './modules/staff/routes.crm.ts';
import { staffAdminRoutes } from './modules/staff/routes.staff.ts';

export interface ServerDeps {
  staff?: StaffDeps;
  clients?: ClientPublicDeps;
  /** Публичная сеть для сайта (K5 №1–4) – без входа, нужна только база. */
  network?: NetworkPublicDeps;
  /** Web Push (S1-15): открытый ключ VAPID (null – не настроен, подписка 503) и разрешённые push-сервисы. Нужны clients. */
  notifications?: { vapidPublicKey: string | null; allowedPushHosts?: readonly string[]; unsubscribeSecret?: string | null };
  /** Сертификаты (K16): CERT_PEPPER – HMAC кода. Нет – маршруты сертификатов не подключаются. */
  certificates?: { pepper: string };
  /** Вложения Э3 (K19 №350): адаптер диска с корнем ATTACHMENTS_DIR вне веб-корня. Нет – маршруты не подключаются. */
  attachments?: { store: FileStore };
  /** Пул отчётов K24 §9 под ролью yu_reports. Нет – маршруты отчётов не подключаются (нужен и staff). */
  reports?: { pool: pg.Pool; /** Каталог EXPORT_DIR (K24 §7). Нет – маршрутов экспорта нет. */ exportStore?: FileStore };
  /** CMS (K22): медиатека – адаптер диска с корнем MEDIA_DIR и квотой. Нет – маршруты медиа не подключаются. */
  content?: { mediaStore: FileStore; previewSecret?: string };
  /** Куда писать лог (по умолчанию stdout) – тесты проверяют, что код и токен в лог не попадают. */
  logStream?: NodeJS.WritableStream;
  /** GET /health/deep (core/health.ts): пороги и срок кэша – тесты; по умолчанию DEFAULT_THRESHOLDS и 5 с. */
  health?: { thresholds?: Partial<HealthThresholds>; cacheMs?: number };
}

/** Реестры модулей на процесс (ворота записи K9, способы оплаты K10 §5), а buildServer зовут повторно (тесты) –
 *  регистрируем один раз. Модули друг друга не импортируют (ADR 0002): связывает их только этот файл. */
let hooksRegistered = false;
function registerModuleHooks(): void {
  if (hooksRegistered) return;
  registerBookingGate(loyaltyGate); // K15 §8: −50 → LOYALTY_LIMIT_REACHED
  registerPaymentMethod(pointsPaymentMethod); // K15 §6: оплата сеанса баллами
  setPointsPaymentDeps({ bookings: paymentBookingProvider, payments: paymentLookup }); // доля резерва удержания брони
  registerEquipmentAttachmentOwners(); // K19 §9: вложения оборудования и ремонта
  registerEventAttachmentOwner(); // K19 §9, 11 §11.4: документ к расходу мероприятия
  registerEventSources(); // K6, K20 §4: блокировка видит мероприятие по строке занятости (S3-52)
  registerEventSummaries(eventSummaries); // K19 §18: номер, статус и время затронутого мероприятия в предложении блокировки
  registerGiftGrant(); // K5, K20 §8.2: подарочный ресурс открывается только правом подарка
  // K9 «Обезличивание»: ПДн и живые записи клиента в чужих таблицах (K20 §14, K21 §15); без любого процедура не запускается
  registerClientAnonymizer(bookingClientAnonymizer);
  registerClientAnonymizer(eventsClientAnonymizer);
  registerClientAnonymizer({ name: 'notifications', run: anonymizeClientNotifications });
  // K9 «Слияние»: перенос записей второй карточки модулями-владельцами таблиц; без любого процедура не запускается
  for (const m of [bookingClientMerger, financeClientMerger, loyaltyClientMerger, certificatesClientMerger, eventsClientMerger, notificationsClientMerger]) {
    registerClientMerger(m);
  }
  hooksRegistered = true;
}

/** K1: назначение на город раскрывается в филиалы, дата назначения – по зоне цели (modules/network). */
export const networkLookup: NetworkLookup = { branchesOfCities: branchIdsOfCities, timezonesOf };

/** Параметры запроса, чьи значения в лог не пишутся (ПДн и секреты в строке поиска CRM и ЛК): остаётся имя и `*`. */
const MASKED_QUERY = new Set(['q', 'phone', 'email', 'name', 'number', 'pin', 'code', 't', 'token']);

/** Лог запроса как у Fastify по умолчанию, но без токена отписки (?t= №205 – действующий ключ отказа от рекламы, K21 §4, K2 правило 4)
 *  и без значений поисковых и контактных параметров (tests/api/request-hygiene.test.ts). */
function logUrl(raw: string): string {
  const at = raw.indexOf('?');
  if (at < 0) return raw;
  const path = raw.slice(0, at);
  if (path.startsWith('/api/public/v1/unsubscribe')) return path;
  const query = raw
    .slice(at + 1)
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      const name = eq < 0 ? pair : pair.slice(0, eq);
      return MASKED_QUERY.has(name.toLowerCase()) ? `${name}=*` : pair;
    })
    .join('&');
  return `${path}?${query}`;
}

const logSerializers = {
  req(req: FastifyRequest) {
    return { method: req.method, url: logUrl(req.url), host: req.host, remoteAddress: req.ip, remotePort: req.socket?.remotePort };
  },
};

export function buildServer(config: Config, deps: ServerDeps = {}): FastifyInstance {
  registerModuleHooks();
  // trustProxy – только список доверенных: иначе за Caddy у всех один request.ip и 51 неудача закроет вход всем.
  const app = Fastify({
    logger: deps.logStream ? { level: config.LOG_LEVEL, stream: deps.logStream, serializers: logSerializers } : { level: config.LOG_LEVEL, serializers: logSerializers },
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
    // 17 §13.2: JSON с кодом, маршрутом и reqId (метка pino), без тела запроса и без detail/where ошибок pg –
    // там значения строк (телефон, email). Стек и SQL-код ошибки – для разбора.
    const e = err as Error & { code?: unknown };
    request.log.error(
      { code: 'INTERNAL', method: request.method, route: request.routeOptions.url ?? 'unknown', error: { type: e.name, message: e.message, pgCode: typeof e.code === 'string' ? e.code : undefined, stack: e.stack } },
      'необработанная ошибка API',
    );
    return reply.code(500).send({ error: { code: 'INTERNAL', message: 'Внутренняя ошибка', requestId: request.id } });
  });

  // Неизвестный маршрут – то же тело, что NOT_FOUND объекта: без «Route GET:/… not found» фреймворка (перебор маршрутов снаружи
  // не отличает «нет маршрута» от «нет объекта»).
  app.setNotFoundHandler((request, reply) => reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Не найдено', requestId: request.id } }));

  app.get('/health', async () => ({ status: 'ok', version: config.GIT_SHA }));
  // 17 §13.1: база, outbox, пульс worker и очередь, диск, ошибки сервисных уведомлений – без авторизации, без ПДн и секретов.
  // Тело: { status, version, checkedAt, checks } – status первым ключом (scripts/monitor-check.sh читает его без jq); down → 503.
  const deepHealth = createDeepHealth({
    pool: deps.network?.pool ?? deps.staff?.pool,
    version: config.GIT_SHA,
    dirs: { media: config.MEDIA_DIR, attachments: config.ATTACHMENTS_DIR },
    ...(deps.health?.thresholds ? { thresholds: deps.health.thresholds } : {}),
    ...(deps.health?.cacheMs !== undefined ? { cacheMs: deps.health.cacheMs } : {}),
  });
  app.get('/health/deep', async (_request, reply) => {
    const r = await deepHealth();
    return reply.code(r.status === 'down' ? 503 : 200).header('cache-control', 'no-store').send(r);
  });

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
              // удержание брони – через провайдер booking (ADR 0002): до обработки booking.confirmed доля этой брони в его резерве – её
              const holdId = (await paymentBookingProvider.payableBooking(c, bookingId))?.holdId ?? null;
              return await pointsAvailableForBooking(c, clientId, at, bookingId, holdId);
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
          // K20 §8.2: новое VR-место может сделать комнату VR-комнатой – подарочный ресурс и тариф 0 ₽ появляются сами
          onResourceCreated: async (tx, ctx, resource, meta, clock) => {
            if (resource.type === 'vr_seat') await ensureGiftResource(tx, ctx, resource.branchId, meta, clock);
          },
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
        clientCrmRoutes(scope, {
          pool: staff.pool,
          links: clientBranchLinks,
          ...(staff.clock ? { clock: staff.clock } : {}),
          authenticate: (request, reply) => authenticate(staff, request, reply),
        }),
      { prefix: '/api/crm/v1/clients' },
    );
    // K19 №331–337: оборудование (S3-33)
    void app.register(
      async (scope) =>
        equipmentCrmRoutes(scope, {
          pool: staff.pool,
          ...(staff.clock ? { clock: staff.clock } : {}),
          authenticate: (request, reply) => authenticate(staff, request, reply),
        }),
      { prefix: '/api/crm/v1' },
    );
    // K19 №341–349: ремонт (S3-39)
    void app.register(
      async (scope) =>
        repairCrmRoutes(scope, {
          pool: staff.pool,
          ...(staff.clock ? { clock: staff.clock } : {}),
          authenticate: (request, reply) => authenticate(staff, request, reply),
        }),
      { prefix: '/api/crm/v1' },
    );
    // K19 №350: закрытые вложения – выдача только через API с правом на объект-владелец
    if (deps.content) {
      const store = deps.content.mediaStore;
      const contentCrm = {
        pool: staff.pool,
        previewSecret: deps.content.previewSecret,
        ...(staff.clock ? { clock: staff.clock } : {}),
        authenticate: (request: FastifyRequest, reply: FastifyReply) => authenticate(staff, request, reply),
      };
      void app.register(async (scope) => publicationCrmRoutes(scope, contentCrm), { prefix: '/api/crm/v1' });
      void app.register(async (scope) => catalogCrmRoutes(scope, contentCrm), { prefix: '/api/crm/v1' });
      void app.register(
        async (scope) =>
          mediaRoutes(scope, {
            pool: staff.pool,
            store,
            ...(staff.clock ? { clock: staff.clock } : {}),
            authenticate: (request, reply) => authenticate(staff, request, reply),
          }),
        { prefix: '/api/crm/v1' },
      );
    }
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
    // K24 §10: отчёты – только с пулом yu_reports (REPORTS_DATABASE_URL)
    if (deps.reports) {
      const reports = deps.reports.pool;
      void app.register(
        async (scope) =>
          reportsCrmRoutes(scope, {
            pool: staff.pool,
            reports,
            ...(staff.clock ? { clock: staff.clock } : {}),
            authenticate: (request, reply) => authenticate(staff, request, reply),
          }),
        { prefix: '/api/crm/v1' },
      );
      // K24 §7, K11 №243–247: экспорт – файл считает worker, здесь постановка и скачивание
      const exportStore = deps.reports.exportStore;
      if (exportStore) {
        void app.register(
          async (scope) =>
            reportsExportRoutes(scope, {
              pool: staff.pool,
              store: exportStore,
              ...(staff.clock ? { clock: staff.clock } : {}),
              authenticate: (request, reply) => authenticate(staff, request, reply),
            }),
          { prefix: '/api/crm/v1' },
        );
      }
    }
    // K21 §11, K11 №201–212: кампании, журнал отправок, шаблоны, сводка клиента
    void app.register(
      async (scope) =>
        notificationCrmRoutes(scope, {
          pool: staff.pool,
          ...(staff.clock ? { clock: staff.clock } : {}),
          network: staff.network ?? networkLookup,
          bookings: bookingLookup,
          unsubscribeSecret: deps.notifications?.unsubscribeSecret ?? null,
          authenticate: (request, reply) => authenticate(staff, request, reply),
        }),
      { prefix: '/api/crm/v1' },
    );
    // K20 №361–370: мероприятия
    void app.register(
      async (scope) =>
        eventCrmRoutes(scope, {
          pool: staff.pool,
          ...(staff.clock ? { clock: staff.clock } : {}),
          authenticate: (request, reply) => authenticate(staff, request, reply),
        }),
      { prefix: '/api/crm/v1' },
    );
    // K20 №376–379: подарок имениннику, праздничный календарь
    void app.register(
      async (scope) =>
        giftCrmRoutes(scope, {
          pool: staff.pool,
          ...(staff.clock ? { clock: staff.clock } : {}),
          authenticate: (request, reply) => authenticate(staff, request, reply),
        }),
      { prefix: '/api/crm/v1' },
    );
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
    // K18 №301–310: смены, покрытие, ставки, «временно не работает»
    void app.register(
      async (scope) =>
        shiftsCrmRoutes(scope, {
          pool: staff.pool,
          ...(staff.clock ? { clock: staff.clock } : {}),
          authenticate: (request, reply) => authenticate(staff, request, reply),
        }),
      { prefix: '/api/crm/v1' },
    );
    // K18 №311–318: периоды, ведомости, выплата, расход, штрафы, корректировки, отчёт; журнал ПДн зарплаты
    void app.register(
      async (scope) =>
        payrollCrmRoutes(scope, {
          pool: staff.pool,
          ...(staff.clock ? { clock: staff.clock } : {}),
          authenticate: (request, reply) => authenticate(staff, request, reply),
        }),
      { prefix: '/api/crm/v1' },
    );
  }

  if (deps.network) {
    const network = deps.network;
    void app.register(async (scope) => networkPublicRoutes(scope, network), { prefix: '/api/public/v1' });
    void app.register(async (scope) => contentPublicRoutes(scope, network), { prefix: '/api/public/v1' }); // K22 §12: без сессии, только живые версии
    // K22 §11: черновик для предпросмотра – только по внутренней сети и только с секретом; без PREVIEW_SECRET маршрута нет
    const previewSecret = deps.content?.previewSecret;
    if (previewSecret) {
      void app.register(async (scope) => contentInternalRoutes(scope, { ...network, previewSecret }), { prefix: '/api/internal/v1' });
    }
  }

  if (deps.clients) {
    // K5: при входе удержания посетителя переходят к клиенту (attach в транзакции входа).
    const clients: ClientPublicDeps = { ...deps.clients, hooks: { onLogin: attachVisitorHolds, ...deps.clients.hooks } };
    void app.register(async (scope) => clientPublicRoutes(scope, clients), { prefix: '/api/public/v1' });
    const push = deps.notifications ?? { vapidPublicKey: null };
    void app.register(async (scope) => notificationPublicRoutes(scope, { clients, bookings: bookingLookup, ...push }), { prefix: '/api/public/v1' });
    // ЛК «Мои сертификаты» (K16 §8): только чтение, CERT_PEPPER не нужен
    void app.register(async (scope) => certificatePublicRoutes(scope, clients), { prefix: '/api/public/v1' });
    // K20 П1–П2: «Мой подарок» – не сертификат: свой адрес и свой номер
    void app.register(async (scope) => giftPublicRoutes(scope, clients), { prefix: '/api/public/v1' });
    // K20 П3–П5: мои мероприятия, заявка на праздник и сведения для /birthday/
    void app.register(async (scope) => eventPublicRoutes(scope, clients), { prefix: '/api/public/v1' });
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
  // без обработчика ошибка простаивающего соединения роняет процесс API (как в worker.ts)
  pool.on('error', (err) => console.error('пул yu_app: ошибка простаивающего соединения', err.message));
  const deps: ServerDeps = { network: { pool } };
  // Пара VAPID проверяется здесь: несовпадение ключей – ошибка запуска, а не тихий отказ всех отправок.
  const vapid =
    config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY && config.VAPID_SUBJECT
      ? vapidKeys(config.VAPID_PUBLIC_KEY, config.VAPID_PRIVATE_KEY, config.VAPID_SUBJECT)
      : null;
  deps.notifications = { vapidPublicKey: vapid?.publicKey ?? null, allowedPushHosts: config.PUSH_ENDPOINT_HOSTS ?? DEFAULT_PUSH_HOSTS, unsubscribeSecret: config.UNSUBSCRIBE_SECRET ?? null };
  if (config.CERT_PEPPER) deps.certificates = { pepper: config.CERT_PEPPER };
  // K19 №350: каталог создаётся при первой записи (mkdir в адаптере); без входа сотрудников маршруты не подключаются
  deps.attachments = { store: createFileStore({ root: config.ATTACHMENTS_DIR }) };
  deps.content = {
    mediaStore: createFileStore({ root: config.MEDIA_DIR, quota: { maxBytes: Math.round(config.MEDIA_QUOTA_GB * 1024 ** 3), code: 'MEDIA_QUOTA_EXCEEDED' } }),
    ...(config.PREVIEW_SECRET ? { previewSecret: config.PREVIEW_SECRET } : {}),
  };
  if (config.SESSION_PEPPER) {
    deps.staff = { pool, auth: staffAuthConfig(config.SESSION_PEPPER) };
    const sms =
      config.APP_ENV === 'prod' ? unconfiguredSmsSender : createDevSmsSender(config.APP_ENV, (line) => console.info(line));
    deps.clients = { pool, auth: clientAuthConfig(config.SESSION_PEPPER), sms };
  }
  // Диспетчер уведомлений работает и без VAPID: строки получают статус «нет канала» и остаются в ЛК.
  // sender здесь – только для предупреждения о VAPID при старте; отправляет worker (startWorkerTasks, с bookingLookup)
  const reportsPool = config.REPORTS_DATABASE_URL
    ? createReportsPool(config.REPORTS_DATABASE_URL, config.REPORTS_POOL_MAX, { screen: config.REPORTS_SCREEN_MAX, export: config.REPORTS_EXPORT_MAX, waitMs: config.REPORTS_BUSY_WAIT_MS })
    : null;
  if (reportsPool) deps.reports = { pool: reportsPool, exportStore: createFileStore({ root: config.EXPORT_DIR }) };
  const close = async () => {
    await reportsPool?.end();
    await pool.end();
  };
  return { deps, close, sender: { pool, vapid } };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const { deps, close, sender } = depsFromConfig(config);
  // Способ certificate (K10 §5) – здесь, а не в registerModuleHooks: нужен CERT_PEPPER; один раз на процесс.
  if (config.CERT_PEPPER) registerPaymentMethod(createCertificatePaymentMethod({ pepper: config.CERT_PEPPER }));
  const app = buildServer(config, deps);
  if (!deps.staff) app.log.warn('Вход сотрудников выключен: нужны DATABASE_URL и SESSION_PEPPER');
  if (!config.CERT_PEPPER) app.log.warn('Оплата сертификатом выключена: нет CERT_PEPPER');
  if (!config.UNSUBSCRIBE_SECRET) app.log.warn('Реклама выключена: нет UNSUBSCRIBE_SECRET (K21 §13)');
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

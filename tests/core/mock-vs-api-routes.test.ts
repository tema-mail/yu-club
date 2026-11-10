// Сверка моков экранов с настоящим API (11.11.2026), без браузера и без базы.
// Было: экраны Э4 гонялись Playwright только на моках, а мок вручную повторяет API – экран CRM «Вернуть из архива»
// города и филиала звал POST /cities/:id/restore и /branches/:id/restore, которых в API нет (на бою – 404), и e2e был зелёным.
// Тест собирает оба мока (apps/crm/tests/mock-api.ts, apps/site/tests/mock-api.ts) и API (buildServer с зависимостями как
// на бою – depsFromConfig: пулы создаются, но не подключаются) и требует: каждый маршрут мока (метод + путь, имена
// параметров не важны) есть в API. Префиксы у мока и API одни: CRM и сайт проксируют /api/crm/v1/* и /api/public/v1/*
// без переписывания пути (apps/<app>/src/pages/api/.../[...path].ts), SSR ходит в API_URL с теми же путями (lib/api.ts).
// Маршрута нет в API – чини экран и мок по API; служебные ручки мока – только в EXCEPTIONS с причиной.
import diagnostics from 'node:diagnostics_channel';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, RouteOptions } from 'fastify';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import { buildServer, depsFromConfig } from '../../apps/api/src/server.ts';
import { buildMock as buildCrmMock } from '../../apps/crm/tests/mock-api.ts';
import { buildMock as buildSiteMock } from '../../apps/site/tests/mock-api.ts';

/** Служебные маршруты мока: в API их нет намеренно. Ключ – «МЕТОД путь» после normalize(). */
const EXCEPTIONS: Record<'crm' | 'site', Record<string, string>> = {
  crm: {
    'POST /__test/reset': 'сброс состояния мока перед спеком',
    'POST /__test/event-money': 'засев денег мероприятия для спека event-money',
    'POST /__test/staff-feed/add': 'событие зоны в ленту сотрудника (в API его кладёт обработчик repair.registered)',
    'POST /__test/notifications/audience-grow': 'рост аудитории между предпросмотром и подтверждением – проверка AUDIENCE_CHANGED',
    'POST /__test/media-remove-fails': 'сбой удаления файла медиа – проверка повтора очистки',
  },
  site: {
    'POST /__mock/sitemap-down': 'имитация молчащего API для sitemap.spec.ts (карта – 503)',
    'POST /__mock/content': 'подмена контента публичного API под спек',
    'POST /__test/booking-reset': 'сброс броней мока',
    'POST /__test/fail-next': 'следующий запрос записи отвечает заданной ошибкой',
    'GET /__test/bookings': 'что мок записал – проверка спеком',
    'POST /__test/resources-empty': 'филиал без ресурсов – пустое состояние экрана',
    'GET /__test/last-xff': 'какой X-Forwarded-For дошёл до API через прокси сайта',
    'GET /__test/consents': 'какие согласия записал мок – проверка спеком',
    'GET /__test/push-calls': 'какие вызовы push дошли до API',
    'POST /__test/commerce-reset': 'сброс баллов и сертификатов мока',
    'POST /__test/inbox-reset': 'сброс входящих ЛК мока',
    'GET /__test/inbox-calls': 'какие вызовы входящих дошли до API',
    'GET /__test/unsubscribe-token': 'токен отписки (в API его подписывает sender.ts и кладёт в push)',
    'POST /__test/events-reset': 'сброс мероприятий мока',
    'POST /__test/party-config': 'настройки праздника под спек',
    'GET /__test/event-requests': 'какие заявки на праздник записал мок',
  },
};

type Key = string;

/** Имена параметров (и их regex) не важны: /x/:id и /x/:branchId – один маршрут. HEAD Fastify добавляет к GET сам. */
const normalize = (method: string, url: string): Key => `${method} ${url.replace(/:[A-Za-z0-9_]+(\([^)]*\))?/g, ':p')}`;

// onRoute надо повесить до первого маршрута – ловим создание экземпляра Fastify (канал fastify.initialization).
let sink: Set<Key> | null = null;
diagnostics.subscribe('fastify.initialization', (msg) => {
  const target = sink;
  if (!target) return;
  (msg as { fastify: FastifyInstance }).fastify.addHook('onRoute', (r: RouteOptions) => {
    for (const m of [r.method].flat()) if (m !== 'HEAD') target.add(normalize(String(m), r.url));
  });
});

async function routesOf(build: () => FastifyInstance): Promise<Set<Key>> {
  const out = new Set<Key>();
  sink = out;
  let app: FastifyInstance;
  try {
    app = build();
    await app.ready();
  } finally {
    sink = null;
  }
  await app.close();
  return out;
}

async function apiRoutes(): Promise<Set<Key>> {
  const secret = 's'.repeat(40);
  const dir = join(tmpdir(), 'yu-mock-vs-api');
  // Все необязательные модули включены (CERT_PEPPER, PREVIEW_SECRET, отчёты, экспорт); база не нужна – пулы ленивые.
  const config = loadConfig({
    LOG_LEVEL: 'silent', DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none', REPORTS_DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none',
    SESSION_PEPPER: secret, CERT_PEPPER: secret, PREVIEW_SECRET: secret, UNSUBSCRIBE_SECRET: secret, MEDIA_DIR: dir, ATTACHMENTS_DIR: dir, EXPORT_DIR: dir,
  });
  const { deps, close } = depsFromConfig(config);
  try {
    return await routesOf(() => buildServer(config, deps));
  } finally {
    await close();
  }
}

const api = await apiRoutes();
const mocks = { crm: await routesOf(buildCrmMock), site: await routesOf(buildSiteMock) };

describe('моки экранов против маршрутов API', () => {
  it('API собран со всеми модулями', () => {
    for (const k of ['GET /api/crm/v1/me', 'GET /api/crm/v1/reports/dashboard', 'POST /api/crm/v1/content/media', 'GET /api/public/v1/branches', 'GET /api/internal/v1/content/preview/*']) {
      expect(api.has(k), k).toBe(true);
    }
  });

  describe.each(['crm', 'site'] as const)('мок %s', (app) => {
    it('каждый маршрут мока есть в API (или в списке служебных)', () => {
      const routes = mocks[app];
      expect(routes.size).toBeGreaterThan(app === 'crm' ? 250 : 50);
      const missing = [...routes].filter((k) => !api.has(k) && !Object.hasOwn(EXCEPTIONS[app], k)).sort();
      expect(missing).toEqual([]);
    });

    it('список служебных без мёртвых строк', () => {
      const stale = Object.keys(EXCEPTIONS[app]).filter((k) => !mocks[app].has(k) || api.has(k));
      expect(stale).toEqual([]);
    });
  });
});

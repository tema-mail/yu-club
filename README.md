# Ю-Клуб: сайт, личный кабинет и CRM сети компьютерных клубов

Монорепозиторий на npm workspaces: `apps/api` (Fastify, TypeScript без шага сборки), `apps/crm` и `apps/site` (Astro SSR + острова Preact), `packages/contracts`, `db` (SQL-миграции и засевы). База – PostgreSQL 16, фон – pg-boss в отдельном процессе `worker`. Пароли, ключи и адреса стенда в репозитории не лежат.

Главный документ для программистов – `docs/OTCHET-dlya-programmistov.md`: что написано, что нет, инварианты, известные дефекты. Начинать с него.

## Оглавление

1. Скачать и поднять локально
2. Тесты и проверки
3. Стенд
4. Где что лежит
5. Правила проекта

## 1. Скачать и поднять локально

Нужны Node ≥ 26 (`engines` в `package.json`; встроенный Temporal, TypeScript запускает сам Node) и npm. Docker на маке не нужен: тесты поднимают embedded-postgres сами.

```bash
git clone git@github.com:tema-mail/yu-club.git && cd yu-club
npm ci                                   # ставит и embedded-postgres (allowScripts в package.json)
npm run typecheck && npm run lint
```

Postgres для ручной разработки – `deploy/compose.dev.yml` (на сервере или машине с Docker):

```bash
POSTGRES_PASSWORD=... docker compose -f deploy/compose.dev.yml up -d
# роли до миграций – шапка compose.dev.yml (yu_app, yu_reports)
MIGRATION_DATABASE_URL=postgres://postgres:...@127.0.0.1:5432/yu_club node db/migrate.ts up
MIGRATION_DATABASE_URL=... node db/migrate.ts status
```

Запуск: `npm run dev:api` (окружение – `apps/api/src/config.ts`: `DATABASE_URL`, `SESSION_PEPPER`, `CERT_PEPPER`, `APP_ENV` и остальное), `npm run dev -w @yu/crm`, `npm run dev -w @yu/site` (переменная `API_URL`). Экран без API: `npm run mock -w @yu/crm` (мок `apps/crm/tests/mock-*.ts`) и `API_URL` на его порт. Первый Владелец – `apps/api/src/modules/staff/seed-owner.ts`, демо-данные – `APP_ENV=stage ... node db/seed/dev.ts` (на `prod` отказывает). Фоновый процесс – `node apps/api/src/worker.ts`.

## 2. Тесты и проверки

| Команда | Что | Где |
|---|---|---|
| `npm test` (`npx vitest run --maxWorkers=4`) | бэкенд на настоящей Postgres, каждый файл в своей базе | `tests/**` |
| `npm run test:crm` | экраны CRM на моке API, Playwright | `apps/crm/tests/*.spec.ts` |
| `npm run test:site` | сайт и ЛК на моке | `apps/site/tests/*.spec.ts` |
| `npm run test:perf` | тесты порогов времени | `vitest.perf.config.ts`, `tests/perf` |
| `npm run load:race`, `load:money`, `load:club`, `load:campaign`, `load:reports` | нагрузка и гонки, только локально | `tests/load/*.ts` |
| `npm run test:e2e:stand` | сквозные сценарии на живом стенде (`SITE_URL`, `CRM_URL`, ssh к стенду) | `tests/e2e/*.spec.ts` |
| `npm run build:crm`, `build:site` | сборка Astro | `apps/*/dist` |

Для Playwright один раз: `npx playwright install chromium`. CI (`.github/workflows/ci.yml`) гоняет typecheck, lint, сборки, `npm test` на сервисе postgres:16 (`TEST_DATABASE_URL`) и Playwright CRM и сайта.

Проверка данных после работы системы: `DATABASE_URL=... node apps/api/src/modules/reports/reconcile.ts` – код выхода 0, расхождения – 2.

## 3. Стенд

Выкладка одной командой `deploy/deploy.sh` (шапка скрипта – переменные и как переехать на другой сервер); `--reset-stage` пересоздаёт базу стенда и засевает её (`deploy/seed-stand.sh`), только при `APP_ENV=stage`. Контейнеры – `deploy/compose.yml`, общий Caddy – `deploy/Caddyfile.yu-club`, бэкап и проверка восстановления – `deploy/backup.sh`, `deploy/restore-check.sh`, копия вне сервера – `deploy/offsite-pull.sh`. Подробно: `docs/ekspluatatsiya/plan-zapuska-i-otkata.md`.

## 4. Где что лежит

| Что | Где |
|---|---|
| Главный отчёт для программистов | `docs/OTCHET-dlya-programmistov.md` |
| Техдолг для вывода в бой (сервер, ключи, юридическое, данные) | `docs/TEHDOLG-zapusk.md` |
| План разработки по шагам `S<этап>-<номер>` | `docs/plan-yu-club.md` |
| Контракты между модулями K1…K24 (важнее кода) | `docs/kontrakty/` |
| Архитектурные решения | `docs/adr/0001…0005` |
| Модель данных, карта сайта | `docs/model-dannyh.md`, `docs/karta-sayta.md` |
| Принятые умолчания и вопросы заказчику | `docs/reshenia.md`, `docs/voprosy-zakazchiku.md` |
| ТЗ (20 разделов) и его разбор | `tz/`, `docs/razbor/` |
| Эксплуатация: инструкции ролей, регламент сбоя, план запуска и отката, чек-лист наполнения, пилот | `docs/ekspluatatsiya/` |
| Права (роль × зона × действие) | `apps/api/src/core/permissions.ts` |
| Настройки с наследованием | `apps/api/src/core/settings.ts` |
| Модули API | `apps/api/src/modules/<модуль>/` |
| Экраны CRM и острова | `apps/crm/src/pages/`, `apps/crm/src/islands/` |
| Миграции и раннер | `db/migrations/NNNN_имя.sql`, `db/migrate.ts` |

## 5. Правила проекта

Коротко из OTCHET §10: контракты важнее кода; файл не длиннее 800 строк; шаг – не больше 3 файлов, с проверкой и коммитом; чужие таблицы только через провайдеры, отчёты только через `rpt_*`; новый маршрут – право, зона, аудит, идемпотентность, тест на чужой объект с 404; экран на моке не готов, пока не проверен на настоящем API; миграции только вперёд по номеру, применённый файл не меняется; сообщения коммитов на русском с номером шага.

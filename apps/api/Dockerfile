# Образ API yu-club. Сборка из корня репозитория:
#   docker build -f apps/api/Dockerfile --build-arg GIT_SHA=<коммит> -t yu-club-api .
# TypeScript запускает сам Node (снятие типов), шага сборки нет.
# Тот же образ гоняет миграции (node db/migrate.ts up – сервис migrate в deploy/compose.yml)
# и засев стенда (db/seed/dev.ts, apps/api/src/modules/staff/seed-owner.ts – deploy/seed-stand.sh).
FROM node:26-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/crm/package.json apps/crm/
COPY apps/site/package.json apps/site/
COPY packages/contracts/package.json packages/contracts/
COPY db/package.json db/
# только рабочие зависимости API и db (CRM – свой образ), скрипты пакетов не запускаем
RUN npm ci -w @yu/api -w @yu/db -w @yu/contracts --include-workspace-root=false --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:26-alpine
LABEL project=yu-club
WORKDIR /app
ENV NODE_ENV=production TZ=UTC HOST=0.0.0.0 PORT=3000
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY apps/api/package.json apps/api/
COPY apps/api/src apps/api/src
COPY db/package.json db/migrate.ts db/
COPY db/migrations db/migrations
COPY db/seed db/seed
COPY packages/contracts/src packages/contracts/src
ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=30s --start-interval=2s CMD wget -qO- http://127.0.0.1:3000/health >/dev/null || exit 1
CMD ["node", "apps/api/src/server.ts"]

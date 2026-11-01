# Образ CRM yu-club (Astro SSR, адаптер node standalone). Сборка из корня репозитория:
#   docker build -f apps/crm/Dockerfile -t yu-club-crm .
# Рантайм: API_URL (адрес API внутри сети), TRUSTED_PROXIES (чьему X-Forwarded-For верим), HOST/PORT.
FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/crm/package.json apps/crm/
COPY db/package.json db/
RUN npm ci -w @yu/crm --include-workspace-root=false --ignore-scripts --no-audit --no-fund
COPY apps/crm apps/crm
RUN npm run build -w @yu/crm

FROM node:26-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/crm/package.json apps/crm/
COPY db/package.json db/
RUN npm ci -w @yu/crm --include-workspace-root=false --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:26-alpine
LABEL project=yu-club
WORKDIR /app/apps/crm
ENV NODE_ENV=production TZ=UTC HOST=0.0.0.0 PORT=4321
COPY --from=deps /app/node_modules /app/node_modules
COPY --from=build /app/apps/crm/dist ./dist
COPY apps/crm/package.json ./
USER node
EXPOSE 4321
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=30s --start-interval=2s CMD wget -qO- http://127.0.0.1:4321/login >/dev/null || exit 1
CMD ["node", "dist/server/entry.mjs"]

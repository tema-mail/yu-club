# Образ CRM yu-club (Astro SSR, адаптер node standalone). Сборка из корня репозитория:
#   npm run build:crm && docker build -f apps/crm/Dockerfile -t yu-club-crm .
# apps/crm/dist собирается ДО docker build (deploy/deploy.sh – на маке из чистого HEAD): на стенде
# мало памяти, astro build в образе вытеснял соседей. В образе – только рабочие зависимости CRM.
# Рантайм: API_URL (адрес API внутри сети), TRUSTED_PROXIES (чьему X-Forwarded-For верим), HOST/PORT.
FROM node:26-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/crm/package.json apps/crm/
COPY apps/site/package.json apps/site/
COPY packages/contracts/package.json packages/contracts/
COPY db/package.json db/
RUN npm ci -w @yu/crm --include-workspace-root=false --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:26-alpine
LABEL project=yu-club
WORKDIR /app/apps/crm
ENV NODE_ENV=production TZ=UTC HOST=0.0.0.0 PORT=4321
COPY --from=deps /app/node_modules /app/node_modules
COPY apps/crm/package.json ./
COPY apps/crm/dist ./dist
USER node
EXPOSE 4321
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=30s --start-interval=2s CMD wget -qO- http://127.0.0.1:4321/login >/dev/null || exit 1
CMD ["node", "dist/server/entry.mjs"]

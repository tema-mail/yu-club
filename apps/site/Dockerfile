# Образ публичного сайта yu-club (Astro SSR, адаптер node standalone). Сборка из корня репозитория:
#   npm run build -w @yu/site && docker build -f apps/site/Dockerfile -t yu-club-site .
# apps/site/dist собирается ДО docker build (deploy/deploy.sh – на маке из чистого HEAD): на стенде мало памяти.
# В образе – только рабочие зависимости сайта.
# Рантайм: API_URL (API внутри сети), APP_ENV (не prod – noindex везде), PUBLIC_SITE_URL, HOST/PORT.
FROM node:26-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/crm/package.json apps/crm/
COPY apps/site/package.json apps/site/
COPY packages/contracts/package.json packages/contracts/
COPY db/package.json db/
RUN npm ci -w @yu/site --include-workspace-root=false --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:26-alpine
LABEL project=yu-club
WORKDIR /app/apps/site
ENV NODE_ENV=production TZ=UTC HOST=0.0.0.0 PORT=4341
COPY --from=deps /app/node_modules /app/node_modules
COPY apps/site/package.json ./
COPY apps/site/dist ./dist
USER node
EXPOSE 4341
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=30s --start-interval=2s CMD wget -qO- http://127.0.0.1:4341/robots.txt >/dev/null || exit 1
CMD ["node", "dist/server/entry.mjs"]

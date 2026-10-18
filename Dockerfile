# One image for the Node services (api, workers). Command chooses the service.
#   docker compose -f infra/docker-compose.yml --profile app up -d --build
FROM node:22-alpine AS base
WORKDIR /app
ENV NODE_ENV=production

FROM base AS deps
COPY package.json package-lock.json .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/workers/package.json apps/workers/
COPY apps/simulator/package.json apps/simulator/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/coreif/package.json packages/coreif/
COPY packages/db/package.json packages/db/
# tsx runs the TypeScript sources (workspace packages export .ts); dev deps are needed for it.
RUN npm ci --include=dev --no-audit --no-fund

FROM base AS runtime
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# /data/uploads: incident photos (M7); a new named volume copies this ownership
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app && mkdir -p /data/uploads && chown app:app /data/uploads
USER app
EXPOSE 3000
WORKDIR /app/apps/api
CMD ["node", "--import", "tsx", "src/main.ts"]

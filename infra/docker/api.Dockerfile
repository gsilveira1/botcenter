# syntax=docker/dockerfile:1.7
# Bot Center API and worker image (NestJS 11 with Fastify, Node 24).
#
# Build from the repository root:
#   docker build -f infra/docker/api.Dockerfile -t botcenter-api .
#
# Stages:
#   base     Node 24 Alpine with pnpm 10 (corepack).
#   deps     `pnpm fetch` from the lockfile only. This layer changes only when the lockfile changes.
#   build    Installs the workspace, builds @botcenter/api and its workspace dependencies (the
#            Prisma client too), and copies the production files with `pnpm deploy` to /out/api.
#   runtime  Node 24 Alpine, tini, user `node` (uid 1000), the pruned app, and the Prisma migrations.
#
# One image, three roles (the `ROLE` variable, read by botcenter-entrypoint.sh):
#   ROLE=api      node dist/main.js     (HTTP server on PORT, default 3000)
#   ROLE=worker   node dist/worker.js   (queue workers; /metrics and /health/live on WORKER_METRICS_PORT 9464)
#   A command     runs as given, for example the `migrate` service of compose.prod.yml:
#                 pnpm --filter @botcenter/api db:migrate
#
# Contract with apps/api (the image build fails without it):
#   - `pnpm --filter @botcenter/api build` writes dist/main.js and dist/worker.js.
#   - `prisma` is a runtime dependency of @botcenter/api, and the script `db:migrate` is
#     `prisma migrate deploy --config ../../prisma/prisma.config.ts`.
#   - @botcenter/prisma is a devDependency of @botcenter/api (its `build` generates the client).

ARG NODE_IMAGE=node:24.22.0-alpine3.24@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f
ARG PNPM_VERSION=10.33.0

FROM ${NODE_IMAGE} AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    npm_config_store_dir=/pnpm/store \
    CI=true \
    TURBO_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare "pnpm@${PNPM_VERSION}" --activate
WORKDIR /repo

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=botcenter-pnpm-store,target=/pnpm/store \
    pnpm fetch

FROM deps AS build
# Native modules (for example `re2` of @botcenter/engine, Node ^24.15): the install downloads a prebuilt
# binary or builds it with node-gyp. The build tools stay in this stage; the runtime image has none.
RUN apk add --no-cache python3 make g++
COPY . .
RUN --mount=type=cache,id=botcenter-pnpm-store,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile --filter "@botcenter/api..."
RUN pnpm --filter "@botcenter/api..." run build
RUN --mount=type=cache,id=botcenter-pnpm-store,target=/pnpm/store \
    pnpm --filter "@botcenter/api" deploy --prod --legacy /out/api
# The fail-fast checks of the contract above.
RUN test -f /out/api/dist/main.js && test -f /out/api/dist/worker.js \
    && test -x /out/api/node_modules/.bin/prisma

FROM ${NODE_IMAGE} AS runtime
ARG PNPM_VERSION
# tini forwards SIGTERM to Node (graceful shutdown of the workers). openssl: the Prisma schema engine.
# pnpm: the `migrate` command. `--no-cache` keeps no package index in the image.
RUN apk add --no-cache tini openssl \
    && npm install -g "pnpm@${PNPM_VERSION}" \
    && npm cache clean --force \
    && rm -rf /root/.npm /tmp/*
ENV NODE_ENV=production \
    PORT=3000 \
    WORKER_METRICS_PORT=9464 \
    ROLE=api \
    NODE_OPTIONS=--max-old-space-size=384
WORKDIR /app
# A minimal workspace, so that `pnpm --filter @botcenter/api db:migrate` works in the container.
COPY --from=build --chown=root:root /repo/package.json /repo/pnpm-workspace.yaml ./
COPY --from=build --chown=root:root /repo/prisma/schema.prisma /repo/prisma/prisma.config.ts ./prisma/
COPY --from=build --chown=root:root /repo/prisma/migrations ./prisma/migrations
COPY --from=build --chown=root:root /out/api ./apps/api
COPY --chown=root:root --chmod=0755 infra/docker/botcenter-entrypoint.sh /usr/local/bin/botcenter-entrypoint
# The app files belong to root and are read-only for `node`. The process writes only to /tmp.
USER node
WORKDIR /app/apps/api
EXPOSE 3000 9464
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
    CMD if [ "$ROLE" = "worker" ]; then wget -q -O /dev/null "http://127.0.0.1:${WORKER_METRICS_PORT}/health/live"; \
        else wget -q -O /dev/null "http://127.0.0.1:${PORT}/health/live"; fi || exit 1
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/botcenter-entrypoint"]

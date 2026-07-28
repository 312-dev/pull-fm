# ---------------------------------------------------------------------------
# Pull.fm BFF runtime image.
#
# Two properties are worth calling out because they are easy to get wrong in a
# pnpm workspace:
#
#   1. `pnpm deploy` is used rather than copying node_modules. pnpm's default
#      layout is a symlink farm pointing into the workspace root's virtual
#      store, so a naive `COPY apps/bff/node_modules` produces an image full of
#      dangling links that only fails at runtime.
#   2. Dependency manifests are copied before the source, so a source-only
#      change reuses the install layer. This is what keeps the deploy inside
#      the ten-minute Gate 0 budget.
# ---------------------------------------------------------------------------

FROM node:22.21.1-alpine3.22 AS build

WORKDIR /repo
RUN corepack enable

# Manifests only: this layer is invalidated by a dependency change, not by a
# code change.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/bff/package.json apps/bff/
COPY packages/crypto/package.json packages/crypto/
COPY packages/db/package.json packages/db/
COPY packages/upstream/package.json packages/upstream/

RUN pnpm install --frozen-lockfile --filter @pull-fm/bff...

COPY tsconfig.base.json ./
COPY apps/bff apps/bff

RUN pnpm --filter @pull-fm/bff build

# Produces a self-contained tree with a real node_modules and only production
# dependencies.
RUN pnpm --filter @pull-fm/bff deploy --prod /out

# ---------------------------------------------------------------------------

FROM node:22.21.1-alpine3.22 AS runtime

# Dumb-init reaps zombies and forwards SIGTERM to node as PID 1, which is what
# makes the graceful drain in src/index.ts actually run on a rolling deploy.
RUN apk add --no-cache dumb-init

WORKDIR /app
COPY --from=build --chown=node:node /out /app

# The forward migration runner and the migrations themselves ship inside the
# image, so the version of the schema and the version of the code that expects
# it can never be deployed apart.
COPY --chown=node:node packages/db/scripts/migrate.mjs /app/migrate.mjs
COPY --chown=node:node packages/db/migrations /app/migrations

# Build metadata. BUILD_SHA is read by src/config.ts and reported on /healthz,
# which is how the deploy pipeline verifies from outside that the new commit is
# the one actually serving traffic.
ARG BUILD_SHA=unknown
ENV BUILD_SHA=$BUILD_SHA
ENV NODE_ENV=production

USER node
EXPOSE 3000

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]

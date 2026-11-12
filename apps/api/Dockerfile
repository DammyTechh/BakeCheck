# ─────────────────────────────────────────────────────────────────────────────
# BreadGuard AI — Node.js API
#
# Multi-stage: the build stage carries the full toolchain, the runtime stage
# carries only what is needed to run. Keeping the compiler out of the runtime
# image is both smaller and a smaller attack surface.
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: dependencies ────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS deps

WORKDIR /app

# Copy manifests only, so this layer is cached unless dependencies change.
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/

# `npm ci` installs exactly what the lockfile pins — a build must not silently
# pick up a different version from the one that was tested.
RUN npm ci --workspaces --include-workspace-root

# npm workspaces HOIST dependencies to the root node_modules. A workspace only
# gets its own nested node_modules when a version conflict makes hoisting
# impossible — which, for this tree, never happens. So `apps/api/node_modules`
# does not exist, and a `COPY` of it fails the build outright:
#
#   failed to compute cache key: "/app/apps/api/node_modules": not found
#
# Creating it empty is deliberate rather than dropping the COPY: if a future
# dependency does conflict and npm nests it, the COPY still carries it
# forward. Dropping the line would silently omit it and fail at runtime.
RUN mkdir -p apps/api/node_modules

# ── Stage 2: build ───────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY package.json package-lock.json ./
COPY apps/api ./apps/api
COPY database ./database

WORKDIR /app/apps/api
RUN npm run build

# Drop dev dependencies from the tree that will be copied forward.
WORKDIR /app
RUN npm prune --omit=dev --workspaces --include-workspace-root \
 && mkdir -p apps/api/node_modules

# ── Stage 3: runtime ─────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime

# sharp needs libvips at runtime. The prebuilt binary bundles it, but
# installing the system package keeps the image working if a rebuild from
# source is ever needed.
RUN apt-get -o Acquire::Retries=5 update \
 && apt-get -o Acquire::Retries=5 install -y --no-install-recommends \
      libvips42 \
      ca-certificates \
      tini \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /app

# Run unprivileged. The node image already provides a `node` user.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=node:node /app/apps/api/package.json ./apps/api/
COPY --from=build --chown=node:node /app/package.json ./

# Migrations ship with the image so a release can run them without a separate
# artifact or a checkout.
COPY --from=build --chown=node:node /app/database ./database

# Local storage driver writes here. On Render and similar platforms this is
# ephemeral — use STORAGE_DRIVER=supabase in production.
RUN mkdir -p /app/.storage && chown node:node /app/.storage

USER node

EXPOSE 3000

# tini reaps zombies and forwards signals, so SIGTERM reaches Node and the
# application's shutdown hooks actually run.
ENTRYPOINT ["/usr/bin/tini", "--"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

WORKDIR /app/apps/api
CMD ["node", "dist/main.js"]

# syntax=docker/dockerfile:1
# Build context: project root  →  docker build -f docker/Dockerfile .

# ── stage 1: deps ────────────────────────────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /build
COPY access/frontdoor/package.json access/frontdoor/pnpm-lock.yaml ./
RUN corepack enable pnpm \
  && pnpm install --prod --frozen-lockfile --ignore-scripts

# ── stage 2: runtime ─────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

# non-root user already exists in node image; just use it
USER node
WORKDIR /app

# copy server source
COPY --chown=node:node access/frontdoor/server.js ./server.js
COPY --chown=node:node access/frontdoor/package.json ./package.json

# copy production node_modules from deps stage
COPY --chown=node:node --from=deps /build/node_modules ./node_modules

# copy browser client static files
COPY --chown=node:node clients/browser ./static

# runtime directories (must be writable by node user; real data should be volume-mounted)
RUN mkdir -p /app/data/history /app/data/media /app/config

# ── environment defaults ──────────────────────────────────────────────────────
ENV NODE_ENV=production \
    BIND=0.0.0.0 \
    PORT=18081 \
    CLAWEB_STATIC_ROOT=/app/static \
    CLAWEB_LOGIN_CONFIG=/app/config/claweb-login.json \
    CLAWEB_HISTORY_DIR=/app/data/history \
    CLAWEB_MEDIA_DIR=/app/data/media \
    CLAWEB_UPSTREAM_WS=ws://127.0.0.1:18999 \
    CLAWEB_LOG_LEVEL=info \
    CLAWEB_LOG_JSON=1

EXPOSE 18081

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://127.0.0.1:18081/ || exit 1

ENTRYPOINT ["node", "server.js"]

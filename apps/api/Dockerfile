# TonyAI API — NestJS + Prisma + Puppeteer (PDF reports)
# Build from the REPO ROOT:  docker build -f apps/api/Dockerfile .
#
# Builder and runtime share the same base so the Prisma engine generated in the
# builder matches the runtime libc/openssl (binaryTargets in schema.prisma are
# belt-and-braces). Chromium comes from the distro (PUPPETEER_EXECUTABLE_PATH):
# ~400 MB smaller than Puppeteer's bundled Chrome and it exists for linux/arm64,
# so local Apple-Silicon builds work natively.

FROM node:22-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable

# ---------------------------------------------------------------------------
FROM base AS builder
WORKDIR /app
# Never download bundled Chrome in the image (distro chromium is used at runtime).
ENV PUPPETEER_SKIP_DOWNLOAD=true
COPY . .
# Filtered install: api + its workspace deps only (skips web/e2e dep trees).
RUN pnpm install --frozen-lockfile --filter @tonyai/api...
RUN pnpm --filter @tonyai/shared-types build \
 && pnpm --filter @tonyai/db run generate \
 && pnpm --filter @tonyai/api build
# NOTE: `pnpm prune --prod` is NOT safe here — at the workspace root it prunes
# against the root manifest (no prod deps) and strips the api's runtime deps.
# Image slimming (turbo prune / selective copy) is a Phase-2 deploy optimization.

# ---------------------------------------------------------------------------
FROM base AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium fonts-liberation \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    PORT=3001

WORKDIR /app
COPY --from=builder --chown=node:node /app /app

USER node
WORKDIR /app/apps/api
EXPOSE 3001
# ConfigModule resolves .env by cwd — none is baked in (.dockerignore); all
# configuration is injected as real environment variables.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]

# TonyAI API — NestJS + Prisma + Puppeteer (PDF reports)
# Build from the REPO ROOT:  docker build -f apps/api/Dockerfile .
#
# Builder and runtime share the same base so the Prisma engine generated in the
# builder matches the runtime libc/openssl (binaryTargets in schema.prisma are
# belt-and-braces). Chromium comes from the distro (PUPPETEER_EXECUTABLE_PATH):
# ~400 MB smaller than Puppeteer's bundled Chrome and it exists for linux/arm64,
# so local Apple-Silicon builds work natively.

# Docker Hub's official node image through its Amazon ECR Public mirror (the
# same digest): anonymous pulls from shared CI runners hit Docker Hub's rate
# limit (429) and failed the image build.
FROM public.ecr.aws/docker/library/node:22-bookworm-slim AS base
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
# Install a separate production tree; root pruning would remove workspace deps.
FROM base AS production-dependencies
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=true
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/shared-types/package.json ./packages/shared-types/package.json
RUN pnpm install --frozen-lockfile --prod --filter @tonyai/api... --ignore-scripts

# ---------------------------------------------------------------------------
FROM base AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium fonts-liberation tini \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    PORT=3001 \
    NODE_OPTIONS=--max-old-space-size=768

WORKDIR /app
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=production-dependencies --chown=node:node /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=production-dependencies --chown=node:node /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=builder --chown=node:node /app/apps/api/package.json ./apps/api/package.json
COPY --from=builder --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --from=builder --chown=node:node /app/packages/db/package.json ./packages/db/package.json
COPY --from=builder --chown=node:node /app/packages/db/generated ./packages/db/generated
COPY --from=builder --chown=node:node /app/packages/shared-types/package.json ./packages/shared-types/package.json
COPY --from=builder --chown=node:node /app/packages/shared-types/dist ./packages/shared-types/dist
COPY --from=builder --chown=node:node /app/infra/certs/prod-ca-2021.crt ./infra/certs/prod-ca-2021.crt

USER node
WORKDIR /app/apps/api
EXPOSE 3001
# ConfigModule resolves .env by cwd — none is baked in (.dockerignore); all
# configuration is injected as real environment variables.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]

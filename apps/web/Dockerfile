# TonyAI Web — Next.js 16 (standalone output)
# Build from the REPO ROOT:  docker build -f apps/web/Dockerfile .
#
# NEXT_PUBLIC_* values are inlined at BUILD time, so an image is bound to the
# environment it was built for — pass the right --build-arg per environment and
# never promote a dev image to staging. Server-side auth (proxy.ts) can override
# the Supabase URL at RUNTIME via SUPABASE_URL_INTERNAL (needed in containers,
# where the browser-facing localhost URL is unreachable from inside).

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable

# ---------------------------------------------------------------------------
FROM base AS builder
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=true

# Browser-facing config, inlined into the client bundle at build time.
# Defaults target the local Supabase + the api container published on :3001.
ARG NEXT_PUBLIC_SUPABASE_URL=http://localhost:54321
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_API_BASE_URL=http://localhost:3001/api/v1
# Optional — empty means Sentry never initialises in the browser bundle.
ARG NEXT_PUBLIC_SENTRY_DSN=
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL \
    NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN

COPY . .
RUN pnpm install --frozen-lockfile --filter @tonyai/web...
RUN pnpm --filter @tonyai/shared-types build \
 && pnpm --filter @tonyai/web build

# ---------------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
# Standalone server (traced from the monorepo root) + static assets.
COPY --from=builder --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=builder --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=node:node /app/apps/web/public ./apps/web/public

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]

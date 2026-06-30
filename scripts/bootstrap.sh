#!/usr/bin/env bash
#
# TonyAI — local bootstrap
# One command: deps -> Supabase up -> sync .env from live keys -> migrate -> generate -> seed
#
# Usage:  pnpm setup        (or)   bash scripts/bootstrap.sh
#
set -euo pipefail

# --- pretty output -----------------------------------------------------------
if [ -t 1 ]; then
  BOLD=$'\033[1m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; DIM=$'\033[2m'; RESET=$'\033[0m'
else
  BOLD=""; GREEN=""; YELLOW=""; RED=""; DIM=""; RESET=""
fi
step()  { printf "\n%s==>%s %s%s\n" "$BOLD$GREEN" "$RESET" "$BOLD" "$*$RESET"; }
info()  { printf "    %s\n" "$*"; }
warn()  { printf "%s !  %s%s\n" "$YELLOW" "$*" "$RESET"; }
die()   { printf "%s ✗  %s%s\n" "$RED" "$*" "$RESET" >&2; exit 1; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# --- 0. prerequisites --------------------------------------------------------
step "Checking prerequisites"
command -v node >/dev/null      || die "node not found (need >= 20)"
command -v pnpm >/dev/null      || die "pnpm not found  (npm i -g pnpm)"
command -v supabase >/dev/null  || die "supabase CLI not found  (https://supabase.com/docs/guides/cli)"
command -v docker >/dev/null    || die "docker not found  (install Docker Desktop)"
docker info >/dev/null 2>&1     || die "Docker daemon is not running — start Docker Desktop and retry"
info "node $(node -v) · pnpm $(pnpm -v) · supabase $(supabase --version 2>/dev/null | head -1)"

# --- 1. dependencies ---------------------------------------------------------
step "Installing dependencies"
pnpm install

# --- 2. Supabase up ----------------------------------------------------------
step "Starting local Supabase"
if supabase status >/dev/null 2>&1; then
  info "Supabase is already running."
else
  supabase start
fi

# --- 3. sync .env files from live keys --------------------------------------
step "Syncing .env files from 'supabase status'"
# Pull live values (ANON_KEY, SERVICE_ROLE_KEY, JWT_SECRET, API_URL, DB_URL)
eval "$(supabase status -o env | grep -E '^(ANON_KEY|SERVICE_ROLE_KEY|JWT_SECRET|API_URL|DB_URL)=')"
: "${ANON_KEY:?could not read ANON_KEY}" "${SERVICE_ROLE_KEY:?}" "${JWT_SECRET:?}" "${API_URL:?}" "${DB_URL:?}"

cat > apps/web/.env.local <<EOF
NEXT_PUBLIC_SUPABASE_URL="${API_URL}"
NEXT_PUBLIC_SUPABASE_ANON_KEY="${ANON_KEY}"
NEXT_PUBLIC_API_BASE_URL="http://localhost:3001/api/v1"
EOF
info "wrote apps/web/.env.local"

cat > apps/api/.env <<EOF
PORT=3001
WEB_ORIGIN="http://localhost:3000"
DATABASE_URL="${DB_URL}"
DIRECT_URL="${DB_URL}"
SUPABASE_URL="${API_URL}"
SUPABASE_JWT_SECRET="${JWT_SECRET}"
SUPABASE_SERVICE_ROLE_KEY="${SERVICE_ROLE_KEY}"
EOF
info "wrote apps/api/.env"

cat > packages/db/.env <<EOF
DATABASE_URL="${DB_URL}"
DIRECT_URL="${DB_URL}"
SUPABASE_URL="${API_URL}"
SUPABASE_SERVICE_ROLE_KEY="${SERVICE_ROLE_KEY}"
EOF
info "wrote packages/db/.env"

# --- 4. database: migrate -> generate -> seed --------------------------------
step "Applying migrations"
pnpm --filter @tonyai/db run deploy

step "Generating Prisma client"
pnpm --filter @tonyai/db run generate

step "Seeding demo data"
pnpm --filter @tonyai/db run seed

# --- done --------------------------------------------------------------------
step "Done 🎉"
cat <<EOF
${DIM}Start the apps:${RESET}  ${BOLD}pnpm dev${RESET}   ${DIM}(web :3000 · api :3001)${RESET}
${DIM}Run tests:${RESET}      ${BOLD}pnpm test${RESET}   ${DIM}· ${RESET}${BOLD}pnpm e2e${RESET}

${BOLD}Seed users${RESET} (password: ${BOLD}TonyAI!2026${RESET})
  admin@tonyai.local   super_admin   sees all 5 subsidiaries
  entry@tonyai.local   data_entry    sees 2 subsidiaries
EOF

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

# The CLI version decides how the local stack signs tokens and which keys
# `supabase status` exposes, so pin a floor and say so out loud.
SUPABASE_MIN="2.0.0"
SUPABASE_VER="$(supabase --version 2>/dev/null | head -1 | tr -d 'v' | tr -d '[:space:]')"
if [ -n "$SUPABASE_VER" ]; then
  if [ "$(printf '%s\n%s\n' "$SUPABASE_MIN" "$SUPABASE_VER" | sort -V | head -1)" != "$SUPABASE_MIN" ]; then
    die "supabase CLI $SUPABASE_VER is too old (need >= $SUPABASE_MIN). Upgrade: brew upgrade supabase"
  fi
fi

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
for var in ANON_KEY SERVICE_ROLE_KEY API_URL DB_URL; do
  if [ -z "${!var:-}" ]; then
    printf '\n'
    warn "'supabase status -o env' did not report $var."
    info "Your supabase CLI ($SUPABASE_VER) may have dropped the legacy key names,"
    info "or another Supabase project is occupying ports 54321/54322."
    info "Check:  supabase status          (project should be 'TonyAI-mono-repo')"
    info "        supabase status -o env   (should list ANON_KEY, SERVICE_ROLE_KEY, API_URL)"
    die "Cannot write the .env files without $var."
  fi
done

# JWT_SECRET is OPTIONAL: a project that signs asymmetrically has no shared
# secret, and the API verifies those against the JWKS at SUPABASE_URL instead.
if [ -z "${JWT_SECRET:-}" ]; then
  warn "No JWT_SECRET reported — assuming this project signs tokens asymmetrically."
  info "The API will verify against \${SUPABASE_URL}/auth/v1/.well-known/jwks.json."
fi

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

# --- 5. auth smoke check -----------------------------------------------------
# Proves the whole login chain end-to-end BEFORE you start the apps. Without it
# a key/algorithm mismatch only surfaces later as "the page loads but there is
# no data and an auth error" — the browser login succeeds, every API call 401s.
step "Verifying the login chain"
# The body goes in on stdin so the seed password never lands in the process
# list, where any local user could read it via `ps`.
AUTH_JSON="$(printf '%s' '{"email":"admin@tonyai.local","password":"TonyAI!2026"}' \
  | curl -s -X POST "${API_URL}/auth/v1/token?grant_type=password" \
    -H "apikey: ${ANON_KEY}" -H "Content-Type: application/json" \
    --data @- --max-time 20 || true)"

ALG="$(printf '%s' "$AUTH_JSON" | node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
  try{
    const t=JSON.parse(d).access_token;
    if(!t) return console.log('NO_TOKEN');
    console.log(JSON.parse(Buffer.from(t.split('.')[0],'base64url').toString()).alg||'UNKNOWN');
  }catch{console.log('NO_TOKEN')}
});" 2>/dev/null || echo NO_TOKEN)"

case "$ALG" in
  NO_TOKEN|UNKNOWN)
    warn "Could not obtain an access token for admin@tonyai.local."
    info "The seed may not have created the auth users. Re-run: pnpm db:seed"
    die "Login is broken — fix this before starting the apps."
    ;;
  HS*)
    # Actually verify the signature against the secret we just wrote, instead of
    # asserting a ✓ we never checked.
    if printf '%s' "$AUTH_JSON" | JWT_SECRET="$JWT_SECRET" node -e "
      const {createHmac,timingSafeEqual}=require('crypto');
      let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
        try{
          const [h,p,s]=JSON.parse(d).access_token.split('.');
          const want=createHmac('sha256',process.env.JWT_SECRET).update(h+'.'+p).digest();
          const got=Buffer.from(s,'base64url');
          process.exit(want.length===got.length&&timingSafeEqual(want,got)?0:1);
        }catch{process.exit(1)}
      });" 2>/dev/null; then
      info "tokens are signed ${ALG} and verify against SUPABASE_JWT_SECRET ✓"
    else
      warn "The token does NOT verify against the SUPABASE_JWT_SECRET just written."
      info "Usually a stale Supabase instance or a port-conflicting project."
      die "The API would reject every login."
    fi
    ;;
  *)
    info "tokens are signed ${ALG} (asymmetric) — verified against the project's JWKS"
    # A 200 is not enough: an empty key set also returns 200 and would 401 every
    # request. Require at least one published key.
    if curl -sf --max-time 15 "${API_URL}/auth/v1/.well-known/jwks.json" \
      | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
          try{process.exit((JSON.parse(d).keys||[]).length>0?0:1)}catch{process.exit(1)}
        });" 2>/dev/null; then
      info "JWKS endpoint reachable and publishing keys ✓"
    else
      warn "JWKS at ${API_URL}/auth/v1/.well-known/jwks.json is unreachable or empty."
      die "The API would reject every login."
    fi
    ;;
esac

# --- done --------------------------------------------------------------------
step "Done 🎉"
cat <<EOF
${DIM}Start the apps:${RESET}  ${BOLD}pnpm dev${RESET}   ${DIM}(web :3000 · api :3001)${RESET}
${DIM}Run tests:${RESET}      ${BOLD}pnpm test${RESET}   ${DIM}· ${RESET}${BOLD}pnpm e2e${RESET}

${BOLD}Seed users${RESET} (password: ${BOLD}TonyAI!2026${RESET})
  admin@tonyai.local   super_admin   sees all 5 subsidiaries
  entry@tonyai.local   data_entry    sees 2 subsidiaries
EOF

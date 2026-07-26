#!/usr/bin/env bash
# Local docker-compose wrapper: interpolates the compose file from the REAL
# local env files (supabase-cli demo JWTs differ per CLI version — never
# hardcode them). Usage:  pnpm docker:up | pnpm docker:down
set -euo pipefail
cd "$(dirname "$0")/.."
for f in apps/api/.env apps/web/.env.local; do
  [ -f "$f" ] || { echo "Missing $f — run 'pnpm setup' first." >&2; exit 1; }
done
set -a
. apps/api/.env
. apps/web/.env.local
set +a
exec docker compose "$@"

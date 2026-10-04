#!/usr/bin/env bash
# Local docker-compose wrapper: interpolates the compose file from the REAL
# local env files (supabase-cli demo JWTs differ per CLI version — never
# hardcode them). Usage:  pnpm docker:up | pnpm docker:down
set -euo pipefail
set +x
cd "$(dirname "$0")/.."
for f in apps/api/.env apps/web/.env.local; do
  [ -f "$f" ] || { echo "Missing $f — run 'pnpm setup' first." >&2; exit 1; }
done
set -a
. apps/api/.env
. apps/web/.env.local
set +a
# Only startup provisions a login; stopping containers must not rotate it.
case "${1:-}" in
  up)
    source infra/scripts/local-runtime-env.sh
    prepare_local_runtime
    export CONTAINER_DATABASE_URL
    CONTAINER_DATABASE_URL=$(node --input-type=module -e 'const u=new URL(process.env.DATABASE_URL); u.hostname="host.docker.internal"; process.stdout.write(u.toString())')
    ;;
  down|stop|ps|logs)
    # Compose interpolates even for non-starting commands; no usable credential.
    export CONTAINER_DATABASE_URL='postgresql://tonyai_runtime:unused@host.docker.internal:54322/postgres'
    ;;
  *) echo 'Use up (also to recreate/restart), down, stop, ps or logs.' >&2; exit 2 ;;
esac
unset DIRECT_URL RUNTIME_DB_PASSWORD
exec docker compose "$@"

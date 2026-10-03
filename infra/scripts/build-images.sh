#!/usr/bin/env bash
# Owner-run child process: failure stops this script, never the interactive shell.
set -euo pipefail
set +x
: "${1:?Usage: build-images.sh <source-sha> <new-candidate-json>}" "${2:?Output path required}"
export RELEASE_SHA="$1"
test ! -e "$2"
: "${SUPABASE_PROJECT_REF:?Complete Supabase setup first}"
: "${ACR_HOST:?}" "${ACR_NAME:?}" "${API_ORIGIN:?}" "${RESOURCE_GROUP:?}"
test "$(git rev-parse HEAD)" = "$RELEASE_SHA"
test -z "$(git status --porcelain)"
export NEXT_PUBLIC_SUPABASE_URL="$SUPABASE_URL"
export NEXT_PUBLIC_API_BASE_URL="$API_ORIGIN/api/v1"
if [[ -z "${NEXT_PUBLIC_SUPABASE_ANON_KEY:-}" ]]; then
  read -r -s -p 'Paste staging public browser key (never service_role): ' NEXT_PUBLIC_SUPABASE_ANON_KEY
  printf '\n'
fi
export NEXT_PUBLIC_SUPABASE_ANON_KEY
python3 infra/scripts/check_browser_key.py
# Validate public provenance before registry authentication or a build.
python3 - <<'PYVALIDATE'
import os,sys
sys.path.insert(0, 'infra/scripts')
from candidate import create
create(os.environ['RELEASE_SHA'], 'sha256:'+'0'*64, 'sha256:'+'0'*64)
PYVALIDATE
work_dir=$(mktemp -d)
container_id=''
cleanup() {
  if [[ -n "$container_id" ]]; then docker rm "$container_id" >/dev/null; fi
  rm -rf "$work_dir"
}
trap cleanup EXIT
az acr login --name "$ACR_NAME" --output none
docker buildx build --platform linux/amd64 --file apps/api/Dockerfile --label "org.opencontainers.image.revision=$RELEASE_SHA" --tag "$ACR_HOST/tonyai/api:$RELEASE_SHA" --metadata-file "$work_dir/api.json" --push .
docker buildx build --platform linux/amd64 --file apps/web/Dockerfile --label "org.opencontainers.image.revision=$RELEASE_SHA" --tag "$ACR_HOST/tonyai/web:$RELEASE_SHA" --metadata-file "$work_dir/web.json" --build-arg NEXT_PUBLIC_SUPABASE_URL --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY --build-arg NEXT_PUBLIC_API_BASE_URL --push .
unset NEXT_PUBLIC_SUPABASE_ANON_KEY
# Digest comes from THIS build result, never a later lookup of the mutable tag.
read_digest() {
  python3 - "$1" <<'PY'
import json,re,sys
with open(sys.argv[1]) as source:
    digest=json.load(source)['containerimage.digest']
assert re.fullmatch(r'sha256:[a-f0-9]{64}',digest)
print(digest)
PY
}
API_DIGEST=$(read_digest "$work_dir/api.json")
WEB_DIGEST=$(read_digest "$work_dir/web.json")
docker pull --platform linux/amd64 "$ACR_HOST/tonyai/web@$WEB_DIGEST"
container_id=$(docker create --platform linux/amd64 "$ACR_HOST/tonyai/web@$WEB_DIGEST")
docker cp "$container_id:/app/apps/web/.next/static" "$work_dir/static"
python3 infra/scripts/scan_browser_assets.py "$work_dir/static"
# Record only public provenance after the exact pushed image scan passes. Never mutate foundation tags.
python3 infra/scripts/candidate.py create --sha "$RELEASE_SHA" --candidate "$2" --api-digest "$API_DIGEST" --web-digest "$WEB_DIGEST"
printf 'PASS: built and scanned release %s\nAPI %s\nWeb %s\n' "$RELEASE_SHA" "$API_DIGEST" "$WEB_DIGEST"

#!/usr/bin/env bash
# Owner-run child process: failure stops this script, never the interactive shell.
set -euo pipefail
set +x
: "${RELEASE_SHA:?Restore the staging session first}"
: "${SUPABASE_PROJECT_REF:?Complete Supabase setup first}"
: "${ACR_HOST:?}" "${ACR_NAME:?}" "${API_ORIGIN:?}" "${RESOURCE_GROUP:?}"
test "$(git rev-parse HEAD)" = "$RELEASE_SHA"
test -z "$(git status --porcelain)"
export NEXT_PUBLIC_SUPABASE_URL="$SUPABASE_URL"
export NEXT_PUBLIC_API_BASE_URL="$API_ORIGIN/api/v1"
read -r -s -p 'Paste staging public browser key (never service_role): ' NEXT_PUBLIC_SUPABASE_ANON_KEY
printf '\n'
export NEXT_PUBLIC_SUPABASE_ANON_KEY
python3 infra/scripts/check_browser_key.py
work_dir=$(mktemp -d)
container_id=''
cleanup() {
  if [[ -n "$container_id" ]]; then docker rm "$container_id" >/dev/null; fi
  rm -rf "$work_dir"
}
trap cleanup EXIT
az acr login --name "$ACR_NAME" --output none
docker buildx build --platform linux/amd64 --file apps/api/Dockerfile --tag "$ACR_HOST/tonyai/api:$RELEASE_SHA" --metadata-file "$work_dir/api.json" --push .
docker buildx build --platform linux/amd64 --file apps/web/Dockerfile --tag "$ACR_HOST/tonyai/web:$RELEASE_SHA" --metadata-file "$work_dir/web.json" --build-arg NEXT_PUBLIC_SUPABASE_URL --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY --build-arg NEXT_PUBLIC_API_BASE_URL --push .
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
# Persist only public digests after the scan passes, for a later terminal/session.
az group update -n "$RESOURCE_GROUP" --set "tags.apiDigest=$API_DIGEST" "tags.webDigest=$WEB_DIGEST" --output none
printf 'PASS: built and scanned release %s\nAPI %s\nWeb %s\n' "$RELEASE_SHA" "$API_DIGEST" "$WEB_DIGEST"

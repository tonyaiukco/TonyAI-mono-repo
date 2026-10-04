#!/usr/bin/env bash
# CI runner only. Starts already-built images; never starts/resets/seeds Supabase.
set -euo pipefail
set +x
[[ "${CI:-}" == true ]]
: "${API_IMAGE:?}" "${WEB_IMAGE:?}" "${SUPABASE_URL:?}"
case "$SUPABASE_URL" in http://localhost:54321|http://127.0.0.1:54321) ;; *) exit 2 ;; esac
case "${DIRECT_URL:?}" in postgresql://postgres:postgres@127.0.0.1:54322/postgres|postgresql://postgres:postgres@localhost:54322/postgres) ;; *) exit 2 ;; esac
work_dir=$(mktemp -d)
api_id=''
web_id=''
cleanup() {
  result=$?
  if [[ "$result" -ne 0 ]]; then
    echo '::group::CI-only image smoke diagnostics'
    # Only this loopback fixture stack: never use this script for tenant data.
    [[ -z "$api_id" ]] || docker logs --tail 100 "$api_id" 2>&1 || true
    [[ -z "$web_id" ]] || docker logs --tail 100 "$web_id" 2>&1 || true
    echo '::endgroup::'
  fi
  [[ -z "$web_id" ]] || docker rm -f "$web_id" >/dev/null
  [[ -z "$api_id" ]] || docker rm -f "$api_id" >/dev/null
  rm -rf "$work_dir"
  exit "$result"
}
trap cleanup EXIT
# Provision the existing CI stack, never seed/reset/start it here.
source infra/scripts/local-runtime-env.sh
prepare_local_runtime
unset DIRECT_URL RUNTIME_DB_PASSWORD
echo 'Smoke: start API and web images'
# Linux host networking gives both images the same loopback-only CI services.
export PORT=3001 WEB_ORIGIN=http://localhost:3000 ALLOW_INSECURE_LOCAL_AUTH=true
api_id=$(docker run -d --network host --shm-size=1g --init \
  -e PORT -e WEB_ORIGIN -e DATABASE_URL -e SUPABASE_URL \
  -e SUPABASE_SERVICE_ROLE_KEY -e SUPABASE_JWT_SECRET -e SUPABASE_JWT_SCHEME \
  -e ALLOW_INSECURE_LOCAL_AUTH "$API_IMAGE")
web_id=$(docker run -d --network host "$WEB_IMAGE")
echo 'Smoke: liveness, readiness and login'
for url in http://localhost:3001/api/v1/health http://localhost:3001/api/v1/health/ready http://localhost:3000/login; do
  ready=false
  for attempt in {1..60}; do
    if curl --fail --silent --output /dev/null "$url"; then ready=true; break; fi
    sleep 2
  done
  [[ "$ready" == true ]]
done
# Inspect immutable local image IDs, not tags, in the evidence.
docker inspect --format '{{.Image}}' "$api_id" "$web_id"
docker cp "$web_id:/app/apps/web/.next/static" "$work_dir/static"
echo 'Smoke: browser asset secret scan'
python3 infra/scripts/scan_browser_assets.py "$work_dir/static"
export SMOKE_PUBLIC_KEY="$NEXT_PUBLIC_SUPABASE_ANON_KEY"
export SMOKE_PASSWORD_1='TonyAI!2026'
# Resolve seeded identity through login in memory, never by logging an auth response.
export SMOKE_TARGET_JSON
SMOKE_TARGET_JSON=$(node --input-type=module <<'JS'
const url=process.env.SUPABASE_URL;
const auth=await fetch(url+'/auth/v1/token?grant_type=password', {method:'POST',redirect:'error',headers:{apikey:process.env.SMOKE_PUBLIC_KEY,'Content-Type':'application/json'},body:JSON.stringify({email:'admin@tonyai.local',password:process.env.SMOKE_PASSWORD_1})});
if (!auth.ok) process.exit(1);
const {access_token:token}=await auth.json();
try {
  const result=await fetch('http://localhost:3001/api/v1/me',{redirect:'error',headers:{Authorization:'Bearer '+token}});
  if(!result.ok) process.exitCode=1;
  else {
    const me=await result.json();
    console.log(JSON.stringify({mode:'ci-local',web:'http://localhost:3000',api:'http://localhost:3001/api/v1',supabase:url,tenants:[{userId:me.id,organisationId:me.organisationId,subsidiaryId:me.accessibleSubsidiaryIds[0],email:'admin@tonyai.local'}]}));
  }
} finally {
  const logout=await fetch(url+'/auth/v1/logout?scope=local',{method:'POST',redirect:'error',headers:{apikey:process.env.SMOKE_PUBLIC_KEY,Authorization:'Bearer '+token}});
  if(logout.status!==204) process.exitCode=1;
}
JS
)
echo 'Smoke: authenticated browser and API exports'
node infra/scripts/image-smoke.mjs

# 3. Owner-run image build and application deployment

Complete [Supabase setup](02-supabase.md) first. These commands manually exercise
the foundation; automated promotion, image startup qualification and `tini` are
LP2-02. They do not constitute G2 staging acceptance. Use a clean checkout of the
recorded release SHA, Node 22/pnpm and Docker buildx. No local Supabase is needed.

## 3.1 Build immutable candidates

In the same Bash session, confirm `RELEASE_SHA`, `SUPABASE_URL`, `API_ORIGIN`,
`WEB_ORIGIN`, `ACR_NAME` and `ACR_HOST` still identify this staging environment.
The browser public key is intentionally embedded in the web bundle. Only the
Supabase **publishable/anon browser key** may be used there; service-role/secret
keys never belong in builds, build arguments, Docker context or GitHub.

```bash
test "$(git rev-parse HEAD)" = "$RELEASE_SHA"
test -z "$(git status --porcelain)"
az acr login --name "$ACR_NAME" --output none
docker buildx build --platform linux/amd64 --file apps/api/Dockerfile --tag "$ACR_HOST/tonyai/api:$RELEASE_SHA" --push .
export NEXT_PUBLIC_SUPABASE_URL="$SUPABASE_URL"
export NEXT_PUBLIC_API_BASE_URL="$API_ORIGIN/api/v1"
read -r -s -p 'Paste the staging public browser key (never service_role): ' NEXT_PUBLIC_SUPABASE_ANON_KEY
printf '\n'
export NEXT_PUBLIC_SUPABASE_ANON_KEY
# Refuse secret/service-role keys before they enter an image.
python3 infra/scripts/check_browser_key.py
docker buildx build --platform linux/amd64 --file apps/web/Dockerfile --tag "$ACR_HOST/tonyai/web:$RELEASE_SHA" --build-arg NEXT_PUBLIC_SUPABASE_URL --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY --build-arg NEXT_PUBLIC_API_BASE_URL --push .
unset NEXT_PUBLIC_SUPABASE_ANON_KEY
export API_DIGEST="$(az acr repository show -n "$ACR_NAME" --image "tonyai/api:$RELEASE_SHA" --query digest -o tsv)"
export WEB_DIGEST="$(az acr repository show -n "$ACR_NAME" --image "tonyai/web:$RELEASE_SHA" --query digest -o tsv)"
[[ "$API_DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]]
[[ "$WEB_DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]]
```

Expected/evidence: each build/push exits 0 and yields an ACR digest. Record SHA,
API/web digests, `linux/amd64`, project ref and public URL inputs, but **not the
browser key value**. Record that its type/project were checked. Rebuild the web
for every environment; changing ACA runtime variables cannot replace inlined
`NEXT_PUBLIC_*`. The API image can be promoted once LP2-02 qualifies it.

## 3.2 Validate and deploy both apps

```bash
az deployment group validate -g "$RESOURCE_GROUP" --template-file infra/azure/apps.bicep --parameters prefix="$PREFIX" supabaseProjectRef="$SUPABASE_PROJECT_REF" apiDigest="$API_DIGEST" webDigest="$WEB_DIGEST" --query properties.provisioningState -o tsv
az deployment group what-if -g "$RESOURCE_GROUP" --template-file infra/azure/apps.bicep --parameters prefix="$PREFIX" supabaseProjectRef="$SUPABASE_PROJECT_REF" apiDigest="$API_DIGEST" webDigest="$WEB_DIGEST"
az deployment group create -g "$RESOURCE_GROUP" -n lp2-apps --template-file infra/azure/apps.bicep --parameters prefix="$PREFIX" supabaseProjectRef="$SUPABASE_PROJECT_REF" apiDigest="$API_DIGEST" webDigest="$WEB_DIGEST" --query properties.provisioningState -o tsv
az containerapp show -g "$RESOURCE_GROUP" -n "$PREFIX-staging-api" --query '{state:properties.provisioningState,revision:properties.latestReadyRevisionName,image:properties.template.containers[0].image,scale:properties.template.scale}'
az containerapp show -g "$RESOURCE_GROUP" -n "$PREFIX-staging-web" --query '{state:properties.provisioningState,revision:properties.latestReadyRevisionName,image:properties.template.containers[0].image,scale:properties.template.scale}'
```

Expected/evidence: validation and deployment succeed, nonempty ready revisions,
exact image digests, min 0/max 2 replicas. API 1 vCPU/2 GiB, web 0.5 vCPU/1 GiB,
Consumption profile, HTTPS ingress, explicit startup/liveness/readiness probes.
Key Vault reference failures usually need correct secret names/RBAC propagation;
never substitute literal secrets into ACA or relax JWT configuration.

The foundation configures Log Analytics for container stdout/system logs. Current
`/api/v1/health` only proves process liveness; using it for the initial ACA
readiness probe does **not** prove dependency readiness under DB failure. LP2-03
must replace/qualify that readiness behavior before G2.

Use [the acceptance procedure](04-verify.md) next. Do not set production DNS or
open real customer onboarding from this runbook.

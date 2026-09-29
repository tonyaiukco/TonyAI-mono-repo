# 3. Owner-run image build and application deployment

Complete [Supabase setup](02-supabase.md) first. These commands manually exercise
the foundation; automated promotion, image startup qualification and `tini` are
LP2-02. They do not constitute G2 staging acceptance. Use a clean checkout of the
recorded release SHA, Node 22/pnpm and Docker buildx. No local Supabase is needed.

## 3.1 Build immutable candidates

First [restore the Bash session](00-session.md), then confirm `RELEASE_SHA`, `SUPABASE_URL`, `API_ORIGIN`,
`WEB_ORIGIN`, `ACR_NAME` and `ACR_HOST` still identify this staging environment.
The browser public key is intentionally embedded in the web bundle. Only the
Supabase **publishable/anon browser key** may be used there; service-role/secret
keys never belong in builds, build arguments, Docker context or GitHub.

```bash
bash infra/scripts/build-images.sh
# Only after it prints PASS, restore the persisted digests:
source infra/scripts/restore-session.sh "$AZURE_SUBSCRIPTION_ID" "$RESOURCE_GROUP"

```

Expected/evidence: each build/push exits 0 and yields its own buildx metadata digest
(no mutable-tag lookup). The exact web digest is pulled without running it;
`.next/static` is scanned for opaque secret keys and service-role JWTs. A failed
scan stops before storing deployable digest metadata: quarantine the pushed
candidate and revoke any exposed key before rebuilding. Record SHA,
API/web digests, `linux/amd64`, project ref and public URL inputs, but **not the
browser key value**. Record that its type/project were checked. Rebuild the web
for every environment; changing ACA runtime variables cannot replace inlined
`NEXT_PUBLIC_*`. The API image can be promoted once LP2-02 qualifies it.

## 3.2 Validate and deploy both apps

```bash
bash infra/scripts/deploy-apps.sh
az containerapp show -g "$RESOURCE_GROUP" -n "$PREFIX-staging-api" --query '{state:properties.provisioningState,revision:properties.latestReadyRevisionName,image:properties.template.containers[0].image,scale:properties.template.scale}'
az containerapp show -g "$RESOURCE_GROUP" -n "$PREFIX-staging-web" --query '{state:properties.provisioningState,revision:properties.latestReadyRevisionName,image:properties.template.containers[0].image,scale:properties.template.scale}'
```

Expected/evidence: validation and deployment succeed, nonempty ready revisions,
exact image digests, min 0/max 2 replicas. API 1 vCPU/2 GiB, web 0.5 vCPU/1 GiB,
Consumption profile, HTTPS ingress, explicit startup/liveness/readiness probes.
The helper pins exact enabled secret version IDs and prints only those references;
record them in acceptance evidence. Subsequent CI deployments consume those
nonsecret version parameters, not Key Vault values. Key Vault reference failures usually need correct secret names/RBAC propagation;
never substitute literal secrets into ACA or relax JWT configuration.

The foundation configures Log Analytics for container stdout/system logs. Current
`/api/v1/health` only proves process liveness; using it for the initial ACA
readiness probe does **not** prove dependency readiness under DB failure. LP2-03
must replace/qualify that readiness behavior before G2.

Use [the acceptance procedure](04-verify.md) next. Do not set production DNS or
open real customer onboarding from this runbook.

## 3.3 Grant app-scoped GitHub deployer access after owner bootstrap

```bash
az deployment group create -g "$RESOURCE_GROUP" -n lp2-deployer-access --template-file infra/azure/deployer-access.bicep --parameters prefix="$PREFIX" principalId="$DEPLOYER_OBJECT_ID" --query properties.provisioningState -o tsv
```

Expected: Contributor is assigned on exactly the two existing app resources.
This is additive ARM deployment: if the older PR template was ever applied,
remove its obsolete **RG-scoped** Container Apps Contributor grant explicitly:

```bash
# Inspect the precise grant before removal; do not delete inherited/unrelated roles.
az role assignment list --assignee "$DEPLOYER_OBJECT_ID" --scope "$GROUP_ID" --query "[?scope=='$GROUP_ID' && roleDefinitionName=='Container Apps Contributor'].{id:id,scope:scope}" -o table
az role assignment delete --assignee "$DEPLOYER_OBJECT_ID" --role 'Container Apps Contributor' --scope "$GROUP_ID"
az role assignment list --assignee "$DEPLOYER_OBJECT_ID" --all --query '[].{role:roleDefinitionName,scope:scope}' -o table
```

Skip the deletion command when no exact old grant exists. Record app-only scopes,
and separately inspect inherited subscription/group grants. Creating a third app
or job with this identity must be denied; updating the two authorized apps remains
access to their secrets. OIDC success/denial is still an owner-run LP2-02 check.

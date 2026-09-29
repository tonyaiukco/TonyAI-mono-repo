# 1. Owner-run Azure foundation and federation

Prerequisites: Azure subscription with budget/credit approved, permission to create
resources, custom role definitions and RBAC assignments in the staging group, and Entra app-registration
permission. Install Azure CLI + Bicep, Docker with buildx, Python 3.10+,
Node 22 and the repo-pinned pnpm. No local Supabase or Docker Compose stack is used.
Run commands in **Bash** (`bash` from zsh), from this checkout. Stop on any failed step.
For a new terminal after provisioning, use [restore session](00-session.md).

## 1.1 Select the account and create the group

Start a fresh terminal without local env files. Fill only nonsecret identifiers:

```bash
set +x
export AZURE_SUBSCRIPTION_ID='<subscription-uuid>'
export AZURE_TENANT_ID='<tenant-uuid>'
export RESOURCE_GROUP='tonyai-staging-rg'
export PREFIX='tonyai'
export GITHUB_REPOSITORY='<owner>/<repository>'
export RELEASE_SHA="$(git rev-parse HEAD)"
bash <<'BASH'
set -euo pipefail
test -z "$(git status --porcelain)"
# Confirm this SHA is the owner's reviewed candidate before the first mutation.
node --version # must be v22.x
pnpm --version # must match package.json packageManager
PUPPETEER_SKIP_DOWNLOAD=true PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 pnpm install --frozen-lockfile
pnpm db:generate
az login --tenant "$AZURE_TENANT_ID" --output none
az account set --subscription "$AZURE_SUBSCRIPTION_ID"
az account show --query '{subscription:id,tenant:tenantId}' -o json
if [[ "$(az group exists --name "$RESOURCE_GROUP")" == false ]]; then
  az group create --name "$RESOURCE_GROUP" --location germanywestcentral --tags application=TonyAI environment=staging tonyaiPrefix="$PREFIX" releaseSha="$RELEASE_SHA" githubRepository="$GITHUB_REPOSITORY" --query '{id:id,location:location}'
else
  test "$(az group show -n "$RESOURCE_GROUP" --query tags.environment -o tsv)" = staging
fi
for provider in Microsoft.App Microsoft.ContainerRegistry Microsoft.KeyVault Microsoft.OperationalInsights Microsoft.ManagedIdentity; do
  az provider register --namespace "$provider" --wait --output none
done
az bicep version
az extension add --name containerapp --upgrade --only-show-errors
BASH
```

Expected/evidence: correct tenant/subscription IDs, group location
`germanywestcentral`, provider commands exit 0, CLI/Bicep version. Record the
release SHA, successful dependency install/Prisma generation and tool versions
with every run. These actions create billed cloud
resources; only the owner executes them. Existing group/name must be exclusively
staging. Do not reuse a production resource group.

## 1.2 Validate and apply foundation

```bash
bash <<'BASH'
set -euo pipefail
az deployment group validate -g "$RESOURCE_GROUP" --template-file infra/azure/foundation.bicep --parameters prefix="$PREFIX" --query properties.provisioningState -o tsv
az deployment group what-if -g "$RESOURCE_GROUP" --template-file infra/azure/foundation.bicep --parameters prefix="$PREFIX"
az deployment group create -g "$RESOURCE_GROUP" -n lp2-foundation --template-file infra/azure/foundation.bicep --parameters prefix="$PREFIX" --query properties.provisioningState -o tsv
BASH
```

After successful apply, restore variables; only then configure registry auth:

```bash
source infra/scripts/restore-session.sh "$AZURE_SUBSCRIPTION_ID" "$RESOURCE_GROUP" &&
bash <<'BASH'
set -euo pipefail
az acr config authentication-as-arm update -r "$ACR_NAME" --status enabled --output none
az acr config authentication-as-arm show -r "$ACR_NAME" --query status -o tsv
BASH
```

Keep foundation `what-if` output in the owner's private, unrecorded terminal.
Whether a rerun displays the evaluated Log Analytics shared key is still
unverified; do not attach raw output to the PR. Record only the reviewed resource
changes and pass/fail, never evaluated settings or keys.

Expected/evidence: validation/apply `Succeeded`; what-if only intended staging
resources; ACR ARM-token authentication `enabled`. Save the nonsecret deployment
ID and resource IDs. App origins are derived before image builds, avoiding a
bootstrap image with wrong public settings. A second foundation apply must
succeed without changing identities/URLs. Purge protection prevents immediate
vault-name reuse after deletion. Use [the recovery procedure](05-rotation.md#recover-a-soft-deleted-vault); do not purge it. Recovered secrets are stale until explicitly reconciled.
RBAC propagation may take minutes; retry a denied dependent step after it settles,
not by granting Contributor/Owner to the runtime identities.

## 1.3 Owner secret-management access

```bash
export OWNER_OBJECT_ID="$(az ad signed-in-user show --query id -o tsv)"
az role assignment create --assignee-object-id "$OWNER_OBJECT_ID" --assignee-principal-type User --role 'Key Vault Secrets Officer' --scope "$(foundation_output vaultId)" --query '{role:roleDefinitionId,scope:scope}'
```

Expected/evidence: one Secrets Officer assignment at this vault. The owner uses
it to place secrets in the portal and run migrations/bucket provisioning. Review
whether it remains needed after setup; runtime has separate, narrower access.

## 1.4 Entra app and GitHub environment federation

In GitHub, create environment **staging**, restrict deployments to **main**, add
required reviewers where the repository plan supports them, and protect workflow
changes through owner review. If these controls are unavailable on the plan,
**stop before creating the federated credential**: the owner must choose a plan
or equivalent enforced deployment restriction. An environment subject alone does
not restrict the originating branch. Never enable federation for fork PR jobs.

Run the idempotent helper only after verifying those enforced protections:

```bash
python3 infra/scripts/configure_oidc.py --subscription "$AZURE_SUBSCRIPTION_ID" --group "$RESOURCE_GROUP" --repo "$GITHUB_REPOSITORY" --environment-protection-verified
source infra/scripts/restore-session.sh "$AZURE_SUBSCRIPTION_ID" "$RESOURCE_GROUP"
az ad app credential list --id "$AZURE_CLIENT_ID" --query 'length(@)' -o tsv
az ad app federated-credential list --id "$AZURE_CLIENT_ID" --query '[].{name:name,issuer:issuer,subject:subject,audiences:audiences}'
```

Expected/evidence: repeated execution reuses the same dedicated app/service
principal and exact named credential; no password credentials (`0`). The helper
uses a deterministic app name per resource-group ID, stores IDs in group tags,
and refuses ambiguous apps or an existing federation with a different subject.
If reusing an older deployment's app, first record its reviewed client/object IDs
in `githubClientId`/`githubPrincipalId` group tags; do not create a duplicate.
Expected issuer `https://token.actions.githubusercontent.com`, audience
`api://AzureADTokenExchange`, subject `repo:<owner>/<repository>:environment:staging`.
No password is created and no Entra credential file is written.

No Azure deployment rights are granted yet. The owner first creates the two apps
in runbook 03, then applies app-scoped deployer permissions in its final step.

Set GitHub **environment variables**, not secrets: `AZURE_CLIENT_ID`,
`AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `RESOURCE_GROUP`, `ACR_NAME`, `PREFIX`.
LP2-02 supplies the workflow (`environment: staging`, `permissions: id-token: write,
contents: read`, `azure/login` with these IDs). No workflow file is added here.
After bootstrap, the deployer gets Container Apps Contributor **only on the two
existing app resources**, RG Reader and template/environment-join permissions,
AcrPush on this registry, and Managed Identity Operator on the two identities.
It cannot create arbitrary apps/jobs or change the environment logging destination.
**It can replace API code, so deployment access IS access to database-url and the
backend service key, including their RLS-bypassing privileges.** GitHub staging
environment/branch enforcement and owner workflow review are the real trust
barrier. App-scoped RBAC reduces reach; it does not protect these runtime secrets
from an authorized or compromised deployment. Audit inherited broad grants too.
Record actual OIDC-login success and negative branch/environment rejection in
LP2-02; creating the trust relationship alone does not prove token exchange.

Sources: [federation setup](https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation-create-trust),
[Container Apps roles](https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles/containers),
[ACR managed identity](https://learn.microsoft.com/en-us/azure/container-registry/container-registry-authentication-managed-identity).

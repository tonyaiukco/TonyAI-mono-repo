# 1. Owner-run Azure foundation and federation

Prerequisites: Azure subscription with budget/credit approved, permission to create
resources, custom role definitions and RBAC assignments in the staging group, and Entra app-registration
permission. Install Azure CLI + Bicep, GitHub CLI, Docker with buildx, Python 3.10+,
Node 22 and the repo-pinned pnpm. No local Supabase or Docker Compose stack is used.
Run commands in **Bash**, from this checkout. Stop on any failed step.

## 1.1 Select the account and create the group

Start a fresh terminal without local env files. Fill only nonsecret identifiers:

```bash
set -euo pipefail
set +x
export AZURE_SUBSCRIPTION_ID='<subscription-uuid>'
export AZURE_TENANT_ID='<tenant-uuid>'
export RESOURCE_GROUP='tonyai-staging-rg'
export PREFIX='tonyai'
export GITHUB_REPOSITORY='<owner>/<repository>'
export RELEASE_SHA="$(git rev-parse HEAD)"
test -z "$(git status --porcelain)"
# Confirm this SHA is the owner's reviewed candidate before the first mutation.
node --version # must be v22.x
pnpm --version # must match package.json packageManager
PUPPETEER_SKIP_DOWNLOAD=true PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 pnpm install --frozen-lockfile
pnpm db:generate
az login --tenant "$AZURE_TENANT_ID" --output none
az account set --subscription "$AZURE_SUBSCRIPTION_ID"
az account show --query '{subscription:id,tenant:tenantId}' -o json
az group create --name "$RESOURCE_GROUP" --location germanywestcentral --tags application=TonyAI environment=staging --query '{id:id,location:location}'
for provider in Microsoft.App Microsoft.ContainerRegistry Microsoft.KeyVault Microsoft.OperationalInsights Microsoft.ManagedIdentity; do
  az provider register --namespace "$provider" --wait --output none
done
az bicep version
az extension add --name containerapp --upgrade --only-show-errors
```

Expected/evidence: correct tenant/subscription IDs, group location
`germanywestcentral`, provider commands exit 0, CLI/Bicep version. Record the
release SHA, successful dependency install/Prisma generation and tool versions
with every run. These actions create billed cloud
resources; only the owner executes them. Existing group/name must be exclusively
staging. Do not reuse a production resource group.

## 1.2 Validate and apply foundation

```bash
az deployment group validate -g "$RESOURCE_GROUP" --template-file infra/azure/foundation.bicep --parameters prefix="$PREFIX" --query properties.provisioningState -o tsv
az deployment group what-if -g "$RESOURCE_GROUP" --template-file infra/azure/foundation.bicep --parameters prefix="$PREFIX"
az deployment group create -g "$RESOURCE_GROUP" -n lp2-foundation --template-file infra/azure/foundation.bicep --parameters prefix="$PREFIX" --query properties.provisioningState -o tsv
foundation_output() { az deployment group show -g "$RESOURCE_GROUP" -n lp2-foundation --query "properties.outputs.$1.value" -o tsv; }
export ACR_NAME="$(foundation_output registryName)"
export ACR_HOST="$(foundation_output registryHost)"
export VAULT_NAME="$(foundation_output vaultName)"
export WEB_ORIGIN="$(foundation_output webOrigin)"
export API_ORIGIN="$(foundation_output apiOrigin)"
export GROUP_ID="$(az group show -n "$RESOURCE_GROUP" --query id -o tsv)"
az acr config authentication-as-arm update -r "$ACR_NAME" --status enabled --output none
az acr config authentication-as-arm show -r "$ACR_NAME" --query status -o tsv
```

Expected/evidence: validation/apply `Succeeded`; what-if only intended staging
resources; ACR ARM-token authentication `enabled`. Save the nonsecret deployment
ID and resource IDs. App origins are derived before image builds, avoiding a
bootstrap image with wrong public settings. A second foundation apply must
succeed without changing identities/URLs. Purge protection prevents immediate
vault-name reuse after deletion: recover a soft-deleted vault; do not purge it.
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

Run once to create the dedicated app/service principal; on reruns reuse the
recorded IDs (do not create duplicate apps):

```bash
export AZURE_CLIENT_ID="$(az ad app create --display-name tonyai-staging-github --sign-in-audience AzureADMyOrg --query appId -o tsv)"
export DEPLOYER_OBJECT_ID="$(az ad sp create --id "$AZURE_CLIENT_ID" --query id -o tsv)"
python3 - <<'PY'
import json, os, re
from pathlib import Path
repo = os.environ['GITHUB_REPOSITORY']
assert re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repo)
data = json.loads(Path('infra/azure/github-federation.example.json').read_text())
data['subject'] = 'repo:' + repo + ':environment:staging'
Path('/tmp/tonyai-staging-federation.json').write_text(json.dumps(data))
PY
az ad app federated-credential create --id "$AZURE_CLIENT_ID" --parameters /tmp/tonyai-staging-federation.json --query '{name:name,issuer:issuer,subject:subject,audiences:audiences}'
az deployment group create -g "$RESOURCE_GROUP" -n lp2-deployer-access --template-file infra/azure/deployer-access.bicep --parameters prefix="$PREFIX" principalId="$DEPLOYER_OBJECT_ID" --query properties.provisioningState -o tsv
az ad app credential list --id "$AZURE_CLIENT_ID" --query 'length(@)' -o tsv
az ad app federated-credential list --id "$AZURE_CLIENT_ID" --query '[].{name:name,issuer:issuer,subject:subject,audiences:audiences}'
```

Expected/evidence: no password credentials (`0`); exactly the issuer
`https://token.actions.githubusercontent.com`, audience `api://AzureADTokenExchange`
and subject `repo:<owner>/<repository>:environment:staging`. The JSON file contains
identifiers only. For recreation reuse/update the named federation, or create a new
dedicated app if it was deleted. Never add a client secret as a fallback.

Set GitHub **environment variables**, not secrets: `AZURE_CLIENT_ID`,
`AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `RESOURCE_GROUP`, `ACR_NAME`, `PREFIX`.
LP2-02 supplies the workflow (`environment: staging`, `permissions: id-token: write,
contents: read`, `azure/login` with these IDs). No workflow file is added here.
The deployer gets Container Apps Contributor and Reader in this group, a custom
role for `Microsoft.Resources/deployments/*` in this group, AcrPush on this
registry and Managed Identity Operator on the two runtime identities. The custom
role is necessary because Container Apps Contributor cannot submit ARM deployments.
It grants neither role-assignment writes nor Key Vault data access. Recheck those
scopes and the absence of inherited broad roles before enabling the workflow.
Record actual OIDC-login success and negative branch/environment rejection in
LP2-02; creating the trust relationship alone does not prove token exchange.

Sources: [federation setup](https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation-create-trust),
[Container Apps roles](https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles/containers),
[ACR managed identity](https://learn.microsoft.com/en-us/azure/container-registry/container-registry-authentication-managed-identity).

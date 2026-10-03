# 1. Backend and Azure foundation

Complete [session setup](00-session.md). The owner approves region availability,
subscription, budget/alerts and organization billing before provisioning. Budget
amounts are deliberately unspecified. This code does not activate billing or
claim a cost ceiling.

## 1.1 Bootstrap the Entra-only backend

Fill `backend.json`: distinct staging account, owner object ID, explicit public
owner egress IPv4 (`/32`), empty `application_object_id` until OIDC is established.
No broad firewall range, trusted-service bypass or storage keys.

```bash
python3 infra/scripts/bootstrap_backend.py --config .infra-local/staging/backend.json
```

Expected `PASS`: account in Germany West Central, two private containers
(`foundation`, `application`), Entra-only data plane, deny-default IP firewall,
versioning and 30-day deletion retention, deletion lock. A timeout is resumable
with the same config/IDs. The bootstrap checks ownership tags and readbacks;
inspect inherited Azure roles and record least-privilege evidence separately.
Do not use a shared production account. Storage RBAC propagation may take time;
wait and rerun, never enable Shared Key as a workaround.

## 1.2 Apply foundation as owner

Start with `runtime_secrets_ready=false`, `apps_ready=false`, and an empty
deployer ID. Select globally unique names. Record the reviewed infrastructure
SHA in `release_sha`. The region is fixed by code.

```bash
python3 infra/scripts/terraform_run.py foundation plan --backend .infra-local/staging/backend.json --inputs .infra-local/staging/foundation.json
python3 infra/scripts/terraform_run.py foundation apply --backend .infra-local/staging/backend.json --inputs .infra-local/staging/foundation.json
terraform -chdir=infra/terraform/foundation output -json application_contract > .infra-local/staging/foundation-contract.json
source infra/scripts/restore-session.sh '<subscription-uuid>' '<staging-resource-group>'
```

Expected: ACR Basic/admin disabled, Consumption environment, workspace with
30-day retention, Azure Monitor diagnostics, RBAC/purge-protected vault, separate
API/web identities, registry pull grants and owner Secrets Officer. Review every
Terraform plan before typing `yes`. No Container App is created yet. Terraform
owns the RG and shared resources; do not edit them with alternate templates.
Copy the **public** contract into `release-r001.json.foundation`; verify names
against restoration. Never give the deployer access to foundation state.

## 1.3 Protect GitHub and create/resume the dedicated OIDC identity

Before federation: verify the GitHub plan actually enforces `staging` environment
required reviewers, no self-approval/bypass, deployment branches limited to main,
and protected workflow/source review. A displayed setting without enforcement
is insufficient. If unavailable, keep owner-only deployment and stop before
federation. The environment subject does not itself restrict branches. A deployer
can replace API code and obtain runtime data despite having no direct vault role.

```bash
python3 infra/scripts/configure_oidc.py --subscription "$AZURE_SUBSCRIPTION_ID" --group "$RESOURCE_GROUP" --repo '<owner/repo>' --environment-protection-verified
```

Expected: dedicated app/SP IDs, trusted owner lists, no passwords/certificates,
exact issuer `https://token.actions.githubusercontent.com`, audience
`api://AzureADTokenExchange`, subject `repo:<owner/repo>:environment:staging`.
The helper refuses an unrecorded same-name app, duplicate identities, foreign
owners/credentials or unexpected federation. If app creation succeeded but its
RG marker write failed, it refuses adoption on retry: inspect the new app/SP,
credential metadata and ownership in Entra, and reconcile that marker only after
owner review. Do not rerun with a new name to hide an ambiguous outcome.

Put the returned SP object ID in `foundation.json.config.deployer_object_id` and
`backend.json.application_object_id`; the client ID is for GitHub OIDC login only.
Rerun backend bootstrap and foundation plan/apply. This grants application-state
Blob Data Contributor, ACR push, identity operator and environment read/join.
After runbook 03 creates both apps **as owner**, set `apps_ready=true` and reapply
foundation to grant Container Apps Contributor at the two app IDs only. No RG-wide
app contributor, ARM deployment role, secret read, foundation-state access or
role-assignment writer is granted to the deployer.

The `infra.yml` workflow is validation-only. LP2-02 wires deployment with
`environment: staging`, `id-token: write`, enforced branch/reviewer checks and
serialized deployment. Backend firewall must admit the approved runner's fixed
egress (or an owner-managed private runner); never open all addresses for a hosted
runner. Do not grant the workflow foundation permissions to bypass bootstrap.

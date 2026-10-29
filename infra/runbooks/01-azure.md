# 1. Backend and Azure foundation

> **The QA and pilot deployment route (owner decision 2026-10-28).** The hosted phase
> builds this path **from scratch**: Supabase Cloud (Pro) in **North EU — Stockholm
> (`eu-north-1`)** and Azure Container Apps in **Sweden Central (`swedencentral`)**, in the
> paused self-hosted QA's subscription but in its own resource groups (`tonyai-qatmp-*`),
> prefix (`tonyaiqt`) and Terraform backend. Order and approvals:
> [`docs/TMP_Supabase_Azure_Doc/tmp_supabase_azure_roadmap.md`](../../docs/TMP_Supabase_Azure_Doc/tmp_supabase_azure_roadmap.md)
> section 5. WP-2 merged as #253; WP-3 merged as #254. Each live
> operation still needs its own owner approval. WP-6 CI deployment is deferred.
> **Section 1.1 here bootstraps the hosted phase's own backend** (`tonyai-qatmp-tfstate`,
> pinned by WP-2) — never the paused self-hosted backend account.

The owner approves subscription, Sweden capacity, budget/alerts and billing
before provisioning. No budget ceiling or provisioning approval is implied.

Before L2, reconcile the exact hosted exception in
`infra/config/hosted-qa-exception.json` with the reviewed nonsecret inputs:
the real subscription, `tonyai-qatmp-apps`, prefix `tonyaiqt`, environment
`staging`, `tonyai-qatmp-tfstate` and its dedicated globally unique backend
account. The foundation and application writers use separate state containers;
the application consumes only `application_contract`, never foundation state.
Placeholders must fail closed. Never use the paused backend or alter
`deployment-policy.json` / the frozen subscription refusal to make a target pass.

## 1.1 Bootstrap the Entra-only backend

Fill `backend.json`: distinct staging account, owner object ID, explicit public
owner egress IPv4 (`/32`), empty `application_object_id` until OIDC is established.
No broad firewall range, trusted-service bypass or storage keys.

Set backend `location` to `swedencentral`, matching the code default and
foundation contract.
Existing backend resources cannot be relocated by changing this field.

```bash
python3 infra/scripts/bootstrap_backend.py --config .infra-local/staging/backend.json
```

Expected `PASS`: account in Sweden Central (the configured `location`), two
private containers
(`foundation`, `application`), Entra-only data plane, deny-default IP firewall,
versioning and 30-day deletion retention, deletion lock. A timeout is resumable
with the same config/IDs. The bootstrap checks ownership tags and readbacks;
inspect inherited Azure roles and record least-privilege evidence separately.
Do not use a shared production account. Storage RBAC propagation may take time;
wait and rerun, never enable Shared Key as a workaround.

## 1.2 Foundation apply

Start with `runtime_secrets_ready=false`, `apps_ready=false`, and an empty
deployer ID. Select globally unique names. Record the reviewed infrastructure
SHA in `release_sha`. The region is fixed by code to `swedencentral`
(`terraform/foundation/variables.tf`). Complete section 1.4 identity preparation
before planning: SMTP Entra IDs are foundation inputs. Keep
`smtp_secret_ready=false` until the vault secret exists.

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

## 1.3 GitHub/Entra federation (deferred to WP-6)

Do not execute this section during WP-3 or the initial owner-run L1–L10.
The current JIT-only workflow contract remains enforced until WP-6 changes and
qualifies it; it is not a prerequisite for owner-run deployment.

Complete [runbook 03’s one-time GitHub/main/JIT setup](03-deploy.md#one-time-owner-setup)
before this step. Before federation: verify the GitHub plan actually enforces `staging` environment
required reviewers, no self-approval/bypass, deployment branches limited to main,
and protected workflow/source review. A displayed setting without enforcement
is insufficient. If unavailable, keep owner-only deployment and stop before
federation. The environment subject does not itself restrict branches. A deployer
can replace API code and obtain its runtime credential despite having no direct
vault role. It must never reach the owner credential; keep that secret outside
workloads and remove historical owner-backed runtime versions via runbook 05.

```bash
python3 infra/scripts/configure_oidc.py --subscription "$AZURE_SUBSCRIPTION_ID" --group "$RESOURCE_GROUP" --repo '<owner/repo>' --environment-protection-verified
```

The helper first requires `--repo` to equal the foundation `githubRepository`
tag. With an owner-authorized `gh` session on github.com, it reads the existing
staging environment and its branch policies: required reviewers, prevented
self-review, `can_admins_bypass: false` and exactly one `main` branch rule are
mandatory. It also checks the active no-bypass main ruleset, GitHub Actions
required checks, JIT runner mode and approval of all outside collaborators.
Missing/unreadable settings stop before Graph mutations; it never creates an
environment or changes repository policy. The flag attests actual plan enforcement
and independently reviewed fresh-host JIT isolation, which API configuration
readback alone cannot prove. Retain sanitized configuration and
actual denied/approved deployment evidence.

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

## 1.4 ACS Email identity and domain preparation

**L1b, before foundation:** in the approved tenant, the owner creates a dedicated
SMTP Entra application and service principal, separate from any OIDC deployer.
Prepare the packet only after L1's required inputs are verified or explicitly
accepted by the owner. Bind it to the exact tenant, subscription, signed-in owner
object ID and owner-selected display name. The owner approves **both named
identity creations** for L1b; approval does not include any other cloud operation.
Use a clean reviewed checkout, no tracing/debug/transcript, and preserve only
public IDs, operation time and nonsecret readback in the private owner record.

The L1 prepared hosted-QA packet (2026-10-28) has these public inputs; they are
not an approval or evidence that the identities exist:

| Input | Exact value |
|---|---|
| Tenant | `7fbd1f02-0b21-492b-a23c-4b46ce9d0d22` |
| Subscription | `cb7efc2f-37a7-4672-b62c-93c207bcd33d` |
| Signed-in owner object ID | `9d92febc-c0da-46e2-9498-a3d6c1829c48` |
| SMTP application display name | `tonyaiqt-staging-smtp` |

Compare all three identity/context readbacks below with this table immediately
before creation. Backend `tonyaiqtqabe` is the L2 target, not an L1b side effect.

Before either create, read the active context and check for name collisions:

```bash
az account show --query '{subscription:id,tenant:tenantId}' -o json
az ad signed-in-user show --query id -o tsv
az ad app list --display-name 'tonyaiqt-staging-smtp' \
  --query '[].{clientId:appId,objectId:id,displayName:displayName}' -o json
az ad sp list --display-name 'tonyaiqt-staging-smtp' \
  --query '[].{clientId:appId,principalId:id,displayName:displayName}' -o json
```

Stop on an identity/context mismatch, failed read or any same-name candidate.
An empty successful inventory is required for a new creation, but is not a
concurrency lock: use one owner session and prohibit parallel creation. Azure AD
commands use the active **tenant**; `--subscription` alone does not bind Graph.
If needed, the owner signs in to the exact tenant and selects the subscription,
then repeats these reads. Do not paste the following as an unattended batch:
inspect and record the application result before creating its service principal.
Neither command creates a password:

```bash
az ad app create --display-name 'tonyaiqt-staging-smtp' --sign-in-audience AzureADMyOrg --query '{clientId:appId,objectId:id}' -o json
az ad sp create --id '<returned-application-client-id>' --query id -o tsv
az ad app show --id '<returned-application-client-id>' --query '{clientId:appId,objectId:id,displayName:displayName,audience:signInAudience,passwordCount:length(passwordCredentials),certificateCount:length(keyCredentials),apiPermissionCount:length(requiredResourceAccess)}' -o json
az ad sp show --id '<returned-application-client-id>' --query '{clientId:appId,principalId:id,tenant:appOwnerOrganizationId,passwordCount:length(passwordCredentials),certificateCount:length(keyCredentials)}' -o json
az ad app owner list --id '<returned-application-client-id>' --query '[].id' -o json
az ad sp owner list --id '<returned-application-client-id>' --query '[].id' -o json
```

Expected: one single-tenant application and one service principal in the approved
tenant; matching client IDs, distinct object IDs, zero credentials and zero app
API permissions. Review owner IDs against the intended owner; an unexpected or
empty owner list requires reconciliation, not an automatic owner/role mutation.
No ACS resource, RBAC role, federation, consent, backend, secret, DNS change or
email is part of L1b. Record only these public identifiers. Put the application **client ID** in
`config.email.client_id`, the **service-principal object ID** in `principal_id`
and the verified tenant ID in `tenant_id`. Never substitute the application
object ID for either. An ambiguous create outcome requires owner reconciliation
before retrying; do not create duplicate identities. On an app timeout, stop all
writes, retain the attempted name/time and rerun only the inventory above.
Reconcile the exact app through Entra audit/provenance and owner metadata; a
matching name alone is not ownership proof. If the app is known but SP creation
is uncertain, use `az ad sp show --id '<recorded-client-id>'`. An error is not
proof of absence: allow for visibility/permission failures and obtain owner
reconciliation before another create. Never automatically adopt/delete a
candidate, choose a different name to retry, or use `create-for-rbac` or
credential-reset commands. The foundation owns the
Communication-resource-scoped SMTP role, username and ACS resources, with data
location Europe. Do not add subscription-wide mail roles in the portal.

**L3:** start with `custom_domain=null`, `custom_domain_verified=false` and
`smtp_secret_ready=false`. Foundation creates the Azure-managed domain and vault.
Read the public output after apply:

```bash
terraform -chdir=infra/terraform/foundation output -json email_contract
```

`enabled.username` and `enabled.sender` are the actual SMTP username and sender;
never guess the generated domain. `host`, `port` and `secure` must be
`smtp.azurecomm.net`, `587` and `false` (mandatory STARTTLS). This is public
configuration, not a password. Confirm the SMTP username is ready in ACS.

**L7, only after the vault and valid release manifest exist:** use Entra's
Certificates & secrets page to create a client secret with a custom expiry
**no more than 90 days** after creation. In a private unrecorded session, save
the value directly to the owner's password manager, then enter it at runbook
03 §3.5's hidden `smtp-password` prompt. Never use a CLI command that prints
the generated password, put it in argv, JSON, Terraform, a screenshot, a log or
chat. Record only credential ID/expiry and the returned vault version; schedule
owner rotation before expiry. Terraform must never create/read that secret.

### Optional custom sending domain (Namecheap)

This is a separately approved DNS/foundation change; the Azure-managed sender
can be used for initial QA. Set the actual `config.email.custom_domain`, leave
`custom_domain_verified=false`, then review/apply foundation to create the domain
without linking it. Read `email_contract.enabled.custom_domain_verification` and
the ACS domain's verification page. In Namecheap, confirm authoritative DNS is
hosted there, then Domain List → Manage → Advanced DNS → Host Records. Copy the
**actual ACS record types, hosts and values** for domain verification, SPF and
both DKIM selectors. Use relative hosts in Namecheap (do not append the domain
twice); merge an existing SPF record instead of creating a second one. Preserve
unrelated DNS/MX records. Configure the owner's DMARC policy for this sending
domain; do not invent DNS values or a policy on the owner's behalf.

Wait for DNS propagation and trigger ACS verification for ownership, SPF and
DKIM/DKIM2. Only after every required status succeeds, set
`custom_domain_verified=true` and review/apply foundation. The flag is an owner
attestation, not a DNS verifier. Read back the linked domain and new public
sender, update a new release's `mail.from`, then perform §3.5's SMTP acceptance.
Keep the Azure-managed domain; do not delete it during transition. If verification
fails, keep the flag false and the existing sender. If delivery fails after
cutover, use a new owner-reviewed release with the previously qualified sender.

References: [ACS SMTP authentication](https://learn.microsoft.com/en-us/azure/communication-services/quickstarts/email/send-email-smtp/smtp-authentication)
and [Namecheap host record types](https://www.namecheap.com/support/knowledgebase/article.aspx/579/2237/which-record-type-option-should-i-choose-for-the-information-im-about-to-enter/).

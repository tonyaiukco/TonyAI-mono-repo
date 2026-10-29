# 0. Safe owner session and restoration

> **The QA and pilot deployment route (owner decision 2026-10-28).** The hosted phase
> builds this path **from scratch**: Supabase Cloud (Pro) in **North EU — Stockholm
> (`eu-north-1`)** and Azure Container Apps in **Sweden Central (`swedencentral`)**, in the
> paused self-hosted QA's subscription but in its own resource groups (`tonyai-qatmp-*`),
> prefix (`tonyaiqt`) and Terraform backend. Order and approvals:
> [`docs/TMP_Supabase_Azure_Doc/tmp_supabase_azure_roadmap.md`](../../docs/TMP_Supabase_Azure_Doc/tmp_supabase_azure_roadmap.md)
> section 5. WP-2 merged as #253; WP-3 merged as #254. Each live
> operation still needs its own owner approval. WP-6 CI deployment is deferred.

## L1: prerequisite evidence before provisioning

L1 authorizes only local preparation and explicitly approved read-only metadata
checks. Record each result in the central planning file as `VERIFIED`,
`OWNER_CONFIRMATION_REQUIRED` or `BLOCKED`, with observation time and source.
An expired CLI session or a cached `az account show` result is not live evidence.
Never run provider registration, backend bootstrap, Terraform plan/apply or
`supabase_setup.py` as an offline preflight.

Collect the following without requesting secret values:

- Azure tenant/subscription and signed-in owner object ID; subscription Owner,
  or Contributor plus User Access Administrator, including inherited scope and
  conditions. Check Entra application-registration permission separately from
  Azure RBAC; metadata is not proof that a future create will succeed.
- Registration readback for all eight providers listed below (namespace casing
  may differ). Missing registration requires a separately approved operation.
- Budget-alert readback and scope; credit amount/expiry and spending acceptance
  separately as provider evidence or an explicitly labelled owner declaration.
  An empty subscription budget list does not prove there are no billing-scope
  budgets, and an Azure credit assumption does not fund Supabase billing.
- Owner public egress IPv4 from the workstation/network that will run L2;
  owner confirmation of VPN/static/dynamic status. This initial backend allows
  exactly one public `/32`, no runner range or trusted-service bypass. Recheck
  after a network change; never widen the rule to compensate for a dynamic IP.
- Supabase organisation ID **and** slug, current Pro billing entitlement,
  account MFA, and whether a usable Management API token is held in the password
  manager. The owner can inspect organisation settings/Billing and account
  security; record uninspected dashboard claims as owner declarations. Never
  request a token value or invoke project setup merely to check entitlement.
- Node 22, pnpm 11.9.0, Terraform 1.13.3, Python 3.10+, Azure CLI, host `psql`,
  Docker server and buildx. Record actual executable paths when PATH differs.
  One local Supabase stack only; stop it before heavy Docker builds.

The binding is Supabase `eu-north-1` (Stockholm), Azure `swedencentral`,
`staging`, prefix `tonyaiqt`, groups `tonyai-qatmp-tfstate` and
`tonyai-qatmp-apps`. The owner selects a dedicated backend account matching
`tonyaiqt[a-z0-9]{1,16}`; Azure name availability is a point-in-time check, not
a reservation. Update the versioned `infra/config/hosted-qa-exception.json`
with that confirmed account/subscription in a reviewed change before live use.
Do not edit the frozen deployment policy or replace missing IDs with test UUIDs.

After real nonsecret backend inputs and the exact exception are available, this
pure validation makes no cloud call:

```bash
python3 - <<'PY'
import ipaddress
import json
import sys
from pathlib import Path
sys.path.insert(0, "infra/scripts")
from bootstrap_backend import validate
from hosted_target import hosted_exception, require_hosted_backend
from deployment_policy import require_hosted_target

backend = json.loads(Path(".infra-local/staging/backend.json").read_text())
exception = hosted_exception()
validate(backend)
require_hosted_backend(backend)
require_hosted_target(backend["subscription_id"], exception["resource_group"],
                      exception["prefix"], backend["environment"])
if (backend["location"] != "swedencentral"
        or backend["application_object_id"] != ""
        or len(backend["allowed_ipv4"]) != 1
        or ipaddress.ip_network(backend["allowed_ipv4"][0]).prefixlen != 32):
    raise SystemExit("BLOCKED: initial backend needs owner-only public IPv4 /32.")
print("PASS: exact hosted target/backend binding; owner-only /32 bootstrap.")
PY
```

The state container/key pairs are `foundation` / `staging.tfstate` and
`application` / `staging.tfstate`. Owner writes foundation;
the later application writer gets only application-container access and the
public `application_contract`, never foundation state. Keep its principal empty
until the separately authorized WP-6 federation work.

L1 does not require invented downstream outputs: full foundation validation
awaits L1b's real SMTP client/SP IDs; Supabase's vault/web origin await L3.
Project ref, PostgreSQL version, pooler host, CA and privilege acceptance await
L4/L4a. List those as deferred dependencies, never `VERIFIED`. Missing L1 inputs
keep L1 open and block the L1b approval request.

## Owner session setup and restoration

These commands are for the owner after cloud/budget approval, not for the coding
agent. Use Bash or zsh from the repository root, a private terminal without
transcripts, shell tracing, Azure/HTTP debug logging or Terraform debug variables.
No secrets in command arguments, shell history, files or chat. Helpers use hidden
input and captured in-memory requests; failures suppress provider bodies.

```bash
node --version      # v22.x
pnpm --version      # 11.9.0
terraform version   # 1.13.3
az version
gh --version
python3 --version
mkdir -p .infra-local/staging
chmod 700 .infra-local .infra-local/staging
cp infra/config/backend.example.json .infra-local/staging/backend.json
cp infra/config/foundation.example.json .infra-local/staging/foundation.json
cp infra/config/supabase.example.json .infra-local/staging/supabase.json
cp infra/config/application.example.json .infra-local/staging/release-r001.json
```

On first setup only, replace placeholders using an editor. Subsequent sessions
**do not copy templates over existing files**. These JSON files and the journal
contain only public identifiers, digests and version IDs. Keep private backups
of the nonsecret journal/release manifests outside Git; losing an intent journal
requires owner recovery of creation provenance; it never authorizes project adoption. Never fill a secret into a JSON input.
Use unique backend account, vault, registry, group and project names for each
recreation. Production uses a separate backend account, RG, identities, vault,
Supabase project and protected GitHub environment; LP2-04 completes its domain,
email, backup and operational acceptance. No shared staging credentials/state.

```bash
az login --tenant '<tenant-uuid>' --output none
az account set --subscription '<subscription-uuid>'
az account show --query '{subscription:id,tenant:tenantId}' -o json
az ad signed-in-user show --query id -o tsv
```

Expected: the reviewed tenant/subscription and owner object ID. Fill both Azure
config files consistently. Owner has the necessary subscription/RG creation and
RBAC administration rights plus permission to create the dedicated Entra app.
Register `Microsoft.App`, `Microsoft.ContainerRegistry`, `Microsoft.KeyVault`,
`Microsoft.ManagedIdentity`, `Microsoft.OperationalInsights`, `Microsoft.Insights`,
`Microsoft.Communication` and `Microsoft.Storage` as the owner (`az provider register --namespace <name>
--wait`). Record each registration, not a claim based on these instructions.

After foundation exists, this works in a fresh Bash/zsh terminal:

```bash
source infra/scripts/restore-session.sh '<subscription-uuid>' '<staging-resource-group>'
```

Expected: `PASS: foundation session restored`. The helper clears stale values first,
checks real resource IDs, tags, region, ACR host and environment domain and quotes
exports. Failure returns to the interactive shell with targets unset. Without a
journal argument, project variables are empty. Digests and secret versions come
from the explicitly selected release manifest, never resource-group tags. The foundation's
`releaseSha` tag is initial infrastructure provenance, **not** the current image
release: builds take an explicit SHA and deployments take an explicit manifest.
Never substitute a candidate file for the selected release.

Restore the Supabase project after runbook 02 without exposing keys:

```bash
source infra/scripts/restore-session.sh '<subscription-uuid>' '<staging-resource-group>' .infra-local/staging/supabase-journal.json
```

The journal must be completed and match the verified vault and web origin; a
foreign, missing or incomplete journal fails without leaving stale exports.

The application runner reinitializes its backend every time from explicit inputs,
rejects target/environment mismatches and ambient `TF_VAR_*`, debug flags, CLI
arguments, SAS/access keys and client secrets. The deployment helper saves and displays its application plan, asks for approval
before draining the API, then applies that same plan. A failure is not
permission to paste provider output into chat; retain sanitized IDs/status only.

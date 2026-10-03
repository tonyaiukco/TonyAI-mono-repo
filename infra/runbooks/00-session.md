# 0. Safe owner session and restoration

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
makes automatic project adoption unsafe. Never fill a secret into a JSON input.
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
`Microsoft.ManagedIdentity`, `Microsoft.OperationalInsights`, `Microsoft.Insights`
and `Microsoft.Storage` as the owner (`az provider register --namespace <name>
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
arguments, SAS/access keys and client secrets. It uses no saved plan file. Apply
shows a fresh plan and asks for Terraform's normal confirmation. A failure is not
permission to paste provider output into chat; retain sanitized IDs/status only.

# 2. Resumable Supabase Frankfurt setup

First restore the owner session. Complete `supabase.json` with organization ID
**and slug**, a unique staging/recreation name, the foundation vault and exact
`WEB_ORIGIN`. Obtain a scoped Supabase management token in the owner's secure
session; never save it in the repository or Terraform/GitHub inputs. Billing is
organization-level; selecting a `plan` on project creation is deprecated/ignored.
The owner approves budget/Pro during UAT separately. The helper requests the exact
`eu-central-1` region, not a broad smart-region group.

```bash
python3 infra/scripts/supabase_setup.py --config .infra-local/staging/supabase.json --journal .infra-local/staging/supabase-journal.json --foundation .infra-local/staging/foundation.json --billing-approved
```

Enter the token at the hidden prompt. The helper:

1. Generates a DB bootstrap password and transfers it directly to owner-only
   Key Vault `bootstrap-db-password` before project creation.
2. Saves nonsecret creation intent before POST. On retry, a unique project with
   matching name, organization and Frankfurt region is recovered. Existing
   unrecorded projects, duplicate matches and unknown outcomes stop safely.
3. Waits for `ACTIVE_HEALTHY` by returning a resumable message; rerun the **same**
   command/journal after provisioning finishes. It does not create a second project.
4. Reads provider-created anon/service-role keys directly into memory; verifies
   project/role; puts only the backend key in Key Vault. No duplicate API keys are
   created. Pooler host comes from the Management API; URLs are built in memory.
5. Stores `database-url` (transaction 6543) and `direct-url` (session 5432), with
   Frankfurt/project binding, `/postgres`, strict CA verification, and an allowlist
   of query parameters. API's runtime DIRECT_URL is deliberately the runtime URL;
   the migration URL stays owner-only. LP1-03 later narrows runtime DB privileges.
6. Reconciles both private buckets (`evidence`, `import-sources`), limits/MIME types
   and readback. Disables signup/anonymous/phone/SAML/passkeys/unused providers,
   pins site URL and redirects to exactly `WEB_ORIGIN` and `WEB_ORIGIN/login`.
7. Uses an existing active ES256/RS256 key or creates one journaled ES256 standby,
   activates it and verifies the active public JWKS ID. Ambiguous signing-key
   creation stops; subsequent runs reconcile the recorded key, never POST blindly.

Expected final `PASS`, public project reference and exact vault versions in the
journal. Secret values never enter the journal. A completed initial setup is a
no-op on retry; future credential changes use runbook 05. Preserve the journal
before closing the terminal and prohibit simultaneous setup from different
machines/journal copies; the helper locks its local journal, not the remote account.

On a timeout with no visible project/key: wait for eventual visibility and retry.
If it remains absent, reconcile the request with Supabase using operation time,
project name and organization, then have the owner review the journal recovery.
Do not delete `project_pending` or `signing_before_ids` simply to retry. If the
journal is lost, stop automatic creation/adoption and reconstruct IDs/ownership
from provider evidence. No automated project/key deletion is implemented.

Restore public project variables using runbook 00. Copy journal
`versions.database_url_version` and `versions.backend_secret_version` into the
release's `database_secret_version`/`backend_secret_version`. Then set foundation
`runtime_secrets_ready=true` and run its plan/apply again. Only API gets Secrets
User on `database-url` and `supabase-service-role-key` at individual-secret scopes.
The bootstrap password and `direct-url` have no API/web/deployer read grant.

```bash
python3 infra/scripts/cloud_ops.py probe-storage --vault "$VAULT_NAME" --project-ref "$SUPABASE_PROJECT_REF" --source-sha '<reviewed-helper-full-sha>'
```

Expected for both buckets: upload, public denial, 60-second signed download byte
match, and removal of exactly the probe object. Failed cleanup remains an owner
action; identify only that synthetic probe path and remove it before recording a
pass. Inspect `infra/supabase/verify.sql` through the secure SQL editor after
migrations: no demo users/tenants/factors; private buckets and expected RLS. Never
run local seed or local RLS/E2E fixtures against cloud. Assess Supabase network
restrictions against actual ACA egress; don't claim a fixed egress allowlist on
plain Consumption. SMTP/invitation and production PITR are LP2-04.

API contract reviewed against [Supabase Management API](https://supabase.com/docs/reference/api/introduction)
and its public OpenAPI schema on 2026-10-03. Region availability, actual API
responses, key propagation and the bundled CA chain remain owner-run evidence.

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
4. Reads existing keys into memory, preferring `sb_publishable_` / `sb_secret_`.
   Legacy anon/service-role JWTs are a fallback only when that modern key type is
   absent. Ambiguous inventories stop for owner reconciliation; no keys are created.
   Both keys must pass live probes against this exact project before any transfer.
   Only the backend key enters Key Vault. Pooler host comes from the Management API.
   Its literal `[YOUR-PASSWORD]` marker is normalized only for host discovery;
   the stored URLs use the bootstrap password read privately from Key Vault.
5. Stores `database-url` (transaction 6543) and `direct-url` (session 5432), with
   Frankfurt/project binding, `/postgres`, strict CA verification, and an allowlist
   of query parameters. API's runtime DIRECT_URL is deliberately the runtime URL;
   only the owner reads the separate migration secret. **Both URLs currently use
   the same `postgres.<ref>` role and password: deploy access equals database-owner
   access until LP1-03 supplies a separate least-privilege runtime role.** Rotate
   both URLs together. After both writes, the journal checkpoints exact versions
   and the helper disables that bootstrap password version. On interruption it
   reuses the checkpointed URLs and repeats the disable without reading the
   disabled password or making replacement URLs.
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
The disabled bootstrap version and `direct-url` have no API/web/deployer read
grant; this does not isolate database authority because the enabled runtime URL
contains the same database-owner password. Disabling the bootstrap copy reduces
retained enabled copies; it does not revoke or reduce runtime privileges.

```bash
python3 infra/scripts/cloud_ops.py probe-storage --vault "$VAULT_NAME" --project-ref "$SUPABASE_PROJECT_REF" --source-sha '<reviewed-helper-full-sha>' --secret-version '<selected-backend-secret-version>'
```

Use `versions.backend_secret_version` from the completed setup journal, or the
backend version from the selected release after rotation; never select latest.

Expected for both buckets: upload, public denial, 60-second signed download byte
match, and a deletion acknowledgment for the exact probe prefix. This is an API
acknowledgment, not an independent absence readback. In the Storage dashboard
confirm no objects remain under `lp2-foundation-probe/` before recording cleanup
evidence; inspect/remove only these synthetic probes if cleanup was interrupted. Inspect `infra/supabase/verify.sql` through the secure SQL editor after
migrations: no demo users/tenants/factors; private buckets and expected RLS. Never
run local seed or local RLS/E2E fixtures against cloud. Assess Supabase network
restrictions against actual ACA egress; don't claim a fixed egress allowlist on
plain Consumption. SMTP/invitation and production PITR are LP2-04.

API contract reviewed against [Supabase Management API](https://supabase.com/docs/reference/api/introduction)
and its public OpenAPI schema on 2026-10-03. Region availability, actual API
responses, key propagation and the bundled CA chain remain owner-run evidence.

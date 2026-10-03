# 4. Acceptance evidence, recreation and recovery

First [restore the session](00-session.md). The owner records each actual result in the PR's B9 handoff, including integrated
SHA, timestamp, environment/project ref, command/scenario, result and a sanitized
evidence location. A blank checklist is not a successful cloud execution.

## 4.1 Inspect the deployed contract

```bash
az resource list -g "$RESOURCE_GROUP" --query '[].{name:name,type:type,location:location}' -o table
az acr show -n "$ACR_NAME" --query '{sku:sku.name,admin:adminUserEnabled}'
az keyvault show -n "$VAULT_NAME" --query '{rbac:properties.enableRbacAuthorization,purgeProtection:properties.enablePurgeProtection}'
az containerapp secret list -g "$RESOURCE_GROUP" -n "$PREFIX-staging-api" --query '[].{name:name,keyVaultUrl:keyVaultUrl,identity:identity}'
az containerapp secret list -g "$RESOURCE_GROUP" -n "$PREFIX-staging-web" --query '[].name'
az role assignment list --scope "$(foundation_output vaultId)" --all --query '[].{role:roleDefinitionName,scope:scope,principal:principalId}'
```

Expected: Germany West Central; ACR Basic/admin false; Key Vault RBAC/purge
protection true; API's two **references** with API identity; no web secrets.
Inspect the secret-level role assignments in the portal as well: API has Secrets
User on the two runtime secrets only; `direct-url` has no API/web/deployer grant.
**These are Key Vault grant boundaries, not separate DB roles. Both URLs share
database-owner credentials: deploy access equals database-owner access until
LP1-03 delivers the least-privilege runtime role. Both URLs rotate together.**
Verify the journaled `bootstrap-db-password` version is disabled using secret
version metadata only. Record the scope/role/principal IDs, never call a secret command with `--show-values`.
Audit inherited subscription/group assignments too; an inherited broad role can
invalidate least-privilege claims despite correct template assignments.

## 4.2 HTTP and logging checks

```bash
curl --fail --silent --show-error "$API_ORIGIN/api/v1/health"
curl --fail --silent --show-error --max-time 5 "$API_ORIGIN/api/v1/health/ready"
curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' "$WEB_ORIGIN/login"
curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' "$API_ORIGIN/api/v1/subsidiaries"
curl --silent --show-error -D - -o /dev/null -X OPTIONS "$API_ORIGIN/api/v1/subsidiaries" -H "Origin: $WEB_ORIGIN" -H 'Access-Control-Request-Method: GET'
curl --silent --show-error -D - -o /dev/null -X OPTIONS "$API_ORIGIN/api/v1/subsidiaries" -H 'Origin: https://untrusted.invalid' -H 'Access-Control-Request-Method: GET'
```

Expected: health JSON and 200; login 200; unauthenticated tenant route **401**.
CORS for the allowed origin must contain exactly `$WEB_ORIGIN`; the untrusted
request must never receive an allow-origin value matching `https://untrusted.invalid`
or `*` (the current static CORS setting may return the pinned web origin).
A cold scale-to-zero app may need another request after startup; repeated failures
are a failed check, not permission to disable auth or probes.

In the workspace's Logs view, run:

```kusto
ContainerAppConsoleLogs
| where ContainerAppName endswith "-staging-api"
| where TimeGenerated > ago(30m)
| extend entry = parse_json(Log)
| where isnotempty(entry.requestId)
| project TimeGenerated, level=tostring(entry.level), status=toint(entry.status)
| take 10
```

Expected/evidence: the rejected tenant request is observable as a structured
warning/status without bearer tokens or secret values. Inspect system logs for
secret-resolution/image-pull failures privately; do not publish raw logs.

## 4.3 Acceptance matrix and remaining live proof

| Requirement | Owner action and evidence |
|---|---|
| Foundation recreates | Run steps 0–3 with a separate backend account, owner-approved staging rehearsal RG and Supabase project; record IDs, region, successful deployment IDs, migration status and image digests. Reapplying the original environment only proves convergence, not fresh recreation. |
| Idempotence | Repeat foundation plan/apply and the bucket command below; stable resource identities/origins and same private settings. |
| No demo credentials | `verify.sql` counts, no `@tonyai.local` Auth users; before onboarding, zero Auth/factor rows. Inspect ACA env names: no `ALLOW_INSECURE_LOCAL_AUTH`, no `SUPABASE_JWT_SECRET`, JWKS pinned. |
| Auth confinement | Run the public-key `/auth/v1/settings` probe (signup/unused providers disabled) and separately verify the dashboard redirect list; in a private owner test, signup is refused. Never post passwords/tokens as evidence. |
| Storage works privately | Both bucket probes pass; SQL confirms default-deny policies. Also test authenticated browser direct read/write denial with a controlled user when onboarding exists. |
| No exposed service keys | Compare deployment secret references and RBAC scopes; in private DevTools confirm web requests use only public browser credentials. No service key in assets/build settings/GitHub. |
| Web environment binding | Browser login contacts the exact staging Supabase host and API URL; record public hosts and image digest. |
| Federation | Subject/audience/issuer plus protected environment settings now; successful and denied OIDC exchanges from LP2-02 workflow later. |
| Runtime privilege/RLS | Coordinate LP1-03/LP2-03 cloud-safe fixtures and full containment suite with random unique credentials. Existing `scripts/rls-probes.mjs` assumes local demo accounts and mutates fixtures; **do not run it against staging**. No empty-database containment claim. |

To repeat bucket reconciliation, select the backend version from the reviewed
release manifest (or completed initial setup journal):

```bash
python3 infra/scripts/cloud_ops.py buckets --vault "$VAULT_NAME" --project-ref "$SUPABASE_PROJECT_REF" --source-sha '<reviewed-helper-full-sha>' --secret-version '<selected-backend-secret-version>'
```

Run [rotation/recovery](05-rotation.md) when credentials change or a vault is recovered.

See [LP2-03 operational acceptance](06-operations.md) for bounded dependency loss,
synthetic flows, named-operator alerts, rotation and rollback rehearsal.

Only mark LP2-01 DONE after its actual foundation/recreation evidence closes.
The pending cloud containment work, exact-image startup/login/export smoke
(LP2-02), authenticated flow, DB-loss readiness and rollback rehearsal (LP2-03)
remain G2 gates; a 200 health route closes none of those. The B9 handoff must
name any unexecuted scenario, including steps delegated to the owner.

## 4.4 Rollback and recovery boundaries (F11/F12)

Before changing an existing environment, retain the previous release SHA, API/web
digests, public web inputs, template revision, Auth settings, secret **names and
versions** (not values), migration list and backup identifiers. Reapplying
the application Terraform root with previous digests is an image rollback only; do it only after
schema compatibility review. No automatic down migrations. For incompatible
schema changes, stop traffic and use a separately verified DB/file restoration
or forward fix. The evidence relationship migration cannot be undone by reverting
a container. LP2-03 rehearses that decision with a known candidate.

Use the versioned manifest procedure in [runbook 05](05-rotation.md) for rollback.
It retains compatible image digests and enabled secret versions, assigns a new
revision ID and uses the same Terraform application deployment/readback path.
Repeat 4.1–4.3; record actual ready revisions and authenticated flow results.
A failed readback means deployment state is uncertain, not a successful rollback.

Supabase database backups exclude Storage file bytes. Protect `evidence` **and**
`import-sources` separately, including object key, size and SHA-256 inventory,
and retain bucket policies, Auth settings, identities/RBAC, image digests and
secure secret recovery/rotation procedures. Use this order for backup/restore; the hold is per process:

1. Stop tenant writes for a consistent backup/restore window. Create a new release
   manifest with `release.storage_cleanup_hold=true`; deploy it through runbook 03.
   Verify `STORAGE_CLEANUP_HOLD=1` on **every API process/active revision** and any
   manually running sweeper. A new revision alone is insufficient while old replicas
   are draining: wait until no old unheld process remains. Set the hold before backup
   begins and keep it throughout DB and both-bucket restoration.
2. In the private shell running the matching API image/tool, also run
   `export STORAGE_CLEANUP_HOLD=1`. After the DB and bytes are restored, run:
   `node dist/storage/reconcile.cli.js --forget-uploads --allow-remote`.
   Save its report privately. Restored upload intents can otherwise delete bytes
   committed in the discarded history after the hold lifts.
3. With that shell hold still set, run
   `node dist/storage/reconcile.cli.js --verify --allow-remote` and retain the report.
   Exit 1 requires investigation; exit 2 means the check failed. Any `truncated:true`
   makes coverage incomplete, even on exit 0; do not claim a complete restore.
4. Read both reports, reconcile every missing/hash-mismatched file and record owner
   sign-off. Only then deploy a new manifest with `storage_cleanup_hold=false`,
   verify all processes, clear the shell hold, and resume writes. Never reclaim
   orphans as part of the restore procedure.

`storage_sweep_interval_seconds` is a plain release setting (default 300).
The scheduled verification job always keeps its own hold set; it never removes
objects and never replaces the private post-restore report review.

The owner must set RPO/RTO and backup retention; LP5-03 proves restoration into an
isolated environment: database/audit counts, immutable factor snapshots, links,
source-file bytes/checksums, login and a reconciled report, with elapsed time and
recovered-data age. No backup schedule, PITR guarantee or successful restore is
claimed by this foundation. Production backup/PITR selection belongs to LP2-04.
Do not destroy the original project or rehearsal evidence before owner review.

Sources: [Key Vault references](https://learn.microsoft.com/en-us/azure/container-apps/manage-secrets),
[Supabase backup limits](https://supabase.com/docs/guides/platform/backups).

## 4.5 Terraform/backend evidence

Record the integrated SHA, pinned provider versions, backend account/container/key,
state blob version IDs (metadata only), foundation contract and release manifest.
Repeat a no-change plan for each root. Confirm the deployer can lease/read/write
only the application blob and receives access denied for foundation state and
another environment's account. Verify denial from a nonallowlisted source IP.
Hold a state lease from one approved session and verify a second plan/apply waits
or times out; never use `-lock=false`. Rehearse version recovery with a disposable
state blob before using a real state version; preserve production isolation.
Audit inherited roles: scoped grants do not cancel broader inherited access.

Review initial state privately for absence of DB URLs, service keys, workspace
shared keys, SAS/access keys or inline Container App secrets. Never attach raw
state, plans, token-bearing responses or diagnostic logs as evidence. Record a
sanitized assertion and reviewer, not secret material. Refresh/read behavior is
configuration-reviewed offline; this live check closes that separate evidence gap.

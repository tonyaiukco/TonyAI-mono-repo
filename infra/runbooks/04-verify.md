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
Confirm the selected `database-url` uses `tonyai_runtime.<project-ref>` and the
owner `direct-url` is absent from every API/job environment and secret reference.
Run runbook 05's [Runtime connection and privilege evidence](05-rotation.md#runtime-connection-and-privilege-evidence)
procedure: `runtime-identity.mjs && runtime-role.mjs check` using the same
`DATABASE_URL`. Require both checks to pass and attach their full output,
including PUBLIC warnings; the privilege check alone is insufficient evidence.
Then run the [owner reconciliation check](05-rotation.md#owner-reconciliation-check)
from the deployed SHA and attach its output too.
Keep pg_net disabled unless a feature needs it.
Verify the journaled `bootstrap-db-password` version is disabled using secret
version metadata only. Record the scope/role/principal IDs, never call a secret command with `--show-values`. The reviewed `owner-psql`
helper is the exception for private use of an exact owner version in a child
environment; it never displays the value.
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
| No demo credentials | `verify.sql` counts, no `@tonyai.local` Auth users; before onboarding, zero Auth/factor rows, and the owner reconciliation check prints no placeholder or fixture release line. Inspect ACA env names: no `ALLOW_INSECURE_LOCAL_AUTH`, no `SUPABASE_JWT_SECRET`, JWKS pinned. |
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
   `export STORAGE_CLEANUP_HOLD=1`. After the DB (through the
   [restore procedure below](#database-restore-procedure-and-lp5-03-drill)) and
   the bytes are restored, run:
   `node dist/storage/reconcile.cli.js --forget-uploads --allow-remote`.
   Save its report privately. Restored upload intents can otherwise delete bytes
   committed in the discarded history after the hold lifts.
3. With that shell hold still set, run
   `node dist/storage/reconcile.cli.js --verify --allow-remote` and retain the report.
   Exit 1 requires investigation; exit 2 means the check failed. Any `truncated:true`
   makes coverage incomplete, even on exit 0; do not claim a complete restore.
4. Read both reports, reconcile every missing/hash-mismatched file and record owner
   sign-off. Only then deploy a new manifest with `storage_cleanup_hold=false`
   using owner-run `deploy-apps.sh --ack-clear-storage-hold` (plus backend/inputs),
   verify all processes, clear the shell hold, and resume writes. Never reclaim
   orphans as part of the restore procedure.

`storage_sweep_interval_seconds` is a required plain release setting (1–86400;
normally 300). Both it and `storage_cleanup_hold` must be explicit, including in
older manifests selected for rollback.
The scheduled verification job always keeps its own hold set; it never removes
objects and never replaces the private post-restore report review.

### Database restore procedure and LP5-03 drill

A logical restore never goes into a database that already holds data. The target
is a newly created, isolated Supabase project in the source's region, prepared through runbook 02
(including both buckets from its reconciliation) and migrated through runbook 03
§3.2 **at the source's deployed SHA**. Its schema comes only from the committed
migration chain, never from a dump. Nothing else may write to it before the load.

Use one PostgreSQL 17 client installation, 17.6 or newer, for `pg_dump`,
`pg_restore` and `psql`: an older `psql` cannot read the `\restrict` lines that a
current `pg_dump` writes. In the private owner shell, export the libpq settings the
`owner-psql` helper uses for the **source** project: `PGHOST`, `PGPORT=5432`,
`PGDATABASE=postgres`, `PGUSER=postgres.<project-ref>`, `PGPASSWORD` through hidden
input, `PGSSLMODE=verify-full` and `PGSSLROOTCERT` set to the absolute path of
`infra/certs/prod-ca-2021.crt`. Never put a URL or password on a command line.
With tenant writes stopped under the hold (step 1 above), work in a private
directory:

```bash
cat > row-counts.sql <<'SQL'
SELECT n.nspname || '.' || c.relname || ' ' ||
       (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind IN ('r', 'p') AND n.nspname IN ('public', 'auth', 'storage')
   AND (n.nspname <> 'storage' OR c.relname IN ('objects', 'prefixes', 'buckets'))
   AND (n.nspname, c.relname) <> ('public', '_prisma_migrations')
   AND NOT (n.nspname = 'auth' AND c.relname IN ('schema_migrations', 'sessions', 'refresh_tokens', 'mfa_amr_claims', 'mfa_challenges', 'one_time_tokens', 'flow_state', 'saml_relay_states', 'oauth_authorizations', 'oauth_client_states'))
 ORDER BY 1;
SQL
psql -X -At -c "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name" > source-migrations.txt
psql -X -At -f row-counts.sql > source-counts.txt
pg_dump --data-only --format=custom --file=tonyai-data.dump \
  --table='public.*' --exclude-table-data=public._prisma_migrations \
  --table=auth.users --table=auth.identities --table=auth.mfa_factors --table=auth.audit_log_entries \
  --table=auth.instances --table=auth.sso_providers --table=auth.sso_domains --table=auth.saml_providers \
  --table=auth.oauth_clients --table=auth.oauth_consents \
  --table=storage.objects --table=storage.prefixes
```

The dump holds:

- the application data, without `_prisma_migrations` (the target has its own rows
  from its migration run);
- from Auth, only the named tables: users, identities, MFA factors, provider
  configuration and Auth's audit log;
- Storage's object metadata (`storage.objects`, `storage.prefixes`).

The bytes are protected separately (above).

It deliberately carries **no session and no token**. `auth.sessions`,
`refresh_tokens`, `mfa_amr_claims`, `mfa_challenges`, `one_time_tokens`,
`flow_state`, `saml_relay_states`, `oauth_authorizations` and
`oauth_client_states` stay behind, so no bearer credential leaves the source.
Every user signs in again after a restore; announce that in a real recovery.

It takes no other Storage table. Buckets and their settings come from runbook 02,
and the owner cannot write Storage's vector tables. The other platform schemas hold
nothing TonyAI uses. A named table that does not exist on the project's Auth or
Storage version is skipped. `row-counts.sql` counts every Auth table except the
ten above (the nine left behind and `auth.schema_migrations`), so a new Auth
table holding rows on the source shows up in the count diff instead of being
copied unseen.

**The dump is a secret.** `tonyai-data.dump`, and the `tonyai-data.sql` rendered
from it, hold every tenant's data, personal data, and Auth's password hashes and
MFA secrets. Keep them only on encrypted, owner-only storage in the EU, never in
the evidence store, a PR, chat or a shared host. Record the dump's SHA-256 (for
example `shasum -a 256 tonyai-data.dump`), then delete both files after owner
sign-off. The evidence is `row-counts.sql`, `source-migrations.txt`,
`source-counts.txt` and that checksum.

Switch the libpq settings to the **target** project. Then compare the migration
lists and load the data as the owner, in one transaction, with the insert-time
rules stepped aside:

```bash
psql -X -At -c "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name" | diff source-migrations.txt -
pg_restore --file=tonyai-data.sql tonyai-data.dump
psql -X -v ON_ERROR_STOP=1 --single-transaction -c 'SET session_replication_role = replica' -f tonyai-data.sql
psql -X -At -f row-counts.sql | diff source-counts.txt -
```

- **Both `diff`s must print nothing.** A different migration list means the target
  was not migrated at the source's SHA: stop before loading. A different row count
  means the load is incomplete.
- **`session_replication_role = replica`** may be set only by the owner. It lets
  the load write what the dump holds: the factor library's load rules, its record's
  writers and the slot rule step aside, while the update, delete and truncate
  guards do not. Afterwards the owner reconciliation check scans for mixed record
  slots and for `unspecified` rows under an authoritative release, and compares
  each release's rows with its record. It does not repeat the other insert-time
  rules (a row's version against its release's edition, rows added to a withdrawn
  release, release ordinals) or foreign keys, which replica mode also skips. A
  consistent dump's rows passed them when they were first written.
- **Never use `--disable-triggers`**, on `pg_dump` or `pg_restore`. It wraps each
  table in `DISABLE`/`ENABLE TRIGGER ALL`. As the hosted owner that fails. As a
  superuser it leaves every `ENABLE ALWAYS` integrity trigger demoted to plain
  ENABLE, which the check reports as `trigger … is not ENABLE ALWAYS`.
- **If the load stops on an error,** `--single-transaction` has rolled all of it
  back. Recreating the database is always safe. Retry into the same database only
  after `row-counts.sql` shows that it still holds nothing but runbook 02's
  buckets. Never load without
  `--single-transaction`: the factor tables and `factor_release_events` refuse
  DELETE and TRUNCATE even to the owner, so a partly committed load could never be
  cleaned.

Then run the [owner reconciliation check](05-rotation.md#owner-reconciliation-check)
on the target from the deployed SHA. It must exit 0 with no problem line and no
"not reconciled" line. Continue with steps 2–4 above (Storage reconciliation and
sign-off), with the reconcile CLI's environment pointing at the **target** project.
A shell still holding the source's credentials would run `--forget-uploads`
against the live database.

**LP5-03 drill.** The owner sets RPO/RTO and backup retention. LP5-03 proves
restoration into an isolated environment by running this procedure end to end, and
records in B9:

- source and target project refs, the deployed SHA, dump time and recovered-data
  age;
- both silent `diff`s and the owner reconciliation check's full output on the
  target;
- immutable factor snapshots and evidence links intact (spot-check records against
  the source), with source-file bytes and checksums from steps 2–4;
- a fresh sign-in by a restored user (sessions are not restored), and a report
  downloaded and reconciled against the source;
- the elapsed time from hold to sign-off.

The procedure was rehearsed on a scratch database in the local Supabase cluster,
with the owner's privileges on `auth` and `storage` matched to the source's (the
owner holds only SELECT on Storage's vector tables). The hosted owner's
permissions for the `auth` and `storage` loads are proven only by this drill. No backup schedule, PITR guarantee or successful restore is claimed
by this foundation. Production backup/PITR selection belongs to LP2-04. Do not
destroy the original project or rehearsal evidence before owner review. The drill
target is a full copy of production data: delete it, and the dump files, once the
owner has signed off the B9 record.

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

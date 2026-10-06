# 5. Rotation, rollback and recovery

Use a private owner session restored through runbook 00. Keep the last verified
release manifest and DB/schema compatibility evidence. **Every application
change uses a new immutable manifest and the same `deploy-apps.sh` path**. Never
mix mutable candidates, ad hoc Container App updates or latest secret references.
Every selected manifest must explicitly carry `storage_cleanup_hold` and
`storage_sweep_interval_seconds`; copy the current incident hold into any older
rollback manifest. Clearing an on/unknown hold requires owner-run
`--ack-clear-storage-hold` only after the runbook 04 reports have been reviewed.

## Initial LP1-03 runtime handoff (owner-run, before G2)

Keep application traffic and `runtime_secrets_ready` off during first setup.
Runbook 02 stores only owner `direct-url` (`postgres.<project-ref>`, session 5432).
The application `database-url` must use `tonyai_runtime.<project-ref>` on
transaction port 6543, with its own random password. Never reuse the owner password.
The API and scheduled storage-verify job get only `database-url` and the backend
Storage key. `storage:reconcile` needs only the runtime role. `direct-url` reaches
only owner tooling (migrations, private psql and synthetic fixtures);
it is never a workload secret or an application environment variable.

1. Before applying the LP1-03 migration, use the owner-only helper below from a
   clean reviewed checkout. It resolves the exact `direct-url` version from Key
   Vault into psql's libpq environment, verifies the Frankfurt/project/owner/TLS
   contract, disables psql startup files/history, and never puts a password or
   URL in argv or prints it. A private interactive terminal and psql are required.
   The freshly generated owner password need not be retrieved or reset manually.
   Use the same `versions.direct_url_version` from runbook 02 for this session,
   migrations and fixtures; after owner rotation use its explicitly recorded
   replacement. Never use a dashboard reset without storing/selecting a new URL.

   ```bash
   python3 infra/scripts/cloud_ops.py owner-psql --vault "$VAULT_NAME" --project-ref "$SUPABASE_PROJECT_REF" --source-sha '<reviewed-helper-full-sha>' --direct-secret-version '<selected-direct-url-version>'
   ```

   Confirm the hosted `postgres` retains CREATEROLE and BYPASSRLS and can grant
   USAGE on `storage` and SELECT on `storage.objects`:

   ```sql
   SHOW server_version;
   SELECT current_user, rolcreaterole, rolbypassrls
   FROM pg_roles WHERE rolname = current_user;
   SELECT has_schema_privilege(current_user, 'storage', 'USAGE WITH GRANT OPTION') AS storage_usage_grant,
          has_table_privilege(current_user, 'storage.objects', 'SELECT WITH GRANT OPTION') AS storage_select_grant;
   BEGIN;
   CREATE ROLE lp1_probe BYPASSRLS;
   ROLLBACK;
   ```

   All four booleans must be true and the rolled-back role probe must succeed.
   `server_version` must be 17.x: the [owner reconciliation check](#owner-reconciliation-check)
   pins CHECK constraints by md5 of PostgreSQL 17's `pg_get_constraintdef` output.
   Record the server version and probe output. If the probe fails, roll back or
   exit the session; never drop an existing role named `lp1_probe`. Stop and
   resolve with the platform owner on failure; do not weaken the migration or grant wider runtime privileges.
2. Generate the runtime password using `openssl rand -hex 32` in the private,
   unrecorded owner terminal, and save the 64-character hex string in the password
   manager. Do not use symbols, percent-encoding or a password-manager substitute:
   use this exact hex string for both the URL and psql's hidden `\password` prompts.
   Never paste it into a recorded shell command, PR or evidence output. Build the
   complete runtime URL from this template (all query parameters are required):

   ```text
   postgresql://tonyai_runtime.<project-ref>:<64-character-hex-password>@aws-N-eu-central-1.pooler.supabase.com:6543/postgres?sslmode=require&sslaccept=strict&sslcert=/app/infra/certs/prod-ca-2021.crt&pgbouncer=true
   ```

   Use the project's actual Frankfurt pooler host. Store the URL through hidden
   input below; this validates its structure, not a login, because the role does
   not exist until migration.

   ```bash
   python3 infra/scripts/release_secrets.py store --foundation .infra-local/staging/foundation.json --project-ref "$SUPABASE_PROJECT_REF" --name database-url
   ```

   This initial-storage path validates the foundation and project without needing
   a release manifest or an existing runtime version. Put the returned version ID and runbook 02's backend version in the initial
   release manifest. This allows a complete immutable manifest before migration;
   the migration helper does not read or connect through the runtime URL.
3. Apply the reviewed migration chain using runbook 03 §3.2 and the explicit
   owner secret version. Reconnect using the `owner-psql` command above with the same selected owner version.
   Use the same saved runtime password at both hidden prompts:

   ```text
   \password tonyai_runtime
   ALTER ROLE tonyai_runtime LOGIN;
   ```

   **Never use `ALTER ROLE … PASSWORD '…'` with a cleartext password.** Supabase
   statement logs and `pg_stat_statements` can retain it. psql's `\password`
   computes the verifier on the client. Do not run the loopback-only local
   provisioning helper against staging, including through a forwarded port.
4. Keep **pg_net disabled** in Dashboard → Database → Extensions unless a feature
   explicitly needs it. The runtime check reports PUBLIC exposures, including
   any outbound HTTP queue and Storage SECURITY DEFINER helpers; retain and
   review every warning. An unexpected exposure requires operator review.
5. For an existing shared-owner installation, close traffic and disable all old
   owner-backed `database-url` vault versions before granting runtime access.
   Rotate the owner password too: old workloads may have held it. Follow both
   independent procedures below; disabling a vault version alone does not revoke
   its database password. The first deployment of this change must have a new
   `release_id`, even for unchanged images/secret versions, because it creates a
   fresh `revisionSuffix`. `deploy-apps.sh --verify-only` against the pre-change
   deployment will fail closed while its runtime `DIRECT_URL` alias remains.
   For new setup, no owner-backed runtime version exists.
6. Verify the selected runtime version (`release_secrets.py verify`), then run
   the **Runtime connection and privilege evidence** procedure below before
   opening traffic. Enable foundation `runtime_secrets_ready`, deploy via runbook
   03, update the scheduled storage-verify job via runbook 06, and repeat the same
   evidence procedure against the deployed version. Attach both identity and
   privilege output, including all PUBLIC warnings, to the LP1-03 handoff.

## Runtime connection and privilege evidence

In the private owner shell, load the exact selected runtime URL from the password
manager into exported `DATABASE_URL` through hidden input, never shell history or
tracing. Replace only `sslcert`'s container path with the absolute local repository
CA path when running outside the image. Keep that same variable for **both** commands:

```bash
node infra/scripts/runtime-identity.mjs && node packages/db/scripts/runtime-role.mjs check
```

The first command executes **`SELECT current_user, session_user`** through that URL
and refuses unless both are **`tonyai_runtime`**. It must print
`PASS: current_user=tonyai_runtime; session_user=tonyai_runtime`. A login failure or
owner session fails this step and prevents the second command. The unchanged
`runtime-role.mjs check` checks the named role's grants, not the caller identity;
**"privileges as intended" alone is not sufficient evidence**.

Require both commands to pass. Attach full stdout **and stderr**, including every
PUBLIC warning, plus source SHA, deployed release and exact secret version IDs
(never values). Clear `DATABASE_URL` afterwards. Repeat after restoration or grant
changes. LP1-03 is DONE only after the deployed identity and privilege evidence
and required security review close. Hardening the DB checker itself belongs to
the Claude Code lane; this PR does not modify `packages/db`.

Under this runtime URL `check` also prints `! the library's record was not
reconciled: tonyai_runtime cannot read factor_release_events …`. That line is
**expected** here, not a failure: the runtime role cannot read the library's
record, so the reconciliation runs only in the owner check below.

## Owner reconciliation check

Run it after **every** restore, every deploy that applies a migration and every
factor-library load. Use the private owner shell, never a shared host, on a clean
checkout of the **deployed** source SHA. Load the exact selected owner session URL
(`direct-url`: session pooler, port 5432, user `postgres.<project-ref>`) into
exported `DATABASE_URL` through hidden input, never shell history or tracing, and
replace only `sslcert`'s container path with the absolute local repository CA path,
as for the runtime URL above. Then run:

```bash
node packages/db/scripts/runtime-role.mjs check
```

The command reads the exported owner URL; never type the URL inline in front of
it. Through the owner, the check also compares every factor release's held rows with
`factor_release_events` and scans the data for what the insert-time rules would
have refused (a replica-mode restore bypasses them). Expected:

- exit 0 and the final line `tonyai_runtime on <host>: privileges as intended`;
- **no** `- …` problem line;
- **no** `the library's record was not reconciled` line (if it appears, the URL
  is not the owner's);
- on staging and production, **no** `! factor library holds a placeholder release`
  or `… fixture release` line. Neither environment ever holds one (K3), so such a
  line is a finding even though the exit code stays 0.

Record the `! tonyai_runtime can also reach …` PUBLIC warnings as in the runtime
procedure. Attach full stdout and stderr with the source SHA and clear
`DATABASE_URL` afterwards. Three limits apply (independent review F5):

1. Its CHECK pins are md5 hashes of PostgreSQL 17 output. Confirm `SHOW
   server_version` is 17.x in the same session before relying on it.
2. It reads its integrity-function bodies from the checkout's migrations. Run it
   only from the deployed SHA; any other checkout can report false drift or miss
   real drift.
3. On a database without migration `20261004120000_lp3_03_factor_model` it exits 1
   with `relation "factor_releases" does not exist` and prints no privilege result
   at all. That is not a privilege finding; the check is usable only once that
   migration is applied.

## Rotate the runtime credential

Use a write-free maintenance window: new connections using the old password may
fail as soon as it changes. Supavisor may cache authentication; revocation is not
proved until a fresh connection with the old password is explicitly refused.
The owner `direct-url` stays unchanged. Follow this order:

1. Copy the last **deployed** manifest to `release-r002.json`, assign a new
   `release_id`, and retain both image digests, cleanup hold, sweep interval and
   backend version. Keep the previous manifest unchanged as evidence.
2. Generate a new `openssl rand -hex 32` password privately as in initial step 2.
   Save the old and new runtime URLs privately until revocation is verified.
   Store the new full URL at the hidden prompt, using the already-created manifest:

   ```bash
   python3 infra/scripts/release_secrets.py store --inputs .infra-local/staging/release-r002.json --name database-url
   ```

3. Select the returned exact runtime version in `release-r002.json` and freeze
   that manifest; the currently deployed release still selects the old version.
4. Validate the selected secret references and new URL before changing PostgreSQL:

   ```bash
   python3 infra/scripts/release_secrets.py verify --inputs .infra-local/staging/release-r002.json
   ```

   This is structural/project verification, not a runtime login test. An
   interruption here leaves the old deployed release and password usable.
5. Open `owner-psql` using the selected owner version. Run
   `\password tonyai_runtime` with the exact saved new hex string, followed by
   `ALTER ROLE tonyai_runtime LOGIN;`. Once this executes, an interruption needs
   forward recovery: old revisions may fail on their next database connection.
6. Immediately run **Runtime connection and privilege evidence** above using the
   new URL. Stop on any identity, login or privilege failure; repair forward
   through the private owner session before proceeding.
7. Deploy the new manifest through `deploy-apps.sh` (runbook 03).
8. Update the scheduled storage-verify job to the same digest/secret versions
   through runbook 06.
9. Repeat the full runtime identity/privilege check with PUBLIC warnings against
   the deployed version. Verify readiness, authenticated login/exports, bucket
   probes and storage reconciliation.
10. Probe the **old password** through a fresh Supavisor transaction connection.
    Use the project's actual host and enter the old saved hex password only at
    psql's hidden `-W` prompt (the arguments below contain no secret):

    ```bash
    PGSSLMODE=verify-full PGSSLROOTCERT="$PWD/infra/certs/prod-ca-2021.crt" psql -X -W -h 'aws-N-eu-central-1.pooler.supabase.com' -p 6543 -U "tonyai_runtime.$SUPABASE_PROJECT_REF" -d postgres -c 'SELECT current_user, session_user'
    ```

    Require an explicit authentication refusal, not a network/TLS failure; prove
    the new URL still succeeds immediately afterwards. Record the old version ID
    and sanitized refusal outcome. If the old password still works, stop
    retirement and resolve Supavisor authentication caching/revocation with the
    platform owner; do not claim rotation complete.
11. Only after that refusal and all new-version checks, disable superseded runtime
    vault versions and clear both URLs from the terminal environment.

Rollback uses current credentials and runtime-qualified images. An interrupted
password change may require a second reset, new secret version and new manifest;
never assume that reselecting an old manifest restores a revoked password.

## Rotate the owner credential

In the secure Supabase provider session, rotate the hosted `postgres` password
under an owner-reviewed maintenance plan. Use the **currently deployed** manifest
(`release-r001.json` in this example); no new release is needed. Store only the new session URL:

```bash
python3 infra/scripts/release_secrets.py store --inputs .infra-local/staging/release-r001.json --name direct-url
```

Record its exact version for future migrations and smoke fixture provisioning.
Verify a fresh `owner-psql` connection using that new exact version and the prerequisite queries above, then
retire the old owner vault versions. The runtime password, `database-url`, API
revisions and scheduled job stay unchanged. No application deployment or seed is
needed for owner-only rotation. If the provider reset revokes the old password
immediately, pause owner jobs until verification; preserve enough information
for a second reset after interruption. Never rerun initial setup to rotate keys.

## Rotate the backend key and deploy selected versions

For a backend-key change, retain the old provider key through verification if the
provider supports overlap. Copy the deployed manifest into a new immutable release
ID, retaining its digests and operational settings. Use hidden entry:

```bash
python3 infra/scripts/release_secrets.py store --inputs .infra-local/staging/release-r002.json --name supabase-service-role-key
python3 infra/scripts/release_secrets.py verify --inputs .infra-local/staging/release-r002.json
bash infra/scripts/deploy-apps.sh --backend .infra-local/staging/backend.json --inputs .infra-local/staging/release-r002.json
```

Each store prints only a validated Key Vault version ID; copy it into the new
manifest before verification. Strict URL checks reject wrong roles, projects,
regions, ports, query keys, TLS settings and CA paths. Backend keys require a live
exact-project probe. New release IDs create fresh revisions even with unchanged
images. Verify login, authenticated requests/new DB connections, both bucket
probes and the browser build; update the scheduled job through runbook 06 before
revoking old provider keys or disabling vault versions. Key-only rotation applies
no migrations. A legacy JWT/anon-key rotation changes compiled browser inputs:
rebuild the same qualified web source for the target/public key, select its digest,
and retain the deployed API digest unless explicitly promoting an API release.
Record references and results only.

## Roll back images

First prove the previous binaries can consume the current schema/data **and pass
the actual-image smoke under `tonyai_runtime` grants**. Pre-#147 images were not
qualified with that role and cannot be assumed compatible. Image
rollback does not undo migrations. Clone the last compatible release into a new
manifest, assign a new revision suffix, use its qualified API/web digests and
current enabled credential versions. If the web's embedded public key was revoked,
rebuild that compatible source for the current project/public key first. Record
the resulting digest and provenance. Run exact-version verification and
`deploy-apps.sh` with this manifest; repeat runbook 04. The newer candidate JSON
never participates automatically. Retain the failed release and recovery evidence.

## Recover backend state or a vault

For state recovery, stop all writers, inspect blob versions/lease metadata and
follow [the backend recovery procedure](../terraform/README.md). Reapply bootstrap
with identical identifiers after a recoverable partial operation; retain firewall,
Entra-only access, retention and deletion lock. To change deployer principals,
review/remove the old scoped assignments first; bootstrap does not remove old
principal grants automatically. Do not leave a stale principal with state access.

Key Vault purge protection prevents name-reuse shortcuts. Use the recorded vault
name, group and region; as owner inspect deletion metadata then recover it:

```bash
az keyvault list-deleted --query '[].{name:name,location:properties.location,id:id}' -o table
az keyvault recover --name '<recorded-vault>' --resource-group '<original-staging-group>' --location germanywestcentral --output none
```

All old versions return too. Keep workload credentials revoked/traffic closed
until reconciliation; review secret **metadata** in the portal, disable stale
versions, restore RBAC and recreate fresh project-matched values with the helpers.
If Terraform state was lost, do not blindly import a recovered vault/app: first
review ownership, provider GET surfaces and absence of inline secrets. After
state reconciliation reapply foundation, then application through a reviewed
release. Never purge the vault, disable purge protection or grant broad runtime
secret access to make recovery easier.

Supabase DB backups do not contain Storage bytes. Protect evidence/import-source
objects, checksum inventory, bucket/Auth policies and release configuration.
RPO/RTO and retention are owner decisions; LP5-03 proves an isolated restore and
report reconciliation through the [database restore procedure and drill](04-verify.md#database-restore-procedure-and-lp5-03-drill)
in runbook 04. A state/vault restore alone is not disaster-recovery proof.

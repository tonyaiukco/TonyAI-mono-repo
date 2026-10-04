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
only the owner migration process and explicitly selected synthetic-fixture child;
it is never a workload secret or an application environment variable.

1. Before applying LP1-03, connect as the hosted owner using the selected
   `direct-url` connection details in a private psql session. Pass host, port,
   database and user as nonsecret arguments; use `-W` for the owner password
   prompt, never a password-bearing connection URI in argv. Use libpq
   `PGSSLMODE=verify-full` and `PGSSLROOTCERT` pointing at the repository CA
   (`infra/certs/prod-ca-2021.crt`). Prisma's `sslaccept`/`sslcert` query keys are
   not libpq options. Do not capture terminal input or enable shell tracing.
   Confirm the hosted `postgres` retains CREATEROLE and BYPASSRLS and can grant
   USAGE on `storage` and SELECT on `storage.objects`:

   ```sql
   SELECT current_user, rolcreaterole, rolbypassrls
   FROM pg_roles WHERE rolname = current_user;
   SELECT has_schema_privilege(current_user, 'storage', 'USAGE WITH GRANT OPTION') AS storage_usage_grant,
          has_table_privilege(current_user, 'storage.objects', 'SELECT WITH GRANT OPTION') AS storage_select_grant;
   ```

   All four booleans must be true. Stop and resolve with the platform owner if
   any are false; do not weaken the migration or grant wider runtime privileges.
2. Generate a unique random runtime password in the owner's password manager.
   Prepare the runtime transaction URL with username `tonyai_runtime.<project-ref>`
   and the strict TLS parameters from the root `.env.example`. Store it using
   the initial-storage command below (hidden input). This
   validates URL structure, not a login: the role does not exist until migration.

   ```bash
   python3 infra/scripts/release_secrets.py store --foundation .infra-local/staging/foundation.json --project-ref "$SUPABASE_PROJECT_REF" --name database-url
   ```

   This initial-storage path validates the foundation and project without needing
   a release manifest or an existing runtime version. Put the returned version ID and runbook 02's backend version in the initial
   release manifest. This allows a complete immutable manifest before migration;
   the migration helper does not read or connect through the runtime URL.
3. Apply the reviewed migration chain using runbook 03 §3.2 and the explicit
   owner secret version. Reconnect the private owner psql session over `direct-url`.
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
   its database password. For new setup, no owner-backed runtime version exists.
6. Verify the selected runtime version (`release_secrets.py verify`), then enable
   foundation `runtime_secrets_ready`, deploy via runbook 03, and update the
   scheduled storage-verify job via runbook 06. In the private owner shell, load
   that exact runtime URL into `DATABASE_URL` without echoing it, using the local
   absolute CA path for `sslcert` when running outside the container. Run:

   ```bash
   node packages/db/scripts/runtime-role.mjs check
   ```

   This is `DATABASE_URL=<staging runtime url> node packages/db/scripts/runtime-role.mjs check`
   with the value supplied privately, not typed into shell history. It must print
   **"privileges as intended"**. Attach the full stdout **and stderr**, including
   all PUBLIC warnings, with the source SHA, deployed release and secret version
   IDs (never values). Repeat after restoration or grant changes. LP1-03 is DONE
   only after this staging evidence and the required security review close.

## Rotate the runtime credential

Use a maintenance window: a password reset invalidates the old login for new
connections, so old revisions cannot recover by restarting. Generate a fresh
random runtime password in the owner's password manager. Through owner psql over
`direct-url`, use `\password tonyai_runtime` and then `ALTER ROLE tonyai_runtime LOGIN;`.
Enter the new runtime transaction URL only at the hidden prompt:

```bash
python3 infra/scripts/release_secrets.py store --inputs .infra-local/staging/release-r002.json --name database-url
```

Copy the last deployed manifest to a new immutable release ID, retaining both
image digests, cleanup hold, sweep interval and backend version; select the new
runtime version. The owner `direct-url` stays unchanged. Verify and deploy via
the common commands below, update the scheduled verification job to the same
runtime version, rerun the privilege check including warnings, readiness,
authenticated login/exports and storage reconciliation. Only after verification
disable superseded runtime vault versions. Rollback uses current credentials;
an interrupted rotation may require a second password reset and new version.

## Rotate the owner credential

In the secure Supabase provider session, rotate the hosted `postgres` password
under an owner-reviewed maintenance plan. Store only the new session URL:

```bash
python3 infra/scripts/release_secrets.py store --inputs .infra-local/staging/release-r002.json --name direct-url
```

Record its exact version for future migrations and smoke fixture provisioning.
Verify a fresh owner psql connection and the prerequisite queries above, then
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

First prove the previous binaries can consume the current schema/data. Image
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
report reconciliation. A state/vault restore alone is not disaster-recovery proof.

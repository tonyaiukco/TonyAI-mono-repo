# 5. Rotation, rollback and recovery

Use a private owner session restored through runbook 00. Keep the last verified
release manifest and DB/schema compatibility evidence. **Every application
change uses a new immutable manifest and the same `deploy-apps.sh` path**. Never
mix mutable candidates, ad hoc Container App updates or latest secret references.

## Rotate backend key or DB URLs

Create/rotate the credential in the secure Supabase provider session under an
owner-reviewed maintenance plan. For a new backend key, keep the old provider key
enabled through verification if the provider supports overlap. Copy the last
**deployed** manifest to `release-r002.json`, set a new `release_id` (`r002`), and
retain both current image digests. New values are entered only at hidden prompts:

```bash
python3 infra/scripts/release_secrets.py store --inputs .infra-local/staging/release-r002.json --name supabase-service-role-key
# For a database password change, update BOTH pooler URLs:
python3 infra/scripts/release_secrets.py store --inputs .infra-local/staging/release-r002.json --name database-url
python3 infra/scripts/release_secrets.py store --inputs .infra-local/staging/release-r002.json --name direct-url
```

Each prints only a validated Key Vault version ID. The strict URL checks reject
foreign projects/regions, wrong ports, unknown query keys, insecure TLS and wrong
CA paths. Opaque backend keys also require a successful live exact-project probe
before storage. Copy the new runtime/backend version IDs into the new manifest.
Record the direct URL version alongside this release for future migrations; the
migration helper requires that explicit version and never reads latest. A
legacy JWT/anon-key rotation also changes compiled browser configuration:
rebuild the web for the same target and qualified source commit, select that web
digest, and **retain the deployed API digest** unless explicitly promoting an API
release. Do not copy the build's API candidate over an intentional API rollback.

```bash
python3 infra/scripts/release_secrets.py verify --inputs .infra-local/staging/release-r002.json
bash infra/scripts/deploy-apps.sh --backend .infra-local/staging/backend.json --inputs .infra-local/staging/release-r002.json
```

Key-only rotation does not apply migrations. Verify new database connections through
the authenticated runtime flow; any migration change requires a separately reviewed
source-bound release under runbook 03. The new release ID creates fresh revisions, even when only secret versions
change. Verify authenticated requests/new DB connections, both bucket probes,
login and the browser build before revoking the old provider key or disabling old
vault versions. Update the owner-managed scheduled verification job to the selected digest and new
secret versions through runbook 06 before retiring the old versions. Record
references and results only. If a DB password reset revokes
the old credential immediately, use a maintenance window: old revisions cannot
recover by restarting. Restore service with consistent new transaction/session
URLs and the new manifest; a second reset may be required after an interrupted
rotation. Initial Supabase setup is not the rotation path and must not overwrite
the new URLs with the original bootstrap password.

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

# Secret rotation and vault recovery (owner-run)

For rotation, first [restore the session](00-session.md). Vault recovery can run
before foundation succeeds; its independent bootstrap inputs are listed below. Never copy secret values into this
runbook, shell arguments, env files, tickets or logs. Use the private provider and
Key Vault portals for new values. Record only secret version IDs, timestamps,
revision names/digests and pass/fail evidence. A revision restart alone does not prove a versionless Key Vault cache refreshed.
The app template pins exact versions: deploy the new reference, verify its ID,
then restart and verify every consumer before revoking the old provider key.

## Independent backend key rotation (preferred `sb_secret_` key)

1. Supabase → API Keys: create a new **secret backend key**, leaving the old key
   active for the overlap. The installed supabase-js accepts this key format;
   cloud bucket access must still be verified. Do not change the public browser
   key or signing key for this independent rotation.
2. Key Vault → `supabase-service-role-key`: create a new enabled version with the
   new value. Confirm its secret version ID without showing the value.
3. Run `bash infra/scripts/deploy-apps.sh` to select the new enabled backend
   version and apply its exact reference. Compare `keyVaultUrl` with the new
   vault version ID; only then restart every active API revision below; do not assume the
   platform refresh delay has elapsed. Web has no backend key.
4. Run `probe-storage` for both buckets and the API health + controlled
   authenticated upload/download flow on staging. Check the running API, not only
   the owner helper: the latter resolves the new vault value independently.
5. After every API consumer passes, revoke the **old key in Supabase**. Repeat the
   running API flow. Disable the old Key Vault version in the portal. A vault
   version being disabled does not revoke the underlying provider credential.
   If verification fails before revocation, keep old provider key active, create
   a new latest vault version of the known-good value, rerun `deploy-apps.sh`,
   verify the exact new reference ID, then restart/retest.

```bash
az containerapp revision list -g "$RESOURCE_GROUP" -n "$PREFIX-staging-api" --query '[?properties.active].name' -o tsv
# Set only a nonsecret name returned above; repeat for each active revision.
export API_REVISION='<active-api-revision>'
az containerapp revision restart -g "$RESOURCE_GROUP" -n "$PREFIX-staging-api" --revision "$API_REVISION" --output none
python3 infra/scripts/cloud_ops.py probe-storage --vault "$VAULT_NAME" --project-ref "$SUPABASE_PROJECT_REF"
curl --fail --silent --show-error "$API_ORIGIN/api/v1/health"
```

Expected evidence: new vault version and matching versioned ACA reference, restarted revision, both bucket probes and
running API flow pass before and after provider revocation. Do not claim a health
200 proves key refresh or storage authorization. No rotation is complete until
all old provider consumers/keys are accounted for.

## Legacy service-role/JWT secret rotation

Legacy `service_role` and `anon` keys share the project's legacy JWT secret.
Rotating it changes **both**. Pinning API user JWT verification to JWKS does not
make the old API keys independent. Prefer migrating backend to `sb_secret_` and
web to a project-verified publishable key first; qualify both live before retiring
legacy API keys. See [Supabase key guidance](https://supabase.com/docs/guides/getting-started/api-keys).

If the legacy scheme must be rotated, schedule a maintenance window and review
all consumers before the provider change. Do not assume an overlap/grace period:
confirm actual provider behavior in the dashboard. Rotate at Supabase, create a
new enabled Key Vault backend-key version, then **rebuild the web with the new
anon key** using runbook 03. Its old compiled bundle cannot be repaired by a
runtime variable. Deploy the new web digest and exact new backend-secret version with
`deploy-apps.sh`, restart API revisions, and verify
login, authenticated storage and browser asset scanning. Confirm old legacy keys
are revoked at the provider and disable their old vault versions only after the
new consumers pass. Browser clients may need a full reload/new session. If
rotation immediately invalidates old keys, the maintenance window spans the
provider change through successful redeployment; an old-image rollback will not
restore invalidated credentials. Never switch JWT_SCHEME away from `jwks`.

## Database password rotation

A password change immediately invalidates new connections using the old password;
this is not a two-key overlap. Schedule a maintenance window and stop API traffic
before the change. Independently list/select each active API revision and deactivate it (commands
below), and keep the web in the agreed maintenance state.

```bash
az containerapp revision list -g "$RESOURCE_GROUP" -n "$PREFIX-staging-api" --query '[?properties.active].name' -o tsv
export API_REVISION='<active-api-revision-from-this-list>'
az containerapp revision deactivate -g "$RESOURCE_GROUP" -n "$PREFIX-staging-api" --revision "$API_REVISION" --output none
```

In Supabase rotate the database password. In the vault create new enabled versions
of **both** `database-url` (6543) and `direct-url` (5432), with the same new password,
project/Frankfurt host and strict TLS/CA options. Neither URL may retain the old
password. Run the owner migration/status command against the new session URL,
then apply its exact reference with the API still inactive. **Do not use the full
app deploy helper while traffic is paused**: it can reactivate a revision. Set only
the existing app secret reference, then restart/reactivate each recorded revision:

```bash
bash <<'BASH'
set -euo pipefail
python3 infra/scripts/cloud_ops.py migrate --vault "$VAULT_NAME" --project-ref "$SUPABASE_PROJECT_REF"
# These are secret-reference IDs, not values; keep the app inactive until both URLs pass.
DATABASE_SECRET_ID="$(az keyvault secret show --vault-name "$VAULT_NAME" --name database-url --query id -o tsv)"
[[ "$DATABASE_SECRET_ID" =~ /secrets/database-url/[a-f0-9]{32}$ ]]
API_IDENTITY_ID="$(az deployment group show -g "$RESOURCE_GROUP" -n lp2-foundation --query properties.outputs.apiIdentityId.value -o tsv)"
test "$API_IDENTITY_ID" = "$GROUP_ID/providers/Microsoft.ManagedIdentity/userAssignedIdentities/$PREFIX-staging-api"
az containerapp secret set -g "$RESOURCE_GROUP" -n "$PREFIX-staging-api" --secrets "database-url=keyvaultref:$DATABASE_SECRET_ID,identityref:$API_IDENTITY_ID" --output none
az containerapp secret list -g "$RESOURCE_GROUP" -n "$PREFIX-staging-api" --query '[].{name:name,keyVaultUrl:keyVaultUrl}'
CURRENT_DATABASE_ID="$(az containerapp secret list -g "$RESOURCE_GROUP" -n "$PREFIX-staging-api" --query "[?name=='database-url'].keyVaultUrl | [0]" -o tsv)"
test "$CURRENT_DATABASE_ID" = "$DATABASE_SECRET_ID"
az group update -n "$RESOURCE_GROUP" --set "tags.databaseSecretVersion=${DATABASE_SECRET_ID##*/}" --output none
az containerapp revision restart -g "$RESOURCE_GROUP" -n "$PREFIX-staging-api" --revision "$API_REVISION" --output none
az containerapp revision activate -g "$RESOURCE_GROUP" -n "$PREFIX-staging-api" --revision "$API_REVISION" --output none
BASH
```

Expected evidence: strict TLS migration/status passes, new API connections work,
login and an authenticated DB-backed request succeed. The old password was
revoked by the provider change; now disable old vault URL versions. If interrupted,
restore the session and finish both URL updates before resuming traffic. Recovery
requires another provider password reset and matching vault versions; restarting
an old revision alone cannot repair a revoked password.

## Recover a soft-deleted vault

Do not purge a vault to work around name reuse. Use its recorded name and original
group/location, inspect the deletion entry, then recover it as the owner:

```bash
# Works without lp2-foundation outputs or restore-session. Supply recorded identifiers.
export AZURE_SUBSCRIPTION_ID='<subscription-uuid>'
export RESOURCE_GROUP='<original-staging-resource-group>'
az login --tenant '<tenant-uuid>' --output none
az account set --subscription "$AZURE_SUBSCRIPTION_ID"
export RECOVER_VAULT_NAME='<recorded-staging-vault-name>'
az keyvault list-deleted --query "[?name=='$RECOVER_VAULT_NAME'].{name:name,location:properties.location,id:id}" -o table
az keyvault recover --name "$RECOVER_VAULT_NAME" --resource-group "$RESOURCE_GROUP" --location germanywestcentral --output none
```

Expected: recovery completes for the intended staging vault. **All old secrets
and versions return too.** RBAC assignments/diagnostic settings may need recreation.
Reapply foundation, regrant owner access, and keep apps stopped and API secret
permissions absent while reconciling. Inspect secret/version **metadata** only:

```bash
az keyvault secret list --vault-name "$RECOVER_VAULT_NAME" --query '[].{name:name,enabled:attributes.enabled}' -o table
az keyvault secret list-versions --vault-name "$RECOVER_VAULT_NAME" --name database-url --query '[].{id:id,enabled:attributes.enabled}' -o table
# Repeat for direct-url and supabase-service-role-key. For each old version:
az keyvault secret set-attributes --id '<old-secret-version-id>' --enabled false --output none
```

Disable every stale version; verify no unexpected secret names. Create fresh,
project-matched versions using runbook 02, then reapply secret-access and deploy
apps. Never resume against recovered values merely because a reference resolves.
If the old project/keys still exist, rotate/revoke them at Supabase as part of
recovery. Retain provider/version mapping privately for the owner's audit.

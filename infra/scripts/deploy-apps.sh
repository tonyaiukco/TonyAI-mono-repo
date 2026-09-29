#!/usr/bin/env bash
# Owner selects the latest versions explicitly; deployments never rely on KV cache refresh.
set -euo pipefail
set +x
: "${RELEASE_SHA:?}" "${RESOURCE_GROUP:?}" "${PREFIX:?}" "${SUPABASE_PROJECT_REF:?}"
: "${VAULT_NAME:?}" "${API_DIGEST:?}" "${WEB_DIGEST:?}"
test "$(git rev-parse HEAD)" = "$RELEASE_SHA"
test -z "$(git status --porcelain)"
[[ "$API_DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]]
[[ "$WEB_DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]]
# Only IDs are returned; never print or persist secret values.
database_id=$(az keyvault secret show --vault-name "$VAULT_NAME" --name database-url --query id -o tsv)
backend_id=$(az keyvault secret show --vault-name "$VAULT_NAME" --name supabase-service-role-key --query id -o tsv)
[[ "$database_id" =~ /secrets/database-url/[a-f0-9]{32}$ ]]
[[ "$backend_id" =~ /secrets/supabase-service-role-key/[a-f0-9]{32}$ ]]
database_version=${database_id##*/}
backend_version=${backend_id##*/}
parameters=(prefix="$PREFIX" supabaseProjectRef="$SUPABASE_PROJECT_REF" apiDigest="$API_DIGEST" webDigest="$WEB_DIGEST" databaseSecretVersion="$database_version" backendSecretVersion="$backend_version")
az deployment group validate -g "$RESOURCE_GROUP" --template-file infra/azure/apps.bicep --parameters "${parameters[@]}" --query properties.provisioningState -o tsv
az deployment group what-if -g "$RESOURCE_GROUP" --template-file infra/azure/apps.bicep --parameters "${parameters[@]}"
az deployment group create -g "$RESOURCE_GROUP" -n lp2-apps --template-file infra/azure/apps.bicep --parameters "${parameters[@]}" --query properties.provisioningState -o tsv
current_database_id=$(az containerapp secret list -g "$RESOURCE_GROUP" -n "$PREFIX-staging-api" --query "[?name=='database-url'].keyVaultUrl | [0]" -o tsv)
current_backend_id=$(az containerapp secret list -g "$RESOURCE_GROUP" -n "$PREFIX-staging-api" --query "[?name=='supabase-service-role-key'].keyVaultUrl | [0]" -o tsv)
test "$current_database_id" = "$database_id"
test "$current_backend_id" = "$backend_id"
az group update -n "$RESOURCE_GROUP" --set "tags.databaseSecretVersion=$database_version" "tags.backendSecretVersion=$backend_version" --output none
az containerapp secret list -g "$RESOURCE_GROUP" -n "$PREFIX-staging-api" --query '[].{name:name,keyVaultUrl:keyVaultUrl}'
printf '%s\n' 'PASS: app configuration pins selected secret version IDs. Restart existing API revisions after a rotation and verify before revoking old credentials.'

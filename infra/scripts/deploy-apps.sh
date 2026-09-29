#!/usr/bin/env bash
# Owner selects the latest versions explicitly; deployments never rely on KV cache refresh.
set -euo pipefail
set +x
: "${RELEASE_SHA:?}" "${RESOURCE_GROUP:?}" "${PREFIX:?}" "${SUPABASE_PROJECT_REF:?}"
: "${ACR_HOST:?}" "${VAULT_NAME:?}" "${API_DIGEST:?}" "${WEB_DIGEST:?}"
test "$(git rev-parse HEAD)" = "$RELEASE_SHA"
test -z "$(git status --porcelain)"
[[ "$API_DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]]
[[ "$WEB_DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]]
# Owner-only validation reads the runtime URL into memory and returns its exact version ID.
# LP2-02 must consume reviewed version metadata; never grant its workflow secret read access.
database_id=$(python3 infra/scripts/cloud_ops.py runtime-secret-id --vault "$VAULT_NAME" --project-ref "$SUPABASE_PROJECT_REF")
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
current_api_image=$(az containerapp show -g "$RESOURCE_GROUP" -n "$PREFIX-staging-api" --query 'properties.template.containers[0].image' -o tsv)
current_web_image=$(az containerapp show -g "$RESOURCE_GROUP" -n "$PREFIX-staging-web" --query 'properties.template.containers[0].image' -o tsv)
test "$current_api_image" = "$ACR_HOST/tonyai/api@$API_DIGEST"
test "$current_web_image" = "$ACR_HOST/tonyai/web@$WEB_DIGEST"
az group update -n "$RESOURCE_GROUP" --set "tags.apiDigest=$API_DIGEST" "tags.webDigest=$WEB_DIGEST" "tags.databaseSecretVersion=$database_version" "tags.backendSecretVersion=$backend_version" --output none
az containerapp secret list -g "$RESOURCE_GROUP" -n "$PREFIX-staging-api" --query '[].{name:name,keyVaultUrl:keyVaultUrl}'
printf '%s\n' 'PASS: app configuration pins selected secret version IDs. Restart existing API revisions after a rotation and verify before revoking old credentials.'

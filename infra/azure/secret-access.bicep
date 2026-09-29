targetScope = 'resourceGroup'
param prefix string = 'tonyai'
var suffix = uniqueString(resourceGroup().id)
var secretsUser = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = { name: 'kv-stg-${suffix}' }
resource apiIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = { name: '${prefix}-staging-api' }
// Run AFTER the owner has stored the secrets. No access to direct-url.
resource secrets 'Microsoft.KeyVault/vaults/secrets@2023-07-01' existing = [for name in ['database-url', 'supabase-service-role-key']: {
  parent: vault
  name: name
}]
resource readers 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for (name, i) in ['database-url', 'supabase-service-role-key']: {
  name: guid(secrets[i].id, apiIdentity.id, secretsUser)
  scope: secrets[i]
  properties: { roleDefinitionId: secretsUser, principalId: apiIdentity.properties.principalId, principalType: 'ServicePrincipal' }
}]

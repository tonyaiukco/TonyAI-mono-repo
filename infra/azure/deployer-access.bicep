targetScope = 'resourceGroup'
param prefix string = 'tonyai'
@description('Entra service principal OBJECT id, not the application/client id.')
param principalId string
var suffix = uniqueString(resourceGroup().id)
// Container Apps Contributor lacks ARM deployment operations, needed for apps.bicep.
resource deploymentRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(resourceGroup().id, 'tonyai-staging-template-deployer')
  properties: {
    roleName: '${prefix}-staging-template-deployer-${suffix}'
    description: 'Apply, validate and inspect ARM templates only in the staging resource group.'
    type: 'CustomRole'
    assignableScopes: [resourceGroup().id]
    permissions: [{ actions: ['Microsoft.Resources/deployments/*'], notActions: [], dataActions: [], notDataActions: [] }]
  }
}
resource deployments 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, principalId, deploymentRole.id)
  properties: { roleDefinitionId: deploymentRole.id, principalId: principalId, principalType: 'ServicePrincipal' }
}
resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = { name: '${prefix}stg${suffix}' }
resource identities 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = [for kind in ['api', 'web']: { name: '${prefix}-staging-${kind}' }]
// RG Reader plus Container Apps Contributor; no RBAC-write or Key Vault data access.
resource appRoles 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for role in ['acdd72a7-3385-48ef-bd42-f606fba81ae7', '358470bc-b998-42bd-ab17-a7e34c199c0f']: {
  name: guid(resourceGroup().id, principalId, role)
  properties: { roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', role), principalId: principalId, principalType: 'ServicePrincipal' }
}]
var pushRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '8311e382-0749-4cb8-b61a-304f252e45ec')
resource push 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, principalId, pushRole)
  scope: registry
  properties: { roleDefinitionId: pushRole, principalId: principalId, principalType: 'ServicePrincipal' }
}
var identityOperator = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'f1a07417-d97a-45cb-824c-7a7467783830')
resource operators 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for (kind, i) in ['api', 'web']: {
  name: guid(identities[i].id, principalId, identityOperator)
  scope: identities[i]
  properties: { roleDefinitionId: identityOperator, principalId: principalId, principalType: 'ServicePrincipal' }
}]

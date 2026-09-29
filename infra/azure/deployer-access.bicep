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
    description: 'Apply staging ARM templates and join the existing Container Apps environment.'
    type: 'CustomRole'
    assignableScopes: [resourceGroup().id]
    permissions: [{ actions: ['Microsoft.Resources/deployments/*', 'Microsoft.App/managedEnvironments/join/action'], notActions: [], dataActions: [], notDataActions: [] }]
  }
}
resource deployments 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, principalId, deploymentRole.id)
  properties: { roleDefinitionId: deploymentRole.id, principalId: principalId, principalType: 'ServicePrincipal' }
}
resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = { name: '${prefix}stg${suffix}' }
resource identities 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = [for kind in ['api', 'web']: { name: '${prefix}-staging-${kind}' }]
// Bootstrap the two apps as the owner BEFORE granting this deployer access.
resource apps 'Microsoft.App/containerApps@2025-01-01' existing = [for kind in ['api', 'web']: { name: '${prefix}-staging-${kind}' }]
var readerRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'acdd72a7-3385-48ef-bd42-f606fba81ae7')
resource reader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, principalId, 'acdd72a7-3385-48ef-bd42-f606fba81ae7')
  properties: { roleDefinitionId: readerRole, principalId: principalId, principalType: 'ServicePrincipal' }
}
var appContributor = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '358470bc-b998-42bd-ab17-a7e34c199c0f')
// Replacing API code is still access to both runtime secrets. Environment protection
// is the trust boundary; app scopes prevent creating arbitrary additional apps/jobs.
resource appRoles 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for (kind, i) in ['api', 'web']: {
  name: guid(apps[i].id, principalId, appContributor)
  scope: apps[i]
  properties: { roleDefinitionId: appContributor, principalId: principalId, principalType: 'ServicePrincipal' }
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

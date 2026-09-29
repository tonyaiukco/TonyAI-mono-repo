targetScope = 'resourceGroup'

@description('Stable, lowercase alphanumeric project prefix; use a dedicated staging resource group.')
@minLength(3)
@maxLength(12)
param prefix string = 'tonyai'

@allowed(['germanywestcentral'])
param location string = 'germanywestcentral'

var stem = '${prefix}-staging'
var suffix = uniqueString(resourceGroup().id)
var tags = { application: 'TonyAI', environment: 'staging', task: 'LP2-01' }
var acrPull = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: '${prefix}stg${suffix}'
  location: location
  tags: tags
  sku: { name: 'Basic' }
  properties: {
    adminUserEnabled: false
    publicNetworkAccess: 'Enabled'
  }
}

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${stem}-logs'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
    features: { enableLogAccessUsingOnlyResourcePermissions: true }
  }
}

resource environment 'Microsoft.App/managedEnvironments@2025-01-01' = {
  name: '${stem}-env'
  location: location
  tags: tags
  properties: {
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
  }
}

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: 'kv-stg-${suffix}'
  location: location
  tags: tags
  properties: {
    tenantId: tenant().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: true
    publicNetworkAccess: 'Enabled'
    // Consumption egress is not fixed. RBAC gates access; no ineffective IP allowlist.
    networkAcls: { bypass: 'AzureServices', defaultAction: 'Allow' }
  }
}

resource apiIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${stem}-api'
  location: location
  tags: tags
}

resource webIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${stem}-web'
  location: location
  tags: tags
}

resource apiPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, apiIdentity.id, acrPull)
  scope: registry
  properties: { roleDefinitionId: acrPull, principalId: apiIdentity.properties.principalId, principalType: 'ServicePrincipal' }
}

resource webPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, webIdentity.id, acrPull)
  scope: registry
  properties: { roleDefinitionId: acrPull, principalId: webIdentity.properties.principalId, principalType: 'ServicePrincipal' }
}

output registryName string = registry.name
output registryId string = registry.id
output registryHost string = registry.properties.loginServer
output vaultName string = vault.name
output vaultId string = vault.id
output environmentName string = environment.name
output apiIdentityId string = apiIdentity.id
output webIdentityId string = webIdentity.id
output webOrigin string = 'https://${stem}-web.${environment.properties.defaultDomain}'
output apiOrigin string = 'https://${stem}-api.${environment.properties.defaultDomain}'
output logsName string = logs.name

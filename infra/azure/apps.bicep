targetScope = 'resourceGroup'

@minLength(3)
@maxLength(12)
param prefix string = 'tonyai'
@allowed(['germanywestcentral'])
param location string = 'germanywestcentral'

@description('Project ref from the isolated Supabase Frankfurt project, never a URL or credential.')
@minLength(20)
@maxLength(20)
param supabaseProjectRef string
@description('sha256:<64 hex digits>; from the staging ACR, not a mutable tag.')
@minLength(71)
@maxLength(71)
param apiDigest string
@minLength(71)
@maxLength(71)
param webDigest string
@description('Exact enabled Key Vault version IDs, supplied by the owner/deployment metadata, never secret values.')
@minLength(32)
@maxLength(32)
param databaseSecretVersion string
@minLength(32)
@maxLength(32)
param backendSecretVersion string

var stem = '${prefix}-staging'
var suffix = uniqueString(resourceGroup().id)
var supabaseUrl = 'https://${supabaseProjectRef}.supabase.co'

resource environment 'Microsoft.App/managedEnvironments@2025-01-01' existing = { name: '${stem}-env' }
resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = { name: '${prefix}stg${suffix}' }
resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = { name: 'kv-stg-${suffix}' }
resource apiIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = { name: '${stem}-api' }
resource webIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = { name: '${stem}-web' }

module api './container-app.bicep' = {
  name: 'staging-api'
  params: {
    name: '${stem}-api'
    location: location
    environmentId: environment.id
    identityId: apiIdentity.id
    registryHost: registry.properties.loginServer
    image: '${registry.properties.loginServer}/tonyai/api@${apiDigest}'
    port: 3001
    probePath: '/api/v1/health'
    isApi: true
    secrets: [for secretName in ['database-url', 'supabase-service-role-key']: {
      name: secretName
      keyVaultUrl: '${vault.properties.vaultUri}secrets/${secretName}/${secretName == 'database-url' ? databaseSecretVersion : backendSecretVersion}'
      identity: apiIdentity.id
    }]
    env: [
      { name: 'NODE_ENV', value: 'production' }
      { name: 'PORT', value: '3001' }
      { name: 'LOG_FORMAT', value: 'json' }
      { name: 'SUPABASE_URL', value: supabaseUrl }
      { name: 'SUPABASE_JWT_SCHEME', value: 'jwks' }
      { name: 'WEB_ORIGIN', value: 'https://${stem}-web.${environment.properties.defaultDomain}' }
      { name: 'DATABASE_URL', secretRef: 'database-url' }
      // Prisma requires the variable; runtime never gets the migration credential.
      { name: 'DIRECT_URL', secretRef: 'database-url' }
      { name: 'SUPABASE_SERVICE_ROLE_KEY', secretRef: 'supabase-service-role-key' }
    ]
  }
}

module web './container-app.bicep' = {
  name: 'staging-web'
  params: {
    name: '${stem}-web'
    location: location
    environmentId: environment.id
    identityId: webIdentity.id
    registryHost: registry.properties.loginServer
    image: '${registry.properties.loginServer}/tonyai/web@${webDigest}'
    port: 3000
    probePath: '/login'
    isApi: false
    env: [
      { name: 'NODE_ENV', value: 'production' }
      { name: 'PORT', value: '3000' }
      { name: 'HOSTNAME', value: '0.0.0.0' }
      { name: 'SUPABASE_URL_INTERNAL', value: supabaseUrl }
    ]
  }
}

output apiOrigin string = 'https://${api.outputs.fqdn}'
output webOrigin string = 'https://${web.outputs.fqdn}'

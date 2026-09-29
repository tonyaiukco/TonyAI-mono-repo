param name string
param location string
param environmentId string
param identityId string
param registryHost string
param image string
param port int
param probePath string
param isApi bool
param env array
param secrets array = []

resource app 'Microsoft.App/containerApps@2025-01-01' = {
  name: name
  location: location
  tags: { application: 'TonyAI', environment: 'staging', task: 'LP2-01' }
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${identityId}': {} } }
  properties: {
    environmentId: environmentId
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: { external: true, allowInsecure: false, targetPort: port, transport: 'auto' }
      registries: [{ server: registryHost, identity: identityId }]
      secrets: secrets
    }
    template: {
      containers: [{
        name: isApi ? 'api' : 'web'
        image: image
        env: env
        resources: { cpu: json(isApi ? '1.0' : '0.5'), memory: isApi ? '2Gi' : '1Gi' }
        // The current API route proves process health only. LP2-03 adds DB readiness.
        probes: [for kind in ['Startup', 'Liveness', 'Readiness']: {
          type: kind
          httpGet: { path: probePath, port: port, scheme: 'HTTP' }
          periodSeconds: kind == 'Startup' ? 5 : 10
          timeoutSeconds: 5
          failureThreshold: kind == 'Startup' ? 60 : 3
        }]
      }]
      scale: {
        minReplicas: 0
        maxReplicas: 2
        rules: [{ name: 'http', http: { metadata: { concurrentRequests: '10' } } }]
      }
    }
  }
}

output fqdn string = app.properties.configuration.ingress.fqdn

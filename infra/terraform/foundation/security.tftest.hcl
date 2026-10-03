mock_provider "azapi" {
  mock_resource "azapi_resource" {
    defaults = {
      output = { properties = { principalId = "00000000-0000-0000-0000-000000000004", defaultDomain = "example.germanywestcentral.azurecontainerapps.io", loginServer = "tonyaistaging.azurecr.io" } }
    }
  }
}
variables {
  config = {
    subscription_id       = "00000000-0000-0000-0000-000000000001"
    tenant_id             = "00000000-0000-0000-0000-000000000002"
    environment           = "staging"
    resource_group        = "tonyai-staging"
    prefix                = "tonyai"
    registry_name         = "tonyaistaging"
    vault_name            = "tonyai-staging-kv"
    repository            = "owner/repo"
    release_sha           = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    owner_object_id       = "00000000-0000-0000-0000-000000000003"
    deployer_object_id    = "00000000-0000-0000-0000-000000000005"
    runtime_secrets_ready = true
    apps_ready            = true
  }
}
run "foundation_security_contract" {
  command = plan
  assert {
    condition     = azapi_resource.registry.body.properties.adminUserEnabled == false && azapi_resource.registry.body.sku.name == "Basic"
    error_message = "ACR must use Basic with no admin keys."
  }
  assert {
    condition     = azapi_resource.environment.body.properties.appLogsConfiguration.destination == "azure-monitor" && !can(azapi_resource.environment.body.properties.appLogsConfiguration.logAnalyticsConfiguration) && azapi_resource.diagnostics.body.properties.workspaceId == azapi_resource.logs.id
    error_message = "Logging must route by resource ID without any workspace keys."
  }
  assert {
    condition     = azapi_resource.vault.body.properties.enableRbacAuthorization && azapi_resource.vault.body.properties.enablePurgeProtection && azapi_resource.vault.body.properties.softDeleteRetentionInDays == 90
    error_message = "Vault RBAC and recovery controls are required."
  }
  assert {
    condition     = alltrue([for key, grant in azapi_resource.grant : !startswith(key, "app-") || can(regex("/Microsoft.App/containerApps/tonyai-staging-(api|web)$", grant.parent_id))]) && !contains(keys(azapi_resource.grant), "secret-direct-url")
    error_message = "App deployer scopes must stay on the two apps; migration credentials are owner-only."
  }
}

override_resource {
  override_during = plan
  target          = azapi_resource.group
  values          = { output = { properties = { principalId = "00000000-0000-0000-0000-000000000004", defaultDomain = "example.germanywestcentral.azurecontainerapps.io", loginServer = "tonyaistaging.azurecr.io" } }, id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/tonyai-staging" }
}

override_resource {
  override_during = plan
  target          = azapi_resource.registry
  values          = { output = { properties = { principalId = "00000000-0000-0000-0000-000000000004", defaultDomain = "example.germanywestcentral.azurecontainerapps.io", loginServer = "tonyaistaging.azurecr.io" } }, id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/tonyai-staging/providers/Microsoft.ContainerRegistry/registries/tonyaistaging" }
}

override_resource {
  override_during = plan
  target          = azapi_resource.logs
  values          = { output = { properties = { principalId = "00000000-0000-0000-0000-000000000004", defaultDomain = "example.germanywestcentral.azurecontainerapps.io", loginServer = "tonyaistaging.azurecr.io" } }, id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/tonyai-staging/providers/Microsoft.OperationalInsights/workspaces/tonyai-staging-logs" }
}

override_resource {
  override_during = plan
  target          = azapi_resource.environment
  values          = { output = { properties = { principalId = "00000000-0000-0000-0000-000000000004", defaultDomain = "example.germanywestcentral.azurecontainerapps.io", loginServer = "tonyaistaging.azurecr.io" } }, id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/tonyai-staging/providers/Microsoft.App/managedEnvironments/tonyai-staging-env" }
}

override_resource {
  override_during = plan
  target          = azapi_resource.vault
  values          = { output = { properties = { principalId = "00000000-0000-0000-0000-000000000004", defaultDomain = "example.germanywestcentral.azurecontainerapps.io", loginServer = "tonyaistaging.azurecr.io" } }, id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/tonyai-staging/providers/Microsoft.KeyVault/vaults/tonyai-staging-kv" }
}

override_resource {
  override_during = plan
  target          = azapi_resource.identity["api"]
  values          = { output = { properties = { principalId = "00000000-0000-0000-0000-000000000004", defaultDomain = "example.germanywestcentral.azurecontainerapps.io", loginServer = "tonyaistaging.azurecr.io" } }, id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/tonyai-staging/providers/Microsoft.ManagedIdentity/userAssignedIdentities/tonyai-staging-api" }
}

override_resource {
  override_during = plan
  target          = azapi_resource.identity["web"]
  values          = { output = { properties = { principalId = "00000000-0000-0000-0000-000000000004", defaultDomain = "example.germanywestcentral.azurecontainerapps.io", loginServer = "tonyaistaging.azurecr.io" } }, id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/tonyai-staging/providers/Microsoft.ManagedIdentity/userAssignedIdentities/tonyai-staging-web" }
}

override_resource {
  override_during = plan
  target          = azapi_resource.join_role
  values          = { output = { properties = { principalId = "00000000-0000-0000-0000-000000000004", defaultDomain = "example.germanywestcentral.azurecontainerapps.io", loginServer = "tonyaistaging.azurecr.io" } }, id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/tonyai-staging/providers/Microsoft.Authorization/roleDefinitions/00000000-0000-0000-0000-000000000099" }
}
